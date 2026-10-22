// Effect 4.0.4 RPC protocols are intentionally unstable; this adapter targets that pinned API.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Cause, Data, Deferred, Duration, Effect, Fiber, Layer, Option, Predicate, Queue, Schema } from "effect"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcClient from "effect/rpc/RpcClient"
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError"
import * as RpcServer from "effect/rpc/RpcServer"
import * as RpcSchema from "effect/rpc/RpcSchema"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcMessage from "effect/rpc/RpcMessage"
import type * as RpcGroup from "effect/rpc/RpcGroup"
import type { NativePort, Ownership, RuntimeApi } from "./ChromePort.js"
import * as PortLink from "./internal/port.js"

/** Limits apply per port. Ingress overflow terminates the transport rather than losing frames. */
export interface Options {
  /** Received frames queued before the receive loop takes them (default 256). */
  readonly capacity?: number
  /** Maximum JSON frame length in UTF-16 code units, in both directions (default 1 MiB). */
  readonly maxFrameLength?: number
  /**
   * Client only: how long to wait for the server's Pong before failing the transport (default:
   * forever). Chrome connects a port when any script in the target listens on `onConnect`, so a
   * port that reaches only listeners for other names is never answered. Must be positive;
   * `"Infinity"` waits forever.
   */
  readonly readyTimeout?: Duration.Input
}

/** `RpcServer.make`'s own options, such as `concurrency` and `disableFatalDefects`. */
export type ServerOptions = NonNullable<Parameters<typeof RpcServer.make>[1]>

export interface ServeOptions extends Options {
  /**
   * Passed to `RpcServer.make`. By default Effect RPC treats a handler defect as fatal to the
   * connection: every call in flight on the port fails with it. `disableFatalDefects: true`
   * fails only the call whose handler died.
   */
  readonly server?: ServerOptions
}

/**
 * Transport failures. `operation` names the step that failed: `"initialize"` (invalid
 * `Options`), `"addListener"` (listener registration on the port), `"postMessage"` (encoding,
 * the outbound size limit, or Chrome refusing the frame), `"onMessage"` (an invalid, oversized
 * or malformed frame, or ingress overflow), `"onDisconnect"` (Chrome disconnected the port;
 * `cause` is its `lastError`, if any), `"ready"` (no Pong within `readyTimeout`) and
 * `"disconnect"` (local termination: scope release or the client ending).
 */
