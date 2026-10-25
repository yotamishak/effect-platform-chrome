// Pinned Effect 4.0.4 RPC and @effect/vitest are deliberately unstable integrations.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Predicate, Queue, Scope, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcServer from "effect/rpc/RpcServer"
import * as RpcMessage from "effect/rpc/RpcMessage"
import { TestClock } from "effect/testing"
import {
  ChromeRpcError, finishAccepted, layerClient, layerServer, makeClientProtocol, makeServerProtocol, serve
} from "../src/ChromeRpc.js"
import type { Options, ServerOptions } from "../src/ChromeRpc.js"
import { group, pair, Rejected, transportError } from "./support/ChromeRpc.js"
import type { Handlers, Ports } from "./support/ChromeRpc.js"

/** A server on `ports.server` (forked into the test scope) and a client on `ports.client`. */
const connect = Effect.fnUntraced(function*(
  ports: Ports, handlers: Handlers, options: Options = {}, server: ServerOptions = { concurrency: "unbounded" }
) {
  const serverProtocol = yield* makeServerProtocol(ports.api, ports.server, "owned", options)

  yield* RpcServer.make(group, server).pipe(
    Effect.provideService(RpcServer.Protocol, serverProtocol), Effect.provide(handlers), Effect.forkScoped
  )

  const clientProtocol = yield* makeClientProtocol(ports.api, ports.client, "owned", options)
  const client = yield* RpcClient.make(group).pipe(Effect.provideService(RpcClient.Protocol, clientProtocol))

  return { ports, client }
})

const setup = Effect.fnUntraced(function*(options: Options = {}) {
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

  return { ...yield* connect(ports, handlers, options), started, cancelled }
})

const echoOnly = group.toLayer({
  Echo: ({ value }) => Effect.succeed(value), Wait: () => Effect.never, Numbers: () => Stream.empty
})

/** A client protocol whose Ping reaches nobody; resolves `ping` when the first frame is posted. */
const unanswered = Effect.fnUntraced(function*(options: Options = {}, lastError?: chrome.runtime.LastError) {
  const ports = pair(lastError)
  const ping = yield* Deferred.make<void>()
  const frames: Array<string> = []
  ports.client.postMessage = (frame) => {
    if (Predicate.isString(frame)) frames.push(frame)
    Deferred.doneUnsafe(ping, Effect.void)
  }

  const protocol = yield* makeClientProtocol(ports.api, ports.client, "owned", options)
  const client = yield* RpcClient.make(group).pipe(Effect.provideService(RpcClient.Protocol, protocol))

  return { ports, ping, frames, protocol, client }
})

