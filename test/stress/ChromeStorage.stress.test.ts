// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChromeStorageError, make } from "../../src/ChromeStorage.js"
import type { AreaName, Change, Changes, ChromeStorageApi, StorageAreaApi } from "../../src/ChromeStorage.js"
import { burst, expectOperations, gatedEvent, labelled, newest, pendingCalls, pendingCount } from "./support.js"

const areas = ["local", "sync", "session", "managed"] as const

const fixture = (throwEvery?: number) => {
  const onChanged = gatedEvent<[changes: Changes, areaName: AreaName]>()
  const pending = pendingCalls(throwEvery)

  const area = (name: AreaName): StorageAreaApi => ({
    get: () => pending.call(`${name}:get`).then(() => ({ key: name })),
    getBytesInUse: () => pending.call(`${name}:getBytesInUse`).then(() => 1),
    getKeys: () => pending.call(`${name}:getKeys`).then(() => ["key"]),
    set: () => pending.call(`${name}:set`),
    remove: () => pending.call(`${name}:remove`),
    clear: () => pending.call(`${name}:clear`)
  })

  const api: ChromeStorageApi = {
    local: area("local"), sync: area("sync"), session: area("session"), managed: area("managed"), onChanged
  }

  return { onChanged, pending, service: make(api) }
}

const newValueOf = (change: Change): number => {
  const value = change.changes["key"]?.newValue
  expect(value).toBeTypeOf("number")

  return Number(value)
}

describe("ChromeStorage stress", () => {
  it.effect("keeps the newest 64 of 4,096 area changes interleaved with 4,096 others, then removes both listeners", () => Effect.gen(function*() {
    const { service, onChanged } = fixture()
    const local = yield* Effect.forkScoped(Stream.runCollect(Stream.take(service.local.onChanged, 64)))
    const all = yield* Effect.forkScoped(Stream.runCollect(Stream.take(service.onChanged, 64)))

    yield* onChanged.registered(2)

    for (let index = 0; index < burst; index++) {
      onChanged.emit({ key: { newValue: index } }, "sync")
      onChanged.emit({ key: { newValue: index } }, "local")
    }

    // Filtered-out sync changes never take a slot in the local subscription's buffer.
    const localChanges = yield* Fiber.join(local)
    expect(localChanges.map(newValueOf)).toEqual(newest(burst))
    expect(localChanges.every((change) => change.area === "local")).toBe(true)

    const allChanges = yield* Fiber.join(all)
    expect(allChanges.map((change) => [change.area, newValueOf(change)])).toEqual(
      newest(burst, 32).flatMap((index) => [["sync", index], ["local", index]])
    )
    expect(onChanged.listeners.size).toBe(0)
    expect(new Set(onChanged.removed)).toEqual(new Set(onChanged.added))
  }))

  it.effect("churns 512 concurrent per-area and global subscriptions through interruption", () => Effect.gen(function*() {
    const { service, onChanged } = fixture()
    const streams = [...areas.map((name) => service[name].onChanged), service.onChanged]

    for (let round = 0; round < 4; round++) {
      const fibers = yield* Effect.forEach(Array.from({ length: 512 }), (_, index) =>
        Effect.forkChild(Stream.runDrain(streams[index % streams.length]!)))

      yield* onChanged.registered(512)

      for (let index = 0; index < 64; index++) {
        for (const name of areas) onChanged.emit({ key: { newValue: index } }, name)
      }

      yield* Effect.forEach(fibers.filter((_, index) => index % 3 === 0), Fiber.interrupt, { concurrency: "unbounded" })
      yield* Effect.forEach(fibers.filter((_, index) => index % 3 !== 0), Fiber.interrupt, { concurrency: "unbounded" })
      expect(onChanged.listeners.size).toBe(0)
    }

    expect(onChanged.added).toHaveLength(2048)
    expect(onChanged.removed).toHaveLength(2048)
    expect(new Set(onChanged.removed)).toEqual(new Set(onChanged.added))
  }))

  it.effect("settles 1,024 concurrent calls newest first with interleaved rejections, keeping area and operation", () => Effect.gen(function*() {
    const { service, pending } = fixture()

    const operations = areas.flatMap((name) => {
      const read = [
        () => labelled(`${name}:get`, service[name].get(["key"])),
        () => labelled(`${name}:getBytesInUse`, service[name].getBytesInUse("key")),
        () => labelled(`${name}:getKeys`, service[name].getKeys)
      ]

      return name === "managed" ? read : [
        ...read,
        () => labelled(`${name}:set`, service[name].set({ key: name })),
        () => labelled(`${name}:remove`, service[name].remove("key")),
        () => labelled(`${name}:clear`, service[name].clear)
      ]
    })

    const calls = Array.from({ length: 1024 }, (_, index) => operations[index % operations.length]!())
    const fiber = yield* Effect.forkChild(Effect.all(calls, { concurrency: "unbounded" }))

    yield* pending.arrived(pendingCount(1024))
    const rejected = pending.settleInterleaved()
    const results = yield* Fiber.join(fiber)

    expectOperations(
      results, new Map([...pending.thrown, ...rejected]), ChromeStorageError,
      (error) => `${error.area}:${error.operation}`
    )
  }))
})
