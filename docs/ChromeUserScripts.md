# ChromeUserScripts

An injectable Effect v4 service for the Promise-based Manifest V3 `chrome.userScripts` API
(Chrome 120+), for extensions that run code their users supply, such as user-script managers.
Import from `effect-platform-chrome/ChromeUserScripts`. No Chrome global is read at import time:
`layerLive` reads `chrome.userScripts` once when it is built, `make(api)` builds the service
from any compatible API, and `layer(api)` provides one.

## Turning the API on

Declare `"userScripts"` in `permissions` and the target sites in `host_permissions`. The
user must also allow user scripts, and until they do the namespace is missing:

| Chrome | Toggle | While it is off |
| --- | --- | --- |
| 138+ | "Allow User Scripts" on the extension's details page | `chrome.userScripts` is undefined, and stays undefined after the user turns it on until the extension's context reloads (for example `chrome.runtime.reload()`) |
| 120–137 | Developer mode at `chrome://extensions` | reading `chrome.userScripts` throws |

If the user turns access off while the worker runs, the namespace stays defined but every
method throws synchronously.

```typescript
import { Effect } from "effect"
import * as ChromeUserScripts from "effect-platform-chrome/ChromeUserScripts"

const program = Effect.gen(function*() {
  if (!(yield* ChromeUserScripts.isAvailable)) {
    // Show ChromeUserScripts.unavailableMessage, which explains both toggles.
    return
  }

  const userScripts = yield* ChromeUserScripts.ChromeUserScripts
  yield* userScripts.register([{
    id: "greeter",
    matches: ["https://example.com/*"],
    js: [{ code: "console.log(document.title)" }]
  }])
}).pipe(Effect.provide(ChromeUserScripts.layerLive))
```

`isAvailable` (the module export, and the same member on the service) runs Chrome's documented
probe, a `getScripts()` call, each time it runs, and never fails: it is `false` when the
namespace is missing or throws, or when the probe throws or rejects. `layerLive` fails with
operation `"initialize"` and a cause carrying `unavailableMessage` when the namespace is
missing or throws on access. A layer built while access is on keeps its API; once access is
revoked its calls fail with the typed error; run the service's `isAvailable` to re-check.

## Registering scripts

- `register(scripts)` takes `UserScriptRegistration`s: Chrome rejects a script without `matches`
  or with an empty `js`, and each source has exactly one of `code` or `file`. Ids must be
  non-empty, must not start with `_`, and must not already be registered. Chrome validates the
  whole batch first and registers nothing when any script is invalid.
- `update(scripts)` changes only the supplied properties of existing scripts and is atomic: an
  unknown id or an invalid result changes nothing. Chrome never updates `includeGlobs` or
  `excludeGlobs`; unregister and register again to change them. `worldId: ""` moves a script
  back to the default world, and a script with a `worldId` cannot move to `MAIN` by update.
- `getScripts(filter?)` lists scripts in registration order with Chrome's defaults filled in
  (`allFrames`, `runAt: "document_idle"`, `world: "USER_SCRIPT"`).
- `unregister(filter?)`: **without a filter, or without `ids`, it removes every user script of
  the extension.** `{ ids: [] }` removes nothing, and an unknown id fails the call and removes
  nothing.

The filter and world arguments are passed to Chrome only when given. Registrations live in
Chrome, not in an Effect scope, and Chrome clears them when the extension updates: register
them again from `runtime.onInstalled` with reason `"update"`.

## Worlds and messaging

Scripts run in the `USER_SCRIPT` world by default, which is exempt from the page's CSP and
hidden from the page; `MAIN` shares the page's JavaScript environment. Since Chrome 133 a
`worldId` selects a separate user-script world (ids starting with `_` are reserved, at most
256 characters, and only with the `USER_SCRIPT` world).

- `configureWorld(properties)` sets `csp` and `messaging` for the default world or the one
  named by `worldId`. Chrome stores at most 100 world configurations and refuses any
  `configureWorld` call once 100 exist, even for a configured world; reset some first.
- `getWorldConfigurations` (Chrome 133+) lists them; the default world's entry has no `worldId`.
- `resetWorldConfiguration(worldId?)` (Chrome 133+) forgets one, or the default world's
  configuration; an unconfigured world resets without error.

User scripts can call `chrome.runtime.sendMessage` and `connect` only in a world configured
with `messaging: true`; the extension receives those messages through
`chrome.runtime.onUserScriptMessage` and `onUserScriptConnect`, not `onMessage`/`onConnect`.

## One-off execution

`execute(injection)` (Chrome 135+) injects code or files once into a tab: at `document_idle`,
or as soon as possible with `injectImmediately`. A script evaluating to a promise is awaited.
The target is a tab plus at most one of `allFrames`, `frameIds` or `documentIds`. Results list
the top frame first and leave out frames Chrome could not inject into; when the injection
targets a single frame that fails, the call fails instead. Current Chrome never sets the
`error` field the typings declare. `result` is untyped: decode it with a schema.

## Errors and versions

Every operation is a lazy Effect failing with `ChromeUserScriptsError`, whose `operation` is the
Chrome member name and whose `cause` is Chrome's rejection or synchronous throw, unchanged.
Each run calls Chrome again; interruption cannot cancel a call Chrome has already started, and
its later outcome is ignored. `getWorldConfigurations`, `resetWorldConfiguration` and `execute`
are optional in `ChromeUserScriptsApi`; where the browser lacks them they fail with the typed
error (`userScripts.execute is unavailable`).

## Testing

`makeUserScripts` (`effect-platform-chrome/testing/UserScripts`) returns `{ api, layer, controls }`
over an in-memory `chrome.userScripts` that applies the validation and atomicity above with
Chrome's error messages, the 100-world limit, and Chrome's `execute` result rules over
per-frame outcomes from `controls.respond`. `controls.setAccess(false)` makes every call throw
synchronously, as revoked access does; `controls.failNext(operation, cause)` rejects one call;
`controls.scripts()` and `controls.worlds()` snapshot the state. Match patterns and file paths
are not validated, and nothing is injected into pages.

Unit tests cover every operation's argument passing, rejection and synchronous throw; the
stress suite runs 2,048 concurrent calls with seeded interleaved throws and rejections,
1,024 concurrent probes, interruption of 512 in-flight calls and races between settlement and
interruption, 4,096-script populations churned concurrently, duplicate-id and world-limit
races, access revoked mid-burst, and 1,024 concurrent executions over up to 1,024 frames.
