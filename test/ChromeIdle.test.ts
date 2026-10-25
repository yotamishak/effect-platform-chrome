// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Deferred, Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeIdle, ChromeIdleError, layer, layerLive, make } from "../src/ChromeIdle.js"
import type { ChromeIdleApi, IdleState } from "../src/ChromeIdle.js"
import type { EventSource } from "../src/internal/event.js"
import * as TestEvent from "../src/testing/Event.js"
import { makeIdle, maximumInterval, minimumInterval } from "../src/testing/Idle.js"

const mockApi = () => {
  const onStateChanged = TestEvent.makeEvent<[IdleState]>()

  const api = {
    queryState: vi.fn((_detectionIntervalInSeconds: number): Promise<IdleState> => Promise.resolve("idle")),
    setDetectionInterval: vi.fn((_intervalInSeconds: number): void => {}),
    getAutoLockDelay: vi.fn((): Promise<number> => Promise.resolve(300)),
    onStateChanged: onStateChanged.api
  } satisfies ChromeIdleApi

  return { api, onStateChanged: onStateChanged.controls }
}

/** Wraps an event so a test can wait, without sleeping, until `count` listeners were added. */
const gated = <Args extends ReadonlyArray<unknown>>(source: EventSource<Args>) => {
  const waiters: Array<{ readonly count: number; readonly gate: Deferred.Deferred<void> }> = []
  let added = 0

  return {
    source: {
      addListener: (listener: (...args: Args) => void) => {
        source.addListener(listener)
        added++

        for (const waiter of waiters) if (added >= waiter.count) Deferred.doneUnsafe(waiter.gate, Effect.void)
      },
      removeListener: (listener: (...args: Args) => void) => source.removeListener(listener)
    } satisfies EventSource<Args>,
    added: (count: number): Effect.Effect<void> => Effect.suspend(() => {
      if (added >= count) return Effect.void

      const gate = Deferred.makeUnsafe<void>()
      waiters.push({ count, gate })

      return Deferred.await(gate)
    })
  }
}

/** A `chrome.idle` stand-in whose methods need `this`, as a live namespace object may. */
class ReceiverIdle {
  readonly calls: Array<string> = []
  readonly event = TestEvent.makeEvent<[IdleState]>()
  readonly onStateChanged = this.event.api

  queryState(detectionIntervalInSeconds: number): Promise<IdleState> {
    this.calls.push(`queryState(${detectionIntervalInSeconds})`)

    return Promise.resolve("locked")
  }

  setDetectionInterval(intervalInSeconds: number): void {
    this.calls.push(`setDetectionInterval(${intervalInSeconds})`)
  }

  getAutoLockDelay(): Promise<number> {
    this.calls.push("getAutoLockDelay()")

    return Promise.resolve(600)
  }
}

