# ChromeScripting

An injectable Effect v4 service for the Promise-based Manifest V3 `chrome.scripting` API. Import from `effect-platform-chrome/ChromeScripting`. No Chrome global is read at import time; `layerLive` resolves it when built. `make(api)` constructs a service directly and `layer(api)` provides a mock or other compatible API subset.
Each live layer build snapshots the API property once; accessor failures become
typed initialization errors.

## Permissions and targets

Declare `"scripting"` plus appropriate `host_permissions`, or use a temporary `"activeTab"` grant following a user gesture. This adapter neither requests permissions nor bypasses Chrome restrictions. Restricted pages (for example `chrome://` pages and the Chrome Web Store), missing host grants, stale document/frame IDs, and closed tabs may fail. File URL access requires the user's extension setting as well as the appropriate permission.

```json
{
  "manifest_version": 3,
  "permissions": ["scripting", "activeTab"],
  "host_permissions": ["https://example.com/*"]
}
```

Targets preserve Chrome's options: `tabId`, `allFrames`, `frameIds`, or `documentIds`. Explicit frame and document IDs are mutually exclusive, and cannot be combined with `allFrames: true`. Without frame options, Chrome targets the main frame. Each frame needs applicable access.

## Function and file injections

```typescript
import { Effect } from "effect"
import { ChromeScripting, layerLive } from "effect-platform-chrome/ChromeScripting"

const readText = (tabId: number) => Effect.gen(function*() {
  const scripting = yield* ChromeScripting
  const results = yield* scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: async (selector: string) => document.querySelector(selector)?.textContent ?? "",
    args: ["h1"]
  })

  // Array<chrome.scripting.InjectionResult<string>>; result remains optional.
  return results.map(({ frameId, documentId, result }) => ({ frameId, documentId, result }))
})

const program = readText(123).pipe(Effect.provide(layerLive))
// Run program at your application's runtime boundary, using a real authorized tab ID.
```

`executeScript` infers the argument tuple and return type from `func`, requires arguments for required parameters, and returns `InjectionResult<Awaited<Result>>[]`. Chrome waits for a returned Promise. A no-argument function can omit `args`. Function typing is not runtime validation of browser serialization: args must be JSON-serializable, and functions are serialized without their lexical closure, bound parameters, or extension execution context. Pass captured values via `args`; do not reference imported helpers or Effect services inside the injected function. Results must survive Chrome's serialization too; class prototypes and arbitrary runtime objects are not guaranteed by TypeScript inference.

File injections accept packaged extension-relative paths and return `InjectionResult<unknown>[]`; there is no caller-selected result generic. Decode data with a schema before treating it as domain data.

```typescript
const injectFiles = (tabId: number) => Effect.gen(function*() {
  const scripting = yield* ChromeScripting
  return yield* scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["content.js"],
    world: "ISOLATED",
    injectImmediately: true
  })
})
```

`ISOLATED` is Chrome's default extension world. `MAIN` shares the page's JavaScript environment: page scripts can interfere with injected code, and extension-only APIs are not available there. Both worlds access the DOM. `injectImmediately` is forwarded without promising execution before page load.

Results are preserved per frame, including `frameId`, `documentId`, and optional `result`. Chrome puts the main frame first; do not assume ordering for other frames. The adapter does not aggregate frames, manufacture missing results, or attach per-frame errors that Chrome does not expose. A rejected injection fails the Effect rather than producing invented partial results. CSS injection into multiple frames may ignore unsuccessful frame injections according to Chrome's API; successful resolution is not proof that every frame changed.

## CSS and dynamic registrations

```typescript
const install = (tabId: number) => Effect.gen(function*() {
  const scripting = yield* ChromeScripting
  const css: chrome.scripting.CSSInjection = {
    target: { tabId }, css: "h1 { color: rebeccapurple }", origin: "USER"
  }
  yield* scripting.insertCSS(css)
  yield* scripting.removeCSS(css)
  yield* scripting.registerContentScripts([{
    id: "example-heading",
    matches: ["https://example.com/*"],
    js: ["content.js"],
    runAt: "document_idle",
    world: "ISOLATED",
    persistAcrossSessions: false
  }])
  yield* scripting.updateContentScripts([{ id: "example-heading", allFrames: true }])
  const registered = yield* scripting.getRegisteredContentScripts({ ids: ["example-heading"] })
  yield* scripting.unregisterContentScripts({ ids: ["example-heading"] })
  return registered
})
```

