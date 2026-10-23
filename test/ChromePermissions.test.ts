// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Exit, Fiber, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromePermissions, ChromePermissionsError, layer, layerLive, make } from "../src/ChromePermissions.js"
import type {
  AddHostAccessRequest, ChromePermissionsApi, ChromePermissionsService, Permissions, RemoveHostAccessRequest
} from "../src/ChromePermissions.js"
import { makeEvent } from "../src/testing/Event.js"

const permissions: Permissions = { permissions: ["tabs"], origins: ["https://example.com/*"] }

const mockApi = () => {
  const onAdded = makeEvent<[Permissions]>()
  const onRemoved = makeEvent<[Permissions]>()

  const api = {
    getAll: vi.fn(async (): Promise<Permissions> => permissions),
    contains: vi.fn(async (_permissions: Permissions) => true),
    request: vi.fn(async (_permissions: Permissions) => true),
    remove: vi.fn(async (_permissions: Permissions) => true),
    addHostAccessRequest: vi.fn(async (_request: chrome.permissions.AddHostAccessRequest) => {}),
    removeHostAccessRequest: vi.fn(async (_request: chrome.permissions.RemoveHostAccessRequest) => {}),
    onAdded: onAdded.api,
    onRemoved: onRemoved.api
  } satisfies ChromePermissionsApi

  return { api, events: { onAdded: onAdded.controls, onRemoved: onRemoved.controls } }
}

type Method = "getAll" | "contains" | "request" | "remove" | "addHostAccessRequest" | "removeHostAccessRequest"

/** Runs one service operation as Effect<void>, with arguments, keyed by its Chrome member. */
const call = (service: ChromePermissionsService, method: Method): Effect.Effect<void, ChromePermissionsError> => {
  switch (method) {
    case "getAll": return Effect.asVoid(service.getAll)
    case "contains": return Effect.asVoid(service.contains(permissions))
    case "request": return Effect.asVoid(service.request(permissions))
    case "remove": return Effect.asVoid(service.remove(permissions))
    case "addHostAccessRequest": return service.addHostAccessRequest({ tabId: 7 })
    case "removeHostAccessRequest": return service.removeHostAccessRequest({ tabId: 7 })
  }
}

const methods: ReadonlyArray<Method> = ["getAll", "contains", "request", "remove", "addHostAccessRequest", "removeHostAccessRequest"]

