// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Cause, Deferred, Effect, Exit, Fiber, Option, Scope, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChromePortError, make } from "../../src/ChromePort.js"
import type { ChromePortApi, NativePort } from "../../src/ChromePort.js"
import { makeEvent } from "../../src/testing/Event.js"
import { makePortPair } from "../../src/testing/Port.js"
import { burst, expectOperations, labelled, newest } from "./support.js"

/** Runs a native callback with `lastError` set to `error` only for its duration. */
type Reporting = (error: string | undefined, run: () => void) => void

interface Hooks {
  /** Every `failPostEvery`-th `postMessage` throws (none when 0). */
  readonly failPostEvery?: number
  /** Runs after Chrome inserted the message listener, inside acquisition. */
  readonly afterAddMessage?: (() => void) | undefined
  /** Runs before Chrome removes the message listener, inside release. */
  readonly beforeRemoveMessage?: (() => void) | undefined
}

/** A native port whose listeners, posts and disconnect calls are counted. */
const nativePort = (reporting: Reporting, name: string, hooks: Hooks = {}) => {
  const message = makeEvent<[message: number, port: NativePort]>()
  const disconnect = makeEvent<[port: NativePort]>()
  const failures = new Map<Error, string>()
  const disconnectFailures: Array<Error> = []
  let posts = 0
  let disconnects = 0

  const port: NativePort = {
    name,
    onMessage: {
      ...message.api,
      addListener: (listener) => {
        message.api.addListener(listener)
        hooks.afterAddMessage?.()
      },
      removeListener: (listener) => {
        hooks.beforeRemoveMessage?.()
        message.api.removeListener(listener)
      }
    },
    onDisconnect: disconnect.api,
    postMessage: () => {
      const post = posts++
      const every = hooks.failPostEvery ?? 0

      if (every > 0 && post % every === 0) {
        const cause = new Error(`${name} post ${post} failed`)
        failures.set(cause, "send")

        throw cause
      }
    },
    disconnect: () => {
      disconnects++
      const failure = disconnectFailures.shift()

      if (failure !== undefined) {
        failures.set(failure, "disconnect")

        throw failure
      }
    }
  }

  return {
    port,
    failures,
    message: message.controls,
    disconnect: disconnect.controls,
    emit: (value: number) => message.controls.emit(value, port),
    get listeners() { return message.controls.listenerCount + disconnect.controls.listenerCount },
    get disconnects() { return disconnects },
    get posts() { return posts },
    /** The next native `disconnect()` throws. */
    failDisconnect: (cause: Error) => { disconnectFailures.push(cause) },
    /** Chrome reporting the disconnect, with `lastError` set only during the callback. */
    hostDisconnect: (error?: string) => reporting(error, () => disconnect.controls.emit(port))
  }
}

type Native = ReturnType<typeof nativePort>

const runtime = (connectFailEvery = 0) => {
  let lastError: chrome.runtime.LastError | undefined
  let connects = 0
  const failures = new Map<Error, string>()
  const opened: Array<Native> = []

  const reporting: Reporting = (error, run) => {
    lastError = error === undefined ? undefined : { message: error }

    try { run() } finally { lastError = undefined }
  }

  const open = (operation: "connect" | "connectNative", name: string) => {
    const connect = connects++

    if (connectFailEvery > 0 && connect % connectFailEvery === 0) {
      const cause = new Error(`${operation} ${connect} failed`)
      failures.set(cause, operation)

      throw cause
    }

    const native = nativePort(reporting, `${name}-${connect}`)
    opened.push(native)

    return native.port
  }

  const api: ChromePortApi = {
    get lastError() { return lastError },
    connect: () => open("connect", "connected"),
    connectNative: (application) => open("connectNative", application)
  }

  return {
    api,
    failures,
    opened,
    native: (name: string, hooks?: Hooks) => nativePort(reporting, name, hooks)
  }
}

/** A gate that opens once `size` arrivals have been counted. */
const countdown = (size: number) => Effect.map(Deferred.make<void>(), (deferred) => {
  let count = 0

  return {
    arrive: Effect.suspend(() => ++count === size ? Deferred.succeed(deferred, undefined) : Effect.succeed(false)),
    await: Deferred.await(deferred)
  }
})

/** A small deterministic linear congruential generator, instead of Math.random. */
const seeded = (seed: number) => {
  let state = seed >>> 0

  return (bound: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0

    return state % bound
  }
}

