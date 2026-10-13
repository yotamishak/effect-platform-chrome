// These compatibility tests exercise the adapter's unstable persistence API and
// the pinned, test-only Effect v4 Vitest integration.
/* oxlint-disable effecttsgo/unstable-api-usage */
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Predicate from "effect/Predicate"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import { describe, expect, it, vi } from "@effect/vitest"
import * as ChromeKeyValueStore from "../src/ChromeKeyValueStore.js"

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

const failure = <A extends Effect.Effect<unknown, KeyValueStore.KeyValueStoreError>>(effect: A) =>
  Effect.flip(Effect.asVoid(effect))

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

    expect(yield* store.has("key")).toBe(true)
    expect(yield* store.size).toBe(1)
    yield* store.clear
    expect(yield* store.size).toBe(0)
  }))

  it.effect("preserves rejected and synchronously thrown causes for every primitive operation", () => Effect.gen(function*() {
    const cause = new Error("Chrome quota or permission failure")

    for (const synchronous of [false, true]) {
      const fail = () => {
        if (synchronous) throw cause

        return Promise.reject(cause)
      }

      const store = ChromeKeyValueStore.make({ get: fail, set: fail, remove: fail })

      for (const [method, effect] of [
        ["get", store.get("key")], ["getUint8Array", store.getUint8Array("key")],
        ["has", store.has("key")], ["set", store.set("key", "value")],
        ["remove", store.remove("key")], ["clear", store.clear], ["size", store.size]
      ] as const) {
        const error = yield* failure(effect)
        expect(error).toBeInstanceOf(KeyValueStore.KeyValueStoreError)
        expect(error.method).toBe(method)
        expect(error.cause).toBe(cause)
        expect(error.key).toBe(method === "clear" || method === "size" ? undefined : "key")
      }
    }

    const area = storageArea()
    const store = ChromeKeyValueStore.make(area)
    yield* store.set("key", "value")
    area.remove.mockRejectedValueOnce(cause)
    expect((yield* failure(store.clear)).cause).toBe(cause)
  }))

  it.effect("keeps adversarial namespace/key pairs distinct and clears only the selected namespace", () => Effect.gen(function*() {
    const area = storageArea()
    const namespaces = ["", "a", "a:", "a:b", "0:", "🌍", "é", "e\u0301", "__proto__", "constructor"]
    const keys = ["", ":", "b:c", "🌍\u0000", "é", "e\u0301", "__proto__", "constructor", "toString"]

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

  it.effect("defers operations and global API lookup until effects/layers run", () => Effect.gen(function*() {
    const local = storageArea()
    const sync = storageArea()
    const session = storageArea()
    vi.stubGlobal("chrome", undefined)
    const layers = [ChromeKeyValueStore.layerLocal(), ChromeKeyValueStore.layerSync(), ChromeKeyValueStore.layerSession()]
    const missingError = yield* Effect.flip(Effect.provide(KeyValueStore.KeyValueStore, layers[0]!))
    expect(missingError.method).toBe("initialize")
    expect(missingError.cause).toBeInstanceOf(Error)
    vi.stubGlobal("chrome", { storage: { local, sync, session } })

    for (const [index, area] of [local, sync, session].entries()) {
      const store = yield* Effect.provide(KeyValueStore.KeyValueStore, layers[index]!)
      const set = store.set("key", "value")
      expect(area.set).not.toHaveBeenCalled()
      yield* set
      expect(area.set).toHaveBeenCalledOnce()
    }

    const injected = yield* Effect.provide(KeyValueStore.KeyValueStore, ChromeKeyValueStore.layer(local))
    expect(yield* injected.get("key")).toBe("value")
  }))
})
