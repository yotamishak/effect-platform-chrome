// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Deferred, Effect, Exit, Fiber, Option, Predicate, Queue, Schema, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChromeStorageError, make as makeStorage } from "../../src/ChromeStorage.js"
import type { AreaName, Changes, ChromeStorageApi, Items, StorageAreaApi } from "../../src/ChromeStorage.js"
import { make } from "../../src/ChromeSchemaStorage.js"
import type { Migration } from "../../src/ChromeSchemaStorage.js"
import { burst, expectOperations, gatedEvent, labelled, pendingCalls, pendingCount } from "./support.js"

const writable = ["local", "sync", "session"] as const

class MigrationFailure extends Schema.TaggedError<MigrationFailure>()("MigrationFailure", { index: Schema.Int }) {}

/** A deterministic generator (mulberry32), so every run sees the same interleaving. */
const seeded = (seed: number) => {
  let state = seed >>> 0

  return (bound: number): number => {
    state = (state + 0x6D2B79F5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), state | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)

    return (((mixed ^ (mixed >>> 14)) >>> 0) % bound)
  }
}

const shuffle = <A>(items: ReadonlyArray<A>, next: (bound: number) => number): Array<A> => {
  const result = [...items]

  for (let index = result.length - 1; index > 0; index--) {
    const other = next(index + 1)
    const swapped = result[index]!
    result[index] = result[other]!
    result[other] = swapped
  }

  return result
}

/** Completes once `arrive` has run `size` times, instead of sleeping. */
const countdown = (size: number) => {
  const done = Deferred.makeUnsafe<void>()
  let count = 0

  const arriveUnsafe = () => {
    count++

    if (count === size) Deferred.doneUnsafe(done, Effect.void)
  }

  return { arriveUnsafe, arrive: Effect.sync(arriveUnsafe), await: Deferred.await(done) }
}

/**
 * In-memory areas, or areas whose every call waits on `pending` when it is given. A read
 * of a `held` key calls `onHeld`, then waits until `release` is called.
 */
const fixture = (pending?: ReturnType<typeof pendingCalls>, onHeld: () => void = () => {}) => {
  const onChanged = gatedEvent<[changes: Changes, areaName: AreaName]>()
  const held = new Set<string>()
  const heldReads = Deferred.makeUnsafe<void>()
  const counts = { get: 0, set: 0, remove: 0 }

  const area = (name: AreaName) => {
    const data = new Map<string, Items[string]>()

    const gate = (operation: string) => pending === undefined ? Promise.resolve() : pending.call(`${name}:${operation}`)

    const api: StorageAreaApi = {
      get: async (keys) => {
        counts.get++
        await gate("get")
        const requested = Predicate.isString(keys) ? [keys] : Array.isArray(keys) ? keys : []

        if (requested.some((key) => held.has(key))) {
          onHeld()
          await Effect.runPromise(Deferred.await(heldReads))
        }

        const result: Items = {}

        for (const key of requested) {
          if (data.has(key)) Object.defineProperty(result, key, { value: data.get(key), enumerable: true })
        }

        return result
      },
      getBytesInUse: async () => 0,
      set: async (items) => {
        counts.set++
        await gate("set")

        for (const [key, value] of Object.entries(items)) data.set(key, value)
      },
      remove: async (keys) => {
        counts.remove++
        await gate("remove")

        for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key)
      },
      clear: async () => { data.clear() }
    }

    return { api, data }
  }

  const areas = { local: area("local"), sync: area("sync"), session: area("session"), managed: area("managed") }

  const api: ChromeStorageApi = {
    local: areas.local.api, sync: areas.sync.api, session: areas.session.api, managed: areas.managed.api, onChanged
  }

  return {
    onChanged,
    held,
    counts,
    data: (name: AreaName) => areas[name].data,
    release: () => Deferred.doneUnsafe(heldReads, Effect.void),
    service: make(makeStorage(api))
  }
}

