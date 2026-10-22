// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Deferred, Effect, Exit, Fiber, Option, Predicate, Schema, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChromeStorageError, make as makeStorage } from "../../src/ChromeStorage.js"
import type { AreaName, Changes, ChromeStorageApi, Items, StorageAreaApi } from "../../src/ChromeStorage.js"
import { make } from "../../src/ChromeSchemaStorage.js"
import { burst, expectOperations, gatedEvent, labelled, pendingCalls, pendingCount } from "./support.js"

const writable = ["local", "sync", "session"] as const

/** In-memory areas, or areas whose every call waits on `pending` when it is given. */
const fixture = (pending?: ReturnType<typeof pendingCalls>) => {
  const onChanged = gatedEvent<[changes: Changes, areaName: AreaName]>()

  const area = (name: AreaName): StorageAreaApi => {
    const data = new Map<string, Items[string]>()

    const gate = (operation: string) => pending === undefined ? Promise.resolve() : pending.call(`${name}:${operation}`)

    return {
      get: async (keys) => {
        await gate("get")
        const result: Items = {}

        for (const key of Predicate.isString(keys) ? [keys] : Array.isArray(keys) ? keys : []) {
          if (data.has(key)) Object.defineProperty(result, key, { value: data.get(key), enumerable: true })
        }

        return result
      },
      getBytesInUse: async () => 0,
      set: async (items) => {
        await gate("set")

        for (const [key, value] of Object.entries(items)) data.set(key, value)
      },
      remove: async (keys) => {
        await gate("remove")

        for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key)
      },
      clear: async () => { data.clear() }
    }
  }

  const api: ChromeStorageApi = {
    local: area("local"), sync: area("sync"), session: area("session"), managed: area("managed"), onChanged
  }

  return { onChanged, service: make(makeStorage(api)) }
}

const entryOptions = (key: string, area: AreaName = "local") =>
  ({ namespace: "stress", key, area, version: 1, schema: Schema.String }) as const

describe("ChromeSchemaStorage stress", () => {
  it.effect("coalesces a 4,096-change burst to its newest value and removes the listener", () => Effect.gen(function*() {
    const { service, onChanged } = fixture()
    const entry = service.entry(entryOptions("theme"))
    const other = service.entry(entryOptions("other"))
    const initial = yield* Deferred.make<void>()

    // The latest-state stream keeps one pending change; the last one written must win.
    const consumer = yield* Effect.forkScoped(entry.observe.pipe(
      Stream.tap(() => Deferred.succeed(initial, undefined)),
      Stream.takeUntil((value) => Option.getOrUndefined(value) === `v${burst - 1}`),
      Stream.runCollect
    ))

    yield* Deferred.await(initial)
    expect(onChanged.listeners.size).toBe(1)

    for (let index = 0; index < burst; index++) {
      onChanged.emit({ [entry.storageKey]: { newValue: { version: 1, payload: `v${index}` } } }, "local")
      // Another key, and the same key in another area, never reach this entry.
      onChanged.emit({ [other.storageKey]: { newValue: { version: 1, payload: "other" } } }, "local")
      onChanged.emit({ [entry.storageKey]: { newValue: { version: 1, payload: "sync" } } }, "sync")
    }

    expect(yield* Fiber.join(consumer)).toEqual([Option.none(), Option.some(`v${burst - 1}`)])
    expect(onChanged.listeners.size).toBe(0)
    expect(onChanged.removed).toEqual(onChanged.added)
  }))

  it.effect("churns 512 concurrent observers interrupted during and after their initial read", () => Effect.gen(function*() {
    const pending = pendingCalls(0)
    const { service, onChanged } = fixture(pending)

    const fibers = yield* Effect.forEach(Array.from({ length: 512 }), (_, index) => Effect.forkChild(
      Stream.runDrain(service.entry(entryOptions(`key-${index % 64}`, writable[index % writable.length])).observe)
    ))

    // Each observer registers synchronously before its initial read reaches the area.
    yield* pending.arrived(512)
    expect(onChanged.listeners.size).toBe(512)

    // Half the reads complete; the other half stay in flight while their observers stop.
    for (const [index, call] of pending.calls.entries()) {
      if (index % 2 === 0) call.resolve()
    }

    yield* Effect.forEach(fibers.filter((_, index) => index % 2 === 1), Fiber.interrupt, { concurrency: "unbounded" })
    yield* Effect.forEach(fibers.filter((_, index) => index % 2 === 0), Fiber.interrupt, { concurrency: "unbounded" })
    expect(onChanged.listeners.size).toBe(0)

    // Late settlement after interruption reaches no observer.
    for (const [index, call] of pending.calls.entries()) {
      if (index % 2 === 1) call.reject(new Error("late"))
    }

    const exits = yield* Effect.forEach(fibers, Fiber.await)
    expect(exits.every((exit) => Exit.hasInterrupts(exit))).toBe(true)
    expect(onChanged.added).toHaveLength(512)
    expect(new Set(onChanged.removed)).toEqual(new Set(onChanged.added))
  }))

  it.effect("settles 512 concurrent entry operations with interleaved rejections, keeping area and operation", () => Effect.gen(function*() {
    const pending = pendingCalls()
    const { service } = fixture(pending)

    const operations = writable.flatMap((area) => {
      const entry = service.entry(entryOptions(`key-${area}`, area))

      return [
        () => labelled(`${area}:get`, entry.get()),
        () => labelled(`${area}:set`, entry.set(area)),
        () => labelled(`${area}:remove`, entry.remove)
      ]
    })

    const calls = Array.from({ length: 512 }, (_, index) => operations[index % operations.length]!())
    const fiber = yield* Effect.forkChild(Effect.all(calls, { concurrency: "unbounded" }))

    yield* pending.arrived(pendingCount(512))
    const rejected = pending.settleInterleaved()
    const results = yield* Fiber.join(fiber)

    expectOperations(
      results, new Map([...pending.thrown, ...rejected]), ChromeStorageError,
      (error) => `${error.area}:${error.operation}`
    )
  }))
})
