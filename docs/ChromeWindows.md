# ChromeWindows

Import from `effect-platform-chrome/ChromeWindows`. `ChromeWindows` is an Effect v4 service
over `chrome.windows`. `make(api)` and `layer(api)` take an injectable Promise-based subset;
`layerLive` reads `chrome.windows` only when built, failing with `operation: "initialize"`
where the namespace is missing. No manifest permission is needed, except `"tabs"` for the
`url`, `title` and `favIconUrl` of tabs in windows read with `populate: true`.

| Member | Behaviour |
| --- | --- |
| `get(windowId, queryOptions?)` | One window; fails for an unknown id or one `windowTypes` excludes. |
| `getCurrent(queryOptions?)` | The window running the calling code; in a service worker, the last active window. |
| `getLastFocused(queryOptions?)` | The most recently focused matching window. |
| `getAll(queryOptions?)` | Every matching window, possibly none. |
| `create(createData?)` | `Option<Window>`: none when Chrome hides the new window (see incognito). |
| `update(windowId, updateInfo)` | Changes only the given properties. |
| `focus(windowId)` | `update(windowId, { focused: true })`; fails as `"update"`. |
| `remove(windowId)` | Closes the window and its tabs. |
| `onCreated(filter?)`, `onRemoved(filter?)`, `onFocusChanged(filter?)` | Window-type-filterable event streams. |
| `onBoundsChanged` | Committed size or position changes. |

Optional arguments reach Chrome only when given, so `getAll()` calls `chrome.windows.getAll()`
and `onCreated()` adds its listener without a filter. Every window id also accepts
`WINDOW_ID_CURRENT` (-2); `WINDOW_ID_NONE` (-1) is exported for comparing focus changes.
Failures are `ChromeWindowsError` with the Chrome member as `operation` (`get`, `create`,
`update`, `onFocusChanged`, …) and Chrome's rejection or throw as `cause`, unchanged.

## Which windows you see

- Queries without `windowTypes` see `normal` and `popup` windows. Pass
  `{ windowTypes: ["devtools"] }` (and so on) to see others; `app` and `panel` windows are
  visible only to the extension that owns them.
- Event listeners without a filter see `normal`, `popup` and the extension's own `app` and
  `panel` windows, never `devtools` ones. A filter replaces that default; an empty
  `windowTypes` list matches nothing. `onBoundsChanged` takes no filter and covers the
  unfiltered set.
- Windows of an incognito profile are invisible, in calls and events alike, unless the user
  allowed the extension in incognito. `create({ incognito: true })` then still opens the
  window but resolves to `Option.none()`.

## Focus

`onFocusChanged` reports every focus change to every subscription. When the newly focused
window is one the subscription cannot see (excluded by its filter or the default types, or an
inaccessible incognito window), it receives `WINDOW_ID_NONE` instead of the id, exactly as when
Chrome loses focus to another application. On some Linux window managers `WINDOW_ID_NONE` also
arrives immediately before every switch between two Chrome windows, so treat it as transient.

`update` validates combinations as Chrome does and rejects them with `Invalid value for state`:
`minimized`, `maximized` and `fullscreen` cannot be combined with `left`/`top`/`width`/`height`,
`focused: true` not with `minimized`, and `focused: false` not with `maximized` or
`fullscreen`. `create` applies the same rules. Bounds given without a state change a
maximized or minimized window's restored bounds without restoring it; `state: "normal"`
restores it. `focused: false` brings
the next window in z-order to the front. `locked-fullscreen` needs the ChromeOS-only
`lockWindowFullscreenPrivate` permission; `setSelfAsOpener` fails in a service worker.

## Events are observations

The streams are scoped observations: each consumption adds its own listener when it starts
and removes it when it ends, fails or is interrupted, and buffers at most 64 undelivered
events, dropping the oldest. They cannot wake a suspended MV3 service worker; register
listeners that must survive suspension through `ChromeServiceWorker`.

```ts
import { Effect, Stream } from "effect"
import * as ChromeWindows from "effect-platform-chrome/ChromeWindows"

const followFocus = Effect.gen(function*() {
  const windows = yield* ChromeWindows.ChromeWindows

  yield* windows.onFocusChanged({ windowTypes: ["normal"] }).pipe(
    Stream.filter((windowId) => windowId !== ChromeWindows.WINDOW_ID_NONE),
    Stream.mapEffect((windowId) => windows.get(windowId, { populate: true })),
    Stream.runForEach((window) => Effect.log(`${window.tabs?.length ?? 0} tabs in focus`))
  )
}).pipe(Effect.provide(ChromeWindows.layerLive))
```

## Testing

`makeWindows` in `effect-platform-chrome/ChromeTesting` (`src/testing/Windows.ts`) is an
in-memory window list for tests. It returns `{ api, layer, controls }` and models what this
page describes: default and explicit `windowTypes` for queries and events, `-1` focus reports
for hidden windows, focus history (removing, minimizing or unfocusing the focused window
refocuses the most recently focused other window that is not minimized, or reports -1),
restoring a minimized window when it is focused, Chrome's state/focus/bounds validation,
`WINDOW_ID_CURRENT`, and incognito access through `controls.incognitoAccess`. `controls.seed`
adds windows of any type or state without validation. Tabs, URLs and `populate` are not
modelled, and state changes do not move bounds.
