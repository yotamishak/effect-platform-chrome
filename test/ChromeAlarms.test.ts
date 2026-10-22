// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeAlarms, ChromeAlarmsError, layer, layerLive, make } from "../src/ChromeAlarms.js"
import type { Alarm, AlarmCreateInfo, ChromeAlarmsApi } from "../src/ChromeAlarms.js"

const alarm: Alarm = { name: "tick", scheduledTime: 123, persistAcrossSessions: true }

const fixture = () => {
  const listeners = new Set<(alarm: Alarm) => void>()

  const api = {
    create: vi.fn<(...args: [AlarmCreateInfo] | [string | undefined, AlarmCreateInfo]) => Promise<void>>(async () => {}),
    get: vi.fn<ChromeAlarmsApi["get"]>(async () => undefined),
    getAll: vi.fn<ChromeAlarmsApi["getAll"]>(async () => [alarm]),
    clear: vi.fn<ChromeAlarmsApi["clear"]>(async () => false),
    clearAll: vi.fn<ChromeAlarmsApi["clearAll"]>(async () => true),
    onAlarm: {
      addListener: vi.fn<ChromeAlarmsApi["onAlarm"]["addListener"]>((listener) => { listeners.add(listener) }),
      removeListener: vi.fn<ChromeAlarmsApi["onAlarm"]["removeListener"]>((listener) => { listeners.delete(listener) })
    }
  } satisfies ChromeAlarmsApi

  return { api, listeners, service: make(api) }
}

