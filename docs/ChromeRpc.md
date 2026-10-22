# ChromeRpc

An adapter for **Effect 4.0.4** `effect/rpc/RpcClient` and
`effect/rpc/RpcServer` protocols, using dedicated Chrome runtime ports. It uses
`effect/rpc/RpcSerialization.json`, including its JSON schema codecs—not a
separate request/response protocol. Requests, typed failures, defects, concurrent
calls, interrupt messages and acknowledged response streams are handled by Effect RPC.

## Shared schema

```ts
import { Schema } from "effect"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"

export class Missing extends Schema.TaggedError<Missing>()("Missing", {
  message: Schema.String
}) {}

export const Api = RpcGroup.make(
  Rpc.make("Greeting", {
    payload: { name: Schema.String },
    success: Schema.String,
    error: Missing
  }),
  Rpc.make("Numbers", { success: Schema.Finite, stream: true })
)
```

## Worker startup

Register `ChromeServiceWorker.start` **synchronously at worker top level**, before
awaiting initialization. This installs Chrome's wakeup `onConnect` listener.
Each accepted port then gets its own scoped server. The client repeatedly sends
the existing RPC `Ping` message every 100 ms until the server receive loop sends
`Pong`. No request is sent before that response, so even a Ping lost while the
worker initializes is harmless. Do not use raw `RpcClient` messages to bypass readiness.

```ts
import { Effect, Layer, Stream } from "effect"
import * as ChromeRpc from "effect-platform-chrome/ChromeRpc"
import * as ChromeServiceWorker from "effect-platform-chrome/ChromeServiceWorker"
import { Api, Missing } from "./Api.js"

const handlers = Api.toLayer({
  Greeting: ({ name }) => name.length === 0
    ? Effect.fail(new Missing({ message: "Name required" }))
    : Effect.succeed(`Hello ${name}`),
  Numbers: () => Stream.fromIterable([1, 2, 3])
})

// Intentional startup access, not access from the adapter's module imports.
const worker = ChromeServiceWorker.start({
  chrome,
  layer: Layer.empty,
  onConnect: (port) => port.name === "example-rpc"
    ? ChromeRpc.serve(chrome.runtime, port, "owned", Api).pipe(Effect.provide(handlers))
    : Effect.void
})

// worker.dispose() is explicit teardown; Chrome termination need not run it.
```

`serve` completes on disconnect, interrupts all connection handlers and closes
the connection scope. That differs from `runtime.sendMessage`, whose listener
always runs to completion after its sender goes away. Wrap handlers whose work
must outlive the caller (an upload, a sign-in, a write) in `finishAccepted`:
`Api.toLayer(ChromeRpc.finishAccepted(handlers))`. Each Effect result, including
one wrapped by `Rpc.fork` or `Rpc.uninterruptible` (the wrapper's options are
kept), then runs in a detached fiber with its own scope: a disconnect interrupts
only the wait, the reply is dropped, and resources the handler acquired with
`Effect.acquireRelease` stay open until its work finishes rather than closing with
the request. Results of streaming procedures, whether a `Stream` or an Effect of a
`Queue`, are left as they are.

`serve` takes `ServeOptions`: the transport `Options` plus `server`, which is
passed to `RpcServer.make` (`concurrency`, `disableFatalDefects`, tracing). By
default Effect RPC treats a handler defect as fatal to the connection: the server
sends a connection-wide `Defect` and every call in flight on that port fails with
it. Set `server: { disableFatalDefects: true }` to fail only the call whose handler
died.

For manual integration, `makeServerProtocol` returns the native Effect protocol
plus a `closed: Effect<void>` notification. Run `RpcServer.make(Api)` with that
protocol and race it against `closed` within the same scope. `layerServer`
provides just the standard protocol; its enclosing scope must be closed by the
application.

## Scoped client

```ts
import { Effect, Stream } from "effect"
import * as RpcClient from "effect/rpc/RpcClient"
import * as ChromeRpc from "effect-platform-chrome/ChromeRpc"
import { Api } from "./Api.js"

export const program = Effect.scoped(Effect.gen(function*() {
  const native = yield* Effect.sync(() => chrome.runtime.connect({ name: "example-rpc" }))
  const protocol = yield* ChromeRpc.makeClientProtocol(chrome.runtime, native, "owned")
  const client = yield* RpcClient.make(Api).pipe(
    Effect.provideService(RpcClient.Protocol, protocol)
  )
  const greeting = yield* client.Greeting({ name: "Ada" }).pipe(Effect.timeout("5 seconds"))
  const numbers = yield* Stream.runCollect(client.Numbers())
  return { greeting, numbers }
}))
```

