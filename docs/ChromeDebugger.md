# ChromeDebugger

An injectable Effect v4 service for the Promise-based Manifest V3 `chrome.debugger` API, which carries the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) (CDP) between an extension and a tab, extension or other target. Import from `effect-platform-chrome/ChromeDebugger`. No Chrome global is read at import time: `layerLive` reads `chrome.debugger` when it is built, and fails with operation `"initialize"` where the API is missing. `make(api)` builds the service from any compatible API, and `layer(api)` provides it.

## Permissions

```json
{
  "manifest_version": 3,
  "permissions": ["debugger"]
}
```

`"debugger"` shows a strong install warning. While a session is attached, Chrome shows an infobar saying the extension is debugging the browser, and the user can cancel it. Other limits:

- Only one client can attach to a target at a time. Attaching fails while DevTools, another extension or this extension is already attached.
- Restricted pages (`chrome://` URLs, the Chrome Web Store and other extensions' pages) cannot be attached to.
- Attaching to an extension's background page needs the `--silent-debugger-extension-api` command-line switch.

## Sessions

`session(target, requiredVersion)` is a scoped resource. It attaches when acquired and detaches when its scope closes. Its `sendCommand` and `events` are bound to the target:

```typescript
import { Effect, Schema, Stream } from "effect"
import { ChromeDebugger, layerLive } from "effect-platform-chrome/ChromeDebugger"

const Evaluated = Schema.Struct({
  result: Schema.Struct({ value: Schema.optional(Schema.Unknown) })
})

const collectRequests = (tabId: number) => Effect.scoped(Effect.gen(function*() {
  const debuggerService = yield* ChromeDebugger
  const session = yield* debuggerService.session({ tabId }, "1.3")

  yield* session.sendCommand("Network.enable")

  const evaluated = yield* session.sendCommand("Runtime.evaluate", { expression: "document.title", returnByValue: true })
  const title = yield* Schema.decodeUnknownEffect(Evaluated)(evaluated)

  const requests = yield* session.events.pipe(
    Stream.filter((event) => event.method === "Network.requestWillBeSent"),
    Stream.take(10),
    Stream.runCollect
  )

  return { title: title.result.value, requests: requests.length }
}))

const program = collectRequests(123).pipe(Effect.provide(layerLive))
```

- **No missed events.** The session adds its `onEvent` and `onDetach` listeners before it calls `attach`. Events caused by the first commands, such as `Network.enable`, are buffered until something reads `events`.
- **Buffering.** `events` is a single-consumer stream with room for `capacity` events (default 64; set it with `session(target, version, { capacity })`). When it is full, the oldest event is dropped, because Chrome callbacks cannot be backpressured. Raise `capacity` for chatty domains such as `Network`.
- **Child sessions.** Events from child sessions (for example after `Target.setAutoAttach` with `flatten: true`) are included, with `sessionId: Option.some(id)`. Pass that id as the third argument of `session.sendCommand` to send a command to the child session (Chrome 125+).
- **Detach by Chrome.** When Chrome ends the session, `events` ends after the buffered events are read and `detached` completes with the reason: `"target_closed"` when the tab closed, or `"canceled_by_user"` when the user dismissed the infobar or opened DevTools. `detached` never completes when the scope closes normally, so combine it with your own work, for example with `Effect.raceFirst(work, session.detached)`.
- **Release.** Closing the scope (including by interruption) detaches the target. It also removes the listeners and interrupts anyone reading `events`. If Chrome has already detached the target, release does not call `detach`. Release ignores failures, because the target may already be gone. "Not attached" errors are dropped silently, and other errors are logged at warning level.

## Raw protocol data

CDP parameters and results are free-form JSON defined by the protocol, not by Chrome's extension API. `sendCommand` takes `CommandParams` (a read-only JSON object) and returns `unknown`: Chrome resolves `undefined` for commands without a result. Event `params` are `unknown` as well. Decode each one with a schema at this boundary before using it as domain data. Protocol errors (an unknown method or invalid params) reject with an `Error` whose message is Chrome's JSON error text. They become a `ChromeDebuggerError` with operation `"sendCommand"`.

`requiredVersion` is the protocol version, for example `"1.3"`. Chrome accepts a debuggee with the same major version and an equal or greater minor version.

## Service worker lifetime

From Chrome 118, an attached debugger session keeps the extension's service worker alive. Chrome can still stop the worker without running Effect finalizers (for example on update or crash). In that case a session's release never runs, and Chrome usually ends the attachment itself. When a new worker starts, it can call `getTargets` and `detach` any `attached` target it still owns before attaching again. Attaching to an already attached target fails.

## Lower-level calls

`attach`, `detach`, `sendCommand(target, method, params?)` and `getTargets` map one-to-one onto Chrome. Each failure is a `ChromeDebuggerError` whose `operation` names the call. `onEvent` and `onDetach` are observational streams over every attached target: each consumption owns a listener only while it runs, and buffers 64 events. These streams cannot wake an MV3 service worker. If an event must wake the worker, register it synchronously at startup through `ChromeServiceWorker.listen`.

## Testing

Pass `layer(api)` an object of `vi.fn` methods, with `makeEvent` from `effect-platform-chrome/ChromeTesting` for `onEvent` and `onDetach`. Because a session listens before it attaches, a test can emit events right after acquiring the session and then collect `session.events`. To end the stream, emit `onDetach` for the target.