const entryOptions = (key: string, area: AreaName = "local") =>
  ({ namespace: "stress", key, area, version: 1, schema: Schema.String }) as const

const change = (key: string, version: number, payload: string): Changes => ({ [key]: { newValue: { version, payload } } })

describe("ChromeSchemaStorage stress", () => {
  // This is a latest-state stream (one pending change, one pending value), not a 64-event
  // log: exactly the newest change of a burst survives.
  it.effect("coalesces a 4,096-change burst to its newest value and removes the listener", () => Effect.gen(function*() {
    const { service, onChanged } = fixture()
    const entry = service.entry(entryOptions("theme"))
    const other = service.entry(entryOptions("other"))
    const initial = yield* Deferred.make<void>()

    const consumer = yield* Effect.forkScoped(entry.observe.pipe(
      Stream.tap(() => Deferred.succeed(initial, undefined)),
      Stream.takeUntil((value) => Option.getOrUndefined(value) === `v${burst - 1}`),
      Stream.runCollect
    ))

    yield* Deferred.await(initial)
    expect(onChanged.listeners.size).toBe(1)

    for (let index = 0; index < burst; index++) {
      onChanged.emit(change(entry.storageKey, 1, `v${index}`), "local")
      // Another key, and the same key in another area, never reach this entry.
      onChanged.emit(change(other.storageKey, 1, "other"), "local")
      onChanged.emit(change(entry.storageKey, 1, "sync"), "sync")
    }

    expect(yield* Fiber.join(consumer)).toEqual([Option.none(), Option.some(`v${burst - 1}`)])
    expect(onChanged.listeners.size).toBe(0)
    expect(onChanged.removed).toEqual(onChanged.added)
  }))

  it.effect("delivers exactly the newest change of each seeded chunk to a blocked consumer, in order", () => Effect.gen(function*() {
    const { service, onChanged } = fixture()
    const entry = service.entry(entryOptions("chunks"))
    const next = seeded(0x5eed)
    const received = yield* Queue.unbounded<void>()
    const release = yield* Queue.unbounded<void>()
    const chunks: Array<number> = []

    for (let total = 0; total < burst;) {
      const size = Math.min(1 + next(256), burst - total)
      total += size
      chunks.push(total - 1)
    }

    const consumer = yield* Effect.forkScoped(entry.observe.pipe(
      Stream.tap(() => Effect.andThen(Queue.offer(received, undefined), Queue.take(release))),
      Stream.take(chunks.length + 1),
      Stream.runCollect
    ))

    let index = 0

    for (const last of chunks) {
      yield* Queue.take(received)

      // Every change of the chunk arrives while the consumer is blocked on the previous value.
      for (; index <= last; index++) onChanged.emit(change(entry.storageKey, 1, `v${index}`), "local")

      yield* Queue.offer(release, undefined)
    }

    yield* Queue.take(received)
    yield* Queue.offer(release, undefined)
    expect(yield* Fiber.join(consumer)).toEqual([Option.none(), ...chunks.map((last) => Option.some(`v${last}`))])
    expect(onChanged.listeners.size).toBe(0)
  }))

  it.effect("drops 4,096 superseded failing migrations and fails only on a current one", () => Effect.gen(function*() {
    const { service, onChanged } = fixture()

    // Payloads "fail<n>" fail their migration with index n.
    const migrations: Array<Migration<MigrationFailure>> = [{ from: 0, run: (payload) => Predicate.isString(payload) && payload.startsWith("fail")
      ? Effect.fail(new MigrationFailure({ index: Number(payload.slice(4)) }))
      : Effect.succeed(payload) }]

    const entry = service.entry({ ...entryOptions("migrating"), migrations })
    const values: Array<Option.Option<string>> = []
    const seen = yield* Queue.unbounded<void>()

    const consumer = yield* Effect.forkScoped(entry.observe.pipe(
      Stream.tap((value) => Effect.andThen(Effect.sync(() => values.push(value)), Queue.offer(seen, undefined))),
      Stream.runDrain,
      Effect.flip
    ))

    yield* Queue.take(seen)

    for (let index = 0; index < burst; index++) {
      onChanged.emit(change(entry.storageKey, 0, index % 2 === 0 ? `fail${index}` : `ok${index}`), "local")
    }

    yield* Queue.take(seen)
    expect(values).toEqual([Option.none(), Option.some(`ok${burst - 1}`)])

    for (let index = 0; index < burst; index++) {
      onChanged.emit(change(entry.storageKey, 0, index % 2 === 1 ? `fail${index}` : `ok${index}`), "local")
    }

    expect(yield* Fiber.join(consumer)).toEqual(new MigrationFailure({ index: burst - 1 }))
    expect(values).toHaveLength(2)
    expect(onChanged.listeners.size).toBe(0)
  }))

  it.effect("churns 512 observers interrupted at every stage, in seeded order, ending with zero listeners", () => Effect.gen(function*() {
    const stages = ["start", "read", "default", "migration", "idle", "event"] as const
    const total = 512
    const assigned = Array.from({ length: total }, (_, index) => stages[index % stages.length]!)
    const count = (stage: typeof stages[number]) => assigned.filter((candidate) => candidate === stage).length
    // Reads held in storage, defaults and migrations parked, and initial values emitted.
    const settled = countdown(count("read") + count("default") + count("migration") + count("idle") + count("event"))
    const eventsParked = countdown(count("event"))
    const f = fixture(undefined, settled.arriveUnsafe)
    const never = Deferred.makeUnsafe<void>()

    // Reports that the stage was reached, then blocks until interrupted.
    const park = (reached: Effect.Effect<void>) => Effect.andThen(reached, Deferred.await(never))

    const observers = assigned.map((stage, index) => {
      const area = writable[index % writable.length]!

      // An initial migration settles the first phase; a change's migration the second.
      const reached = stage === "migration" ? settled.arrive : eventsParked.arrive
      const parks = stage === "migration" || stage === "event"

      const entry = f.service.entry({
        ...entryOptions(`${stage}-${index}`, area),
        version: 2,
        defaultValue: () => stage === "default" ? Effect.as(park(settled.arrive), "unreachable") : Effect.succeed("default"),
        migrations: [
          { from: 0, run: (payload) => parks ? Effect.as(park(reached), payload) : Effect.succeed(payload) },
          { from: 1, run: Effect.succeed }
        ]
      })

      if (stage === "read") f.held.add(entry.storageKey)

      if (stage === "migration") f.data(area).set(entry.storageKey, { version: 0, payload: "old" })

      return { entry, area, stage }
    })

    const fibers = yield* Effect.forEach(observers, ({ entry, stage }) => Effect.forkChild(Stream.runDrain(
      stage === "idle" || stage === "event" ? Stream.tap(entry.observe, () => settled.arrive) : entry.observe
    )))

    const starting = fibers.filter((_, index) => assigned[index] === "start")
    // "start" observers are interrupted before they have necessarily run at all.
    yield* Effect.forEach(starting, Fiber.interrupt, { concurrency: "unbounded" })
    yield* settled.await

    // "event" observers have emitted their initial value; park them decoding a change.
    for (const { entry, area, stage } of observers) {
      if (stage === "event") f.onChanged.emit(change(entry.storageKey, 0, "event"), area)
    }

    yield* eventsParked.await
    expect(f.onChanged.listeners.size).toBe(total - starting.length)

    yield* Effect.forEach(shuffle(fibers, seeded(512)), Fiber.interrupt, { concurrency: "unbounded" })
    expect(f.onChanged.listeners.size).toBe(0)
    expect(f.onChanged.removed).toHaveLength(f.onChanged.added.length)
    expect(new Set(f.onChanged.removed)).toEqual(new Set(f.onChanged.added))

    // Held reads settling after interruption reach no observer and write nothing.
    f.release()
    const exits = yield* Effect.forEach(fibers, Fiber.await)
    expect(exits.every((exit) => Exit.hasInterrupts(exit))).toBe(true)
    expect(f.counts.set).toBe(0)
  }))

  it.effect("observes 2,048 entries through a clear-like deletion and then a migrating change", () => Effect.gen(function*() {
    const f = fixture()
    const population = 2048
    const phases = [countdown(population), countdown(population), countdown(population)] as const
    const defaulted = (index: number) => index % 2 === 0

    const migrations = [{ from: 0, run: (payload: Schema.Json) => Effect.succeed(Predicate.isString(payload) ? payload.toUpperCase() : payload) }]

    // Half the entries default on deletion; the others observe it as None.
    const entries = Array.from({ length: population }, (_, index) => defaulted(index)
      ? f.service.entry({ ...entryOptions(`entry-${index}`), migrations, defaultValue: () => Effect.succeed(`default-${index}`) })
      : f.service.entry({ ...entryOptions(`entry-${index}`), migrations }))

    for (const [index, entry] of entries.entries()) f.data("local").set(entry.storageKey, { version: 1, payload: `stored-${index}` })

    // Each observer reports its n-th value to phase n.
    const fibers = yield* Effect.forEach(entries, (entry) => {
      let emitted = 0

      return Effect.forkChild(entry.observe.pipe(
        Stream.take(phases.length),
        Stream.tap(() => Effect.suspend(() => phases[emitted++]!.arrive)),
        Stream.runCollect
      ))
    })

    yield* phases[0].await
    const cleared: Changes = {}

    for (const [index, entry] of entries.entries()) cleared[entry.storageKey] = { oldValue: { version: 1, payload: `stored-${index}` } }
    f.onChanged.emit(cleared, "local")
    yield* phases[1].await
    const migrated: Changes = {}

    for (const [index, entry] of entries.entries()) migrated[entry.storageKey] = { newValue: { version: 0, payload: `legacy-${index}` } }
    f.onChanged.emit(migrated, "local")
    const results = yield* Effect.forEach(fibers, Fiber.join)

    expect(results).toEqual(entries.map((_, index) => [
      Option.some(`stored-${index}`),
      defaulted(index) ? Option.some(`default-${index}`) : Option.none(),
      Option.some(`LEGACY-${index}`)
    ]))

    expect(f.onChanged.listeners.size).toBe(0)
    expect(f.counts.set).toBe(0)
  }))

  it.effect.each([false, true])("races 1,024 write-back migrations of one envelope, with a concurrent writer=%s", (writer) => Effect.gen(function*() {
    const f = fixture()
    const readers = 1024
    const started = countdown(readers)
    const release = yield* Deferred.make<void>()

    const entry = f.service.entry({ ...entryOptions("shared"), migrations: [{ from: 0, run: (payload) => Effect.gen(function*() {
      yield* started.arrive
      yield* Deferred.await(release)

      return payload
    }) }] })

    f.data("local").set(entry.storageKey, { version: 0, payload: "snapshot" })
    const fibers = yield* Effect.forEach(Array.from({ length: readers }), () => Effect.forkChild(entry.get({ writeBack: true })))
    yield* started.await

    if (writer) yield* entry.set("newer")
    yield* Deferred.succeed(release, undefined)
    const results = yield* Effect.forEach(fibers, Fiber.join)
    expect(results.every((result) => Option.getOrUndefined(result) === "snapshot")).toBe(true)

    if (writer) {
      // Every migration re-read the newer envelope and left it in place.
      expect(f.data("local").get(entry.storageKey)).toEqual({ version: 1, payload: "newer" })
      expect(f.counts.set).toBe(1)
    } else {
      // Write-backs in one context serialize their re-read and write: the first writes the
      // current envelope, and every later re-read sees it instead of the migrated snapshot.
      expect(f.data("local").get(entry.storageKey)).toEqual({ version: 1, payload: "snapshot" })
      expect(f.counts.set).toBe(1)
    }

    expect(f.counts.get).toBe(readers * 2)
  }))

  it.effect("settles 1,536 concurrent entry operations with interleaved rejections and throws, keeping area and operation", () => Effect.gen(function*() {
    const pending = pendingCalls()
    const { service } = fixture(pending)
    const total = 1536

    const operations = writable.flatMap((area) => {
      const entry = service.entry(entryOptions(`key-${area}`, area))

      return [
        () => labelled(`${area}:get`, entry.get()),
        () => labelled(`${area}:set`, entry.set(area)),
        () => labelled(`${area}:remove`, entry.remove)
      ]
    })

    const next = seeded(1536)
    const calls = Array.from({ length: total }, () => operations[next(operations.length)]!())
    const fiber = yield* Effect.forkChild(Effect.all(calls, { concurrency: "unbounded" }))

    yield* pending.arrived(pendingCount(total))
    expect(pending.thrown.size).toBe(total - pendingCount(total))
    const rejected = pending.settleInterleaved()
    const results = yield* Fiber.join(fiber)

    expectOperations(
      results, new Map([...pending.thrown, ...rejected]), ChromeStorageError,
      (error) => `${error.area}:${error.operation}`
    )
  }))

  // Chrome applies storage calls in submission order and reads at submission. A write-back
  // must therefore submit its write while storage still holds the snapshot it re-read; a
  // same-context write submitted in between would be silently overwritten.
  it.effect("never lets 512 write-backs overwrite 512 interleaved same-context writes, in seeded order", () => Effect.gen(function*() {
    const next = seeded(4242)
    const data = new Map<string, Items[string]>()
    const violations: Array<unknown> = []
    let migrated = 0

    /** Settles after a seeded number of microtask hops, so completions interleave without sleeping. */
    const settle = async () => {
      for (let hop = next(6); hop > 0; hop--) await Promise.resolve()
    }

    const local: StorageAreaApi = {
      get: async (keys) => {
        const result: Items = {}

        for (const key of Predicate.isString(keys) ? [keys] : []) {
          if (data.has(key)) result[key] = data.get(key)
        }

        await settle()

        return result
      },
      getBytesInUse: async () => 0,
      set: async (items) => {
        for (const [key, value] of Object.entries(items)) {
          // SAFETY: this test writes only envelopes through the entries below.
          const envelope = value as { readonly version: number; readonly payload: string }

          if (envelope.version === 1) {
            migrated++
            const current = data.get(key)

            if (!(Predicate.isObject(current) && "version" in current && current.version === 0 && "payload" in current && current.payload === envelope.payload)) {
              violations.push({ current, written: envelope })
            }
          }

          data.set(key, value)
        }

        await settle()
      },
      remove: async (keys) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key)
        await settle()
      },
      clear: async () => { data.clear() }
    }

    const unused: StorageAreaApi = { ...local }
    const service = make(makeStorage({ local, sync: unused, session: unused, managed: unused, onChanged: gatedEvent() }))
    const total = 512

    const current = service.entry({ ...entryOptions("contended"), migrations: [{ from: 0, run: (payload) => Effect.as(Effect.forEach(Array.from({ length: next(4) }), () => Effect.yieldNow, { discard: true }), payload) }] })

    // A second descriptor of the same key, still on version 0, writes legacy envelopes.
    const legacy = service.entry({ ...entryOptions("contended"), version: 0 })
    yield* legacy.set("initial")

    const operations = shuffle([
      ...Array.from({ length: total }, () => Effect.asVoid(current.get({ writeBack: true }))),
      ...Array.from({ length: total }, (_, index) => index % 8 === 0 ? legacy.remove : legacy.set(`user-${index}`))
    ], next)

    // A bounded window keeps write-backs and writes overlapping throughout the run.
    yield* Effect.all(operations, { concurrency: 8 })
    expect(violations).toEqual([])
    // Both paths ran: some write-backs wrote, and some found a newer same-context write.
    expect(migrated).toBeGreaterThan(0)
    expect(migrated).toBeLessThan(total)
  }))
})