describe("ChromeRpc options", () => {
  it.effect.each([0, -1, 1.5, Infinity, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid transport limits before listeners (%s)", (limit) => Effect.gen(function*() {
    const ports = pair()

    for (const options of [{ capacity: limit }, { maxFrameLength: limit }]) {
      const client = yield* Effect.flip(makeClientProtocol(ports.api, ports.client, "owned", options))
      const server = yield* Effect.flip(makeServerProtocol(ports.api, ports.server, "owned", options))

      for (const error of [client, server]) {
        expect(error.operation).toBe("initialize")
        expect(error.message).toContain("positive safe integers")
      }
    }

    expect(ports.listeners()).toBe(0)
    expect(ports.close).not.toHaveBeenCalled()
  }))

  it.effect.each([0, -1, Number.NaN, "-1 seconds", "0 millis", "-Infinity"] as const)("rejects a readyTimeout that is not a positive duration (%s)", (readyTimeout) => Effect.gen(function*() {
    const ports = pair()
    const error = yield* Effect.flip(makeClientProtocol(ports.api, ports.client, "owned", { readyTimeout }))
    expect(error.operation).toBe("initialize")
    expect(error.message).toContain("readyTimeout")
    expect(ports.listeners()).toBe(0)
    expect(ports.close).not.toHaveBeenCalled()
  }))

  it.effect("an infinite readyTimeout waits for a late server", () => Effect.gen(function*() {
    const { ports, ping, client } = yield* unanswered({ readyTimeout: "Infinity" })
    const call = yield* client.Echo({ value: "late" }).pipe(Effect.forkScoped)
    yield* Deferred.await(ping)
    // A finite deadline of this length would have failed the call long before.
    yield* TestClock.adjust("1 minute")
    expect(call.pollUnsafe()).toBeUndefined()

    // Route the client's frames to the server from now on, then serve.
    ports.client.postMessage = (frame) => {
      for (const listener of ports.serverMessages) listener(frame, ports.server)
    }

    yield* serve(ports.api, ports.server, "owned", group).pipe(Effect.provide(echoOnly), Effect.forkScoped)
    yield* TestClock.adjust("100 millis")
    expect(yield* Fiber.join(call)).toBe("late")
  }))

  it.effect("layerClient and layerServer provide the standard protocols", () => Effect.gen(function*() {
    const ports = pair()
    const scope = yield* Scope.make()

    const server = yield* Layer.buildWithScope(layerServer(ports.api, ports.server, "owned"), scope)
    yield* RpcServer.make(group).pipe(Effect.provideContext(server), Effect.provide(echoOnly), Effect.forkScoped)
    const protocol = yield* Layer.buildWithScope(layerClient(ports.api, ports.client, "owned"), scope)
    const client = yield* RpcClient.make(group).pipe(Effect.provideContext(protocol))
    expect(yield* client.Echo({ value: "layers" })).toBe("layers")
    yield* Scope.close(scope, Exit.void)
    expect(ports.listeners()).toBe(0)
    expect(ports.close).toHaveBeenCalled()

    const invalid = yield* Effect.flip(Layer.build(layerClient(ports.api, ports.client, "owned", { capacity: 0 })))
    expect(invalid.operation).toBe("initialize")
  }))
})

describe("ChromeRpc calls", () => {
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

  it.effect("actual handler defect reaches the client as a defect rather than a declared error", () => Effect.gen(function*() {
    const ports = pair()

    const { client } = yield* connect(ports, group.toLayer({
      Echo: () => Effect.die(new Error("remote defect")), Wait: () => Effect.never, Numbers: () => Stream.empty
    }))

    const exit = yield* Effect.exit(client.Echo({ value: "defect" }))
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)

    if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("remote defect")
  }))

  it.effect.each([false, true])("serve forwards RpcServer options: a defect fails every call unless disableFatalDefects (%s)", (disableFatalDefects) => Effect.gen(function*() {
    const ports = pair()
    const waiting = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()

    const handlers = group.toLayer({
      Echo: () => Effect.die(new Error("remote defect")),
      Wait: () => Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as("survived")),
      Numbers: () => Stream.empty
    })

    yield* serve(ports.api, ports.server, "owned", group, { server: { disableFatalDefects } }).pipe(
      Effect.provide(handlers), Effect.forkScoped
    )

    const protocol = yield* makeClientProtocol(ports.api, ports.client, "owned")
    const client = yield* RpcClient.make(group).pipe(Effect.provideService(RpcClient.Protocol, protocol))
    const call = yield* client.Wait().pipe(Effect.exit, Effect.forkScoped)
    yield* Deferred.await(waiting)
    const exit = yield* Effect.exit(client.Echo({ value: "die" }))
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    yield* Deferred.succeed(release, undefined)
    const waited = yield* Fiber.join(call)

    if (disableFatalDefects) expect(waited).toEqual(Exit.succeed("survived"))
    else expect(Exit.isFailure(waited) && Cause.hasDies(waited.cause)).toBe(true)
    expect(ports.close).not.toHaveBeenCalled()
  }))

  it.effect("a second RpcClient sharing the protocol is refused", () => Effect.gen(function*() {
    const ports = pair()
    yield* serve(ports.api, ports.server, "owned", group).pipe(Effect.provide(echoOnly), Effect.forkScoped)
    const protocol = yield* makeClientProtocol(ports.api, ports.client, "owned")
    const first = yield* RpcClient.make(group).pipe(Effect.provideService(RpcClient.Protocol, protocol))
    expect(yield* first.Echo({ value: "first" })).toBe("first")

    const second = yield* RpcClient.make(group).pipe(Effect.provideService(RpcClient.Protocol, protocol))
    const error = transportError(yield* Effect.flip(second.Echo({ value: "second" })))
    expect(error.operation).toBe("postMessage")
    expect(error.message).toContain("another client")
    expect(yield* first.Echo({ value: "still first" })).toBe("still first")
    expect(ports.close).not.toHaveBeenCalled()
  }))
})

