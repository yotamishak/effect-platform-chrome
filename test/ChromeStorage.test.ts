// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Deferred, Effect, Fiber, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeStorage, ChromeStorageError, changeBufferSize, layer, layerLive, limits, make } from "../src/ChromeStorage.js"
import type { AccessLevel, AreaName, Changes, ChromeStorageApi, Items } from "../src/ChromeStorage.js"
import { makeStorage } from "../src/testing/Storage.js"

type Listener = (changes: Changes, area: AreaName) => void

const fixture = () => {
  const listeners = new Set<Listener>()
  const gates: Array<{ readonly size: number; readonly deferred: Deferred.Deferred<void> }> = []

  const onChanged = {
    addListener: vi.fn((listener: Listener) => {
      listeners.add(listener)

      for (const gate of gates.splice(0)) {
        if (listeners.size >= gate.size) Deferred.doneUnsafe(gate.deferred, Effect.void)
        else gates.push(gate)
      }
    }),
    removeListener: vi.fn((listener: Listener) => { listeners.delete(listener) })
  }

  /** Completes once at least `size` listeners are registered at the same time. */
  const registered = (size: number): Effect.Effect<void> => Effect.suspend(() => {
    if (listeners.size >= size) return Effect.void
    const deferred = Deferred.makeUnsafe<void>()
    gates.push({ size, deferred })

    return Deferred.await(deferred)
  })

  const area = () => ({
    get: vi.fn(async (..._keys: ReadonlyArray<unknown>): Promise<Items> => ({ key: "value" })),
    getBytesInUse: vi.fn(async (..._keys: ReadonlyArray<unknown>) => 17),
    getKeys: vi.fn(async () => ["key"]),
    set: vi.fn(async (_items: Items) => {}),
    remove: vi.fn(async (_keys: string | Array<string>) => {}),
    clear: vi.fn(async () => {}),
    setAccessLevel: vi.fn(async (_options: { readonly accessLevel: AccessLevel }) => {})
  })

  const raw = { local: area(), sync: area(), session: area(), managed: area(), onChanged }
  const api: ChromeStorageApi = raw

  return {
    raw,
    api,
    listeners,
    registered,
    emit: (changes: Changes, area: AreaName) => {
      for (const listener of Array.from(listeners)) listener(changes, area)
    }
  }
}

const writableAreas = ["local", "sync", "session"] as const

const allAreas = ["local", "sync", "session", "managed"] as const

type Operation = "get" | "getBytesInUse" | "getKeys" | "set" | "remove" | "clear" | "setAccessLevel"

/** Every service call on an area, with the operation name it must report. */
const callsOn = (storage: ReturnType<typeof make>, name: AreaName): ReadonlyArray<readonly [Operation, Effect.Effect<void, ChromeStorageError>]> => {
  const reads = [
    ["get", Effect.asVoid(storage[name].get())],
    ["getBytesInUse", Effect.asVoid(storage[name].getBytesInUse())],
    ["getKeys", Effect.asVoid(storage[name].getKeys)]
  ] as const

  if (name === "managed") return reads
  const area = storage[name]

  return [
    ...reads,
    ["set", area.set({ key: 1 })],
    ["remove", area.remove("key")],
    ["clear", area.clear],
    ["setAccessLevel", area.setAccessLevel("TRUSTED_CONTEXTS")]
  ]
}

