// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Deferred, Effect, Exit, Fiber, Option, Result, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChromeAlarmsError, make } from "../../src/ChromeAlarms.js"
import type { Alarm, AlarmCreateInfo, ChromeAlarmsApi } from "../../src/ChromeAlarms.js"
import { makeAlarms } from "../../src/testing/Alarms.js"
import { burst, expectOperations, gatedEvent, labelled, newest, pendingCalls, pendingCount } from "./support.js"

type CreateArgs = [info: AlarmCreateInfo] | [name: string | undefined, info: AlarmCreateInfo]

const alarm = (scheduledTime: number): Alarm => ({ name: `alarm-${scheduledTime}`, scheduledTime, persistAcrossSessions: true })

const fixture = (throwEvery?: number) => {
  const onAlarm = gatedEvent<[alarm: Alarm]>()
  const pending = pendingCalls(throwEvery)

  const api: ChromeAlarmsApi = {
    create: () => pending.call("create"),
    get: () => pending.call("get").then(() => alarm(0)),
    getAll: () => pending.call("getAll").then(() => [alarm(0)]),
    clear: () => pending.call("clear").then(() => true),
    clearAll: () => pending.call("clearAll").then(() => true),
    onAlarm
  }

  return { api, onAlarm, pending, service: make(api) }
}

/** A deterministic PRNG (mulberry32), so every run explores the same interleaving. */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6D2B79F5) | 0
  let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value

  return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
}

