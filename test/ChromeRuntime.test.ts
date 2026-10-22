// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Schema, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeMessageError, fail, succeed } from "../src/ChromeMessage.js"
import { ChromeRuntime, ChromeRuntimeError, layer, layerLive, make, type ChromeRuntimeApi } from "../src/ChromeRuntime.js"
import { makePortPair } from "../src/testing/Port.js"

const event = <A extends ReadonlyArray<unknown>>() => {
  const listeners = new Set<(...args: A) => void>()
  let registered!: () => void
  const ready = new Promise<void>((resolve) => { registered = resolve })

  return {
    listeners,
    ready,
    addListener: vi.fn((listener: (...args: A) => void) => {
      listeners.add(listener)
      registered()
    }),
    removeListener: vi.fn((listener: (...args: A) => void) => { listeners.delete(listener) }),
    emit: (...args: A) => { for (const listener of listeners) listener(...args) }
  }
}

const context: chrome.runtime.ExtensionContext = {
  contextId: "worker", contextType: "BACKGROUND", frameId: -1, incognito: false, tabId: -1, windowId: -1
}

const fake = () => ({
  id: "extension-id",
  getManifest: vi.fn<ChromeRuntimeApi["getManifest"]>(() => ({ manifest_version: 3, name: "Test", version: "1.0.0" })),
  getURL: vi.fn((path: string) => `chrome-extension://extension-id/${path}`),
  sendMessage: vi.fn<ChromeRuntimeApi["sendMessage"]>(async () => ({ ok: true })),
  getContexts: vi.fn<ChromeRuntimeApi["getContexts"]>(async () => [context]),
  openOptionsPage: vi.fn<ChromeRuntimeApi["openOptionsPage"]>(async () => undefined),
  reload: vi.fn<ChromeRuntimeApi["reload"]>(() => undefined),
  setUninstallURL: vi.fn<ChromeRuntimeApi["setUninstallURL"]>(async () => undefined),
  getPlatformInfo: vi.fn<ChromeRuntimeApi["getPlatformInfo"]>(async () => ({ os: "mac", arch: "arm64" })),
  requestUpdateCheck: vi.fn<ChromeRuntimeApi["requestUpdateCheck"]>(async () => ({ status: "update_available", version: "2.0.0" })),
  onInstalled: event<[chrome.runtime.InstalledDetails]>(),
  onStartup: event<[]>(),
  onUpdateAvailable: event<[chrome.runtime.UpdateAvailableDetails]>(),
  onSuspend: event<[]>(),
  onMessageExternal: event<[unknown, chrome.runtime.MessageSender, () => void]>(),
  onConnectExternal: event<[chrome.runtime.Port]>()
})