describe("ChromeStorage layers", () => {
  it.effect("imports without chrome and fails layerLive with initialize", () => Effect.gen(function*() {
    vi.stubGlobal("chrome", undefined)
    expect(yield* Effect.promise(() => import("../src/ChromeStorage.js"))).toBeDefined()

    const failure = yield* ChromeStorage.pipe(Effect.provide(layerLive), Effect.flip)

    expect(failure).toBeInstanceOf(ChromeStorageError)
    expect(failure).toMatchObject({ operation: "initialize", area: "all" })
    expect(failure.cause).toBeInstanceOf(Error)
  }))

  it.effect("fails layerLive with initialize when chrome has no storage namespace", () => Effect.gen(function*() {
    vi.stubGlobal("chrome", { runtime: {} })

    const failure = yield* ChromeStorage.pipe(Effect.provide(layerLive), Effect.flip)

    expect(failure).toBeInstanceOf(ChromeStorageError)
    expect(failure).toMatchObject({ operation: "initialize", area: "all" })
  }))

  it.effect("builds layerLive from a fake global without calling it, then uses it", () => Effect.gen(function*() {
    const f = fixture()
    vi.stubGlobal("chrome", { storage: f.api })

    const result = yield* Effect.gen(function*() {
      const storage = yield* ChromeStorage
      expect(f.raw.local.get).not.toHaveBeenCalled()
      expect(f.raw.onChanged.addListener).not.toHaveBeenCalled()

      return yield* storage.local.get("key")
    }).pipe(Effect.provide(layerLive))

    expect(result).toEqual({ key: "value" })
    expect(f.raw.local.get).toHaveBeenCalledExactlyOnceWith("key")
  }))

  it.effect("provides an injected API through layer without a global", () => Effect.gen(function*() {
    const f = fixture()
    vi.stubGlobal("chrome", undefined)
    const result = yield* Effect.flatMap(ChromeStorage, (storage) => storage.sync.get("key")).pipe(Effect.provide(layer(f.api)))
    expect(result).toEqual({ key: "value" })
    expect(f.raw.sync.get).toHaveBeenCalledExactlyOnceWith("key")
  }))

  it("mirrors Chrome's quota constants", () => {
    expect(limits).toEqual({
      local: { QUOTA_BYTES: 10485760 },
      sync: {
        QUOTA_BYTES: 102400, QUOTA_BYTES_PER_ITEM: 8192, MAX_ITEMS: 512,
        MAX_WRITE_OPERATIONS_PER_HOUR: 1800, MAX_WRITE_OPERATIONS_PER_MINUTE: 120
      },
      session: { QUOTA_BYTES: 10485760 }
    })
  })
})

