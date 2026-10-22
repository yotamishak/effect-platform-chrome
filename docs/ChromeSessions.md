# ChromeSessions

Import from `effect-platform-chrome/ChromeSessions`. `make(api)` and `layer(api)` take an
injectable Promise-based `chrome.sessions` subset; `layerLive` reads the global only when built
and fails with `operation: "initialize"` without it. Every call needs the `"sessions"`
permission. Tab URLs, titles and favicons are only reported with `"tabs"` or matching host
permissions.

```ts
import { Effect, Option } from "effect"
import * as ChromeSessions from "effect-platform-chrome/ChromeSessions"

// Reopens the most recently closed tab, skipping closed windows.
const reopenLastTab = Effect.gen(function*() {
  const sessions = yield* ChromeSessions.ChromeSessions
  const closed = yield* sessions.getRecentlyClosed({ maxResults: 10 })
  const lastTab = closed.find((session) => session.tab !== undefined)

  if (lastTab === undefined) return Option.none()

  return yield* Option.match(ChromeSessions.sessionIdOf(lastTab), {
    onNone: () => Effect.succeedNone,
    onSome: (sessionId) => Effect.asSome(sessions.restore(sessionId))
  })
}).pipe(Effect.provide(ChromeSessions.layerLive))
```

## What Chrome reports

- **Recently closed** (`getRecentlyClosed`): at most 25 entries, most recently closed first.
  Each is a tab or a window; a closed tab group is listed as its tabs. Closed tabs carry a
  `sessionId` and no `id`. A closed window lists its tabs, and each of those tabs' `sessionId`s
  can be restored on its own; the window entry disappears once its last tab is restored.
  Chrome keeps little of what was closed: a closed tab is always listed with `active: false`,
  and a closed window always as a `"normal"` window in the `"normal"` state, unfocused, not
  incognito and without bounds, with its selected tab as the one active tab. Restoring reopens
  the tab or window as it really was.
- **Synced devices** (`getDevices`): other devices' open windows, most recently active device
  first, or `[]` when tab sync is off. `maxResults` bounds the windows listed **per device**, not
  the number of devices. Their session ids look like `<device tag>.<id>`; restoring one opens
  that tab or window here and leaves the device's list as it was.
- **`lastModified`** is in seconds since the epoch. Multiply by 1000 for a `Date`.
- **`maxResults`** must be an integer from 0 to `MAX_SESSION_RESULTS` (25). Chrome's bindings
  throw synchronously for anything else; that surfaces as `ChromeSessionsError` with the method
  as `operation`, like a rejection.

## Restoring

`restore()` reopens the most recent entry; `restore(sessionId)` reopens that entry, a tab of a
closed window, or a synced device's tab or window. The result describes the live tab or window
(with its new ids) and has `lastModified` set to the restore time.

Chrome parses the id before looking it up: a local id is one 32-bit integer, and a device id is
a tag, the first `.`, then one integer. A sign and leading zeros are accepted, so `"007"` and
`"+7"` both name entry `7`. An id that parses but matches nothing is reported in its canonical
spelling (`"0099"` as `"99"`); one that does not parse is reported as given. Chrome rejects with:

| Message | When |
| --- | --- |
| `There are no recently closed sessions.` | `restore()` with nothing closed |
| `Invalid session id: "<id>".` | an unknown, malformed or already restored id |
| `Can not restore sessions in incognito mode.` | called from an incognito context |
| `Synced sessions are not available.` | a device id while tab sync is off |
| `There are no browser windows to restore the session.` | no window is open for the profile |
| `Tabs cannot be edited right now (user may be dragging a tab).` | the tab strip is busy |
| `Unable to determine live tab context.` or `No active tab.` | the window to restore into has no active tab |

Interrupting a `restore` effect does not undo it: once Chrome has the call, the tab or window
reopens, and only the result is discarded.

Chrome handles the calls one at a time: each of several concurrent `restore()` calls reopens
the then most recent entry, and once the list is empty the rest fail as above.

## onChanged

`onChanged` emits `void` whenever the recently closed list changes: a close, a restore, an
eviction, or clearing history. Chrome may fire it more than once for one change (restoring an
entry fires it twice), and synced device changes never fire it, so use it as a cue to re-read
`getRecentlyClosed` rather than as a count. Like every stream in this library it is
observational: each consumption owns a listener, removed when the stream ends or is
interrupted, and keeps at most 64 pending events, dropping the oldest. It cannot wake an MV3
service worker; register wake listeners through `ChromeServiceWorker`.

## Testing

`makeSessions(overrides?)` from `effect-platform-chrome/testing/Sessions` returns
`{ api, layer, controls }` over an in-memory recently closed list and device list:

- `controls.closeTab(tab?)` and `controls.closeWindow(window?, tabs?)` record copies of their
  arguments as Chrome does (numeric `sessionId`s, no live `id`, newest 25 kept) and fire
  `onChanged`; `controls.clear()` empties the list and fires it. Entries are listed in Chrome's
  reduced shape (inactive tabs; normal, unfocused windows without bounds with one active tab)
  and restored as they were given.
- `controls.setDevices(devices)` replaces the synced devices without an event, and
  `controls.setTime(seconds)` sets the clock used for `lastModified`.
- `restore` follows Chrome: Chrome's id parsing, fresh live ids, Chrome's messages, two `onChanged` events per
  restored entry (one when only a tab of a window that keeps other tabs is restored), none for a
  device's session.
- An invalid `maxResults` throws synchronously, as the bindings do.
