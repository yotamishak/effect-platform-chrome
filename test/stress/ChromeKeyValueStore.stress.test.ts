// The adapter targets Effect's unstable persistence API, and the pinned Effect v4 test
// integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Deferred, Effect, Exit, Fiber, Predicate, Result } from "effect"
import * as Base64 from "effect/encoding/Base64"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import { describe, expect, it } from "@effect/vitest"
import { defaultNamespace, make } from "../../src/ChromeKeyValueStore.js"
import type { ChromeKeyValueStoreApi } from "../../src/ChromeKeyValueStore.js"
import { pendingCalls, pendingCount } from "./support.js"

type NativeOperation = "get" | "getKeys" | "set" | "remove"

const physical = (namespace: string, key: string) =>
  `effect-platform-chrome/KeyValueStore/v1:${namespace.length}:${namespace}:${key}`

/** A deterministic generator: the same seed always yields the same sequence. */
const seeded = (seed: number) => {
  let state = seed >>> 0

  return (bound: number): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0

    return state % bound
  }
}

/**
 * An in-memory storage area that applies each call when it completes, as Chrome does.
 * Calls to operations in `hold` wait until the test releases them, with a gate that
 * completes once N are waiting instead of sleeping.
 */
const heldArea = (options: { readonly getKeys: boolean } = { getKeys: true }) => {
  const data = new Map<string, ReturnType<typeof JSON.parse>>()
  const hold = new Set<NativeOperation>()
  const waiting: Array<{ readonly operation: NativeOperation; readonly release: () => void }> = []
  const gates: Array<{ readonly size: number; readonly deferred: Deferred.Deferred<void> }> = []
  const calls = { get: 0, getKeys: 0, set: 0, remove: 0 }
  const removed: Array<ReadonlyArray<string>> = []

  const enter = <A>(operation: NativeOperation, run: () => A): Promise<A> => {
    calls[operation]++

    if (!hold.has(operation)) return Promise.resolve().then(run)

    return new Promise<A>((resolve) => {
      waiting.push({ operation, release: () => resolve(run()) })

      for (const gate of gates.splice(0)) {
        if (waiting.length >= gate.size) Deferred.doneUnsafe(gate.deferred, Effect.void)
        else gates.push(gate)
      }
    })
  }

  const base = {
    get: (keys: string | null) => enter("get", () => keys === null
      ? Object.fromEntries(data)
      : data.has(keys) ? Object.fromEntries([[keys, data.get(keys)]]) : {}),
    set: (items: Parameters<ChromeKeyValueStoreApi["set"]>[0]) => enter("set", () => {
      for (const [key, value] of Object.entries(items)) data.set(key, value)
    }),
    remove: (keys: string | Array<string>) => enter("remove", () => {
      const list = Array.isArray(keys) ? keys : [keys]
      removed.push(list)

      for (const key of list) data.delete(key)
    })
  }

  const api: ChromeKeyValueStoreApi = options.getKeys
    ? { ...base, getKeys: () => enter("getKeys", () => Array.from(data.keys())) }
    : base

  return {
    api,
    data,
    hold,
    calls,
    removed,
    /** Completes once at least `size` held calls are waiting. */
    waiting: (size: number): Effect.Effect<void> => Effect.suspend(() => {
      if (waiting.length >= size) return Effect.void
      const deferred = Deferred.makeUnsafe<void>()
      gates.push({ size, deferred })

      return Deferred.await(deferred)
    }),
    /** Releases every waiting call, in the order `order` picks (arrival order by default). */
    release: (order: (size: number) => number = () => 0): number => {
      let released = 0

      while (waiting.length > 0) {
        const [next] = waiting.splice(order(waiting.length), 1)
        next!.release()
        released++
      }

      return released
    }
  }
}

const methods = ["get", "getUint8Array", "has", "set", "remove", "clear", "size", "isEmpty"] as const

type Method = typeof methods[number]

const keyless: ReadonlySet<Method> = new Set(["clear", "size", "isEmpty"])