`layerClient` also provides the standard protocol. Use exactly **one**
`RpcClient.make` per acquired protocol; use another native port for another
client. A second client on the same protocol has its calls fail with
`RpcClientError` instead of waiting for replies the first client receives.
Clients and servers must remain inside the protocol's owning scope.
Readiness has no deadline by default. Set `Options.readyTimeout` to fail the
transport (and every waiting call) when no Pong arrives in time; it must be a
positive duration, and `"Infinity"` keeps the default. Chrome connects a port when
any script in the target listens on `onConnect`, so a `tabs.connect` port reaching
a frame where only listeners for other port names run is never answered (a port
reaching no listener at all is disconnected by Chrome at once, with a `lastError`).
Independently, bound calls with Effect timeout when a slow handler must not hold
the caller.

## Errors

Acquisition fails with `ChromeRpcError`; a client call reports transport failures
as `RpcClientError` whose `RpcClientDefect` reason carries the `ChromeRpcError` as
its `cause`. Its `operation` names the step that failed:

| `operation` | Meaning | Effect |
| --- | --- | --- |
| `"initialize"` | `capacity`, `maxFrameLength` or `readyTimeout` is invalid | acquisition fails before any listener is added |
| `"addListener"` | registering the port's listeners threw (`cause`) | acquisition fails; listeners are removed, an owned port disconnected |
| `"postMessage"` | a frame could not be encoded or exceeds `maxFrameLength` | only that message fails; nothing reached Chrome |
| `"postMessage"` | Chrome's `postMessage` threw (`cause`) | the transport terminates |
| `"onMessage"` | an inbound frame is not a string, is oversized or malformed, or overflows `capacity` | the transport terminates |
| `"onDisconnect"` | Chrome disconnected the port; `message` and `cause` are its `lastError`, when it set one | the transport terminates |
| `"ready"` | no Pong within `readyTimeout` | the transport terminates |
| `"disconnect"` | the protocol's scope closed, or the client sent `Eof` and its calls finished | the transport terminates |

A terminated transport fails every pending and later call, streams included, with
the same error, removes its listeners and disconnects an owned port. Declared
handler failures keep their schema error types; handler defects arrive as defects.

## Wire format

Frames are JSON strings from `RpcSerialization.json`: `{"_tag":"Ping"}` and
`{"_tag":"Pong"}` for readiness, `{"_tag":"Request","id","tag","payload","headers"}`
and `{"_tag":"Exit","requestId","exit"}` for calls. Two details matter to anything
that speaks the format by hand (a test harness, another language):

- A procedure without a payload sends `payload: null`. Declare such procedures with
  no `payload` rather than `payload: {}`, whose struct does not accept `null`.
- Effect's JSON codecs write a present-but-undefined optional field as `null` and
  read it back as absent, so typed clients and servers round-trip it.

Cancellation before readiness does not send `Interrupt`: its request never
reached the peer, and waiting for Pong from a dead peer would hang cancellation.

## Buffering, ownership and limits

The existing `ChromePort.messages` stream slides at 64 messages. RPC cannot
tolerate that behavior. This module therefore uses `ChromePort.NativePort`,
`RuntimeApi` and `Ownership` directly with its own scoped native listeners.
**Do not simultaneously adopt/consume the same port through ChromePort.**
No sibling API changes are required.

Defaults: 256 queued frames and 1 MiB UTF-16 code units per JSON frame, configurable
through `Options.capacity` and `Options.maxFrameLength`. Both must be positive
safe integers. Inbound overflow and malformed or oversized inbound frames terminate
the local transport, as does a `postMessage` that Chrome refuses; received frames
are never silently dropped. Queued frames are not drained after a terminal failure.
An outbound frame that cannot be encoded or exceeds `maxFrameLength` is refused
before it reaches Chrome and fails only its own message: the client's call fails
with `RpcClientError`, and the server answers that call with a defect, as Effect
RPC does for a response it cannot encode. A refused server `Defect` has no call to
answer, so it terminates the transport rather than leaving calls unanswered. Keep
`maxFrameLength` well inside Chrome's own message size limit. Effect RPC's
acknowledgements provide stream backpressure, not Chrome ingress backpressure.
The `capacity` must hold the largest burst of frames that can arrive while the
receive loop is busy: a release of N concurrent calls answers with N frames at once.
The receive loop is serial: a full per-request stream buffer can delay other
responses on the same connection. Terminal disconnect bypasses that blocked
receive operation and fails pending calls. Use separate dedicated ports when
independent streams must not share this head-of-line blocking. The frame queue
limit does not bound request concurrency, total payload memory or Chrome's own
internal queues; bound those separately in the application.
Payloads must work with Effect's JSON codecs. Binary transferables and
server-originated requests/notifications are not supported.

