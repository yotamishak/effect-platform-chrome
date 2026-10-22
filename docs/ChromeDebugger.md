# ChromeDebugger

An injectable Effect v4 service for the Promise-based Manifest V3 `chrome.debugger` API, which carries the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) (CDP) between an extension and a tab, extension or other target. Import from `effect-platform-chrome/ChromeDebugger`. No Chrome global is read at import time: `layerLive` reads `chrome.debugger` when it is built, and fails with operation `"initialize"` where the API is missing. `make(api)` builds the service from any compatible API, and `layer(api)` provides it.

## Permissions and limits

```json
{
  "manifest_version": 3,
  "permissions": ["debugger"]
}
```

`"debugger"` shows a strong install warning. While a target is attached, Chrome shows an infobar saying the extension is debugging the browser, and the user can cancel it. Chrome skips the infobar for policy-installed extensions and under the `--silent-debugger-extension-api` switch. Other limits:

- **One attachment per target and extension.** `attach` fails with `Another debugger is already attached to the tab with id: 7.` while this extension, from any of its contexts, is attached to the target, including through another id for the same target (`tabId` and its `targetId`). DevTools and other extensions can be attached at the same time.
- **Restricted targets.** Pages the extension may not script (`chrome://` URLs, the Chrome Web Store, other extensions' pages, `file://` URLs without file access) cannot be attached to. If an attached tab navigates to one, Chrome detaches it with `"target_closed"`.
- **Enterprise policy.** `attach` fails with `Host access is restricted by policy.` when the extension has policy-blocked hosts, and with `Screenshot capture is restricted by policy.` when screenshots are disabled.
- **Protocol domains.** Only these CDP domains are available: Accessibility, Audits, CacheStorage, Console, CSS, Database, Debugger, DOM, DOMDebugger, DOMSnapshot, Emulation, Fetch, IO, Input, Inspector, Log, Network, Overlay, Page, Performance, Runtime, Storage, Target, Tracing, WebAudio and WebAuthn.
- **Extension targets.** An `extensionId` debuggee names another extension's background page, which only exists for Manifest V2 extensions, and needs the `--silent-debugger-extension-api` switch.

## Sessions

`session(target, requiredVersion)` is a scoped resource. It attaches when acquired and detaches when its scope closes. Its `sendCommand` and `events` are bound to the target:

```typescript
import { Effect, Option, Schema, Stream } from "effect"
import { ChromeDebugger, layerLive } from "effect-platform-chrome/ChromeDebugger"

const Evaluated = Schema.Struct({
  result: Schema.Struct({ value: Schema.optional(Schema.Unknown) })
})

const collectRequests = (tabId: number) => Effect.scoped(Effect.gen(function*() {
  const debuggerService = yield* ChromeDebugger
  const session = yield* debuggerService.session({ tabId }, "1.3")

  yield* session.sendCommand("Network.enable")

  const evaluated = yield* session.sendCommand("Runtime.evaluate", { expression: "document.title", returnByValue: true })
  const title = yield* Schema.decodeUnknownEffect(Evaluated)(Option.getOrUndefined(evaluated))

  const requests = yield* session.events.pipe(
    Stream.filter((event) => event.method === "Network.requestWillBeSent"),
    Stream.take(10),
    Stream.runCollect
  )

  return { title: title.result.value, requests: requests.length }
}))

const program = collectRequests(123).pipe(Effect.provide(layerLive))
```

- **No missed events.** The session adds its `onEvent` and `onDetach` listeners before it calls `attach`, and starts buffering in the callback that resolves `attach`, before any command can run. Events caused by the first commands, such as `Network.enable`, are buffered until something reads `events`.
- **No foreign events.** Until `attach` resolves, events and detaches for the target belong to an earlier attachment, for example one that another context of the extension is still ending, because Chrome allows only one per target and extension. The session ignores them, so they cannot fill or end its stream.
- **Buffering.** `events` is a single-consumer stream with room for `capacity` events (default 64; set it with `session(target, version, { capacity })`). When it is full, the oldest event is dropped, because Chrome callbacks cannot be backpressured. Raise `capacity` for chatty domains such as `Network`. A consumer takes only the events it reads, so after `Stream.take(session.events, 1)` the next consumer continues with the following buffered event. A `capacity` that is not a positive safe integer fails the session with operation `"session"` before anything is registered.
- **Child sessions.** Events from child sessions (for example after `Target.setAutoAttach` with `flatten: true`) are included, with `sessionId: Option.some(id)`. Pass that id as the third argument of `session.sendCommand` to send a command to the child session (Chrome 125+).
- **Detach by Chrome.** When Chrome ends the attachment, `events` ends after the buffered events are read and `detached` completes with the reason: `"target_closed"` when the target went away (the tab closed, or navigated to a page the extension may not debug), or `"canceled_by_user"` when the user dismissed the debugging infobar. Commands that were still running fail with `Detached while handling command.`, and later ones with `Debugger is not attached to the tab with id: 7.` `detached` never completes when the scope closes normally, so combine it with your own work, for example with `Effect.raceFirst(work, session.detached)`.
- **Acquisition.** Interrupting a session while `attach` is pending waits for Chrome's answer, then detaches if the attachment succeeded, so an interrupted acquisition never leaves the target attached. If `attach` or a listener registration fails, the session removes its listeners and does not detach.
- **Bound to one attachment.** `session.target` is a frozen copy of the debuggee, so changing the object you passed cannot redirect the session's routing, commands or release. Once release starts or Chrome detaches the target, `session.sendCommand` fails with operation `"sendCommand"` and Chrome's `Debugger is not attached …` message without calling Chrome, so a command from an ended session never reaches a later attachment to the same target.
- **Release.** Closing the scope (including by interruption) detaches the target, then removes the listeners and discards the buffer. Anyone still reading `events` is interrupted; if Chrome had already detached the target, the stream simply ends. If Chrome has already detached the target, release does not call `detach`. Release ignores failures, because the target may already be gone: "not attached" and "no such target" errors are dropped silently, and other errors are logged at warning level.

## Raw protocol data

CDP parameters and results are free-form JSON defined by the protocol, not by Chrome's extension API. `sendCommand` takes `CommandParams` (a read-only JSON object), passes it only when given, and returns `Option<object>`: Chrome resolves `{}` for commands without a result, so `None` only appears when an API resolves nothing. Event `params` are an `Option<object>` for the same reason. Decode each one with a schema at this boundary before using it as domain data. Protocol errors (an unknown method or invalid params) reject with an `Error` whose message is Chrome's JSON error text. They become a `ChromeDebuggerError` with operation `"sendCommand"`.

`requiredVersion` is the protocol version. Chrome accepts `"1.0"` through `"1.3"` and fails other values with `Requested protocol version is not supported: 0.1.`

## Service worker lifetime

From Chrome 118, an attached debugger session keeps the extension's service worker alive. Chrome can still stop the worker without running Effect finalizers (for example on update or crash). In that case a session's release never runs, and Chrome usually ends the attachment itself. When a new worker starts, it can `detach` targets it may still own before attaching again: `detach` fails with `Debugger is not attached …` for targets this extension is not attached to. `getTargets` marks a target `attached` when any client, DevTools included, is attached to it.

## Lower-level calls

`attach`, `detach`, `sendCommand(target, method, params?)` and `getTargets` map one-to-one onto Chrome. Each failure, whether Chrome rejects or throws synchronously, is a `ChromeDebuggerError` whose `operation` names the call. `detach` does not fire `onDetach`. `onEvent` and `onDetach` are observational streams over every attached target: each consumption owns a listener only while it runs, and buffers 64 events. Their `source` is the debuggee given to `attach`, plus `sessionId` for a child session. These streams cannot wake an MV3 service worker. If an event must wake the worker, register it synchronously at startup through `ChromeServiceWorker.listen`.

## Testing

`makeDebugger()` from `effect-platform-chrome/testing/Debugger` is an in-memory `chrome.debugger` with Chrome's rules and error messages. It returns `{ api, layer, controls }` and takes `overrides` for any API member:

```typescript
import { Effect, Option, Stream } from "effect"
import { make } from "effect-platform-chrome/ChromeDebugger"
import { makeDebugger } from "effect-platform-chrome/testing/Debugger"

const { api, controls } = makeDebugger()
controls.addTarget({ type: "page", id: "target-7", tabId: 7, attached: false, title: "Example", url: "https://example.com/" })
controls.respond("Runtime.evaluate", (params) => ({ result: { value: params?.["expression"] } }))

const test = Effect.scoped(Effect.gen(function*() {
  const session = yield* make(api).session({ tabId: 7 }, "1.3")
  const evaluated = yield* session.sendCommand("Runtime.evaluate", { expression: "1 + 1" })

  controls.emit({ tabId: 7 }, "Page.loadEventFired", { timestamp: 1 })
  controls.removeTarget("target-7")

  return { evaluated, events: yield* Stream.runCollect(session.events), reason: yield* session.detached }
}))
```

- A debuggee resolves like Chrome: `tabId` to a `page` target, otherwise `extensionId` to a `background_page` target, otherwise `targetId` to a target id. Missing targets, unsupported versions, double attachments and missing attachments fail with Chrome's messages.
- Commands resolve `{}` unless `controls.respond(method, handler)` installs a handler. A handler can return a Promise to keep the command pending, and can throw to fail it. `controls.commands` records each accepted command and `controls.pendingCommands` counts the unsettled ones.
- `controls.emit(target, method, params?, sessionId?)` fires `onEvent` from an attached target, with the attach debuggee as `source`. `controls.removeTarget(id)` and `controls.restrict(id, message?)` end an attachment with `"target_closed"`, and `controls.cancel(target)` ends one with `"canceled_by_user"`. Each fails the target's pending commands with `Detached while handling command.` first, and returns the exceptions thrown by listeners.
- `controls.onEvent` and `controls.onDetach` are the `makeEvent` controls (`listenerCount`, `waitForListener`, `failNext`), for checking cleanup and registration failures.

For full control, pass `layer(api)` an object of `vi.fn` methods, with `makeEvent` from `effect-platform-chrome/ChromeTesting` for `onEvent` and `onDetach`. Because a session listens before it attaches, a test can emit events right after acquiring the session and then collect `session.events`. To end the stream, emit `onDetach` for the target.
