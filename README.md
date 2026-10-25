# effect-platform-chrome

Standalone TypeScript ESM library for **Effect v4** and **Chrome
Manifest V3**, modeled after `@effect/platform-browser`.

**Status:** initial implementation with thirty-seven public modules and mocked behavior
tests. The library focuses on platform services rather than UI APIs.

This is an independent community project, not an official Effect package.

## Development

Use Node.js 22.12+ (22.x), 24.x, or 26+ and npm.

```sh
npm ci
npm run lint
npm run typecheck
npm run build
npm test
npm run test:watch
npm pack --dry-run
```

The build produces ESM JavaScript, TypeScript declarations, and source/declaration
maps in `dist/`; packaged `src/` files provide the corresponding map sources.
Consumers must provide `effect` compatible with `^4.0.4`; development uses
`effect@4.0.4`. The library itself does not depend on Node.js at runtime. Bundle
integrations into the appropriate extension contexts with an ESM-capable
bundler; select Manifest V3 permissions according to the APIs used.

Behavior tests in `test/**/*.test.ts` use exact `@effect/vitest@4.0.4` with
`vitest@5.0.4` and `effect@4.0.4`. The integration's peers are Effect `^4.0.4`
and Vitest `>=5.0.0 <6.0.0`; use this stable release, not the older guide's beta.
The Node test environment uses explicit Chrome API mocks, not fabricated browser
globals. Return Effects directly from `it.effect` and compose with `Effect.gen`:

```ts
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { make } from "./src/ChromeAlarms.js"

// mockApi is an explicit ChromeAlarmsApi fixture, fresh for each test.
it.effect("reads alarms", () => Effect.gen(function*() {
  const alarms = make(mockApi())
  expect(yield* alarms.getAll).toEqual([])
}))
```

`it.effect` provides the test scope and TestClock automatically. Fork consumers
with `Effect.forkScoped` (or `forkChild` for parent-owned work), synchronize actual
listener registration, and join or interrupt before cleanup assertions. Preserve
an explicit inner `Effect.scoped` when asserting resource release before the
test ends. Use `Effect.flip` for typed failures and `Effect.exit` for interruption
or defects instead of Promise-runner wrappers. Provide fresh injected layers per
test rather than sharing mutable mocks.

Use `TestClock.adjust` from `effect/testing` for genuine Effect deadlines; the
alarm timeout test checks the listener is retained before and removed at its
deadline without real sleeps. Promise gates remain appropriate at native Chrome
mock boundaries. Ordinary async tests intentionally cover AbortSignal runners
and most `ChromeServiceWorker.start` callback/ManagedRuntime Promise lifecycles.
Do not force the test clock into independently created runtimes: their clocks
are separate. Real worker suspension and wakeup require browser integration tests.

### Effect tooling setup

