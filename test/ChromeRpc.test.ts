// Pinned Effect 4.0.4 RPC and @effect/vitest are deliberately unstable integrations.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Predicate, Schema, Scope, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcServer from "effect/rpc/RpcServer"
import * as RpcMessage from "effect/rpc/RpcMessage"
import { TestClock } from "effect/testing"
import { finishAccepted, makeClientProtocol, makeServerProtocol, serve } from "../src/ChromeRpc.js"
import type { Options } from "../src/ChromeRpc.js"
import type { NativePort, RuntimeApi } from "../src/ChromePort.js"

class Rejected extends Schema.TaggedError<Rejected>()("Rejected", { message: Schema.String }) {}

const group = RpcGroup.make(
  Rpc.make("Echo", { payload: { value: Schema.String }, success: Schema.String, error: Rejected }),
  Rpc.make("Wait", { success: Schema.String }),
  Rpc.make("Numbers", { success: Schema.Finite, stream: true })
)

const pair = () => {
  type MessageListener = Parameters<NativePort["onMessage"]["addListener"]>[0]

  type DisconnectListener = Parameters<NativePort["onDisconnect"]["addListener"]>[0]

  const clientMessages = new Set<MessageListener>()
  const serverMessages = new Set<MessageListener>()
  const clientDisconnects = new Set<DisconnectListener>()
  const serverDisconnects = new Set<DisconnectListener>()
  let closed = false

  const event = <A>(listeners: Set<A>) => ({
    addListener: (listener: A) => { listeners.add(listener) },
    removeListener: (listener: A) => { listeners.delete(listener) },
    hasListener: (listener: A) => listeners.has(listener),
    hasListeners: () => listeners.size > 0,
    addRules: vi.fn(), getRules: vi.fn(), removeRules: vi.fn()
  })

  const close = vi.fn(() => {
    if (closed) return
    closed = true

    for (const listener of clientDisconnects) listener(client)

    for (const listener of serverDisconnects) listener(server)
  })

  const client: NativePort = {
    name: "rpc", disconnect: close,
    onMessage: event(clientMessages), onDisconnect: event(clientDisconnects),
    postMessage: vi.fn<NativePort["postMessage"]>((frame) => {
      if (closed) throw new Error("closed")

      for (const listener of serverMessages) listener(frame, server)
    })
  }

  const server: NativePort = {
    name: "rpc", disconnect: close,
    onMessage: event(serverMessages), onDisconnect: event(serverDisconnects),
    postMessage: vi.fn<NativePort["postMessage"]>((frame) => {
      if (closed) throw new Error("closed")

      for (const listener of clientMessages) listener(frame, client)
    })
  }

  // SAFETY: Chrome's ambient declaration makes lastError required although it is
  // undefined outside a native error callback. This mock models the actual boundary.
  const api = { connect: () => client, lastError: undefined } as RuntimeApi

  return { client, server, api, close, clientMessages, serverMessages, clientDisconnects, serverDisconnects }
}

const connect = Effect.fnUntraced(function*(
  ports: ReturnType<typeof pair>, handlers: Layer.Layer<Rpc.ToHandler<RpcGroup.Rpcs<typeof group>>>, options: Options = {}
) {
  const serverProtocol = yield* makeServerProtocol(ports.api, ports.server, "owned", options)

  const serverFiber = yield* RpcServer.make(group, { concurrency: "unbounded" }).pipe(
    Effect.provideService(RpcServer.Protocol, serverProtocol), Effect.provide(handlers), Effect.forkScoped
  )

  const clientProtocol = yield* makeClientProtocol(ports.api, ports.client, "owned", options)
  const client = yield* RpcClient.make(group).pipe(Effect.provideService(RpcClient.Protocol, clientProtocol))

  return { ports, client, serverFiber }
})

const setup = Effect.fnUntraced(function*() {
  const ports = pair()
  const started = yield* Deferred.make<void>()
  const cancelled = yield* Deferred.make<void>()

  const handlers = group.toLayer({
    Echo: ({ value }) => value === "reject" ? Effect.fail(new Rejected({ message: "no" })) : Effect.succeed(value),
    Wait: () => Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Effect.never), Effect.ensuring(Deferred.succeed(cancelled, undefined))
    ),
    Numbers: () => Stream.fromIterable([1, 2, 3, 4]).pipe(Stream.rechunk(1))
  })

  return { ...yield* connect(ports, handlers), started, cancelled }
})

