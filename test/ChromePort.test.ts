// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Cause, Deferred, Effect, Exit, Fiber, Option, Scope, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromePort, ChromePortError, layer, layerLive, make } from "../src/ChromePort.js"
import type { ChromePortApi, ConnectOptions, NativePort } from "../src/ChromePort.js"
import { makePortPair } from "../src/testing/Port.js"

const fixture = () => {
  const messages = new Set<(message: unknown, port: NativePort) => void>()
  const disconnects = new Set<(port: NativePort) => void>()
  const postMessage = vi.fn<(message: unknown) => void>()
  const disconnect = vi.fn<() => void>()

  const native: NativePort = {
    name: "test",
    postMessage,
    disconnect,
    onMessage: {
      addListener: (listener: (message: unknown, port: NativePort) => void) => { messages.add(listener) },
      removeListener: (listener: (message: unknown, port: NativePort) => void) => { messages.delete(listener) },
      hasListener: (listener) => messages.has(listener),
      hasListeners: () => messages.size > 0,
      addRules: vi.fn(),
      getRules: vi.fn(),
      removeRules: vi.fn()
    },
    onDisconnect: {
      addListener: (listener: (port: NativePort) => void) => { disconnects.add(listener) },
      removeListener: (listener: (port: NativePort) => void) => { disconnects.delete(listener) },
      hasListener: (listener) => disconnects.has(listener),
      hasListeners: () => disconnects.size > 0,
      addRules: vi.fn(),
      getRules: vi.fn(),
      removeRules: vi.fn()
    }
  }

  let lastError: { message: string } | undefined
  const connect = vi.fn<(target?: string | chrome.runtime.ConnectInfo, connectInfo?: chrome.runtime.ConnectInfo) => NativePort>(() => native)
  const connectNative = vi.fn<(application: string) => NativePort>(() => native)

  const api: ChromePortApi = {
    connect,
    connectNative,
    get lastError() { return lastError }
  }

  return {
    native, api, connect, connectNative, postMessage, disconnect, messages, disconnects,
    emit: (message: unknown) => { for (const listener of messages) listener(message, native) },
    close: (message?: string) => {
      lastError = message === undefined ? undefined : { message }

      try { for (const listener of disconnects) listener(native) } finally { lastError = undefined }
    }
  }
}