const run = (store: KeyValueStore.KeyValueStore, method: Method, key: string): Effect.Effect<void, KeyValueStore.KeyValueStoreError> => {
  switch (method) {
    case "get": return Effect.asVoid(store.get(key))
    case "getUint8Array": return Effect.asVoid(store.getUint8Array(key))
    case "has": return Effect.asVoid(store.has(key))
    case "set": return store.set(key, key)
    case "remove": return store.remove(key)
    case "clear": return store.clear
    case "size": return Effect.asVoid(store.size)
    case "isEmpty": return Effect.asVoid(store.isEmpty)
  }
}

describe("ChromeKeyValueStore stress", () => {
  it.effect("maps 1,024 concurrent calls with interleaved rejections and throws to the right method, key and cause", () => Effect.gen(function*() {
    const pending = pendingCalls()
    const total = 1_024

    // One store per call, so every native call is labelled with the store method that made it.
    const apiFor = (method: Method): ChromeKeyValueStoreApi => ({
      get: () => pending.call(method).then(() => ({})),
      set: () => pending.call(method),
      remove: () => pending.call(method),
      getKeys: () => pending.call(method).then(() => [])
    })

    const calls = Array.from({ length: total }, (_, index) => {
      const method = methods[index % methods.length]!

      return { method, key: `${method}:${index}`, store: make(apiFor(method), { namespace: `ns:${index}` }) }
    })

    const fiber = yield* Effect.forkChild(Effect.forEach(calls, ({ method, key, store }) =>
      Effect.map(Effect.result(run(store, method, key)), (result) => ({ method, key, result })), { concurrency: "unbounded" }))

    yield* pending.arrived(pendingCount(total))
    expect(pending.calls).toHaveLength(pendingCount(total))
    const rejected = pending.settleInterleaved()
    const results = yield* Fiber.join(fiber)
    const injected = new Map([...pending.thrown, ...rejected])
    const seen = new Set<unknown>()

    for (const { method, key, result } of results) {
      if (Result.isSuccess(result)) continue

      const error = result.failure
      expect(error).toBeInstanceOf(KeyValueStore.KeyValueStoreError)
      expect(error.method).toBe(method)
      expect(error.key).toBe(keyless.has(method) ? undefined : key)
      expect(error.cause).toBeInstanceOf(Error)

      if (error.cause instanceof Error) {
        expect(injected.get(error.cause)).toBe(method)
        seen.add(error.cause)
      }
    }

    expect(seen.size).toBe(injected.size)
    expect(results.filter(({ result }) => Result.isFailure(result))).toHaveLength(injected.size)
    expect(pending.thrown.size).toBe(Math.ceil(total / 7))
  }))

  it.effect("applies 1,024 concurrent writes to one key in Chrome's completion order", () => Effect.gen(function*() {
    const area = heldArea()
    const store = make(area.api)
    const other = make(area.api, { namespace: "other" })
    yield* other.set("key", "untouched")
    area.hold.add("set")
    const values = Array.from({ length: 1_024 }, (_, index) => index % 2 === 0 ? `value:${index}` : new Uint8Array([index % 256, index >> 8]))
    const writes = yield* Effect.forkChild(Effect.forEach(values, (value) => store.set("key", value), { concurrency: "unbounded", discard: true }))
    yield* area.waiting(values.length)
    const random = seeded(0x5eed)
    const order: Array<number> = []
    // Record which write lands last by replaying the release order over a list of indices.
    const indices = values.map((_, index) => index)
    area.release((size) => {
      const picked = random(size)
      order.push(indices.splice(picked, 1)[0]!)

      return picked
    })
    yield* Fiber.join(writes)
    const last = values[order.at(-1)!]!
    expect(yield* store.get("key")).toBe(Predicate.isString(last) ? last : Base64.encode(last))
    expect(yield* store.size).toBe(1)
    expect(yield* other.get("key")).toBe("untouched")
  }))

  it.effect("interrupts 512 two-step operations at every stage: none starts its second step after interruption", () => Effect.gen(function*() {
    const area = heldArea()
    const count = 512
    const stores = Array.from({ length: count }, (_, index) => make(area.api, { namespace: `ns:${index}` }))
    yield* Effect.forEach(stores, (store, index) => store.set("key", `value:${index}`), { discard: true })
    const setsBefore = area.calls.set

    // Even stores clear; odd stores modify. Both read first, then write.
    const operation = (index: number) => index % 2 === 0
      ? stores[index]!.clear
      : Effect.asVoid(stores[index]!.modify("key", (value) => value + "!"))

    area.hold.add("get").add("getKeys").add("set").add("remove")
    const fibers = yield* Effect.forEach(stores, (_, index) => Effect.forkChild(operation(index)))
    yield* area.waiting(count)
    // Stage one: interrupt a third while their reads are in flight.
    const duringRead = fibers.filter((_, index) => index % 3 === 0)
    yield* Effect.forEach(duringRead, Fiber.interrupt, { concurrency: "unbounded", discard: true })
    expect(area.release()).toBe(count)
    // The rest reach their write, which stays held.
    const writing = count - duringRead.length
    yield* area.waiting(writing)
    // Stage two: interrupt another third while their writes are in flight.
    const duringWrite = fibers.filter((_, index) => index % 3 === 1)
    yield* Effect.forEach(duringWrite, Fiber.interrupt, { concurrency: "unbounded", discard: true })
    expect(area.release()).toBe(writing)
    yield* Effect.forEach(fibers.filter((_, index) => index % 3 === 2), Fiber.join, { discard: true })

    for (const [index, fiber] of fibers.entries()) {
      const exit = yield* Fiber.await(fiber)
      expect(Exit.hasInterrupts(exit)).toBe(index % 3 !== 2)
    }

    // Writes Chrome had already started land; writes not yet started never do.
    const store = (index: number) => make(area.api, { namespace: `ns:${index}` })
    area.hold.clear()

    for (let index = 0; index < count; index++) {
      const expected = index % 3 === 0 ? `value:${index}` : index % 2 === 0 ? undefined : `value:${index}!`
      expect(yield* store(index).get("key")).toBe(expected)
    }

    expect(area.calls.set - setsBefore + area.calls.remove).toBe(writing)
  }))

  it.effect.each([true, false])("sizes and clears 16 namespaces of 1,024 keys among 4,096 unrelated items (getKeys: %s)", (getKeys) => Effect.gen(function*() {
    const area = heldArea({ getKeys })
    const namespaces = Array.from({ length: 16 }, (_, index) => index === 0 ? "" : `ns:${"x".repeat(index)}`)

    for (let index = 0; index < 4_096; index++) area.data.set(`unrelated:${index}`, index)

    yield* Effect.forEach(namespaces, (namespace) => {
      const store = make(area.api, { namespace })

      return Effect.forEach(Array.from({ length: 1_024 }, (_, index) => `key:${index}`),
        (key) => store.set(key, key), { concurrency: "unbounded", discard: true })
    }, { discard: true })

    expect(area.data.size).toBe(4_096 + 16 * 1_024)

    for (const namespace of namespaces) expect(yield* make(area.api, { namespace }).size).toBe(1_024)

    const removalsBefore = area.removed.length
    yield* make(area.api, { namespace: "ns:x" }).clear
    expect(area.removed.length).toBe(removalsBefore + 1)
    expect(new Set(area.removed.at(-1))).toEqual(new Set(Array.from({ length: 1_024 }, (_, index) => physical("ns:x", `key:${index}`))))

    for (const namespace of namespaces) {
      const store = make(area.api, { namespace })
      expect(yield* store.size).toBe(namespace === "ns:x" ? 0 : 1_024)
      expect(yield* store.get("key:1023")).toBe(namespace === "ns:x" ? undefined : "key:1023")
    }

    expect(area.calls.getKeys > 0).toBe(getKeys)
    expect(area.data.get("unrelated:4095")).toBe(4_095)
  }))

  it.effect("clears 512 namespaces concurrently while each gains a key mid-listing, removing only listed keys", () => Effect.gen(function*() {
    const area = heldArea()
    const count = 512
    const stores = Array.from({ length: count }, (_, index) => make(area.api, { namespace: `${index}` }))
    yield* Effect.forEach(stores, (store) => store.set("old", "old"), { discard: true })
    area.hold.add("getKeys")
    const clearing = yield* Effect.forkChild(Effect.forEach(stores, (store) => store.clear, { concurrency: "unbounded", discard: true }))
    yield* area.waiting(count)
    yield* Effect.forEach(stores, (store) => store.set("new", "new"), { concurrency: "unbounded", discard: true })
    area.release(seeded(512))
    yield* Fiber.join(clearing)

    // Every listing completed after the new writes, so each clear removed both of its keys.
    for (const store of stores) {
      expect(yield* store.get("old")).toBeUndefined()
      expect(yield* store.get("new")).toBeUndefined()
    }

    // One removal per namespace, each naming exactly that namespace's keys.
    expect(new Set(area.removed.map((keys) => [...keys].sort().join("|")))).toEqual(new Set(
      stores.map((_, index) => [physical(`${index}`, "new"), physical(`${index}`, "old")].sort().join("|"))
    ))
    expect(area.removed).toHaveLength(count)
  }))

  it.effect.each([true, false])("matches a reference model over 4,000 seeded operations on adversarial names (getKeys: %s)", (getKeys) => Effect.gen(function*() {
    const area = heldArea({ getKeys })
    const namespaces = ["", "a", "a:", "a:b", "0:", "🌍", "__proto__", defaultNamespace]
    const keys = ["", ":", "b", "b:c", "é", "é", "__proto__", "constructor", "🌍\u0000"]
    const stores = namespaces.map((namespace) => make(area.api, { namespace }))
    const model = namespaces.map(() => new Map<string, string | Uint8Array>())
    const random = seeded(4_000)
    const encoder = new TextEncoder()
    area.data.set("unrelated", "keep")

    const asString = (value: string | Uint8Array | undefined) =>
      value === undefined || Predicate.isString(value) ? value : Base64.encode(value)

    const asBytes = (value: string | Uint8Array | undefined) =>
      value === undefined || value instanceof Uint8Array ? value : encoder.encode(value)

    for (let step = 0; step < 4_000; step++) {
      const which = random(stores.length)
      const store = stores[which]!
      const entries = model[which]!
      const key = keys[random(keys.length)]!

      switch (random(9)) {
        case 0:
        case 1: {
          const value = random(2) === 0
            ? `s${random(1_000)}:${key}`
            : Uint8Array.from({ length: random(9) }, () => random(256))

          yield* store.set(key, value)
          entries.set(key, value)
          break
        }

        case 2:
          yield* store.remove(key)
          entries.delete(key)
          break
        case 3:
          expect(yield* store.get(key)).toEqual(asString(entries.get(key)))
          break
        case 4:
          expect(yield* store.getUint8Array(key)).toEqual(asBytes(entries.get(key)))
          break
        case 5:
          expect(yield* store.has(key)).toBe(entries.has(key))
          break
        case 6:
          expect(yield* store.size).toBe(entries.size)
          expect(yield* store.isEmpty).toBe(entries.size === 0)
          break
        case 7: {
          const before = entries.get(key)
          const modified = yield* store.modify(key, (value) => value + "+")
          const expected = before === undefined ? undefined : asString(before) + "+"
          expect(modified).toBe(expected)

          if (expected !== undefined) entries.set(key, expected)
          break
        }

        default:
          if (random(8) === 0) {
            yield* store.clear
            entries.clear()
          }
      }
    }

    for (const [index, store] of stores.entries()) {
      expect(yield* store.size).toBe(model[index]!.size)

      for (const key of keys) expect(yield* store.get(key)).toEqual(asString(model[index]!.get(key)))
    }

    expect(area.data.get("unrelated")).toBe("keep")
  }))
})
