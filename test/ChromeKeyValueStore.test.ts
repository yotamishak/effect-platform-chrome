// These compatibility tests exercise the adapter's unstable persistence API and
// the pinned, test-only Effect v4 Vitest integration.
/* oxlint-disable effecttsgo/unstable-api-usage */
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Predicate from "effect/Predicate"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import { describe, expect, it, vi } from "@effect/vitest"
import * as ChromeKeyValueStore from "../src/ChromeKeyValueStore.js"
import * as ChromeTesting from "../src/ChromeTesting.js"

const storageArea = () => {
  const data: Record<string, unknown> = {}

  const get = vi.fn(async (keys: string | null): Promise<Record<string, unknown>> => {
    if (keys === null) return structuredClone(data)

    return Object.hasOwn(data, keys) ? { [keys]: structuredClone(data[keys]) } : {}
  })

  const set = vi.fn(async (items: Record<string, unknown>) => { Object.assign(data, structuredClone(items)) })

  const remove = vi.fn(async (keys: string | Array<string>) => {
    for (const key of Predicate.isString(keys) ? [keys] : keys) delete data[key]
  })

  const clear = vi.fn(async () => { throw new Error("Whole-area clear must not be called") })

  return { data, get, set, remove, clear }
}

/** A storage area with Chrome 130's `getKeys`. */
const keyedArea = () => {
  const area = storageArea()
  const getKeys = vi.fn(async () => Object.keys(area.data))

  return { ...area, getKeys }
}

const physical = (namespace: string, key: string) =>
  `effect-platform-chrome/KeyValueStore/v1:${namespace.length}:${namespace}:${key}`

const failure = <A extends Effect.Effect<unknown, KeyValueStore.KeyValueStoreError>>(effect: A) =>
  Effect.flip(Effect.asVoid(effect))

const operations = (store: KeyValueStore.KeyValueStore) => [
  ["get", store.get("key")], ["getUint8Array", store.getUint8Array("key")],
  ["has", store.has("key")], ["set", store.set("key", "value")],
  ["remove", store.remove("key")], ["clear", store.clear], ["size", store.size], ["isEmpty", store.isEmpty]
] as const

const keyless = new Set(["clear", "size", "isEmpty"])