describe("ChromePort", () => {
  it.effect.each(["owned", "borrowed"] as const)("scope closure interrupts %s consumers and discards unconsumed bursts", (ownership) => Effect.gen(function*() {
    const f = fixture()

    for (let cycle = 0; cycle < 128; cycle++) {
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const port = yield* make(f.api).adopt(f.native, ownership).pipe(Effect.provideService(Scope.Scope, scope))

      if (cycle % 2 === 0) {
        let started!: () => void
        const ready = new Promise<void>((resolve) => { started = resolve })

        const consumer = yield* Effect.forkScoped(Effect.gen(function*() {
          started()

          return yield* Stream.runDrain(port.messages)
        }))

        // Wait through the native microtask gate so the consumer is running before
        // closing its port scope, rather than only reading an already closed port.
        yield* Effect.promise(() => ready)
        yield* Scope.close(scope, Exit.void)
        const exit = yield* Fiber.await(consumer)
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      } else {
        for (let index = 0; index < 1024; index++) f.emit(index)
        yield* Scope.close(scope, Exit.void)
        const seen: Array<unknown> = []

        const exit = yield* Effect.exit(port.messages.pipe(
          Stream.tap((value) => Effect.sync(() => { seen.push(value) })),
          Stream.runDrain
        ))

        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
        expect(seen).toEqual([])
      }

      expect(f.messages.size + f.disconnects.size).toBe(0)
      expect((yield* Effect.flip(port.send("late"))).operation).toBe("send")
      yield* port.disconnect
      yield* Scope.close(scope, Exit.void)
    }

    expect(f.disconnect).toHaveBeenCalledTimes(ownership === "owned" ? 128 : 0)
    expect(f.postMessage).not.toHaveBeenCalled()
  }))

  it.effect.each([0, 1, 63, 64, 65, 1024, 4096])("retains exactly the newest 64 of %i early messages through clean disconnect", (count) => Effect.gen(function*() {
    const f = fixture()

    const values = yield* Effect.scoped(Effect.gen(function*() {
      const port = yield* make(f.api).connect()

      for (let index = 0; index < count; index++) f.emit(index)
      f.close()
      f.emit("ignored after close")
      const failure = yield* Effect.flip(port.send("late"))
      expect(failure.operation).toBe("send")

      return yield* Stream.runCollect(port.messages)
    }))

    expect(values).toEqual(Array.from({ length: Math.min(count, 64) }, (_, index) => Math.max(0, count - 64) + index))
    expect(f.messages.size).toBe(0)
    expect(f.disconnects.size).toBe(0)
    expect(f.disconnect).not.toHaveBeenCalled()
    expect(f.postMessage).not.toHaveBeenCalled()
  }))

  it.effect("buffers a burst emitted synchronously during listener attachment", () => Effect.gen(function*() {
    const f = fixture()
    vi.spyOn(f.native.onMessage, "addListener").mockImplementation((listener) => {
      f.messages.add(listener)

      for (let index = 0; index < 2048; index++) listener(index, f.native)
      f.close()
    })

    const values = yield* Effect.scoped(Effect.gen(function*() {
      const port = yield* make(f.api).connect()
      expect(f.messages.size).toBe(0)
      expect(f.disconnects.size).toBe(0)

      return yield* Stream.runCollect(port.messages)
    }))

    expect(values).toEqual(Array.from({ length: 64 }, (_, index) => 1984 + index))
    expect(f.disconnect).not.toHaveBeenCalled()
  }))

  it.effect.each([undefined, "acquisition disconnected"])("handles disconnect during disconnect-listener acquisition (%s)", (message) => Effect.gen(function*() {
    const f = fixture()
    const attachMessages = vi.spyOn(f.native.onMessage, "addListener")
    vi.spyOn(f.native.onDisconnect, "addListener").mockImplementation((listener) => {
      f.disconnects.add(listener)
      f.close(message)
    })
    yield* Effect.scoped(Effect.gen(function*() {
      const port = yield* make(f.api).connect()

      if (message === undefined) {
        expect(yield* Stream.runCollect(port.messages)).toEqual([])
      } else {
        const failure = yield* Effect.flip(Stream.runDrain(port.messages))
        expect(failure.message).toBe(message)
        expect(f.api.lastError).toBeUndefined()
        expect(yield* Effect.flip(port.send("late"))).toBe(failure)
      }
    }))
    expect(attachMessages).not.toHaveBeenCalled()
    expect(f.disconnects.size).toBe(0)
    expect(f.disconnect).not.toHaveBeenCalled()
  }))

  it.effect("delivers the retained burst then reports the snapshotted disconnect error", () => Effect.gen(function*() {
    const f = fixture()
    const seen: Array<unknown> = []
    yield* Effect.scoped(Effect.gen(function*() {
      const port = yield* make(f.api).connect()

      for (let index = 0; index < 2048; index++) f.emit(index)
      f.close("host error")

      const failure = yield* Effect.flip(port.messages.pipe(
        Stream.tap((value) => Effect.sync(() => { seen.push(value) })),
        Stream.runDrain
      ))

      expect(failure).toMatchObject({ operation: "disconnect", message: "host error", cause: { message: "host error" } })
      expect(yield* Effect.flip(port.send("late"))).toBe(failure)
      yield* port.disconnect
    }))
    expect(seen).toEqual(Array.from({ length: 64 }, (_, index) => 1984 + index))
    expect(f.messages.size + f.disconnects.size).toBe(0)
    expect(f.disconnect).not.toHaveBeenCalled()
  }))

  it.effect.each(["owned", "borrowed"] as const)("repeats 256 %s acquisitions without leaking listeners or retrying disconnect", (ownership) => Effect.gen(function*() {
    const f = fixture()

    for (let cycle = 0; cycle < 256; cycle++) {
      const port = yield* Effect.scoped(Effect.gen(function*() {
        const acquired = yield* make(f.api).adopt(f.native, ownership)
        expect(f.messages.size).toBe(1)
        expect(f.disconnects.size).toBe(1)
        f.emit(cycle)

        if (cycle % 2 === 0) {
          yield* acquired.disconnect
          yield* acquired.disconnect
          expect(yield* Stream.runCollect(acquired.messages)).toEqual([cycle])
        }

        return acquired
      }))

      expect(f.messages.size + f.disconnects.size).toBe(0)
      expect((yield* Effect.flip(port.send(cycle))).operation).toBe("send")
      yield* port.disconnect
    }

    expect(f.disconnect).toHaveBeenCalledTimes(ownership === "owned" ? 256 : 0)
    expect(f.postMessage).not.toHaveBeenCalled()
  }))

  it.effect.each(["owned", "borrowed"] as const)("rolls back partially attached listeners for %s ports", (ownership) => Effect.gen(function*() {
    for (const event of ["onMessage", "onDisconnect"] as const) {
      const f = fixture()
      const cause = new Error(`${event} failed after attaching`)

      if (event === "onMessage") {
        vi.spyOn(f.native.onMessage, "addListener").mockImplementation((listener) => {
          f.messages.add(listener)
          listener("early", f.native)
          throw cause
        })
      } else {
        vi.spyOn(f.native.onDisconnect, "addListener").mockImplementation((listener) => {
          f.disconnects.add(listener)
          throw cause
        })
      }

      const failure = yield* Effect.scoped(Effect.flip(make(f.api).adopt(f.native, ownership)))
      expect(failure).toMatchObject({ operation: "adopt", cause })
      expect(f.messages.size + f.disconnects.size).toBe(0)
      expect(f.disconnect).toHaveBeenCalledTimes(ownership === "owned" ? 1 : 0)
    }
  }))

  it.effect("preserves the native disconnect failure when listener removal also throws", () => Effect.gen(function*() {
    const f = fixture()
    const cause = new Error("native disconnect failed")
    f.disconnect.mockImplementation(() => { throw cause })
    vi.spyOn(f.native.onMessage, "removeListener").mockImplementation((listener) => {
      f.messages.delete(listener)
      throw new Error("message removal failed")
    })
    const removeDisconnect = vi.spyOn(f.native.onDisconnect, "removeListener")
    yield* Effect.scoped(Effect.gen(function*() {
      const port = yield* make(f.api).connect()
      const failure = yield* Effect.flip(port.disconnect)
      expect(failure.cause).toBe(cause)
      expect(yield* Effect.flip(Stream.runDrain(port.messages))).toBe(failure)
      yield* port.disconnect
    }))
    expect(removeDisconnect).toHaveBeenCalled()
    expect(f.messages.size + f.disconnects.size).toBe(0)
    expect(f.disconnect).toHaveBeenCalledOnce()
  }))

  it.effect("buffers early messages and installs/removes listeners at acquisition/release", () => Effect.gen(function*() {
    const f = fixture()

    const result = yield* Effect.scoped(Effect.gen(function*() {
      const port = yield* make(f.api).connect({ extensionId: "extension", name: "channel" })
      expect(f.messages.size).toBe(1)
      expect(f.disconnects.size).toBe(1)
      f.emit({ early: true })
      f.emit("second")

      return yield* Stream.runCollect(Stream.take(port.messages, 2))
    }))

    expect(result).toEqual([{ early: true }, "second"])
    expect(f.connect).toHaveBeenCalledWith("extension", { name: "channel" })
    expect(f.messages.size).toBe(0)
    expect(f.disconnects.size).toBe(0)
    expect(f.disconnect).toHaveBeenCalledTimes(1)
  }))

  it.effect("drops oldest messages when the bounded buffer overflows", () => Effect.gen(function*() {
    const f = fixture()

    const result = yield* Effect.scoped(Effect.gen(function*() {
      const port = yield* make(f.api).connect()

      for (let i = 0; i < 70; i++) f.emit(i)
      f.close()

      return yield* Stream.runCollect(port.messages)
    }))

    expect(result).toEqual(Array.from({ length: 64 }, (_, i) => i + 6))
    expect(f.disconnect).not.toHaveBeenCalled()
  }))

  it.effect("snapshots lastError inside the disconnect callback and fails the stream", () => Effect.gen(function*() {
    const f = fixture()

    const result = yield* Effect.scoped(Effect.gen(function*() {
      const port = yield* make(f.api).connect()
      f.close("No receiving end")
      expect(f.api.lastError).toBeUndefined()

      return yield* Effect.flip(Stream.runDrain(port.messages))
    }))

    expect(result).toBeInstanceOf(ChromePortError)
    expect(result.operation).toBe("disconnect")
    expect(result.message).toBe("No receiving end")
    expect(result.cause).toEqual({ message: "No receiving end" })
    expect(f.messages.size).toBe(0)
    expect(f.disconnects.size).toBe(0)
    expect(f.disconnect).not.toHaveBeenCalled()
  }))

  it.effect.each(["owned", "borrowed"] as const)("respects %s adoption ownership and idempotent disconnect", (ownership) => Effect.gen(function*() {
    const f = fixture()
    yield* Effect.scoped(Effect.gen(function*() {
      const port = yield* make(f.api).adopt(f.native, ownership)
      yield* port.disconnect
      yield* port.disconnect
      expect(yield* Stream.runCollect(port.messages)).toEqual([])
      const failure = yield* Effect.flip(port.send("late"))
      expect(failure.operation).toBe("send")
    }))
    expect(f.connect).not.toHaveBeenCalled()
    expect(f.disconnect).toHaveBeenCalledTimes(ownership === "owned" ? 1 : 0)
    expect(f.messages.size).toBe(0)
    expect(f.disconnects.size).toBe(0)
  }))

  it.effect("does not disconnect borrowed ports on scope release", () => Effect.gen(function*() {
    const f = fixture()
    yield* Effect.scoped(make(f.api).adopt(f.native, "borrowed"))
    expect(f.disconnect).not.toHaveBeenCalled()
    expect(f.messages.size).toBe(0)
    expect(f.disconnects.size).toBe(0)
  }))

  it.effect("captures synchronous postMessage failures in the typed error channel", () => Effect.gen(function*() {
    const f = fixture()
    const cause = new Error("Cannot serialize")
    f.postMessage.mockImplementation(() => { throw cause })

    const failure = yield* Effect.scoped(Effect.gen(function*() {
      const port = yield* make(f.api).connect()

      return yield* Effect.flip(port.send({ unsupported: true }))
    }))

    expect(failure.operation).toBe("send")
    expect(failure.cause).toBe(cause)
    expect(f.disconnect).toHaveBeenCalledTimes(1)
  }))

  it.effect("cleans listeners and owned connections when consumption is interrupted", () => Effect.gen(function*() {
    const f = fixture()
    let registered!: () => void
    const ready = new Promise<void>((resolve) => { registered = resolve })
    vi.spyOn(f.native.onMessage, "addListener").mockImplementation((listener) => {
      f.messages.add(listener)
      registered()
    })

    const fiber = yield* Effect.forkScoped(Effect.scoped(Effect.gen(function*() {
      const port = yield* make(f.api).connect()

      return yield* Stream.runDrain(port.messages)
    })))

    yield* Effect.promise(() => ready)
    expect(f.messages.size).toBe(1)
    yield* Fiber.interrupt(fiber)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(f.messages.size).toBe(0)
    expect(f.disconnects.size).toBe(0)
    expect(f.disconnect).toHaveBeenCalledTimes(1)
  }))

  it.effect("captures synchronous disconnect failure and never retries native disconnect", () => Effect.gen(function*() {
    const f = fixture()
    const cause = new Error("disconnect threw")
    f.disconnect.mockImplementation(() => { throw cause })
    yield* Effect.scoped(Effect.gen(function*() {
      const port = yield* make(f.api).connect()
      const failure = yield* Effect.flip(port.disconnect)
      expect(failure.operation).toBe("disconnect")
      expect(failure.cause).toBe(cause)
      yield* port.disconnect
    }))
    expect(f.disconnect).toHaveBeenCalledTimes(1)
    expect(f.messages.size).toBe(0)
    expect(f.disconnects.size).toBe(0)
  }))

  it.effect("captures connect errors and supports an injected service layer", () => Effect.gen(function*() {
    const f = fixture()
    const cause = new Error("connect threw")
    f.connect.mockImplementation(() => { throw cause })

    const failure = yield* Effect.scoped(Effect.gen(function*() {
      const service = yield* ChromePort

      return yield* Effect.flip(service.connect())
    })).pipe(Effect.provide(layer(f.api)))

    expect(failure.operation).toBe("connect")
    expect(failure.cause).toBe(cause)
  }))

  it.effect("captures callback lastError during an explicit disconnect", () => Effect.gen(function*() {
    const f = fixture()
    f.disconnect.mockImplementation(() => f.close("Disconnected by host"))
    yield* Effect.scoped(Effect.gen(function*() {
      const port = yield* make(f.api).connect()
      const failure = yield* Effect.flip(port.disconnect)
      expect(failure.message).toBe("Disconnected by host")
      const streamFailure = yield* Effect.flip(Stream.runDrain(port.messages))
      expect(streamFailure).toBe(failure)
      yield* port.disconnect
    }))
    expect(f.disconnect).toHaveBeenCalledTimes(1)
  }))

  it.effect("rolls back partial listener acquisition and releases an owned connection", () => Effect.gen(function*() {
    const f = fixture()
    const cause = new Error("listener registration failed")
    vi.spyOn(f.native.onMessage, "addListener").mockImplementation(() => { throw cause })
    const failure = yield* Effect.scoped(Effect.flip(make(f.api).connect()))
    expect(failure.operation).toBe("connect")
    expect(failure.cause).toBe(cause)
    expect(f.messages.size).toBe(0)
    expect(f.disconnects.size).toBe(0)
    expect(f.disconnect).toHaveBeenCalledTimes(1)
  }))

  it.effect("reports an unavailable live runtime without requiring Chrome at import time", () => Effect.gen(function*() {
    vi.stubGlobal("chrome", undefined)

    const failure = yield* Effect.flip(
      ChromePort.pipe(Effect.provide(layerLive))
    )

    expect(failure).toBeInstanceOf(ChromePortError)
    expect(failure.operation).toBe("initialize")
    vi.stubGlobal("chrome", {})
    expect(yield* Effect.flip(ChromePort.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
  }))

  it.effect("builds the live layer from a fake chrome.runtime when the layer is built", () => Effect.gen(function*() {
    const f = fixture()
    vi.stubGlobal("chrome", { runtime: f.api })

    const name = yield* Effect.scoped(Effect.gen(function*() {
      const service = yield* ChromePort
      const port = yield* service.connect({ name: "live" })
      yield* port.send("hello")

      return port.name
    })).pipe(Effect.provide(layerLive))

    expect(name).toBe("test")
    expect(f.connect).toHaveBeenCalledExactlyOnceWith({ name: "live" })
    expect(f.postMessage).toHaveBeenCalledExactlyOnceWith("hello")
    expect(f.disconnect).toHaveBeenCalledOnce()
  }))
})

describe("ChromePort arguments", () => {
  it.effect.each<{ readonly label: string; readonly options?: ConnectOptions; readonly expected: ReadonlyArray<unknown> }>([
    { label: "nothing", expected: [] },
    { label: "an empty object", options: {}, expected: [] },
    { label: "a name", options: { name: "channel" }, expected: [{ name: "channel" }] },
    { label: "includeTlsChannelId alone", options: { includeTlsChannelId: false }, expected: [{ includeTlsChannelId: false }] },
    { label: "an extension id alone", options: { extensionId: "other" }, expected: ["other"] },
    { label: "every field", options: { extensionId: "other", name: "channel", includeTlsChannelId: true }, expected: ["other", { name: "channel", includeTlsChannelId: true }] }
  ])("connect passes Chrome only the given arguments: $label", ({ options, expected }) => Effect.gen(function*() {
    const f = fixture()
    yield* Effect.scoped(options === undefined ? make(f.api).connect() : make(f.api).connect(options))
    expect(f.connect).toHaveBeenCalledOnce()
    expect(f.connect.mock.calls[0]).toEqual(expected)
  }))

  it.effect("connectNative opens an owned port to the named host and releases it with the scope", () => Effect.gen(function*() {
    const f = fixture()

    const received = yield* Effect.scoped(Effect.gen(function*() {
      const port = yield* make(f.api).connectNative("com.example.host")
      expect(f.messages.size + f.disconnects.size).toBe(2)
      yield* port.send({ text: "ping" })
      f.emit({ text: "pong" })

      return yield* Stream.runCollect(Stream.take(port.messages, 1))
    }))

    expect(received).toEqual([{ text: "pong" }])
    expect(f.connectNative).toHaveBeenCalledExactlyOnceWith("com.example.host")
    expect(f.postMessage).toHaveBeenCalledExactlyOnceWith({ text: "ping" })
    expect(f.messages.size + f.disconnects.size).toBe(0)
    expect(f.disconnect).toHaveBeenCalledOnce()
  }))

  it.effect("connectNative reports a missing host through the stream, without disconnecting again", () => Effect.gen(function*() {
    const f = fixture()

    const failure = yield* Effect.scoped(Effect.gen(function*() {
      const port = yield* make(f.api).connectNative("com.example.missing")
      f.close("Specified native messaging host not found.")

      return yield* Effect.flip(Stream.runDrain(port.messages))
    }))

    expect(failure).toMatchObject({ operation: "disconnect", message: "Specified native messaging host not found." })
    expect(f.disconnect).not.toHaveBeenCalled()
  }))

  it.effect("connectNative fails with a typed error when Chrome has no connectNative", () => Effect.gen(function*() {
    const f = fixture()
    const api: ChromePortApi = { connect: f.connect, lastError: undefined }

    const failure = yield* Effect.scoped(Effect.flip(make(api).connectNative("com.example.host")))

    expect(failure).toBeInstanceOf(ChromePortError)
    expect(failure.operation).toBe("connectNative")
    expect(failure.cause).toBeInstanceOf(Error)
    expect(f.connect).not.toHaveBeenCalled()
  }))

  it.effect("connectNative maps a synchronous throw and a registration failure to operation connectNative", () => Effect.gen(function*() {
    const thrown = fixture()
    const cause = new Error("Invalid native host name")
    thrown.connectNative.mockImplementation(() => { throw cause })
    expect(yield* Effect.scoped(Effect.flip(make(thrown.api).connectNative("Bad Name")))).toMatchObject({ operation: "connectNative", cause })

    const registration = fixture()
    const failure = new Error("onMessage registration failed")
    vi.spyOn(registration.native.onMessage, "addListener").mockImplementation(() => { throw failure })
    expect(yield* Effect.scoped(Effect.flip(make(registration.api).connectNative("com.example.host")))).toMatchObject({ operation: "connectNative", cause: failure })
    expect(registration.disconnects.size).toBe(0)
    expect(registration.disconnect).toHaveBeenCalledOnce()
  }))

  it.effect("exposes the sender of a delivered port, and None for a connecting port", () => Effect.gen(function*() {
    const f = fixture()
    const sender: chrome.runtime.MessageSender = { id: "extension", url: "chrome-extension://extension/popup.html" }

    const [connected, adopted] = yield* Effect.scoped(Effect.gen(function*() {
      const service = make(f.api)
      const outgoing = yield* service.connect()
      f.native.sender = sender

      return [outgoing.sender, (yield* service.adopt(f.native, "borrowed")).sender] as const
    }))

    expect(connected).toEqual(Option.none())
    expect(adopted).toEqual(Option.some(sender))
  }))

  it.effect("never lets a listener removal failure escape into Chrome's disconnect dispatch", () => Effect.gen(function*() {
    const f = fixture()

    const removeMessage = vi.spyOn(f.native.onMessage, "removeListener").mockImplementation((listener) => {
      f.messages.delete(listener)
      throw new Error("message removal failed")
    })

    const values = yield* Effect.scoped(Effect.gen(function*() {
      const port = yield* make(f.api).connect()
      f.emit("kept")
      expect(() => f.close()).not.toThrow()

      return yield* Stream.runCollect(port.messages)
    }))

    expect(values).toEqual(["kept"])
    expect(removeMessage).toHaveBeenCalled()
    expect(f.messages.size + f.disconnects.size).toBe(0)
    expect(f.disconnect).not.toHaveBeenCalled()
  }))

  it.effect("a disconnect reported during registration succeeds even when removal throws", () => Effect.gen(function*() {
    const f = fixture()
    vi.spyOn(f.native.onDisconnect, "addListener").mockImplementation((listener) => {
      f.disconnects.add(listener)
      f.close("gone")
    })
    vi.spyOn(f.native.onDisconnect, "removeListener").mockImplementation((listener) => {
      f.disconnects.delete(listener)
      throw new Error("disconnect removal failed")
    })

    const failure = yield* Effect.scoped(Effect.gen(function*() {
      const port = yield* make(f.api).connect()

      return yield* Effect.flip(Stream.runDrain(port.messages))
    }))

    expect(failure).toMatchObject({ operation: "disconnect", message: "gone" })
    expect(f.disconnects.size).toBe(0)
    expect(f.disconnect).not.toHaveBeenCalled()
  }))
})

describe("ChromePort fixture", () => {
  it.effect("gives only the receiving endpoint a sender, which adoption exposes", () => Effect.gen(function*() {
    const sender: chrome.runtime.MessageSender = { id: "extension", frameId: 0 }
    const pair = makePortPair("named", { sender })
    expect(pair.right.port.sender).toBe(sender)
    expect("sender" in pair.left.port).toBe(false)
    expect("sender" in makePortPair().right.port).toBe(false)

    const [left, right, echoed] = yield* Effect.scoped(Effect.gen(function*() {
      const client = yield* make(pair.left.api).connect({ name: "ignored" })
      const server = yield* make(pair.right.api).adopt(pair.right.port, "borrowed")
      yield* client.send({ n: 1 })
      pair.controls.flush()

      return [client.sender, server.sender, yield* Stream.runHead(server.messages)] as const
    }))

    expect(left).toEqual(Option.none())
    expect(right).toEqual(Option.some(sender))
    expect(echoed).toEqual(Option.some({ n: 1 }))
    // The owned client disconnected the pair on release; only the server is notified.
    expect(pair.controls.connected).toBe(false)
  }))

  it.effect("maps a fixture connect failure to operation connect", () => Effect.gen(function*() {
    const pair = makePortPair()
    const cause = new Error("connect failed")
    pair.controls.left.failNext("connect", cause)
    expect(yield* Effect.scoped(Effect.flip(make(pair.left.api).connect()))).toMatchObject({ operation: "connect", cause })
    pair.left.port.disconnect()
    expect((yield* Effect.scoped(Effect.flip(make(pair.left.api).connect()))).operation).toBe("connect")
  }))
})

describe("ChromePort edge cases", () => {
  it.effect("sequential partial consumers resume where the previous one stopped", () => Effect.gen(function*() {
    const f = fixture()

    const [first, second, middle, rest] = yield* Effect.scoped(Effect.gen(function*() {
      const port = yield* make(f.api).connect()

      for (let index = 0; index < 8; index++) f.emit(index)

      const head = yield* Stream.runHead(port.messages)
      const next = yield* Stream.runHead(port.messages)
      const taken = yield* Stream.runCollect(Stream.take(port.messages, 2))
      f.close()

      return [head, next, taken, yield* Stream.runCollect(port.messages)] as const
    }))

    expect(first).toEqual(Option.some(0))
    expect(second).toEqual(Option.some(1))
    expect(middle).toEqual([2, 3])
    expect(rest).toEqual([4, 5, 6, 7])
  }))

  it.effect("a consumer interrupted while handling one message leaves the later ones buffered", () => Effect.gen(function*() {
    const f = fixture()

    yield* Effect.scoped(Effect.gen(function*() {
      const port = yield* make(f.api).adopt(f.native, "borrowed")

      for (let index = 0; index < 4; index++) f.emit(index)

      const handling = yield* Deferred.make<unknown>()

      const consumer = yield* Effect.forkScoped(Stream.runForEach(port.messages, (value) =>
        Deferred.succeed(handling, value).pipe(Effect.andThen(Effect.never))
      ))

      expect(yield* Deferred.await(handling)).toBe(0)
      yield* Fiber.interrupt(consumer)
      f.close()
      expect(yield* Stream.runCollect(port.messages)).toEqual([1, 2, 3])
    }))
  }))

  it.effect("a port whose properties throw fails acquisition without leaving listeners or an open owned port", () => Effect.gen(function*() {
    for (const property of ["name", "sender"] as const) {
      const f = fixture()
      const cause = new Error(`${property} getter failed`)
      Object.defineProperty(f.native, property, { get: () => { throw cause } })

      const failure = yield* Effect.scoped(Effect.flip(make(f.api).connect()))

      expect(failure).toMatchObject({ operation: "connect", cause })
      expect(f.messages.size + f.disconnects.size).toBe(0)
      expect(f.disconnect).toHaveBeenCalledOnce()
    }
  }))
})