describe("ChromeStorage calls", () => {
  it.effect.each(writableAreas)("defers and forwards every %s operation exactly", (name) => Effect.gen(function*() {
    const f = fixture()
    const area = make(f.api)[name]
    const raw = f.raw[name]
    const write = area.set({ key: "new" })
    expect(raw.set).not.toHaveBeenCalled()
    yield* write
    expect(raw.set).toHaveBeenCalledExactlyOnceWith({ key: "new" })
    expect(yield* area.get({ missing: "default" })).toEqual({ key: "value" })
    expect(raw.get).toHaveBeenCalledExactlyOnceWith({ missing: "default" })
    expect(yield* area.getBytesInUse(["key"])).toBe(17)
    expect(raw.getBytesInUse).toHaveBeenCalledExactlyOnceWith(["key"])
    expect(yield* area.getKeys).toEqual(["key"])
    expect(raw.getKeys).toHaveBeenCalledExactlyOnceWith()
    yield* area.remove(["key"])
    expect(raw.remove).toHaveBeenCalledExactlyOnceWith(["key"])
    yield* area.clear
    yield* area.clear
    expect(raw.clear).toHaveBeenCalledTimes(2)
    yield* area.setAccessLevel("TRUSTED_CONTEXTS")
    expect(raw.setAccessLevel).toHaveBeenCalledExactlyOnceWith({ accessLevel: "TRUSTED_CONTEXTS" })
    expect(area.area).toBe(name)

    for (const other of allAreas.filter((candidate) => candidate !== name)) {
      expect(f.raw[other].set).not.toHaveBeenCalled()
      expect(f.raw[other].get).not.toHaveBeenCalled()
    }
  }))

  it.effect.each(allAreas)("omits absent %s selectors and passes null and empty selectors through", (name) => Effect.gen(function*() {
    const f = fixture()
    const area = make(f.api)[name]
    const raw = f.raw[name]
    yield* area.get()
    yield* area.getBytesInUse()
    expect(raw.get.mock.calls).toEqual([[]])
    expect(raw.getBytesInUse.mock.calls).toEqual([[]])
    yield* area.get(null)
    yield* area.get([])
    yield* area.get({})
    yield* area.getBytesInUse(null)
    yield* area.getBytesInUse([])
    expect(raw.get.mock.calls).toEqual([[], [null], [[]], [{}]])
    expect(raw.getBytesInUse.mock.calls).toEqual([[], [null], [[]]])
  }))

  it.effect("exposes only reads and changes for managed storage", () => Effect.gen(function*() {
    const f = fixture()
    const managed = make(f.api).managed
    expect(Object.keys(managed).sort()).toEqual(["area", "get", "getBytesInUse", "getKeys", "onChanged"])
    expect(yield* managed.get()).toEqual({ key: "value" })
    expect(yield* managed.getBytesInUse()).toBe(17)
    expect(yield* managed.getKeys).toEqual(["key"])
    expect(f.raw.managed.set).not.toHaveBeenCalled()
  }))

  it.effect.each(allAreas.flatMap((name) => [[name, "rejection"], [name, "throw"]] as const))(
    "maps every %s call's %s to the typed error with area and operation",
    ([name, mode]) => Effect.gen(function*() {
      const f = fixture()
      const raw = f.raw[name]
      const causes = new Map<Operation, Error>()

      const failing = (operation: Operation) => () => {
        const cause = new Error(`${name}.${operation} ${mode}`)
        causes.set(operation, cause)

        if (mode === "throw") throw cause

        return Promise.reject(cause)
      }

      raw.get.mockImplementation(failing("get"))
      raw.getBytesInUse.mockImplementation(failing("getBytesInUse"))
      raw.getKeys.mockImplementation(failing("getKeys"))
      raw.set.mockImplementation(failing("set"))
      raw.remove.mockImplementation(failing("remove"))
      raw.clear.mockImplementation(failing("clear"))
      raw.setAccessLevel.mockImplementation(failing("setAccessLevel"))
      const storage = make(f.api)
      const calls = callsOn(storage, name)
      expect(calls).toHaveLength(name === "managed" ? 3 : 7)

      for (const [operation, effect] of calls) {
        const error = yield* Effect.flip(effect)
        expect(error).toBeInstanceOf(ChromeStorageError)
        expect(error).toMatchObject({ area: name, operation })
        expect(error.cause).toBe(causes.get(operation))
      }

      // Other areas stay usable after one area's failures.
      for (const other of allAreas.filter((candidate) => candidate !== name)) {
        expect(yield* storage[other].get()).toEqual({ key: "value" })
      }
    })
  )

  it.effect.each(allAreas)("types a missing %s area for every call without affecting other areas", (name) => Effect.gen(function*() {
    const f = fixture()
    const api: ChromeStorageApi = { ...f.api }
    Reflect.deleteProperty(api, name)
    const storage = make(api)

    for (const [operation, effect] of callsOn(storage, name)) {
      const error = yield* Effect.flip(effect)
      expect(error).toMatchObject({ area: name, operation })
      expect(error.cause).toBeInstanceOf(TypeError)
    }

    const other = name === "local" ? "sync" : "local"
    expect(yield* storage[other].get()).toEqual({ key: "value" })
  }))

  it.effect.each(allAreas)("types getKeys before Chrome 130 on %s, calling it on the area when present", (name) => Effect.gen(function*() {
    const { raw } = fixture()
    const target = { ...raw[name], getKeys: vi.fn(async () => ["a"]) }
    const storage = make({ ...raw, [name]: target })
    const keys = storage[name].getKeys
    expect(target.getKeys).not.toHaveBeenCalled()
    expect(yield* keys).toEqual(["a"])
    expect(yield* keys).toEqual(["a"])
    expect(target.getKeys.mock.contexts).toHaveLength(2)
    expect(target.getKeys.mock.contexts.every((receiver) => receiver === target)).toBe(true)
    expect(target.get).not.toHaveBeenCalled()
    const { getKeys: _getKeys, ...withoutGetKeys } = raw[name]
    const missing = yield* Effect.flip(make({ ...raw, [name]: withoutGetKeys })[name].getKeys)
    expect(missing).toBeInstanceOf(ChromeStorageError)
    expect(missing).toMatchObject({ area: name, operation: "getKeys" })
    expect(String(missing.cause)).toContain(`storage.${name}.getKeys is unavailable`)
  }))

  it.effect.each(writableAreas)("types setAccessLevel before Chrome 102 on %s, calling it on the area when present", (name) => Effect.gen(function*() {
    const { raw } = fixture()
    const target = { ...raw[name], setAccessLevel: vi.fn(async (_options: { readonly accessLevel: AccessLevel }) => {}) }

    yield* make({ ...raw, [name]: target })[name].setAccessLevel("TRUSTED_AND_UNTRUSTED_CONTEXTS")
    expect(target.setAccessLevel).toHaveBeenCalledExactlyOnceWith({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })
    expect(target.setAccessLevel.mock.contexts[0]).toBe(target)
    const { setAccessLevel: _setAccessLevel, ...withoutSetter } = raw[name]
    const missing = yield* Effect.flip(make({ ...raw, [name]: withoutSetter })[name].setAccessLevel("TRUSTED_CONTEXTS"))
    expect(missing).toMatchObject({ area: name, operation: "setAccessLevel" })
    expect(String(missing.cause)).toContain(`storage.${name}.setAccessLevel is unavailable`)
  }))

  it.effect("passes empty, Unicode and dangerous own keys through the native storage boundary", () => Effect.gen(function*() {
    const f = fixture()
    const items = Object.fromEntries([["__proto__", "safe"], ["constructor", "own"], ["", "empty"], ["🌍", "unicode"]])
    const storage = make(f.api)
    yield* storage.session.set(items)
    expect(f.raw.session.set).toHaveBeenCalledExactlyOnceWith(items)
    expect(Object.hasOwn(f.raw.session.set.mock.calls[0]![0], "__proto__")).toBe(true)
    yield* storage.session.get(["", "🌍", "__proto__", "constructor"])
    expect(f.raw.session.get).toHaveBeenCalledWith(["", "🌍", "__proto__", "constructor"])
    expect(f.raw.local.set).not.toHaveBeenCalled()
  }))
})

