# ChromeContextMenus

Import from `effect-platform-chrome/ChromeContextMenus`. `ChromeContextMenus` is an
Effect v4 service over `chrome.contextMenus`; `make(api)` and `layer(api)` accept an
injected API, and `layerLive` reads `chrome.contextMenus` and `chrome.runtime` only when
built. The manifest needs the `"contextMenus"` permission.

- `create(properties)` resolves to the item's id: the `id` you gave, or a number Chrome
  generated.
- `update(id, properties)`, `remove(id)` and `removeAll` use Chrome's MV3 Promise forms.
  `remove` also removes the item's children and fails for an unknown id.
- `item(properties)` creates an item for the life of a `Scope` (see below).
- `onClicked` emits `{ info, tab }`, with `tab` an `Option` because Chrome omits it
  outside tabs.
- Failures are `ChromeContextMenusError` with the Chrome call as `operation`
  (`"create"`, `"update"`, `"remove"`, `"removeAll"`, `"onClicked"`, or `"initialize"`
  for a missing global) and the original `cause`.

## Why `create` waits for a callback

`chrome.contextMenus.create` has no Promise form. It returns the id synchronously, before
Chrome has validated anything, and reports problems such as a duplicate id or an unknown
`parentId` only through `chrome.runtime.lastError` while its callback runs. The wrapper
passes a callback, reads `lastError` inside it, and resolves only once Chrome confirms the
item, so a duplicate id fails the Effect with `{ operation: "create", cause: lastError }`
instead of logging an "Unchecked runtime.lastError" warning. Because `lastError` is not a
`contextMenus` member, the injected `ChromeContextMenusApi` carries it as a `lastError`
property; `layerLive` wires it to a live view of `chrome.runtime.lastError`.

Interrupting `create` stops the wait; it does not undo a creation Chrome already started.

## Where to create menus

MV3 menu items persist across service-worker restarts: Chrome keeps them when the worker
stops, and recreating them on every wake fails with duplicate ids. Create permanent menus
once, from `runtime.onInstalled`. Clearing first keeps installs and updates idempotent:

```ts
import { Effect } from "effect"
import * as ChromeContextMenus from "effect-platform-chrome/ChromeContextMenus"
import * as ChromeServiceWorker from "effect-platform-chrome/ChromeServiceWorker"

const installMenus = Effect.gen(function*() {
  const menus = yield* ChromeContextMenus.ChromeContextMenus
  yield* menus.removeAll
  yield* menus.create({ id: "save-link", title: "Save link", contexts: ["link"] })
})

ChromeServiceWorker.start({
  chrome,
  layer: ChromeContextMenus.layerLive,
  onInstalled: () => installMenus,
  listeners: [
    // Wake listener: registered synchronously at worker startup.
    ChromeServiceWorker.listen(chrome.contextMenus.onClicked, (info, tab) =>
      Effect.log("Clicked", info.menuItemId, tab?.url))
  ]
})
```

`item(properties)` is the scoped alternative, for menus owned by something shorter-lived
than the extension: an extension page, or a session that adds commands while it is active.
It creates on acquire and removes on release. Release is best effort: an item that is
already gone (for example after `removeAll`) is ignored, and Chrome may stop a worker
without running finalizers, leaving the item behind. Do not rely on scoped items in a
service worker for cleanup.

## Clicks wake the worker only through `ChromeServiceWorker`

`onClicked` is observational, like every stream in this library: each consumption adds a
listener while it runs and removes it when the stream ends. Such a listener cannot wake a
stopped MV3 worker, and a click on a persisted menu usually arrives at a stopped one.
Register the wake listener with `ChromeServiceWorker.listen(chrome.contextMenus.onClicked, ...)`
as above, synchronously at startup. Each stream subscription buffers at most 64 events,
dropping the oldest.

## Testing

`effect-platform-chrome/testing/ContextMenus` exports `makeContextMenus()`, an in-memory
item tree. Its `create` returns the id at once and runs the callback in a microtask with
`lastError` set for a duplicate id or unknown parent; `remove` drops descendants;
`controls.click(id, info?, tab?)` emits `onClicked` for an existing item, filling
`menuItemId`, `parentMenuItemId`, `editable` and `pageUrl`.