describe("ChromeKeyValueStore", () => {
  it.effect("round trips strings and binary with Effect-compatible cross-type reads", () => Effect.gen(function*() {
    const area = storageArea()
    const store = ChromeKeyValueStore.make(area)
    yield* store.set("text", "hello 🌍")
    expect(yield* store.get("text")).toBe("hello 🌍")
    expect(yield* store.getUint8Array("text")).toEqual(new TextEncoder().encode("hello 🌍"))
    const bytes = new Uint8Array([0, 1, 127, 128, 255])
    yield* store.set("bytes", bytes)
    bytes[0] = 42
    expect(yield* store.getUint8Array("bytes")).toEqual(new Uint8Array([0, 1, 127, 128, 255]))
    expect(yield* store.get("bytes")).toBe("AAF/gP8=")
    yield* store.set("base64-looking-string", "aGVsbG8=")
    expect(yield* store.getUint8Array("base64-looking-string")).toEqual(new TextEncoder().encode("aGVsbG8="))

    for (const value of ["", new Uint8Array()]) {
      yield* store.set("empty", value)
      expect(yield* store.get("empty")).toBe("")
      expect(yield* store.getUint8Array("empty")).toEqual(new Uint8Array())
    }
  }))

  it.effect("stores only the viewed bytes of a subarray", () => Effect.gen(function*() {
    const store = ChromeKeyValueStore.make(storageArea())
    const buffer = new Uint8Array([9, 9, 1, 2, 3, 9, 9])
    yield* store.set("view", buffer.subarray(2, 5))
    expect(yield* store.getUint8Array("view")).toEqual(new Uint8Array([1, 2, 3]))
    expect(yield* store.get("view")).toBe("AQID")
  }))

  it.effect("passes Chrome exactly one physical key per call and lists keys only through getKeys when present", () => Effect.gen(function*() {
    const area = keyedArea()
    const store = ChromeKeyValueStore.make(area, { namespace: "ns" })
    yield* store.set("text", "value")
    expect(area.set).toHaveBeenCalledWith({ [physical("ns", "text")]: { version: 1, type: "string", value: "value" } })
    yield* store.set("bytes", new Uint8Array([255]))
    expect(area.set).toHaveBeenLastCalledWith({ [physical("ns", "bytes")]: { version: 1, type: "uint8array", value: "/w==" } })
    expect(area.data[physical("ns", "bytes")]).toEqual({ version: 1, type: "uint8array", value: "/w==" })
    yield* store.get("text")
    yield* store.getUint8Array("text")
    yield* store.has("text")

    for (const call of area.get.mock.calls) expect(call).toEqual([physical("ns", "text")])

    yield* store.remove("text")
    expect(area.remove).toHaveBeenCalledWith(physical("ns", "text"))
    area.data["unrelated"] = "keep"
    expect(yield* store.size).toBe(1)
    expect(yield* store.isEmpty).toBe(false)
    yield* store.clear
    expect(area.remove).toHaveBeenLastCalledWith([physical("ns", "bytes")])
    expect(yield* store.isEmpty).toBe(true)

    for (const call of area.getKeys.mock.calls) expect(call).toEqual([])

    expect(area.getKeys).toHaveBeenCalledTimes(4)
    expect(area.get).not.toHaveBeenCalledWith(null)
    expect(area.data).toEqual({ unrelated: "keep" })
  }))

  it.effect("falls back to reading the whole area without getKeys", () => Effect.gen(function*() {
    const area = storageArea()
    const store = ChromeKeyValueStore.make(area, { namespace: "ns" })
    yield* store.set("a", "1")
    area.data["unrelated"] = "keep"
    area.get.mockClear()
    expect(yield* store.size).toBe(1)
    expect(yield* store.isEmpty).toBe(false)
    yield* store.clear
    expect(area.get.mock.calls).toEqual([[null], [null], [null]])
    expect(area.remove).toHaveBeenLastCalledWith([physical("ns", "a")])
    expect(area.data).toEqual({ unrelated: "keep" })
  }))

  it.effect("isolates all operations, including clear, from adjacent namespaces and unrelated data", () => Effect.gen(function*() {
    const area = storageArea()
    area.data.unrelated = "keep"
    const a = ChromeKeyValueStore.make(area, { namespace: "a" })
    const ab = ChromeKeyValueStore.make(area, { namespace: "a:b" })
    const empty = ChromeKeyValueStore.make(area, { namespace: "" })
    yield* a.set("b:c", "a")
    yield* a.set("", "empty key")
    yield* ab.set("c", "ab")
    yield* empty.set("a:b:c", "empty namespace")
    expect(yield* a.size).toBe(2)
    expect(yield* ab.size).toBe(1)
    expect(yield* a.get("c")).toBeUndefined()
    expect(yield* a.has("c")).toBe(false)
    yield* a.remove("c")
    expect(yield* ab.get("c")).toBe("ab")
    yield* a.clear
    expect(yield* a.isEmpty).toBe(true)
    expect(yield* ab.get("c")).toBe("ab")
    expect(yield* empty.get("a:b:c")).toBe("empty namespace")
    expect(area.data.unrelated).toBe("keep")
    expect(area.clear).not.toHaveBeenCalled()
    const removeCalls = area.remove.mock.calls.length
    yield* a.clear
    expect(area.remove.mock.calls.length).toBe(removeCalls)
  }))

  it.effect("uses the default namespace when none is given", () => Effect.gen(function*() {
    const area = storageArea()
    yield* ChromeKeyValueStore.make(area).set("key", "value")
    expect(Object.keys(area.data)).toEqual([physical(ChromeKeyValueStore.defaultNamespace, "key")])
    expect(yield* ChromeKeyValueStore.make(area, { namespace: ChromeKeyValueStore.defaultNamespace }).get("key")).toBe("value")
  }))

  it.effect("handles missing values and derives modify helpers", () => Effect.gen(function*() {
    const store = ChromeKeyValueStore.make(storageArea())
    expect(yield* store.get("missing")).toBeUndefined()
    expect(yield* store.getUint8Array("missing")).toBeUndefined()
    expect(yield* store.has("missing")).toBe(false)
    const transform = vi.fn((value: string) => value + "!")
    expect(yield* store.modify("missing", transform)).toBeUndefined()
    expect(transform).not.toHaveBeenCalled()
    yield* store.remove("missing")
    yield* store.set("text", "value")
    expect(yield* store.modify("text", transform)).toBe("value!")
    yield* store.set("binary", new Uint8Array([1]))
    expect(yield* store.has("binary")).toBe(true)
    expect(yield* store.modifyUint8Array("binary", (value) => new Uint8Array([...value, 2]))).toEqual(new Uint8Array([1, 2]))
    expect(yield* store.getUint8Array("binary")).toEqual(new Uint8Array([1, 2]))
  }))

  it.effect("reports the failing primitive of modify helpers", () => Effect.gen(function*() {
    const area = storageArea()
    const store = ChromeKeyValueStore.make(area)
    yield* store.set("text", "value")
    const read = new Error("read failed")
    area.get.mockRejectedValueOnce(read)
    expect(yield* failure(store.modify("text", (value) => value))).toMatchObject({ method: "get", key: "text", cause: read })
    area.get.mockRejectedValueOnce(read)
    expect(yield* failure(store.modifyUint8Array("text", (value) => value))).toMatchObject({ method: "getUint8Array", key: "text", cause: read })
    const write = new Error("write failed")
    area.set.mockRejectedValueOnce(write)
    expect(yield* failure(store.modify("text", (value) => value + "!"))).toMatchObject({ method: "set", key: "text", cause: write })
    expect(yield* store.get("text")).toBe("value")
  }))

  it.effect.each([
    null,
    "untagged",
    { version: 2, type: "string", value: "unsupported" },
    { version: 1, type: "unknown", value: "wrong tag" },
    { version: 1, type: "string", value: 123 },
    { version: 1, type: "uint8array", value: "not base64!" },
    { version: "1", type: "string", value: "wrong version type" },
    { type: "string", value: "missing version" },
    { version: 1, type: "string" },
    { version: 1, type: "uint8array", value: [0, 255] },
    ...["A", "AAA", "====", "AA=A", "AA==AAAA", "AA-_", "AA A"].map((value) => ({ version: 1, type: "uint8array", value }))
  ].map((corrupt) => ({ corrupt })))("fails typed reads of corrupt envelopes: %j", ({ corrupt }) => Effect.gen(function*() {
    const area = storageArea()
    const store = ChromeKeyValueStore.make(area)
    yield* store.set("key", "valid")
    const name = Object.keys(area.data)[0]!
    area.data[name] = corrupt

    for (const [method, effect] of [["get", store.get("key")], ["getUint8Array", store.getUint8Array("key")]] as const) {
      const error = yield* failure(effect)
      expect(error).toBeInstanceOf(KeyValueStore.KeyValueStoreError)
      expect(error.method).toBe(method)
      expect(error.key).toBe("key")
      expect(error.cause).toBeDefined()
    }

    expect(yield* failure(store.modify("key", (value) => value))).toMatchObject({ method: "get", key: "key" })
    expect(area.set).toHaveBeenCalledOnce()
    expect(yield* store.has("key")).toBe(true)
    expect(yield* store.size).toBe(1)
    yield* store.clear
    expect(yield* store.size).toBe(0)
  }))

  it.effect.each([false, true])("maps a rejection and a synchronous throw of every native call (getKeys: %s)", (withKeys) => Effect.gen(function*() {
    const cause = new Error("Chrome quota or permission failure")

    for (const synchronous of [false, true]) {
      const fail = () => {
        if (synchronous) throw cause

        return Promise.reject(cause)
      }

      const store = ChromeKeyValueStore.make(withKeys ? { get: fail, set: fail, remove: fail, getKeys: fail } : { get: fail, set: fail, remove: fail })

      for (const [method, effect] of operations(store)) {
        const error = yield* failure(effect)
        expect(error).toBeInstanceOf(KeyValueStore.KeyValueStoreError)
        expect(error.method).toBe(method)
        expect(error.cause).toBe(cause)
        expect(error.message).toBe(`Chrome KeyValueStore ${method} failed`)
        expect(error.key).toBe(keyless.has(method) ? undefined : "key")
      }
    }

    // clear's second native call, the removal, maps to clear as well.
    for (const synchronous of [false, true]) {
      const area = withKeys ? keyedArea() : storageArea()
      const store = ChromeKeyValueStore.make(area)
      yield* store.set("key", "value")

      if (synchronous) area.remove.mockImplementationOnce(() => { throw cause })
      else area.remove.mockRejectedValueOnce(cause)

      const error = yield* failure(store.clear)
      expect(error).toMatchObject({ method: "clear", cause })
      expect(error.key).toBeUndefined()
      expect(yield* store.size).toBe(1)
    }
  }))

  it.effect("keeps adversarial namespace/key pairs distinct and clears only the selected namespace", () => Effect.gen(function*() {
    const area = storageArea()
    const namespaces = ["", "a", "a:", "a:b", "0:", "🌍", "é", "é", "__proto__", "constructor"]
    const keys = ["", ":", "b:c", "🌍\u0000", "é", "é", "__proto__", "constructor", "toString"]

    for (const namespace of namespaces) {
      const store = ChromeKeyValueStore.make(area, { namespace })

      for (const key of keys) yield* store.set(key, JSON.stringify([namespace, key]))
    }

    expect(Object.keys(area.data)).toHaveLength(namespaces.length * keys.length)

    for (const namespace of namespaces) {
      const store = ChromeKeyValueStore.make(area, { namespace })
      expect(yield* store.size).toBe(keys.length)

      for (const key of keys) expect(yield* store.get(key)).toBe(JSON.stringify([namespace, key]))
    }

    yield* ChromeKeyValueStore.make(area, { namespace: "a:" }).clear

    for (const namespace of namespaces) {
      const store = ChromeKeyValueStore.make(area, { namespace })
      expect(yield* store.size).toBe(namespace === "a:" ? 0 : keys.length)
    }
  }))

  it.effect.each([256, 65_537])("round trips all byte values in a bounded %i-byte payload without aliasing", (length) => Effect.gen(function*() {
    const store = ChromeKeyValueStore.make(storageArea())
    const bytes = Uint8Array.from({ length }, (_, index) => index % 256)
    yield* store.set("binary", bytes)
    const first = yield* store.getUint8Array("binary")
    expect(first).toEqual(bytes)
    first!.fill(42)
    expect(yield* store.getUint8Array("binary")).toEqual(bytes)
  }))

  it.effect("ignores inherited physical keys in reads, existence, size and clear", () => Effect.gen(function*() {
    const area = storageArea()
    const store = ChromeKeyValueStore.make(area)
    yield* store.set("inherited", "not owned")
    const prototype = structuredClone(area.data)
    yield* store.clear
    const inherited: Record<string, unknown> = {}
    Object.setPrototypeOf(inherited, prototype)
    area.get.mockResolvedValue(inherited)
    expect(yield* store.get("inherited")).toBeUndefined()
    expect(yield* store.getUint8Array("inherited")).toBeUndefined()
    expect(yield* store.has("inherited")).toBe(false)
    expect(yield* store.size).toBe(0)
    area.remove.mockClear()
    yield* store.clear
    expect(area.remove).not.toHaveBeenCalled()
  }))

  it.effect("supports concurrent independent writes and reads without conflating keys", () => Effect.gen(function*() {
    const store = ChromeKeyValueStore.make(storageArea())
    const keys = Array.from({ length: 64 }, (_, index) => `key:${index}`)
    yield* Effect.forEach(keys, (key) => store.set(key, key), { concurrency: "unbounded" })
    expect(yield* Effect.forEach(keys, (key) => store.get(key), { concurrency: "unbounded" })).toEqual(keys)
    expect(yield* store.size).toBe(64)
    yield* Effect.forEach(keys, (key) => store.remove(key), { concurrency: "unbounded" })
    expect(yield* store.size).toBe(0)
  }))

  it.effect("observes same-key writes in API completion order rather than assuming atomic transactions", () => Effect.gen(function*() {
    const area = storageArea()
    const store = ChromeKeyValueStore.make(area)
    let complete!: () => void
    let entered!: () => void
    const pending = new Promise<void>((resolve) => { complete = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    area.set.mockImplementationOnce(async (items) => {
      entered()
      await pending
      Object.assign(area.data, structuredClone(items))
    })
    const first = yield* Effect.forkScoped(store.set("key", "first"))
    yield* Effect.promise(() => started)
    expect(yield* store.get("key")).toBeUndefined()
    yield* store.set("key", "second")
    expect(yield* store.get("key")).toBe("second")
    complete()
    yield* Fiber.join(first)
    expect(yield* store.get("key")).toBe("first")
  }))

  it.effect("keeps prior data after injected quota and access failures and permits later recovery", () => Effect.gen(function*() {
    const area = storageArea()
    const store = ChromeKeyValueStore.make(area)
    yield* store.set("key", "original")
    const quota = new Error("QUOTA_BYTES exceeded")
    area.set.mockRejectedValueOnce(quota)
    expect(yield* failure(store.set("key", "replacement"))).toMatchObject({ method: "set", key: "key", cause: quota })
    expect(yield* store.get("key")).toBe("original")
    const access = new Error("Access denied")
    area.remove.mockImplementationOnce(() => { throw access })
    expect(yield* failure(store.clear)).toMatchObject({ method: "clear", cause: access })
    expect(yield* store.size).toBe(1)
    yield* store.clear
    expect(yield* store.size).toBe(0)
  }))

  it.effect("does not pretend clear is atomic with concurrent writes, but preserves namespace isolation", () => Effect.gen(function*() {
    const area = storageArea()
    const store = ChromeKeyValueStore.make(area, { namespace: "owned" })
    const other = ChromeKeyValueStore.make(area, { namespace: "owned:other" })
    yield* store.set("old", "remove")
    let complete!: () => void
    let entered!: () => void
    const pending = new Promise<void>((resolve) => { complete = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    area.remove.mockImplementationOnce(async (keys) => {
      entered()
      await pending

      for (const key of Predicate.isString(keys) ? [keys] : keys) delete area.data[key]
    })
    const clearing = yield* Effect.forkScoped(store.clear)
    yield* Effect.promise(() => started)
    yield* store.set("new", "later write")
    yield* other.set("old", "keep")
    complete()
    yield* Fiber.join(clearing)
    expect(yield* store.get("old")).toBeUndefined()
    expect(yield* store.get("new")).toBe("later write")
    expect(yield* other.get("old")).toBe("keep")
  }))

  it.effect("never starts clear's removal once interrupted while listing keys", () => Effect.gen(function*() {
    const area = keyedArea()
    const store = ChromeKeyValueStore.make(area)
    yield* store.set("key", "value")
    const listing = yield* Deferred.make<void>()
    let release!: (keys: Array<string>) => void
    area.getKeys.mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve
      Deferred.doneUnsafe(listing, Effect.void)
    }))
    const clearing = yield* Effect.forkChild(store.clear)
    yield* Deferred.await(listing)
    yield* Fiber.interrupt(clearing)
    expect(Exit.hasInterrupts(yield* Fiber.await(clearing))).toBe(true)
    release(Object.keys(area.data))
    // A later call settles after the abandoned listing, so its continuation had the chance to run.
    expect(yield* store.get("key")).toBe("value")
    expect(area.remove).not.toHaveBeenCalled()
  }))

  it.effect("interrupts a pending call without waiting for Chrome, whose late result is discarded", () => Effect.gen(function*() {
    const area = storageArea()
    const store = ChromeKeyValueStore.make(area)
    const arrived = yield* Deferred.make<void>()
    let settle!: () => void
    area.set.mockImplementationOnce((items) => new Promise<void>((resolve) => {
      settle = () => {
        Object.assign(area.data, structuredClone(items))
        resolve()
      }

      Deferred.doneUnsafe(arrived, Effect.void)
    }))
    const writing = yield* Effect.forkChild(store.set("key", "late"))
    yield* Deferred.await(arrived)
    yield* Fiber.interrupt(writing)
    expect(Exit.hasInterrupts(yield* Fiber.await(writing))).toBe(true)
    expect(yield* store.has("key")).toBe(false)
    settle()
    // Chrome cannot cancel a write in flight: it lands even though its fiber was interrupted.
    expect(yield* store.get("key")).toBe("late")
  }))

  it.effect("works over the ChromeTesting storage fixture, including its injected failures", () => Effect.gen(function*() {
    const fixture = ChromeTesting.makeStorage()
    fixture.controls.seed("local", { unrelated: "keep" })
    const store = ChromeKeyValueStore.make(fixture.api.local, { namespace: "fixture" })
    yield* store.set("text", "value")
    yield* store.set("bytes", new Uint8Array([1, 2]))
    expect(yield* store.get("text")).toBe("value")
    expect(yield* store.getUint8Array("bytes")).toEqual(new Uint8Array([1, 2]))
    expect(yield* store.size).toBe(2)
    const cause = new Error("getKeys failed")
    fixture.controls.failNext("local", "getKeys", cause)
    expect(yield* failure(store.clear)).toMatchObject({ method: "clear", cause })
    yield* store.clear
    expect(yield* store.isEmpty).toBe(true)
    expect(yield* Effect.promise(() => fixture.api.local.get(null))).toEqual({ unrelated: "keep" })
    // The session area is a separate store.
    const session = ChromeKeyValueStore.make(fixture.api.session, { namespace: "fixture" })
    yield* session.set("text", "session")
    expect(yield* store.get("text")).toBeUndefined()
  }))

  it.effect("layerLive fails with initialize without chrome, without storage, or without the area", () => Effect.gen(function*() {
    for (const global of [undefined, {}, { storage: {} }, { storage: { local: storageArea() } }]) {
      vi.stubGlobal("chrome", global)
      const area = global === undefined ? "local" : "session"
      const error = yield* Effect.flip(Effect.provide(KeyValueStore.KeyValueStore, ChromeKeyValueStore.layerLive({ area })))
      expect(error).toBeInstanceOf(KeyValueStore.KeyValueStoreError)
      expect(error.method).toBe("initialize")
      expect(error.key).toBeUndefined()
      expect(error.cause).toBeInstanceOf(Error)
    }

    vi.stubGlobal("chrome", undefined)
    expect((yield* Effect.flip(Effect.provide(KeyValueStore.KeyValueStore, ChromeKeyValueStore.layerLive()))).method).toBe("initialize")
  }))

  it.effect("layerLive defers global lookup and calls until built and run, defaulting to local", () => Effect.gen(function*() {
    const local = storageArea()
    const sync = storageArea()
    const session = storageArea()
    vi.stubGlobal("chrome", undefined)

    const layers = [
      ChromeKeyValueStore.layerLive(),
      ChromeKeyValueStore.layerLive({ area: "local" }),
      ChromeKeyValueStore.layerLive({ area: "sync" }),
      ChromeKeyValueStore.layerLive({ area: "session", namespace: "session-ns" })
    ] as const

    vi.stubGlobal("chrome", { storage: { local, sync, session } })

    for (const [index, area] of [local, local, sync, session].entries()) {
      area.set.mockClear()
      const store = yield* Effect.provide(KeyValueStore.KeyValueStore, layers[index]!)
      const set = store.set("key", "value")
      expect(area.set).not.toHaveBeenCalled()
      yield* set
      expect(area.set).toHaveBeenCalledOnce()
    }

    expect(Object.keys(session.data)).toEqual([physical("session-ns", "key")])
    expect(Object.keys(sync.data)).toEqual([physical(ChromeKeyValueStore.defaultNamespace, "key")])
    const injected = yield* Effect.provide(KeyValueStore.KeyValueStore, ChromeKeyValueStore.layer(local))
    expect(yield* injected.get("key")).toBe("value")
    const namespaced = yield* Effect.provide(KeyValueStore.KeyValueStore, ChromeKeyValueStore.layer(local, { namespace: "other" }))
    expect(yield* namespaced.get("key")).toBeUndefined()
  }))
})