Setup follows [Effect Solutions](https://www.effect.solutions/) and the
[@effect/tsgo Oxlint guide](https://github.com/Effect-TS/tsgo/blob/main/docs/README.md),
using the native TypeScript 7 integration rather than the older JavaScript
language-service patcher. Compatible development tools are pinned to
`typescript@7.0.2`, `@effect/tsgo@0.51.1`, `oxlint@1.87.0`, and
`oxlint-tsgolint@7.0.2003`, and matching `@oxlint/plugins@1.87.0`.
Newer registry linter versions are not necessarily
supported by this integration; check its supported-version table before upgrading.

`npm ci` runs `prepare` (`effect-tsgo patch --oxlint`) to patch both TypeScript
and Oxlint. If installing with lifecycle scripts disabled, run `npm run prepare`
explicitly. `.oxlintrc.json` extends the recommended Effect type-aware preset;
`npm run lint` checks library sources, tests, and Vitest configuration only,
not dependencies, generated output, or separately configured examples. Lint
errors and warnings fail the command (`--max-warnings=0`). There are no blanket
Effect-rule exclusions. The KeyValueStore adapter and its compatibility tests
deliberately opt into Effect's unstable persistence API; test suites also document
their use of the pinned, test-only `@effect/vitest` API marked unstable by tsgo.

[anti-slop](https://github.com/dmmulroy/anti-slop) is vendored, not installed from
an unofficial npm package. Both generic and Effect plugins are enabled alongside
the recommended Effect preset: all 18 generic rules, five Effect rules, and
Oxlint's accumulating-spread rule are errors. See
[`tools/oxlint/anti-slop/UPSTREAM.md`](tools/oxlint/anti-slop/UPSTREAM.md) for the
exact upstream revision, MIT attribution, and the narrow file-specific raw Chrome
message/storage exceptions. Other rules still apply at these boundaries. Required
assertions need meaningful `SAFETY:` comments. Agent assets and vendored/generated
code are ignored without ignoring all dot-directories.

Alarm `getAll` and `clearAll` are lazy Effect values (not zero-argument methods), and
`get` returns an `Option`, None when no such alarm exists.
Service-worker handler errors are inferred generically; unknown message payloads
are still decoded by each protocol owner. Injected storage APIs need only the
Promise-based `ChromeStorageApi` subset, not unrelated native Chrome members.

`.vscode/settings.json` uses the native TypeScript 7 workspace SDK settings
recommended by this tsgo release (`js/ts.*`, not the older `typescript.tsdk`).
Use a VS Code release supporting the native TypeScript integration, select the
workspace TypeScript version when prompted, and install the recommended Oxc
extension for editor linting. The plugin enables Effect editor features with
`diagnostics: false`, because Oxlint supplies Effect diagnostics. Do not run a
second standalone tsgo language server or the legacy JS patcher alongside it.
Other editors can use the patched compiler's language server; see the
[@effect/tsgo README](https://github.com/Effect-TS/tsgo#readme) for editor setup.

Strict NodeNext configuration includes forced module detection and an incremental
typecheck cache under `node_modules/.cache/`. `npm run build` is not incremental: it
removes `dist/` first, so a deleted or partial output, or files left from renamed
sources, never survive into a build. Library type
checking remains enabled (`skipLibCheck: false`); composite project references
are unnecessary for this standalone library.

Effect Solutions is a **local dev dependency**, not a global installation:

```sh
npm run effect-solutions -- list
npm run effect-solutions -- show project-setup tsconfig
```

`AGENTS.md` points to the actual version-matched reference source at
`node_modules/effect/src/` after installation. No separate clone is needed:
the current upstream v4 source is [Effect-TS/effect](https://github.com/Effect-TS/effect),
not the guide's historical effect-smol repository. Consult installed APIs when
a guide example targets an older release.

Dependency caveat: `npm audit` currently reports five moderate dev-only findings
through `effect-solutions@0.5.3` → `gray-matter` → `js-yaml` → `argparse` →
`sprintf-js` (GHSA-hp3w-g68c-fv3c). The suggested automatic fix downgrades the
CLI across a breaking version boundary; no forced downgrade was applied. This
CLI is not a library runtime dependency; use it only with trusted documentation.

## Modules

| Module | Responsibility |
| --- | --- |
| `ChromeStorage` | Typed access to Chrome storage areas (including `getKeys`, Chrome 130+) and change events. |
| `ChromeKeyValueStore` | Adapter for `effect/persistence/KeyValueStore`. |
| `ChromeRuntime` | Runtime messaging, lifecycle, update and external message/connection events, extension contexts and metadata; `request` unwraps the worker's reply envelope. |
| `ChromeMessage` | The `{ ok, value \| error }` reply envelope shared by `ChromeServiceWorker` and senders: its schema, `succeed`/`fail`, and `decodeResponse`. |
| `ChromePort` | Scoped long-lived messaging ports and streams. |
| `ChromeTabs` | Tab operations (create, update, move, duplicate, reload, discard, grouping, zoom, history, language detection, messaging, ports, capture) and tab event streams. |
| `ChromeAlarms` | Alarm scheduling and event handling. |
| `ChromeServiceWorker` | Manifest V3 service-worker lifecycle integration, with wake listeners for any event (optionally filtered) via `listen`. |
| [`ChromeRpc`](docs/ChromeRpc.md) | Effect RPC client/server protocols over Chrome ports. |
| [`ChromeSchemaStorage`](docs/ChromeSchemaStorage.md) | Schema validation, defaults, version migrations, and latest-state observation. |
| [`ChromePermissions`](docs/ChromePermissions.md) | Permission checks, requests, revocation, host access requests (Chrome 133+), and change events. |
| [`ChromeScripting`](docs/ChromeScripting.md) | Typed script injection, CSS, and dynamic content-script registration. |
| `ChromeIdentity` | Web auth flows (`launchWebAuthFlow`), the OAuth redirect URL, Google account tokens (`getAuthToken`, cache removal), profile user info and sign-in change events. |
| `ChromeWebNavigation` | A tab's frames (`getAllFrames`, `getFrame`) and every navigation event (before-navigate, committed, DOMContentLoaded, completed, errors, created targets, fragment/history updates, tab replacement), each a stream method taking an optional URL filter (`onCommitted(filter?)`). |
| `ChromeCookies` | Reading, setting and removing cookies (including removing a cookie read from `getAll`), listing cookie stores, and cookie change events. |
| `ChromeNotifications` | Creating, updating, clearing and listing notifications, the permission level, and click, button, close and permission-change events. |
| `ChromeWindows` | Listing, creating, updating, focusing and closing windows, with window-type-filterable event streams. |
| `ChromeTabGroups` | Reading, querying, updating and moving tab groups, and their event streams. |
| [`ChromeOffscreen`](docs/ChromeOffscreen.md) | The single offscreen document: concurrency-safe `ensureDocument` and a scoped `document`. |
| `ChromeAction` | Toolbar action: per-tab badge text/colors, icon, title, popup, enable/disable, `openPopup`, user settings; `onClicked` / `onUserSettingsChanged` streams. |
| `ChromeCommands` | Keyboard commands: `getAll` and the `onCommand` stream (command name and optional tab). |
| [`ChromeSidePanel`](docs/ChromeSidePanel.md) | Side panel options, behavior, layout and `close`; lazy `open` plus `openFromUserGesture`; `onOpened` / `onClosed` streams. |
| [`ChromeContextMenus`](docs/ChromeContextMenus.md) | Creating (with lastError-checked confirmation), updating and removing menu items, scoped items, and click events. |
| [`ChromeOmnibox`](docs/ChromeOmnibox.md) | The omnibox default suggestion and keyword-session events, answering input through an Effect-returning `suggest`. |
| [`ChromeDeclarativeNetRequest`](docs/ChromeDeclarativeNetRequest.md) | Dynamic, session and static request rules, atomic `replaceDynamicRules`, matched-rule feedback and debug matches. |
| `ChromeWebRequest` | Observational request-lifecycle streams with a required `RequestFilter`; blocking belongs in `ChromeDeclarativeNetRequest`. |
| `ChromeIdle` | Idle/locked state queries, the detection interval, the ChromeOS auto-lock delay, and state-change events. |
| `ChromeI18n` | Localized messages as `Option` (missing key is none), UI and accept languages, and language detection. |
| `ChromeDownloads` | Starting, searching and controlling downloads, `waitForComplete`, choosing filenames, and download events. |
| `ChromeHistory` | Searching, adding and deleting browser history, and visit events. |
| `ChromeBookmarks` | Reading, searching and editing the bookmark tree, and its change/import events. |
| `ChromeSessions` | Recently closed tabs and windows, other devices' sessions, restoring them, and change events. |
| `ChromeManagement` | Installed extensions (`getSelf`, `getAll`, `get`), permission warnings, enabling and uninstalling, and install/uninstall/enable/disable events. |
| `ChromeUserScripts` | User-script registration, world configuration and one-off `execute`, with an `isAvailable` probe for the user's "Allow User Scripts" toggle. |
| [`ChromeDebugger`](docs/ChromeDebugger.md) | Chrome DevTools Protocol commands and events, with scoped sessions that attach on acquire and detach on release. |
| `ChromeTabCapture` | Tab-capture stream ids for offscreen documents, captured tabs, and capture status events. |
| [`ChromeTesting`](docs/ChromeTesting.md) | In-memory fixtures for storage, tabs, windows, ports, action, context menus, omnibox, offscreen, cookies, identity, web navigation, notifications, declarativeNetRequest and bookmarks, plus event simulators; one module per adapter under `testing/`. |

Modules use Effect v4 services, tagged errors, layers, and scoped streams.
Manifest V3 wakeup listeners must
be registered **synchronously at service-worker module evaluation**, before any
asynchronous initialization. Use `ChromeServiceWorker.start` for this purpose:
it has named options for runtime messages, ports, install, startup and alarms, and
takes every other wake event (`action.onClicked`, `contextMenus.onClicked`,
`commands.onCommand`, a webNavigation event with its URL filter, …) as
`listeners: [ChromeServiceWorker.listen(event, handler, filter?)]`.
Ordinary event streams subscribe when consumed and are observational. Worker
initialization gates handlers, with bounded startup buffering. Chrome can terminate
a worker without running finalizers; in-memory queues and fibers are not durable.

The package exports module namespaces from the root and individual subpaths:

```ts
import { ChromeStorage } from "effect-platform-chrome"
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const storage = yield* ChromeStorage.ChromeStorage
  yield* storage.local.set({ greeting: "Hello from Effect" })
  return yield* storage.local.get("greeting")
}).pipe(Effect.provide(ChromeStorage.layerLive))
```

You can also import `effect-platform-chrome/ChromeStorage` directly.
Every module with a Chrome global behind it exposes `layerLive`, which reads the
global when the layer is built and fails with operation `"initialize"` where it is
missing. Each also takes an injected API through `make(api)` and `layer(api)`; see
[docs/CONVENTIONS.md](docs/CONVENTIONS.md). `ChromeSchemaStorage.layer` builds on the
`ChromeStorage` service in context. `ChromeKeyValueStore.layerLive({ area, namespace })` picks the storage area
(`"local"` by default) and isolates its keys by namespace. Importing modules does not access Chrome globals.

`effect-platform-chrome/internal` and all `internal/*`
subpaths are explicitly excluded from public exports.

## WXT example

[`examples/wxt`](examples/wxt/README.md) demonstrates the platform integrations using a
popup, background service worker, and content script on `https://example.com/*`.
It includes RPC, schema storage/migrations, permissions, script injection, and a
bounded browser stress runner. ChromeTesting has development-only fixture examples.
Build the library with `npm run build`, then run `npm ci` and `npm run build`
inside `examples/wxt`. Load `examples/wxt/.output/chrome-mv3` as an unpacked
extension in Chrome. See the example README for the walkthrough and manual
worker-restart checks.

## License and publication

Licensed under [MIT](LICENSE). Vendored tooling retains its original licenses
and attribution. This repository is public; the package remains `private: true`
and is not published to npm.