describe("ChromeRpc readiness", () => {
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
      Effect.provideService(RpcServer.Protocol, server), Effect.provide(echoOnly), Effect.forkScoped
    )
    yield* TestClock.adjust("100 millis")
    expect(yield* Fiber.join(call)).toBe("ready")
  }))

  it.effect("dead peer readiness times out without sending or replaying requests", () => Effect.gen(function*() {
    const ports = yield* Effect.scoped(Effect.gen(function*() {
      const { ports, ping, frames, client } = yield* unanswered()
      const call = yield* client.Echo({ value: "unavailable" }).pipe(Effect.timeout("1 second"), Effect.forkScoped)
      yield* Deferred.await(ping)
      yield* TestClock.adjust("1 second")
      const error = yield* Fiber.join(call).pipe(Effect.flip)
      expect(error._tag).toBe("TimeoutError")
      expect(frames.length).toBe(11)
      expect(frames.every((frame) => frame === '{"_tag":"Ping"}')).toBe(true)

      return ports
    }))

    expect(ports.listeners()).toBe(0)
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

    const handled: Array<string> = []
    const server = yield* makeServerProtocol(ports.api, ports.server, "owned")
    yield* RpcServer.make(group).pipe(
      Effect.provideService(RpcServer.Protocol, server),
      Effect.provide(group.toLayer({
        Echo: ({ value }) => Effect.sync(() => {
          handled.push(value)

          return value
        }),
        Wait: () => Effect.never, Numbers: () => Stream.empty
      })), Effect.forkScoped
    )
    const later = yield* client.Echo({ value: "after ready" }).pipe(Effect.forkScoped)
    yield* TestClock.adjust("100 millis")
    expect(yield* Fiber.join(later)).toBe("after ready")
    expect(handled).toEqual(["after ready"])
  }))

  it.effect("readyTimeout fails waiting calls when nothing serves the port", () => Effect.gen(function*() {
    const { ports, ping, client } = yield* unanswered({ readyTimeout: "1 second" })
    const call = yield* client.Echo({ value: "unanswered" }).pipe(Effect.forkScoped)
    yield* Deferred.await(ping)
    yield* TestClock.adjust("999 millis")
    expect(call.pollUnsafe()).toBeUndefined()
    yield* TestClock.adjust("1 millis")
    const error = transportError(yield* Fiber.join(call).pipe(Effect.flip))
    expect(error.operation).toBe("ready")
    expect(error.message).toContain("did not answer within")
    expect(ports.listeners()).toBe(0)
    expect(ports.close).toHaveBeenCalledTimes(1)
  }))

  it.effect("readyTimeout does not affect a peer that answers in time", () => Effect.gen(function*() {
    const { client } = yield* connect(pair(), echoOnly, { readyTimeout: "1 second" })
    expect(yield* client.Echo({ value: "in time" })).toBe("in time")
    yield* TestClock.adjust("2 seconds")
    expect(yield* client.Echo({ value: "still connected" })).toBe("still connected")
  }))

  it.effect.each(["not json", "{}", "null", "[{}]", '{"_tag":"Chunk","requestId":"1","values":[]}'])("malformed frame before readiness fails waiting call (%s)", (frame) => Effect.gen(function*() {
    const { ports, ping, client } = yield* unanswered()
    const call = yield* client.Echo({ value: "must not send" }).pipe(Effect.forkScoped)
    yield* Deferred.await(ping)
    ports.server.postMessage(frame)
    const error = transportError(yield* Fiber.join(call).pipe(Effect.flip))
    expect(error.operation).toBe("onMessage")
    expect(error.message).toBe("Malformed RPC response")
    expect(ports.clientMessages.size + ports.clientDisconnects.size).toBe(0)
    expect(ports.close).toHaveBeenCalledTimes(1)
  }))

  it.effect.each([null, 42, { frame: "not a JSON string" }, new Uint8Array([1, 2, 3])])("rejects native non-string frames before readiness (%#)", (frame) => Effect.gen(function*() {
    const ports = pair()
    const protocol = yield* makeClientProtocol(ports.api, ports.client, "owned")
    ports.server.postMessage(frame)
    const error = transportError(yield* Effect.flip(protocol.send(0, RpcMessage.constEof)))
    expect(error.operation).toBe("onMessage")
    expect(error.message).toContain("Invalid or oversized RPC frame")
    expect(ports.clientMessages.size + ports.clientDisconnects.size).toBe(0)
    expect(ports.close).toHaveBeenCalledTimes(1)
  }))
})

