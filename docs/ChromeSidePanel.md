# ChromeSidePanel

Import from `effect-platform-chrome/ChromeSidePanel`. `make(api)` and `layer(api)`
take an injectable Promise-based `chrome.sidePanel` subset; `layerLive` reads the
global only when built and fails with `operation: "initialize"` without it. The
manifest needs the `"sidePanel"` permission and usually `side_panel.default_path`.

- `setOptions` / `getOptions` configure the panel per tab (`tabId`) or by default.
  Chrome requires `getOptions`' argument, so `getOptions()` sends `{}`, which reads
  the default options.
- `setPanelBehavior({ openPanelOnActionClick: true })` makes the toolbar icon open
  the panel; Chrome then handles the gesture and no code calls `open`.
- `close({ tabId })` closes that tab's tab-specific panel and `close({ windowId })` the
  window's global panel. It is a no-op when the panel is already closed; since Chrome 145
  it rejects a `tabId` whose tab only shows the global panel.
- Version-gated members are optional in `ChromeSidePanelApi`: `open` (Chrome 116+),
  `getLayout` (140+), `close` and `onOpened` (141+), `onClosed` (142+). On a browser or
  injected API without one, calling it (or consuming the stream) fails with a typed
  `ChromeSidePanelError` whose `operation` is the member name. They are read when used,
  never when the service is made.
- Rejections and synchronous throws become `ChromeSidePanelError` with the Chrome
  method (or event) name as `operation`.
- `onOpened` / `onClosed` emit the info object (`tabId` only for a tab-specific panel).
  Each consumption owns one listener, removed when it ends, fails or is interrupted, and
  buffers at most 64 events, dropping the oldest.

## Opening from a user gesture

Chrome only opens the panel in response to a user action, such as an action click,
a context menu click, a command, or a click in an extension page. `open(options)` is
lazy like every other Effect here: composing it inside a handler does not call Chrome,
and any async step, layer build or scheduler hop before it runs can lose the gesture.

`openFromUserGesture(options)` is the explicit imperative bridge, shared with
`ChromePermissions.requestFromUserGesture`: it calls `chrome.sidePanel.open`
synchronously when invoked and returns an Effect for that already-started call.
Running the returned Effect again observes the same call rather than opening twice,
and rejection handlers are attached immediately even if it is never run. Invoke it
directly on the handler's synchronous stack:

```ts
import { Effect } from "effect"
import * as ChromeSidePanel from "effect-platform-chrome/ChromeSidePanel"

// Extension page setup, before the gesture (not module import in shared code).
const sidePanel = ChromeSidePanel.make(chrome.sidePanel)
const { id: windowId } = await chrome.windows.getCurrent()
const button = document.querySelector<HTMLButtonElement>("#open-panel")!

button.addEventListener("click", () => {
  if (windowId === undefined) return
  // Native open begins here synchronously, before runFork is involved.
  const outcome = sidePanel.openFromUserGesture({ windowId })
  Effect.runFork(outcome.pipe(Effect.catch((error) => Effect.logError(error))))
})
```

Awaiting anything in the handler before the call, such as `getCurrent`, can end
the gesture, so gather ids beforehand. In a service worker, prefer
`setPanelBehavior({ openPanelOnActionClick: true })` for toolbar clicks. For a
command or context menu click, call `openFromUserGesture` with the event's tab or
window id directly inside a listener registered synchronously at worker startup.
`ChromeServiceWorker.listen` handlers can be queued until the worker's layer is
ready, so they are not a gesture guarantee. `onOpened` and `onClosed` are
observational streams that cannot wake the worker.

## Stress coverage

`test/stress/ChromeSidePanel.stress.test.ts` covers, without a browser: a 4096-event burst
per event leaving exactly the newest 64 in order and no listener; 512 concurrent
subscriptions per event stopped at seeded stages (before or after registration, mid-element,
completed, partial registration failure) ending with zero listeners; 1536 concurrent calls
across `setOptions`, `getOptions`, `setPanelBehavior`, `open`, `openFromUserGesture` and
`close` with seeded rejections and throws settled in shuffled order, each typed with its own
`operation` and cause; 1024 concurrent `getPanelBehavior` / `getLayout` runs; 1024 gesture
opens started in one handler and partly interrupted; and 1024 calls to members an older
browser lacks, each typed.