`owned` disconnects the native port on terminal failure or scope release.
`borrowed` removes this adapter's listeners but never disconnects the native
port; its owner must close it to notify the peer of local termination. Prefer
`owned` for dedicated RPC connections. All callbacks capture `lastError` during
the native disconnect callback. Even a clean native disconnect fails pending
client calls with `RpcClientError` (a `RpcClientDefect` reason containing the
`ChromeRpcError`). Streams fail with the same error: the transport fails every
call before it interrupts a receive that a full stream buffer blocks, so a consumer
drains what it already received and then sees the transport failure, not an
interruption. Declared handler failures retain their schema error types.

No reconnect, request replay, restart retry, durability or exactly-once execution
is provided. Ping retries are readiness probes only. A stopped worker can lose
in-memory work without running finalizers. Authorization, extension sender
validation and selecting the expected port name belong at the worker boundary.

## Deterministic stress and regression coverage

`test/ChromeRpc.test.ts` covers each operation's typed error, option validation,
readiness, lifecycle, the layers and `finishAccepted`; `test/stress/ChromeRpc.stress.test.ts`
covers the extremes. Both use actual Effect RPC clients and servers over paired
synchronous native-port mocks (`test/support/ChromeRpc.ts`), fresh handler layers
and explicit Deferred gates, with TestClock for readiness:

- A 4,096-frame burst queued before the receive loop runs is handled whole and in
  order; the same burst past a 64-frame capacity terminates at frame 65, handles
  none of the 64 stale frames and leaves no listener.
- 2,048 requests simultaneously held inside handlers, then released; every
  response is correlated, including schema-typed failures every 17th call.
- 1,028 concurrent calls interleaving success, typed failure, a throwing handler
  (with `disableFatalDefects`) and an oversized request, each with its own outcome
  and the oversized ones never reaching a handler; the connection survives.
- 1,024 concurrent connections interleaving success, listener registration
  throws, `postMessage` throws and disconnects with `lastError`, each failing with
  the right `operation` and `cause`; no listener remains.
- 512 connections interrupted at every stage (server only, before readiness,
  mid-call, mid-stream, after a call): no listener remains, every owned port is
  disconnected and every remote handler and stream is finalized.
- 512 cancellations and 512 late response frames; a disconnect with 1,024 pending
  calls; a disconnect racing 512 in-flight sends (no handler starts after it).
- 4,096 single-item acknowledged chunks through a gated one-item client buffer and
  an eight-frame ingress capacity; 128 cancelled backpressured streams.
- `readyTimeout` racing Pong across 128 clients: answered ones connect, the rest
  fail with `"ready"` at the deadline.
- `finishAccepted` across 256 calls whose caller disconnects: wrapped handlers
  finish and release their scoped resources only afterwards; plain ones are
  interrupted.

Regression fixes: failed acquisition detaches and closes immediately; reentrant
registration cannot return a live protocol after disconnect or retain a
late-inserted listener. Terminal readiness/closed notifications are published after
native cleanup, since unsafe Deferred/Queue completion can resume effects
reentrantly. Cancelling an unsent request does not wait for readiness. A second
client on one protocol fails its calls instead of hanging. An oversized or
unencodable outbound frame fails only its own message instead of every call on the
port. `finishAccepted` keeps a handler's scoped resources open until its work
finishes, honours `Rpc.fork` / `Rpc.uninterruptible` wrappers and leaves every
streaming result alone. `readyTimeout` is validated at acquisition, and a
disconnect reports Chrome's `lastError` as its cause.

Cleanup is best-effort when the native API itself throws: both listener removals
and owned disconnect are attempted, preserving the first transport failure. An
API that throws before actually removing a listener cannot be forced to remove it;
late callbacks are ignored by the terminal-state guard. These tests validate the
pinned Effect JSON protocol, not JSON-RPC 2.0, NDJSON, transferables, Chrome process
crashes, or a real browser's internal buffering.
