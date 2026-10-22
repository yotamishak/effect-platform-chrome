// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeStorage, ChromeStorageError, changeBufferSize, layer, make } from "../src/ChromeStorage.js"
import * as ChromeStorageModule from "../src/ChromeStorage.js"
import { makeStorage } from "../src/testing/Storage.js"

const fixture = () => {
  type Listener = (changes: Record<string, chrome.storage.StorageChange>, area: chrome.storage.AreaName) => void

  const listeners = new Set<Listener>()

  const onChanged = {
    addListener: vi.fn((listener: Listener) => { listeners.add(listener) }),
    removeListener: vi.fn((listener: Listener) => { listeners.delete(listener) })
  }

  const area = () => ({
    get: vi.fn(async () => ({ key: "value" })),
    set: vi.fn(async (_items: Record<string, unknown>) => {}),
    remove: vi.fn(async (_keys: string | Array<string>) => {}),
    clear: vi.fn(async () => {}),
    getBytesInUse: vi.fn(async () => 17)
  })

  const raw = { local: area(), sync: area(), session: area(), managed: area(), onChanged }

  return {
    raw,
    api: raw,
    listeners,
    emit: (changes: Record<string, chrome.storage.StorageChange>, area: chrome.storage.AreaName) => {
      for (const listener of listeners) listener(changes, area)
    }
  }
}

