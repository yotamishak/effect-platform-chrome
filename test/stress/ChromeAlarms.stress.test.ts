// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Exit, Fiber, Option, Result, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChromeAlarmsError, make } from "../../src/ChromeAlarms.js"
import type { Alarm, ChromeAlarmsApi } from "../../src/ChromeAlarms.js"
import { burst, expectOperations, gatedEvent, labelled, newest, pendingCalls, pendingCount } from "./support.js"

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

  return { onAlarm, pending, service: make(api) }
}

describe("ChromeAlarms stress", () => {
  it.effect("keeps the newest 64 of a 4,096-alarm burst and removes the listener", () => Effect.gen(function*() {
    const { service, onAlarm } = fixture()
    const consumer = yield* Effect.forkScoped(Stream.runCollect(Stream.take(service.onAlarm, 64)))

    yield* onAlarm.registered(1)

    for (let index = 0; index < burst; index++) onAlarm.emit(alarm(index))

    const received = yield* Fiber.join(consumer)
    expect(received.map((value) => value.scheduledTime)).toEqual(newest(burst))
    expect(onAlarm.listeners.size).toBe(0)
    expect(onAlarm.removed).toEqual(onAlarm.added)
  }))

  it.effect("churns 512 concurrent subscriptions through interruption without leaking listeners", () => Effect.gen(function*() {
    const { service, onAlarm } = fixture()

    for (let round = 0; round < 4; round++) {
      const fibers = yield* Effect.forEach(Array.from({ length: 512 }), () => Effect.forkChild(Stream.runDrain(service.onAlarm)))

      yield* onAlarm.registered(512)

      for (let index = 0; index < 128; index++) onAlarm.emit(alarm(index))

      // Interleaved interruption: odd fibers first, then even ones.
      yield* Effect.forEach(fibers.filter((_, index) => index % 2 === 1), Fiber.interrupt, { concurrency: "unbounded" })
      expect(onAlarm.listeners.size).toBe(256)
      yield* Effect.forEach(fibers.filter((_, index) => index % 2 === 0), Fiber.interrupt, { concurrency: "unbounded" })
      expect(onAlarm.listeners.size).toBe(0)
    }

    expect(onAlarm.added).toHaveLength(2048)
    expect(onAlarm.removed).toHaveLength(2048)
    expect(new Set(onAlarm.removed)).toEqual(new Set(onAlarm.added))
  }))

  it.effect("settles 1,024 concurrent calls newest first with interleaved rejections, keeping operation names", () => Effect.gen(function*() {
    const { service, pending } = fixture()

    const operations = [
      (name: string) => labelled("create", service.create(name, { delayInMinutes: 1 })),
      (name: string) => labelled("get", service.get(name)),
      () => labelled("getAll", service.getAll),
      (name: string) => labelled("clear", service.clear(name)),
      () => labelled("clearAll", service.clearAll)
    ]

    const calls = Array.from({ length: 1024 }, (_, index) => operations[index % operations.length]!(`alarm-${index}`))

    const fiber = yield* Effect.forkChild(Effect.all(calls, { concurrency: "unbounded" }))

    yield* pending.arrived(pendingCount(1024))
    const rejected = pending.settleInterleaved()
    const results = yield* Fiber.join(fiber)

    expectOperations(results, new Map([...pending.thrown, ...rejected]), ChromeAlarmsError)
    expect(results.filter(({ result }) => Result.isSuccess(result))).toHaveLength(1024 - pending.thrown.size - rejected.size)
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
})