describe("ChromeRpc transport failures", () => {
  it.effect("disconnect fails pending and subsequent calls and interrupts remote work", () => Effect.gen(function*() {
    const { ports, client, started, cancelled } = yield* setup()
    const call = yield* client.Wait().pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    ports.close()
    const pending = transportError(yield* Fiber.join(call).pipe(Effect.flip))
    expect(pending.operation).toBe("onDisconnect")
    expect(pending.message).toBe("Chrome RPC port disconnected")
    yield* Deferred.await(cancelled)
    expect(transportError(yield* Effect.flip(client.Echo({ value: "later" })))).toBe(pending)
    expect(ports.listeners()).toBe(0)
  }))

  it.effect("a disconnect reports the lastError Chrome exposed inside its callback", () => Effect.gen(function*() {
    const lastError = { message: "Could not establish connection. Receiving end does not exist." }
    const { ports, ping, client } = yield* unanswered({}, lastError)
    const call = yield* client.Echo({ value: "nobody" }).pipe(Effect.forkScoped)
    yield* Deferred.await(ping)
    ports.close()
    expect(ports.api.lastError).toBeUndefined()
    const error = transportError(yield* Fiber.join(call).pipe(Effect.flip))
    expect(error.operation).toBe("onDisconnect")
    expect(error.message).toBe(lastError.message)
    expect(error.cause).toBe(lastError)
  }))

  it.effect("native server send failure terminates pending calls and cancels handlers", () => Effect.gen(function*() {
    const { ports, client, started, cancelled } = yield* setup()
    const call = yield* client.Wait().pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    const refusal = new Error("native send failed")
    ports.server.postMessage = () => { throw refusal }

    // The server's send fails, its transport disconnects the port and the client sees that.
    expect(transportError(yield* Effect.flip(client.Echo({ value: "trigger" }))).operation).toBe("onDisconnect")
    expect(Exit.isFailure(yield* Fiber.await(call))).toBe(true)
    yield* Deferred.await(cancelled)
    expect(ports.listeners()).toBe(0)
    expect(ports.close).toHaveBeenCalledTimes(2)
  }))

  it.effect("native client send failure is a postMessage error that terminates the transport", () => Effect.gen(function*() {
    const { ports, client, started, cancelled } = yield* setup()
    const call = yield* client.Wait().pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    const refusal = new Error("Message length exceeded maximum allowed length.")
    ports.client.postMessage = () => { throw refusal }

    const error = transportError(yield* Effect.flip(client.Echo({ value: "trigger" })))
    expect(error.operation).toBe("postMessage")
    expect(error.cause).toBe(refusal)
    expect(transportError(yield* Fiber.join(call).pipe(Effect.flip))).toBe(error)
    yield* Deferred.await(cancelled)
    expect(ports.listeners()).toBe(0)
  }))

  it.effect("an oversized outbound request fails only itself, before reaching Chrome", () => Effect.gen(function*() {
    const ports = pair()
    let handled = 0

    const { client } = yield* connect(ports, group.toLayer({
      Echo: ({ value }) => Effect.sync(() => {
        handled++

        return value
      }),
      Wait: () => Effect.never, Numbers: () => Stream.empty
    }), { maxFrameLength: 200 })

    const error = transportError(yield* Effect.flip(client.Echo({ value: "x".repeat(201) })))
    expect(error.operation).toBe("postMessage")
    expect(error.message).toContain("oversized")
    expect(handled).toBe(0)
    expect(yield* client.Echo({ value: "fits" })).toBe("fits")
    expect(handled).toBe(1)
    expect(ports.close).not.toHaveBeenCalled()
  }))

  it.effect("an unencodable response fails only its call; an unencodable defect ends the connection", () => Effect.gen(function*() {
    const ports = pair()
    const protocol = yield* makeServerProtocol(ports.api, ports.server, "owned")
    // JSON cannot encode a bigint; Effect's codecs never produce one, so this is a hand-made frame.
    const response = RpcMessage.ResponseExitDieEncoded({ requestId: RpcMessage.RequestId("0"), encodedDefect: 1n })
    const exit = yield* Effect.exit(protocol.send(0, response))
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)

    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause)
      expect(error).toBeInstanceOf(ChromeRpcError)
      expect(error).toMatchObject({ operation: "postMessage", message: "RPC frame could not be encoded" })
    }

    expect(ports.close).not.toHaveBeenCalled()
    yield* protocol.send(0, RpcMessage.ResponseDefectEncoded(1n))
    yield* protocol.closed
    expect(ports.close).toHaveBeenCalledTimes(1)
    expect(ports.server.postMessage).not.toHaveBeenCalled()
    expect(ports.listeners()).toBe(0)
  }))

  it.effect("an oversized response fails only its call with a defect", () => Effect.gen(function*() {
    const ports = pair()

    const { client } = yield* connect(ports, group.toLayer({
      Echo: ({ value }) => Effect.succeed(value.repeat(400)), Wait: () => Effect.never,
      Numbers: () => Stream.make(1, 2)
    }), { maxFrameLength: 300 })

    const exit = yield* Effect.exit(client.Echo({ value: "x" }))
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)

    if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("oversized outbound RPC frame")
    expect(yield* client.Echo({ value: "" })).toBe("")
    expect(yield* Stream.runCollect(client.Numbers())).toEqual([1, 2])
    expect(ports.close).not.toHaveBeenCalled()
  }))

  it.effect("an oversized fatal defect terminates the connection instead of leaving calls unanswered", () => Effect.gen(function*() {
    const ports = pair()

    const { client } = yield* connect(ports, group.toLayer({
      Echo: () => Effect.die("d".repeat(400)), Wait: () => Effect.never, Numbers: () => Stream.empty
    }), { maxFrameLength: 300 })

    const error = transportError(yield* Effect.flip(client.Echo({ value: "die" })))
    expect(error.operation).toBe("onDisconnect")
    expect(ports.listeners()).toBe(0)
    // Both owned ends disconnect.
    expect(ports.close).toHaveBeenCalledTimes(2)
  }))

  it.effect.each(["{}", "not json", "x".repeat(1024 * 1024 + 1)])("invalid response fails pending work (%#)", (frame) => Effect.gen(function*() {
    const { ports, client, started, cancelled } = yield* setup()
    const call = yield* client.Wait().pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    ports.server.postMessage(frame)
    expect(transportError(yield* Fiber.join(call).pipe(Effect.flip)).operation).toBe("onMessage")
    yield* Deferred.await(cancelled)
    expect(ports.close).toHaveBeenCalled()
  }))

  it.effect("overflow fails fast without silently dropping RPC frames", () => Effect.gen(function*() {
    const ports = pair()
    const protocol = yield* makeClientProtocol(ports.api, ports.client, "owned", { capacity: 1 })
    ports.server.postMessage('{"_tag":"Pong"}')
    ports.server.postMessage('{"_tag":"Pong"}')
    const error = transportError(yield* Effect.flip(protocol.send(0, RpcMessage.constEof)))
    expect(error.operation).toBe("onMessage")
    expect(error.message).toContain("overflow")
    expect(ports.close).toHaveBeenCalled()
  }))

  it.effect("overflow also fails already pending calls and cancels server work", () => Effect.gen(function*() {
    const { ports, client, started, cancelled } = yield* setup()
    const call = yield* client.Wait().pipe(Effect.forkScoped)
    yield* Deferred.await(started)

    for (let i = 0; i < 257; i++) ports.server.postMessage('{"_tag":"Pong"}')

    expect(transportError(yield* Fiber.join(call).pipe(Effect.flip)).message).toContain("overflow")
    yield* Deferred.await(cancelled)
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
    const disconnected = yield* Deferred.make<number>()
    yield* protocol.run(() => Effect.void).pipe(Effect.forkScoped)
    yield* Queue.take(protocol.disconnects).pipe(Effect.flatMap((id) => Deferred.succeed(disconnected, id)), Effect.forkScoped)
    ports.client.postMessage(frame)
    yield* protocol.closed
    expect(yield* Deferred.await(disconnected)).toBe(0)
    expect(yield* protocol.clientIds).toEqual(new Set())
    expect(ports.close).toHaveBeenCalledTimes(1)
    expect(ports.serverMessages.size + ports.serverDisconnects.size).toBe(0)
  }))

  it.effect("disconnect fails a backpressured stream with the transport error, not an interruption", () => Effect.gen(function*() {
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

    const received: Array<number> = []

    const stream = yield* client.Numbers(undefined, { streamBufferSize: 1 }).pipe(
      Stream.runForEach((value) => Effect.sync(() => received.push(value)).pipe(
        Effect.andThen(Deferred.succeed(consumed, undefined)), Effect.andThen(Deferred.await(release))
      )),
      Effect.forkScoped
    )

    yield* Deferred.await(consumed)
    yield* Deferred.await(thirdChunk)
    // An acknowledged one-item buffer admits only one queued item and one blocked offer.
    expect(chunks).toBe(3)
    ports.close()
    const pending = transportError(yield* Fiber.join(call).pipe(Effect.flip))
    expect(pending.operation).toBe("onDisconnect")
    yield* Deferred.await(streamClosed)
    yield* Deferred.succeed(release, undefined)
    const streamError = yield* Fiber.join(stream).pipe(Effect.flip)
    expect(transportError(streamError)).toBe(pending)
    // The consumed item and the queued one; the blocked offer is abandoned.
    expect(received).toEqual([0, 1])
    expect(chunks).toBe(3)
    expect(ports.listeners()).toBe(0)
  }))
})