describe("ChromeAlarms stress", () => {
  it.effect("keeps the newest 64 of a 4,096-alarm burst in order and removes the listener", () => Effect.gen(function*() {
    const { service, onAlarm } = fixture()
    const consumer = yield* Effect.forkScoped(Stream.runCollect(Stream.take(service.onAlarm, 64)))

    yield* onAlarm.registered(1)

    for (let index = 0; index < burst; index++) onAlarm.emit(alarm(index))

    const received = yield* Fiber.join(consumer)
    expect(received.map((value) => value.scheduledTime)).toEqual(newest(burst))
    expect(onAlarm.listeners.size).toBe(0)
    expect(onAlarm.removed).toEqual(onAlarm.added)
  }))

  it.effect("churns 512 subscriptions through interruption at every stage and failed registration", () => Effect.gen(function*() {
    const { api, service, onAlarm } = fixture()
    const causes = new Set<Error>()

    // Registration that adds the listener, then throws, as a revoked context might.
    const failing = make({
      ...api,
      onAlarm: {
        addListener: (listener) => {
          onAlarm.addListener(listener)
          const cause = new Error("registration failed")
          causes.add(cause)

          throw cause
        },
        removeListener: onAlarm.removeListener
      }
    })

    const failures: Array<ChromeAlarmsError> = []
    const stage = (index: number) => index % 5

    // Stage 3 ends after one alarm; stage 4 fails registration; the rest run until interrupted.
    const subscription = (index: number): Effect.Effect<void, ChromeAlarmsError> => {
      switch (stage(index)) {
        case 3: return Effect.asVoid(Stream.runCollect(Stream.take(service.onAlarm, 1)))
        case 4: return Stream.runDrain(failing.onAlarm).pipe(
          Effect.catch((error) => Effect.sync(() => { failures.push(error) }))
        )
        default: return Stream.runDrain(service.onAlarm)
      }
    }

    for (let round = 0; round < 4; round++) {
      const fibers = yield* Effect.forEach(Array.from({ length: 512 }, (_, index) => index),
        (index) => Effect.forkChild(subscription(index)))

      const at = (wanted: number) => fibers.filter((_, index) => stage(index) === wanted)
      const running = at(1).length + at(2).length + at(3).length

      // Stage 0: interrupted as soon as it is forked, before registration.
      yield* Effect.forEach(at(0), Fiber.interrupt, { concurrency: "unbounded" })
      // Stage 4: registration fails and the partially added listener is removed.
      yield* Effect.forEach(at(4), Fiber.join, { concurrency: "unbounded" })
      expect(onAlarm.listeners.size).toBeLessThanOrEqual(running)

      yield* onAlarm.registered(running)

      for (let index = 0; index < 128; index++) onAlarm.emit(alarm(index))

      // Stage 3 ends by itself; stage 1 is interrupted idle and stage 2 with a full buffer.
      yield* Effect.forEach(at(3), Fiber.join, { concurrency: "unbounded" })
      expect(onAlarm.listeners.size).toBe(at(1).length + at(2).length)

      yield* Effect.forEach([...at(1), ...at(2)], Fiber.interrupt, { concurrency: "unbounded" })
      expect(onAlarm.listeners.size).toBe(0)
    }

    expect(failures).toHaveLength(4 * 102)

    for (const failure of failures) {
      expect(failure.operation).toBe("onAlarm")
      expect(failure.cause instanceof Error && causes.has(failure.cause)).toBe(true)
    }

    expect(onAlarm.listeners.size).toBe(0)
    expect(onAlarm.removed).toHaveLength(onAlarm.added.length)
    expect(new Set(onAlarm.removed)).toEqual(new Set(onAlarm.added))
    expect(causes.size).toBe(4 * 102)
  }))

  it.effect("removes listeners of 512 subscriptions interrupted inside registration and during removal", () => Effect.gen(function*() {
    const { api, onAlarm } = fixture()
    let consumer: Fiber.Fiber<unknown, ChromeAlarmsError> | undefined
    let interruptedInside = 0
    let removing = 0

    const service = make({
      ...api,
      onAlarm: {
        // Interrupts the consumer mid-acquire, after the listener is in place and has an event.
        addListener: (listener) => {
          onAlarm.addListener(listener)
          listener(alarm(-1))

          if (consumer !== undefined) {
            interruptedInside++
            consumer.interruptUnsafe()
          }
        },
        // Delivers events while the listener is being removed.
        removeListener: (listener) => {
          removing++
          listener(alarm(-2))
          onAlarm.removeListener(listener)
          listener(alarm(-3))
        }
      }
    })

    for (let index = 0; index < 512; index++) {
      consumer = undefined
      const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(service.onAlarm, 2)))
      consumer = fiber
      const exit = yield* Fiber.await(fiber)

      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(onAlarm.listeners.size).toBe(0)
    }

    expect(interruptedInside).toBe(512)
    expect(removing).toBe(512)
    expect(onAlarm.removed).toEqual(onAlarm.added)
  }))

  it.effect("settles 2,048 concurrent calls newest first with interleaved rejections and throws", () => Effect.gen(function*() {
    const { service, pending } = fixture()

    const operations = [
      (name: string) => labelled("create", service.create(name, { delayInMinutes: 1 })),
      () => labelled("create", service.create({ periodInMinutes: 1 })),
      () => labelled("create", service.create(undefined, { when: 1 })),
      (name: string) => labelled("get", service.get(name)),
      () => labelled("get", service.get()),
      () => labelled("getAll", service.getAll),
      (name: string) => labelled("clear", service.clear(name)),
      () => labelled("clear", service.clear()),
      () => labelled("clearAll", service.clearAll)
    ]

    const calls = Array.from({ length: 2048 }, (_, index) => operations[index % operations.length]!(`alarm-${index}`))

    const fiber = yield* Effect.forkChild(Effect.all(calls, { concurrency: "unbounded" }))

    yield* pending.arrived(pendingCount(2048))
    const rejected = pending.settleInterleaved()
    const results = yield* Fiber.join(fiber)

    expect(pending.thrown.size).toBe(Math.ceil(2048 / 7))
    expectOperations(results, new Map([...pending.thrown, ...rejected]), ChromeAlarmsError)
    expect(results.filter(({ result }) => Result.isSuccess(result))).toHaveLength(2048 - pending.thrown.size - rejected.size)
  }))

  it.effect("interrupts 512 calls mid-operation and tolerates their late settlement", () => Effect.gen(function*() {
    const { service, pending } = fixture(0)

    const fibers = yield* Effect.forEach(Array.from({ length: 512 }), (_, index) =>
      Effect.forkChild(index % 2 === 0 ? service.getAll : service.clear(`alarm-${index}`)))

    yield* pending.arrived(512)
    yield* Effect.forEach(fibers, Fiber.interrupt, { concurrency: "unbounded" })
    pending.settleInterleaved()

    const exits = yield* Effect.forEach(fibers, Fiber.await)
    expect(exits.every((exit) => Exit.hasInterrupts(exit))).toBe(true)

    const after = yield* Effect.forkChild(service.get("after"))
    yield* pending.arrived(513)
    pending.calls[512]!.resolve()
    expect(yield* Fiber.join(after)).toEqual(Option.some(alarm(0)))
  }))

  it.effect("enforces the 500-alarm cap across 1,024 concurrent creates", () => Effect.gen(function*() {
    const alarms = make(makeAlarms().api)

    const results = yield* Effect.forEach(Array.from({ length: 1024 }, (_, index) => index), (index) =>
      Effect.result(alarms.create(`alarm-${index % 600}`, { delayInMinutes: 1 + index })), { concurrency: "unbounded" })

    const failures = results.filter(Result.isFailure).map((result) => result.failure)
    expect(results.filter(Result.isSuccess).length).toBeGreaterThanOrEqual(500)

    for (const failure of failures) {
      expect(failure.operation).toBe("create")
      expect(failure.cause).toEqual(new Error("An extension cannot have more than 500 active alarms."))
    }

    const names = (yield* alarms.getAll).map((alarm) => alarm.name)
    expect(names).toHaveLength(500)
    expect(new Set(names).size).toBe(500)
  }))

  it.effect("matches a sequential model under 4,096 seeded concurrent creates, clears and clearAlls", () => Effect.gen(function*() {
    const base = makeAlarms()
    const model = new Map<string, number>()
    let modelCleared = 0

    // Applies each call to the model in the order the fixture actually executes it.
    const create: ChromeAlarmsApi["create"] = (...args: CreateArgs) => {
      if (args.length === 1) return base.api.create(args[0])

      const [name, info] = args

      if (name === undefined) return base.api.create(undefined, info)

      const when = info.when ?? Number.NaN

      // Chrome leaves an identical alarm in place.
      if (model.get(name) !== when) {
        model.delete(name)
        model.set(name, when)
      }

      return base.api.create(name, info)
    }

    const api: ChromeAlarmsApi = {
      ...base.api,
      create,
      clear: (name) => {
        if (name !== undefined && model.delete(name)) modelCleared++

        return base.api.clear(name)
      },
      clearAll: () => {
        model.clear()

        return base.api.clearAll()
      }
    }

    const alarms = make(api)
    const random = seeded(0xA1A2)

    const operations = Array.from({ length: 4096 }, () => {
      const name = `alarm-${Math.floor(random() * 64)}`
      const pick = random()

      if (pick < 0.6) return Effect.as(alarms.create(name, { when: Math.floor(random() * 1_000_000) }), 0)

      if (pick < 0.98) return Effect.map(alarms.clear(name), (cleared) => cleared ? 1 : 0)

      return Effect.as(alarms.clearAll, 0)
    })

    const cleared = yield* Effect.all(operations, { concurrency: "unbounded" })

    expect(cleared.reduce((total, value) => total + value, 0)).toBe(modelCleared)
    expect((yield* alarms.getAll).map((alarm) => [alarm.name, alarm.scheduledTime]))
      .toEqual(Array.from(model.entries()))
  }))

  it.effect("fires a full population of 500 alarms in one poll to 128 subscribers", () => Effect.gen(function*() {
    const fixture = makeAlarms()
    const subscribed = Deferred.makeUnsafe<void>()

    // Delegates to the fixture's event, completing a gate once all subscribers are registered.
    const alarms = make({
      ...fixture.api,
      onAlarm: {
        addListener: (listener) => {
          fixture.api.onAlarm.addListener(listener)

          if (fixture.controls.onAlarm.listenerCount === 128) Deferred.doneUnsafe(subscribed, Effect.void)
        },
        removeListener: (listener) => fixture.api.onAlarm.removeListener(listener)
      }
    })

    for (let index = 0; index < 500; index++) {
      yield* alarms.create(`alarm-${index}`, index % 2 === 0
        ? { when: index * 10 }
        : { when: index * 10, periodInMinutes: 1 })
    }

    const subscribers = yield* Effect.forEach(Array.from({ length: 128 }), () =>
      Effect.forkChild(Stream.runCollect(Stream.take(alarms.onAlarm, 64))))

    yield* Deferred.await(subscribed)

    expect(fixture.controls.advance(5_000)).toEqual([])

    // Chrome fires due alarms newest first, so the buffer keeps the 64 oldest alarms.
    const expected = Array.from({ length: 64 }, (_, index) => `alarm-${63 - index}`)

    for (const received of yield* Effect.forEach(subscribers, Fiber.join)) {
      expect(received.map((value) => value.name)).toEqual(expected)
    }

    expect(fixture.controls.onAlarm.listenerCount).toBe(0)
    const remaining = yield* alarms.getAll
    expect(remaining).toHaveLength(250)
    expect(remaining.every((value) => value.periodInMinutes === 1 && value.scheduledTime > 5_000)).toBe(true)
  }))

  it.effect("delivers a whole 500-alarm poll while listeners clear and re-create alarms mid-dispatch", () => Effect.gen(function*() {
    const fixture = makeAlarms()
    const alarms = make(fixture.api)
    const random = seeded(0xA1A3)
    const seen: Array<string> = []
    const rejected: Array<unknown> = []
    let fresh = 0

    for (let index = 0; index < 500; index++) {
      yield* alarms.create(`alarm-${index}`, index % 2 === 0 ? { when: index } : { when: index, periodInMinutes: 1 })
    }

    // Each listener call clears a random alarm and creates an already-due one, which Chrome
    // can only apply after the poll that is being dispatched.
    fixture.api.onAlarm.addListener((alarm) => {
      seen.push(alarm.name)
      void fixture.api.clear(`alarm-${Math.floor(random() * 500)}`)
      void fixture.api.create(`fresh-${fresh++}`, { when: 0 }).catch((cause: unknown) => { rejected.push(cause) })
    })

    expect(fixture.controls.advance(500)).toEqual([])
    expect(seen).toEqual(Array.from({ length: 500 }, (_, index) => `alarm-${499 - index}`))

    // The next poll fires exactly what was due once the previous dispatch had finished.
    const before = yield* alarms.getAll
    const due = before.filter((alarm) => alarm.scheduledTime <= fixture.controls.now).map((alarm) => alarm.name).reverse()
    expect(due.length).toBeGreaterThan(0)
    expect(due.every((name) => name.startsWith("fresh-"))).toBe(true)
    // The surviving repeating alarms plus the creations reach the cap mid-dispatch.
    expect(rejected.length).toBeGreaterThan(0)
    expect(new Set(rejected.map(String))).toEqual(new Set(["Error: An extension cannot have more than 500 active alarms."]))
    expect(before).toHaveLength(500)

    seen.length = 0
    const created = fresh
    expect(fixture.controls.advance(0)).toEqual([])
    expect(seen).toEqual(due)

    // What is left is repeating alarms on their next slot and the second dispatch's creations.
    for (const alarm of yield* alarms.getAll) {
      if (alarm.name.startsWith("fresh-")) expect(Number(alarm.name.slice(6))).toBeGreaterThanOrEqual(created)
      else expect([alarm.periodInMinutes, alarm.scheduledTime > 500]).toEqual([1, true])
    }
  }))
})
