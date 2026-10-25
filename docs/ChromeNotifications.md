# ChromeNotifications

Import from `effect-platform-chrome/ChromeNotifications`. `ChromeNotifications` is an Effect v4
service over `chrome.notifications` (the `notifications` manifest permission). `make(api)` and
`layer(api)` accept the injectable Promise-based subset `ChromeNotificationsApi` (Promises since
Chrome 116); `layerLive` reads `chrome.notifications` only when the layer is built and fails with
`operation: "initialize"` where it is missing.

| Member | Chrome call | Result |
| --- | --- | --- |
| `create(options, notificationId?)` | `create([notificationId,] options)` | The shown notification's id |
| `update(notificationId, options)` | `update` | Whether it was showing |
| `clear(notificationId)` | `clear` | Whether it was showing |
| `getAll` | `getAll` | The showing ids, as a list |
| `getPermissionLevel` | `getPermissionLevel` | `"granted"` or `"denied"` |
| `onClicked` | `onClicked` | The clicked notification's id |
| `onButtonClicked` | `onButtonClicked` | `{ notificationId, buttonIndex }` |
| `onClosed` | `onClosed` | `{ notificationId, byUser }` |
| `onPermissionLevelChanged` | `onPermissionLevelChanged` | The new level |

`getAll` and `getPermissionLevel` are Effect values that ask Chrome afresh on every run. Every
call failure, rejection or synchronous throw, is a `ChromeNotificationsError` whose `operation`
is the Chrome member name and whose `cause` is Chrome's error, unchanged. `create` passes the
id to Chrome only when one is given; an empty id asks Chrome to generate one, as no id does.

The deprecated `onShowSettings` is left out: no Chrome UI has dispatched it since Chrome 65.

## What Chrome enforces

Read from Chromium's implementation (`notifications_api.cc` and the extension notification
display helper), so the fixture can reproduce it:

- **Turned-off notifications.** While the user has turned this extension's notifications off,
  every call except `getPermissionLevel` fails with the message `"Unknown error."` (Chrome
  responds with an empty error, which the bindings replace). `getPermissionLevel` reports
  `"denied"`; `onPermissionLevelChanged` only fires on ChromeOS.
- **Ids.** An id may be at most 500 bytes of UTF-8. Chrome's documentation says characters,
  but `"é".repeat(251)` (502 bytes) is refused. Without an id, Chrome generates a UUID.
- **Replacing.** `create` with the id of a showing notification replaces it in place. No
  `onClosed` is dispatched for the replaced one.
- **`create` checks**, in order: `type`, `iconUrl`, `title` and `message` must be present
  (empty strings are present); outside ChromeOS a negative `priority` is refused; `imageUrl`
  must be given exactly for `"image"`; non-empty `items` exactly for `"list"`; `progress` only
  for `"progress"`, between 0 and 100. Images that fail to load are refused as well, with
  `"Unable to download all specified images."`.
- **Argument types.** Chrome's bindings validate argument types before the call reaches the
  browser and throw synchronously, for example for a `priority` or `progress` that is not an
  integer; the service maps that throw to the same typed error.
- **`update` checks** the fields it is given against the template the notification ends up
  with (`progress` on a basic notification is refused, `{ type: "progress", progress: 5 }` is
  accepted) and changes nothing when it refuses them. An unknown id resolves `false` without
  checking anything. Empty `items` are ignored.
- **Buttons.** Only the first two are shown; the rest are ignored.
- **`getAll`** builds its result from a sorted set of ids, so the list comes back sorted, with
  integer-like ids first as in any JavaScript object.
- **Options are copied as JSON.** The bindings copy the options through `JSON.stringify`
  before sending them, so `undefined` fields are dropped, and they load every image URL first.
- **Events.** `clear` closes the notification through the platform's notification backend,
  which may report it through `onClosed` with `byUser: false` (Chrome's own notification
  center does; the fixture always does). Clicks and user dismissals are dispatched as user
  gestures, but stream consumers run after the listener returns, so a gesture-only call (such
  as `ChromePermissions.requestFromUserGesture`) cannot use them.

## Events

Each stream consumption registers its own listener when it starts and removes it when its scope
closes, including on interruption, completion or failure, and when Chrome's `addListener`
registered the listener before throwing. A registration failure is a `ChromeNotificationsError`
named after the event. Each subscription buffers at most 64 undelivered events and drops the
oldest. These listeners are observational: they cannot wake an MV3 service worker, so register
wake listeners through `ChromeServiceWorker`.

## Testing

`makeNotifications(overrides?)` from `effect-platform-chrome/ChromeTesting` returns
`{ api, layer, controls }` over in-memory notifications that apply the rules above, with
Chrome's messages exported as `notificationErrors`. Generated ids are `notification-<n>`,
skipping ids in use, instead of UUIDs; the negative-priority rule is the desktop one; image
URLs are not loaded. Of the argument types, only the integer `priority` and `progress` are
checked: anything else throws a `TypeError` synchronously from `create` and `update`, with the
message `notificationIntegerError(property)` (Chrome's, without the invocation signature).

`controls` simulate the user and the system: `click`, `clickButton` (only the shown buttons),
`close(id, byUser = true)`, and `setPermissionLevel`, which fires `onPermissionLevelChanged`
when the level changes and makes the API refuse calls while `"denied"`. Each returns the
exceptions thrown by listeners. `notification(id)` returns a copy of the stored options and
`permissionLevel` the current level.

Stress coverage lives in `test/stress/ChromeNotifications.stress.test.ts`: 4,096-event bursts
on every event, 512 subscriptions churned through every stage, 1,536 concurrent calls with
interleaved rejections and throws, interrupted in-flight calls, 10,000-notification fixture
populations, 2,048 concurrent fixture calls that throw, reject or succeed, and races between
same-id creates, updates and clears, and a permission change.
