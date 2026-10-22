// Effect 4.0.4 RPC protocols are intentionally unstable; this adapter targets that pinned API.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Cause, Data, Deferred, Duration, Effect, Fiber, Layer, Predicate, Queue, Schema } from "effect"
import * as RpcClient from "effect/rpc/RpcClient"
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError"
import * as RpcServer from "effect/rpc/RpcServer"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcMessage from "effect/rpc/RpcMessage"
import type * as Rpc from "effect/rpc/Rpc"
import type * as RpcGroup from "effect/rpc/RpcGroup"
import type { ChromePortApi, NativePort, Ownership } from "./ChromePort.js"
import * as PortLink from "./internal/port.js"

/** Limits apply per port. Overflow terminates the transport rather than losing frames. */
export interface Options {
  readonly capacity?: number
  /** Maximum JSON frame length in UTF-16 code units (default 1 MiB). */
  readonly maxFrameLength?: number
  /**
   * Client only: how long to wait for the server's Pong before failing the transport (default:
   * forever). Chrome connects a port when any script in the target listens on `onConnect`, so a
   * port that reaches only listeners for other names is never answered.
   */
  readonly readyTimeout?: Duration.Input
}

/** Acquisition, disconnect, serialization, and buffer-limit failures. */
export class ChromeRpcError extends Schema.TaggedError<ChromeRpcError>()("ChromeRpcError", {
  message: Schema.String,
  cause: Schema.Defect()
}) {}

const requestId = Schema.Union([Schema.String, Schema.Finite])

const request = Schema.TaggedStruct("Request", {
  id: requestId, tag: Schema.String, payload: Schema.Unknown,
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String]).pipe(Schema.mutable)),
  traceId: Schema.optionalKey(Schema.String), spanId: Schema.optionalKey(Schema.String),
  sampled: Schema.optionalKey(Schema.Boolean), isNotification: Schema.optionalKey(Schema.Literal(true))
})

const fromClient = Schema.Union([
  request,
  Schema.TaggedStruct("Ack", { requestId }),
  Schema.TaggedStruct("Interrupt", { requestId }),
  Schema.TaggedStruct("Eof", {}),
  Schema.TaggedStruct("Ping", {})
])

const pong = Schema.TaggedStruct("Pong", {})

const fromServer = Schema.Union([
  pong,
  Schema.TaggedStruct("Defect", { defect: Schema.Unknown }),
  Schema.TaggedStruct("Chunk", { requestId, values: Schema.NonEmptyArray(Schema.Unknown) }),
  Schema.TaggedStruct("Exit", { requestId, exit: Schema.Union([
    Schema.TaggedStruct("Success", { value: Schema.Unknown }),
    Schema.TaggedStruct("Failure", { cause: Schema.Array(Schema.Union([
      Schema.TaggedStruct("Fail", { error: Schema.Unknown }),
      Schema.TaggedStruct("Die", { defect: Schema.Unknown }),
      Schema.TaggedStruct("Interrupt", { fiberId: Schema.NullOr(Schema.Finite).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))) })
    ])) })
  ]) })
])

const clientError = (cause: ChromeRpcError) => new RpcClientError({
  reason: new RpcClientDefect({ message: cause.message, cause })
})

const protocolMessages = Data.taggedEnum<Data.TaggedEnum<{ ClientProtocolError: { readonly error: RpcClientError } }>>()

const transport = Effect.fnUntraced(function*(
  api: ChromePortApi, native: NativePort, ownership: Ownership, options: Options
) {
  const capacity = options.capacity ?? 256
  const maxFrameLength = options.maxFrameLength ?? 1024 * 1024

  if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isSafeInteger(maxFrameLength) || maxFrameLength < 1) {
    return yield* new ChromeRpcError({ message: "RPC limits must be positive safe integers", cause: undefined })
  }

  const queue = yield* Queue.make<string, ChromeRpcError>({ capacity, strategy: "dropping" })
  const ready = yield* Deferred.make<void, ChromeRpcError>()
  const closed = yield* Deferred.make<void>()
  const parser = RpcSerialization.json.makeUnsafe()
  let failure: ChromeRpcError | undefined

  // Every termination, including Chrome's own disconnect, also disconnects an owned port.
  const stop = (error: ChromeRpcError) => {
    if (failure !== undefined) return
    failure = error
    link.close()

    try { link.detach() } catch { /* Preserve the first transport failure. */ }

    try { link.disconnect() } catch { /* Best-effort terminal disconnect. */ }

    // Unsafe completion may resume waiting effects reentrantly. Publish only after cleanup.
    Deferred.doneUnsafe(ready, Effect.fail(error))
    Deferred.doneUnsafe(closed, Effect.void)
    Queue.failCauseUnsafe(queue, Cause.fail(error))
  }

  const link = PortLink.make(native, ownership, () => api.lastError, {
    onMessage: (message) => {
      if (!Predicate.isString(message) || message.length > maxFrameLength) {
        stop(new ChromeRpcError({ message: "Invalid or oversized RPC frame", cause: undefined }))
      } else if (!Queue.offerUnsafe(queue, message)) {
        stop(new ChromeRpcError({ message: "RPC receive buffer overflow", cause: undefined }))
      }
    },
    onDisconnect: (lastError) => {
      stop(new ChromeRpcError({ message: lastError?.message ?? "Chrome RPC port disconnected", cause: undefined }))
    }
  })

  yield* Effect.addFinalizer(() => Effect.sync(() => {
    stop(new ChromeRpcError({ message: "Chrome RPC scope closed", cause: undefined }))
    Queue.shutdownUnsafe(queue)
  }))
  yield* Effect.try({
    try: link.register,
    // A callback can close the wire before a hostile registration inserts and throws.
    catch: (cause) => failure ?? new ChromeRpcError({ message: "Chrome RPC listener registration failed", cause })
  }).pipe(Effect.tapError((error) => Effect.sync(() => stop(error))))

  // Registration callbacks may synchronously report an already-dead port.
  if (failure !== undefined) return yield* failure

  // The serializer accepts protocol envelopes whose schema payload holes are unknown.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  const send = (message: unknown) => Effect.try({
    try: () => {
      if (failure !== undefined) throw failure
      const frame = parser.encode(message)

      if (!Predicate.isString(frame) || frame.length > maxFrameLength) {
        throw new ChromeRpcError({ message: "Invalid or oversized outbound RPC frame", cause: undefined })
      }

      native.postMessage(frame)
    },
    catch: (cause) => cause instanceof ChromeRpcError ? cause : new ChromeRpcError({ message: "Chrome RPC send failed", cause })
  }).pipe(Effect.tapError((error) => Effect.sync(() => stop(error))))

  return { queue, ready, closed: Deferred.await(closed), send, parser, stop, error: () => failure }
})

