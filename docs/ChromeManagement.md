# ChromeManagement

`ChromeManagement` wraps `chrome.management`: the installed extensions, apps and themes,
their permission warnings, enabling, uninstalling, the remaining app calls, and the
install, uninstall, enable and disable events. Every failure is a
`ChromeManagementError` whose `operation` is the Chrome member name (`"uninstall"`,
`"onEnabled"`, `"initialize"`).

```ts
import { Effect, Layer } from "effect"
import { ChromeManagement } from "effect-platform-chrome"

const program = Effect.gen(function*() {
  const management = yield* ChromeManagement.ChromeManagement
  const items = yield* management.getAll
  return items.filter((item) => item.type === "extension" && !item.enabled)
})

Effect.runPromise(program.pipe(Effect.provide(ChromeManagement.layerLive)))
```

## What needs the "management" permission

`chrome.management` exists in every extension context except content scripts, but
without the "management" permission Chrome exposes only three members:

| Works without the permission | Needs `replacement_web_app` in the manifest | Needs the permission |
| --- | --- | --- |
| `getSelf`, `getPermissionWarningsByManifest`, `uninstallSelf` | `installReplacementWebApp` (not on Android) | everything else, events included |

`layerLive` therefore builds without the permission. A call or stream whose member Chrome
left out fails with a typed error (`chrome.management.getAll is unavailable: it requires
the "management" permission`), never a defect. `ChromeManagementApi` marks those members
optional, so an injected API can leave them out the same way.

## User gestures

Chrome honours some calls only inside a user gesture, such as a click handler. Each of
these has a lazy form, which reaches Chrome only when the Effect runs (usually too late),
and an `xFromUserGesture` form, which starts the native call immediately and returns an
Effect awaiting its outcome. Running that Effect again, or interrupting it, never repeats
or cancels the call; an outcome nobody awaits is absorbed rather than reported as an
unhandled rejection.

| Call | When Chrome needs a gesture | Gesture form |
| --- | --- | --- |
| `setEnabled` | Re-enabling an item disabled for a permissions increase (`disabledReason: "permissions_increase"`), which then shows a re-enable prompt | `setEnabledFromUserGesture` |
| `uninstall` | Always for another item, because Chrome always confirms | `uninstallFromUserGesture` |
| `uninstallSelf` | With `showConfirmDialog: true` | `uninstallSelfFromUserGesture` |
| `setLaunchType` | Always | `setLaunchTypeFromUserGesture` |
| `createAppShortcut` | Always | `createAppShortcutFromUserGesture` |
| `generateAppForLink` | Always | `generateAppForLinkFromUserGesture` |
| `installReplacementWebApp` | Always | `installReplacementWebAppFromUserGesture()` |

```ts
button.addEventListener("click", () => {
  // Started inside the click; the Effect only awaits Chrome's answer.
  const outcome = management.uninstallFromUserGesture(id)
  Effect.runFork(outcome.pipe(Effect.catchTag("ChromeManagementError", reportCancel)))
})
```

Disabling, `launchApp`, the reads and `uninstallSelf` without a dialog need no gesture.
`uninstallSelf` without a dialog removes the extension at once, so its Effect may never
complete.

## Events

`onInstalled`, `onUninstalled` (the removed id), `onEnabled` and `onDisabled` are
observational streams: each consumption owns one listener, removed when its scope closes,
and buffers at most 64 events, dropping the oldest. They cannot wake an MV3 service
worker; register wake listeners through `ChromeServiceWorker.listen`. For this
extension's own install and update, use `ChromeRuntime`.

## Testing

`makeManagement` from `effect-platform-chrome/testing/Management` returns
`{ api, layer, controls }` over an in-memory `chrome.management`:

- `self` and `installed` seed the items (`extensionInfo(id, properties)` fills a complete
  entry; `extensionId(n)` makes distinct 32-letter ids); `permission: false` drops the
  gated members as Chrome does; `replacementWebApp` adds `installReplacementWebApp`;
  `warnings` maps permissions and host patterns to warning text.
- Calls fail with Chrome's messages for unknown ids, items the user may not modify,
  app-only calls on non-apps, unavailable launch types, invalid links, manifests Chrome
  could not load and missing gestures.
- `controls.withUserGesture(run)` makes the calls `run` starts synchronously count as a
  gesture, so it tells `uninstallFromUserGesture` apart from a lazy `uninstall` run later.
- Dialogs accept by default; `controls.answerDialogs("cancel" | "hold")` changes that, and
  held dialogs wait in `controls.pendingDialogs` for `controls.answerDialog(accepted)`.
- `controls.install`, `controls.uninstall` and `controls.setEnabled(id, enabled, reason)`
  simulate changes made outside the API and emit the matching events.
