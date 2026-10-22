# ChromeContextMenus

Import from `effect-platform-chrome/ChromeContextMenus`. `ChromeContextMenus` is an
Effect v4 service over `chrome.contextMenus`; `make(api)` and `layer(api)` accept an
injected API, and `layerLive` reads `chrome.contextMenus` and `chrome.runtime` only when
built. The manifest needs the `"contextMenus"` permission; `update`, `remove` and
`removeAll` use the Promise forms Chrome 123 added.

- `create(properties)` resolves to the item's id: the `id` you gave, or a number Chrome
  generated. Chrome keeps string and numeric ids apart, so `"1"` and `1` are different items.
- `update(id, properties)` changes the given fields; `remove(id)` also removes the item's
  descendants; both fail for an unknown id. `removeAll` is an `Effect` value.
- `item(properties)` creates an item for the life of a `Scope` (see below).
- `onClicked` emits `{ info, tab }`, with `tab` an `Option` because Chrome omits it
  outside tabs.
- `ACTION_MENU_TOP_LEVEL_LIMIT` (6) mirrors Chrome's constant: the toolbar-icon menu shows
  at most six top-level items and silently ignores the rest. `ContextType` and `ItemType`
  are the string unions of Chrome's enums.
- Failures are `ChromeContextMenusError` with the Chrome call as `operation`
  (`"create"`, `"update"`, `"remove"`, `"removeAll"`, `"onClicked"`, or `"initialize"`
  for a missing global) and the original `cause`, unchanged.

## Why `create` waits for a callback

`chrome.contextMenus.create` has no Promise form. It returns the id synchronously, before
Chrome has validated anything, and reports problems only through `chrome.runtime.lastError`
while its callback runs. The wrapper passes a callback, reads `lastError` inside it, and
resolves only once Chrome confirms the item, so a failure fails the Effect with
`{ operation: "create", cause: lastError }` instead of logging an "Unchecked
runtime.lastError" warning. Because `lastError` is not a `contextMenus` member, the injected
`ChromeContextMenusApi` carries it as a `lastError` property; `layerLive` wires it to a live
view of `chrome.runtime.lastError`. Malformed arguments (an unknown context, an empty
`contexts` list) make Chrome throw synchronously instead; that also becomes a `"create"`
error.

What Chrome reports through `lastError`, in the order it checks:

| Condition | Message |
| --- | --- |
| No `id`, in an extension with a service worker or event page | `Extensions using event pages or Service Workers must pass an id parameter to chrome.contextMenus.create` |
| The extension already has 1000 top-level items (this blocks child items too) | `An extension can create a maximum of 1000 menu items.` |
| The id is taken | `Cannot create item with duplicate id <id>` |
| `onclick`, in an extension with a service worker or event page | `Extensions using event pages or Service Workers cannot pass an onclick parameter …` |
| A `"launcher"` context (packaged apps only) | `Only packaged apps are allowed to use 'launcher' context` |
| No title on an item that is not a separator | `All menu items except for separators must have a title` |
| An unknown `parentId` | `Cannot find menu item with id <parentId>` |
| A parent that is not a `"normal"` item | `Parent items must have type "normal"` |

So an MV3 extension with a background service worker must always pass an `id`, even when
it creates menus from a popup or another extension page. Listen to `onClicked` rather than
passing `onclick`.

Interrupting `create` stops the wait; it does not undo a creation Chrome already started.
When Chrome confirms, the waiting fiber resumes inside Chrome's callback.

## Updating items

`update` applies the given fields in Chrome's order (type, title, checked, visible, enabled,
contexts, parent, URL patterns) and stops at the first problem, so a failed update can leave
earlier fields changed. It fails for an empty title on a non-separator, `checked: true` on an
item that is neither a checkbox nor a radio, a `"launcher"` context, or an unknown or
non-`"normal"` parent. Chrome refuses a `parentId` that is the item itself or one of its
descendants without reporting an error: the update resolves and the item stays where it
was. A moved item becomes the last child of its new parent, and `parentId` cannot move an
item back to the top level.

Radio items form groups by adjacency: each run of neighbouring radio siblings keeps exactly
one item checked, and clicking or checking one unchecks the others in its run.

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
It creates on acquire and removes on release. Interrupting it while Chrome has not yet
confirmed the item waits for that confirmation, so an item Chrome created is always removed
again. Release is best effort: a failed removal is ignored (for example, an item already
gone after `removeAll`), release removes whatever item has the id at that moment, and Chrome
may stop a worker without running finalizers, leaving the item behind. Do not rely on scoped
items in a service worker for cleanup.

## Clicks wake the worker only through `ChromeServiceWorker`

`onClicked` is observational, like every stream in this library: each consumption adds a
listener while it runs and removes it when the stream ends, fails or is interrupted. Such a
listener cannot wake a stopped MV3 worker, and a click on a persisted menu usually arrives
at a stopped one. Register the wake listener with
`ChromeServiceWorker.listen(chrome.contextMenus.onClicked, ...)` as above, synchronously at
startup. Each stream subscription buffers at most 64 events, dropping the oldest.

For checkbox and radio items Chrome fills `info.wasChecked` and `info.checked`: a checkbox
toggles, and a radio is always checked after a click.

## Testing

`effect-platform-chrome/testing/ContextMenus` exports `makeContextMenus(overrides?, options?)`,
an in-memory menu tree that follows Chrome's rules above:

- `create` returns the id at once (generated ids are increasing numbers) and runs the
  callback in a microtask with `lastError` set for every condition in the table;
  `options.serviceWorker: true` adds the service-worker rules (`id` required, no `onclick`).
  Malformed `contexts` or `type` values throw synchronously, for `create` and `update`.
- `update` applies fields in Chrome's order, keeps fields applied before a failure, and
  resolves without moving an item for a parent cycle; `remove` drops descendants.
- Radio runs keep exactly one checked item after every create, move, removal and click.
- `controls.item(id)`, `controls.items()` (creation order) and `controls.children(parentId?)`
  (menu order, top level without an argument) read the tree.
- `controls.click(id, info?, tab?)` emits `onClicked` for an existing item, filling
  `menuItemId`, `parentMenuItemId`, `editable: false`, `pageUrl` from the tab, and for
  checkbox and radio items `wasChecked` and `checked`, updating their state. `info`
  overrides any field. It returns the exceptions listeners threw. Stored `onclick`
  handlers are not called.
- `overrides` replaces any API member.
