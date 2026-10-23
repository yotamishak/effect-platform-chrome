// Pinned Effect 4.0.4 RPC and @effect/vitest are deliberately unstable integrations.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Cause, Deferred, Effect, Exit, Fiber, Predicate, Scope, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcServer from "effect/rpc/RpcServer"
import { TestClock } from "effect/testing"
import { finishAccepted, makeClientProtocol, makeServerProtocol, serve } from "../../src/ChromeRpc.js"
import type { Options, ServerOptions } from "../../src/ChromeRpc.js"
import { group, pair, Rejected, transportError, transportFailure } from "../support/ChromeRpc.js"
import type { Handlers, Ports } from "../support/ChromeRpc.js"

const connect = Effect.fnUntraced(function*(
  ports: Ports, handlers: Handlers, options: Options = {}, server: ServerOptions = { concurrency: "unbounded" }
) {
  const serverProtocol = yield* makeServerProtocol(ports.api, ports.server, "owned", options)

  yield* RpcServer.make(group, server).pipe(
    Effect.provideService(RpcServer.Protocol, serverProtocol), Effect.provide(handlers), Effect.forkScoped
  )

  const clientProtocol = yield* makeClientProtocol(ports.api, ports.client, "owned", options)

  return yield* RpcClient.make(group).pipe(Effect.provideService(RpcClient.Protocol, clientProtocol))
})

/** A Deferred completed by the `target`-th call of the returned counter. */
const countdown = Effect.fnUntraced(function*(target: number) {
  const done = yield* Deferred.make<void>()
  let count = 0

  if (target === 0) yield* Deferred.succeed(done, undefined)

  // For native callbacks, which run outside any fiber.
  const tickUnsafe = () => {
    if (++count === target) Deferred.doneUnsafe(done, Effect.void)
  }

  return { done: Deferred.await(done), tick: Effect.sync(tickUnsafe), tickUnsafe, count: () => count }
})

const request = (id: number) => `{"_tag":"Request","id":"${id}","tag":"Echo","payload":{"value":"${id}"},"headers":[]}`