describe("ChromeStorage", () => {
  it.effect("imports without chrome and resolves the live global lazily", () => Effect.gen(function*() {
    vi.stubGlobal("chrome", undefined)
    expect(yield* Effect.promise(() => import("../src/ChromeStorage.js"))).toBeDefined()

    const failure = yield* ChromeStorage.pipe(Effect.provide(layer), Effect.flip)

    expect(failure).toBeInstanceOf(ChromeStorageError)
    expect(failure.operation).toBe("initialize")
    const f = fixture()
    vi.stubGlobal("chrome", { storage: f.api })

    const result = yield* Effect.gen(function*() {
      const storage = yield* ChromeStorage

      return yield* storage.local.get()
    }).pipe(Effect.provide(layer))

    expect(result).toEqual({ key: "value" })
  }))

  it.effect.each(["local", "sync", "session"] as const)("provides deferred read/write operations for %s", (name) => Effect.gen(function*() {
    const f = fixture()
    const area = make(f.api)[name]
    const write = area.set({ key: "new" })
    expect(f.raw[name].set).not.toHaveBeenCalled()
    yield* write
    expect(f.raw[name].set).toHaveBeenCalledWith({ key: "new" })
    expect(yield* area.get({ missing: "default" })).toEqual({ key: "value" })
    expect(f.raw[name].get).toHaveBeenCalledWith({ missing: "default" })
    expect(yield* area.getBytesInUse(["key"])).toBe(17)
    expect(f.raw[name].getBytesInUse).toHaveBeenCalledWith(["key"])
    yield* area.remove(["key"])
    yield* area.clear
    expect(f.raw[name].remove).toHaveBeenCalledWith(["key"])
    expect(f.raw[name].clear).toHaveBeenCalledOnce()
  }))

  it.effect("exposes only reads and changes for managed storage", () => Effect.gen(function*() {
    const f = fixture()
    const managed = make(f.api).managed
    expect(managed).not.toHaveProperty("set")
    expect(managed).not.toHaveProperty("remove")
    expect(managed).not.toHaveProperty("clear")
    expect(yield* managed.get()).toEqual({ key: "value" })
    expect(yield* managed.getBytesInUse()).toBe(17)
    expect(f.raw.managed.set).not.toHaveBeenCalled()
  }))

  it.effect("preserves rejection and synchronous throw causes with area and operation", () => Effect.gen(function*() {
    const f = fixture()
    const cause = new Error("quota exceeded")
    f.raw.sync.set.mockRejectedValueOnce(cause)
    const storage = make(f.api)
    const rejected = yield* storage.sync.set({ key: 1 }).pipe(Effect.flip)
    expect(rejected).toBeInstanceOf(ChromeStorageError)
    expect(rejected).toMatchObject({ area: "sync", operation: "set", cause })
    f.raw.local.get.mockImplementationOnce(() => { throw cause })
    const thrown = yield* storage.local.get().pipe(Effect.flip)
    expect(thrown).toMatchObject({ area: "local", operation: "get", cause })
  }))

  it.effect("filters area events and removes the listener after normal completion", () => Effect.gen(function*() {
    const f = fixture()
    f.raw.onChanged.addListener.mockImplementationOnce((listener) => {
      f.listeners.add(listener)
      listener({ ignored: { newValue: 0 } }, "sync")
      listener({ key: { oldValue: 1, newValue: 2 } }, "local")
    })
    const storage = make(f.api)
    expect(f.listeners.size).toBe(0)
    const result = yield* Stream.runCollect(Stream.take(storage.local.onChanged, 1))
    expect(result).toEqual([{ area: "local", changes: { key: { oldValue: 1, newValue: 2 } } }])
    expect(f.listeners.size).toBe(0)
    expect(f.raw.onChanged.removeListener).toHaveBeenCalledOnce()
  }))

  it.effect("uses a bounded sliding buffer and includes the originating area", () => Effect.gen(function*() {
    const f = fixture()
    f.raw.onChanged.addListener.mockImplementationOnce((listener) => {
      f.listeners.add(listener)

      for (let i = 0; i < changeBufferSize + 3; i++) listener({ key: { newValue: i } }, "managed")
    })
    const result = yield* Stream.runCollect(Stream.take(make(f.api).onChanged, changeBufferSize))
    expect(result).toHaveLength(changeBufferSize)
    expect(result[0]).toEqual({ area: "managed", changes: { key: { newValue: 3 } } })
    expect(f.listeners.size).toBe(0)
  }))

  it.effect("types listener registration errors", () => Effect.gen(function*() {
    const f = fixture()
    const cause = new Error("unavailable")
    f.raw.onChanged.addListener.mockImplementationOnce(() => { throw cause })
    const error = yield* Stream.runCollect(make(f.api).onChanged).pipe(Effect.flip)
    expect(error).toMatchObject({ operation: "onChanged.addListener", area: "all", cause })
    expect(f.listeners.size).toBe(0)
  }))

  it.effect("removes listeners when a waiting consumer is interrupted", () => Effect.gen(function*() {
    const f = fixture()
    let registered!: () => void
    const registration = new Promise<void>((resolve) => { registered = resolve })
    f.raw.onChanged.addListener.mockImplementationOnce((listener) => {
      f.listeners.add(listener)
      registered()
    })
    const fiber = yield* Effect.forkScoped(Stream.runDrain(make(f.api).onChanged))
    yield* Effect.promise(() => registration)
    expect(f.listeners.size).toBe(1)
    yield* Fiber.interrupt(fiber)
    expect(f.listeners.size).toBe(0)
    expect(f.raw.onChanged.removeListener).toHaveBeenCalledOnce()
  }))

  it.effect.each([false, true])("types all API failures, including synchronous=%s, without leaking to other areas", (synchronous) => Effect.gen(function*() {
    const f = fixture()
    const cause = new Error("Storage access denied or injected quota exceeded")

    const fail = () => {
      if (synchronous) throw cause

      return Promise.reject(cause)
    }

    for (const name of ["local", "sync", "session", "managed"] as const) {
      const raw = f.raw[name]
      raw.get.mockImplementation(fail)
      raw.getBytesInUse.mockImplementation(fail)
      raw.set.mockImplementation(fail)
      raw.remove.mockImplementation(fail)
      raw.clear.mockImplementation(fail)
      const storage = make(f.api)
      const area = storage[name]
      const operations = [["get", Effect.asVoid(area.get())], ["getBytesInUse", Effect.asVoid(area.getBytesInUse())]] as const

      for (const [operation, effect] of operations) {
        expect(yield* Effect.flip(effect)).toMatchObject({ area: name, operation, cause })
      }

      if (name !== "managed") {
        const writable = storage[name]

        for (const [operation, effect] of [["set", writable.set({ key: 1 })], ["remove", writable.remove("key")], ["clear", writable.clear]] as const) {
          expect(yield* Effect.flip(effect)).toMatchObject({ area: name, operation, cause })
        }
      }
    }
  }))

  it.effect("defers missing managed-area access and keeps available areas usable", () => Effect.gen(function*() {
    const f = fixture()
    Reflect.deleteProperty(f.api, "managed")
    const storage = make(f.api)
    expect(yield* storage.local.get()).toEqual({ key: "value" })

    for (const [operation, effect] of [["get", Effect.asVoid(storage.managed.get())], ["getBytesInUse", Effect.asVoid(storage.managed.getBytesInUse())]] as const) {
      const error = yield* Effect.flip(effect)
      expect(error).toMatchObject({ area: "managed", operation })
      expect(error.cause).toBeInstanceOf(TypeError)
    }
  }))

  it.effect("passes empty, Unicode and dangerous own keys through the native storage boundary", () => Effect.gen(function*() {
    const f = fixture()
    const items = { ["__proto__"]: "safe", constructor: "own", "": "empty", "🌍": "unicode" }
    const storage = make(f.api)
    yield* storage.session.set(items)
    expect(f.raw.session.set).toHaveBeenCalledWith(items)
    expect(Object.hasOwn(f.raw.session.set.mock.calls[0]![0], "__proto__")).toBe(true)
    yield* storage.session.get(["", "🌍", "__proto__", "constructor"])
    expect(f.raw.session.get).toHaveBeenCalledWith(["", "🌍", "__proto__", "constructor"])
    expect(f.raw.local.set).not.toHaveBeenCalled()
    expect(f.raw.sync.set).not.toHaveBeenCalled()
  }))

  it.effect("retains every event in a burst exactly at capacity", () => Effect.gen(function*() {
    const f = fixture()
    f.raw.onChanged.addListener.mockImplementationOnce((listener) => {
      f.listeners.add(listener)

      for (let index = 0; index < 64; index++) listener({ key: { newValue: index } }, "local")
    })
    const result = yield* Stream.runCollect(Stream.take(make(f.api).onChanged, 64))
    expect(result.map((event) => event.changes.key!.newValue)).toEqual(Array.from({ length: 64 }, (_, index) => index))
    expect(f.listeners.size).toBe(0)
  }))

  it.effect("gives simultaneous subscriptions independent listeners and cleanup", () => Effect.gen(function*() {
    const f = fixture()
    let registered!: () => void
    const ready = new Promise<void>((resolve) => { registered = resolve })
    f.raw.onChanged.addListener.mockImplementation((listener) => {
      f.listeners.add(listener)

      if (f.listeners.size === 2) registered()
    })
    const stream = make(f.api).local.onChanged
    const first = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 1)))
    const second = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 2)))
    yield* Effect.promise(() => ready)
    f.emit({ key: { newValue: 1 } }, "local")
    expect(yield* Fiber.join(first)).toEqual([{ area: "local", changes: { key: { newValue: 1 } } }])
    expect(f.listeners.size).toBe(1)
    f.emit({ ignored: { newValue: 0 } }, "sync")
    f.emit({ key: { newValue: 2 } }, "local")
    expect(yield* Fiber.join(second)).toEqual([
      { area: "local", changes: { key: { newValue: 1 } } },
      { area: "local", changes: { key: { newValue: 2 } } }
    ])
    expect(f.listeners.size).toBe(0)
    expect(f.raw.onChanged.removeListener).toHaveBeenCalledTimes(2)
    const removed = f.raw.onChanged.removeListener.mock.calls.map(([listener]) => listener)
    expect(new Set(removed).size).toBe(2)
  }))

  it.effect("cleans up listeners when downstream consumption fails", () => Effect.gen(function*() {
    const f = fixture()
    f.raw.onChanged.addListener.mockImplementationOnce((listener) => {
      f.listeners.add(listener)
      listener({ key: { newValue: 1 } }, "session")
    })
    const cause = new Error("Consumer failed")
    const consumed = Stream.mapEffect(make(f.api).onChanged, () => Effect.fail(cause))
    expect(yield* Stream.runDrain(consumed).pipe(Effect.flip)).toBe(cause)
    expect(f.listeners.size).toBe(0)
    expect(f.raw.onChanged.removeListener).toHaveBeenCalledOnce()
  }))

  it.effect("sets an area's access level and types a missing or rejected setter", () => Effect.gen(function*() {
    const { raw } = fixture()
    const setAccessLevel = vi.fn(async (_options: { readonly accessLevel: ChromeStorageModule.AccessLevel }) => {})
    const storage = make({ ...raw, local: { ...raw.local, setAccessLevel } })
    yield* storage.local.setAccessLevel("TRUSTED_CONTEXTS")
    expect(setAccessLevel).toHaveBeenCalledExactlyOnceWith({ accessLevel: "TRUSTED_CONTEXTS" })
    expect(yield* Effect.flip(storage.session.setAccessLevel("TRUSTED_CONTEXTS"))).toMatchObject({
      operation: "setAccessLevel", area: "session"
    })
    const cause = new Error("Access level not supported")
    setAccessLevel.mockRejectedValueOnce(cause)
    expect(yield* Effect.flip(storage.local.setAccessLevel("TRUSTED_AND_UNTRUSTED_CONTEXTS"))).toMatchObject({ cause })
  }))

  it("names the live layer layerLive, as the other modules do", () => {
    expect(ChromeStorageModule.layerLive).toBe(layer)
  })

  it.effect.each(["local", "sync", "session", "managed"] as const)("lists %s keys lazily and types a missing or rejected getKeys", (name) => Effect.gen(function*() {
    const { raw } = fixture()
    const getKeys = vi.fn(async () => ["a", "b"])
    const storage = make({ ...raw, [name]: { ...raw[name], getKeys } })
    const keys = storage[name].getKeys
    expect(getKeys).not.toHaveBeenCalled()
    expect(yield* keys).toEqual(["a", "b"])
    expect(raw[name].get).not.toHaveBeenCalled()
    const cause = new Error("getKeys failed")
    getKeys.mockRejectedValueOnce(cause)
    expect(yield* Effect.flip(keys)).toMatchObject({ area: name, operation: "getKeys", cause })
    const missing = yield* Effect.flip(make(raw)[name].getKeys)
    expect(missing).toBeInstanceOf(ChromeStorageError)
    expect(missing).toMatchObject({ area: name, operation: "getKeys" })
  }))

  it.effect("lists fixture keys for every area and injects getKeys failures", () => Effect.gen(function*() {
    const fixture = makeStorage()
    const storage = make(fixture.api)
    yield* storage.local.set({ b: 2, a: 1 })
    fixture.controls.seed("managed", { policy: true })
    expect(yield* storage.local.getKeys).toEqual(["b", "a"])
    expect(yield* storage.managed.getKeys).toEqual(["policy"])
    expect(yield* storage.session.getKeys).toEqual([])
    const cause = new Error("quota")
    fixture.controls.failNext("sync", "getKeys", cause)
    expect(yield* Effect.flip(storage.sync.getKeys)).toMatchObject({ area: "sync", operation: "getKeys", cause })
    expect(yield* storage.sync.getKeys).toEqual([])
  }))
})
