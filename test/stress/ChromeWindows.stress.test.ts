// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Deferred, Effect, Exit, Fiber, Option, Result, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChromeWindowsError, make, WINDOW_ID_NONE } from "../../src/ChromeWindows.js"
import type { ChromeWindowsApi, ChromeWindowsService, WindowEventFilter, WindowType } from "../../src/ChromeWindows.js"
import { makeWindows } from "../../src/testing/Windows.js"

/** A deterministic 32-bit generator (mulberry32), so every run churns the same way. */
const seeded = (seed: number) => {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <A>(random: () => number, values: ReadonlyArray<A>): A => {
  const value = values[Math.floor(random() * values.length)]

  if (value === undefined) throw new Error("pick from an empty list")

  return value
}

const window: chrome.windows.Window = {
  id: 1, focused: false, alwaysOnTop: false, incognito: false, state: "normal", type: "normal"
}

/** A fast mock event recording every listener added and removed, with explicit gates and hooks. */
const event = <Args extends Array<unknown>>() => {
  const listeners = new Set<(...args: Args) => void>()
  const added = new Set<(...args: Args) => void>()
  const removed = new Set<(...args: Args) => void>()
  const waiting: Array<{ readonly count: number, readonly resolve: () => void }> = []
  const filters: Array<WindowEventFilter | undefined> = []
  let adds = 0
  let failure: { readonly cause: Error, readonly afterAdding: boolean } | undefined
  let onAdd: (() => void) | undefined
  let onRemove: (() => void) | undefined

  return {
    listeners,
    added,
    removed,
    filters,
    get adds() { return adds },
    /** Listeners ever added that `removeListener` never received. */
    unremoved: () => Array.from(added).filter((listener) => !removed.has(listener)).length,
    /** Resolves once `count` listeners have been added in total. */
    addedTimes: (count: number) => new Promise<void>((resolve) => {
      if (adds >= count) resolve()
      else waiting.push({ count, resolve })
    }),
    failNext: (cause: Error, afterAdding = false) => { failure = { cause, afterAdding } },
    /** Runs after each successful registration, while `addListener` is still on the stack. */
    setOnAdd: (hook: (() => void) | undefined) => { onAdd = hook },
    /** Runs inside each `removeListener`, before the listener is removed. */
    setOnRemove: (hook: (() => void) | undefined) => { onRemove = hook },
    addListener(listener: (...args: Args) => void, filter?: WindowEventFilter) {
      const failing = failure
      failure = undefined

      if (failing !== undefined && !failing.afterAdding) throw failing.cause

      listeners.add(listener)
      added.add(listener)
      filters.push(filter)

      if (failing !== undefined) throw failing.cause

      adds++

      for (const waiter of waiting.filter((each) => each.count <= adds)) {
        waiting.splice(waiting.indexOf(waiter), 1)
        waiter.resolve()
      }

      onAdd?.()
    },
    removeListener(listener: (...args: Args) => void) {
      onRemove?.()
      removed.add(listener)
      listeners.delete(listener)
    },
    emit: (...args: Args) => { for (const listener of Array.from(listeners)) listener(...args) }
  }
}

type WindowEvent = ReturnType<typeof event<[chrome.windows.Window]>>

type IdEvent = ReturnType<typeof event<[number]>>

const mockApi = () => ({
  get: async (windowId: number): Promise<chrome.windows.Window> => ({ ...window, id: windowId }),
  getCurrent: async (): Promise<chrome.windows.Window> => window,
  getLastFocused: async (): Promise<chrome.windows.Window> => window,
  getAll: async (): Promise<Array<chrome.windows.Window>> => [window],
  create: async (): Promise<chrome.windows.Window | undefined> => window,
  update: async (windowId: number): Promise<chrome.windows.Window> => ({ ...window, id: windowId }),
  remove: async (): Promise<void> => {},
  onCreated: event<[chrome.windows.Window]>(),
  onRemoved: event<[number]>(),
  onFocusChanged: event<[number]>(),
  onBoundsChanged: event<[chrome.windows.Window]>()
}) satisfies ChromeWindowsApi

const events = ["onCreated", "onRemoved", "onFocusChanged", "onBoundsChanged"] as const

type EventName = typeof events[number]

/** One stream of the service with its mock source, both reduced to window ids. */
interface Driver {
  readonly source: WindowEvent | IdEvent
  readonly stream: (filter?: WindowEventFilter) => Stream.Stream<number, ChromeWindowsError>
  readonly emit: (id: number) => void
}

const driver = (api: ReturnType<typeof mockApi>, windows: ChromeWindowsService, name: EventName): Driver => {
  const idOf = (each: chrome.windows.Window) => each.id ?? WINDOW_ID_NONE

  const drivers: Record<EventName, Driver> = {
    onCreated: {
      source: api.onCreated,
      stream: (filter) => Stream.map(windows.onCreated(filter), idOf),
      emit: (id) => api.onCreated.emit({ ...window, id })
    },
    onRemoved: { source: api.onRemoved, stream: (filter) => windows.onRemoved(filter), emit: (id) => api.onRemoved.emit(id) },
    onFocusChanged: {
      source: api.onFocusChanged,
      stream: (filter) => windows.onFocusChanged(filter),
      emit: (id) => api.onFocusChanged.emit(id)
    },
    onBoundsChanged: {
      source: api.onBoundsChanged,
      stream: () => Stream.map(windows.onBoundsChanged, idOf),
      emit: (id) => api.onBoundsChanged.emit({ ...window, id })
    }
  }

  return drivers[name]
}

/** Every listener a source ever saw is gone and was removed exactly through `removeListener`. */
const expectClean = (source: WindowEvent | IdEvent) => {
  expect(source.listeners.size).toBe(0)

  expect(source.unremoved()).toBe(0)
}

/** How the concurrent-call test identifies a call: its window id, or its unique options object. */
type CallKey = number | chrome.windows.QueryOptions | chrome.windows.CreateData

const range = (from: number, length: number) => Array.from({ length }, (_, index) => from + index)

const SENTINEL = -999

describe("ChromeWindows stress", () => {
  it.effect.each(events)("keeps exactly the newest 64 of a 4,096-event burst during %s registration", (name) => Effect.gen(function*() {
    const api = mockApi()
    const subject = driver(api, make(api), name)

    subject.source.setOnAdd(() => {
      for (let id = 0; id < 4096; id++) subject.emit(id)

      subject.emit(SENTINEL)
    })
    const received = yield* Stream.runCollect(Stream.takeUntil(subject.stream(), (id) => id === SENTINEL))
    // 4,097 offers into 64 slots: the sentinel plus the 63 events before it.
    expect(received).toEqual([...range(4033, 63), SENTINEL])
    expectClean(subject.source)
    expect(subject.source.adds).toBe(1)
    expect(subject.source.removed.size).toBe(1)
  }))

  it.effect.each(events)("keeps exactly the newest 64 of a 4,096-event burst arriving after %s registered", (name) => Effect.gen(function*() {
    const api = mockApi()
    const subject = driver(api, make(api), name)
    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.takeUntil(subject.stream(), (id) => id === SENTINEL)))
    yield* Effect.promise(() => subject.source.addedTimes(1))
    yield* Effect.sync(() => {
      for (let id = 0; id < 4096; id++) subject.emit(id)

      subject.emit(SENTINEL)
    })
    expect(yield* Fiber.join(fiber)).toEqual([...range(4033, 63), SENTINEL])
    expectClean(subject.source)
    // Late dispatches after the stream ended reach nobody.
    subject.emit(1)
    expect(subject.source.listeners.size).toBe(0)
  }))

  it.effect("keeps the newest 64 matching events of filtered fixture bursts", () => Effect.gen(function*() {
    const fixture = makeWindows()
    const windows = make(fixture.api)
    const popups = yield* Effect.forkChild(Stream.runCollect(Stream.take(windows.onCreated({ windowTypes: ["popup"] }), 64)))
    yield* Effect.promise(() => fixture.controls.onCreated.waitForListener())

    const popupIds = yield* Effect.sync(() => {
      const ids: Array<number> = []

      for (let index = 0; index < 8192; index++) {
        const seededWindow = fixture.controls.seed({ type: index % 2 === 0 ? "normal" : "popup" })

        if (seededWindow.type === "popup") ids.push(seededWindow.id ?? WINDOW_ID_NONE)
      }

      return ids
    })

    expect((yield* Fiber.join(popups)).map((each) => each.id)).toEqual(popupIds.slice(-64))
    expect(fixture.controls.onCreated.listenerCount).toBe(0)

    // Focus moves across 4,096 windows, half of them devtools: a normal-only listener sees -1 for those.
    const focus = yield* Effect.forkChild(Stream.runCollect(Stream.take(windows.onFocusChanged({ windowTypes: ["normal"] }), 64)))
    yield* Effect.promise(() => fixture.controls.onFocusChanged.waitForListener())

    const expected = yield* Effect.sync(() => {
      const seen: Array<number> = []
      const pending: Array<Promise<chrome.windows.Window>> = []

      for (let index = 0; index < 4096; index++) {
        const id = index * 2 + 1
        const devtools = fixture.controls.seed({ type: "devtools" }).id ?? WINDOW_ID_NONE
        pending.push(fixture.api.update(id, { focused: true }), fixture.api.update(devtools, { focused: true }))
        seen.push(id, WINDOW_ID_NONE)
      }

      return { seen, pending }
    })

    yield* Effect.promise(() => Promise.all(expected.pending))
    expect(yield* Fiber.join(focus)).toEqual(expected.seen.slice(-64))
    expect(fixture.controls.onFocusChanged.listenerCount).toBe(0)

    const bounds = yield* Effect.forkChild(Stream.runCollect(Stream.take(windows.onBoundsChanged, 64)))
    yield* Effect.promise(() => fixture.controls.onBoundsChanged.waitForListener())
    const resized = yield* Effect.sync(() => range(1, 4096).map((width) => fixture.api.update(1, { width })))
    yield* Effect.promise(() => Promise.all(resized))
    expect((yield* Fiber.join(bounds)).map((each) => each.width)).toEqual(range(4033, 64))

    const closed = yield* Effect.forkChild(Stream.runCollect(Stream.take(windows.onRemoved({ windowTypes: ["popup"] }), 64)))
    yield* Effect.promise(() => fixture.controls.onRemoved.waitForListener())
    const removals = yield* Effect.sync(() => popupIds.map((id) => fixture.api.remove(id)))
    yield* Effect.promise(() => Promise.all(removals))
    expect(yield* Fiber.join(closed)).toEqual(popupIds.slice(-64))

    for (const controls of [fixture.controls.onCreated, fixture.controls.onRemoved, fixture.controls.onFocusChanged, fixture.controls.onBoundsChanged]) {
      expect(controls.listenerCount).toBe(0)
    }
  }))

  it.effect("churns 512 concurrent subscriptions, interrupting at every stage, down to zero listeners", () => Effect.gen(function*() {
    const random = seeded(0x5eed)
    const api = mockApi()
    const windows = make(api)
    const stages = ["unstarted", "idle", "buffered", "midDelivery", "completed", "failsBefore", "failsAfter", "reentrantRelease"] as const

    type Stage = typeof stages[number]

    const plans = Array.from({ length: 512 }, (_, index) => ({ index, stage: pick(random, stages), name: pick(random, events) }))
    const shared = (name: EventName) => driver(api, windows, name)
    const blocked = yield* Deferred.make<void>()
    const entered: Array<Deferred.Deferred<void>> = []

    // Stage "unstarted": forked and interrupted before the fiber ever runs.
    const unstarted = plans.filter((plan) => plan.stage === "unstarted")
    const early = yield* Effect.forEach(unstarted, (plan) => Effect.forkChild(Stream.runDrain(shared(plan.name).stream())))
    yield* Fiber.interruptAll(early)

    for (const fiber of early) expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)

    const baseline = Object.fromEntries(events.map((name) => [name, api[name].adds]))

    // Stages that fail registration or re-enter Chrome during release each get their own API.
    const isolated = plans.filter((plan) => plan.stage === "failsBefore" || plan.stage === "failsAfter" || plan.stage === "reentrantRelease")
      .map((plan) => {
        const own = mockApi()
        const subject = driver(own, make(own), plan.name)

        if (plan.stage === "failsBefore") subject.source.failNext(new Error(`refused ${plan.index}`))

        if (plan.stage === "failsAfter") subject.source.failNext(new Error(`refused ${plan.index}`), true)

        if (plan.stage === "reentrantRelease") {
          subject.source.setOnRemove(() => {
            for (let id = 0; id < 128; id++) subject.emit(id)
          })
        }

        return { plan, subject }
      })

    const sharedPlans = plans.filter((plan) => ["idle", "buffered", "midDelivery", "completed"].includes(plan.stage))
    const forks = new Map<number, Fiber.Fiber<ReadonlyArray<number> | void, ChromeWindowsError>>()

    for (const plan of sharedPlans) {
      const subject = shared(plan.name)

      if (plan.stage === "completed") {
        forks.set(plan.index, yield* Effect.forkChild(Stream.runCollect(Stream.take(subject.stream(), 3))))
      } else if (plan.stage === "idle" || plan.stage === "buffered") {
        forks.set(plan.index, yield* Effect.forkChild(Stream.runDrain(subject.stream())))
      } else {
        const gate = yield* Deferred.make<void>()
        entered.push(gate)
        forks.set(plan.index, yield* Effect.forkChild(Stream.runForEach(subject.stream(), () =>
          Deferred.succeed(gate, undefined).pipe(Effect.andThen(Deferred.await(blocked))))))
      }
    }

    const isolatedForks = yield* Effect.forEach(isolated, ({ subject }) => Effect.forkChild(Stream.runDrain(subject.stream())))

    for (const name of events) {
      const expected = baseline[name] ?? 0
      const count = sharedPlans.filter((plan) => plan.name === name).length
      yield* Effect.promise(() => api[name].addedTimes(expected + count))
    }

    const fibersOf = (stage: Stage) => sharedPlans.filter((plan) => plan.stage === stage).flatMap((plan) => {
      const fiber = forks.get(plan.index)

      return fiber === undefined ? [] : [fiber]
    })

    // Stage "idle": registered, nothing delivered yet.
    yield* Fiber.interruptAll(fibersOf("idle"))

    // Deliver 100 events per source in one synchronous turn and interrupt the "buffered" subscriptions in
    // that same turn, so their queues still hold undelivered events. Completed subscriptions finish and
    // "midDelivery" ones block inside their handler with a full buffer behind them.
    yield* Effect.sync(() => {
      for (const name of events) {
        for (let id = 0; id < 100; id++) shared(name).emit(id)
      }

      for (const fiber of fibersOf("buffered")) fiber.interruptUnsafe()
    })
    yield* Effect.forEach(entered, (gate) => Deferred.await(gate), { discard: true })
    yield* Fiber.interruptAll(fibersOf("midDelivery"))

    // 100 synchronous events into 64 slots: completed subscriptions start at event 36.
    for (const fiber of fibersOf("completed")) expect(yield* Fiber.join(fiber)).toEqual([36, 37, 38])

    for (const stage of ["idle", "buffered", "midDelivery"] as const) {
      for (const fiber of fibersOf(stage)) expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
    }

    // Reentrant releases happen on interruption; failing registrations end with typed errors on their own.
    const reentrant = isolated.flatMap(({ plan }, position) => plan.stage === "reentrantRelease" ? [isolatedForks[position]] : [])
    yield* Effect.forEach(isolated, ({ plan, subject }) => plan.stage === "reentrantRelease"
      ? Effect.promise(() => subject.source.addedTimes(1))
      : Effect.void, { discard: true })
    yield* Fiber.interruptAll(reentrant.flatMap((fiber) => fiber === undefined ? [] : [fiber]))

    for (const [position, { plan, subject }] of isolated.entries()) {
      const fiber = isolatedForks[position]

      if (fiber === undefined) throw new Error("missing isolated fiber")

      const exit = yield* Fiber.await(fiber)

      if (plan.stage === "reentrantRelease") {
        expect(Exit.hasInterrupts(exit)).toBe(true)
      } else {
        expect(Exit.isFailure(exit)).toBe(true)
        const error = yield* Effect.flip(Fiber.join(fiber))
        expect(error).toBeInstanceOf(ChromeWindowsError)
        expect(error.operation).toBe(plan.name)
        expect(error.cause).toEqual(new Error(`refused ${plan.index}`))
      }

      expectClean(subject.source)
    }

    for (const name of events) expectClean(api[name])

    expect(new Set(plans.map((plan) => plan.stage))).toEqual(new Set(stages))
  }))

  it.effect("interrupts subscriptions while Chrome is still inside addListener", () => Effect.gen(function*() {
    const api = mockApi()
    const windows = make(api)

    for (const name of events) {
      const subject = driver(api, windows, name)

      for (let round = 0; round < 64; round++) {
        const fiber = yield* Effect.forkChild(Stream.runDrain(subject.stream()))

        subject.source.setOnAdd(() => {
          fiber.interruptUnsafe()
          subject.emit(round)
        })
        expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
      }

      subject.source.setOnAdd(undefined)
      expectClean(subject.source)
      expect(subject.source.removed.size).toBe(64)
    }
  }))

  it.effect("types 2,048 concurrent calls with interleaved resolutions, rejections and throws", () => Effect.gen(function*() {
    const random = seeded(0xc0ffee)
    const operations = ["get", "getCurrent", "getLastFocused", "getAll", "create", "update", "focus", "remove"] as const

    type Outcome = "resolve" | "reject" | "throw"

    const total = 2048

    const plans = Array.from({ length: total }, (_, index) => ({
      index,
      operation: pick(random, operations),
      outcome: pick<Outcome>(random, ["resolve", "reject", "throw"]),
      cause: new Error(`failure ${index}`)
    }))

    const byKey = new Map<CallKey, typeof plans[number]>()
    let started = 0
    let allStarted!: () => void
    const ready = new Promise<void>((resolve) => { allStarted = resolve })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })

    const settle = <A>(key: CallKey, value: (index: number) => A): Promise<A> => {
      const plan = byKey.get(key)

      if (plan === undefined) throw new Error("unplanned call")

      started++

      if (started === total) allStarted()

      if (plan.outcome === "throw") throw plan.cause

      return gate.then(() => plan.outcome === "resolve" ? value(plan.index) : Promise.reject(plan.cause))
    }

    const at = (index: number): chrome.windows.Window => ({ ...window, id: index })

    const api: ChromeWindowsApi = {
      ...mockApi(),
      get: (windowId) => settle(windowId, at),
      getCurrent: (queryOptions) => settle(queryOptions ?? {}, at),
      getLastFocused: (queryOptions) => settle(queryOptions ?? {}, at),
      getAll: (queryOptions) => settle(queryOptions ?? {}, (index) => [at(index)]),
      create: (createData) => settle(createData ?? {}, (index) => index % 2 === 0 ? at(index) : undefined),
      update: (windowId) => settle(windowId, at),
      remove: (windowId) => settle(windowId, () => undefined)
    }

    const windows = make(api)

    const effects = plans.map((plan): Effect.Effect<unknown, ChromeWindowsError> => {
      const options: chrome.windows.QueryOptions = {}
      const createData: chrome.windows.CreateData = {}

      switch (plan.operation) {
        case "get":
          byKey.set(plan.index, plan)

          return windows.get(plan.index)
        case "update":
          byKey.set(plan.index, plan)

          return windows.update(plan.index, { width: plan.index })
        case "focus":
          byKey.set(plan.index, plan)

          return windows.focus(plan.index)
        case "remove":
          byKey.set(plan.index, plan)

          return windows.remove(plan.index)
        case "create":
          byKey.set(createData, plan)

          return windows.create(createData)
        case "getAll":
          byKey.set(options, plan)

          return windows.getAll(options)
        case "getCurrent":
          byKey.set(options, plan)

          return windows.getCurrent(options)
        case "getLastFocused":
          byKey.set(options, plan)

          return windows.getLastFocused(options)
      }
    })

    const fiber = yield* Effect.forkChild(Effect.forEach(effects, (effect) => Effect.result(effect), { concurrency: "unbounded" }))
    yield* Effect.promise(() => ready)
    expect(started).toBe(total)
    release()
    const results = yield* Fiber.join(fiber)

    for (const [index, result] of results.entries()) {
      const plan = plans[index]

      if (plan === undefined) throw new Error("missing plan")

      if (plan.outcome === "resolve") {
        expect(Result.isSuccess(result)).toBe(true)

        if (Result.isSuccess(result)) {
          const expected = {
            get: at(index), getCurrent: at(index), getLastFocused: at(index), getAll: [at(index)],
            create: index % 2 === 0 ? Option.some(at(index)) : Option.none(), update: at(index), focus: at(index), remove: undefined
          }

          expect(result.success).toEqual(expected[plan.operation])
        }
      } else {
        expect(Result.isFailure(result)).toBe(true)

        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(ChromeWindowsError)
          expect(result.failure.operation).toBe(plan.operation === "focus" ? "update" : plan.operation)
          expect(result.failure.cause).toBe(plan.cause)
        }
      }
    }

    const outcomes = new Set(plans.map((plan) => `${plan.operation}:${plan.outcome}`))
    expect(outcomes.size).toBe(operations.length * 3)
  }))

  it.effect("interrupts 1,024 in-flight calls and tolerates Chrome settling them afterwards", () => Effect.gen(function*() {
    const pending: Array<{ readonly resolve: () => void, readonly reject: (cause: Error) => void }> = []
    let allStarted!: () => void
    const ready = new Promise<void>((resolve) => { allStarted = resolve })

    const hang = <A>(value: A) => new Promise<A>((resolve, reject) => {
      pending.push({ resolve: () => resolve(value), reject })

      if (pending.length === 1024) allStarted()
    })

    const api: ChromeWindowsApi = {
      ...mockApi(),
      get: () => hang(window),
      getAll: () => hang([window]),
      create: () => hang(window),
      update: () => hang(window),
      remove: () => hang(undefined)
    }

    const windows = make(api)
    const calls = [windows.get(1), windows.getAll(), windows.create(), windows.focus(1), windows.remove(1)]

    const fibers = yield* Effect.forEach(range(0, 1024), (index) =>
      Effect.forkChild(Effect.asVoid(calls[index % calls.length] ?? Effect.void)))

    yield* Effect.promise(() => ready)
    yield* Fiber.interruptAll(fibers)

    for (const fiber of fibers) expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)

    // Settling after interruption must neither resurrect the fibers nor leave unhandled rejections.
    for (const [index, entry] of pending.entries()) {
      if (index % 2 === 0) entry.resolve()
      else entry.reject(new Error(`late failure ${index}`))
    }

    for (const fiber of fibers) expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
  }))

  it.effect("keeps fixture invariants across 10,000 windows", () => Effect.gen(function*() {
    const random = seeded(42)
    const fixture = makeWindows()
    const windows = make(fixture.api)
    const types: ReadonlyArray<WindowType> = ["normal", "popup", "devtools", "app"]
    const seededWindows = Array.from({ length: 10_000 }, () => fixture.controls.seed({ type: pick(random, types), incognito: random() < 0.1 }))
    const visible = (shown: ReadonlyArray<WindowType>) => seededWindows.filter((each) => shown.includes(each.type ?? "normal")).map((each) => each.id)
    expect((yield* windows.getAll()).map((each) => each.id)).toEqual(visible(["normal", "popup"]))
    expect((yield* windows.getAll({ windowTypes: ["devtools", "app"] })).map((each) => each.id)).toEqual(visible(["devtools", "app"]))
    expect((yield* windows.getLastFocused({ windowTypes: [...types] })).id).toBe(1)

    for (let round = 0; round < 2000; round++) {
      const target = pick(random, seededWindows).id ?? WINDOW_ID_NONE
      expect((yield* windows.focus(target)).focused).toBe(true)
      expect(fixture.controls.focused).toBe(target)
    }

    const focusedWindows = (yield* windows.getAll({ windowTypes: [...types] })).filter((each) => each.focused)
    expect(focusedWindows.map((each) => each.id)).toEqual([fixture.controls.focused])
    fixture.controls.incognitoAccess = false
    const hidden = seededWindows.filter((each) => each.incognito).length
    expect(yield* windows.getAll({ windowTypes: [...types] })).toHaveLength(10_000 - hidden)
    fixture.controls.incognitoAccess = true

    const order = seededWindows.map((each) => each.id ?? WINDOW_ID_NONE)

    for (let index = order.length - 1; index > 0; index--) {
      const swap = Math.floor(random() * (index + 1))
      const current = order[index] ?? WINDOW_ID_NONE
      order[index] = order[swap] ?? WINDOW_ID_NONE
      order[swap] = current
    }

    yield* Effect.forEach(order, (id) => windows.remove(id), { concurrency: 64, discard: true })
    expect(yield* windows.getAll({ windowTypes: [...types] })).toEqual([])
    expect(fixture.controls.focused).toBe(WINDOW_ID_NONE)
    expect(yield* Effect.flip(windows.getLastFocused())).toMatchObject({ operation: "getLastFocused" })
  }))

  it.effect("keeps focus consistent across 4,096 racing fixture operations", () => Effect.gen(function*() {
    const random = seeded(7)
    const fixture = makeWindows()
    const windows = make(fixture.api)
    const focusEvents: Array<number> = []
    fixture.api.onFocusChanged.addListener((windowId) => { focusEvents.push(windowId) }, { windowTypes: ["normal", "popup", "devtools"] })
    const ids = range(0, 256).map(() => fixture.controls.seed({ type: pick(random, ["normal", "popup", "devtools"] as const) }).id ?? WINDOW_ID_NONE)
    const kinds = ["focus", "unfocus", "minimize", "maximize", "restore", "resize", "remove", "create", "get", "badState"] as const
    const plans = Array.from({ length: 4096 }, () => ({ kind: pick(random, kinds), id: pick(random, ids), size: Math.floor(random() * 2000) }))

    const run = (plan: typeof plans[number]): Effect.Effect<unknown, ChromeWindowsError> => {
      switch (plan.kind) {
        case "focus": return windows.focus(plan.id)
        case "unfocus": return windows.update(plan.id, { focused: false })
        case "minimize": return windows.update(plan.id, { state: "minimized" })
        case "maximize": return windows.update(plan.id, { state: "maximized" })
        case "restore": return windows.update(plan.id, { state: "normal" })
        case "resize": return windows.update(plan.id, { width: plan.size, height: plan.size })
        case "remove": return windows.remove(plan.id)
        case "create": return windows.create({ focused: plan.size % 2 === 0 })
        case "get": return windows.get(plan.id, { windowTypes: ["normal", "popup", "devtools"] })
        case "badState": return windows.update(plan.id, { state: "minimized", focused: true })
      }
    }

    const memberOfKind: Record<typeof kinds[number], string> = {
      focus: "update", unfocus: "update", minimize: "update", maximize: "update", restore: "update", resize: "update",
      remove: "remove", create: "create", get: "get", badState: "update"
    }

    const results = yield* Effect.forEach(plans, (plan) => Effect.result(run(plan)), { concurrency: "unbounded" })

    const missing = (plan: typeof plans[number]) => new Error(`No window with id: ${plan.id}.`)

    for (const [index, result] of results.entries()) {
      const plan = plans[index]

      if (plan === undefined) throw new Error("missing plan")

      if (plan.kind === "badState") {
        // Never applied: rejected as Chrome rejects it, or because the window is already gone.
        expect(Result.isFailure(result)).toBe(true)
      }

      if (Result.isSuccess(result)) continue

      expect(result.failure).toBeInstanceOf(ChromeWindowsError)
      expect(result.failure.operation).toBe(memberOfKind[plan.kind])
      const allowed = plan.kind === "badState" ? [new Error("Invalid value for state"), missing(plan)] : [missing(plan)]
      expect(allowed).toContainEqual(result.failure.cause)
    }

    expect(results.filter((result) => Result.isFailure(result)).length).toBeGreaterThan(0)
    const all = yield* windows.getAll({ windowTypes: ["normal", "popup", "devtools"] })
    const focused = all.filter((each) => each.focused)
    const current = fixture.controls.focused

    if (current === WINDOW_ID_NONE) {
      expect(focused).toEqual([])
    } else {
      expect(focused.map((each) => each.id)).toEqual([current])
      expect(focused[0]?.state).not.toBe("minimized")
    }

    expect(focusEvents.at(-1)).toBe(current)

    for (const [index, id] of focusEvents.entries()) {
      if (index > 0) expect(id).not.toBe(focusEvents[index - 1])
    }
  }))
})
