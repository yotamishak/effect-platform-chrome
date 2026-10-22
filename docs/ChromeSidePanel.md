# ChromeSidePanel

Import from `effect-platform-chrome/ChromeSidePanel`. `make(api)` and `layer(api)`
take an injectable Promise-based `chrome.sidePanel` subset; `layerLive` reads the
global only when built and fails with `operation: "initialize"` without it. The
manifest needs the `"sidePanel"` permission and usually `side_panel.default_path`.

- `setOptions` / `getOptions` configure the panel per tab (`tabId`) or by default.
  `getOptions()` with no argument reads the default options.
- `setPanelBehavior({ openPanelOnActionClick: true })` makes the toolbar icon open
  the panel; Chrome then handles the gesture and no code calls `open`.
- `close` (Chrome 141+), `getLayout` (Chrome 140+), `onOpened` (Chrome 141+) and
  `onClosed` (Chrome 142+) fail or never emit on older browsers.
- Rejections and synchronous throws become `ChromeSidePanelError` with the Chrome
  method (or event) name as `operation`.

## Opening from a user gesture

Chrome only opens the panel in response to a user action, such as an action click,
a context menu click, a command, or a click in an extension page. `open(options)` is
lazy like every other Effect here: composing it inside a handler does not call Chrome,
and any async step, layer build or scheduler hop before it runs can lose the gesture.

`openFromUserGesture(options)` is the explicit imperative bridge, modelled on
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
