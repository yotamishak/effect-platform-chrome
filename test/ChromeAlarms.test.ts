// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Deferred, Effect, Fiber, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeAlarms, ChromeAlarmsError, layer, layerLive, make } from "../src/ChromeAlarms.js"
import type { Alarm, AlarmCreateInfo, ChromeAlarmsApi, ChromeAlarmsService } from "../src/ChromeAlarms.js"
import { makeAlarms } from "../src/testing/Alarms.js"

const alarm: Alarm = { name: "tick", scheduledTime: 123, persistAcrossSessions: true }

type CreateArgs = [AlarmCreateInfo] | [string | undefined, AlarmCreateInfo]

const fixture = () => {
  const listeners = new Set<(alarm: Alarm) => void>()

  const api = {
    create: vi.fn<(...args: CreateArgs) => Promise<void>>(async () => {}),
    get: vi.fn<ChromeAlarmsApi["get"]>(async () => undefined),
    getAll: vi.fn<ChromeAlarmsApi["getAll"]>(async () => [alarm]),
    clear: vi.fn<ChromeAlarmsApi["clear"]>(async () => false),
    clearAll: vi.fn<ChromeAlarmsApi["clearAll"]>(async () => true),
    onAlarm: {
      addListener: vi.fn<ChromeAlarmsApi["onAlarm"]["addListener"]>((listener) => { listeners.add(listener) }),
      removeListener: vi.fn<ChromeAlarmsApi["onAlarm"]["removeListener"]>((listener) => { listeners.delete(listener) })
    }
  } satisfies ChromeAlarmsApi

  /** Completes once the next listener is registered, instead of sleeping. */
  const nextRegistration = () => {
    const registered = Deferred.makeUnsafe<void>()
    api.onAlarm.addListener.mockImplementationOnce((listener) => {
      listeners.add(listener)
      Deferred.doneUnsafe(registered, Effect.void)
    })

    return Deferred.await(registered)
  }

  return { api, listeners, nextRegistration, service: make(api) }
}

/** Every call of the service, each with the Chrome member it must report. */
const calls = (service: ChromeAlarmsService) => [
  ["create", service.create({ when: 42 })],
  ["create", service.create(undefined, { delayInMinutes: 1 })],
  ["create", service.create("tick", { periodInMinutes: 1 })],
  ["get", service.get()],
  ["get", service.get("tick")],
  ["getAll", service.getAll],
  ["clear", service.clear()],
  ["clear", service.clear("tick")],
  ["clearAll", service.clearAll]
] as const