`insertCSS` / `removeCSS` accept Chrome's `CSSInjection` union (exactly one of `css` or `files`) and preserve target/origin. To remove CSS, its content/files and origin must exactly match the insertion. Removing absent CSS is a Chrome no-op.

Registration accepts `ContentScriptRegistration[]`: Chrome's `RegisteredContentScript` with `matches` required (Chrome rejects a registration without it even though its typings make it optional) and at least one of `js` or `css`. Matches, exclusions, files, world, run timing, frame options and persistence are forwarded unchanged. `ContentScriptUpdate` requires `id` and allows partial property updates, including id-only updates. It has no `world` field: Chrome never changes a registered script's world on update, so unregister and register again to move a script. Chrome validates IDs/files and rejects invalid registration/update batches as a whole; this adapter does not retry, roll back, or unregister on failure.

`getRegisteredContentScripts(filter?)` and `unregisterContentScripts(filter?)` are functions. Omitted/undefined filters call Chrome with no argument; `{}`, `{ ids: [] }`, and explicit ID lists are forwarded unchanged. **An omitted unregister filter, `{}`, and `{ ids: [] }` all remove every dynamic content script of this extension**: Chrome treats an empty `ids` list like no filter. Guard computed ID lists before unregistering them:

```typescript
const unregisterOwned = (ids: Array<string>) => Effect.gen(function*() {
  const scripting = yield* ChromeScripting
  if (ids.length > 0) yield* scripting.unregisterContentScripts({ ids })
})
```

Unregistering an unknown ID fails without removing anything. Registration persists according to Chrome's options, not Effect scope. There is deliberately no automatic unregister finalizer: it could remove scripts owned elsewhere, and Chrome can stop a worker without running finalizers. Unregistering does not remove code or styles already injected into a document.

## Errors and execution

Every method returns a lazy `Effect<..., ChromeScriptingError>`. Synchronous API throws and rejected Promises retain `operation` and the original `cause`; unavailable live contexts use operation `"initialize"`. Re-running the same Effect calls Chrome again. Effects are not memoized and do not clone options; avoid mutating options before or during execution. Interruption cannot cancel or undo browser work already dispatched. This module uses only native Chrome scripting APIs, not remote code evaluation, permission changes, or managed script ownership.

The seven public operations are `executeScript`, `insertCSS`, `removeCSS`, `registerContentScripts`, `getRegisteredContentScripts`, `updateContentScripts`, and `unregisterContentScripts`, Chrome's whole `chrome.scripting` namespace (it has no events). Callback overloads are intentionally represented by Effects rather than exposed; Promise options and result metadata are preserved. The module re-exports Chrome's types under short names: `InjectionTarget`, `InjectionResult`, `CSSInjection`, `StyleOrigin`, `ExecutionWorld`, `RegisteredContentScript`, `ContentScriptFilter`, plus its own `ContentScriptRegistration`, `ContentScriptUpdate`, `FunctionInjection` and `FileInjection`.

## Testing

`makeScripting(overrides?)` from `effect-platform-chrome/testing/Scripting` returns `{ api, layer, controls }`: an in-memory `chrome.scripting` modelled on Chromium. `controls.setTab(tabId, frames?)`, `navigate` and `removeTab` describe tabs and frames (a frame may carry a `url` such as `chrome://…` or an `error` to make it unreachable), `addFile(path, evaluate?)` packages files, and `styles()`, `scripts()` and `pending()` snapshot the state. Targets, files, IDs and batches are validated the way Chrome does, with Chrome-like messages; a lone unreachable frame rejects while a wider target leaves it out. Functions run locally, once per frame, with JSON-cloned arguments and results (closures are not stripped). `failNext`, `throwNext` and `holdNext` inject one rejection, one synchronous throw, or a pause where Chrome goes asynchronous; `restart()` drops tabs, styles and non-persistent scripts.

## Stress coverage

`test/stress/ChromeScripting.stress.test.ts` settles 2,048 concurrent calls across all seven
operations with seeded, interleaved rejections and synchronous throws (each mapped to the
right `operation` and `cause`); interrupts 512 calls before, while and after Chrome holds them;
replays one Effect 4,096 times; and drives the fixture with 4,096 registrations, racing
duplicate registrations/updates/unregistrations, an empty-`ids` unregister racing targeted
ones, scoped registrations interrupted mid-acquire and mid-release, 100 injections into a
64-frame tab, and 4,096 balanced CSS insertions and removals across navigations. These tests
do not emulate Chrome serialization exactly or inject code into a browser.