describe("ChromeRuntime", () => {
  it.effect("request encodes the message and unwraps the reply envelope", () => Effect.gen(function*() {
    const runtime = fake()
    const service = make(runtime)
    const request = Schema.Struct({ ping: Schema.FiniteFromString })
    const value = Schema.Struct({ pong: Schema.FiniteFromString })

    runtime.sendMessage.mockResolvedValueOnce(succeed({ pong: "2" }))
    expect(yield* service.request(request, value, { ping: 1 })).toEqual({ pong: 2 })
    expect(runtime.sendMessage).toHaveBeenLastCalledWith(undefined, { ping: "1" }, undefined)

    runtime.sendMessage.mockResolvedValueOnce(fail({ code: "Overflow", message: "Startup queue is full" }))
    const failure = yield* Effect.flip(service.request(request, value, { ping: 1 }))
    expect(failure).toBeInstanceOf(ChromeMessageError)
    expect(failure).toMatchObject({ code: "Overflow", message: "Startup queue is full" })

    for (const reply of [{ pong: "2" }, succeed({ pong: "x" }), undefined]) {
      runtime.sendMessage.mockResolvedValueOnce(reply)
      const invalid = yield* Effect.flip(service.request(request, value, { ping: 1 }))
      expect(invalid).toBeInstanceOf(ChromeRuntimeError)
      expect(invalid).toMatchObject({ operation: "sendMessage.decodeResponse" })
    }
  }))

  it.effect("encodes transformed requests and decodes transformed responses across 256 exchanges", () => Effect.gen(function*() {
    const runtime = fake()
    const service = make(runtime)
    const request = Schema.Struct({ ping: Schema.FiniteFromString })
    const response = Schema.Struct({ pong: Schema.FiniteFromString })

    for (let index = 0; index < 256; index++) {
      runtime.sendMessage.mockResolvedValueOnce({ pong: String(index + 1) })
      expect(yield* service.sendMessageSchema(request, response, { ping: index }, { extensionId: "peer" })).toEqual({ pong: index + 1 })
      expect(runtime.sendMessage).toHaveBeenLastCalledWith("peer", { ping: String(index) }, undefined)
    }

    runtime.sendMessage.mockResolvedValueOnce({ pong: "not numeric" })
    const failure = yield* service.sendMessageSchema(request, response, { ping: 0 }).pipe(Effect.flip)
    expect(failure.operation).toBe("sendMessage.decodeResponse")
    expect(failure.cause).toBeInstanceOf(Schema.SchemaError)
    expect(runtime.sendMessage).toHaveBeenCalledTimes(257)
  }))

  it.effect.each([1, 63, 64, 65, 1024, 4096])("retains exactly the newest lifecycle events in a synchronous burst of %i", (count) => Effect.gen(function*() {
    const runtime = fake()
    runtime.onInstalled.addListener.mockImplementationOnce((listener) => {
      runtime.onInstalled.listeners.add(listener)

      for (let index = 0; index < count; index++) listener({ reason: "update", previousVersion: String(index) })
    })
    const values = yield* make(runtime).onInstalled.pipe(Stream.take(Math.min(count, 64)), Stream.runCollect)
    expect(values).toEqual(Array.from({ length: Math.min(count, 64) }, (_, index) => ({
      reason: "update", previousVersion: String(Math.max(0, count - 64) + index)
    })))
    expect(runtime.onInstalled.listeners.size).toBe(0)
    expect(runtime.onInstalled.addListener).toHaveBeenCalledOnce()
    expect(runtime.onInstalled.removeListener).toHaveBeenCalledOnce()
  }))

  it.effect("repeats 256 lifecycle subscriptions with exact startup and installed counts and no listeners left behind", () => Effect.gen(function*() {
    const runtime = fake()
    const service = make(runtime)
    runtime.onInstalled.addListener.mockImplementation((listener) => {
      runtime.onInstalled.listeners.add(listener)

      for (let index = 0; index < 128; index++) listener({ reason: "update", previousVersion: String(index) })
    })
    runtime.onStartup.addListener.mockImplementation((listener) => {
      runtime.onStartup.listeners.add(listener)

      for (let index = 0; index < 128; index++) listener()
    })

    for (let cycle = 0; cycle < 256; cycle++) {
      const values = yield* service.onInstalled.pipe(Stream.take(64), Stream.runCollect)
      expect(values.map((value) => value.previousVersion)).toEqual(Array.from({ length: 64 }, (_, index) => String(index + 64)))
      expect(yield* service.onStartup.pipe(Stream.take(64), Stream.runCollect)).toEqual(Array.from({ length: 64 }, () => undefined))
      expect(runtime.onInstalled.listeners.size + runtime.onStartup.listeners.size).toBe(0)
    }

    expect(runtime.onInstalled.addListener).toHaveBeenCalledTimes(256)
    expect(runtime.onInstalled.removeListener).toHaveBeenCalledTimes(256)
    expect(runtime.onStartup.addListener).toHaveBeenCalledTimes(256)
    expect(runtime.onStartup.removeListener).toHaveBeenCalledTimes(256)
  }))

  it.effect("gives concurrent lifecycle subscribers independent buffers and removes each listener", () => Effect.gen(function*() {
    const runtime = fake()
    const service = make(runtime)
    let registered!: () => void
    const ready = new Promise<void>((resolve) => { registered = resolve })
    runtime.onInstalled.addListener.mockImplementation((listener) => {
      runtime.onInstalled.listeners.add(listener)

      if (runtime.onInstalled.listeners.size === 16) registered()
    })

    const results = yield* Effect.forEach(Array.from({ length: 16 }), () =>
      Effect.forkScoped(service.onInstalled.pipe(Stream.take(64), Stream.runCollect)))

    yield* Effect.promise(() => ready)

    for (let index = 0; index < 2048; index++) runtime.onInstalled.emit({ reason: "update", previousVersion: String(index) })

    for (const values of yield* Effect.forEach(results, Fiber.join)) {
      expect(values).toEqual(Array.from({ length: 64 }, (_, index) => ({ reason: "update", previousVersion: String(1984 + index) })))
    }

    expect(runtime.onInstalled.listeners.size).toBe(0)
    expect(runtime.onInstalled.removeListener).toHaveBeenCalledTimes(16)
  }))

  it.effect("repeated interrupted startup subscribers always release their listener", () => Effect.gen(function*() {
    const runtime = fake()
    const service = make(runtime)

    for (let cycle = 0; cycle < 128; cycle++) {
      let registered!: () => void
      const ready = new Promise<void>((resolve) => { registered = resolve })
      runtime.onStartup.addListener.mockImplementationOnce((listener) => {
        runtime.onStartup.listeners.add(listener)
        registered()
      })
      const fiber = yield* Effect.forkScoped(Stream.runDrain(service.onStartup))
      yield* Effect.promise(() => ready)

      for (let index = 0; index < 128; index++) runtime.onStartup.emit()
      yield* Fiber.interrupt(fiber)
      expect(runtime.onStartup.listeners.size).toBe(0)
    }

    expect(runtime.onStartup.removeListener).toHaveBeenCalledTimes(128)
  }))

  it.effect("isolates 512 mixed messaging failures and successes without leaking lifecycle listeners", () => Effect.gen(function*() {
    const runtime = fake()
    const service = make(runtime)
    const request = Schema.Struct({ ping: Schema.Finite })
    const response = Schema.Struct({ ok: Schema.Boolean })

    for (let index = 0; index < 512; index++) {
      const cause = new Error(`failure ${index}`)

      switch (index % 4) {
        case 0: {
          runtime.sendMessage.mockRejectedValueOnce(cause)
          const failure = yield* service.sendMessageSchema(request, response, { ping: index }).pipe(Effect.flip)
          expect(failure).toMatchObject({ operation: "sendMessage", cause })
          break
        }

        case 1: {
          runtime.sendMessage.mockImplementationOnce(() => { throw cause })
          const failure = yield* service.sendMessageSchema(request, response, { ping: index }).pipe(Effect.flip)
          expect(failure).toMatchObject({ operation: "sendMessage", cause })
          break
        }

        case 2: {
          runtime.sendMessage.mockResolvedValueOnce({ ok: "invalid" })
          const failure = yield* service.sendMessageSchema(request, response, { ping: index }).pipe(Effect.flip)
          expect(failure.operation).toBe("sendMessage.decodeResponse")
          expect(failure.cause).toBeInstanceOf(Schema.SchemaError)
          break
        }

        default: {
          expect(yield* service.sendMessageSchema(request, response, { ping: index })).toEqual({ ok: true })
        }
      }

      const failure = yield* service.sendMessageSchema(request, response, { ping: Number.NaN }).pipe(Effect.flip)
      expect(failure.operation).toBe("sendMessage.encodeRequest")
      expect(failure.cause).toBeInstanceOf(Schema.SchemaError)
    }

    expect(runtime.sendMessage).toHaveBeenCalledTimes(512)
    expect(runtime.onInstalled.listeners.size + runtime.onStartup.listeners.size).toBe(0)
  }))

  it.effect("imports safely without chrome and resolves the live API lazily", () => Effect.gen(function*() {
    vi.stubGlobal("chrome", undefined)
    const imported = yield* Effect.promise(() => import("../src/ChromeRuntime.js"))
    expect(imported.layerLive).toBe(layerLive)

    const error = yield* ChromeRuntime.pipe(Effect.provide(layerLive), Effect.flip)

    expect(error).toBeInstanceOf(ChromeRuntimeError)
    expect(error.operation).toBe("initialize")
    const runtime = fake()
    vi.stubGlobal("chrome", { runtime })
    expect(yield* Effect.gen(function*() {
      return yield* (yield* ChromeRuntime).id
    }).pipe(Effect.provide(layerLive))).toBe("extension-id")
  }))

  it.effect("provides an injected API through layer without a global", () => Effect.gen(function*() {
    vi.stubGlobal("chrome", undefined)
    const runtime = fake()
    expect(yield* Effect.gen(function*() {
      return yield* (yield* ChromeRuntime).getPlatformInfo
    }).pipe(Effect.provide(layer(runtime)))).toEqual({ os: "mac", arch: "arm64" })
  }))

  it.effect("reads metadata lazily and preserves the API receiver", () => Effect.gen(function*() {
    const runtime = fake()
    const service = make(runtime)
    expect(runtime.getManifest).not.toHaveBeenCalled()
    expect(yield* service.id).toBe("extension-id")
    expect(yield* service.getManifest).toEqual(runtime.getManifest())
    expect(yield* service.getURL("page.html")).toBe("chrome-extension://extension-id/page.html")
    expect(runtime.getURL.mock.contexts[0]).toBe(runtime)
    expect(runtime.onInstalled.listeners.size).toBe(0)
    expect(runtime.onStartup.listeners.size).toBe(0)
  }))

  it.effect("uses the explicit Chrome Promise overload and returns unknown responses", () => Effect.gen(function*() {
    const runtime = fake()
    const service = make(runtime)
    expect(yield* service.sendMessage("hello")).toEqual({ ok: true })
    expect(runtime.sendMessage).toHaveBeenLastCalledWith(undefined, "hello", undefined)
    yield* service.sendMessage({ ping: 1 }, {
      extensionId: "other-extension", options: { includeTlsChannelId: true }
    })
    expect(runtime.sendMessage).toHaveBeenLastCalledWith("other-extension", { ping: 1 }, { includeTlsChannelId: true })
    expect(runtime.sendMessage.mock.contexts[0]).toBe(runtime)
  }))

  it.effect("tags messaging rejections and synchronous throws with the original cause", () => Effect.gen(function*() {
    const runtime = fake()
    const cause = new Error("disconnected")
    runtime.sendMessage.mockRejectedValueOnce(cause)
    const service = make(runtime)
    const rejected = yield* service.sendMessage({}).pipe(Effect.asVoid, Effect.flip)
    expect(rejected).toBeInstanceOf(ChromeRuntimeError)
    expect(rejected).toMatchObject({ operation: "sendMessage", cause })
    runtime.sendMessage.mockImplementationOnce(() => { throw cause })
    expect(yield* service.sendMessage({}).pipe(Effect.asVoid, Effect.flip)).toMatchObject({ operation: "sendMessage", cause })
  }))

  it.effect("validates requests before sending and validates unknown responses", () => Effect.gen(function*() {
    const runtime = fake()
    const service = make(runtime)
    const request = Schema.Struct({ ping: Schema.Finite })
    const response = Schema.Struct({ ok: Schema.Boolean })
    expect(yield* service.sendMessageSchema(request, response, { ping: 1 })).toEqual({ ok: true })
    runtime.sendMessage.mockClear()
    const invalid = { ping: "invalid" }
    // Deliberately violate the typed input contract to verify runtime encoding validation.
    // @ts-expect-error negative test: ping must be a number
    const requestError = yield* service.sendMessageSchema(request, response, invalid).pipe(Effect.flip)
    expect(requestError.operation).toBe("sendMessage.encodeRequest")
    expect(requestError.cause).toBeInstanceOf(Schema.SchemaError)
    expect(runtime.sendMessage).not.toHaveBeenCalled()
    runtime.sendMessage.mockResolvedValueOnce({ ok: "not-a-boolean" })
    const responseError = yield* service.sendMessageSchema(request, response, { ping: 1 }).pipe(Effect.flip)
    expect(responseError.operation).toBe("sendMessage.decodeResponse")
    expect(responseError.cause).toBeInstanceOf(Schema.SchemaError)
  }))

  it.effect("tags synchronous metadata errors", () => Effect.gen(function*() {
    const runtime = fake()
    const cause = new Error("unavailable")
    runtime.getManifest.mockImplementation(() => { throw cause })
    runtime.getURL.mockImplementation(() => { throw cause })
    Object.defineProperty(runtime, "id", { get: () => { throw cause } })
    const service = make(runtime)
    expect(yield* service.id.pipe(Effect.flip)).toMatchObject({ operation: "id", cause })
    expect(yield* service.getManifest.pipe(Effect.flip)).toMatchObject({ operation: "getManifest", cause })
    expect(yield* service.getURL("").pipe(Effect.flip)).toMatchObject({ operation: "getURL", cause })
  }))

  it.effect("removes installed listeners when consumption completes", () => Effect.gen(function*() {
    const runtime = fake()
    const result = yield* Effect.forkScoped(make(runtime).onInstalled.pipe(Stream.take(1), Stream.runCollect))
    yield* Effect.promise(() => runtime.onInstalled.ready)
    runtime.onInstalled.emit({ reason: "install" })
    expect(yield* Fiber.join(result)).toEqual([{ reason: "install" }])
    expect(runtime.onInstalled.listeners.size).toBe(0)
    expect(runtime.onInstalled.removeListener).toHaveBeenCalledWith(runtime.onInstalled.addListener.mock.calls[0]?.[0])
  }))

  it.effect("removes startup listeners on interruption", () => Effect.gen(function*() {
    const runtime = fake()
    const fiber = yield* Effect.forkScoped(Stream.runDrain(make(runtime).onStartup))
    yield* Effect.promise(() => runtime.onStartup.ready)
    runtime.onStartup.emit()
    yield* Fiber.interrupt(fiber)
    expect(runtime.onStartup.listeners.size).toBe(0)
    expect(runtime.onStartup.removeListener).toHaveBeenCalledOnce()
  }))

  it.effect("bounds lifecycle buffering and drops the oldest events on overflow", () => Effect.gen(function*() {
    const runtime = fake()
    runtime.onInstalled.addListener.mockImplementationOnce((listener) => {
      runtime.onInstalled.listeners.add(listener)

      for (let index = 0; index < 100; index++) {
        listener({ reason: "update", previousVersion: String(index) })
      }
    })
    const values = yield* make(runtime).onInstalled.pipe(Stream.take(64), Stream.runCollect)
    expect(values).toHaveLength(64)
    expect(values[0]).toEqual({ reason: "update", previousVersion: "36" })
    expect(values[63]).toEqual({ reason: "update", previousVersion: "99" })
    expect(runtime.onInstalled.listeners.size).toBe(0)
  }))

  it.effect("cleans up and tags listener registration throws", () => Effect.gen(function*() {
    const runtime = fake()
    const cause = new Error("registration failed")
    runtime.onInstalled.addListener.mockImplementationOnce((listener) => {
      runtime.onInstalled.listeners.add(listener)
      throw cause
    })
    const error = yield* Stream.runDrain(make(runtime).onInstalled).pipe(Effect.flip)
    expect(error).toMatchObject({ operation: "onInstalled", cause })
    expect(runtime.onInstalled.listeners.size).toBe(0)
    runtime.onStartup.addListener.mockImplementationOnce(() => { throw cause })
    expect(yield* Stream.runDrain(make(runtime).onStartup).pipe(Effect.flip)).toMatchObject({
      operation: "onStartup", cause
    })
    expect(runtime.onStartup.removeListener).toHaveBeenCalledOnce()
  }))

  it.effect("calls the extension-management APIs lazily with the API receiver", () => Effect.gen(function*() {
    const runtime = fake()
    const service = make(runtime)
    const filter: chrome.runtime.ContextFilter = { contextTypes: ["BACKGROUND"] }
    const reload = service.reload
    expect(runtime.reload).not.toHaveBeenCalled()
    yield* reload
    expect(runtime.reload).toHaveBeenCalledOnce()
    expect(runtime.reload.mock.contexts[0]).toBe(runtime)
    expect(yield* service.getContexts(filter)).toEqual([context])
    expect(runtime.getContexts).toHaveBeenCalledExactlyOnceWith(filter)
    yield* service.openOptionsPage
    yield* service.openOptionsPage
    expect(runtime.openOptionsPage).toHaveBeenCalledTimes(2)
    yield* service.setUninstallURL("https://example.com/goodbye")
    expect(runtime.setUninstallURL).toHaveBeenCalledExactlyOnceWith("https://example.com/goodbye")
    expect(yield* service.getPlatformInfo).toEqual({ os: "mac", arch: "arm64" })
    expect(yield* service.requestUpdateCheck).toEqual({ status: "update_available", version: "2.0.0" })
    expect(runtime.getContexts.mock.contexts[0]).toBe(runtime)
  }))

  it.effect("tags extension-management rejections and throws with their operation", () => Effect.gen(function*() {
    const runtime = fake()
    const service = make(runtime)
    const cause = new Error("Could not create an options page.")
    runtime.getContexts.mockRejectedValueOnce(cause)
    runtime.openOptionsPage.mockRejectedValueOnce(cause)
    runtime.reload.mockImplementationOnce(() => { throw cause })
    runtime.setUninstallURL.mockRejectedValueOnce(cause)
    runtime.getPlatformInfo.mockImplementationOnce(() => { throw cause })
    runtime.requestUpdateCheck.mockRejectedValueOnce(cause)

    const failures = [
      ["getContexts", service.getContexts({})],
      ["openOptionsPage", service.openOptionsPage],
      ["reload", service.reload],
      ["setUninstallURL", service.setUninstallURL("")],
      ["getPlatformInfo", service.getPlatformInfo],
      ["requestUpdateCheck", service.requestUpdateCheck]
    ] as const

    for (const [operation, effect] of failures) {
      const error = yield* Effect.flip(Effect.asVoid(effect))
      expect(error).toBeInstanceOf(ChromeRuntimeError)
      expect(error).toMatchObject({ operation, cause })
    }
  }))

  it.effect("streams update, suspend, external message and external connection events while consumed", () => Effect.gen(function*() {
    const runtime = fake()
    const service = make(runtime)
    const sender: chrome.runtime.MessageSender = { id: "peer-extension", origin: "chrome-extension://peer-extension" }
    const sendResponse = vi.fn()
    const port = makePortPair("external").left.port

    const updates = yield* Effect.forkScoped(Stream.runCollect(Stream.take(service.onUpdateAvailable, 1)))
    const suspends = yield* Effect.forkScoped(Stream.runCollect(Stream.take(service.onSuspend, 2)))
    const messages = yield* Effect.forkScoped(Stream.runCollect(Stream.take(service.onMessageExternal, 1)))
    const connections = yield* Effect.forkScoped(Stream.runCollect(Stream.take(service.onConnectExternal, 1)))
    yield* Effect.promise(() => Promise.all([
      runtime.onUpdateAvailable.ready, runtime.onSuspend.ready, runtime.onMessageExternal.ready, runtime.onConnectExternal.ready
    ]))

    runtime.onUpdateAvailable.emit({ version: "2.0.0" })
    runtime.onSuspend.emit()
    runtime.onSuspend.emit()
    runtime.onMessageExternal.emit({ ping: 1 }, sender, sendResponse)
    runtime.onConnectExternal.emit(port)

    expect(yield* Fiber.join(updates)).toEqual([{ version: "2.0.0" }])
    expect(yield* Fiber.join(suspends)).toEqual([undefined, undefined])
    expect(yield* Fiber.join(messages)).toEqual([{ message: { ping: 1 }, sender }])
    expect((yield* Fiber.join(connections))[0]).toBe(port)
    expect(sendResponse).not.toHaveBeenCalled()

    for (const source of [runtime.onUpdateAvailable, runtime.onSuspend, runtime.onMessageExternal, runtime.onConnectExternal]) {
      expect(source.listeners.size).toBe(0)
      expect(source.removeListener).toHaveBeenCalledOnce()
    }
  }))

  it.effect("the external message listener never claims the response channel", () => Effect.gen(function*() {
    const runtime = fake()
    const fiber = yield* Effect.forkScoped(Stream.runDrain(make(runtime).onMessageExternal))
    yield* Effect.promise(() => runtime.onMessageExternal.ready)
    const [listener] = runtime.onMessageExternal.listeners
    expect(listener?.("message", {}, () => undefined)).toBeUndefined()
    yield* Fiber.interrupt(fiber)
    expect(runtime.onMessageExternal.listeners.size).toBe(0)
  }))

  it.effect("tags and cleans up failed registrations of the new event streams", () => Effect.gen(function*() {
    const runtime = fake()
    const service = make(runtime)
    const cause = new Error("registration failed")

    const streams = [
      ["onUpdateAvailable", runtime.onUpdateAvailable, Stream.runDrain(service.onUpdateAvailable)],
      ["onSuspend", runtime.onSuspend, Stream.runDrain(service.onSuspend)],
      ["onMessageExternal", runtime.onMessageExternal, Stream.runDrain(service.onMessageExternal)],
      ["onConnectExternal", runtime.onConnectExternal, Stream.runDrain(service.onConnectExternal)]
    ] as const

    for (const [operation, source, drain] of streams) {
      source.addListener.mockImplementationOnce(() => { throw cause })
      expect(yield* Effect.flip(drain)).toMatchObject({ operation, cause })
      expect(source.removeListener).toHaveBeenCalledOnce()
      expect(source.listeners.size).toBe(0)
    }
  }))
})