describe("ChromePermissions", () => {
  it.effect("passes each call through unchanged and returns Chrome's result", () => Effect.gen(function*() {
    const { api } = mockApi()
    const service = make(api)
    expect(yield* service.getAll).toBe(permissions)
    expect(yield* service.contains(permissions)).toBe(true)
    expect(yield* service.request(permissions)).toBe(true)
    expect(yield* service.remove(permissions)).toBe(true)
    yield* service.addHostAccessRequest({ tabId: 7, pattern: "https://example.com/*" })
    yield* service.removeHostAccessRequest({ documentId: "doc", pattern: "https://example.com/*" })
    expect(api.getAll).toHaveBeenCalledExactlyOnceWith()

    for (const method of [api.contains, api.request, api.remove]) expect(method).toHaveBeenCalledExactlyOnceWith(permissions)
    expect(api.addHostAccessRequest).toHaveBeenCalledExactlyOnceWith({ tabId: 7, pattern: "https://example.com/*" })
    expect(api.removeHostAccessRequest).toHaveBeenCalledExactlyOnceWith({ documentId: "doc", pattern: "https://example.com/*" })
  }))

  it.effect("keeps every operation lazy and re-runs Chrome on each execution", () => Effect.gen(function*() {
    const { api } = mockApi()
    const service = make(api)
    const effects = methods.map((method) => call(service, method))

    for (const method of methods) expect(api[method]).not.toHaveBeenCalled()

    for (const effect of effects) {
      yield* effect
      yield* effect
    }

    for (const method of methods) expect(api[method]).toHaveBeenCalledTimes(2)
    api.getAll.mockResolvedValueOnce({})
    expect(yield* service.getAll).toEqual({})
  }))

  it.effect("returns false for absence, denial and unsuccessful removal", () => Effect.gen(function*() {
    const { api } = mockApi()
    api.contains.mockResolvedValue(false)
    api.request.mockResolvedValue(false)
    api.remove.mockResolvedValue(false)
    const service = make(api)
    expect(yield* service.contains(permissions)).toBe(false)
    expect(yield* service.request(permissions)).toBe(false)
    expect(yield* service.remove(permissions)).toBe(false)
    expect(yield* service.requestFromUserGesture(permissions)).toBe(false)
  }))

  it.effect.each(methods)("maps a rejection and a synchronous throw from %s to the typed error", (method) => Effect.gen(function*() {
    for (const synchronous of [false, true]) {
      const { api } = mockApi()
      const cause = new Error(`${method} failed`)

      vi.mocked(api[method]).mockImplementation(() => {
        if (synchronous) throw cause

        return Promise.reject(cause)
      })

      const error = yield* Effect.flip(call(make(api), method))
      expect(error).toBeInstanceOf(ChromePermissionsError)
      expect(error.operation).toBe(method)
      expect(error.cause).toBe(cause)
    }
  }))

  it.effect.each(methods)("types a throwing %s accessor instead of throwing from make", (method) => Effect.gen(function*() {
    const { api } = mockApi()
    const cause = new Error("access denied")
    Object.defineProperty(api, method, { get: () => { throw cause } })
    const service = make(api)
    expect(yield* Effect.flip(call(service, method))).toMatchObject({ operation: method, cause })
  }))

  it.effect.each(["addHostAccessRequest", "removeHostAccessRequest"] as const)(
    "fails %s with a typed error when the browser predates Chrome 133", (method) => Effect.gen(function*() {
      const { api } = mockApi()
      const { [method]: _absent, ...older } = api
      const error = yield* Effect.flip(call(make(older), method))
      expect(error).toBeInstanceOf(ChromePermissionsError)
      expect(error.operation).toBe(method)
      expect(String(error.cause)).toContain(`permissions.${method} is unavailable`)
    })
  )

  it.effect("types host access requests as exactly one of a tab or a document, as Chrome requires", () => Effect.gen(function*() {
    const { api } = mockApi()
    const service = make(api)
    const valid: ReadonlyArray<AddHostAccessRequest> = [{ tabId: 7 }, { documentId: "doc", pattern: "https://example.com/*" }]
    const removals: ReadonlyArray<RemoveHostAccessRequest> = [{ tabId: 7, pattern: "https://example.com/*" }, { documentId: "doc" }]
    // @ts-expect-error Chrome rejects a request naming neither: "Must specify either 'documentId' or 'tabId'."
    const neither: AddHostAccessRequest = { pattern: "https://example.com/*" }
    // @ts-expect-error Chrome rejects a request naming both a tab and a document.
    const both: AddHostAccessRequest = { tabId: 7, documentId: "doc" }
    // @ts-expect-error The same rule holds when withdrawing a request.
    const removeBoth: RemoveHostAccessRequest = { tabId: 7, documentId: "doc" }
    // @ts-expect-error The same rule holds when withdrawing a request.
    const removeNeither: RemoveHostAccessRequest = {}

    yield* Effect.forEach(valid, service.addHostAccessRequest, { discard: true })
    yield* Effect.forEach(removals, service.removeHostAccessRequest, { discard: true })
    expect(api.addHostAccessRequest.mock.calls).toEqual(valid.map((request) => [request]))
    expect(api.removeHostAccessRequest.mock.calls).toEqual(removals.map((request) => [request]))
    // Chrome still validates at runtime; a value that slips past the types is passed through unchanged.
    expect([neither, both, removeBoth, removeNeither]).toHaveLength(4)
  }))

  describe("requestFromUserGesture", () => {
    it.effect("calls Chrome before the Effect runs and replays one outcome", () => Effect.gen(function*() {
      const { api } = mockApi()
      const service = make(api)
      const outcome = service.requestFromUserGesture(permissions)
      expect(api.request).toHaveBeenCalledExactlyOnceWith(permissions)
      expect(yield* outcome).toBe(true)
      expect(yield* outcome).toBe(true)
      expect(api.request).toHaveBeenCalledOnce()
      const lazy = service.request(permissions)
      expect(api.request).toHaveBeenCalledOnce()
      yield* lazy
      expect(api.request).toHaveBeenCalledTimes(2)
    }))

    // A synchronous click handler is an intentional native boundary.
    it("starts the request on the handler's synchronous stack", async () => {
      const { api } = mockApi()
      let inHandler = false
      api.request.mockImplementation(async () => {
        expect(inHandler).toBe(true)

        return false
      })
      const service = make(api)

      const onClick = () => {
        inHandler = true
        const outcome = service.requestFromUserGesture(permissions)
        inHandler = false

        return outcome
      }

      const outcome = onClick()
      expect(await Effect.runPromise(outcome)).toBe(false)
      expect(api.request).toHaveBeenCalledOnce()
    })

    it.effect("types a rejection and a synchronous throw as request, without re-requesting", () => Effect.gen(function*() {
      for (const synchronous of [false, true]) {
        const { api } = mockApi()
        const cause = new Error("This function must be called during a user gesture")
        api.request.mockImplementation(() => {
          if (synchronous) throw cause

          return Promise.reject(cause)
        })
        const outcome = make(api).requestFromUserGesture(permissions)

        for (let round = 0; round < 2; round++) {
          const error = yield* Effect.flip(outcome)
          expect(error).toBeInstanceOf(ChromePermissionsError)
          expect(error).toMatchObject({ operation: "request", cause })
        }

        expect(api.request).toHaveBeenCalledOnce()
      }
    }))

    it.effect("never throws on the handler's stack when the request accessor throws", () => Effect.gen(function*() {
      const { api } = mockApi()
      const cause = new Error("Extension context invalidated.")
      Object.defineProperty(api, "request", { get: () => { throw cause } })
      const outcome = make(api).requestFromUserGesture(permissions)
      expect(yield* Effect.flip(outcome)).toMatchObject({ operation: "request", cause })
    }))

    it.effect("stops waiting when interrupted and still reports the late outcome", () => Effect.gen(function*() {
      const { api } = mockApi()
      let answer!: (granted: boolean) => void
      api.request.mockImplementation(() => new Promise<boolean>((resolve) => { answer = resolve }))
      const outcome = make(api).requestFromUserGesture(permissions)
      const waiting = yield* Effect.forkChild(outcome)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(waiting)
      expect(Exit.hasInterrupts(yield* Fiber.await(waiting))).toBe(true)
      answer(true)
      expect(yield* outcome).toBe(true)
      expect(api.request).toHaveBeenCalledOnce()
    }))
  })

  describe.each(["onAdded", "onRemoved"] as const)("%s", (event) => {
    it.effect("delivers changes in order and removes its listener when the stream ends", () => Effect.gen(function*() {
      const mock = mockApi()
      const stream = make(mock.api)[event]
      expect(mock.events[event].listenerCount).toBe(0)
      const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 2)))
      yield* Effect.promise(() => mock.events[event].waitForListener())
      mock.events[event].emit(permissions)
      mock.events[event].emit({ origins: ["https://other.example/*"] })
      expect(yield* Fiber.join(fiber)).toEqual([permissions, { origins: ["https://other.example/*"] }])
      expect(mock.events[event].listenerCount).toBe(0)
    }))

    it.effect("removes its listener when interrupted and ignores late callbacks", () => Effect.gen(function*() {
      const mock = mockApi()
      const addListener = vi.spyOn(mock.api[event], "addListener")
      const received: Array<Permissions> = []
      const stream = Stream.tap(make(mock.api)[event], (value) => Effect.sync(() => { received.push(value) }))
      const fiber = yield* Effect.forkScoped(Stream.runDrain(stream))
      yield* Effect.promise(() => mock.events[event].waitForListener())
      yield* Fiber.interrupt(fiber)
      expect(mock.events[event].listenerCount).toBe(0)
      addListener.mock.calls[0]?.[0](permissions)
      expect(received).toEqual([])
    }))

    it.effect("types a registration failure, cleans a partial registration, and resubscribes", () => Effect.gen(function*() {
      const mock = mockApi()
      const cause = new Error("listener rejected")
      const source = mock.api[event]
      const add = source.addListener
      vi.spyOn(source, "addListener").mockImplementationOnce((listener) => {
        add(listener)
        throw cause
      })
      const stream = make(mock.api)[event]
      const error = yield* Effect.flip(Stream.runDrain(stream))
      expect(error).toBeInstanceOf(ChromePermissionsError)
      expect(error).toMatchObject({ operation: event, cause })
      expect(mock.events[event].listenerCount).toBe(0)
      const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 1)))
      yield* Effect.promise(() => mock.events[event].waitForListener())
      mock.events[event].emit(permissions)
      expect(yield* Fiber.join(fiber)).toEqual([permissions])
      expect(mock.events[event].listenerCount).toBe(0)
    }))

    it.effect("types a throwing event accessor lazily, per consumption", () => Effect.gen(function*() {
      const mock = mockApi()
      const cause = new Error("event accessor unavailable")
      const source = mock.api[event]
      let broken = true

      const getter = vi.fn(() => {
        if (broken) throw cause

        return source
      })

      Object.defineProperty(mock.api, event, { get: getter })
      const stream = make(mock.api)[event]
      expect(getter).not.toHaveBeenCalled()
      expect(yield* Effect.flip(Stream.runDrain(stream))).toMatchObject({ operation: event, cause })
      broken = false
      const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 1)))
      yield* Effect.promise(() => mock.events[event].waitForListener())
      mock.events[event].emit(permissions)
      expect(yield* Fiber.join(fiber)).toEqual([permissions])
    }))
  })

  it.effect("provides an injected API through layer", () => Effect.gen(function*() {
    const { api } = mockApi()
    expect(yield* Effect.flatMap(ChromePermissions, (service) => service.getAll).pipe(Effect.provide(layer(api)))).toBe(permissions)
  }))

  it.effect("fails layerLive with initialize without chrome, and builds from a fake global", () => Effect.gen(function*() {
    yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => vi.unstubAllGlobals()))
    vi.stubGlobal("chrome", undefined)
    const missing = yield* Effect.flip(ChromePermissions.pipe(Effect.provide(layerLive)))
    expect(missing).toBeInstanceOf(ChromePermissionsError)
    expect(missing.operation).toBe("initialize")
    vi.stubGlobal("chrome", {})
    expect(String((yield* Effect.flip(ChromePermissions.pipe(Effect.provide(layerLive)))).cause)).toContain("chrome.permissions is unavailable")
    const cause = new Error("access denied")
    vi.stubGlobal("chrome", { get permissions() { throw cause } })
    expect(yield* Effect.flip(ChromePermissions.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize", cause })
    const { api } = mockApi()
    const getter = vi.fn(() => api)
    vi.stubGlobal("chrome", { get permissions() { return getter() } })
    const service = yield* ChromePermissions.pipe(Effect.provide(layerLive))
    expect(yield* service.getAll).toBe(permissions)
    expect(yield* service.contains(permissions)).toBe(true)
    expect(getter).toHaveBeenCalledOnce()
  }))
})