/**
 * Acquires a dedicated native port as an Effect RPC client protocol. Use with exactly
 * one RpcClient.make. Requests wait for Ping/Pong readiness; no restart retries.
 * Does not consume ChromePort.messages (its sliding buffer is unsuitable for RPC).
 */
export const makeClientProtocol = Effect.fnUntraced(function*(
  api: ChromePortApi, native: NativePort, ownership: Ownership, options: Options = {}
) {
  const wire = yield* transport(api, native, ownership, options)
  let used = false

  return RpcClient.Protocol.of({
    codecFor: RpcSerialization.json.codecFor,
    supportsAck: true,
    supportsTransferables: false,
    run: (_clientId, receive) => Effect.gen(function*() {
      if (used) return yield* Effect.die(new Error("Chrome RPC protocol requires exactly one client"))
      used = true
      yield* Effect.gen(function*() {
        while (!(yield* Deferred.isDone(wire.ready))) {
          yield* wire.send(RpcMessage.constPing)
          yield* Effect.sleep("100 millis")
        }
      }).pipe(Effect.ignore, Effect.forkScoped)

      const { readyTimeout } = options

      if (readyTimeout !== undefined) {
        yield* Effect.gen(function*() {
          yield* Effect.sleep(readyTimeout)

          if (!(yield* Deferred.isDone(wire.ready))) {
            wire.stop(new ChromeRpcError({
              message: `Chrome RPC peer did not answer within ${Duration.format(Duration.fromInputUnsafe(readyTimeout))}`,
              cause: undefined
            }))
          }
        }).pipe(Effect.forkScoped)
      }

      return yield* Effect.gen(function*() {
        while (true) {
          const frame = yield* Queue.take(wire.queue)
          const error = wire.error()

          if (error !== undefined) return yield* error

          const messages = yield* Effect.try({
            try: () => wire.parser.decode(frame),
            catch: (cause) => new ChromeRpcError({ message: "Malformed RPC response", cause })
          })

          for (const raw of messages) {
            const message = yield* Schema.decodeUnknownEffect(fromServer)(raw).pipe(
              Effect.mapError((cause) => new ChromeRpcError({ message: "Malformed RPC response", cause }))
            )

            if (Predicate.isTagged(message, "Pong")) yield* Deferred.succeed(wire.ready, undefined)
            else yield* receive(message)
          }
        }
      }).pipe(Effect.raceFirst(wire.closed.pipe(Effect.andThen(Effect.suspend(() =>
        Effect.fail(wire.error() ?? new ChromeRpcError({ message: "Chrome RPC transport closed", cause: undefined }))
      )))), Effect.catch((error) => Effect.gen(function*() {
        wire.stop(error)
        yield* receive(protocolMessages.ClientProtocolError({ error: clientError(error) }))

        return yield* Effect.never
      })))
    }).pipe(Effect.scoped),
    send: (_clientId, message) => Effect.gen(function*() {
      // No request reached the peer before readiness, so cancellation must not wait
      // for a peer that may never appear (RPC sends Interrupt from its finalizer).
      if (Predicate.isTagged(message, "Interrupt") && !(yield* Deferred.isDone(wire.ready))) return
      yield* Deferred.await(wire.ready)

      const error = wire.error()

      if (error !== undefined) return yield* error
      yield* wire.send(message)
    }).pipe(Effect.mapError(clientError))
  })
})