describe("ChromeIdle calls", () => {
  it.effect("passes each argument through unchanged and returns Chrome's result", () => Effect.gen(function*() {
    const { api } = mockApi()
    const idle = make(api)

    for (const state of ["active", "idle", "locked"] as const) {
      api.queryState.mockResolvedValueOnce(state)
      expect(yield* idle.queryState(60)).toBe(state)
    }

    expect(yield* idle.setDetectionInterval(30)).toBeUndefined()
    expect(yield* idle.getAutoLockDelay).toBe(300)
    api.getAutoLockDelay.mockResolvedValueOnce(0)
    expect(yield* idle.getAutoLockDelay).toBe(0)
    expect(api.queryState.mock.calls).toEqual([[60], [60], [60]])
    expect(api.setDetectionInterval).toHaveBeenCalledExactlyOnceWith(30)
    expect(api.getAutoLockDelay.mock.calls).toEqual([[], []])
  }))

  it.effect("passes out-of-range values to Chrome rather than validating them", () => Effect.gen(function*() {
    const { api } = mockApi()
    const idle = make(api)
    yield* idle.queryState(0)
    yield* idle.queryState(1e9)
    yield* idle.setDetectionInterval(-1)
    yield* idle.setDetectionInterval(15.5)
    expect(api.queryState.mock.calls).toEqual([[0], [1e9]])
    expect(api.setDetectionInterval.mock.calls).toEqual([[-1], [15.5]])
  }))

  it.effect("is lazy: nothing reaches Chrome until an Effect runs, and each run calls again", () => Effect.gen(function*() {
    const { api } = mockApi()
    const idle = make(api)
    const query = idle.queryState(15)
    const set = idle.setDetectionInterval(15)
    const delay = idle.getAutoLockDelay
    expect(api.queryState).not.toHaveBeenCalled()
    expect(api.setDetectionInterval).not.toHaveBeenCalled()
    expect(api.getAutoLockDelay).not.toHaveBeenCalled()
    yield* Effect.all([query, query, set, set, delay, delay])
    expect(api.queryState).toHaveBeenCalledTimes(2)
    expect(api.setDetectionInterval).toHaveBeenCalledTimes(2)
    expect(api.getAutoLockDelay).toHaveBeenCalledTimes(2)
  }))

  it.effect("maps a rejection of each Promise call to the typed error with its operation", () => Effect.gen(function*() {
    const { api } = mockApi()
    const idle = make(api)
    const queryCause = new Error("query rejected")
    const delayCause = new Error("delay rejected")
    api.queryState.mockRejectedValueOnce(queryCause)
    api.getAutoLockDelay.mockRejectedValueOnce(delayCause)
    const query = yield* Effect.flip(idle.queryState(60))
    expect(query).toBeInstanceOf(ChromeIdleError)
    expect(query._tag).toBe("ChromeIdleError")
    expect(query.operation).toBe("queryState")
    expect(query.cause).toBe(queryCause)
    const delay = yield* Effect.flip(idle.getAutoLockDelay)
    expect(delay).toBeInstanceOf(ChromeIdleError)
    expect(delay.operation).toBe("getAutoLockDelay")
    expect(delay.cause).toBe(delayCause)
  }))

  it.effect("maps a synchronous throw of every call to the typed error with its operation", () => Effect.gen(function*() {
    const { api } = mockApi()
    const idle = make(api)
    // Chrome's bindings throw synchronously for an invalid argument, before any Promise exists.
    const invalid = new TypeError("Error at parameter 'detectionIntervalInSeconds': Value must be at least 15.")
    const setInvalid = new TypeError("Error at parameter 'intervalInSeconds': Value must be at least 15.")
    const absent = new TypeError("chrome.idle.getAutoLockDelay is not a function")
    api.queryState.mockImplementationOnce(() => { throw invalid })
    api.setDetectionInterval.mockImplementationOnce(() => { throw setInvalid })
    api.getAutoLockDelay.mockImplementationOnce(() => { throw absent })
    const query = yield* Effect.flip(idle.queryState(1))
    expect(query).toBeInstanceOf(ChromeIdleError)
    expect(query).toMatchObject({ operation: "queryState" })
    expect(query.cause).toBe(invalid)
    const set = yield* Effect.flip(idle.setDetectionInterval(1))
    expect(set).toBeInstanceOf(ChromeIdleError)
    expect(set).toMatchObject({ operation: "setDetectionInterval" })
    expect(set.cause).toBe(setInvalid)
    const delay = yield* Effect.flip(idle.getAutoLockDelay)
    expect(delay).toBeInstanceOf(ChromeIdleError)
    expect(delay).toMatchObject({ operation: "getAutoLockDelay" })
    expect(delay.cause).toBe(absent)
  }))

  it.effect("keeps non-Error causes unchanged, including undefined", () => Effect.gen(function*() {
    const { api } = mockApi()
    const idle = make(api)
    api.queryState.mockImplementationOnce(() => Promise.reject(undefined))
    api.getAutoLockDelay.mockImplementationOnce(() => Promise.reject("closed"))
    api.setDetectionInterval.mockImplementationOnce(() => { throw 42 })
    expect((yield* Effect.flip(idle.queryState(60))).cause).toBeUndefined()
    expect((yield* Effect.flip(idle.getAutoLockDelay)).cause).toBe("closed")
    expect((yield* Effect.flip(idle.setDetectionInterval(60))).cause).toBe(42)
  }))

  it.effect("recovers after a failure: the next call reaches Chrome again", () => Effect.gen(function*() {
    const { api } = mockApi()
    const idle = make(api)
    api.queryState.mockRejectedValueOnce(new Error("once"))
    expect(yield* Effect.exit(idle.queryState(60))).toSatisfy(Exit.isFailure)
    expect(yield* idle.queryState(60)).toBe("idle")
  }))

  it.effect("fails getAutoLockDelay with the typed error when the API lacks it", () => Effect.gen(function*() {
    const { api } = mockApi()

    const older: ChromeIdleApi = {
      queryState: api.queryState,
      setDetectionInterval: api.setDetectionInterval,
      onStateChanged: api.onStateChanged
    }

    const idle = make(older)
    const error = yield* Effect.flip(idle.getAutoLockDelay)
    expect(error).toBeInstanceOf(ChromeIdleError)
    expect(error.operation).toBe("getAutoLockDelay")
    expect(String(error.cause)).toContain("idle.getAutoLockDelay is unavailable")
    // The rest of the API is unaffected, and the absence is checked on each run.
    expect(yield* idle.queryState(60)).toBe("idle")
    expect((yield* Effect.flip(idle.getAutoLockDelay)).operation).toBe("getAutoLockDelay")
  }))

  it.effect("checks for getAutoLockDelay when it runs, not when the service is made", () => Effect.gen(function*() {
    const { api } = mockApi()

    const older = {
      queryState: api.queryState,
      setDetectionInterval: api.setDetectionInterval,
      onStateChanged: api.onStateChanged
    } satisfies ChromeIdleApi

    const idle = make(older)
    expect((yield* Effect.flip(idle.getAutoLockDelay)).operation).toBe("getAutoLockDelay")
    // The same object gains the function later, as after a browser update.
    Object.assign(older, { getAutoLockDelay: () => Promise.resolve(45) })
    expect(yield* idle.getAutoLockDelay).toBe(45)
  }))

  it.effect("reads no API member when made, and only the member a call needs when it runs", () => Effect.gen(function*() {
    const { api: base, onStateChanged: events } = mockApi()
    const reads: Array<string> = []

    const api: ChromeIdleApi = {
      get queryState() { reads.push("queryState");

 return base.queryState },
      get setDetectionInterval() { reads.push("setDetectionInterval");

 return base.setDetectionInterval },
      get getAutoLockDelay() { reads.push("getAutoLockDelay");

 return base.getAutoLockDelay },
      get onStateChanged() { reads.push("onStateChanged");

 return base.onStateChanged }
    }

    const idle = make(api)
    expect(reads).toEqual([])
    yield* idle.queryState(60)
    expect(reads).toEqual(["queryState"])
    yield* idle.setDetectionInterval(60)
    expect(reads).toEqual(["queryState", "setDetectionInterval"])
    reads.length = 0
    yield* idle.getAutoLockDelay
    expect(new Set(reads)).toEqual(new Set(["getAutoLockDelay"]))
    reads.length = 0
    const head = yield* Effect.forkChild(Stream.runHead(idle.onStateChanged))
    yield* Effect.promise(() => events.waitForListener())
    events.emit("idle")
    yield* Fiber.join(head)
    expect(reads).toEqual(["onStateChanged"])
  }))

  it.effect("types a throwing member lookup as the operation's error, not a defect", () => Effect.gen(function*() {
    const cause = new Error("member lookup failed")

    const api: ChromeIdleApi = {
      get queryState(): ChromeIdleApi["queryState"] { throw cause },
      get setDetectionInterval(): ChromeIdleApi["setDetectionInterval"] { throw cause },
      get getAutoLockDelay(): () => Promise<number> { throw cause },
      get onStateChanged(): ChromeIdleApi["onStateChanged"] { throw cause }
    }

    const idle = make(api)
    expect(yield* Effect.flip(idle.queryState(60))).toMatchObject({ operation: "queryState", cause })
    expect(yield* Effect.flip(idle.setDetectionInterval(60))).toMatchObject({ operation: "setDetectionInterval", cause })
    expect(yield* Effect.flip(idle.getAutoLockDelay)).toMatchObject({ operation: "getAutoLockDelay", cause })
    expect(yield* Effect.flip(Stream.runDrain(idle.onStateChanged))).toMatchObject({ operation: "onStateChanged", cause })
  }))

  it.effect("is catchable by tag", () => Effect.gen(function*() {
    const { api } = mockApi()
    api.queryState.mockRejectedValueOnce(new Error("no"))

    const recovered = yield* make(api).queryState(60).pipe(
      Effect.catchTag("ChromeIdleError", (error) => Effect.succeed(`recovered ${error.operation}`))
    )

    expect(recovered).toBe("recovered queryState")
  }))
})