export class ChromeRpcError extends Schema.TaggedError<ChromeRpcError>()("ChromeRpcError", {
  operation: Schema.String,
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

const failure = (operation: string, message: string, cause?: unknown) =>
  new ChromeRpcError({ operation, message, cause })

const clientError = (cause: ChromeRpcError) => new RpcClientError({
  reason: new RpcClientDefect({ message: cause.message, cause })
})

const protocolMessages = Data.taggedEnum<Data.TaggedEnum<{ ClientProtocolError: { readonly error: RpcClientError } }>>()

interface Limits {
  readonly capacity: number
  readonly maxFrameLength: number
  readonly readyTimeout: Option.Option<Duration.Duration>
}

const isLimit = (value: number) => Number.isSafeInteger(value) && value >= 1

const limits = (options: Options): Effect.Effect<Limits, ChromeRpcError> => Effect.suspend(() => {
  const capacity = options.capacity ?? 256
  const maxFrameLength = options.maxFrameLength ?? 1024 * 1024

  if (!isLimit(capacity) || !isLimit(maxFrameLength)) {
    return Effect.fail(failure("initialize", "RPC limits must be positive safe integers"))
  }

  if (options.readyTimeout === undefined) return Effect.succeed({ capacity, maxFrameLength, readyTimeout: Option.none() })

  const readyTimeout = Duration.fromInput(options.readyTimeout)

  if (Option.isNone(readyTimeout) || Duration.isNegative(readyTimeout.value) || Duration.isZero(readyTimeout.value)) {
    return Effect.fail(failure("initialize", "RPC readyTimeout must be a positive duration"))
  }

  return Effect.succeed({
    capacity, maxFrameLength, readyTimeout: Duration.isFinite(readyTimeout.value) ? readyTimeout : Option.none()
  })
})

const transport = Effect.fnUntraced(function*(api: RuntimeApi, native: NativePort, ownership: Ownership, limits: Limits) {
  const { capacity, maxFrameLength } = limits
  const queue = yield* Queue.make<string, ChromeRpcError>({ capacity, strategy: "dropping" })
  const ready = yield* Deferred.make<void, ChromeRpcError>()
  const closed = yield* Deferred.make<void>()
  const parser = RpcSerialization.json.makeUnsafe()
  let terminal: ChromeRpcError | undefined

  // Every termination, including Chrome's own disconnect, also disconnects an owned port.
  const stop = (error: ChromeRpcError) => {
    if (terminal !== undefined) return
    terminal = error
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
        stop(failure("onMessage", "Invalid or oversized RPC frame"))
      } else if (!Queue.offerUnsafe(queue, message)) {
        stop(failure("onMessage", "RPC receive buffer overflow"))
      }
    },
    onDisconnect: (lastError) => {
      stop(failure("onDisconnect", lastError?.message ?? "Chrome RPC port disconnected", lastError))
    }
  })

  yield* Effect.addFinalizer(() => Effect.sync(() => {
    stop(failure("disconnect", "Chrome RPC scope closed"))
    Queue.shutdownUnsafe(queue)
  }))
  yield* Effect.try({
    try: link.register,
    // A callback can close the wire before a hostile registration inserts and throws.
    catch: (cause) => terminal ?? failure("addListener", "Chrome RPC listener registration failed", cause)
  }).pipe(Effect.tapError((error) => Effect.sync(() => stop(error))))

  // Registration callbacks may synchronously report an already-dead port.
  if (terminal !== undefined) return yield* terminal

  // A frame that cannot be encoded or exceeds the limit never reaches Chrome, so only its own
  // message fails. A frame Chrome refuses terminates the transport: the port is unusable.
  // The serializer accepts protocol envelopes whose schema payload holes are unknown.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  const send = (message: unknown): Effect.Effect<void, ChromeRpcError> => Effect.suspend(() => {
    if (terminal !== undefined) return Effect.fail(terminal)

    let frame: ReturnType<typeof parser.encode>

    try {
      frame = parser.encode(message)
    } catch (cause) {
      return Effect.fail(failure("postMessage", "RPC frame could not be encoded", cause))
    }

    if (!Predicate.isString(frame) || frame.length > maxFrameLength) {
      return Effect.fail(failure("postMessage", "Invalid or oversized outbound RPC frame"))
    }

    try {
      native.postMessage(frame)
    } catch (cause) {
      stop(failure("postMessage", "Chrome RPC send failed", cause))

      return Effect.fail(terminal ?? failure("postMessage", "Chrome RPC send failed", cause))
    }

    return Effect.void
  })

  // Takes frames until the transport stops, handing each decoded message to `handle`.
  const receive = <A>(
    schema: Schema.Codec<A, unknown>, malformed: string, handle: (message: A) => Effect.Effect<void, ChromeRpcError>
  ): Effect.Effect<void> => Effect.gen(function*() {
    while (true) {
      const frame = yield* Queue.take(queue)

      if (terminal !== undefined) return yield* terminal

      const messages = yield* Effect.try({
        try: () => parser.decode(frame),
        catch: (cause) => failure("onMessage", malformed, cause)
      })

      for (const raw of messages) {
        yield* handle(yield* Schema.decodeUnknownEffect(schema)(raw).pipe(
          Effect.mapError((cause) => failure("onMessage", malformed, cause))
        ))
      }
    }
  }).pipe(Effect.catch((error) => Effect.sync(() => stop(error))))

  const wire = {
    queue, ready, closed: Deferred.await(closed), send, stop, receive,
    error: () => terminal,
    // The terminal failure once the transport has stopped.
    failure: Effect.sync(() => terminal ?? failure("disconnect", "Chrome RPC transport closed"))
  }

  return wire
})

/**
 * Acquires a dedicated native port as an Effect RPC client protocol. Use with exactly
 * one RpcClient.make; a second client's calls fail. Requests wait for Ping/Pong readiness;
 * no restart retries. Does not consume ChromePort.messages (its sliding buffer is unsuitable
 * for RPC).
 */