describe("ChromeStorage events", () => {
  it.effect("delivers every area's changes on the global stream and removes its listener at the end", () => Effect.gen(function*() {
    const f = fixture()
    const storage = make(f.api)
    expect(f.raw.onChanged.addListener).not.toHaveBeenCalled()
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(storage.onChanged, 4)))
    yield* f.registered(1)

    for (const name of allAreas) f.emit({ [name]: { newValue: name } }, name)

    expect(yield* Fiber.join(fiber)).toEqual(allAreas.map((name) => ({ area: name, changes: { [name]: { newValue: name } } })))
    expect(f.listeners.size).toBe(0)
    expect(f.raw.onChanged.removeListener).toHaveBeenCalledExactlyOnceWith(f.raw.onChanged.addListener.mock.calls[0]![0])
  }))

  it.effect.each(allAreas)("filters %s changes, removing the listener after normal completion", (name) => Effect.gen(function*() {
    const f = fixture()
    f.raw.onChanged.addListener.mockImplementationOnce((listener) => {
      f.listeners.add(listener)

      for (const other of allAreas) {
        if (other !== name) listener({ ignored: { newValue: other } }, other)
      }

      listener({ key: { oldValue: 1, newValue: 2 } }, name)
    })
    const storage = make(f.api)
    const result = yield* Stream.runCollect(Stream.take(storage[name].onChanged, 1))
    expect(result).toEqual([{ area: name, changes: { key: { oldValue: 1, newValue: 2 } } }])
    expect(f.listeners.size).toBe(0)
    expect(f.raw.onChanged.removeListener).toHaveBeenCalledOnce()
  }))

  it.effect.each([undefined, ...allAreas])("types %s registration failures and removes a partly added listener", (name) => Effect.gen(function*() {
    const f = fixture()
    const cause = new Error("unavailable")
    f.raw.onChanged.addListener.mockImplementationOnce((listener) => {
      f.listeners.add(listener)
      throw cause
    })
    const storage = make(f.api)
    const stream = name === undefined ? storage.onChanged : storage[name].onChanged
    const error = yield* Stream.runCollect(stream).pipe(Effect.flip)
    expect(error).toBeInstanceOf(ChromeStorageError)
    expect(error).toMatchObject({ operation: "onChanged", area: name ?? "all", cause })
    expect(f.listeners.size).toBe(0)
  }))

  it.effect("types a missing onChanged event when the stream starts, not when the service is built", () => Effect.gen(function*() {
    const f = fixture()
    const api: ChromeStorageApi = { ...f.api }
    Reflect.deleteProperty(api, "onChanged")
    const storage = make(api)
    const error = yield* Stream.runCollect(storage.local.onChanged).pipe(Effect.flip)
    expect(error).toMatchObject({ operation: "onChanged", area: "local" })
    expect(error.cause).toBeInstanceOf(TypeError)
  }))

  it.effect("removes listeners when a waiting consumer is interrupted", () => Effect.gen(function*() {
    const f = fixture()
    const registered = yield* Deferred.make<void>()
    f.raw.onChanged.addListener.mockImplementationOnce((listener) => {
      f.listeners.add(listener)
      Deferred.doneUnsafe(registered, Effect.void)
    })
    const fiber = yield* Effect.forkScoped(Stream.runDrain(make(f.api).session.onChanged))
    yield* Deferred.await(registered)
    expect(f.listeners.size).toBe(1)
    yield* Fiber.interrupt(fiber)
    expect(f.listeners.size).toBe(0)
    expect(f.raw.onChanged.removeListener).toHaveBeenCalledOnce()
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

  it.effect("keeps the newest 64 changes and includes the originating area", () => Effect.gen(function*() {
    const f = fixture()
    f.raw.onChanged.addListener.mockImplementationOnce((listener) => {
      f.listeners.add(listener)

      for (let i = 0; i < changeBufferSize + 3; i++) listener({ key: { newValue: i } }, "managed")
    })
    const result = yield* Stream.runCollect(Stream.take(make(f.api).onChanged, changeBufferSize))
    expect(result).toHaveLength(changeBufferSize)
    expect(result[0]).toEqual({ area: "managed", changes: { key: { newValue: 3 } } })
    expect(result.at(-1)).toEqual({ area: "managed", changes: { key: { newValue: changeBufferSize + 2 } } })
    expect(f.listeners.size).toBe(0)
  }))

  it.effect("retains every event in a burst exactly at capacity", () => Effect.gen(function*() {
    const f = fixture()
    f.raw.onChanged.addListener.mockImplementationOnce((listener) => {
      f.listeners.add(listener)

      for (let index = 0; index < changeBufferSize; index++) listener({ key: { newValue: index } }, "local")
    })
    const result = yield* Stream.runCollect(Stream.take(make(f.api).onChanged, changeBufferSize))
    expect(result.map((event) => event.changes["key"]?.newValue)).toEqual(Array.from({ length: changeBufferSize }, (_, index) => index))
    expect(f.listeners.size).toBe(0)
  }))

  it.effect("gives simultaneous subscriptions independent listeners and cleanup", () => Effect.gen(function*() {
    const f = fixture()
    const stream = make(f.api).local.onChanged
    const first = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 1)))
    const second = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 2)))
    yield* f.registered(2)
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
    const removed = f.raw.onChanged.removeListener.mock.calls.map(([listener]) => listener)
    expect(new Set(removed).size).toBe(2)
  }))

  // A synchronous native-event boundary: no Effect runs here.
  it("exposes the wrapped API's native change event, read only when a listener is added", () => {
    const f = fixture()
    const storage = make(f.api)
    expect(f.raw.onChanged.addListener).not.toHaveBeenCalled()
    const received: Array<[Changes, AreaName]> = []

    const listener = (changes: Changes, area: AreaName) => { received.push([changes, area]) }

    storage.changeEvent.addListener(listener)
    expect(f.raw.onChanged.addListener).toHaveBeenCalledExactlyOnceWith(listener)
    f.emit({ key: { newValue: 1 } }, "sync")
    expect(received).toEqual([[{ key: { newValue: 1 } }, "sync"]])
    storage.changeEvent.removeListener(listener)
    expect(f.raw.onChanged.removeListener).toHaveBeenCalledExactlyOnceWith(listener)
    expect(f.listeners.size).toBe(0)
  })
})