describe("ChromeRpc", () => {
  it.effect("holds 2048 simultaneous real RPC requests and preserves correlation and typed failures", () => Effect.gen(function*() {
    const ports = pair()
    const allStarted = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let active = 0
    let completed = 0

    yield* Effect.scoped(Effect.gen(function*() {
      const { client } = yield* connect(ports, group.toLayer({
        Echo: ({ value }) => Effect.gen(function*() {
          active++

          if (active === 2048) yield* Deferred.succeed(allStarted, undefined)
          yield* Deferred.await(release)

          return value.startsWith("reject:") ? yield* new Rejected({ message: value }) : value
        }).pipe(Effect.ensuring(Effect.sync(() => { active--; completed++ }))),
        Wait: () => Effect.never, Numbers: () => Stream.empty
      }), { capacity: 4096 })

      const values = Array.from({ length: 2048 }, (_, i) => i % 17 === 0 ? `reject:${i}` : `value:${i}`)
      const calls = yield* Effect.forEach(values, (value) => client.Echo({ value }).pipe(Effect.exit, Effect.forkScoped))
      yield* Deferred.await(allStarted)
      expect(active).toBe(2048)
      expect(completed).toBe(0)
      yield* Deferred.succeed(release, undefined)
      const exits = yield* Effect.forEach(calls, Fiber.join, { concurrency: 64 })
      expect(exits).toEqual(values.map((value) => value.startsWith("reject:")
        ? Exit.fail(new Rejected({ message: value })) : Exit.succeed(value)))
      expect(active).toBe(0)
      expect(completed).toBe(2048)
      expect(ports.close).not.toHaveBeenCalled()
    }))
    expect(ports.clientMessages.size + ports.serverMessages.size + ports.clientDisconnects.size + ports.serverDisconnects.size).toBe(0)
    expect(ports.close).toHaveBeenCalledTimes(2)
  }))

  it.effect("512 cancellation storm leaves no remote handlers and ignores late responses", () => Effect.gen(function*() {
    const ports = pair()
    const allStarted = yield* Deferred.make<void>()
    const allCancelled = yield* Deferred.make<void>()
    let started = 0
    let active = 0
    let cancelled = 0

    const { client } = yield* connect(ports, group.toLayer({
      Echo: ({ value }) => Effect.succeed(value), Numbers: () => Stream.empty,
      Wait: () => Effect.gen(function*() {
        active++

        if (++started === 512) yield* Deferred.succeed(allStarted, undefined)

        return yield* Effect.never
      }).pipe(Effect.ensuring(Effect.gen(function*() {
        active--

        if (++cancelled === 512) yield* Deferred.succeed(allCancelled, undefined)
      })))
    }), { capacity: 1024 })

    const calls = yield* Effect.forEach(Array.from({ length: 512 }), () => client.Wait().pipe(Effect.forkScoped))
    yield* Deferred.await(allStarted)
    expect(active).toBe(512)
    yield* Effect.forEach(calls, Fiber.interrupt, { concurrency: 32 })
    const exits = yield* Effect.forEach(calls, Fiber.await)
    expect(exits.every((exit) => Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))).toBe(true)
    yield* Deferred.await(allCancelled)
    expect(active).toBe(0)
    expect(cancelled).toBe(512)

    for (let i = 0; i < 512; i++) {
      ports.server.postMessage(`{"_tag":"Exit","requestId":"${i}","exit":{"_tag":"Success","value":"late"}}`)
    }

    expect(yield* client.Echo({ value: "still usable" })).toBe("still usable")
    expect(ports.close).not.toHaveBeenCalled()
  }))

  it.effect("disconnect bypasses a backpressured stream receive and fails unrelated pending calls", () => Effect.gen(function*() {
    const ports = pair()
    const waiting = yield* Deferred.make<void>()
    const consumed = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const thirdChunk = yield* Deferred.make<void>()
    const streamClosed = yield* Deferred.make<void>()
    let chunks = 0
    const original = ports.server.postMessage
    ports.server.postMessage = (frame) => {
      original(frame)

      if (Predicate.isString(frame) && frame.includes('"_tag":"Chunk"') && ++chunks === 3) {
        Deferred.doneUnsafe(thirdChunk, Effect.void)
      }
    }

    const { client } = yield* connect(ports, group.toLayer({
      Echo: ({ value }) => Effect.succeed(value),
      Wait: () => Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never)),
      Numbers: () => Stream.fromIterable(Array.from({ length: 4096 }, (_, i) => i)).pipe(
        Stream.rechunk(1), Stream.ensuring(Deferred.succeed(streamClosed, undefined))
      )
    }))

    const call = yield* client.Wait().pipe(Effect.forkScoped)
    yield* Deferred.await(waiting)

    const stream = yield* client.Numbers(undefined, { streamBufferSize: 1 }).pipe(
      Stream.runForEach(() => Deferred.succeed(consumed, undefined).pipe(Effect.andThen(Deferred.await(release)))),
      Effect.forkScoped
    )

    yield* Deferred.await(consumed)
    yield* Deferred.await(thirdChunk)
    // An acknowledged one-item buffer admits only one queued item and one blocked offer.
    expect(chunks).toBe(3)
    ports.close()
    expect(Exit.isFailure(yield* Fiber.await(call))).toBe(true)
    yield* Deferred.await(streamClosed)
    yield* Deferred.succeed(release, undefined)
    expect(Exit.isFailure(yield* Fiber.await(stream))).toBe(true)
    expect(chunks).toBe(3)
    expect(ports.clientMessages.size + ports.serverMessages.size + ports.clientDisconnects.size + ports.serverDisconnects.size).toBe(0)
  }))

  it.effect("a gated slow consumer drains 4096 acknowledged chunks in order", () => Effect.gen(function*() {
    const ports = pair()
    const first = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()

    const { client } = yield* connect(ports, group.toLayer({
      Echo: ({ value }) => Effect.succeed(value), Wait: () => Effect.never,
      Numbers: () => Stream.fromIterable(Array.from({ length: 4096 }, (_, i) => i)).pipe(Stream.rechunk(1))
    }), { capacity: 8 })

    const values: number[] = []

    const stream = yield* client.Numbers(undefined, { streamBufferSize: 1 }).pipe(
      Stream.runForEach((value) => Effect.gen(function*() {
        values.push(value)

        if (value === 0) {
          yield* Deferred.succeed(first, undefined)
          yield* Deferred.await(release)
        }
      })), Effect.forkScoped
    )

    yield* Deferred.await(first)
    expect(values).toEqual([0])
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(stream)
    expect(values).toEqual(Array.from({ length: 4096 }, (_, i) => i))
    expect(ports.close).not.toHaveBeenCalled()
  }))

  it.effect.each(["onMessage", "onDisconnect"] as const)("partial %s registration failure cleans up immediately", (eventName) => Effect.gen(function*() {
    const ports = pair()

    if (eventName === "onMessage") {
      const add = ports.client.onMessage.addListener.bind(ports.client.onMessage)
      ports.client.onMessage.addListener = (listener) => {
        add(listener)
        throw new Error("registration failed after insert")
      }
    } else {
      const add = ports.client.onDisconnect.addListener.bind(ports.client.onDisconnect)
      ports.client.onDisconnect.addListener = (listener) => {
        add(listener)
        throw new Error("registration failed after insert")
      }
    }

    const error = yield* Effect.flip(makeClientProtocol(ports.api, ports.client, "owned"))
    expect(error.message).toContain("registration")
    // The enclosing test scope is still open: failed acquisition must not retain resources.
    expect(ports.clientMessages.size + ports.clientDisconnects.size).toBe(0)
    expect(ports.close).toHaveBeenCalledTimes(1)
  }))

  it.effect.each([false, true])("reentrant disconnect during registration removes late insertion (throws=%s)", (throws) => Effect.gen(function*() {
    const ports = pair()
    const add = ports.client.onDisconnect.addListener.bind(ports.client.onDisconnect)
    ports.client.onDisconnect.addListener = (listener) => {
      listener(ports.client)
      add(listener)

      if (throws) throw new Error("later registration failure")
    }

    const error = yield* Effect.flip(makeClientProtocol(ports.api, ports.client, "owned"))
    expect(error.message).toContain("disconnected")
    expect(ports.clientMessages.size + ports.clientDisconnects.size).toBe(0)
    expect(ports.close).toHaveBeenCalledTimes(1)
  }))

  it.effect("cleanup callback failures preserve first failure and still attempt both removals and disconnect", () => Effect.gen(function*() {
    const ports = pair()
    const removeMessage = ports.client.onMessage.removeListener.bind(ports.client.onMessage)
    const removeDisconnect = ports.client.onDisconnect.removeListener.bind(ports.client.onDisconnect)

    const messageRemoval = vi.fn((listener: Parameters<typeof removeMessage>[0]) => {
      removeMessage(listener)
      throw new Error("remove message")
    })

    const disconnectRemoval = vi.fn((listener: Parameters<typeof removeDisconnect>[0]) => {
      removeDisconnect(listener)
      throw new Error("remove disconnect")
    })

    ports.client.onMessage.removeListener = messageRemoval
    ports.client.onDisconnect.removeListener = disconnectRemoval
    ports.client.disconnect = vi.fn(() => { ports.close(); throw new Error("disconnect") })
    yield* Effect.scoped(makeClientProtocol(ports.api, ports.client, "owned"))
    expect(messageRemoval).toHaveBeenCalledTimes(1)
    expect(disconnectRemoval).toHaveBeenCalledTimes(1)
    expect(ports.client.disconnect).toHaveBeenCalledTimes(1)
    expect(ports.clientMessages.size + ports.clientDisconnects.size).toBe(0)
  }))

  it.effect.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid transport limits before listeners (%s)", (limit) => Effect.gen(function*() {
    const ports = pair()

    for (const options of [{ capacity: limit }, { maxFrameLength: limit }]) {
      const error = yield* Effect.flip(makeClientProtocol(ports.api, ports.client, "owned", options))
      expect(error.message).toContain("positive safe integers")
    }

    expect(ports.clientMessages.size + ports.clientDisconnects.size).toBe(0)
    expect(ports.close).not.toHaveBeenCalled()
  }))

  it.effect.each(["not json", "{}", "null", "[{}]", '{"_tag":"Chunk","requestId":"1","values":[]}'])("malformed frame before readiness fails waiting call (%s)", (frame) => Effect.gen(function*() {
    const ports = pair()
    const ping = yield* Deferred.make<void>()
    ports.client.postMessage = () => { Deferred.doneUnsafe(ping, Effect.void) }

    const protocol = yield* makeClientProtocol(ports.api, ports.client, "owned")
    const client = yield* RpcClient.make(group).pipe(Effect.provideService(RpcClient.Protocol, protocol))
    const call = yield* client.Echo({ value: "must not send" }).pipe(Effect.forkScoped)
    yield* Deferred.await(ping)
    ports.server.postMessage(frame)
    expect(Exit.isFailure(yield* Fiber.await(call))).toBe(true)
    expect(ports.clientMessages.size + ports.clientDisconnects.size).toBe(0)
    expect(ports.close).toHaveBeenCalledTimes(1)
  }))

  it.effect("dead peer readiness times out without sending or replaying requests", () => Effect.gen(function*() {
    const ports = pair()
    const ping = yield* Deferred.make<void>()
    const frames: string[] = []
    ports.client.postMessage = (frame) => {
      if (Predicate.isString(frame)) frames.push(frame)
      Deferred.doneUnsafe(ping, Effect.void)
    }

    yield* Effect.scoped(Effect.gen(function*() {
      const protocol = yield* makeClientProtocol(ports.api, ports.client, "owned")
      const client = yield* RpcClient.make(group).pipe(Effect.provideService(RpcClient.Protocol, protocol))
      const call = yield* client.Echo({ value: "unavailable" }).pipe(Effect.timeout("1 second"), Effect.forkScoped)
      yield* Deferred.await(ping)
      yield* TestClock.adjust("1 second")
      const error = yield* Fiber.join(call).pipe(Effect.flip)
      expect(error._tag).toBe("TimeoutError")
      expect(frames.length).toBeGreaterThan(0)
      expect(frames.every((frame) => frame === '{"_tag":"Ping"}')).toBe(true)
    }))
    expect(ports.clientMessages.size + ports.clientDisconnects.size).toBe(0)
    expect(ports.close).toHaveBeenCalledTimes(1)
  }))

  it.effect("a timed-out pre-readiness request is never replayed when the server appears", () => Effect.gen(function*() {
    const ports = pair()
    const ping = yield* Deferred.make<void>()
    const original = ports.client.postMessage
    ports.client.postMessage = (frame) => {
      original(frame)
      Deferred.doneUnsafe(ping, Effect.void)
    }

    const protocol = yield* makeClientProtocol(ports.api, ports.client, "owned")
    const client = yield* RpcClient.make(group).pipe(Effect.provideService(RpcClient.Protocol, protocol))
    const timedOut = yield* client.Echo({ value: "cancelled before ready" }).pipe(Effect.timeout("100 millis"), Effect.forkScoped)
    yield* Deferred.await(ping)
    yield* TestClock.adjust("100 millis")
    expect((yield* Fiber.join(timedOut).pipe(Effect.flip))._tag).toBe("TimeoutError")

    const handled: string[] = []
    const server = yield* makeServerProtocol(ports.api, ports.server, "owned")
    yield* RpcServer.make(group).pipe(
      Effect.provideService(RpcServer.Protocol, server),
      Effect.provide(group.toLayer({
        Echo: ({ value }) => Effect.sync(() => { handled.push(value);

 return value }),
        Wait: () => Effect.never, Numbers: () => Stream.empty
      })), Effect.forkScoped
    )
    const later = yield* client.Echo({ value: "after ready" }).pipe(Effect.forkScoped)
    yield* TestClock.adjust("100 millis")
    expect(yield* Fiber.join(later)).toBe("after ready")
    expect(handled).toEqual(["after ready"])
  }))

  it.effect.each([null, 42, { frame: "not a JSON string" }, new Uint8Array([1, 2, 3])])("rejects native non-string frames before readiness (%#)", (frame) => Effect.gen(function*() {
    const ports = pair()
    const protocol = yield* makeClientProtocol(ports.api, ports.client, "owned")
    ports.server.postMessage(frame)
    const error = yield* Effect.flip(protocol.send(0, RpcMessage.constEof))
    expect(error.message).toContain("Invalid or oversized RPC frame")
    expect(ports.clientMessages.size + ports.clientDisconnects.size).toBe(0)
    expect(ports.close).toHaveBeenCalledTimes(1)
  }))

  it.effect("native server send failure terminates pending calls and cancels handlers", () => Effect.gen(function*() {
    const { ports, client, started, cancelled } = yield* setup()
    const call = yield* client.Wait().pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    ports.server.postMessage = () => { throw new Error("native send failed") }

    expect((yield* Effect.flip(client.Echo({ value: "trigger" })))._tag).toBe("RpcClientError")
    expect(Exit.isFailure(yield* Fiber.await(call))).toBe(true)
    yield* Deferred.await(cancelled)
    expect(ports.clientMessages.size + ports.serverMessages.size + ports.clientDisconnects.size + ports.serverDisconnects.size).toBe(0)
    expect(ports.close).toHaveBeenCalledTimes(2)
  }))

  it.effect("oversized outbound request fails locally without reaching a handler", () => Effect.gen(function*() {
    const ports = pair()
    let handled = 0

    const { client } = yield* connect(ports, group.toLayer({
      Echo: ({ value }) => Effect.sync(() => { handled++;

 return value }),
      Wait: () => Effect.never, Numbers: () => Stream.empty
    }), { maxFrameLength: 200 })

    expect((yield* Effect.flip(client.Echo({ value: "x".repeat(201) })))._tag).toBe("RpcClientError")
    expect(handled).toBe(0)
    expect(ports.close).toHaveBeenCalledTimes(2)
  }))

  it.effect("actual handler defect reaches the client as a defect rather than a declared error", () => Effect.gen(function*() {
    const ports = pair()

    const { client } = yield* connect(ports, group.toLayer({
      Echo: () => Effect.die(new Error("remote defect")), Wait: () => Effect.never, Numbers: () => Stream.empty
    }))

    const exit = yield* Effect.exit(client.Echo({ value: "defect" }))
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)

    if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("remote defect")
  }))

  it.effect("disconnect storm fails 1024 pending requests and finalizes every remote handler once", () => Effect.gen(function*() {
    const ports = pair()
    const allStarted = yield* Deferred.make<void>()
    const allCancelled = yield* Deferred.make<void>()
    let active = 0
    let cancelled = 0

    const { client } = yield* connect(ports, group.toLayer({
      Echo: ({ value }) => Effect.succeed(value), Numbers: () => Stream.empty,
      Wait: () => Effect.gen(function*() {
        if (++active === 1024) yield* Deferred.succeed(allStarted, undefined)

        return yield* Effect.never
      }).pipe(Effect.ensuring(Effect.gen(function*() {
        active--

        if (++cancelled === 1024) yield* Deferred.succeed(allCancelled, undefined)
      })))
    }), { capacity: 2048 })

    const calls = yield* Effect.forEach(Array.from({ length: 1024 }), () => client.Wait().pipe(Effect.forkScoped))
    yield* Deferred.await(allStarted)
    expect(active).toBe(1024)
    ports.close()
    const exits = yield* Effect.forEach(calls, Fiber.await, { concurrency: 64 })
    expect(exits.every(Exit.isFailure)).toBe(true)
    yield* Deferred.await(allCancelled)
    expect(active).toBe(0)
    expect(cancelled).toBe(1024)
    expect(ports.clientMessages.size + ports.serverMessages.size + ports.clientDisconnects.size + ports.serverDisconnects.size).toBe(0)
    expect(ports.close).toHaveBeenCalledTimes(3)
  }))

  it.effect("128 interrupted backpressured streams finalize remotely without breaking the connection", () => Effect.gen(function*() {
    const ports = pair()
    const allConsumed = yield* Deferred.make<void>()
    const allCancelled = yield* Deferred.make<void>()
    let consumed = 0
    let active = 0
    let cancelled = 0

    const { client } = yield* connect(ports, group.toLayer({
      Echo: ({ value }) => Effect.succeed(value), Wait: () => Effect.never,
      Numbers: () => Stream.fromEffect(Effect.sync(() => { active++;

 return 0 })).pipe(
        Stream.flatMap(() => Stream.fromIterable(Array.from({ length: 4096 }, (_, i) => i)).pipe(Stream.rechunk(1))),
        Stream.ensuring(Effect.gen(function*() {
          active--

          if (++cancelled === 128) yield* Deferred.succeed(allCancelled, undefined)
        }))
      )
    }), { capacity: 1024 })

    const streams = yield* Effect.forEach(Array.from({ length: 128 }), () => client.Numbers(undefined, { streamBufferSize: 1 }).pipe(
      Stream.runForEach(() => Effect.gen(function*() {
        if (++consumed === 128) yield* Deferred.succeed(allConsumed, undefined)

        return yield* Effect.never
      })), Effect.forkScoped
    ))

    yield* Deferred.await(allConsumed)
    expect(active).toBe(128)
    yield* Effect.forEach(streams, Fiber.interrupt, { concurrency: 32 })
    yield* Deferred.await(allCancelled)
    expect(active).toBe(0)
    expect(cancelled).toBe(128)
    expect(yield* client.Echo({ value: "after streams" })).toBe("after streams")
    expect(ports.close).not.toHaveBeenCalled()
  }))

  it.effect("ingress admits exactly capacity frames then terminates without draining stale frames", () => Effect.gen(function*() {
    const ports = pair()
    const protocol = yield* makeServerProtocol(ports.api, ports.server, "owned", { capacity: 8 })

    for (let i = 0; i < 8; i++) ports.client.postMessage('{"_tag":"Ping"}')
    expect(ports.close).not.toHaveBeenCalled()
    ports.client.postMessage('{"_tag":"Ping"}')
    yield* protocol.closed
    expect(ports.close).toHaveBeenCalledTimes(1)
    expect(ports.serverMessages.size + ports.serverDisconnects.size).toBe(0)
    expect(ports.server.postMessage).not.toHaveBeenCalled()
  }))

  it.effect.each(["not json", "null", "{}", '[{"_tag":"Ping"},{}]', '{"_tag":"Request","id":"1","tag":"Echo","payload":{},"headers":"bad"}'])("malformed server ingress terminates its protocol (%s)", (frame) => Effect.gen(function*() {
    const ports = pair()
    const protocol = yield* makeServerProtocol(ports.api, ports.server, "owned")
    yield* protocol.run(() => Effect.void).pipe(Effect.forkScoped)
    ports.client.postMessage(frame)
    yield* protocol.closed
    expect(ports.close).toHaveBeenCalledTimes(1)
    expect(ports.serverMessages.size + ports.serverDisconnects.size).toBe(0)
  }))

  it.effect("round trips schema success, typed failure, concurrent requests and acknowledged streams", () => Effect.gen(function*() {
    const { client } = yield* setup()
    expect(yield* client.Echo({ value: "hello" })).toBe("hello")
    expect(yield* Effect.flip(client.Echo({ value: "reject" }))).toEqual(new Rejected({ message: "no" }))

    const values = yield* Effect.forEach(Array.from({ length: 128 }, (_, i) => String(i)),
      (value) => client.Echo({ value }), { concurrency: 32 })

    expect(values).toEqual(Array.from({ length: 128 }, (_, i) => String(i)))
    expect(yield* Stream.runCollect(client.Numbers())).toEqual([1, 2, 3, 4])
  }))

  it.effect("interrupt forwards native RPC cancellation to the remote handler", () => Effect.gen(function*() {
    const { client, started, cancelled } = yield* setup()
    const call = yield* client.Wait().pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    expect(yield* client.Echo({ value: "concurrent" })).toBe("concurrent")
    yield* Fiber.interrupt(call)
    yield* Deferred.await(cancelled)
  }))

  it.effect("disconnect fails pending and subsequent calls and interrupts remote work", () => Effect.gen(function*() {
    const { ports, client, started, cancelled } = yield* setup()
    const call = yield* client.Wait().pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    ports.close()
    const exit = yield* Fiber.await(call)
    expect(Exit.isFailure(exit)).toBe(true)
    yield* Deferred.await(cancelled)
    const error = yield* Effect.flip(client.Echo({ value: "later" }))
    expect(error._tag).toBe("RpcClientError")
    expect(ports.clientMessages.size + ports.serverMessages.size).toBe(0)
  }))

  it.effect("scope releases both listeners and owned ports", () => Effect.gen(function*() {
    const ports = yield* Effect.scoped(Effect.gen(function*() {
      const { ports, client } = yield* setup()
      yield* client.Echo({ value: "ready" })

      return ports
    }))

    expect(ports.clientMessages.size + ports.serverMessages.size + ports.clientDisconnects.size + ports.serverDisconnects.size).toBe(0)
    expect(ports.close).toHaveBeenCalled()
  }))

  it.effect("retries only readiness Ping when the first frame precedes server acquisition", () => Effect.gen(function*() {
    const ports = pair()
    const ping = yield* Deferred.make<void>()
    const original = ports.client.postMessage

    ports.client.postMessage = (frame) => {
      original(frame)
      Deferred.doneUnsafe(ping, Effect.void)
    }

    const protocol = yield* makeClientProtocol(ports.api, ports.client, "owned")
    const client = yield* RpcClient.make(group).pipe(Effect.provideService(RpcClient.Protocol, protocol))
    const call = yield* client.Echo({ value: "ready" }).pipe(Effect.forkScoped)
    yield* Deferred.await(ping)

    const server = yield* makeServerProtocol(ports.api, ports.server, "owned")
    yield* RpcServer.make(group).pipe(
      Effect.provideService(RpcServer.Protocol, server),
      Effect.provide(group.toLayer({ Echo: ({ value }) => Effect.succeed(value), Wait: () => Effect.never, Numbers: () => Stream.empty })),
      Effect.forkScoped
    )
    yield* TestClock.adjust("100 millis")
    expect(yield* Fiber.join(call)).toBe("ready")
  }))

  it.effect("overflow fails fast without silently dropping RPC frames", () => Effect.gen(function*() {
    const ports = pair()
    const protocol = yield* makeClientProtocol(ports.api, ports.client, "owned", { capacity: 1 })
    ports.server.postMessage('{"_tag":"Pong"}')
    ports.server.postMessage('{"_tag":"Pong"}')
    const error = yield* Effect.flip(protocol.send(0, RpcMessage.constEof))
    expect(error.message).toContain("overflow")
    expect(ports.close).toHaveBeenCalled()
  }))

  it.effect("borrowed scope detaches without disconnecting the caller-owned native port", () => Effect.gen(function*() {
    const ports = pair()
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
    yield* makeServerProtocol(ports.api, ports.server, "borrowed").pipe(Effect.provideService(Scope.Scope, scope))
    const lateMessages = Array.from(ports.serverMessages)
    const lateDisconnects = Array.from(ports.serverDisconnects)
    yield* Scope.close(scope, Exit.void)

    for (const listener of lateMessages) listener("not json", ports.server)

    for (const listener of lateDisconnects) listener(ports.server)
    expect(ports.serverMessages.size + ports.serverDisconnects.size).toBe(0)
    expect(ports.close).not.toHaveBeenCalled()
  }))

  it.effect.each(["{}", "not json", "x".repeat(1024 * 1024 + 1)])("invalid response fails pending work (%#)", (frame) => Effect.gen(function*() {
    const { ports, client, started, cancelled } = yield* setup()
    const call = yield* client.Wait().pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    ports.server.postMessage(frame)
    expect(Exit.isFailure(yield* Fiber.await(call))).toBe(true)
    yield* Deferred.await(cancelled)
    expect(ports.close).toHaveBeenCalled()
  }))

  it.effect("overflow also fails already pending calls and cancels server work", () => Effect.gen(function*() {
    const { ports, client, started, cancelled } = yield* setup()
    const call = yield* client.Wait().pipe(Effect.forkScoped)
    yield* Deferred.await(started)

    for (let i = 0; i < 257; i++) ports.server.postMessage('{"_tag":"Pong"}')

    expect(Exit.isFailure(yield* Fiber.await(call))).toBe(true)
    yield* Deferred.await(cancelled)
  }))

  it.effect("serve completes and releases its connection scope on native disconnect", () => Effect.gen(function*() {
    const ports = pair()

    const handlers = group.toLayer({
      Echo: ({ value }) => Effect.succeed(value), Wait: () => Effect.never, Numbers: () => Stream.empty
    })

    const server = yield* serve(ports.api, ports.server, "owned", group).pipe(Effect.provide(handlers), Effect.forkScoped)
    const protocol = yield* makeClientProtocol(ports.api, ports.client, "owned")
    const client = yield* RpcClient.make(group).pipe(Effect.provideService(RpcClient.Protocol, protocol))

    yield* client.Echo({ value: "ready" })
    ports.close()
    yield* Fiber.join(server)
    expect(ports.serverMessages.size + ports.serverDisconnects.size).toBe(0)
  }))

  it.effect("readyTimeout fails waiting calls when nothing serves the port", () => Effect.gen(function*() {
    const ports = pair()
    const ping = yield* Deferred.make<void>()
    ports.client.postMessage = () => { Deferred.doneUnsafe(ping, Effect.void) }

    const protocol = yield* makeClientProtocol(ports.api, ports.client, "owned", { readyTimeout: "1 second" })
    const client = yield* RpcClient.make(group).pipe(Effect.provideService(RpcClient.Protocol, protocol))
    const call = yield* client.Echo({ value: "unanswered" }).pipe(Effect.forkScoped)
    yield* Deferred.await(ping)
    yield* TestClock.adjust("1 second")
    const error = yield* Fiber.join(call).pipe(Effect.flip)
    expect(error._tag).toBe("RpcClientError")
    expect(String(Cause.squash(Cause.fail(error)))).toContain("did not answer within")
    expect(ports.close).toHaveBeenCalled()
  }))

  it.effect("readyTimeout does not affect a peer that answers in time", () => Effect.gen(function*() {
    const { client } = yield* connect(pair(), group.toLayer({
      Echo: ({ value }) => Effect.succeed(value), Wait: () => Effect.never, Numbers: () => Stream.empty
    }), { readyTimeout: "1 second" })

    expect(yield* client.Echo({ value: "in time" })).toBe("in time")
    yield* TestClock.adjust("2 seconds")
    expect(yield* client.Echo({ value: "still connected" })).toBe("still connected")
  }))

  it.effect.each([false, true])("a caller's disconnect interrupts accepted work unless finishAccepted (finishAccepted=%s)", (finish) => Effect.gen(function*() {
    const ports = pair()
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const finished = yield* Deferred.make<boolean>()

    const handlers = {
      Echo: ({ value }: { readonly value: string }) => Effect.succeed(value),
      Wait: () => Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as("done"),
        Effect.onExit((exit) => Deferred.succeed(finished, Exit.isSuccess(exit)))
      ),
      Numbers: () => Stream.empty
    }

    const server = yield* serve(ports.api, ports.server, "owned", group).pipe(
      Effect.provide(group.toLayer(finish ? finishAccepted(handlers) : handlers)), Effect.forkScoped
    )

    const protocol = yield* makeClientProtocol(ports.api, ports.client, "owned")
    const client = yield* RpcClient.make(group).pipe(Effect.provideService(RpcClient.Protocol, protocol))
    yield* client.Wait().pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    ports.close()
    yield* Fiber.join(server)
    yield* Deferred.succeed(release, undefined)
    expect(yield* Deferred.await(finished)).toBe(finish)
  }))
})