export const makeClientProtocol = Effect.fnUntraced(function*(
  api: RuntimeApi, native: NativePort, ownership: Ownership, options: Options = {}
) {
  const settings = yield* limits(options)
  const wire = yield* transport(api, native, ownership, settings)
  let owner: number | undefined

  return RpcClient.Protocol.of({
    codecFor: RpcSerialization.json.codecFor,
    supportsAck: true,
    supportsTransferables: false,
    run: (clientId, receive) => Effect.gen(function*() {
      if (owner !== undefined) return yield* Effect.die(new Error("Chrome RPC protocol requires exactly one client"))
      owner = clientId
      yield* Effect.gen(function*() {
        while (!(yield* Deferred.isDone(wire.ready))) {
          yield* wire.send(RpcMessage.constPing)
          yield* Effect.sleep("100 millis")
        }
      }).pipe(Effect.ignore, Effect.forkScoped)

      if (Option.isSome(settings.readyTimeout)) {
        const timeout = settings.readyTimeout.value

        yield* Deferred.await(wire.ready).pipe(
          Effect.timeoutOption(timeout),
          Effect.flatMap(Option.match({
            onSome: () => Effect.void,
            onNone: () => Effect.sync(() => wire.stop(failure("ready", `Chrome RPC peer did not answer within ${Duration.format(timeout)}`)))
          })),
          Effect.ignore,
          Effect.forkScoped
        )
      }

      const loop = yield* wire.receive(fromServer, "Malformed RPC response", (message) =>
        Predicate.isTagged(message, "Pong") ? Deferred.succeed(wire.ready, undefined) : receive(message)
      ).pipe(Effect.forkScoped)

      yield* wire.closed
      // Fail every call, streams included, before interrupting a receive that a full stream
      // buffer may block, so consumers see the transport failure rather than an interruption.
      yield* receive(protocolMessages.ClientProtocolError({ error: clientError(yield* wire.failure) }))
      yield* Fiber.interrupt(loop)

      return yield* Effect.never
    }).pipe(Effect.scoped),
    send: (clientId, message) => Effect.gen(function*() {
      // No request reached the peer before readiness, so cancellation must not wait
      // for a peer that may never appear (RPC sends Interrupt from its finalizer).
      if (Predicate.isTagged(message, "Interrupt") && !(yield* Deferred.isDone(wire.ready))) return
      // Readiness implies `run` started, so the owning client is known from here on.
      yield* Deferred.await(wire.ready)

      if (clientId !== owner) {
        return yield* failure("postMessage", "Chrome RPC protocol already serves another client")
      }

      yield* wire.send(message)
    }).pipe(Effect.mapError(clientError))
  })
})

/** Acquires one server connection. Run RpcServer.make in the same owning scope. */
export const makeServerProtocol = Effect.fnUntraced(function*(
  api: RuntimeApi, native: NativePort, ownership: Ownership, options: Options = {}
) {
  const wire = yield* transport(api, native, ownership, yield* limits(options))
  const disconnects = yield* Queue.make<number>({ capacity: 1 })
  let connected = true
  let used = false

  const protocol = RpcServer.Protocol.of({
    codecFor: RpcSerialization.json.codecFor,
    supportsAck: true, supportsTransferables: false, supportsSpanPropagation: true, supportsNotifications: false,
    disconnects,
    clientIds: Effect.sync(() => connected ? new Set([0]) : new Set<number>()),
    initialMessage: Effect.succeedNone,
    end: () => Effect.sync(() => wire.stop(failure("disconnect", "Chrome RPC client ended"))),
    send: (_clientId, response) => wire.send(response).pipe(Effect.catch((error) => {
      // The transport already failed every call.
      if (wire.error() !== undefined) return Effect.void

      // A refused Defect has no request to answer; a refused response is answered with a
      // request defect by RpcServer, as for a response it cannot encode.
      return Predicate.isTagged(response, "Defect") ? Effect.sync(() => wire.stop(error)) : Effect.die(error)
    })),
    run: (receive) => Effect.gen(function*() {
      if (used) return yield* Effect.die(new Error("Chrome RPC protocol requires exactly one server"))
      used = true

      yield* wire.receive(fromClient, "Malformed RPC request", (message) =>
        Predicate.isTagged(message, "Ping") ? wire.send(pong.make({})) : receive(0, message)
      ).pipe(Effect.raceFirst(wire.closed))
      connected = false
      yield* Queue.offer(disconnects, 0)

      return yield* Effect.never
    })
  })

  return { ...protocol, closed: wire.closed }
})