describe("ChromeIdle.onStateChanged", () => {
  it.effect("delivers every state in order and removes the listener when the stream ends", () => Effect.gen(function*() {
    const mock = mockApi()
    const changes = yield* Effect.forkScoped(Stream.runCollect(Stream.take(make(mock.api).onStateChanged, 4)))
    yield* Effect.promise(() => mock.onStateChanged.waitForListener())
    expect(mock.onStateChanged.listenerCount).toBe(1)
    mock.onStateChanged.emit("idle")
    mock.onStateChanged.emit("locked")
    mock.onStateChanged.emit("active")
    mock.onStateChanged.emit("locked")
    expect(yield* Fiber.join(changes)).toEqual(["idle", "locked", "active", "locked"])
    expect(mock.onStateChanged.listenerCount).toBe(0)
    // Events after the end reach nobody.
    expect(mock.onStateChanged.emit("idle")).toEqual([])
  }))

  it.effect("registers nothing until consumed and misses events from before the subscription", () => Effect.gen(function*() {
    const mock = mockApi()
    const stream = make(mock.api).onStateChanged
    expect(mock.onStateChanged.listenerCount).toBe(0)
    mock.onStateChanged.emit("locked")
    const first = yield* Effect.forkScoped(Stream.runHead(stream))
    yield* Effect.promise(() => mock.onStateChanged.waitForListener())
    mock.onStateChanged.emit("active")
    expect(yield* Fiber.join(first)).toEqual(Option.some("active"))
    expect(mock.onStateChanged.listenerCount).toBe(0)
  }))

  it.effect("removes the listener when the consumer is interrupted, idle or mid-buffer", () => Effect.gen(function*() {
    const mock = mockApi()
    const events = gated(mock.api.onStateChanged)
    const stream = make({ ...mock.api, onStateChanged: events.source }).onStateChanged

    const waiting = yield* Effect.forkChild(Stream.runDrain(stream))
    yield* events.added(1)
    yield* Fiber.interrupt(waiting)
    expect(mock.onStateChanged.listenerCount).toBe(0)

    const blocked = Deferred.makeUnsafe<void>()
    const seen = Deferred.makeUnsafe<IdleState>()

    const stuck = yield* Effect.forkChild(Stream.runDrain(Stream.tap(stream, (state) =>
      Effect.andThen(Deferred.succeed(seen, state), Deferred.await(blocked)))))

    yield* events.added(2)
    mock.onStateChanged.emit("idle")
    mock.onStateChanged.emit("locked")
    expect(yield* Deferred.await(seen)).toBe("idle")
    const exit = yield* Fiber.interrupt(stuck).pipe(Effect.andThen(Fiber.await(stuck)))
    expect(Exit.hasInterrupts(exit)).toBe(true)
    expect(mock.onStateChanged.listenerCount).toBe(0)
  }))

  it.effect("removes the listener when the consumer fails downstream", () => Effect.gen(function*() {
    const mock = mockApi()
    const failure = new ChromeIdleError({ operation: "downstream", cause: "consumer" })
    const run = yield* Effect.forkChild(Effect.flip(Stream.runDrain(Stream.mapEffect(make(mock.api).onStateChanged, () => Effect.fail(failure)))))
    yield* Effect.promise(() => mock.onStateChanged.waitForListener())
    mock.onStateChanged.emit("idle")
    expect(yield* Fiber.join(run)).toBe(failure)
    expect(mock.onStateChanged.listenerCount).toBe(0)
  }))

  it.effect("gives every consumption its own listener, and the stream can run again", () => Effect.gen(function*() {
    const mock = mockApi()
    const events = gated(mock.api.onStateChanged)
    const stream = make({ ...mock.api, onStateChanged: events.source }).onStateChanged
    const left = yield* Effect.forkChild(Stream.runCollect(Stream.take(stream, 2)))
    const right = yield* Effect.forkChild(Stream.runCollect(Stream.take(stream, 2)))
    yield* events.added(2)
    expect(mock.onStateChanged.listenerCount).toBe(2)
    mock.onStateChanged.emit("locked")
    mock.onStateChanged.emit("active")
    expect(yield* Fiber.join(left)).toEqual(["locked", "active"])
    expect(yield* Fiber.join(right)).toEqual(["locked", "active"])
    expect(mock.onStateChanged.listenerCount).toBe(0)

    const again = yield* Effect.forkChild(Stream.runCollect(Stream.take(stream, 1)))
    yield* events.added(3)
    mock.onStateChanged.emit("idle")
    expect(yield* Fiber.join(again)).toEqual(["idle"])
    expect(mock.onStateChanged.listenerCount).toBe(0)
  }))

  it.effect("keeps only the newest 64 pending events, in order", () => Effect.gen(function*() {
    const mock = mockApi()
    const states: ReadonlyArray<IdleState> = ["active", "idle", "locked"]
    const received: Array<IdleState> = []
    const filled = Deferred.makeUnsafe<void>()

    const run = yield* Effect.forkChild(Stream.runDrain(Stream.take(Stream.tap(make(mock.api).onStateChanged, (state) => Effect.sync(() => {
      received.push(state)

      if (received.length === 64) Deferred.doneUnsafe(filled, Effect.void)
    })), 65)))

    yield* Effect.promise(() => mock.onStateChanged.waitForListener())
    // A seeded linear congruential sequence, so a shifted window cannot match by period.
    let seed = 7

    const sent = Array.from({ length: 200 }, () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31

      return states[seed % 3] ?? "active"
    })

    for (const state of sent) mock.onStateChanged.emit(state)

    yield* Deferred.await(filled)
    mock.onStateChanged.emit("locked")
    yield* Fiber.join(run)
    expect(received).toEqual([...sent.slice(-64), "locked"])
    expect(mock.onStateChanged.listenerCount).toBe(0)
  }))

  it.effect("types a failed listener registration and leaves no listener behind", () => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("registration failed")
    mock.onStateChanged.failNext("addListener", cause)
    const error = yield* Effect.flip(Stream.runDrain(make(mock.api).onStateChanged))
    expect(error).toBeInstanceOf(ChromeIdleError)
    expect(error).toMatchObject({ operation: "onStateChanged" })
    expect(error.cause).toBe(cause)
    expect(mock.onStateChanged.listenerCount).toBe(0)
  }))

  it.effect("removes a listener that Chrome added before its registration threw", () => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("added, then threw")

    const partial: EventSource<[IdleState]> = {
      addListener: (listener) => {
        mock.api.onStateChanged.addListener(listener)
        throw cause
      },
      removeListener: (listener) => mock.api.onStateChanged.removeListener(listener)
    }

    const error = yield* Effect.flip(Stream.runDrain(make({ ...mock.api, onStateChanged: partial }).onStateChanged))
    expect(error).toMatchObject({ operation: "onStateChanged", cause })
    expect(mock.onStateChanged.listenerCount).toBe(0)
  }))

  it.effect("reads the event when each consumption starts, not when the service is made", () => Effect.gen(function*() {
    const mock = mockApi()
    let lookups = 0

    const api: ChromeIdleApi = {
      ...mock.api,
      get onStateChanged() { lookups++;

 return mock.api.onStateChanged }
    }

    const stream = make(api).onStateChanged
    expect(lookups).toBe(0)
    const first = yield* Effect.forkChild(Stream.runHead(stream))
    yield* Effect.promise(() => mock.onStateChanged.waitForListener())
    mock.onStateChanged.emit("idle")
    yield* Fiber.join(first)
    expect(lookups).toBe(1)
  }))
})

