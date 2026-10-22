// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChromePortError, make } from "../../src/ChromePort.js"
import type { ChromePortApi, NativePort } from "../../src/ChromePort.js"
import { makeEvent } from "../../src/testing/Event.js"
import { burst, expectOperations, labelled, newest } from "./support.js"

/** Runs a native callback with `lastError` set to `error` only for its duration. */
type Reporting = (error: string | undefined, run: () => void) => void

/** A native port whose listeners, posts and disconnect calls are counted. */
const nativePort = (reporting: Reporting, name: string, failPostEvery = 0) => {
  const message = makeEvent<[message: number, port: NativePort]>()
  const disconnect = makeEvent<[port: NativePort]>()
  const failures = new Map<Error, string>()
  let posts = 0
  let disconnects = 0

  const port: NativePort = {
    name,
    onMessage: message.api,
    onDisconnect: disconnect.api,
    postMessage: () => {
      const post = posts++

      if (failPostEvery > 0 && post % failPostEvery === 0) {
        const cause = new Error(`${name} post ${post} failed`)
        failures.set(cause, "send")

        throw cause
      }
    },
    disconnect: () => { disconnects++ }
  }

  return {
    port,
    failures,
    emit: (value: number) => message.controls.emit(value, port),
    get listeners() { return message.controls.listenerCount + disconnect.controls.listenerCount },
    get disconnects() { return disconnects },
    /** Chrome reporting the disconnect, with `lastError` set only during the callback. */
    hostDisconnect: (error?: string) => reporting(error, () => disconnect.controls.emit(port))
  }
}

const runtime = (connectFailEvery = 0) => {
  let lastError: chrome.runtime.LastError | undefined
  let connects = 0
  const failures = new Map<Error, string>()
  const opened: Array<ReturnType<typeof nativePort>> = []

  const reporting: Reporting = (error, run) => {
    lastError = error === undefined ? undefined : { message: error }

    try { run() } finally { lastError = undefined }
  }

  const api: ChromePortApi = {
    get lastError() { return lastError },
    connect: () => {
      const connect = connects++

      if (connectFailEvery > 0 && connect % connectFailEvery === 0) {
        const cause = new Error(`connect ${connect} failed`)
        failures.set(cause, "connect")

        throw cause
      }

      const native = nativePort(reporting, `connected-${connect}`)
      opened.push(native)

      return native.port
    }
  }

  return {
    api,
    failures,
    opened,
    native: (name: string, failPostEvery?: number) => nativePort(reporting, name, failPostEvery)
  }
}

describe("ChromePort stress", () => {
  it.effect("keeps the newest 64 of a 4,096-message burst, drains them on a clean disconnect and removes both listeners", () => Effect.gen(function*() {
    const host = runtime()
    const native = host.native("burst")

    const received = yield* Effect.scoped(Effect.gen(function*() {
      const port = yield* make(host.api).adopt(native.port, "borrowed")
      expect(native.listeners).toBe(2)

      for (let index = 0; index < burst; index++) native.emit(index)

      native.hostDisconnect()

      return yield* Stream.runCollect(port.messages)
    }))

    expect(received).toEqual(newest(burst))
    expect(native.listeners).toBe(0)
    expect(native.disconnects).toBe(0)
  }))

  it.effect("runs 512 concurrent adopt/disconnect cycles, in four endings, without leaking a listener", () => Effect.gen(function*() {
    const host = runtime()
    const service = make(host.api)
    const natives = Array.from({ length: 512 }, (_, index) => host.native(`port-${index}`))
    const adopted = yield* Deferred.make<void>()
    const go = yield* Deferred.make<void>()
    let open = 0

    const cycle = (index: number) => Effect.scoped(Effect.gen(function*() {
      const native = natives[index]!
      const port = yield* service.adopt(native.port, index % 2 === 0 ? "owned" : "borrowed")

      if (++open === natives.length) yield* Deferred.succeed(adopted, undefined)

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

    yield* Deferred.await(adopted)
    expect(natives.reduce((total, native) => total + native.listeners, 0)).toBe(1024)
    yield* Deferred.succeed(go, undefined)
    yield* Fiber.join(fiber)

    for (const [index, native] of natives.entries()) {
      expect(native.listeners).toBe(0)
      const ending = Math.floor(index / 2) % 4
      const owned = index % 2 === 0
      // Owned ports are disconnected exactly once, unless Chrome already reported the disconnect.
      expect(native.disconnects).toBe(owned && (ending === 0 || ending === 3) ? 1 : 0)
    }
  }))

  it.effect("runs 1,024 concurrent connects and sends with interleaved failures, keeping operation names", () => Effect.gen(function*() {
    const host = runtime(3)
    const service = make(host.api)
    const shared = host.native("shared", 2)
    const scope = yield* Scope.make()
    const port = yield* service.adopt(shared.port, "borrowed").pipe(Scope.provide(scope))

    const calls = Array.from({ length: 1024 }, (_, index) => index % 2 === 0
      ? labelled("connect", Effect.scoped(Effect.flatMap(service.connect({ name: `stress-${index}` }), (connected) => connected.send(index))))
      : labelled("send", port.send(index)))

    const results = yield* Effect.all(calls, { concurrency: "unbounded" })
    yield* Scope.close(scope, Exit.void)

    expectOperations(results, new Map([...host.failures, ...shared.failures]), ChromePortError)
    expect(host.failures.size).toBe(Math.ceil(512 / 3))
    expect(shared.failures.size).toBe(256)
    expect(shared.listeners).toBe(0)

    for (const native of host.opened) {
      expect(native.listeners).toBe(0)
      expect(native.disconnects).toBe(1)
    }

    expect(host.opened).toHaveLength(512 - host.failures.size)
  }))
})
