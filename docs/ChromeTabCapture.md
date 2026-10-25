# ChromeTabCapture

Import from `effect-platform-chrome/ChromeTabCapture`. `ChromeTabCapture` is an Effect v4
service over `chrome.tabCapture`. `make(api)` and `layer(api)` take an injectable subset;
`layerLive` reads `chrome.tabCapture` (and `chrome.runtime.lastError`, for `capture`) only
when built, failing with `operation: "initialize"` where the namespace is missing. Requires
the `"tabCapture"` manifest permission and Chrome 116+ (the Promise forms).

| Member | Behaviour |
| --- | --- |
| `getMediaStreamId(options?)` | A single-use stream id for `targetTabId` (default: the active tab). Works in the service worker. `options` reaches Chrome only when given. |
| `getCapturedTabs` | This extension's `pending` and `active` captures. An empty list stays a list. |
| `capture(options)` | Scoped: the tab's `MediaStream`, whose tracks all stop when the scope closes. Foreground only. |
| `onStatusChanged` | Observational stream of `CaptureInfo` (`tabId`, `status`, `fullscreen`), 64-event sliding buffer. |

Failures are `ChromeTabCaptureError` with the Chrome member as `operation`
(`getMediaStreamId`, `getCapturedTabs`, `capture`, `onStatusChanged`, `initialize`) and
the original rejection, throw or `lastError` as `cause`.

## What Chrome requires

- **An invocation grant.** The target tab must hold the extension's `activeTab` grant, which
  the user gives by invoking the extension on it (an action click, a command, a context
  menu). Without it Chrome fails with "Extension has not been invoked for the current page
  (see activeTab permission). Chrome pages cannot be captured." A navigation ends the grant
  but not a running capture. No transient user activation is needed beyond that, so these
  calls are ordinary lazy Effects.
- **One capture per tab.** A tab whose capture is `pending` or `active` cannot be captured
  again: "Cannot capture a tab with an active stream." Each `getMediaStreamId` registers a
  `pending` capture, so check `getCapturedTabs` (or keep your own state) before asking twice.
- **Audio goes quiet.** While a tab's audio is captured it stops playing to the user. To keep
  it audible, route the stream through an `AudioContext`:
  `context.createMediaStreamSource(stream).connect(context.destination)`.

## From the service worker: `getMediaStreamId`

A service worker has no `MediaStream`; it obtains an id and hands it to a page that does,
usually an offscreen document with the `USER_MEDIA` reason (see `ChromeOffscreen`):

```ts
// Service worker, in response to an action click on the tab.
const program = Effect.gen(function*() {
  const capture = yield* ChromeTabCapture.ChromeTabCapture
  const offscreen = yield* ChromeOffscreen.ChromeOffscreen
  const streamId = yield* capture.getMediaStreamId({ targetTabId: tab.id })
  yield* offscreen.ensureDocument({ url: "offscreen.html", reasons: ["USER_MEDIA"], justification: "Record the tab" })
  // send streamId to the offscreen document with ChromeRuntime or ChromePort
})

// Offscreen document.
const stream = await navigator.mediaDevices.getUserMedia({
  audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
  video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } }
})
```

The id can be redeemed once, within a few seconds. Without `consumerTabId` it works in any
frame of this extension's process with the extension's origin (the offscreen document, a
popup, an extension tab). With `consumerTabId` it works only in frames of that tab whose
origin matches it, and the tab's URL must be secure (HTTPS): "URL scheme for the specified
tab is not secure."

## In an extension page: `capture`

`chrome.tabCapture.capture` exists only in extension pages (popup, side panel, options page,
extension tabs), not in the service worker or an offscreen document. It captures the active
tab of the last active window and needs `audio` or `video` in `options` ("Capture failed. No
audio or video requested."). Where Chrome does not define it, the call fails with the typed
error ("chrome.tabCapture.capture is unavailable in this context; it is foreground only").

The result is scoped, because a forgotten stream keeps the tab captured and blocks every
later capture of it:

```ts
const record = Effect.scoped(Effect.gen(function*() {
  const capture = yield* ChromeTabCapture.ChromeTabCapture
  const stream = yield* capture.capture({ audio: true, video: true })
  // record or render the stream; every track stops when this scope closes
}))
```

`capture` is callback-only in Chrome: success is a stream, failure a `null` stream with
`chrome.runtime.lastError` set only while the callback runs. The bridge reads `lastError`
inside the callback and owns the stream from the moment Chrome delivers it, so no stream
outlives its owner:

- closing the scope stops every track (stopping tracks the caller already stopped is harmless);
- a failure or an interruption of the wait stops a stream delivered with it or after it, at
  once, without waiting for the scope;
- a stream delivered after its scope closed is stopped and the waiting fiber fails;
- a stream delivered together with a `lastError` is stopped, and the call fails with it;
- a `null` stream without `lastError` fails with "chrome.tabCapture.capture delivered no
  stream";
- a repeated callback is ignored, and any stream it carries is stopped;
- a scope that is already closed fails at once with that error, without starting a capture
  in Chrome;
- a failed or interrupted attempt leaves no finalizer in the scope, so a retry loop inside
  one long-lived scope holds only the winning capture's release.

Each run of the Effect is an independent capture.

## Status events

`onStatusChanged` reports `pending`, `active`, `stopped` and `error` transitions and
fullscreen changes for this extension's captures. Like every stream in this library it is an
observation: each consumption adds one listener for its own lifetime, it cannot wake a
stopped MV3 service worker (use `ChromeServiceWorker.listen` for that), and it keeps at most
64 undelivered events, dropping the oldest.

## Testing

`effect-platform-chrome/testing/TabCapture` provides `makeTabCapture(overrides?)`, an
in-memory `chrome.tabCapture` for one window that returns `{ api, layer, controls }`. Tab 1
is open, secure and active, and no tab holds the `activeTab` grant until `controls.invoke`
gives it. The fixture enforces the rules above in Chrome's order and with Chrome's messages
(`tabCaptureErrors`), registers `pending` captures for stream ids, plays `getUserMedia` with
`controls.redeem`, lets ids lapse with `controls.expire`, ends captures with
`controls.stop`, `controls.fail` and `controls.closeTab`, and fires `onStatusChanged` for
each change. `capture` calls back in a microtask with a simulated stream from
`makeCaptureStream`, whose tracks stop once and end the capture when the last one stops;
`asMediaStream` hands such a stream to code typed against the DOM `MediaStream`.