describe("ChromeIdle layers", () => {
  it.effect("provides an injected API through layer", () => Effect.gen(function*() {
    const { api } = mockApi()

    const program = Effect.gen(function*() {
      const idle = yield* ChromeIdle

      return [yield* idle.queryState(15), yield* idle.getAutoLockDelay] as const
    })

    expect(yield* program.pipe(Effect.provide(layer(api)))).toEqual(["idle", 300])
  }))

  it.effect("fails layerLive with \"initialize\" without a chrome global or without chrome.idle", () => Effect.gen(function*() {
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", undefined)), () => Effect.sync(() => vi.unstubAllGlobals()))
    const missing = yield* Effect.flip(ChromeIdle.pipe(Effect.provide(layerLive)))
    expect(missing).toBeInstanceOf(ChromeIdleError)
    expect(missing.operation).toBe("initialize")
    expect(String(missing.cause)).toContain("chrome.idle is unavailable")

    // Without the "idle" permission Chrome leaves the namespace undefined.
    vi.stubGlobal("chrome", {})
    const noPermission = yield* Effect.flip(ChromeIdle.pipe(Effect.provide(layerLive)))
    expect(noPermission).toMatchObject({ operation: "initialize" })
    expect(String(noPermission.cause)).toContain("chrome.idle is unavailable")

    const cause = new Error("namespace getter threw")
    vi.stubGlobal("chrome", { get idle() { throw cause } })
    expect(yield* Effect.flip(ChromeIdle.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize", cause })
  }))

  it.effect("builds layerLive from a fake global, calling Chrome's methods on chrome.idle", () => Effect.gen(function*() {
    const live = new ReceiverIdle()
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", { idle: live })), () => Effect.sync(() => vi.unstubAllGlobals()))

    const program = Effect.gen(function*() {
      const idle = yield* ChromeIdle
      expect(live.calls).toEqual([])
      const state = yield* idle.queryState(30)
      yield* idle.setDetectionInterval(45)
      const delay = yield* idle.getAutoLockDelay
      const changes = yield* Effect.forkChild(Stream.runCollect(Stream.take(idle.onStateChanged, 1)))
      yield* Effect.promise(() => live.event.controls.waitForListener())
      live.event.controls.emit("active")

      return { state, delay, changes: yield* Fiber.join(changes) }
    })

    expect(yield* program.pipe(Effect.provide(layerLive))).toEqual({ state: "locked", delay: 600, changes: ["active"] })
    expect(live.calls).toEqual(["queryState(30)", "setDetectionInterval(45)", "getAutoLockDelay()"])
    expect(live.event.controls.listenerCount).toBe(0)
  }))

  it.effect("reads the global on every build, never at import", () => Effect.gen(function*() {
    const first = makeIdle({ idleTime: 100 })
    const second = makeIdle({ locked: true })
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", { idle: first.api })), () => Effect.sync(() => vi.unstubAllGlobals()))
    const query = Effect.flatMap(ChromeIdle, (idle) => idle.queryState(60))
    expect(yield* query.pipe(Effect.provide(layerLive))).toBe("idle")
    vi.stubGlobal("chrome", { idle: second.api })
    expect(yield* query.pipe(Effect.provide(layerLive))).toBe("locked")
    // A layer that was already built keeps the API it read.
    const built = yield* Layer.build(layerLive)
    vi.stubGlobal("chrome", { idle: first.api })
    expect(yield* query.pipe(Effect.provideContext(built))).toBe("locked")
  }))
})

describe("testing/Idle fixture", () => {
  it.effect("starts active with Chrome's defaults and fits make and layer", () => Effect.gen(function*() {
    const fixture = makeIdle()
    expect(fixture.controls.state).toBe("active")
    expect(fixture.controls.detectionInterval).toBe(60)
    expect(fixture.controls.idleTime).toBe(0)
    expect(fixture.controls.locked).toBe(false)
    expect(fixture.controls.autoLockDelay).toBe(0)
    const idle = make(fixture.api)
    expect(yield* idle.queryState(15)).toBe("active")
    expect(yield* idle.getAutoLockDelay).toBe(0)
    const viaLayer = yield* Effect.flatMap(ChromeIdle, (service) => service.queryState(15)).pipe(Effect.provide(fixture.layer))
    expect(viaLayer).toBe("active")
  }))

  it.effect("answers queryState from idle time and lock, at the threshold inclusive", () => Effect.gen(function*() {
    const fixture = makeIdle({ idleTime: 100 })
    const idle = make(fixture.api)
    expect(yield* idle.queryState(100)).toBe("idle")
    expect(yield* idle.queryState(101)).toBe("active")
    expect(yield* idle.queryState(minimumInterval)).toBe("idle")
    fixture.controls.lock()
    expect(yield* idle.queryState(minimumInterval)).toBe("locked")
    expect(yield* idle.queryState(maximumInterval)).toBe("locked")
  }))

  it.effect("caps both intervals at four hours, as Chrome does", () => Effect.gen(function*() {
    const fixture = makeIdle({ idleTime: maximumInterval - 1 })
    const idle = make(fixture.api)
    expect(yield* idle.queryState(2 ** 31 - 1)).toBe("active")
    fixture.controls.elapse(1)
    expect(yield* idle.queryState(2 ** 31 - 1)).toBe("idle")
    // A listener makes Chrome sample at the detection interval.
    fixture.api.onStateChanged.addListener(() => {})
    yield* idle.setDetectionInterval(1e6)
    expect(fixture.controls.detectionInterval).toBe(maximumInterval)
    expect(fixture.controls.state).toBe("idle")
  }))

  it.effect("throws synchronously, like Chrome's bindings, for intervals that are not integers of at least 15", () => Effect.gen(function*() {
    const fixture = makeIdle()
    const idle = make(fixture.api)

    for (const value of [14, 0, -15, -0, 15.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 31]) {
      expect(() => fixture.api.queryState(value)).toThrow(TypeError)
      expect(() => fixture.api.setDetectionInterval(value)).toThrow(TypeError)
      const query = yield* Effect.flip(idle.queryState(value))
      expect(query.operation).toBe("queryState")
      expect(query.cause).toBeInstanceOf(TypeError)
      const set = yield* Effect.flip(idle.setDetectionInterval(value))
      expect(set.operation).toBe("setDetectionInterval")
      expect(set.cause).toBeInstanceOf(TypeError)
    }

    expect(() => fixture.api.queryState(14)).toThrow("Value must be at least 15.")
    expect(() => fixture.api.queryState(15.5)).toThrow("Invalid type: expected integer, found number.")
    expect(() => fixture.api.setDetectionInterval(14)).toThrow("Error at parameter 'intervalInSeconds'")
    expect(fixture.controls.detectionInterval).toBe(60)
    expect(yield* idle.queryState(minimumInterval)).toBe("active")
  }))

  it.effect("fires onStateChanged only on a change at the detection interval", () => Effect.gen(function*() {
    const fixture = makeIdle()
    const idle = make(fixture.api)
    const changes = yield* Effect.forkChild(Stream.runCollect(Stream.take(idle.onStateChanged, 6)))
    yield* Effect.promise(() => fixture.controls.onStateChanged.waitForListener())
    fixture.controls.elapse(59)
    fixture.controls.elapse(1)
    fixture.controls.elapse(1000)
    fixture.controls.input()
    fixture.controls.input()
    fixture.controls.lock()
    fixture.controls.input()
    fixture.controls.elapse(1000)
    fixture.controls.unlock()
    fixture.controls.elapse(60)
    fixture.controls.lock()
    expect(yield* Fiber.join(changes)).toEqual(["idle", "active", "locked", "active", "idle", "locked"])
    expect(fixture.controls.state).toBe("locked")
  }))

  it.effect("re-evaluates the state when the detection interval changes", () => Effect.gen(function*() {
    const fixture = makeIdle({ idleTime: 100, detectionInterval: 120 })
    const idle = make(fixture.api)
    expect(fixture.controls.state).toBe("active")
    const changes = yield* Effect.forkChild(Stream.runCollect(Stream.take(idle.onStateChanged, 3)))
    yield* Effect.promise(() => fixture.controls.onStateChanged.waitForListener())
    yield* idle.setDetectionInterval(90)
    yield* idle.setDetectionInterval(95)
    yield* idle.setDetectionInterval(120)
    yield* idle.setDetectionInterval(100)
    expect(yield* Fiber.join(changes)).toEqual(["idle", "active", "idle"])
    // queryState takes its own threshold, independent of the detection interval.
    expect(yield* idle.queryState(101)).toBe("active")
  }))

  it.effect("takes its starting state from options and rejects invalid ones", () => Effect.gen(function*() {
    const sampled = (fixture: ReturnType<typeof makeIdle>): IdleState => {
      fixture.api.onStateChanged.addListener(() => {})
      fixture.controls.poll()

      return fixture.controls.state
    }

    const fixture = makeIdle({ idleTime: 30, locked: true, detectionInterval: 20, autoLockDelay: 300 })
    expect(fixture.controls.locked).toBe(true)
    expect(fixture.controls.idleTime).toBe(30)
    expect(sampled(fixture)).toBe("locked")
    expect(yield* make(fixture.api).getAutoLockDelay).toBe(300)
    fixture.controls.unlock()
    expect(fixture.controls.state).toBe("active")
    expect(fixture.controls.idleTime).toBe(0)
    expect(sampled(makeIdle({ idleTime: 20, detectionInterval: 20 }))).toBe("idle")
    expect(sampled(makeIdle({ idleTime: 19, detectionInterval: 20 }))).toBe("active")
    expect(makeIdle({ detectionInterval: 99999 }).controls.detectionInterval).toBe(maximumInterval)
    expect(() => makeIdle({ detectionInterval: 10 })).toThrow(TypeError)
    expect(() => makeIdle({ idleTime: -1 })).toThrow(RangeError)
    expect(() => makeIdle({ autoLockDelay: Number.NaN })).toThrow(RangeError)
  }))

  it.effect("rejects invalid elapsed time without changing state", () => Effect.gen(function*() {
    const fixture = makeIdle({ idleTime: 10 })

    for (const seconds of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => fixture.controls.elapse(seconds)).toThrow(RangeError)
    }

    expect(() => fixture.controls.setAutoLockDelay(-5)).toThrow(RangeError)
    expect(fixture.controls.idleTime).toBe(10)
    expect(fixture.controls.autoLockDelay).toBe(0)
    fixture.controls.setAutoLockDelay(120)
    expect(yield* make(fixture.api).getAutoLockDelay).toBe(120)
  }))

  it.effect("fails each operation once through failNext, before any change", () => Effect.gen(function*() {
    const fixture = makeIdle({ idleTime: 100 })
    const idle = make(fixture.api)
    fixture.api.onStateChanged.addListener(() => {})
    fixture.controls.poll()
    const queryCause = new Error("query")
    const setCause = new Error("set")
    const delayCause = new Error("delay")
    fixture.controls.failNext("queryState", queryCause)
    fixture.controls.failNext("setDetectionInterval", setCause)
    fixture.controls.failNext("getAutoLockDelay", delayCause)
    // queryState rejects rather than throwing, as Chrome's would for a browser-side failure.
    const rejected = fixture.api.queryState(60)
    expect(rejected).toBeInstanceOf(Promise)
    yield* Effect.promise(() => expect(rejected).rejects.toBe(queryCause))
    expect(() => fixture.api.setDetectionInterval(15)).toThrow(setCause)
    expect(fixture.controls.detectionInterval).toBe(60)
    expect(fixture.controls.state).toBe("idle")
    expect(yield* Effect.flip(idle.getAutoLockDelay)).toMatchObject({ operation: "getAutoLockDelay", cause: delayCause })
    expect(yield* idle.queryState(60)).toBe("idle")
    yield* idle.setDetectionInterval(15)
    expect(fixture.controls.detectionInterval).toBe(15)
    expect(yield* idle.getAutoLockDelay).toBe(0)
  }))

  it.effect("returns listener exceptions and keeps delivering to later listeners", () => Effect.gen(function*() {
    const fixture = makeIdle()
    const cause = new Error("listener threw")
    const seen: Array<IdleState> = []
    fixture.api.onStateChanged.addListener(() => { throw cause })
    fixture.api.onStateChanged.addListener((state) => { seen.push(state) })
    expect(fixture.controls.lock()).toEqual([cause])
    expect(fixture.controls.lock()).toEqual([])
    expect(seen).toEqual(["locked"])
    expect(yield* make(fixture.api).queryState(60)).toBe("locked")
  }))

  it.effect("queues changes made from inside a listener so every listener sees states in order", () => Effect.gen(function*() {
    const fixture = makeIdle()
    const first: Array<IdleState> = []
    const second: Array<IdleState> = []
    const cause = new Error("second listener threw")
    fixture.api.onStateChanged.addListener((state) => {
      first.push(state)

      if (state === "idle") fixture.controls.input()
    })
    fixture.api.onStateChanged.addListener((state) => {
      second.push(state)

      if (state === "active") throw cause
    })
    expect(fixture.controls.elapse(60)).toEqual([cause])
    expect(first).toEqual(["idle", "active"])
    expect(second).toEqual(["idle", "active"])
    expect(fixture.controls.state).toBe("active")
    expect(yield* make(fixture.api).queryState(60)).toBe("active")
  }))

  it.effect("samples from Chrome's initial \"active\", so a subscription can open with the state the machine is already in", () => Effect.gen(function*() {
    const fixture = makeIdle({ locked: true })
    const idle = make(fixture.api)
    // Chrome's per-extension record starts "active" and is sampled only while a listener exists.
    expect(fixture.controls.state).toBe("active")
    expect(yield* idle.queryState(60)).toBe("locked")
    const first = yield* Effect.forkChild(Stream.runHead(idle.onStateChanged))
    yield* Effect.promise(() => fixture.controls.onStateChanged.waitForListener())
    // Chrome never calls a listener while it is being added: the first sample comes a tick later.
    expect(fixture.controls.state).toBe("active")
    expect(fixture.controls.poll()).toEqual([])
    expect(yield* Fiber.join(first)).toEqual(Option.some("locked"))
    expect(fixture.controls.state).toBe("locked")
    expect(fixture.controls.poll()).toEqual([])
  }))

  it.effect("stops sampling without listeners, so a later subscription sees the change it missed", () => Effect.gen(function*() {
    const fixture = makeIdle()
    const idle = make(fixture.api)
    const locked = yield* Effect.forkChild(Stream.runHead(idle.onStateChanged))
    yield* Effect.promise(() => fixture.controls.onStateChanged.waitForListener())
    fixture.controls.lock()
    expect(yield* Fiber.join(locked)).toEqual(Option.some("locked"))
    expect(fixture.controls.onStateChanged.listenerCount).toBe(0)
    // Nothing samples now: neither changes, the detection interval, nor a tick.
    fixture.controls.unlock()
    yield* idle.setDetectionInterval(15)
    expect(fixture.controls.poll()).toEqual([])
    expect(fixture.controls.state).toBe("locked")
    expect(yield* idle.queryState(15)).toBe("active")
    const resumed = yield* Effect.forkChild(Stream.runCollect(Stream.take(idle.onStateChanged, 2)))
    yield* Effect.promise(() => fixture.controls.onStateChanged.waitForListener())
    // The first change after re-subscribing is sampled against the stale "locked".
    fixture.controls.elapse(15)
    fixture.controls.input()
    expect(yield* Fiber.join(resumed)).toEqual(["idle", "active"])
  }))

  it.effect("replaces members with overrides", () => Effect.gen(function*() {
    const fixture = makeIdle({ overrides: { queryState: () => Promise.resolve("locked") } })
    expect(yield* make(fixture.api).queryState(60)).toBe("locked")
    expect(fixture.controls.state).toBe("active")
  }))
})