describe("ChromeAlarms", () => {
  it.effect("is lazy and forwards each create overload with exactly the caller's arity", () => Effect.gen(function*() {
    const { api, service } = fixture()
    const info = { delayInMinutes: 0.5 }
    const pending = service.create("tick", info)
    expect(api.create).not.toHaveBeenCalled()
    yield* pending
    yield* service.create(info)
    yield* service.create(undefined, info)
    yield* service.create("", { when: 0, periodInMinutes: 0 })
    yield* service.create({ name: "named", periodInMinutes: 1 })
    expect(api.create.mock.calls).toEqual([
      ["tick", info], [info], [undefined, info], ["", { when: 0, periodInMinutes: 0 }],
      [{ name: "named", periodInMinutes: 1 }]
    ])
  }))

  it.effect("passes optional names only when given, keeping the empty string", () => Effect.gen(function*() {
    const { api, service } = fixture()
    yield* service.get()
    yield* service.get(undefined)
    yield* service.get("")
    yield* service.clear()
    yield* service.clear(undefined)
    yield* service.clear("")
    expect(api.get.mock.calls).toEqual([[], [], [""]])
    expect(api.clear.mock.calls).toEqual([[], [], [""]])
  }))

  it.effect("reads missing alarms as None and keeps alarms, empty lists and clear results", () => Effect.gen(function*() {
    const { api, service } = fixture()
    expect(api.getAll).not.toHaveBeenCalled()
    expect(api.clearAll).not.toHaveBeenCalled()
    expect(yield* service.get()).toEqual(Option.none())
    api.get.mockResolvedValueOnce(alarm)
    expect(yield* service.get("tick")).toEqual(Option.some(alarm))
    expect(yield* service.getAll).toEqual([alarm])
    api.getAll.mockResolvedValueOnce([])
    expect(yield* service.getAll).toEqual([])
    expect(yield* service.clear("missing")).toBe(false)
    api.clear.mockResolvedValueOnce(true)
    expect(yield* service.clear("tick")).toBe(true)
    expect(api.getAll).toHaveBeenCalledTimes(2)
  }))

  it.effect("completes clearAll whether Chrome resolves true or nothing", () => Effect.gen(function*() {
    const { api, service } = fixture()
    expect(yield* service.clearAll).toBeUndefined()
    api.clearAll.mockResolvedValueOnce(undefined)
    expect(yield* service.clearAll).toBeUndefined()
    expect(api.clearAll).toHaveBeenCalledTimes(2)
  }))

  it.effect("reexecutes stored effects, calling Chrome once per run", () => Effect.gen(function*() {
    const { api, service } = fixture()
    const effects = calls(service).map(([, effect]) => Effect.asVoid(effect))

    for (let index = 0; index < 256; index++) {
      for (const effect of effects) yield* effect
    }

    expect(api.create).toHaveBeenCalledTimes(768)

    for (const method of [api.get, api.clear]) expect(method).toHaveBeenCalledTimes(512)

    for (const method of [api.getAll, api.clearAll]) expect(method).toHaveBeenCalledTimes(256)
  }))

  it.effect("maps a rejection and a synchronous throw of every call to its operation", () => Effect.gen(function*() {
    for (const synchronous of [true, false]) {
      const { api, service } = fixture()
      const cause = new Error("Chrome failed")

      const fail = (): Promise<never> => {
        if (synchronous) throw cause

        return Promise.reject(cause)
      }

      api.create.mockImplementation(fail)
      api.get.mockImplementation(fail)
      api.getAll.mockImplementation(fail)
      api.clear.mockImplementation(fail)
      api.clearAll.mockImplementation(fail)

      for (const [operation, effect] of calls(service)) {
        const error = yield* Effect.flip(effect)
        expect(error).toBeInstanceOf(ChromeAlarmsError)
        expect(error.operation).toBe(operation)
        expect(error.cause).toBe(cause)
      }
    }
  }))

  it("interrupts a pending getAll and tolerates late rejection before reexecution", async () => {
    // An intentional AbortSignal runner boundary.
    const { api, service } = fixture()
    let notify!: () => void
    let reject!: (cause: Error) => void
    const ready = new Promise<void>((resolve) => { notify = resolve })
    const pending = new Promise<Array<Alarm>>((_resolve, fail) => { reject = fail })

    api.getAll.mockImplementationOnce(() => {
      notify()

      return pending
    })
    const controller = new AbortController()
    const result = Effect.runPromiseExit(service.getAll, { signal: controller.signal })

    await ready
    controller.abort()
    expect((await result)._tag).toBe("Failure")
    reject(new Error("permission revoked after cancellation"))
    expect(await Effect.runPromise(service.getAll)).toEqual([alarm])
    expect(api.getAll).toHaveBeenCalledTimes(2)
  })

  it.effect("does not undo a create whose fiber is interrupted while Chrome is scheduling it", () => Effect.gen(function*() {
    const base = makeAlarms()
    const arrived = Deferred.makeUnsafe<void>()
    const settled = Deferred.makeUnsafe<void>()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })

    const create: ChromeAlarmsApi["create"] = async (...args: CreateArgs) => {
      Deferred.doneUnsafe(arrived, Effect.void)
      await gate
      await (args.length === 1 || args[0] !== "tick" ? Promise.reject(new Error("unexpected")) : base.api.create(args[0], args[1]))
      Deferred.doneUnsafe(settled, Effect.void)
    }

    const alarms = make({ ...base.api, create })
    const fiber = yield* Effect.forkChild(alarms.create("tick", { when: 1 }))
    yield* Deferred.await(arrived)
    yield* Fiber.interrupt(fiber)
    expect(base.controls.alarm("tick")).toBeUndefined()

    release()
    yield* Deferred.await(settled)
    expect(yield* alarms.get("tick")).toEqual(Option.some({ name: "tick", scheduledTime: 1, persistAcrossSessions: true }))
  }))

  it.effect("emits alarms and removes the identical listener when the stream ends", () => Effect.gen(function*() {
    const { api, service, listeners, nextRegistration } = fixture()
    const registered = nextRegistration()
    const result = yield* Effect.forkScoped(Stream.runCollect(Stream.take(service.onAlarm, 2)))
    yield* registered
    expect(listeners.size).toBe(1)

    for (const listener of listeners) {
      listener(alarm)
      listener({ ...alarm, name: "second" })
    }

    expect(yield* Fiber.join(result)).toEqual([alarm, { ...alarm, name: "second" }])
    expect(listeners.size).toBe(0)
    expect(api.onAlarm.removeListener.mock.calls).toEqual(api.onAlarm.addListener.mock.calls)
  }))

  it.effect("removes the listener when a waiting subscription is interrupted", () => Effect.gen(function*() {
    const { api, service, listeners, nextRegistration } = fixture()
    const registered = nextRegistration()
    const fiber = yield* Effect.forkChild(Stream.runDrain(service.onAlarm))
    yield* registered
    expect(listeners.size).toBe(1)
    yield* Fiber.interrupt(fiber)
    expect(listeners.size).toBe(0)
    expect(api.onAlarm.removeListener.mock.calls).toEqual(api.onAlarm.addListener.mock.calls)
  }))

  it("removes the listener when an AbortSignal interrupts the subscription", async () => {
    // An intentional AbortSignal runner boundary.
    const { api, service, listeners } = fixture()
    let notify!: () => void
    const ready = new Promise<void>((resolve) => { notify = resolve })
    api.onAlarm.addListener.mockImplementationOnce((listener) => {
      listeners.add(listener)
      notify()
    })
    const controller = new AbortController()
    const result = Effect.runPromiseExit(Stream.runDrain(service.onAlarm), { signal: controller.signal })
    await ready
    controller.abort()
    expect((await result)._tag).toBe("Failure")
    expect(listeners.size).toBe(0)
  })

  it.effect("keeps the newest 64 alarms of an overflowing burst", () => Effect.gen(function*() {
    const { api, service, listeners } = fixture()
    api.onAlarm.addListener.mockImplementation((listener) => {
      listeners.add(listener)

      for (let index = 0; index < 100; index++) listener({ ...alarm, scheduledTime: index })
    })
    const result = yield* Stream.runCollect(Stream.take(service.onAlarm, 64))
    expect(result.map((value) => value.scheduledTime)).toEqual(Array.from({ length: 64 }, (_, index) => index + 36))
    expect(listeners.size).toBe(0)
  }))

  it.effect("types a registration failure and removes a partially registered listener", () => Effect.gen(function*() {
    const { api, service, listeners } = fixture()
    const cause = new Error("registration failed after adding")
    api.onAlarm.addListener.mockImplementationOnce((listener) => {
      listeners.add(listener)
      listener(alarm)
      throw cause
    })
    const error = yield* Effect.flip(Stream.runDrain(service.onAlarm))
    expect(error).toBeInstanceOf(ChromeAlarmsError)
    expect(error.operation).toBe("onAlarm")
    expect(error.cause).toBe(cause)
    expect(listeners.size).toBe(0)
    expect(api.onAlarm.removeListener).toHaveBeenCalledExactlyOnceWith(api.onAlarm.addListener.mock.calls[0]?.[0])

    // The same stream value subscribes again afterwards.
    api.onAlarm.addListener.mockImplementationOnce((listener) => {
      listeners.add(listener)
      listener(alarm)
    })
    expect(yield* Stream.runCollect(Stream.take(service.onAlarm, 1))).toEqual([alarm])
    expect(listeners.size).toBe(0)
  }))

  it.effect("types a failure to read the event itself", () => Effect.gen(function*() {
    const { api } = fixture()
    const cause = new Error("onAlarm is unavailable")
    const service = make({ ...api, get onAlarm(): ChromeAlarmsApi["onAlarm"] { throw cause } })
    const error = yield* Effect.flip(Stream.runDrain(service.onAlarm))
    expect(error.operation).toBe("onAlarm")
    expect(error.cause).toBe(cause)
  }))

  it.effect("times out a waiting consumer and releases its listener at the deadline", () => Effect.gen(function*() {
    const { api, service, listeners } = fixture()

    const result = yield* Stream.runDrain(service.onAlarm).pipe(
      Effect.timeout("5 seconds"), Effect.flip, Effect.forkScoped
    )

    yield* TestClock.adjust("4 seconds")
    expect(listeners.size).toBe(1)
    expect(api.onAlarm.removeListener).not.toHaveBeenCalled()

    yield* TestClock.adjust("1 second")
    expect((yield* Fiber.join(result))._tag).toBe("TimeoutError")
    expect(listeners.size).toBe(0)
    expect(api.onAlarm.removeListener.mock.calls).toEqual(api.onAlarm.addListener.mock.calls)
  }))

  it.effect("imports without chrome and fails layerLive with initialize", () => Effect.gen(function*() {
    vi.stubGlobal("chrome", undefined)
    const module = yield* Effect.promise(() => import("../src/ChromeAlarms.js"))
    expect(module.layerLive).toBe(layerLive)

    const error = yield* Effect.flip(Effect.provide(Effect.asVoid(ChromeAlarms), layerLive))

    expect(error).toBeInstanceOf(ChromeAlarmsError)
    expect(error.operation).toBe("initialize")
  }))

  it.effect("fails layerLive with initialize when chrome lacks alarms", () => Effect.gen(function*() {
    vi.stubGlobal("chrome", {})
    const error = yield* Effect.flip(Effect.provide(Effect.asVoid(ChromeAlarms), layerLive))
    expect(error.operation).toBe("initialize")
    expect(error.cause).toBeInstanceOf(Error)
  }))

  it.effect("builds layerLive from a fake global when the layer is built", () => Effect.gen(function*() {
    const { api } = fixture()
    vi.stubGlobal("chrome", { alarms: api })

    const result = yield* Effect.provide(Effect.flatMap(ChromeAlarms, (service) => service.getAll), layerLive)

    expect(result).toEqual([alarm])
  }))

  it.effect("provides an injected API through layer without a global", () => Effect.gen(function*() {
    const { api } = fixture()
    vi.stubGlobal("chrome", undefined)

    const result = yield* Effect.provide(Effect.flatMap(ChromeAlarms, (service) => service.getAll), layer(api))

    expect(result).toEqual([alarm])
  }))
})