/**
 * Serves a dedicated connection until disconnect, then closes its scope and cancels
 * all handlers. Provide the group's handler layer and middleware to this Effect.
 */
export const serve = Effect.fnUntraced(function*<Rpcs extends Rpc.Any>(
  api: RuntimeApi, port: NativePort, ownership: Ownership, group: RpcGroup.RpcGroup<Rpcs>, options: ServeOptions = {}
) {
  const protocol = yield* makeServerProtocol(api, port, ownership, options)

  yield* RpcServer.make(group, options.server).pipe(
    Effect.provideService(RpcServer.Protocol, protocol), Effect.raceFirst(protocol.closed)
  )
}, Effect.scoped)

// Handlers are opaque here: finishAccepted re-hosts whatever each returns, and the caller's
// RpcGroup types both sides.
// oxlint-disable-next-line anti-slop/no-unknown-returns
type Handler = (payload: never, options: never) => unknown

/** The request metadata Effect RPC passes every handler; only the procedure is read here. */
interface HandlerOptions {
  readonly rpc: Rpc.AnyWithProps
}

// An Effect result moves to a detached fiber with its own scope, so neither the caller's
// disconnect nor the request scope closing ends its work or releases its resources.
const detach = <A extends object>(result: A): A => {
  if (!Effect.isEffect(result)) return result

  // SAFETY: the Effect keeps its success, error and requirements (less Scope, now its own).
  // The caller's group types them; here the channels are opaque, not unknown by design.
  // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context
  return Effect.flatMap(Effect.forkDetach(Effect.scoped(result)), Fiber.join) as A
}

/**
 * Lets each handler's work run to completion when its caller disconnects; only the reply is
 * lost. `serve` otherwise interrupts a connection's handlers when its port closes, unlike
 * `runtime.sendMessage`, whose listener always finishes. Use it for handlers whose work must
 * outlive the caller (an upload, a sign-in, a write), as in
 * `Group.toLayer(ChromeRpc.finishAccepted(handlers))`. Effect results, including those
 * wrapped by `Rpc.fork` or `Rpc.uninterruptible`, run in a detached fiber with their own scope
 * and the same success, error and requirements; results of streaming procedures are left as
 * they are.
 */
export const finishAccepted = <const Handlers extends { readonly [Tag in keyof Handlers]: Handler }>(
  handlers: Handlers
): Handlers => {
  const finished = new Map<string, Handler>()

  for (const [tag, handler] of Object.entries<Handler>(handlers)) {
    // SAFETY: Effect RPC calls every handler with its decoded payload and request metadata,
    // which names the procedure being served.
    const invoke = handler as (payload: never, options: HandlerOptions) => ReturnType<Handler>

    finished.set(tag, (payload: never, options: HandlerOptions) => {
      const result = invoke(payload, options)

      if (RpcSchema.isStreamSchema(options.rpc.successSchema) || !Predicate.isObjectKeyword(result)) return result

      return Rpc.wrapMap(result, detach)
    })
  }

  // SAFETY: every entry keeps its tag and parameters; an Effect result keeps its success,
  // error and requirement types, only moved to a detached fiber.
  return Object.fromEntries(finished) as Handlers
}

/** Scoped client protocol layer; the port must be dedicated to this RPC connection. */
export const layerClient = (
  api: RuntimeApi, port: NativePort, ownership: Ownership, options: Options = {}
): Layer.Layer<RpcClient.Protocol, ChromeRpcError> => Layer.effect(RpcClient.Protocol, makeClientProtocol(api, port, ownership, options))

/** Scoped single-connection server protocol layer. */
export const layerServer = (
  api: RuntimeApi, port: NativePort, ownership: Ownership, options: Options = {}
): Layer.Layer<RpcServer.Protocol, ChromeRpcError> => Layer.effect(RpcServer.Protocol, makeServerProtocol(api, port, ownership, options))
