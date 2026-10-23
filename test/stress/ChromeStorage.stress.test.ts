// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Deferred, Effect, Exit, Fiber, Option, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChromeStorageError, limits, make } from "../../src/ChromeStorage.js"
import type { AreaName, Change, Changes, ChromeStorageApi, GetKeys, StorageAreaApi } from "../../src/ChromeStorage.js"
import { makeStorage } from "../../src/testing/Storage.js"
import { burst, expectOperations, gatedEvent, labelled, newest, pendingCalls, pendingCount } from "./support.js"

const areas = ["local", "sync", "session", "managed"] as const

const writable = ["local", "sync", "session"] as const

/** A deterministic generator (mulberry32), so every run takes the same interleaving. */
const seeded = (seed: number) => {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const shuffle = <A>(values: ReadonlyArray<A>, random: () => number): Array<A> => {
  const result = Array.from(values)

  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    const value = result[index]!
    result[index] = result[other]!
    result[other] = value
  }

  return result
}

const fixture = (throwEvery?: number) => {
  const onChanged = gatedEvent<[changes: Changes, areaName: AreaName]>()
  const pending = pendingCalls(throwEvery)

  const area = (name: AreaName): StorageAreaApi => ({
    get: () => pending.call(`${name}:get`).then(() => ({ key: name })),
    getBytesInUse: () => pending.call(`${name}:getBytesInUse`).then(() => 1),
    getKeys: () => pending.call(`${name}:getKeys`).then(() => ["key"]),
    set: () => pending.call(`${name}:set`),
    remove: () => pending.call(`${name}:remove`),
    clear: () => pending.call(`${name}:clear`),
    setAccessLevel: () => pending.call(`${name}:setAccessLevel`)
  })

  const api: ChromeStorageApi = {
    local: area("local"), sync: area("sync"), session: area("session"), managed: area("managed"), onChanged
  }

  return { api, onChanged, pending, service: make(api) }
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

  it.effect("keeps the newest 64 of a 4,096-change burst for every area at once", () => Effect.gen(function*() {
    const { service, onChanged } = fixture()
    const fibers = yield* Effect.forEach(areas, (name) => Effect.forkScoped(Stream.runCollect(Stream.take(service[name].onChanged, 64))))

    yield* onChanged.registered(areas.length)

    for (let index = 0; index < burst; index++) {
      for (const name of areas) onChanged.emit({ key: { newValue: index } }, name)
    }

    for (const [position, fiber] of fibers.entries()) {
      const changes = yield* Fiber.join(fiber)
      expect(changes.map(newValueOf)).toEqual(newest(burst))
      expect(changes.every((change) => change.area === areas[position])).toBe(true)
    }

    expect(onChanged.listeners.size).toBe(0)
    expect(onChanged.removed).toHaveLength(areas.length)
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

  it.effect("interrupts 512 subscriptions at every stage in a seeded order, ending with zero listeners", () => Effect.gen(function*() {
    const random = seeded(0x5eed)
    const { api, service, onChanged } = fixture()
    const streams = [...areas.map((name) => service[name].onChanged), service.onChanged]
    const streamOf = (index: number) => streams[index % streams.length]!

    // The same API, except that registration adds the listener and then throws.
    const failing = gatedEvent<[changes: Changes, areaName: AreaName]>()
    const registrationCause = new Error("registration failed")

    const failingService = make({
      ...api,
      onChanged: {
        addListener: (listener) => {
          failing.addListener(listener)

          throw registrationCause
        },
        removeListener: failing.removeListener
      }
    })

    const downstreamCause = new Error("downstream failed")

    for (let round = 0; round < 2; round++) {
      const indices = Array.from({ length: 512 }, (_, index) => index)
      const at = (stage: number) => indices.filter((index) => index % 7 === stage)

      // Stage 0: interrupted before the stream has started.
      const early = yield* Effect.forEach(at(0), (index) => Effect.forkChild(Stream.runDrain(streamOf(index))))
      yield* Effect.forEach(shuffle(early, random), Fiber.interrupt, { concurrency: "unbounded" })
      expect(onChanged.listeners.size).toBe(0)

      // Stage 1: draining, interrupted in the middle of the burst.
      const midBurst = yield* Effect.forEach(at(1), (index) => Effect.forkChild(Stream.runDrain(streamOf(index))))
      // Stage 2: draining, interrupted after the burst.
      const draining = yield* Effect.forEach(at(2), (index) => Effect.forkChild(Stream.runDrain(streamOf(index))))
      // Stage 3: blocked downstream on its first change while its buffer overflows.
      const blockedIndices = at(3)
      const received = yield* Deferred.make<void>()
      let receipts = 0

      const blocked = yield* Effect.forEach(blockedIndices, (index) => Effect.forkChild(Stream.runForEach(streamOf(index), () => {
        receipts++

        return receipts === blockedIndices.length
          ? Effect.andThen(Deferred.succeed(received, undefined), Effect.never)
          : Effect.never
      })))

      // Stage 4: completes on its own after one change.
      const completing = yield* Effect.forEach(at(4), (index) => Effect.forkChild(Stream.runCollect(Stream.take(streamOf(index), 1))))

      // Stage 5: fails downstream on its tenth change.
      const failingDownstream = yield* Effect.forEach(at(5), (index) => Effect.forkChild(Effect.flip(Stream.runDrain(
        Stream.mapEffect(Stream.zipWithIndex(streamOf(index)), ([, position]) => position === 9 ? Effect.fail(downstreamCause) : Effect.void)
      ))))

      // Stage 6: registration fails after partly adding the listener.
      const failedRegistration = yield* Effect.forEach(at(6), (index) => Effect.forkChild(Effect.flip(Stream.runDrain(
        index % 2 === 0 ? failingService.onChanged : failingService[areas[index % areas.length]!].onChanged
      ))))

      yield* onChanged.registered(midBurst.length + draining.length + blocked.length + completing.length + failingDownstream.length)

      for (let index = 0; index < burst; index++) {
        if (index === burst / 2) {
          yield* Effect.forEach(shuffle(midBurst, random), Fiber.interrupt, { concurrency: "unbounded" })
        }

        for (const name of areas) onChanged.emit({ key: { newValue: index } }, name)
      }

      // The mid-burst interruption yields, so these may take a change from either half.
      for (const fiber of completing) {
        const changes = yield* Fiber.join(fiber)
        expect(changes).toHaveLength(1)
        expect(newValueOf(changes[0]!)).toBeGreaterThanOrEqual(burst / 2 - 64)
        expect(newValueOf(changes[0]!)).toBeLessThan(burst)
      }

      for (const error of yield* Effect.forEach(failingDownstream, Fiber.join)) expect(error).toBe(downstreamCause)

      for (const error of yield* Effect.forEach(failedRegistration, Fiber.join)) {
        expect(error).toBeInstanceOf(ChromeStorageError)
        expect(error).toMatchObject({ operation: "onChanged", cause: registrationCause })
      }

      yield* Deferred.await(received)
      const remaining = shuffle([...draining, ...blocked], random)
      yield* Effect.forEach(remaining, Fiber.interrupt, { concurrency: "unbounded" })

      for (const fiber of [...early, ...midBurst, ...remaining]) {
        expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
      }

      expect(onChanged.listeners.size).toBe(0)
      expect(failing.listeners.size).toBe(0)
    }

    expect(new Set(onChanged.removed)).toEqual(new Set(onChanged.added))
    expect(failing.added).toHaveLength(2 * 73)
    expect(new Set(failing.removed)).toEqual(new Set(failing.added))
  }))

  it.effect("settles 2,048 concurrent calls newest first with interleaved rejections and throws, keeping area and operation", () => Effect.gen(function*() {
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
        () => labelled(`${name}:clear`, service[name].clear),
        () => labelled(`${name}:setAccessLevel`, service[name].setAccessLevel("TRUSTED_CONTEXTS"))
      ]
    })

    const calls = Array.from({ length: 2048 }, (_, index) => operations[index % operations.length]!())
    const fiber = yield* Effect.forkChild(Effect.all(calls, { concurrency: "unbounded" }))

    yield* pending.arrived(pendingCount(2048))
    const rejected = pending.settleInterleaved()
    const results = yield* Fiber.join(fiber)

    expect(pending.thrown.size).toBe(Math.ceil(2048 / 7))
    expect(rejected.size).toBeGreaterThan(0)
    expectOperations(
      results, new Map([...pending.thrown, ...rejected]), ChromeStorageError,
      (error) => `${error.area}:${error.operation}`
    )
  }))

  it.effect("interrupts 1,024 in-flight calls mid-operation; the rest settle with their own outcome", () => Effect.gen(function*() {
    const random = seeded(1024)
    const total = 1024
    const arrivals = yield* Deferred.make<void>()
    // Each call addresses its own key, so every in-flight call can be settled individually.
    const inFlight = new Map<string, { readonly resolve: () => void; readonly reject: (cause: Error) => void }>()

    const call = (id: string) => new Promise<void>((resolve, reject) => {
      inFlight.set(id, { resolve, reject })

      if (inFlight.size === total) Deferred.doneUnsafe(arrivals, Effect.void)
    })

    const keyOf = (keys: GetKeys | undefined) => JSON.stringify(keys)

    const area = (name: AreaName): StorageAreaApi => ({
      get: (keys) => call(`${name}:get:${keyOf(keys)}`).then(() => ({})),
      getBytesInUse: (keys) => call(`${name}:getBytesInUse:${keyOf(keys)}`).then(() => 0),
      getKeys: () => call(`${name}:getKeys:${keyOf(undefined)}`).then(() => []),
      set: (items) => call(`${name}:set:${keyOf(Object.keys(items)[0])}`),
      remove: (keys) => call(`${name}:remove:${keyOf(keys)}`),
      clear: () => call(`${name}:clear:${keyOf(undefined)}`)
    })

    const service = make({
      local: area("local"), sync: area("sync"), session: area("session"), managed: area("managed"),
      onChanged: gatedEvent<[changes: Changes, areaName: AreaName]>()
    })

    const jobs = Array.from({ length: total }, (_, index) => {
      const name = writable[index % writable.length]!
      const key = `k${index}`

      const operations = [
        ["get", Effect.asVoid(service[name].get(key))],
        ["getBytesInUse", Effect.asVoid(service[name].getBytesInUse(key))],
        ["set", service[name].set({ [key]: index })],
        ["remove", service[name].remove(key)]
      ] as const

      const [operation, effect] = operations[Math.floor(index / writable.length) % operations.length]!
      const id = `${name}:${operation}:${JSON.stringify(key)}`

      return { id, name, operation, effect }
    })

    const fibers = yield* Effect.forEach(jobs, (job) => Effect.forkChild(job.effect))
    yield* Deferred.await(arrivals)
    expect(new Set(jobs.map((job) => job.id))).toEqual(new Set(inFlight.keys()))

    const doomed = new Set(shuffle(jobs.map((_, index) => index), random).slice(0, total / 2))
    yield* Effect.forEach(Array.from(doomed), (index) => Fiber.interrupt(fibers[index]!), { concurrency: "unbounded" })

    // Settle everything afterwards, interrupted calls included: their late outcomes are discarded.
    const causes = new Map<string, Error>()

    for (const [position, job] of jobs.entries()) {
      const settle = inFlight.get(job.id)!

      if (position % 3 === 0) {
        const cause = new Error(`${job.id} rejected`)
        causes.set(job.id, cause)
        settle.reject(cause)
      } else {
        settle.resolve()
      }
    }

    for (const [position, job] of jobs.entries()) {
      const exit = yield* Fiber.await(fibers[position]!)
      const cause = causes.get(job.id)

      if (doomed.has(position)) {
        expect(Exit.hasInterrupts(exit)).toBe(true)
      } else if (cause === undefined) {
        expect(Exit.isSuccess(exit)).toBe(true)
      } else {
        const error = Option.getOrUndefined(Exit.findErrorOption(exit))
        expect(error).toBeInstanceOf(ChromeStorageError)
        expect(error).toMatchObject({ area: job.name, operation: job.operation, cause })
      }
    }
  }))

  it.effect("keeps fixture state consistent with its change events under 4,096 racing writes across areas", () => Effect.gen(function*() {
    const random = seeded(42)
    const fixture = makeStorage()
    const storage = make(fixture.api)

    const replayed: Record<AreaName, Map<string, unknown>> = {
      local: new Map(), sync: new Map(), session: new Map(), managed: new Map()
    }

    let events = 0
    // The fixture collects listener exceptions, so mismatches are recorded, not thrown.
    const mismatches: Array<string> = []

    fixture.api.onChanged.addListener((changes, name) => {
      events++

      for (const [key, change] of Object.entries(changes)) {
        const previous = replayed[name].get(key)

        if (JSON.stringify(change.oldValue) !== JSON.stringify(previous) || Object.hasOwn(change, "oldValue") !== replayed[name].has(key)) {
          mismatches.push(`${name}:${key}`)
        }

        if (Object.hasOwn(change, "newValue")) replayed[name].set(key, change.newValue)
        else replayed[name].delete(key)
      }
    })

    const writes = Array.from({ length: 4096 }, () => {
      const name = writable[Math.floor(random() * writable.length)]!
      const key = `k${Math.floor(random() * 32)}`
      const roll = random()
      const area = storage[name]

      return roll < 0.6 ? area.set({ [key]: Math.floor(random() * 4), [`${key}-shadow`]: { nested: [roll < 0.3] } })
        : roll < 0.95 ? area.remove([key, `${key}-shadow`])
        : area.clear
    })

    yield* Effect.all(writes, { concurrency: "unbounded" })

    expect(events).toBeGreaterThan(1000)
    expect(mismatches).toEqual([])

    for (const name of writable) {
      const stored = yield* storage[name].get()
      expect(stored).toEqual(Object.fromEntries(replayed[name]))
      // Chrome lists keys in sorted order; these keys are ASCII, where `sort` agrees with it.
      expect(yield* storage[name].getKeys).toEqual(Array.from(replayed[name].keys()).sort())
    }
  }))

  it.effect("keeps every listener's replica consistent while listeners write re-entrantly 2,048 times", () => Effect.gen(function*() {
    const random = seeded(7)
    const fixture = makeStorage()
    const storage = make(fixture.api)
    const replicas = Array.from({ length: 3 }, () => new Map<string, unknown>())
    const mismatches: Array<string> = []
    let budget = 2048

    const replay = (replica: Map<string, unknown>, label: string) => (changes: Changes, name: AreaName) => {
      if (name !== "local") return

      for (const [key, change] of Object.entries(changes)) {
        if (JSON.stringify(change.oldValue) !== JSON.stringify(replica.get(key))) mismatches.push(`${label}:${key}`)

        if (Object.hasOwn(change, "newValue")) replica.set(key, change.newValue)
        else replica.delete(key)
      }
    }

    // The middle listener writes from inside the dispatch, as a listener running an Effect synchronously does.
    fixture.api.onChanged.addListener(replay(replicas[0]!, "before"))
    fixture.api.onChanged.addListener((changes, name) => {
      replay(replicas[1]!, "writer")(changes, name)

      if (name === "local" && budget > 0) {
        budget--
        const key = `k${Math.floor(random() * 16)}`
        void (random() < 0.7 ? fixture.api.local.set({ [key]: Math.floor(random() * 8) }) : fixture.api.local.remove(key))
      }
    })
    fixture.api.onChanged.addListener(replay(replicas[2]!, "after"))

    for (let round = 0; budget > 0 && round < 4096; round++) {
      yield* storage.local.set({ [`k${Math.floor(random() * 16)}`]: round })
    }

    expect(budget).toBe(0)
    expect(mismatches).toEqual([])
    const stored = yield* storage.local.get()

    for (const replica of replicas) expect(Object.fromEntries(replica)).toEqual(stored)
  }))

  it.effect("never lets 512 seeded sync writes exceed Chrome's quotas, and rejected writes change nothing", () => Effect.gen(function*() {
    const random = seeded(0x9007a)
    const fixture = makeStorage()
    const storage = make(fixture.api)
    let events = 0
    fixture.api.onChanged.addListener(() => { events++ })
    const outcomes = new Map<string, number>()

    for (let index = 0; index < 512; index++) {
      // Phases of 128 writes from an empty area: tiny items over 700 keys reach MAX_ITEMS,
      // then large ones straddle QUOTA_BYTES_PER_ITEM and QUOTA_BYTES.
      const large = Math.floor(index / 128) % 2 === 1

      if (index % 128 === 0) yield* storage.sync.clear
      const before = { keys: yield* storage.sync.getKeys, bytes: yield* storage.sync.getBytesInUse(), events }

      const items = Object.fromEntries(Array.from({ length: 1 + Math.floor(random() * (large ? 3 : 16)) }, () => [
        `k${Math.floor(random() * 700)}`,
        "x".repeat(Math.floor(random() * (large ? limits.sync.QUOTA_BYTES_PER_ITEM * 1.05 : 8)))
      ]))

      const exit = yield* Effect.exit(storage.sync.set(items))
      const outcome = Exit.isSuccess(exit) ? "stored" : String(Option.getOrUndefined(Exit.findErrorOption(exit))?.cause)
      outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1)

      if (Exit.isFailure(exit)) {
        expect(yield* storage.sync.getKeys).toEqual(before.keys)
        expect(yield* storage.sync.getBytesInUse()).toBe(before.bytes)
        expect(events).toBe(before.events)
      }

      expect(yield* storage.sync.getBytesInUse()).toBeLessThanOrEqual(limits.sync.QUOTA_BYTES)
      expect((yield* storage.sync.getKeys).length).toBeLessThanOrEqual(limits.sync.MAX_ITEMS)
    }

    expect(new Set(outcomes.keys())).toEqual(new Set([
      "stored",
      "Error: Resource::kQuotaBytesPerItem quota exceeded",
      "Error: Resource::kQuotaBytes quota exceeded",
      "Error: Resource::kMaxItems quota exceeded"
    ]))
  }))

  it.effect("reads, measures, lists and clears a 20,000-key area in one change event", () => Effect.gen(function*() {
    const fixture = makeStorage()
    const storage = make(fixture.api)
    const count = 20000
    const items = Object.fromEntries(Array.from({ length: count }, (_, index) => [`key-${index}`, index]))
    fixture.controls.seed("local", items)
    fixture.controls.seed("managed", items)

    const keys = Object.keys(items)
    // Chrome's sorted order ("key-10" before "key-2"); ASCII keys sort the same with `sort`.
    expect(yield* storage.local.getKeys).toEqual([...keys].sort())
    expect(yield* storage.managed.getKeys).toHaveLength(count)
    expect(yield* storage.local.get(keys)).toEqual(items)
    expect(yield* storage.local.get([...keys, ...keys])).toEqual(items)
    const expectedBytes = keys.reduce((sum, key, index) => sum + key.length + String(index).length, 0)
    expect(yield* storage.local.getBytesInUse()).toBe(expectedBytes)
    expect(yield* storage.local.getBytesInUse(keys)).toBe(expectedBytes)

    const local = yield* Effect.forkScoped(Stream.runCollect(Stream.take(storage.local.onChanged, 1)))
    yield* Effect.promise(() => fixture.controls.onChanged.waitForListener())
    yield* storage.local.clear

    const [cleared] = yield* Fiber.join(local)
    expect(Object.keys(cleared!.changes)).toHaveLength(count)
    expect(cleared!.changes["key-19999"]).toEqual({ oldValue: 19999 })
    expect(yield* storage.local.getKeys).toEqual([])
    expect(yield* storage.managed.getKeys).toHaveLength(count)
    expect(fixture.controls.onChanged.listenerCount).toBe(0)
  }))
})