// About 1.5 s in total on an idle machine; the timeout only absorbs a heavily loaded host.
describe("ChromeRpc stress", { timeout: 30_000 }, () => {
  it.effect("a 4,096-frame burst survives whole and in order", () => Effect.gen(function*() {
    const ports = pair()
    const handled: Array<string> = []
    const exits: Array<string> = []
    const answered = yield* countdown(4096)
    ports.server.postMessage = (frame) => {
      if (Predicate.isString(frame)) exits.push(frame)
      answered.tickUnsafe()
    }

    yield* Effect.scoped(Effect.gen(function*() {
      const protocol = yield* makeServerProtocol(ports.api, ports.server, "owned", { capacity: 4096 })

      // The whole burst arrives before the receive loop runs, as Chrome may deliver it.
      for (let id = 0; id < 4096; id++) ports.client.postMessage(request(id))

      yield* RpcServer.make(group, { concurrency: "unbounded" }).pipe(
        Effect.provideService(RpcServer.Protocol, protocol),
        Effect.provide(group.toLayer({
          Echo: ({ value }) => Effect.sync(() => {
            handled.push(value)

            return value
          }),
          Wait: () => Effect.never, Numbers: () => Stream.empty
        })),
        Effect.forkScoped
      )
      yield* answered.done
      expect(handled).toEqual(Array.from({ length: 4096 }, (_, id) => String(id)))
      expect(exits).toEqual(Array.from({ length: 4096 }, (_, id) => `{"_tag":"Exit","requestId":"${id}","exit":{"_tag":"Success","value":"${id}"}}`))
      expect(ports.close).not.toHaveBeenCalled()
    }))
    expect(ports.listeners()).toBe(0)
    expect(ports.close).toHaveBeenCalledTimes(1)
  }))

  it.effect("a 4,096-frame burst past capacity terminates at frame 65 and never drains the stale 64", () => Effect.gen(function*() {
    const ports = pair()
    let handled = 0
    const protocol = yield* makeServerProtocol(ports.api, ports.server, "owned", { capacity: 64 })
    let delivered = 0

    for (let id = 0; id < 4096; id++) {
      if (ports.serverMessages.size === 0) break
      ports.client.postMessage(request(id))
      delivered++
    }

    expect(delivered).toBe(65)
    yield* RpcServer.make(group).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.provide(group.toLayer({
        Echo: ({ value }) => Effect.sync(() => {
          handled++

          return value
        }),
        Wait: () => Effect.never, Numbers: () => Stream.empty
      })),
      Effect.raceFirst(protocol.closed)
    )
    expect(handled).toBe(0)
    expect(ports.server.postMessage).not.toHaveBeenCalled()
    expect(ports.listeners()).toBe(0)
    expect(ports.close).toHaveBeenCalledTimes(1)
  }))

  it.effect("holds 2,048 simultaneous requests and preserves correlation and typed failures", () => Effect.gen(function*() {
    const ports = pair()
    const allStarted = yield* countdown(2048)
    const release = yield* Deferred.make<void>()
    let active = 0
    let completed = 0

    yield* Effect.scoped(Effect.gen(function*() {
      const client = yield* connect(ports, group.toLayer({
        Echo: ({ value }) => Effect.gen(function*() {
          active++
          yield* allStarted.tick
          yield* Deferred.await(release)

          return value.startsWith("reject:") ? yield* new Rejected({ message: value }) : value
        }).pipe(Effect.ensuring(Effect.sync(() => {
          active--
          completed++
        }))),
        Wait: () => Effect.never, Numbers: () => Stream.empty
      }), { capacity: 4096 })

      const values = Array.from({ length: 2048 }, (_, i) => i % 17 === 0 ? `reject:${i}` : `value:${i}`)
      const calls = yield* Effect.forEach(values, (value) => client.Echo({ value }).pipe(Effect.exit, Effect.forkScoped))
      yield* allStarted.done
      expect(active).toBe(2048)
      expect(completed).toBe(0)
      yield* Deferred.succeed(release, undefined)
      const exits = yield* Effect.forEach(calls, Fiber.join)
      expect(exits).toEqual(values.map((value) => value.startsWith("reject:")
        ? Exit.fail(new Rejected({ message: value })) : Exit.succeed(value)))
      expect(active).toBe(0)
      expect(completed).toBe(2048)
      expect(ports.close).not.toHaveBeenCalled()
    }))
    expect(ports.listeners()).toBe(0)
    expect(ports.close).toHaveBeenCalledTimes(2)
  }))

  it.effect("1,028 concurrent calls interleave successes, typed failures, handler throws and oversized requests", () => Effect.gen(function*() {
    const ports = pair()
    const accepted = yield* countdown(771)
    const release = yield* Deferred.make<void>()
    const handled = new Set<string>()

    yield* serve(ports.api, ports.server, "owned", group, { capacity: 2048, maxFrameLength: 512, server: { disableFatalDefects: true } }).pipe(
      Effect.provide(group.toLayer({
        Echo: ({ value }) => Effect.gen(function*() {
          handled.add(value)
          yield* accepted.tick
          yield* Deferred.await(release)

          if (value.startsWith("reject:")) return yield* new Rejected({ message: value })

          if (value.startsWith("throw:")) {
            return yield* Effect.sync(() => {
              throw new Error(value)
            })
          }

          return value
        }),
        Wait: () => Effect.never, Numbers: () => Stream.empty
      })),
      Effect.forkScoped
    )

    const protocol = yield* makeClientProtocol(ports.api, ports.client, "owned", { capacity: 2048, maxFrameLength: 512 })
    const client = yield* RpcClient.make(group).pipe(Effect.provideService(RpcClient.Protocol, protocol))
    const kinds = ["ok", "reject", "throw", "huge"] as const
    const values = Array.from({ length: 1028 }, (_, i) => kinds[i % 4] === "huge" ? `huge:${i}:${"x".repeat(512)}` : `${kinds[i % 4]}:${i}`)
    const calls = yield* Effect.forEach(values, (value) => client.Echo({ value }).pipe(Effect.exit, Effect.forkScoped))
    yield* accepted.done
    yield* Deferred.succeed(release, undefined)
    const exits = yield* Effect.forEach(calls, Fiber.join)

    for (const [i, exit] of exits.entries()) {
      const value = values[i] ?? ""

      switch (kinds[i % 4]) {
        case "ok":
          expect(exit).toEqual(Exit.succeed(value))
          break
        case "reject":
          expect(exit).toEqual(Exit.fail(new Rejected({ message: value })))
          break
        case "throw":
          expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause) && String(Cause.squash(exit.cause)).includes(value)).toBe(true)
          break
        default: {
          const error = transportFailure(exit)
          expect(error.operation).toBe("postMessage")
          expect(error.message).toContain("oversized")
          expect(handled.has(value)).toBe(false)
        }
      }
    }

    expect(handled.size).toBe(771)
    expect(ports.close).not.toHaveBeenCalled()
  }))

  it.effect("1,024 concurrent connections interleave registration throws, send throws and disconnects", () => Effect.gen(function*() {
    const lastError = { message: "Could not establish connection. Receiving end does not exist." }
    const all = Array.from({ length: 1024 }, (_, i) => ({ i, ports: pair(i % 4 === 3 ? lastError : undefined) }))
    const refusal = new Error("registration refused")
    const sendRefusal = new Error("Attempting to use a disconnected port object")

    const outcomes = yield* Effect.forEach(all, ({ i, ports }) => Effect.scoped(Effect.gen(function*() {
      switch (i % 4) {
        case 0: {
          const client = yield* connect(ports, group.toLayer({
            Echo: ({ value }) => Effect.succeed(value), Wait: () => Effect.never, Numbers: () => Stream.empty
          }))

          return { i, value: yield* client.Echo({ value: String(i) }) }
        }

        case 1: {
          ports.client.onDisconnect.addListener = () => { throw refusal }

          const error = yield* Effect.flip(makeClientProtocol(ports.api, ports.client, "owned"))

          return { i, operation: error.operation, cause: error.cause }
        }

        case 2: {
          ports.client.postMessage = () => { throw sendRefusal }

          const protocol = yield* makeClientProtocol(ports.api, ports.client, "owned")
          const client = yield* RpcClient.make(group).pipe(Effect.provideService(RpcClient.Protocol, protocol))
          const error = transportError(yield* Effect.flip(client.Echo({ value: "never sent" })))

          return { i, operation: error.operation, cause: error.cause }
        }

        default: {
          const protocol = yield* makeClientProtocol(ports.api, ports.client, "owned")
          const client = yield* RpcClient.make(group).pipe(Effect.provideService(RpcClient.Protocol, protocol))
          const call = yield* client.Echo({ value: "unanswered" }).pipe(Effect.flip, Effect.forkScoped)
          ports.close()
          const error = transportError(yield* Fiber.join(call))

          return { i, operation: error.operation, cause: error.cause }
        }
      }
    })), { concurrency: "unbounded" })

    expect(outcomes).toEqual(all.map(({ i }) => [
      { i, value: String(i) },
      { i, operation: "addListener", cause: refusal },
      { i, operation: "postMessage", cause: sendRefusal },
      { i, operation: "onDisconnect", cause: lastError }
    ][i % 4]))
    expect(all.reduce((sum, { ports }) => sum + ports.listeners(), 0)).toBe(0)
  }))

  it.effect("512 connections interrupted at every stage leave zero listeners and no remote work", () => Effect.gen(function*() {
    const stages = ["serverOnly", "beforeReady", "midCall", "midStream", "afterCall"] as const
    const connections = Array.from({ length: 512 }, (_, i) => ({ stage: stages[i % stages.length], ports: pair() }))
    const reached = yield* countdown(connections.length)
    const midCall = connections.filter(({ stage }) => stage === "midCall").length
    const midStream = connections.filter(({ stage }) => stage === "midStream").length
    const callsFinalized = yield* countdown(midCall)
    const streamsFinalized = yield* countdown(midStream)

    const handlers = group.toLayer({
      Echo: ({ value }) => Effect.succeed(value),
      Wait: () => reached.tick.pipe(Effect.andThen(Effect.never), Effect.ensuring(callsFinalized.tick)),
      Numbers: () => Stream.iterate(0, (n) => n + 1).pipe(Stream.rechunk(1), Stream.ensuring(streamsFinalized.tick))
    })

    const fibers = yield* Effect.forEach(connections, ({ stage, ports }) => Effect.scoped(Effect.gen(function*() {
      if (stage === "serverOnly") {
        yield* makeServerProtocol(ports.api, ports.server, "owned")
        yield* reached.tick

        return yield* Effect.never
      }

      if (stage === "beforeReady") {
        const protocol = yield* makeClientProtocol(ports.api, ports.client, "owned")
        const client = yield* RpcClient.make(group).pipe(Effect.provideService(RpcClient.Protocol, protocol))
        yield* client.Echo({ value: "pending" }).pipe(Effect.forkScoped)
        yield* reached.tick

        return yield* Effect.never
      }

      const client = yield* connect(ports, handlers)

      if (stage === "midCall") return yield* client.Wait()

      if (stage === "midStream") {
        return yield* client.Numbers(undefined, { streamBufferSize: 1 }).pipe(
          Stream.runForEach(() => reached.tick.pipe(Effect.andThen(Effect.never)))
        )
      }

      yield* client.Echo({ value: "done" })
      yield* reached.tick

      return yield* Effect.never
    })).pipe(Effect.forkScoped))

    yield* reached.done
    yield* Fiber.interruptAll(fibers)
    yield* callsFinalized.done
    yield* streamsFinalized.done
    expect(connections.reduce((sum, { ports }) => sum + ports.listeners(), 0)).toBe(0)
    expect(connections.every(({ ports }) => ports.close.mock.calls.length >= 1)).toBe(true)
  }))

  it.effect("512 cancellations leave no remote handlers and ignore late responses", () => Effect.gen(function*() {
    const ports = pair()
    const allStarted = yield* countdown(512)
    const allCancelled = yield* countdown(512)
    let active = 0

    const client = yield* connect(ports, group.toLayer({
      Echo: ({ value }) => Effect.succeed(value), Numbers: () => Stream.empty,
      Wait: () => Effect.sync(() => active++).pipe(
        Effect.andThen(allStarted.tick), Effect.andThen(Effect.never),
        Effect.ensuring(Effect.sync(() => active--).pipe(Effect.andThen(allCancelled.tick)))
      )
    }), { capacity: 1024 })

    const calls = yield* Effect.forEach(Array.from({ length: 512 }), () => client.Wait().pipe(Effect.forkScoped))
    yield* allStarted.done
    expect(active).toBe(512)
    yield* Fiber.interruptAll(calls)
    const exits = yield* Effect.forEach(calls, Fiber.await)
    expect(exits.every((exit) => Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))).toBe(true)
    yield* allCancelled.done
    expect(active).toBe(0)

    for (let i = 0; i < 512; i++) {
      ports.server.postMessage(`{"_tag":"Exit","requestId":"${i}","exit":{"_tag":"Success","value":"late"}}`)
    }

    expect(yield* client.Echo({ value: "still usable" })).toBe("still usable")
    expect(ports.close).not.toHaveBeenCalled()
  }))

  it.effect("a disconnect fails 1,024 pending requests and finalizes every remote handler once", () => Effect.gen(function*() {
    const ports = pair()
    const allStarted = yield* countdown(1024)
    const allCancelled = yield* countdown(1024)

    const client = yield* connect(ports, group.toLayer({
      Echo: ({ value }) => Effect.succeed(value), Numbers: () => Stream.empty,
      Wait: () => allStarted.tick.pipe(Effect.andThen(Effect.never), Effect.ensuring(allCancelled.tick))
    }), { capacity: 2048 })

    const calls = yield* Effect.forEach(Array.from({ length: 1024 }), () => client.Wait().pipe(Effect.flip, Effect.forkScoped))
    yield* allStarted.done
    ports.close()
    const errors = yield* Effect.forEach(calls, Fiber.join)
    expect(new Set(errors.map((error) => transportError(error).operation))).toEqual(new Set(["onDisconnect"]))
    yield* allCancelled.done
    expect(allCancelled.count()).toBe(1024)
    expect(ports.listeners()).toBe(0)
  }))

  it.effect("a disconnect racing in-flight sends fails every call with it and starts no handler afterwards", () => Effect.gen(function*() {
    const ports = pair()
    let handled = 0
    const halfway = yield* countdown(256)

    const client = yield* connect(ports, group.toLayer({
      Echo: ({ value }) => Effect.sync(() => handled++).pipe(Effect.andThen(halfway.tick), Effect.andThen(Effect.never), Effect.as(value)),
      Wait: () => Effect.never, Numbers: () => Stream.empty
    }), { capacity: 1024 })

    const calls = yield* Effect.forEach(Array.from({ length: 512 }, (_, i) => String(i)), (value) =>
      client.Echo({ value }).pipe(Effect.exit, Effect.forkScoped))

    yield* halfway.done
    ports.close()
    const handledAtDisconnect = handled
    const exits = yield* Effect.forEach(calls, Fiber.join)
    expect(new Set(exits.map((exit) => transportFailure(exit).operation))).toEqual(new Set(["onDisconnect"]))
    expect(handledAtDisconnect).toBeGreaterThanOrEqual(256)
    expect(handled).toBe(handledAtDisconnect)
    expect(ports.listeners()).toBe(0)
  }))

  it.effect("a gated slow consumer drains 4,096 acknowledged chunks in order", () => Effect.gen(function*() {
    const ports = pair()
    const first = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()

    const client = yield* connect(ports, group.toLayer({
      Echo: ({ value }) => Effect.succeed(value), Wait: () => Effect.never,
      Numbers: () => Stream.fromIterable(Array.from({ length: 4096 }, (_, i) => i)).pipe(Stream.rechunk(1))
    }), { capacity: 8 })

    const values: Array<number> = []

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

  it.effect("128 interrupted backpressured streams finalize remotely without breaking the connection", () => Effect.gen(function*() {
    const ports = pair()
    const allConsumed = yield* countdown(128)
    const allCancelled = yield* countdown(128)
    let active = 0

    const client = yield* connect(ports, group.toLayer({
      Echo: ({ value }) => Effect.succeed(value), Wait: () => Effect.never,
      Numbers: () => Stream.fromEffect(Effect.sync(() => active++)).pipe(
        Stream.flatMap(() => Stream.fromIterable(Array.from({ length: 4096 }, (_, i) => i)).pipe(Stream.rechunk(1))),
        Stream.ensuring(Effect.sync(() => active--).pipe(Effect.andThen(allCancelled.tick)))
      )
    }), { capacity: 1024 })

    const streams = yield* Effect.forEach(Array.from({ length: 128 }), () => client.Numbers(undefined, { streamBufferSize: 1 }).pipe(
      Stream.runForEach(() => allConsumed.tick.pipe(Effect.andThen(Effect.never))), Effect.forkScoped
    ))

    yield* allConsumed.done
    expect(active).toBe(128)
    yield* Fiber.interruptAll(streams)
    yield* allCancelled.done
    expect(active).toBe(0)
    expect(yield* client.Echo({ value: "after streams" })).toBe("after streams")
    expect(ports.close).not.toHaveBeenCalled()
  }))

  it.effect("readyTimeout races Pong across 128 clients: answered ones connect, the rest fail at the deadline", () => Effect.gen(function*() {
    const connections = Array.from({ length: 128 }, (_, i) => ({ answered: i % 2 === 0, ports: pair() }))
    const pinged = yield* countdown(connections.length)

    for (const { ports } of connections) {
      const original = ports.client.postMessage
      let first = true
      ports.client.postMessage = (frame) => {
        if (first) pinged.tickUnsafe()
        first = false
        original(frame)
      }
    }

    const calls = yield* Effect.forEach(connections, ({ ports }) => Effect.gen(function*() {
      const protocol = yield* makeClientProtocol(ports.api, ports.client, "owned", { readyTimeout: "1 second" })
      const client = yield* RpcClient.make(group).pipe(Effect.provideService(RpcClient.Protocol, protocol))

      return yield* client.Echo({ value: "raced" }).pipe(Effect.exit, Effect.forkScoped)
    }))

    yield* pinged.done
    yield* TestClock.adjust("850 millis")

    for (const { answered, ports } of connections) {
      if (answered) {
        yield* serve(ports.api, ports.server, "owned", group).pipe(
          Effect.provide(group.toLayer({
            Echo: ({ value }) => Effect.succeed(value), Wait: () => Effect.never, Numbers: () => Stream.empty
          })),
          Effect.forkScoped
        )
      }
    }

    yield* TestClock.adjust("150 millis")
    const exits = yield* Effect.forEach(calls, Fiber.join)

    for (const [i, exit] of exits.entries()) {
      if (connections[i]?.answered) expect(exit).toEqual(Exit.succeed("raced"))
      else expect(transportFailure(exit).operation).toBe("ready")
    }

    expect(connections.filter(({ answered }) => !answered).every(({ ports }) => ports.listeners() === 0)).toBe(true)
  }))

  it.effect("finishAccepted lets 256 accepted calls finish after their callers disconnect; plain handlers stop", () => Effect.gen(function*() {
    const run = Effect.fnUntraced(function*(finish: boolean) {
      const ports = pair()
      const started = yield* countdown(256)
      const ended = yield* countdown(256)
      const release = yield* Deferred.make<void>()
      let finished = 0
      let released = 0

      const handlers = {
        Echo: ({ value }: { readonly value: string }) => Effect.gen(function*() {
          yield* Effect.addFinalizer(() => Effect.sync(() => released++))
          yield* started.tick
          yield* Deferred.await(release)
          finished++

          return value
        }).pipe(Effect.ensuring(ended.tick)),
        Wait: () => Effect.never,
        Numbers: () => Stream.empty
      }

      const server = yield* serve(ports.api, ports.server, "owned", group).pipe(
        Effect.provide(group.toLayer(finish ? finishAccepted(handlers) : handlers)), Effect.forkScoped
      )

      const scope = yield* Scope.make()
      const protocol = yield* makeClientProtocol(ports.api, ports.client, "owned").pipe(Effect.provideService(Scope.Scope, scope))
      const client = yield* RpcClient.make(group).pipe(Effect.provideService(RpcClient.Protocol, protocol), Effect.provideService(Scope.Scope, scope))
      yield* Effect.forEach(Array.from({ length: 256 }, (_, i) => String(i)), (value) =>
        client.Echo({ value }).pipe(Effect.forkIn(scope)))
      yield* started.done
      // The caller goes away: its scope disconnects the owned port.
      yield* Scope.close(scope, Exit.void)
      yield* Fiber.join(server)
      const releasedAtDisconnect = released
      yield* Deferred.succeed(release, undefined)
      yield* ended.done

      return { finished, releasedAtDisconnect, released, listeners: ports.listeners() }
    })

    expect(yield* run(true)).toEqual({ finished: 256, releasedAtDisconnect: 0, released: 256, listeners: 0 })
    expect(yield* run(false)).toEqual({ finished: 0, releasedAtDisconnect: 256, released: 256, listeners: 0 })
  }))
})
