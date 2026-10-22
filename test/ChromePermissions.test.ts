// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromePermissions, ChromePermissionsError, layer, layerLive, make } from "../src/ChromePermissions.js"
import type { ChromePermissionsApi } from "../src/ChromePermissions.js"

const permissions: chrome.permissions.Permissions = { permissions: ["tabs"], origins: ["https://example.com/*"] }

const event = () => {
  const listeners = new Set<(value: chrome.permissions.Permissions) => void>()
  let notify!: () => void
  const added = new Promise<void>((resolve) => { notify = resolve })

  return {
    listeners,
    added,
    addListener: vi.fn((listener: (value: chrome.permissions.Permissions) => void) => {
      listeners.add(listener)
      notify()
    }),
    removeListener: vi.fn((listener: (value: chrome.permissions.Permissions) => void) => { listeners.delete(listener) }),
    emit: (value: chrome.permissions.Permissions) => { for (const listener of listeners) listener(value) }
  }
}

const mockApi = () => ({
  getAll: vi.fn(async () => permissions),
  contains: vi.fn(async (_permissions: chrome.permissions.Permissions) => true),
  request: vi.fn(async (_permissions: chrome.permissions.Permissions) => true),
  remove: vi.fn(async (_permissions: chrome.permissions.Permissions) => true),
  onAdded: event(),
  onRemoved: event()
}) satisfies ChromePermissionsApi

