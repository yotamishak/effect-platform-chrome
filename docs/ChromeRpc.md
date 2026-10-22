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
`Api.toLayer(ChromeRpc.finishAccepted(handlers))`. Each Effect result then runs
in a detached fiber; a disconnect interrupts only the wait, and the reply is
dropped. Stream results are left as they are. For manual integration, `makeServerProtocol` returns the
native Effect protocol plus a `closed: Effect<void>` notification. Run
`RpcServer.make(Api)` with that protocol and race it against `closed` within the
same scope. `layerServer` provides just the standard protocol; its enclosing scope
must be closed by the application.

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
client. Clients and servers must remain inside the protocol's owning scope.
Readiness has no deadline by default. Set `Options.readyTimeout` to fail the
transport (and every waiting call) when no Pong arrives in time. Chrome connects a
port when any script in the target listens on `onConnect`, so a `tabs.connect` port
reaching a frame where only listeners for other port names run is never answered.
Independently, bound calls with Effect timeout when a slow handler must not hold
the caller.

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
safe integers. Overflow, malformed frames, oversized frames, serialization or
postMessage failures terminate the local transport; frames are never silently
dropped. Queued frames are not drained after a terminal failure. Effect RPC's
acknowledgements provide stream backpressure, not Chrome ingress backpressure.
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
unary client calls with `RpcClientError` (a `RpcClientDefect` reason containing the
`ChromeRpcError`). A stream whose blocked receive is interrupted during terminal
cleanup may instead observe an interruption cause. Declared handler failures
retain their schema error types.

No reconnect, request replay, restart retry, durability or exactly-once execution
is provided. Ping retries are readiness probes only. A stopped worker can lose
in-memory work without running finalizers. Authorization, extension sender
validation and selecting the expected port name belong at the worker boundary.

## Deterministic stress and regression coverage

`test/ChromeRpc.test.ts` uses actual Effect RPC clients/servers over paired
synchronous native-port mocks, fresh handler layers and explicit Deferred gates:

- 2,048 requests simultaneously held inside server handlers, then released;
  every response is correlated, including schema-typed failures every 17th call.
- 512 concurrent request cancellations and 512 late response frames; all remote
  finalizers complete, active handlers return to zero and the connection remains usable.
- Native disconnect with 1,024 pending calls; every client fiber completes with
  failure, all 1,024 remote finalizers run once and all four listener sets empty.
- 4,096 single-item acknowledged stream chunks with a gated consumer and a
  one-item client buffer; ordered draining uses an eight-frame ingress capacity.
- A stalled one-item stream buffer admits three sent chunks (consumed, queued,
  blocked offer); disconnect completes an unrelated pending call and finalizes
  the stream without releasing the consumer gate first.
- 128 cancelled backpressured streams; remote finalizers complete and subsequent
  requests still succeed. Exact capacity overflow, malformed request/response
  envelopes, outbound size limits, native send failures and real remote defects
  exercise terminal and schema boundaries separately.
- Client-before-server readiness, dead-peer timeout using TestClock, malformed
  frames before readiness, partial listener acquisition, reentrant registration,
  and throwing cleanup callbacks cover lifecycle edges.

Regression fixes: failed acquisition now detaches and closes immediately rather
than retaining resources until the outer scope closes; reentrant registration
cannot return a live protocol after disconnect or retain a late-inserted listener.
Terminal readiness/closed notifications are published after native cleanup, since
unsafe Deferred/Queue completion can resume effects reentrantly. Client/server
receive loops race transport closure so stream backpressure cannot hide a terminal
failure. Cancelling an unsent request no longer waits indefinitely for readiness.

Cleanup is best-effort when the native API itself throws: both listener removals
and owned disconnect are attempted, preserving the first transport failure. An
API that throws before actually removing a listener cannot be forced to remove it;
late callbacks are ignored by the terminal-state guard. These tests validate the
pinned Effect JSON protocol, not JSON-RPC 2.0, NDJSON, transferables, Chrome process
crashes, or a real browser's internal buffering.