const minute = 60_000

/** Fields as a caller outside the type system might pass them, in any combination. */
interface RawCreateInfo {
  readonly name?: string
  readonly when?: number | undefined
  readonly delayInMinutes?: number | undefined
  readonly periodInMinutes?: number
}

/** Chrome validates at runtime what the AlarmCreateInfo union forbids statically. */
const unchecked = (info: RawCreateInfo): AlarmCreateInfo =>
  // SAFETY: deliberately invalid input, to exercise the fixture's runtime validation like Chrome's.
  info as AlarmCreateInfo

const rejection = <A>(effect: Effect.Effect<A, ChromeAlarmsError>) => Effect.map(Effect.flip(effect), (error) => {
  expect(error.operation).toBe("create")
  expect(error.cause).toBeInstanceOf(Error)

  return error.cause instanceof Error ? error.cause.message : ""
})

describe("makeAlarms", () => {
  it.effect("stores alarms with Chrome's defaults and replaces one of the same name last", () => Effect.gen(function*() {
    const fixture = makeAlarms()
    const alarms = yield* ChromeAlarms.pipe(Effect.provide(fixture.layer))

    yield* alarms.create({ delayInMinutes: 2 })
    yield* alarms.create("when", { when: 5_000, persistAcrossSessions: false })
    yield* alarms.create("period", { periodInMinutes: 3 })
    yield* alarms.create({ name: "in-info", delayInMinutes: 1, periodInMinutes: 4 })
    yield* alarms.create(undefined, { when: 7 })

    expect(yield* alarms.get()).toEqual(Option.some({ name: "", scheduledTime: 7, persistAcrossSessions: true }))
    expect(yield* alarms.getAll).toEqual([
      { name: "when", scheduledTime: 5_000, persistAcrossSessions: false },
      { name: "period", scheduledTime: 3 * minute, periodInMinutes: 3, persistAcrossSessions: true },
      { name: "in-info", scheduledTime: minute, periodInMinutes: 4, persistAcrossSessions: true },
      { name: "", scheduledTime: 7, persistAcrossSessions: true }
    ])
    expect(yield* alarms.get("missing")).toEqual(Option.none())
    expect(yield* alarms.clear("when")).toBe(true)
    expect(yield* alarms.clear("when")).toBe(false)
    expect(yield* alarms.clear()).toBe(true)
    expect(fixture.controls.alarm("period")?.periodInMinutes).toBe(3)
    yield* alarms.clearAll
    expect(yield* alarms.getAll).toEqual([])
  }))

  it.effect("hands out copies of its alarms", () => Effect.gen(function*() {
    const fixture = makeAlarms()
    yield* Effect.promise(() => fixture.api.create("tick", { when: 10 }))
    const copy = yield* Effect.promise(() => fixture.api.get("tick"))

    if (copy !== undefined) copy.scheduledTime = 99

    const listed = (yield* Effect.promise(() => fixture.api.getAll()))[0]

    if (listed !== undefined) listed.name = "renamed"

    expect(fixture.controls.alarm("tick")).toEqual({ name: "tick", scheduledTime: 10, persistAcrossSessions: true })
  }))

  it.effect("rejects invalid schedules and names with Chrome's messages", () => Effect.gen(function*() {
    const alarms = make(makeAlarms().api)

    expect(yield* rejection(alarms.create("a", unchecked({ name: "b", when: 1 }))))
      .toBe("Cannot set alarm name in both separate argument and object form.")
    expect(yield* rejection(alarms.create(unchecked({ when: 1, delayInMinutes: 1 }))))
      .toBe("Cannot set both when and delayInMinutes.")
    expect(yield* rejection(alarms.create(unchecked({}))))
      .toBe("Must set at least one of when, delayInMinutes, or periodInMinutes.")
    expect(yield* rejection(alarms.create("é".repeat(513), { when: 1 })))
      .toBe("Alarm name size is 1026 bytes which exceeds the limit of 1024 bytes.")

    yield* alarms.create("x".repeat(1024), { when: 1 })
    expect((yield* alarms.getAll).map((alarm) => alarm.name.length)).toEqual([1024])
  }))

  it.effect("caps an extension at 500 alarms, even for a replacement", () => Effect.gen(function*() {
    const alarms = make(makeAlarms().api)

    for (let index = 0; index < 500; index++) yield* alarms.create(`alarm-${index}`, { delayInMinutes: 60 })

    expect(yield* rejection(alarms.create("alarm-500", { delayInMinutes: 60 })))
      .toBe("An extension cannot have more than 500 active alarms.")
    expect(yield* rejection(alarms.create("alarm-0", { delayInMinutes: 1 })))
      .toBe("An extension cannot have more than 500 active alarms.")
    expect(yield* alarms.clear("alarm-0")).toBe(true)
    yield* alarms.create("alarm-500", { delayInMinutes: 60 })
    expect((yield* alarms.getAll).length).toBe(500)
  }))

  it.effect("fires due alarms newest first, removing one-shots and keeping repeating ones on their grid", () => Effect.gen(function*() {
    const fixture = makeAlarms()
    const alarms = yield* ChromeAlarms.pipe(Effect.provide(fixture.layer))
    yield* alarms.create("once", { delayInMinutes: 1 })
    yield* alarms.create("repeat", { delayInMinutes: 1, periodInMinutes: 2 })
    yield* alarms.create("later", { delayInMinutes: 30 })

    const fired = yield* Effect.forkScoped(Stream.runCollect(Stream.take(alarms.onAlarm, 4)))
    yield* Effect.promise(() => fixture.controls.onAlarm.waitForListener())

    expect(fixture.controls.advance(30_000)).toEqual([])
    expect(fixture.controls.advance(30_000)).toEqual([])
    expect(fixture.controls.now).toBe(minute)
    expect((yield* alarms.getAll).map((alarm) => [alarm.name, alarm.scheduledTime])).toEqual([
      ["repeat", 3 * minute], ["later", 30 * minute]
    ])

    // Missed periods fire once, then the alarm moves to its next slot after now.
    expect(fixture.controls.advance(6 * minute)).toEqual([])
    expect(fixture.controls.alarm("repeat")?.scheduledTime).toBe(9 * minute)
    expect(fixture.controls.advance(23 * minute)).toEqual([])

    expect((yield* Fiber.join(fired)).map((alarm) => [alarm.name, alarm.scheduledTime])).toEqual([
      ["repeat", minute], ["once", minute], ["repeat", 3 * minute], ["later", 30 * minute]
    ])
    expect(fixture.controls.alarm("repeat")?.scheduledTime).toBe(31 * minute)
    expect(fixture.controls.onAlarm.listenerCount).toBe(0)
  }))

  it.effect("dispatches a poll only after updating every due alarm, so listeners cannot change it", () => Effect.gen(function*() {
    // Chrome updates its alarms for the whole poll in the browser process and only then do
    // the extension's listeners run, so a listener sees the polled state and cannot stop
    // another due alarm of the same poll from firing.
    const fixture = makeAlarms()
    const failure = new Error("listener failed")
    const seen: Array<[name: string, first: boolean, second: boolean]> = []
    yield* Effect.promise(() => fixture.api.create("first", { when: 1 }))
    yield* Effect.promise(() => fixture.api.create("second", { when: 1 }))
    fixture.api.onAlarm.addListener((alarm) => {
      seen.push([alarm.name, fixture.controls.alarm("first") !== undefined, fixture.controls.alarm("second") !== undefined])
      void fixture.api.clear("first")
      void fixture.api.create("late", { when: 0 })
      throw failure
    })

    expect(fixture.controls.advance(1)).toEqual([failure, failure])
    expect(seen).toEqual([["second", false, false], ["first", false, false]])

    // An alarm created during dispatch, even one already due, waits for the next poll.
    expect(fixture.controls.alarm("late")?.scheduledTime).toBe(0)
    expect(fixture.controls.advance(0)).toEqual([failure])
    expect(seen.map(([name]) => name)).toEqual(["second", "first", "late"])
  }))

  it.effect("rejects a negative, NaN or infinite clock step", () => Effect.gen(function*() {
    const fixture = makeAlarms()
    yield* Effect.promise(() => fixture.api.create("repeat", { when: 1, periodInMinutes: 1 }))

    expect(() => fixture.controls.advance(-1)).toThrow("Cannot move the clock by -1 ms")
    expect(() => fixture.controls.advance(Number.NaN)).toThrow("Cannot move the clock by NaN ms")
    expect(() => fixture.controls.advance(Number.POSITIVE_INFINITY)).toThrow("Cannot move the clock by Infinity ms")
    expect(fixture.controls.now).toBe(0)
    expect(fixture.controls.alarm("repeat")?.scheduledTime).toBe(1)
  }))

  it.effect("keeps a zero-period alarm and fires it on every poll, as Chrome does", () => Effect.gen(function*() {
    // Chrome repeats any alarm whose periodInMinutes is present, and a zero period leaves its
    // scheduled time in the past; only an absent period makes a one-shot alarm.
    const fixture = makeAlarms()
    const alarms = make(fixture.api)
    const seen: Array<Alarm> = []
    fixture.api.onAlarm.addListener((alarm) => { seen.push(alarm) })
    yield* alarms.create("zero", { when: 5, periodInMinutes: 0 })
    yield* alarms.create("once", { when: 5 })

    expect(fixture.controls.advance(5)).toEqual([])
    expect(fixture.controls.advance(minute)).toEqual([])
    expect(fixture.controls.advance(0)).toEqual([])
    expect(seen.map((alarm) => alarm.name)).toEqual(["once", "zero", "zero", "zero"])
    expect(yield* alarms.getAll).toEqual([
      { name: "zero", scheduledTime: 5, periodInMinutes: 0, persistAcrossSessions: true }
    ])
  }))

  it.effect("treats re-creating an identical alarm as a no-op that keeps its place", () => Effect.gen(function*() {
    const fixture = makeAlarms()
    const alarms = make(fixture.api)
    const names = Effect.map(alarms.getAll, (all) => all.map((alarm) => alarm.name))

    yield* alarms.create("a", { when: 5 })
    yield* alarms.create("b", { delayInMinutes: 1 })
    yield* alarms.create("c", { when: 5, periodInMinutes: 1, persistAcrossSessions: false })

    // Identical name, scheduled time, period and persistence: Chrome keeps the alarm as it is.
    yield* alarms.create("a", { when: 5 })
    yield* alarms.create({ name: "b", delayInMinutes: 1 })
    expect(yield* names).toEqual(["a", "b", "c"])
    yield* alarms.create("c", { when: 5, periodInMinutes: 1, persistAcrossSessions: false })
    expect(yield* names).toEqual(["a", "b", "c"])

    // Any difference replaces it and moves it last.
    yield* alarms.create("a", { when: 5, persistAcrossSessions: false })
    expect(yield* names).toEqual(["b", "c", "a"])
    yield* alarms.create("b", { delayInMinutes: 1, periodInMinutes: 1 })
    expect(yield* names).toEqual(["c", "a", "b"])
    yield* alarms.create("c", { when: 6, periodInMinutes: 1, persistAcrossSessions: false })
    expect(yield* names).toEqual(["a", "b", "c"])

    // The same delay later on the clock is a different scheduled time.
    expect(fixture.controls.advance(1)).toEqual([])
    yield* alarms.create("a", { when: 5, persistAcrossSessions: false })
    yield* alarms.create("b", { delayInMinutes: 1, periodInMinutes: 1 })
    expect(yield* names).toEqual(["a", "c", "b"])
  }))

  it.effect("drops non-persistent alarms on a simulated browser restart", () => Effect.gen(function*() {
    const alarms = make(makeAlarms().api)
    const fixture = makeAlarms()
    const restarted = make(fixture.api)
    yield* alarms.create("unused", { when: 1 })
    yield* restarted.create("session", { when: 1, persistAcrossSessions: false })
    yield* restarted.create("persistent", { when: 1, persistAcrossSessions: true })
    yield* restarted.create("default", { when: 1 })
    fixture.controls.restart()
    expect((yield* restarted.getAll).map((alarm) => alarm.name)).toEqual(["persistent", "default"])
    expect((yield* alarms.getAll).map((alarm) => alarm.name)).toEqual(["unused"])
  }))

  it.effect("replaces members through overrides and fails registration through controls", () => Effect.gen(function*() {
    const cause = new Error("quota")
    const fixture = makeAlarms({ create: () => Promise.reject(cause), clearAll: async () => undefined })
    const alarms = make(fixture.api)
    const error = yield* Effect.flip(alarms.create({ when: 1 }))
    expect(error.cause).toBe(cause)
    yield* alarms.clearAll

    fixture.controls.onAlarm.failNext("addListener", cause)
    const registration = yield* Effect.flip(Stream.runDrain(alarms.onAlarm))
    expect(registration.operation).toBe("onAlarm")
    expect(registration.cause).toBe(cause)
    expect(fixture.controls.onAlarm.listenerCount).toBe(0)
  }))
})
