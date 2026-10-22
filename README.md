# effect-platform-chrome

Standalone TypeScript ESM library for **Effect v4** and **Chrome
Manifest V3**, modeled after `@effect/platform-browser`.

**Status:** initial implementation with eighteen public modules and mocked behavior
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

Alarm `getAll` and `clearAll` are lazy Effect values (not zero-argument methods).
Service-worker handler errors are inferred generically; unknown message payloads
are still decoded by each protocol owner. Injected storage APIs need only the
Promise-based `StorageApi` subset, not unrelated native Chrome members.

`.vscode/settings.json` uses the native TypeScript 7 workspace SDK settings
recommended by this tsgo release (`js/ts.*`, not the older `typescript.tsdk`).
Use a VS Code release supporting the native TypeScript integration, select the
workspace TypeScript version when prompted, and install the recommended Oxc
extension for editor linting. The plugin enables Effect editor features with
`diagnostics: false`, because Oxlint supplies Effect diagnostics. Do not run a
second standalone tsgo language server or the legacy JS patcher alongside it.
Other editors can use the patched compiler's language server; see the
[@effect/tsgo README](https://github.com/Effect-TS/tsgo#readme) for editor setup.

Strict NodeNext configuration includes forced module detection and separate
incremental typecheck/build caches under `node_modules/.cache/`. Library type
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
| `ChromeStorage` | Typed access to Chrome storage areas and change events. |
| `ChromeKeyValueStore` | Adapter for `effect/persistence/KeyValueStore`. |
| `ChromeRuntime` | Runtime messaging, lifecycle events, and extension metadata; `request` unwraps the worker's reply envelope. |
| `ChromeMessage` | The `{ ok, value \| error }` reply envelope shared by `ChromeServiceWorker` and senders: its schema, `succeed`/`fail`, and `decodeResponse`. |
| `ChromePort` | Scoped long-lived messaging ports and streams. |
| `ChromeTabs` | Tab operations and event streams. |
| `ChromeAlarms` | Alarm scheduling and event handling. |
| `ChromeServiceWorker` | Manifest V3 service-worker lifecycle integration, with wake listeners for any event (optionally filtered) via `listen`. |
| [`ChromeRpc`](docs/ChromeRpc.md) | Effect RPC client/server protocols over Chrome ports. |
| [`ChromeSchemaStorage`](docs/ChromeSchemaStorage.md) | Schema validation, defaults, version migrations, and latest-state observation. |
| [`ChromePermissions`](docs/ChromePermissions.md) | Permission checks, requests, revocation, and change events. |
| [`ChromeScripting`](docs/ChromeScripting.md) | Typed script injection, CSS, and dynamic content-script registration. |
| `ChromeIdentity` | Web auth flows (`launchWebAuthFlow`) and the extension's OAuth redirect URL. |
| `ChromeWebNavigation` | A tab's frames (`getAllFrames`, `getFrame`) and committed/history navigations. |
| `ChromeCookies` | Reading, setting and removing cookies, including removing a cookie read from `getAll`. |
| `ChromeNotifications` | Creating and clearing notifications, and their click/close events. |
| `ChromeWindows` | Reading and updating windows, including bringing one to the front. |
| [`ChromeTesting`](docs/ChromeTesting.md) | Isolated storage and tab fixtures, event simulators, and paired ports; one module per adapter under `testing/`. |

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
}).pipe(Effect.provide(ChromeStorage.layer))
```

You can also import `effect-platform-chrome/ChromeStorage` directly.
Every module with a Chrome global behind it exposes `layerLive`, which reads the
global when the layer is built. Most also take an injected API through `make(api)`
and `layer(api)`; Storage, Runtime and Alarms keep `layer` as another name for their
live layer. Port exposes these on its `ChromePort` service class.
KeyValueStore provides `layerLocal()`, `layerSync()`, and `layerSession()` with
isolated namespaces. Importing modules does not access Chrome globals.

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
