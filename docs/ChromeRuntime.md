# ChromeRuntime

Import from `effect-platform-chrome/ChromeRuntime`. `ChromeRuntime` is an Effect v4
service over `chrome.runtime`; `make(api)` and `layer(api)` accept an injectable
Promise-based subset, and `layerLive` reads `chrome.runtime` only when built, failing
with `operation: "initialize"` when it is missing. Importing the module never touches
Chrome.

Every failure is a `ChromeRuntimeError` whose `operation` is the Chrome member name and
whose `cause` is the rejection or throw unchanged. The schema helpers add two phases of
`sendMessage`: `"sendMessage.encodeRequest"` (nothing was sent) and
`"sendMessage.decodeResponse"`.

## Calls

| Member | Notes |
| --- | --- |
| `id`, `getManifest`, `getVersion` | Effect values. `id` fails once the context is invalidated (a content script orphaned by an extension reload). `getVersion` is Chrome 143+. |
| `getURL(path)` | The `chrome-extension://` URL of a packaged file. |
| `sendMessage(message, { extensionId?, options? })` | The unvalidated reply; fails when nothing receives the message. See below for how the arguments reach Chrome. |
| `sendMessageSchema(request, response, message, options?)` | Encodes, sends, decodes. |
| `request(request, value, message, options?)` | For receivers answering with the `ChromeMessage` envelope (`ChromeServiceWorker.start`); a failure envelope is a `ChromeMessageError`. |
| `sendNativeMessage(application, message)` | One message to a native host (`"nativeMessaging"` permission); `message` is a JSON object. |
| `getContexts(filter)` | Chrome 116+. `{}` matches every context. |
| `getPackageDirectoryEntry` | Extension pages only (not service workers); a legacy FileSystem `DirectoryEntry`. |
| `openOptionsPage`, `reload`, `requestUpdateCheck`, `getPlatformInfo` | Effect values. `reload` tears down every context, the caller included. |
| `restart`, `restartAfterDelay(seconds)` | ChromeOS kiosk mode only; no-ops elsewhere. `-1` cancels a scheduled restart. |
| `setUninstallURL(url)` | http(s), at most 1023 characters; `""` clears it. |

A member Chrome lacks in the calling context (a content script, an older Chrome, a
worker for `getPackageDirectoryEntry`) fails with the typed error for that member.

### How `sendMessage` passes its arguments

Chrome reads a two-argument `sendMessage(a, b)` as `(extensionId, message)` only when
`a` is a string or null, and as `(message, options)` otherwise. The service therefore
calls `sendMessage(message)`, `sendMessage(extensionId, message)` or, whenever options
are given, the unambiguous three-argument form with an explicit `undefined` extension id.
A string message sent with options can never be mistaken for an extension id.

## Events

All events are observational streams: one listener per consumption, removed when the
stream ends, fails or is interrupted, and a 64-event sliding buffer that drops the
oldest event on overflow. They cannot wake an MV3 service worker; register wake
listeners synchronously with `ChromeServiceWorker`. An event Chrome does not offer in
the calling context fails the stream with the typed error.

| Stream | Emits |
| --- | --- |
| `onInstalled` | `InstalledDetails` |
| `onStartup`, `onSuspend`, `onSuspendCanceled` | `void` |
| `onUpdateAvailable` | `UpdateAvailableDetails` |
| `onRestartRequired` | `"app_update" \| "os_update" \| "periodic"` (ChromeOS kiosk only) |
| `onEnabled` | `void` (Chrome 155+) |
| `onMessage`, `onMessageExternal`, `onUserScriptMessage` | `{ message, sender }` |
| `onConnect`, `onConnectExternal`, `onConnectNative`, `onUserScriptConnect` | the native `Port` |

The message streams never answer: their listener returns nothing, so another listener
(such as `ChromeServiceWorker.start`'s) keeps the response channel. While one runs in a
context without any other `onMessage` listener, a sender to that context gets no answer
instead of a missing-receiver failure. Check `sender.id` / `sender.origin` before
trusting external messages. Every listener of a connect event receives the same port;
wrap it with `ChromePort.adopt`, as `"borrowed"` when another listener owns it.
`onUserScriptMessage` / `onUserScriptConnect` need Chrome 115+ and the `"userScripts"`
permission; `onConnectNative` exists on ChromeOS only.

## Not wrapped

`connect` and `connectNative` return ports and belong to `ChromePort`;
`getBackgroundPage` and `onBrowserUpdateAvailable` are MV2-only or deprecated;
`lastError` only matters to callback calls, and this module uses Promises.
