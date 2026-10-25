# ChromeServiceWorker

`ChromeServiceWorker` integrates an Effect runtime with a Manifest V3 service worker. Chrome
starts the worker to deliver an event and dispatches that event only to listeners that exist
once the worker's top-level code has run, so every wake listener must be added synchronously at
startup, before any `await`. `start` does that, then builds the layer and runs `initialize`,
holding events that arrive meanwhile in a bounded in-memory queue.

It is not a `chrome.*` namespace wrapper, so it has no service, `layer` or `layerLive`. Chrome
events are passed in (`chrome: { runtime, alarms }`, or the event objects themselves), and the
module never reads the `chrome` global.

## Starting the worker

```ts
import { Effect, Layer } from "effect"
import * as ChromeServiceWorker from "effect-platform-chrome/ChromeServiceWorker"

const worker = ChromeServiceWorker.start({
  chrome,
  layer: AppLayer,
  initialize: hydrateCaches,
  selectMessage: (message) => isOurProtocol(message),
  onMessage: (message, sender) => handle(message, sender),
  onConnect: (port) => servePort(port),
  onInstalled: (details) => Effect.log("installed", details.reason),
  onAlarm: (alarm) => runAlarm(alarm),
  listeners: [
    ChromeServiceWorker.listen(chrome.action.onClicked, (tab) => openPanel(tab)),
    ChromeServiceWorker.listen(chrome.webNavigation.onCommitted, (details) => track(details),
      { url: [{ hostEquals: "example.com" }] }),
    ChromeServiceWorker.listenReply(chrome.runtime.onMessageExternal, {
      select: (_message, sender) => sender.id === TRUSTED_EXTENSION_ID,
      handler: (message) => answerExternal(message)
    }),
    ChromeServiceWorker.listenPort(chrome.runtime.onConnectExternal, (port) => serveExternal(port))
  ],
  onError: (error) => console.error(error)
})
```

`start` throws, with nothing left registered, for an invalid `maxPending`, a missing or doubled
`layer` / `runtime`, a `selectMessage` without `onMessage`, a configured event that is
unavailable, or an `addListener` that throws. All listeners are installed together: if one
cannot be added, the others are removed again.

`ready` resolves to the initialization `Exit`. `dispose()` removes every listener, answers
queued events with `Disposed`, interrupts running handlers and disposes an owned runtime (a
borrowed `runtime` is left running). Chrome can stop a worker without running any of this; the
queue and running fibers are not durable.

## Three kinds of wake listener

| Helper | For | Handler result |
| --- | --- | --- |
| `listen(event, handler, ...addListenerArgs)` | any event | discarded; a failure goes to `onError` |
| `listenReply(event, { select?, handler, reply? }, ...addListenerArgs)` | events answered through a callback passed last: `runtime.onMessageExternal`, `runtime.onUserScriptMessage`, `downloads.onDeterminingFilename`, `webRequest.onAuthRequired` with `["asyncBlocking"]` | sent through the callback exactly once |
| `listenPort(event, handler, ...addListenerArgs)` | events that hand over a port: `runtime.onConnectExternal`, `runtime.onUserScriptConnect`, `runtime.onConnectNative` | discarded; a port whose handler never starts is disconnected |

The extra arguments are passed to `addListener` exactly as given, never padded with
`undefined`: a webNavigation URL filter, or a webRequest `RequestFilter` and `extraInfoSpec`.
The types follow the event, so a required webRequest filter cannot be left out.

`start`'s named options are the same helpers: `selectMessage` / `onMessage` is `listenReply` on
`runtime.onMessage`, and `onConnect` is `listenPort` on `runtime.onConnect`. Listeners can also
be added later with `worker.register(listener)` or `worker.register(event, handler, ...args)`,
but only listeners added during the worker's first synchronous turn can wake it.

### Answering through a callback

`listenReply` returns true for a selected event, which tells Chrome the answer comes
asynchronously, and calls the callback exactly once:

- with `{ ok: true, value }` when the handler succeeds;
- with `{ ok: false, error }` when it fails or never runs: `HandlerFailed`, `Overflow`,
  `InitializationFailed` or `Disposed`.

That is the `ChromeMessage` envelope, which `ChromeMessage.decodeResponse` and
`ChromeRuntime.request` unwrap on the sending side. A callback that is not a message channel
takes `reply`, which builds its argument from the envelope; returning `undefined` calls the
callback with no argument:

```ts
ChromeServiceWorker.listenReply(chrome.downloads.onDeterminingFilename, {
  handler: (item) => chooseFilename(item),
  reply: (response) => response.ok ? { filename: response.value, conflictAction: "uniquify" } : undefined
})
```

`select` returning false (or throwing, which is reported) leaves the event unanswered for other
listeners or Chrome's default: an unclaimed message closes its channel, and an unanswered
filename event keeps the tentative name. A blocking webRequest callback must always be called,
so leave `select` out there and decide in the handler. If the answer cannot be built or
delivered (for example a value Chrome cannot serialize), the failure is reported and a
successful outcome is answered once more as a `HandlerFailed` envelope. Check `sender.id` or
`sender.origin` before trusting an external message.

## The startup queue

Until initialization finishes, accepted events wait in one queue shared by every listener,
holding at most `maxPending` (default 64). It keeps the oldest events: a later one fails at once
with `Overflow`. A claimed reply is answered with it and a port is disconnected, instead of
holding a channel open with no one to serve it; a plain event or a port is also reported to
`onError`. After initialization nothing is queued; every
event's handler starts immediately. If initialization fails, queued and later events fail with
`InitializationFailed`.

## Handler failures

A handler's failure, defect, interruption or synchronous throw is a `HandlerFailed` error with
the pretty-printed cause. `onError` receives `listen` / `listenPort` handler failures and events they
could not run, selector throws, reply delivery failures and the initialization failure (a reply
listener's own failures are answered through its callback instead); it must be synchronous, and a
throw from it is ignored. Without `onError`, they go to `console.error`.