const isInterrupted = <A, E>(exit: Exit.Exit<A, E>) => Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)

describe("ChromePort stress", () => {
  it.effect.each(["connect", "connectNative", "owned", "borrowed"] as const)("keeps the newest 64 of a 4,096-message burst on a %s port, drains them on a clean disconnect and removes both listeners", (kind) => Effect.gen(function*() {
    const host = runtime()
    const service = make(host.api)
    const adopted = host.native("burst")

    const received = yield* Effect.scoped(Effect.gen(function*() {
      const acquisitions = {
        connect: () => service.connect({ name: "burst" }),
        connectNative: () => service.connectNative("com.example.burst"),
        owned: () => service.adopt(adopted.port, "owned"),
        borrowed: () => service.adopt(adopted.port, "borrowed")
      }

      const port = yield* acquisitions[kind]()

      const native = kind === "owned" || kind === "borrowed" ? adopted : host.opened[0]!
      expect(native.listeners).toBe(2)

      for (let index = 0; index < burst; index++) native.emit(index)

      native.hostDisconnect()
      // A message after the disconnect never reaches the stream.
      native.emit(burst)

      return yield* Stream.runCollect(port.messages)
    }))

    expect(received).toEqual(newest(burst))

    for (const native of [adopted, ...host.opened]) {
      expect(native.listeners).toBe(0)
      // A port Chrome already disconnected is never disconnected again.
      expect(native.disconnects).toBe(0)
    }
  }))

  it.effect("drains the newest 64 of a 4,096-message burst, then fails with the lastError Chrome reported", () => Effect.gen(function*() {
    const host = runtime()
    const seen: Array<unknown> = []

    const failure = yield* Effect.scoped(Effect.gen(function*() {
      const port = yield* make(host.api).connect()
      const native = host.opened[0]!

      for (let index = 0; index < burst; index++) native.emit(index)

      native.hostDisconnect("Could not establish connection. Receiving end does not exist.")
      expect(host.api.lastError).toBeUndefined()

      return yield* Effect.flip(port.messages.pipe(
        Stream.tap((value) => Effect.sync(() => { seen.push(value) })),
        Stream.runDrain
      ))
    }))

    expect(seen).toEqual(newest(burst))
    expect(failure).toBeInstanceOf(ChromePortError)
    expect(failure).toMatchObject({ operation: "disconnect", message: "Could not establish connection. Receiving end does not exist." })
    expect(host.opened[0]!.listeners).toBe(0)
    expect(host.opened[0]!.disconnects).toBe(0)
  }))

  it.effect("runs 512 concurrent adopt/disconnect cycles, in four endings, without leaking a listener", () => Effect.gen(function*() {
    const host = runtime()
    const service = make(host.api)
    const natives = Array.from({ length: 512 }, (_, index) => host.native(`port-${index}`))
    const adopted = yield* countdown(natives.length)
    const go = yield* Deferred.make<void>()

    const cycle = (index: number) => Effect.scoped(Effect.gen(function*() {
      const native = natives[index]!
      const port = yield* service.adopt(native.port, index % 2 === 0 ? "owned" : "borrowed")

      yield* adopted.arrive

      // Every port is adopted before any of them ends.
      yield* Deferred.await(go)
      yield* port.send(index)

      for (let message = 0; message < 8; message++) native.emit(message)

      const ending = Math.floor(index / 2) % 4

      if (ending === 0) {
        yield* port.disconnect
      } else if (ending === 1) {
        native.hostDisconnect()
        expect(yield* Stream.runCollect(port.messages)).toEqual(newest(8, 8))
      } else if (ending === 2) {
        native.hostDisconnect("host closed")
        expect((yield* Effect.flip(Stream.runDrain(port.messages))).operation).toBe("disconnect")
      }
      // ending 3: the scope closes with the port still open.
    }))

    const fiber = yield* Effect.forkChild(Effect.forEach(natives, (_, index) => cycle(index), { concurrency: "unbounded", discard: true }))

    yield* adopted.await
    expect(natives.reduce((total, native) => total + native.listeners, 0)).toBe(1024)
    yield* Deferred.succeed(go, undefined)
    yield* Fiber.join(fiber)

    for (const [index, native] of natives.entries()) {
      expect(native.listeners).toBe(0)
      expect(native.posts).toBe(1)
      const ending = Math.floor(index / 2) % 4
      const owned = index % 2 === 0
      // Owned ports are disconnected exactly once, unless Chrome already reported the disconnect.
      expect(native.disconnects).toBe(owned && (ending === 0 || ending === 3) ? 1 : 0)
    }
  }))

  it.effect("churns 4 rounds of 512 acquisitions interrupted at every stage, ending with zero listeners", () => Effect.gen(function*() {
    // Stages: 0 before acquiring; 1 mid-acquire (interrupt delivered inside Chrome's
    // addListener); 2 acquired, not consuming; 3 consuming, blocked after 8 messages;
    // 4 mid-release (interrupt delivered inside Chrome's removeListener).
    const stages = 5
    const size = 512

    for (let round = 0; round < 4; round++) {
      const host = runtime()
      const service = make(host.api)
      const fibers: Array<Fiber.Fiber<void, ChromePortError>> = []
      const natives: Array<Native> = []
      const go = yield* Deferred.make<void>()
      const never = yield* Deferred.make<void>()
      // Stages 1 and 4 finish on their own; the rest park at their stage.
      const parked = yield* countdown(Array.from({ length: size }, (_, index) => index % stages).filter((stage) => stage !== 1 && stage !== 4).length)

      for (let index = 0; index < size; index++) {
        const stage = index % stages
        const ownership = (index + round) % 2 === 0 ? "owned" : "borrowed"

        const native = host.native(`round-${round}-${index}`, {
          // The unsafe interrupts model one arriving while Chrome runs
          // a synchronous native call, which no Effect-level operation can express.
          afterAddMessage: stage === 1 ? () => { fibers[index]!.interruptUnsafe() } : undefined,
          beforeRemoveMessage: stage === 4 ? () => { fibers[index]!.interruptUnsafe() } : undefined
        })

        natives.push(native)

        fibers.push(yield* Effect.forkChild(Effect.scoped(Effect.gen(function*() {
          yield* Deferred.await(go)

          if (stage === 0) {
            yield* parked.arrive
            yield* Deferred.await(never)
          }

          const port = yield* service.adopt(native.port, ownership)

          if (stage === 2) {
            yield* parked.arrive
            yield* Deferred.await(never)
          } else if (stage === 3) {
            for (let message = 0; message < 8; message++) native.emit(message)

            yield* port.messages.pipe(
              Stream.take(8),
              Stream.runDrain
            )
            yield* parked.arrive
            yield* Stream.runDrain(port.messages)
          }
        }))))
      }

      yield* Deferred.succeed(go, undefined)
      yield* parked.await
      // Stages 2 and 3 hold their listeners; stage 1 was interrupted right after acquiring.
      expect(natives.filter((_, index) => index % stages === 2 || index % stages === 3).every((native) => native.listeners === 2)).toBe(true)

      for (const fiber of fibers) yield* Fiber.interrupt(fiber)

      for (const [index, fiber] of fibers.entries()) {
        const exit = yield* Fiber.await(fiber)
        const stage = index % stages
        const native = natives[index]!
        const owned = (index + round) % 2 === 0

        expect(stage === 4 ? Exit.isSuccess(exit) || isInterrupted(exit) : isInterrupted(exit)).toBe(true)
        expect(native.listeners).toBe(0)
        expect(native.disconnects).toBe(owned && stage !== 0 ? 1 : 0)
        expect(native.message.listenerCount).toBe(0)
      }
    }
  }))

  it.effect("runs 1,024 concurrent connects, native connects, adoptions, sends and disconnects with interleaved throws, keeping operation names", () => Effect.gen(function*() {
    const host = runtime(3)
    const service = make(host.api)
    const shared = host.native("shared", { failPostEvery: 2 })
    const scope = yield* Scope.make()
    const port = yield* service.adopt(shared.port, "borrowed").pipe(Scope.provide(scope))
    const injected = new Map<Error, string>()
    const adoptees: Array<Native> = []
    const disconnecting: Array<Native> = []

    const calls = Array.from({ length: 1280 }, (_, index) => {
      switch (index % 5) {
        case 0:
          return labelled("connect", Effect.scoped(Effect.flatMap(service.connect({ name: `stress-${index}` }), (connected) => connected.send(index))))
        case 1:
          return labelled("connectNative", Effect.scoped(Effect.flatMap(service.connectNative(`com.example.${index}`), (connected) => connected.send(index))))
        case 2: {
          const native = host.native(`adopted-${index}`)
          adoptees.push(native)

          // Every other adoption fails to register its message listener.
          if (index % 10 === 2) {
            const cause = new Error(`adopt ${index} failed`)
            native.message.failNext("addListener", cause)
            injected.set(cause, "adopt")
          }

          return labelled("adopt", Effect.scoped(service.adopt(native.port, "owned")))
        }

        case 3:
          return labelled("send", port.send(index))
        default: {
          const native = host.native(`disconnecting-${index}`)
          disconnecting.push(native)

          if (index % 10 === 4) native.failDisconnect(new Error(`disconnect ${index} failed`))

          return labelled("disconnect", Effect.scoped(Effect.flatMap(service.adopt(native.port, "owned"), (adopted) => adopted.disconnect)))
        }
      }
    })

    const results = yield* Effect.all(calls, { concurrency: "unbounded" })
    yield* Scope.close(scope, Exit.void)

    const disconnectFailures = disconnecting.flatMap((native) => [...native.failures])
    expectOperations(results, new Map([...host.failures, ...shared.failures, ...injected, ...disconnectFailures]), ChromePortError)
    expect(host.failures.size).toBe(Math.ceil(512 / 3))
    expect(shared.failures.size).toBe(128)
    expect(disconnectFailures).toHaveLength(128)
    expect(shared.listeners).toBe(0)

    for (const native of [...host.opened, ...adoptees, ...disconnecting]) {
      expect(native.listeners).toBe(0)
      // Owned ports are disconnected exactly once, including when that attempt throws.
      expect(native.disconnects).toBe(1)
    }

    expect(host.opened).toHaveLength(512 - host.failures.size)
  }))

  it.effect("races 512 ports through concurrent explicit disconnects, host disconnects, sends and scope closes", () => Effect.gen(function*() {
    const host = runtime()
    const service = make(host.api)
    const random = seeded(0x5eed)
    const natives = Array.from({ length: 512 }, (_, index) => host.native(`race-${index}`))
    const go = yield* Deferred.make<void>()
    const open = yield* countdown(natives.length)
    const hostErrors = new Set<number>()

    const race = (index: number) => Effect.scoped(Effect.gen(function*() {
      const native = natives[index]!
      const port = yield* service.adopt(native.port, "owned")
      yield* open.arrive
      yield* Deferred.await(go)

      const hostError = random(3) === 0

      if (hostError) hostErrors.add(index)

      // A random interleaving of four contenders for the same port.
      const contenders = [
        Effect.exit(port.disconnect),
        Effect.exit(port.disconnect),
        Effect.exit(port.send(index)),
        Effect.sync(() => {
          native.hostDisconnect(hostError ? "host failed" : undefined)

          return Exit.void
        })
      ]

      for (let swap = contenders.length - 1; swap > 0; swap--) {
        const other = random(swap + 1)
        const current = contenders[swap]!
        contenders[swap] = contenders[other]!
        contenders[other] = current
      }

      const exits = yield* Effect.all(contenders, { concurrency: "unbounded" })

      for (const exit of exits) {
        if (Exit.isFailure(exit)) {
          const failure = Cause.findErrorOption(exit.cause)
          expect(Option.isSome(failure) && ["send", "disconnect"].includes(failure.value.operation)).toBe(true)
        }
      }

      return yield* Stream.runCollect(port.messages).pipe(Effect.exit)
    }))

    const fiber = yield* Effect.forkChild(Effect.forEach(natives, (_, index) => race(index), { concurrency: "unbounded" }))
    yield* open.await
    yield* Deferred.succeed(go, undefined)
    const streams = yield* Fiber.join(fiber)

    for (const [index, native] of natives.entries()) {
      expect(native.listeners).toBe(0)
      // At most once, and never after Chrome reported the disconnect first.
      expect(native.disconnects).toBeLessThanOrEqual(1)
      expect(native.posts).toBeLessThanOrEqual(1)
      const stream = streams[index]!

      if (Exit.isFailure(stream)) {
        expect(hostErrors.has(index)).toBe(true)
        expect(Option.getOrThrow(Cause.findErrorOption(stream.cause))).toMatchObject({ operation: "disconnect", message: "host failed" })
      } else {
        expect(stream.value).toEqual([])
      }
    }

    expect(natives.reduce((total, native) => total + native.disconnects, 0)).toBeGreaterThan(0)
  }))

  it.effect("lets 1,024 concurrent explicit disconnects of one owned port attempt the native disconnect once", () => Effect.gen(function*() {
    const host = runtime()
    const native = host.native("shared")
    const cause = new Error("disconnect failed once")
    native.failDisconnect(cause)

    const exits = yield* Effect.scoped(Effect.gen(function*() {
      const port = yield* make(host.api).adopt(native.port, "owned")

      return yield* Effect.all(Array.from({ length: 1024 }, () => Effect.exit(port.disconnect)), { concurrency: "unbounded" })
    }))

    const failures = exits.filter(Exit.isFailure)
    expect(failures).toHaveLength(1)
    expect(Option.getOrThrow(Cause.findErrorOption(failures[0]!.cause))).toMatchObject({ operation: "disconnect", cause })
    expect(native.disconnects).toBe(1)
    expect(native.listeners).toBe(0)
  }))

  it.effect("delivers 4,096 messages to 8 competing consumers exactly once, in order per consumer", () => Effect.gen(function*() {
    const host = runtime()
    const native = host.native("competing")
    const received: Array<Array<number>> = Array.from({ length: 8 }, () => [])
    let total = 0
    const waiting: Array<{ readonly at: number; readonly deferred: Deferred.Deferred<void> }> = []

    const reached = (count: number) => Effect.suspend(() => {
      if (total >= count) return Effect.void
      const deferred = Deferred.makeUnsafe<void>()
      waiting.push({ at: count, deferred })

      return Deferred.await(deferred)
    })

    yield* Effect.scoped(Effect.gen(function*() {
      const port = yield* make(host.api).adopt(native.port, "borrowed")

      const consumers = yield* Effect.forEach(received, (into) => Effect.forkScoped(Stream.runForEach(port.messages, (value) => Effect.sync(() => {
        // SAFETY: this test's native port only ever emits numbers.
        into.push(value as number)
        total++

        for (const gate of waiting.splice(0)) {
          if (total >= gate.at) Deferred.doneUnsafe(gate.deferred, Effect.void)
          else waiting.push(gate)
        }
      }))))

      // Emit in windows the buffer can hold, waiting until each window is consumed.
      for (let window = 0; window < burst / 64; window++) {
        for (let index = 0; index < 64; index++) native.emit(window * 64 + index)

        yield* reached((window + 1) * 64)
      }

      native.hostDisconnect()

      for (const consumer of consumers) yield* Fiber.join(consumer)
    }))

    const all = received.flat().sort((left, right) => left - right)
    expect(all).toEqual(Array.from({ length: burst }, (_, index) => index))

    for (const values of received) {
      expect(values).toEqual([...values].sort((left, right) => left - right))
    }

    // The consumers really compete: the messages are split between them.
    expect(received.filter((values) => values.length > 0).length).toBeGreaterThan(1)

    expect(native.listeners).toBe(0)
  }))

  it.effect("moves 8,192 messages across 512 fixture pairs and releases every endpoint", () => Effect.gen(function*() {
    const pairs = Array.from({ length: 512 }, (_, index) => makePortPair(`pair-${index}`, { sender: { id: "extension", frameId: index } }))

    const results = yield* Effect.forEach(pairs, (pair, index) => Effect.scoped(Effect.gen(function*() {
      const service = make(pair.left.api)
      const client = yield* service.connect({ name: "ignored by the fixture" })
      const server = yield* make(pair.right.api).adopt(pair.right.port, "borrowed")
      expect(Option.map(server.sender, (sender) => sender.frameId)).toEqual(Option.some(index))

      for (let message = 0; message < 8; message++) {
        yield* client.send({ index, message })
        yield* server.send({ index, reply: message })
      }

      pair.controls.flush()
      const requests = yield* Stream.runCollect(Stream.take(server.messages, 8))
      const replies = yield* Stream.runCollect(Stream.take(client.messages, 8))

      return { requests, replies }
    })), { concurrency: "unbounded" })

    for (const [index, { requests, replies }] of results.entries()) {
      expect(requests).toEqual(Array.from({ length: 8 }, (_, message) => ({ index, message })))
      expect(replies).toEqual(Array.from({ length: 8 }, (_, reply) => ({ index, reply })))
      const pair = pairs[index]!
      // The owned client disconnected the pair; the borrowed server only detached.
      expect(pair.controls.connected).toBe(false)
      expect(pair.controls.left.message.listenerCount + pair.controls.left.disconnect.listenerCount).toBe(0)
      expect(pair.controls.right.message.listenerCount + pair.controls.right.disconnect.listenerCount).toBe(0)
    }
  }))
})