describe("ChromePermissions", () => {
  it.effect("snapshots the live API getter once per layer build", () => Effect.gen(function*() {
    const api = mockApi()
    const getter = vi.fn((): ChromePermissionsApi => { throw new Error("API getter was read twice") }).mockImplementationOnce(() => api)
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", { get permissions() { return getter() } })), () => Effect.sync(() => vi.unstubAllGlobals()))
    const service = yield* ChromePermissions.pipe(Effect.provide(layerLive))
    expect(getter).toHaveBeenCalledTimes(1)
    expect(yield* service.getAll).toBe(permissions)
  }))

  it.effect.each(["onAdded", "onRemoved"] as const)("types lazy %s accessor failures and permits recovery", (operation) => Effect.gen(function*() {
    const api = mockApi()
    const source = api[operation]
    const cause = new Error("event accessor unavailable")
    let unavailable = true

    const getter = vi.fn(() => {
      if (unavailable) throw cause

      return source
    })

    Object.defineProperty(api, operation, { get: getter })
    const stream = make(api)[operation]

    expect(getter).not.toHaveBeenCalled()
    expect(yield* Effect.flip(Stream.runDrain(stream))).toMatchObject({ operation, cause })
    unavailable = false
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 1)))

    yield* Effect.promise(() => source.added)
    source.emit(permissions)
    expect(yield* Fiber.join(fiber)).toEqual([permissions])
    expect(source.listeners.size).toBe(0)
  }))

  it.effect.each(["onAdded", "onRemoved"] as const)("churns 512 concurrent %s subscriptions across 65536 burst events", (operation) => Effect.gen(function*() {
    const api = mockApi()
    const source = api[operation]
    const stream = make(api)[operation]

    for (let round = 0; round < 16; round++) {
      let ready!: () => void
      const registered = new Promise<void>((resolve) => { ready = resolve })
      source.addListener.mockImplementation((listener) => {
        source.listeners.add(listener)

        if (source.listeners.size === 32) ready()
      })
      const fibers = yield* Effect.forEach(Array.from({ length: 32 }), () => Effect.forkScoped(Stream.runDrain(stream)))
      yield* Effect.promise(() => registered)
      expect(source.listeners.size).toBe(32)

      for (let index = 0; index < 4096; index++) source.emit({ origins: [`https://round-${round}-${index}.example/*`] })
      yield* Effect.forEach(fibers, Fiber.interrupt, { concurrency: "unbounded" })
      expect(source.listeners.size).toBe(0)
    }

    expect(source.addListener).toHaveBeenCalledTimes(512)
    expect(source.removeListener.mock.calls).toEqual(source.addListener.mock.calls)
  }))

  it.effect("replays a single gesture outcome to 4096 concurrent observers", () => Effect.gen(function*() {
    const api = mockApi()
    api.request.mockResolvedValue(false)
    const outcome = make(api).requestFromUserGesture(permissions)
    expect(api.request).toHaveBeenCalledExactlyOnceWith(permissions)
    const results = yield* Effect.forEach(Array.from({ length: 4096 }), () => outcome, { concurrency: 64 })
    expect(results).toEqual(Array.from({ length: 4096 }, () => false))
    expect(api.request).toHaveBeenCalledTimes(1)
  }))

  it.effect("types method and global access getter failures", () => Effect.gen(function*() {
    const cause = new Error("access denied")
    const api = mockApi()
    Object.defineProperty(api, "request", { get: () => { throw cause } })
    const service = make(api)
    expect(yield* Effect.flip(service.request(permissions))).toMatchObject({ operation: "request", cause })
    expect(yield* Effect.flip(service.requestFromUserGesture(permissions))).toMatchObject({ operation: "request", cause })
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", { get permissions() { throw cause } })), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromePermissions.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize", cause })
  }))

  it.effect("injects the service and keeps ordinary effects lazy and fresh", () => Effect.gen(function*() {
    const api = mockApi()
    const service = make(api)
    const calls = [service.contains(permissions), service.request(permissions), service.remove(permissions)]
    expect(api.getAll).not.toHaveBeenCalled()
    expect(api.request).not.toHaveBeenCalled()
    expect(yield* service.getAll).toBe(permissions)
    api.getAll.mockResolvedValueOnce({})
    expect(yield* service.getAll).toEqual({})

    for (const call of calls) {
      expect(yield* call).toBe(true)
      expect(yield* call).toBe(true)
    }

    for (const method of [api.contains, api.request, api.remove]) {
      expect(method).toHaveBeenCalledTimes(2)
      expect(method).toHaveBeenLastCalledWith(permissions)
    }

    yield* Effect.gen(function*() {
      const injected = yield* ChromePermissions
      expect(yield* injected.getAll).toBe(permissions)
    }).pipe(Effect.provide(layer(api)))
  }))

  it.effect("returns false for absence, denial, and unsuccessful removal", () => Effect.gen(function*() {
    const api = mockApi()
    api.contains.mockResolvedValue(false)
    api.request.mockResolvedValue(false)
    api.remove.mockResolvedValue(false)
    const service = make(api)
    expect(yield* service.contains(permissions)).toBe(false)
    expect(yield* service.request(permissions)).toBe(false)
    expect(yield* service.remove(permissions)).toBe(false)
    expect(yield* service.requestFromUserGesture(permissions)).toBe(false)
  }))

  it.effect.each(["getAll", "contains", "request", "remove"] as const)(
    "preserves synchronous throws and rejections for %s", (operation) => Effect.gen(function*() {
      for (const synchronous of [true, false]) {
        const cause = new Error(`${operation} failed`)

        const fail = () => {
          if (synchronous) throw cause

          return Promise.reject(cause)
        }

        const api: ChromePermissionsApi = { ...mockApi(), [operation]: fail }
        const service = make(api)

        const effects = {
          getAll: Effect.asVoid(service.getAll), contains: Effect.asVoid(service.contains(permissions)),
          request: Effect.asVoid(service.request(permissions)), remove: Effect.asVoid(service.remove(permissions))
        }

        const error = yield* Effect.flip(effects[operation])
        expect(error).toBeInstanceOf(ChromePermissionsError)
        expect(error.operation).toBe(operation)
        expect(error.cause).toBe(cause)
      }
    })
  )

  // A synchronous Chrome gesture callback is an intentional native boundary.
  it("initiates the gesture request before the handler returns and observes one shared outcome", async () => {
    const api = mockApi()
    let inHandler = false
    api.request.mockImplementation(() => {
      expect(inHandler).toBe(true)

      return Promise.resolve(false)
    })
    const service = make(api)

    const clickHandler = () => {
      inHandler = true
      const outcome = service.requestFromUserGesture(permissions)
      expect(api.request).toHaveBeenCalledExactlyOnceWith(permissions)
      inHandler = false

      return outcome
    }

    const outcome = clickHandler()
    expect(await Effect.runPromise(outcome)).toBe(false)
    expect(await Effect.runPromise(outcome)).toBe(false)
    expect(api.request).toHaveBeenCalledTimes(1)
  })

  it.effect("captures gesture bridge throws and rejections without reissuing requests", () => Effect.gen(function*() {
    for (const synchronous of [true, false]) {
      const api = mockApi()
      const cause = new Error("gesture request failed")
      api.request.mockImplementation(() => {
        if (synchronous) throw cause

        return Promise.reject(cause)
      })
      const outcome = make(api).requestFromUserGesture(permissions)

      for (let index = 0; index < 2; index++) {
        const error = yield* Effect.flip(outcome)
        expect(error.operation).toBe("request")
        expect(error.cause).toBe(cause)
      }

      expect(api.request).toHaveBeenCalledTimes(1)
    }
  }))

  // AbortSignal is an intentional Promise runner boundary, not an Effect deadline.
  it("interrupts waiting for a gesture request without losing its late rejection", async () => {
    const api = mockApi()
    let reject!: (cause: Error) => void
    const pending = new Promise<boolean>((_resolve, fail) => { reject = fail })
    api.request.mockReturnValue(pending)
    const outcome = make(api).requestFromUserGesture(permissions)
    const controller = new AbortController()
    const result = Effect.runPromiseExit(outcome, { signal: controller.signal })
    controller.abort()
    expect((await result)._tag).toBe("Failure")
    const cause = new Error("request rejected after interruption")
    reject(cause)
    const error = await Effect.runPromise(Effect.flip(outcome))
    expect(error.operation).toBe("request")
    expect(error.cause).toBe(cause)
    expect(api.request).toHaveBeenCalledTimes(1)
  })

  it.effect.each(["onAdded", "onRemoved"] as const)("delivers %s and cleans up after consumption", (operation) => Effect.gen(function*() {
    const api = mockApi()
    const source = api[operation]
    const stream = make(api)[operation]
    expect(source.listeners.size).toBe(0)
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 1)))
    yield* Effect.promise(() => source.added)
    source.emit(permissions)
    expect(yield* Fiber.join(fiber)).toEqual([permissions])
    expect(source.listeners.size).toBe(0)
    expect(source.removeListener.mock.calls).toEqual(source.addListener.mock.calls)
  }))

  it.effect.each(["onAdded", "onRemoved"] as const)("bounds %s to the newest 64 of 4096 startup events", (operation) => Effect.gen(function*() {
    const api = mockApi()
    const source = api[operation]
    source.addListener.mockImplementation((listener) => {
      source.listeners.add(listener)

      for (let index = 0; index < 4096; index++) listener({ origins: [`https://host-${index}.example/*`] })
    })
    const values = yield* Stream.runCollect(Stream.take(make(api)[operation], 64))
    expect(values).toEqual(Array.from({ length: 64 }, (_, index) => ({ origins: [`https://host-${index + 4032}.example/*`] })))
    expect(source.listeners.size).toBe(0)
  }))

  it.effect.each(["onAdded", "onRemoved"] as const)("cleans partial %s registration and supports resubscription", (operation) => Effect.gen(function*() {
    const api = mockApi()
    const source = api[operation]
    const cause = new Error("partial registration")
    source.addListener.mockImplementationOnce((listener) => {
      source.listeners.add(listener)
      listener(permissions)
      throw cause
    })
    const stream = make(api)[operation]
    const error = yield* Effect.flip(Stream.runDrain(stream))
    expect(error.operation).toBe(operation)
    expect(error.cause).toBe(cause)
    expect(source.listeners.size).toBe(0)
    source.addListener.mockImplementationOnce((listener) => {
      source.listeners.add(listener)
      listener(permissions)
    })
    expect(yield* Stream.runCollect(Stream.take(stream, 1))).toEqual([permissions])
    expect(source.listeners.size).toBe(0)
    expect(source.removeListener.mock.calls).toEqual(source.addListener.mock.calls)
  }))

  it.effect.each(["onAdded", "onRemoved"] as const)("ignores late %s callbacks during and after interruption cleanup", (operation) => Effect.gen(function*() {
    const api = mockApi()
    const source = api[operation]
    const received: Array<chrome.permissions.Permissions> = []
    source.removeListener.mockImplementation((listener) => {
      listener(permissions)
      source.listeners.delete(listener)
      listener(permissions)
    })
    const stream = Stream.tap(make(api)[operation], (value) => Effect.sync(() => { received.push(value) }))
    const fiber = yield* Effect.forkScoped(Stream.runDrain(stream))
    yield* Effect.promise(() => source.added)
    yield* Fiber.interrupt(fiber)

    for (const [listener] of source.addListener.mock.calls) listener(permissions)
    expect(received).toEqual([])
    expect(source.listeners.size).toBe(0)
    expect(source.removeListener.mock.calls).toEqual(source.addListener.mock.calls)
  }))

  it.effect("accesses Chrome only when the live layer is built", () => Effect.gen(function*() {
    vi.stubGlobal("chrome", undefined)
    const error = yield* Effect.flip(ChromePermissions.pipe(Effect.provide(layerLive)))
    expect(error.operation).toBe("initialize")
    vi.stubGlobal("chrome", {})
    expect((yield* Effect.flip(ChromePermissions.pipe(Effect.provide(layerLive)))).operation).toBe("initialize")
    const api = mockApi()
    vi.stubGlobal("chrome", { permissions: api })
    expect(yield* Effect.gen(function*() {
      const service = yield* ChromePermissions

      return yield* service.getAll
    }).pipe(Effect.provide(layerLive))).toBe(permissions)
  }))

  it.effect("adds and removes host access requests lazily", () => Effect.gen(function*() {
    const addHostAccessRequest = vi.fn(async (_request: chrome.permissions.AddHostAccessRequest) => {})
    const removeHostAccessRequest = vi.fn(async (_request: chrome.permissions.RemoveHostAccessRequest) => {})
    const service = make({ ...mockApi(), addHostAccessRequest, removeHostAccessRequest })
    const add = service.addHostAccessRequest({ tabId: 7, pattern: "https://example.com/*" })
    expect(addHostAccessRequest).not.toHaveBeenCalled()
    yield* add
    yield* service.removeHostAccessRequest({ documentId: "doc", pattern: "https://example.com/*" })
    expect(addHostAccessRequest).toHaveBeenCalledExactlyOnceWith({ tabId: 7, pattern: "https://example.com/*" })
    expect(removeHostAccessRequest).toHaveBeenCalledExactlyOnceWith({ documentId: "doc", pattern: "https://example.com/*" })
    const cause = new Error("Extension cannot request access to this host.")
    addHostAccessRequest.mockRejectedValueOnce(cause)
    const error = yield* Effect.flip(service.addHostAccessRequest({ tabId: 7 }))
    expect(error).toBeInstanceOf(ChromePermissionsError)
    expect(error).toMatchObject({ operation: "addHostAccessRequest", cause })
  }))

  it.effect("types host access request members absent before Chrome 133", () => Effect.gen(function*() {
    const service = make(mockApi())
    expect(yield* Effect.flip(service.addHostAccessRequest({ tabId: 1 }))).toMatchObject({ operation: "addHostAccessRequest" })
    expect(yield* Effect.flip(service.removeHostAccessRequest({ tabId: 1 }))).toMatchObject({ operation: "removeHostAccessRequest" })
  }))
})
