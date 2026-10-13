// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Cause, Effect, Exit, Fiber, Scope, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromePort, ChromePortError, make } from "../src/ChromePort.js"
import type { NativePort, RuntimeApi } from "../src/ChromePort.js"

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
  const connect = vi.fn<RuntimeApi["connect"]>(() => native)

  // SAFETY: Chrome exposes lastError only during callbacks; the getter mirrors that
  // lifetime, including undefined outside callbacks despite its optional declaration.
  const api = {
    connect,
    get lastError() { return lastError }
  } as RuntimeApi

  return {
    native, api, connect, postMessage, disconnect, messages, disconnects,
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
    })).pipe(Effect.provide(ChromePort.layer(f.api)))

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
      ChromePort.pipe(Effect.provide(ChromePort.layerLive))
    )

    expect(failure.operation).toBe("unavailable")
  }))
})