describe("ChromeRpc lifecycle", () => {
  it.effect.each(["onMessage", "onDisconnect"] as const)("partial %s registration failure cleans up immediately", (eventName) => Effect.gen(function*() {
    const ports = pair()
    const refusal = new Error("registration failed after insert")

    if (eventName === "onMessage") {
      const add = ports.client.onMessage.addListener.bind(ports.client.onMessage)
      ports.client.onMessage.addListener = (listener) => {
        add(listener)
        throw refusal
      }
    } else {
      const add = ports.client.onDisconnect.addListener.bind(ports.client.onDisconnect)
      ports.client.onDisconnect.addListener = (listener) => {
        add(listener)
        throw refusal
      }
    }

    const error = yield* Effect.flip(makeClientProtocol(ports.api, ports.client, "owned"))
    expect(error.operation).toBe("addListener")
    expect(error.message).toContain("registration")
    expect(error.cause).toBe(refusal)
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
    expect(error.operation).toBe("onDisconnect")
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
    ports.client.disconnect = vi.fn(() => {
      ports.close()
      throw new Error("disconnect")
    })
    yield* Effect.scoped(makeClientProtocol(ports.api, ports.client, "owned"))
    expect(messageRemoval).toHaveBeenCalledTimes(1)
    expect(disconnectRemoval).toHaveBeenCalledTimes(1)
    expect(ports.client.disconnect).toHaveBeenCalledTimes(1)
    expect(ports.clientMessages.size + ports.clientDisconnects.size).toBe(0)
  }))

  it.effect("scope release removes every listener and disconnects owned ports", () => Effect.gen(function*() {
    const ports = yield* Effect.scoped(Effect.gen(function*() {
      const { ports, client } = yield* setup()
      yield* client.Echo({ value: "ready" })

      return ports
    }))

    expect(ports.listeners()).toBe(0)
    expect(ports.close).toHaveBeenCalledTimes(2)
  }))

  it.effect("a released client protocol reports the scope closing", () => Effect.gen(function*() {
    const ports = pair()
    const protocol = yield* Effect.scoped(makeClientProtocol(ports.api, ports.client, "owned"))
    const error = transportError(yield* Effect.flip(protocol.send(0, RpcMessage.constEof)))
    expect(error.operation).toBe("disconnect")
    expect(error.message).toBe("Chrome RPC scope closed")
    expect(ports.close).toHaveBeenCalledTimes(1)
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

  it.effect("serve completes and releases its connection scope on native disconnect", () => Effect.gen(function*() {
    const ports = pair()
    const server = yield* serve(ports.api, ports.server, "owned", group).pipe(Effect.provide(echoOnly), Effect.forkScoped)
    const protocol = yield* makeClientProtocol(ports.api, ports.client, "owned")
    const client = yield* RpcClient.make(group).pipe(Effect.provideService(RpcClient.Protocol, protocol))

    yield* client.Echo({ value: "ready" })
    ports.close()
    yield* Fiber.join(server)
    expect(ports.serverMessages.size + ports.serverDisconnects.size).toBe(0)
  }))

  it.effect("a client Eof ends the server connection once its calls finish", () => Effect.gen(function*() {
    const ports = pair()
    const protocol = yield* makeServerProtocol(ports.api, ports.server, "owned")
    yield* RpcServer.make(group).pipe(
      Effect.provideService(RpcServer.Protocol, protocol), Effect.provide(echoOnly), Effect.forkScoped
    )
    ports.client.postMessage('{"_tag":"Ping"}')
    ports.client.postMessage('{"_tag":"Eof"}')
    yield* protocol.closed
    expect(ports.server.postMessage).toHaveBeenCalledWith('{"_tag":"Pong"}')
    expect(ports.close).toHaveBeenCalledTimes(1)
    expect(ports.serverMessages.size + ports.serverDisconnects.size).toBe(0)
  }))
})

describe("ChromeRpc finishAccepted", () => {
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

  it.effect("work wrapped by Rpc.fork also finishes after the caller disconnects", () => Effect.gen(function*() {
    const ports = pair()
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const finished = yield* Deferred.make<boolean>()

    const handlers = finishAccepted({
      Echo: ({ value }: { readonly value: string }) => Effect.succeed(value),
      Wait: () => Rpc.fork(Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as("done"),
        Effect.onExit((exit) => Deferred.succeed(finished, Exit.isSuccess(exit)))
      )),
      Numbers: () => Stream.empty
    })

    const server = yield* serve(ports.api, ports.server, "owned", group, { server: { concurrency: 1 } }).pipe(
      Effect.provide(group.toLayer(handlers)), Effect.forkScoped
    )

    const protocol = yield* makeClientProtocol(ports.api, ports.client, "owned")
    const client = yield* RpcClient.make(group).pipe(Effect.provideService(RpcClient.Protocol, protocol))
    yield* client.Wait().pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    // Rpc.fork still bypasses the concurrency limit of one.
    expect(yield* client.Echo({ value: "beside" })).toBe("beside")
    ports.close()
    yield* Fiber.join(server)
    yield* Deferred.succeed(release, undefined)
    expect(yield* Deferred.await(finished)).toBe(true)
  }))

  it.effect("finished work keeps its scoped resources until it completes", () => Effect.gen(function*() {
    const ports = pair()
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const released = yield* Deferred.make<void>()
    const events: Array<string> = []

    const handlers = finishAccepted({
      Echo: ({ value }: { readonly value: string }) => Effect.succeed(value),
      Wait: () => Effect.gen(function*() {
        yield* Effect.addFinalizer(() => Effect.sync(() => events.push("released")).pipe(
          Effect.andThen(Deferred.succeed(released, undefined))
        ))
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
        events.push("finished")

        return "done"
      }),
      Numbers: () => Stream.empty
    })

    const server = yield* serve(ports.api, ports.server, "owned", group).pipe(
      Effect.provide(group.toLayer(handlers)), Effect.forkScoped
    )

    const protocol = yield* makeClientProtocol(ports.api, ports.client, "owned")
    const client = yield* RpcClient.make(group).pipe(Effect.provideService(RpcClient.Protocol, protocol))
    yield* client.Wait().pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    ports.close()
    yield* Fiber.join(server)
    expect(events).toEqual([])
    yield* Deferred.succeed(release, undefined)
    yield* Deferred.await(released)
    expect(events).toEqual(["finished", "released"])
  }))

  it.effect("connected callers still get typed results and streams through finishAccepted", () => Effect.gen(function*() {
    const ports = pair()

    const handlers = finishAccepted({
      Echo: ({ value }: { readonly value: string }) => value === "reject"
        ? Effect.fail(new Rejected({ message: "no" }))
        : Effect.succeed(value),
      Wait: () => Effect.succeed("waited"),
      Numbers: () => Effect.gen(function*() {
        const queue = yield* Queue.make<number, Cause.Done>()
        yield* Queue.offerAll(queue, [1, 2, 3])
        yield* Queue.end(queue)

        return queue
      })
    })

    const { client } = yield* connect(ports, group.toLayer(handlers))
    expect(yield* client.Echo({ value: "ok" })).toBe("ok")
    expect(yield* Effect.flip(client.Echo({ value: "reject" }))).toEqual(new Rejected({ message: "no" }))
    expect(yield* client.Wait()).toBe("waited")
    expect(yield* Stream.runCollect(client.Numbers())).toEqual([1, 2, 3])
  }))

  it.effect("leaves streaming results untouched and keeps wrapper options", () => Effect.gen(function*() {
    const stream = Stream.make(1)
    const queue = Effect.succeed("queue")
    const effect = Effect.succeed("effect")
    const forked = Rpc.wrap({ fork: true, uninterruptible: true })(effect)

    // Effect RPC passes each handler its payload and request metadata naming the procedure.
    interface Metadata { readonly rpc: Rpc.AnyWithProps }

    const wrapped = finishAccepted({
      Stream: (_payload: void, _options: Metadata) => stream,
      Queue: (_payload: void, _options: Metadata) => queue,
      Effect: (_payload: void, _options: Metadata) => effect,
      Forked: (_payload: void, _options: Metadata) => forked
    })

    const numbers = group.requests.get("Numbers")
    const wait = group.requests.get("Wait")

    if (numbers === undefined || wait === undefined) return yield* Effect.die(new Error("group lost a procedure"))

    expect(wrapped.Stream(undefined, { rpc: numbers })).toBe(stream)
    expect(wrapped.Queue(undefined, { rpc: numbers })).toBe(queue)

    const detached = wrapped.Effect(undefined, { rpc: wait })
    expect(detached).not.toBe(effect)
    expect(yield* detached).toBe("effect")

    const wrapper = wrapped.Forked(undefined, { rpc: wait })
    expect(Rpc.isWrapper(wrapper)).toBe(true)
    expect(wrapper.fork && wrapper.uninterruptible).toBe(true)
    expect(wrapper.value).not.toBe(effect)
    expect(yield* wrapper.value).toBe("effect")
  }))
})