/** Acquires one server connection. Run RpcServer.make in the same owning scope. */
export const makeServerProtocol = Effect.fnUntraced(function*(
  api: ChromePortApi, native: NativePort, ownership: Ownership, options: Options = {}
) {
  const wire = yield* transport(api, native, ownership, options)
  const disconnects = yield* Queue.make<number>({ capacity: 1 })
  let connected = true
  let used = false

  const protocol = RpcServer.Protocol.of({
    codecFor: RpcSerialization.json.codecFor,
    supportsAck: true, supportsTransferables: false, supportsSpanPropagation: true, supportsNotifications: false,
    disconnects,
    clientIds: Effect.sync(() => connected ? new Set([0]) : new Set<number>()),
    initialMessage: Effect.succeedNone,
    end: () => Effect.sync(() => wire.stop(new ChromeRpcError({ message: "Chrome RPC client ended", cause: undefined }))),
    send: (_clientId, response) => wire.send(response).pipe(Effect.ignore),
    run: (receive) => Effect.gen(function*() {
      if (used) return yield* Effect.die(new Error("Chrome RPC protocol requires exactly one server"))
      used = true

      return yield* Effect.gen(function*() {
        while (true) {
          const frame = yield* Queue.take(wire.queue)
          const error = wire.error()

          if (error !== undefined) return yield* error

          const messages = yield* Effect.try({
            try: () => wire.parser.decode(frame),
            catch: (cause) => new ChromeRpcError({ message: "Malformed RPC request", cause })
          })

          for (const raw of messages) {
            const message = yield* Schema.decodeUnknownEffect(fromClient)(raw).pipe(
              Effect.mapError((cause) => new ChromeRpcError({ message: "Malformed RPC request", cause }))
            )

            if (Predicate.isTagged(message, "Ping")) yield* wire.send(pong.make({}))
            else yield* receive(0, message)
          }
        }
      }).pipe(Effect.raceFirst(wire.closed.pipe(Effect.andThen(Effect.suspend(() =>
        Effect.fail(wire.error() ?? new ChromeRpcError({ message: "Chrome RPC transport closed", cause: undefined }))
      )))), Effect.catch((error) => Effect.gen(function*() {
        wire.stop(error)
        connected = false
        yield* Queue.offer(disconnects, 0)

        return yield* Effect.never
      })))
    })
  })

  return { ...protocol, closed: wire.closed }
})

/**
 * Serves a dedicated connection until disconnect, then closes its scope and cancels
 * all handlers. Provide the group's handler layer and middleware to this Effect.
 */
export const serve = Effect.fnUntraced(function*<Rpcs extends Rpc.Any>(
  api: ChromePortApi, port: NativePort, ownership: Ownership, group: RpcGroup.RpcGroup<Rpcs>, options: Options = {}
) {
  const protocol = yield* makeServerProtocol(api, port, ownership, options)

  yield* RpcServer.make(group).pipe(
    Effect.provideService(RpcServer.Protocol, protocol), Effect.raceFirst(protocol.closed)
  )
}, Effect.scoped)

// Handlers are opaque here: finishAccepted re-hosts whatever each returns, and the caller's
// RpcGroup types both sides.
// oxlint-disable-next-line anti-slop/no-unknown-returns
type Handler = (payload: never, options: never) => unknown

/**
 * Lets each handler's work run to completion when its caller disconnects; only the reply is
 * lost. `serve` otherwise interrupts a connection's handlers when its port closes, unlike
 * `runtime.sendMessage`, whose listener always finishes. Use it for handlers whose work must
 * outlive the caller (an upload, a sign-in, a write), as in
 * `Group.toLayer(ChromeRpc.finishAccepted(handlers))`. Effect results run in a detached fiber
 * with the same success, error and requirements; stream results are left as they are.
 */
export const finishAccepted = <const Handlers extends { readonly [Tag in keyof Handlers]: Handler }>(
  handlers: Handlers
): Handlers => {
  const finished = new Map<string, Handler>()

  for (const [tag, handler] of Object.entries<Handler>(handlers)) {
    finished.set(tag, (payload, handlerOptions) => {
      const result = handler(payload, handlerOptions)

      // The caller's group types the Effect; this only moves it to a detached fiber.
      // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context
      return Effect.isEffect(result) ? Effect.flatMap(Effect.forkDetach(result), Fiber.join) : result
    })
  }

  // SAFETY: every entry keeps its tag and parameters; an Effect result keeps its success,
  // error and requirement types, only moved to a detached fiber.
  return Object.fromEntries(finished) as Handlers
}

/** Scoped client protocol layer; the port must be dedicated to this RPC connection. */
export const layerClient = (api: ChromePortApi, port: NativePort, ownership: Ownership, options: Options = {}) =>
  Layer.effect(RpcClient.Protocol, makeClientProtocol(api, port, ownership, options))

/** Scoped single-connection server protocol layer. */
export const layerServer = (api: ChromePortApi, port: NativePort, ownership: Ownership, options: Options = {}) =>
  Layer.effect(RpcServer.Protocol, makeServerProtocol(api, port, ownership, options))