describe("ChromeStorage fixture", () => {
  it.effect("reads, measures and lists every area, with absent selectors meaning the whole area", () => Effect.gen(function*() {
    const fixture = makeStorage()
    const storage = make(fixture.api)
    yield* storage.local.set({ b: 2, a: 1 })
    fixture.controls.seed("managed", { policy: true })
    expect(yield* storage.local.get()).toEqual({ b: 2, a: 1 })
    expect(yield* storage.local.get(null)).toEqual({ b: 2, a: 1 })
    expect(yield* storage.local.get([])).toEqual({})
    expect(yield* storage.local.get({})).toEqual({})
    expect(yield* storage.local.getBytesInUse()).toBe(4)
    expect(yield* storage.local.getBytesInUse([])).toBe(0)
    expect(yield* storage.local.getKeys).toEqual(["b", "a"])
    expect(yield* storage.managed.getKeys).toEqual(["policy"])
    expect(yield* storage.managed.get()).toEqual({ policy: true })
    expect(yield* storage.session.getKeys).toEqual([])
  }))

  it.effect.each(allAreas)("fails the next %s call of each operation once, before mutating", (name) => Effect.gen(function*() {
    const fixture = makeStorage()
    fixture.controls.seed(name, { key: "kept" })
    const storage = make(fixture.api)

    for (const [operation, effect] of callsOn(storage, name)) {
      const cause = new Error(`${operation} injected`)
      fixture.controls.failNext(name, operation, cause)
      expect(yield* Effect.flip(effect)).toMatchObject({ area: name, operation, cause })
      expect(yield* storage[name].get()).toEqual({ key: "kept" })
    }

    for (const [, effect] of callsOn(storage, name)) yield* effect
  }))

  it.effect("starts from Chrome's access levels and records changes", () => Effect.gen(function*() {
    const fixture = makeStorage()
    expect(fixture.controls.accessLevel("local")).toBe("TRUSTED_AND_UNTRUSTED_CONTEXTS")
    expect(fixture.controls.accessLevel("sync")).toBe("TRUSTED_AND_UNTRUSTED_CONTEXTS")
    expect(fixture.controls.accessLevel("session")).toBe("TRUSTED_CONTEXTS")
    const storage = yield* ChromeStorage.pipe(Effect.provide(fixture.layer))
    yield* storage.session.setAccessLevel("TRUSTED_AND_UNTRUSTED_CONTEXTS")
    expect(fixture.controls.accessLevel("session")).toBe("TRUSTED_AND_UNTRUSTED_CONTEXTS")
    expect(fixture.controls.accessLevel("local")).toBe("TRUSTED_AND_UNTRUSTED_CONTEXTS")
  }))

  it.effect("removes version-gated members given as undefined, like older Chrome", () => Effect.gen(function*() {
    const fixture = makeStorage({
      local: { getKeys: undefined, setAccessLevel: undefined },
      managed: { getKeys: undefined }
    })

    expect(fixture.api.local).not.toHaveProperty("getKeys")
    expect(fixture.api.local).not.toHaveProperty("setAccessLevel")
    expect(fixture.api.managed).not.toHaveProperty("getKeys")
    expect(fixture.api.sync).toHaveProperty("getKeys")
    const storage = make(fixture.api)
    expect(yield* Effect.flip(storage.local.getKeys)).toMatchObject({ area: "local", operation: "getKeys" })
    expect(yield* Effect.flip(storage.local.setAccessLevel("TRUSTED_CONTEXTS"))).toMatchObject({ area: "local", operation: "setAccessLevel" })
    expect(yield* Effect.flip(storage.managed.getKeys)).toMatchObject({ area: "managed", operation: "getKeys" })
    yield* storage.sync.set({ a: 1 })
    expect(yield* storage.sync.getKeys).toEqual(["a"])
  }))

  it.effect("replaces area members and the global event with overrides", () => Effect.gen(function*() {
    const get = vi.fn(async (): Promise<Items> => ({ overridden: true }))
    const replacement = makeStorage()
    const fixture = makeStorage({ session: { get }, onChanged: replacement.api.onChanged })
    const storage = make(fixture.api)
    expect(yield* storage.session.get("x")).toEqual({ overridden: true })
    expect(get).toHaveBeenCalledExactlyOnceWith("x")
    yield* storage.session.set({ x: 1 })
    expect(yield* storage.session.getKeys).toEqual(["x"])
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(storage.onChanged, 1)))
    yield* Effect.promise(() => replacement.controls.onChanged.waitForListener())
    expect(fixture.controls.onChanged.listenerCount).toBe(0)
    replacement.controls.seed("sync", { y: 2 }, true)
    expect(yield* Fiber.join(fiber)).toEqual([{ area: "sync", changes: { y: { newValue: 2 } } }])
    expect(replacement.controls.onChanged.listenerCount).toBe(0)
  }))

  it.effect("delivers fixture writes to area streams and types fixture registration failures", () => Effect.gen(function*() {
    const fixture = makeStorage()
    const storage = make(fixture.api)
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(storage.sync.onChanged, 2)))
    yield* Effect.promise(() => fixture.controls.onChanged.waitForListener())
    yield* storage.local.set({ ignored: 1 })
    yield* storage.sync.set({ a: 1 })
    yield* storage.sync.set({ a: 1 })
    yield* storage.sync.remove("a")
    expect(yield* Fiber.join(fiber)).toEqual([
      { area: "sync", changes: { a: { newValue: 1 } } },
      { area: "sync", changes: { a: { oldValue: 1 } } }
    ])
    expect(fixture.controls.onChanged.listenerCount).toBe(0)
    const cause = new Error("registration")
    fixture.controls.onChanged.failNext("addListener", cause)
    expect(yield* Effect.flip(Stream.runDrain(storage.onChanged))).toMatchObject({ area: "all", operation: "onChanged", cause })
    expect(fixture.controls.onChanged.listenerCount).toBe(0)
  }))
})