describe("ChromeAlarms", () => {
  // Ordinary async cases below explicitly verify the public AbortSignal runner boundary.
  it("interrupts a pending getAll and tolerates late rejection before reexecution", async () => {
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

  it.effect("retains the newest 64 of 4096 events independently across 128 subscriptions", () => Effect.gen(function*() {
    const { api, service, listeners } = fixture()
    api.onAlarm.addListener.mockImplementation((listener) => {
      listeners.add(listener)

      for (let scheduledTime = 0; scheduledTime < 4096; scheduledTime++) listener({ ...alarm, scheduledTime })
    })

    const values = yield* Effect.forEach(Array.from({ length: 128 }), () =>
      Stream.runCollect(Stream.take(service.onAlarm, 64)), { concurrency: "unbounded" })

    for (const result of values) {
      expect(result.map((value) => value.scheduledTime)).toEqual(Array.from({ length: 64 }, (_, id) => id + 4032))
    }

    expect(listeners.size).toBe(0)
    expect(api.onAlarm.addListener).toHaveBeenCalledTimes(128)
    expect(api.onAlarm.removeListener).toHaveBeenCalledTimes(128)
    expect(new Set(api.onAlarm.removeListener.mock.calls.map(([listener]) => listener))).toEqual(
      new Set(api.onAlarm.addListener.mock.calls.map(([listener]) => listener))
    )
  }))

  it.effect("cleans 256 interrupted subscriptions despite events racing removal", () => Effect.gen(function*() {
    const { api, service, listeners } = fixture()
    api.onAlarm.removeListener.mockImplementation((listener) => {
      listener(alarm)
      listeners.delete(listener)
      listener(alarm)
    })

    for (let index = 0; index < 256; index++) {
      let notify!: () => void
      const ready = new Promise<void>((resolve) => { notify = resolve })

      api.onAlarm.addListener.mockImplementation((listener) => {
        listeners.add(listener)
        notify()
      })
      const fiber = yield* Effect.forkScoped(Stream.runDrain(service.onAlarm))

      yield* Effect.promise(() => ready)
      expect(listeners.size).toBe(1)

      for (let id = 0; id < 128; id++) {
        for (const listener of listeners) listener({ ...alarm, scheduledTime: id })
      }

      yield* Fiber.interrupt(fiber)
      expect(listeners.size).toBe(0)
    }

    expect(api.onAlarm.removeListener.mock.calls).toEqual(api.onAlarm.addListener.mock.calls)
    expect(api.onAlarm.removeListener).toHaveBeenCalledTimes(256)
  }))

  it.effect("cleans partial registration failures and can reuse the same stream", () => Effect.gen(function*() {
    const { api, service, listeners } = fixture()
    const cause = new Error("permission denied after registration")
    api.onAlarm.addListener.mockImplementationOnce((listener) => {
      listeners.add(listener)
      listener(alarm)
      throw cause
    })
    const error = yield* Effect.flip(Stream.runDrain(service.onAlarm))
    expect(error.cause).toBe(cause)
    expect(listeners.size).toBe(0)
    api.onAlarm.addListener.mockImplementationOnce((listener) => {
      listeners.add(listener)
      listener(alarm)
    })
    expect(yield* Stream.runCollect(Stream.take(service.onAlarm, 1))).toEqual([alarm])
    expect(listeners.size).toBe(0)
    expect(api.onAlarm.removeListener.mock.calls).toEqual(api.onAlarm.addListener.mock.calls)
  }))

  it.effect("reexecutes stored effects 256 times preserving empty names, zero and missing alarms", () => Effect.gen(function*() {
    const { api, service } = fixture()
    const info = { when: 0, periodInMinutes: 0 }

    const effects = [service.create("", info), service.create(undefined, info), service.create(info),
      Effect.asVoid(service.get("")), Effect.asVoid(service.getAll),
      Effect.asVoid(service.clear("")), Effect.asVoid(service.clearAll)]

    expect(api.create).not.toHaveBeenCalled()

    for (let index = 0; index < 256; index++) {
      for (const effect of effects) yield* effect
    }

    expect(api.create).toHaveBeenCalledTimes(768)
    expect(api.create).toHaveBeenNthCalledWith(1, "", info)
    expect(api.create).toHaveBeenNthCalledWith(2, undefined, info)
    expect(api.create).toHaveBeenNthCalledWith(3, info)

    for (const method of [api.get, api.getAll, api.clear, api.clearAll]) expect(method).toHaveBeenCalledTimes(256)

    expect(api.get).toHaveBeenLastCalledWith("")
    expect(api.clear).toHaveBeenLastCalledWith("")
    expect(yield* service.get(undefined)).toEqual(Option.none())
    expect(yield* service.clear(undefined)).toBe(false)
    expect(api.get).toHaveBeenLastCalledWith()
    expect(api.clear).toHaveBeenLastCalledWith()
  }))

  it.effect("is lazy and preserves named/unnamed create overloads", () => Effect.gen(function*() {
    const { api, service } = fixture()
    const info = { delayInMinutes: 0.5 }
    const pending = service.create("tick", info)
    expect(api.create).not.toHaveBeenCalled()
    yield* pending
    yield* service.create(info)
    yield* service.create(undefined, info)
    expect(vi.mocked(api.create).mock.calls).toEqual([["tick", info], [info], [undefined, info]])
  }))

  it.effect("preserves missing alarms, alarm objects, arrays, and clear booleans", () => Effect.gen(function*() {
    const { api, service } = fixture()
    expect(api.getAll).not.toHaveBeenCalled()
    expect(api.clearAll).not.toHaveBeenCalled()
    expect(yield* service.get()).toEqual(Option.none())
    expect(api.get).toHaveBeenCalledWith()
    vi.mocked(api.get).mockResolvedValue(alarm)
    expect(yield* service.get("tick")).toEqual(Option.some(alarm))
    expect(yield* service.getAll).toEqual([alarm])
    expect(yield* service.clear("missing")).toBe(false)
    expect(api.clear).toHaveBeenCalledWith("missing")
    expect(yield* service.clearAll).toBe(true)
    expect(yield* service.getAll).toEqual([alarm])
    expect(yield* service.clearAll).toBe(true)
    expect(api.getAll).toHaveBeenCalledTimes(2)
    expect(api.clearAll).toHaveBeenCalledTimes(2)
  }))

  it.effect.each(["create", "get", "getAll", "clear", "clearAll"] as const)(
    "maps both thrown and rejected %s failures to tagged errors",
    (name) => Effect.gen(function*() {
      for (const synchronous of [true, false]) {
        const { api, service } = fixture()
        const cause = new Error("Chrome failed")
        vi.mocked(api[name]).mockImplementation((): Promise<never> => {
          if (synchronous) throw cause

          return Promise.reject(cause)
        })

        const effect = name === "create" ? service.create({ when: 42 })
          : name === "getAll" || name === "clearAll" ? service[name] : service[name]()

        const result = yield* Effect.flip(effect)
        expect(result).toBeInstanceOf(ChromeAlarmsError)
        expect(result.operation).toBe(name)
        expect(result.cause).toBe(cause)
      }
    })
  )

  it.effect("emits events and removes the identical listener on completion", () => Effect.gen(function*() {
    const { api, service, listeners } = fixture()
    let registered!: () => void
    const ready = new Promise<void>((resolve) => { registered = resolve })
    api.onAlarm.addListener.mockImplementationOnce((listener) => {
      listeners.add(listener)
      registered()
    })
    const result = yield* Effect.forkScoped(Stream.runCollect(Stream.take(service.onAlarm, 1)))
    yield* Effect.promise(() => ready)
    expect(listeners.size).toBe(1)

    for (const listener of listeners) listener(alarm)
    expect(yield* Fiber.join(result)).toEqual([alarm])
    expect(listeners.size).toBe(0)
    expect(api.onAlarm.removeListener).toHaveBeenCalledWith(
      vi.mocked(api.onAlarm.addListener).mock.calls[0]![0]
    )
  }))

  it("removes listeners on interruption", async () => {
    const { service, listeners } = fixture()
    const controller = new AbortController()
    const result = Effect.runPromiseExit(Stream.runDrain(service.onAlarm), { signal: controller.signal })
    await vi.waitFor(() => expect(listeners.size).toBe(1))
    controller.abort()
    expect((await result)._tag).toBe("Failure")
    expect(listeners.size).toBe(0)
  })

  it.effect("uses a bounded sliding buffer retaining the newest 64 events", () => Effect.gen(function*() {
    const { api, service, listeners } = fixture()
    vi.mocked(api.onAlarm.addListener).mockImplementation((listener) => {
      listeners.add(listener)

      for (let i = 0; i < 100; i++) listener({ ...alarm, scheduledTime: i })
    })
    const result = yield* Stream.runCollect(Stream.take(service.onAlarm, 64))
    expect(result.map((value) => value.scheduledTime)).toEqual(Array.from({ length: 64 }, (_, i) => i + 36))
    expect(listeners.size).toBe(0)
  }))

  it.effect("tags listener registration failures", () => Effect.gen(function*() {
    const { api, service } = fixture()
    const cause = new Error("registration failed")
    vi.mocked(api.onAlarm.addListener).mockImplementation(() => { throw cause })
    const error = yield* Effect.flip(Stream.runDrain(service.onAlarm))
    expect(error.operation).toBe("onAlarm")
    expect(error.cause).toBe(cause)
    expect(api.onAlarm.removeListener).toHaveBeenCalledExactlyOnceWith(api.onAlarm.addListener.mock.calls[0]?.[0])
  }))

  it.effect("imports without chrome and reports unavailable globals only when building the layer", () => Effect.gen(function*() {
    vi.stubGlobal("chrome", undefined)
    const module = yield* Effect.promise(() => import("../src/ChromeAlarms.js"))
    expect(module.layerLive).toBe(layerLive)

    const error = yield* Effect.flip(
      Effect.provide(Effect.asVoid(ChromeAlarms), layerLive)
    )

    expect(error.operation).toBe("initialize")
  }))

  it.effect("resolves the live API lazily at layer construction", () => Effect.gen(function*() {
    const { api } = fixture()
    vi.stubGlobal("chrome", { alarms: api })

    const result = yield* Effect.provide(
      Effect.flatMap(ChromeAlarms, (service) => service.getAll), layerLive
    )

    expect(result).toEqual([alarm])
  }))

  it.effect("provides an injected API through layer without a global", () => Effect.gen(function*() {
    const { api } = fixture()
    vi.stubGlobal("chrome", undefined)

    const result = yield* Effect.provide(
      Effect.flatMap(ChromeAlarms, (service) => service.getAll), layer(api)
    )

    expect(result).toEqual([alarm])
  }))

  it.effect("times out a waiting alarm consumer and releases its listener at the deadline", () => Effect.gen(function*() {
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
})
