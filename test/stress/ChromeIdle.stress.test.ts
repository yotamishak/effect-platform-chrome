// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeIdle, ChromeIdleError, layerLive, make } from "../../src/ChromeIdle.js"
import type { ChromeIdleApi, ChromeIdleService, IdleState } from "../../src/ChromeIdle.js"
import type { EventSource } from "../../src/internal/event.js"
import * as TestEvent from "../../src/testing/Event.js"
import { makeIdle, maximumInterval, minimumInterval } from "../../src/testing/Idle.js"

const states: ReadonlyArray<IdleState> = ["active", "idle", "locked"]

/** The reference model of the machine the fixture simulates. */
interface IdleModel {
  idleTime: number
  locked: boolean
  interval: number
  reported: IdleState
}

/** mulberry32: a small seeded generator, so every run exercises the same schedule. */
const seeded = (seed: number) => {
  let state = seed >>> 0

  const next = (): number => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  return {
    next,
    int: (below: number): number => Math.floor(next() * below),
    state: (): IdleState => states[Math.floor(next() * 3)] ?? "active"
  }
}

const shuffled = <A>(items: ReadonlyArray<A>, random: ReturnType<typeof seeded>): Array<A> => {
  const copy = Array.from(items)

  for (let index = copy.length - 1; index > 0; index--) {
    const other = random.int(index + 1)
    const current = copy[index]
    const swapped = copy[other]

    if (current !== undefined && swapped !== undefined) {
      copy[index] = swapped
      copy[other] = current
    }
  }

  return copy
}

const baseApi = (onStateChanged: EventSource<[IdleState]>): ChromeIdleApi => ({
  queryState: () => Promise.resolve("active"),
  setDetectionInterval: () => {},
  getAutoLockDelay: () => Promise.resolve(0),
  onStateChanged
})

/** Completes a gate once `count` listeners have been added through the wrapper. */
const gated = (source: EventSource<[IdleState]>) => {
  const waiters: Array<{ readonly count: number; readonly gate: Deferred.Deferred<void> }> = []
  let added = 0

  return {
    source: {
      addListener: (listener: (state: IdleState) => void) => {
        source.addListener(listener)
        added++

        for (const waiter of waiters) if (added >= waiter.count) Deferred.doneUnsafe(waiter.gate, Effect.void)
      },
      removeListener: (listener: (state: IdleState) => void) => source.removeListener(listener)
    } satisfies EventSource<[IdleState]>,
    added: (count: number): Effect.Effect<void> => Effect.suspend(() => {
      if (added >= count) return Effect.void

      const gate = Deferred.makeUnsafe<void>()
      waiters.push({ count, gate })

      return Deferred.await(gate)
    })
  }
}

describe("ChromeIdle stress: bursts", () => {
  it.effect("keeps exactly the newest 64 of a 4,096-event burst, in order, then removes the listener", () => Effect.gen(function*() {
    const event = TestEvent.makeEvent<[IdleState]>()
    const random = seeded(4096)
    const sent = Array.from({ length: 4096 }, () => random.state())
    const received: Array<IdleState> = []
    const filled = Deferred.makeUnsafe<void>()

    const stream = make(baseApi(event.api)).onStateChanged.pipe(
      Stream.tap((state) => Effect.sync(() => {
        received.push(state)

        if (received.length === 64) Deferred.doneUnsafe(filled, Effect.void)
      })),
      Stream.take(65)
    )

    const run = yield* Effect.forkChild(Stream.runDrain(stream))
    yield* Effect.promise(() => event.controls.waitForListener())

    for (const state of sent) event.controls.emit(state)

    yield* Deferred.await(filled)
    // Nothing older than the newest 64 is still buffered: the next event comes straight after.
    event.controls.emit("locked")
    yield* Fiber.join(run)
    expect(received).toEqual([...sent.slice(-64), "locked"])
    expect(event.controls.listenerCount).toBe(0)
    expect(event.controls.emit("idle")).toEqual([])
  }))

  it.effect("keeps the newest 64 of a burst Chrome delivers while the listener is being added", () => Effect.gen(function*() {
    const event = TestEvent.makeEvent<[IdleState]>()
    const random = seeded(17)
    const sent = Array.from({ length: 4096 }, () => random.state())

    const eager: EventSource<[IdleState]> = {
      addListener: (listener) => {
        event.api.addListener(listener)

        for (const state of sent) listener(state)
      },
      removeListener: (listener) => event.api.removeListener(listener)
    }

    const received = yield* Stream.runCollect(Stream.take(make(baseApi(eager)).onStateChanged, 64))
    expect(received).toEqual(sent.slice(-64))
    expect(event.controls.listenerCount).toBe(0)
  }))

  it.effect("gives each of 64 concurrent subscribers its own newest 64 of one 4,096-event burst", () => Effect.gen(function*() {
    const event = TestEvent.makeEvent<[IdleState]>()
    const events = gated(event.api)
    const random = seeded(64)
    const sent = Array.from({ length: 4096 }, () => random.state())
    const idle = make(baseApi(events.source))

    const subscribers = Array.from({ length: 64 }, () => {
      const received: Array<IdleState> = []
      const filled = Deferred.makeUnsafe<void>()

      const stream = idle.onStateChanged.pipe(
        Stream.tap((state) => Effect.sync(() => {
          received.push(state)

          if (received.length === 64) Deferred.doneUnsafe(filled, Effect.void)
        })),
        Stream.take(65)
      )

      return { received, filled, stream }
    })

    const fibers = yield* Effect.forEach(subscribers, ({ stream }) => Effect.forkChild(Stream.runDrain(stream)))
    yield* events.added(64)
    expect(event.controls.listenerCount).toBe(64)

    for (const state of sent) event.controls.emit(state)

    yield* Effect.forEach(subscribers, ({ filled }) => Deferred.await(filled), { discard: true })
    event.controls.emit("idle")
    yield* Fiber.joinAll(fibers)

    for (const { received } of subscribers) expect(received).toEqual([...sent.slice(-64), "idle"])

    expect(event.controls.listenerCount).toBe(0)
  }))

  it.effect("ignores callbacks Chrome makes while or after the listener is removed", () => Effect.gen(function*() {
    const event = TestEvent.makeEvent<[IdleState]>()
    const captured: Array<(state: IdleState) => void> = []

    const late: EventSource<[IdleState]> = {
      addListener: (listener) => {
        captured.push(listener)
        event.api.addListener(listener)
      },
      removeListener: (listener) => {
        listener("locked")
        event.api.removeListener(listener)
        listener("idle")
      }
    }

    const run = yield* Effect.forkChild(Stream.runCollect(Stream.take(make(baseApi(late)).onStateChanged, 1)))
    yield* Effect.promise(() => event.controls.waitForListener())
    event.controls.emit("active")
    expect(yield* Fiber.join(run)).toEqual(["active"])

    // A stale reference that fires later delivers nothing and does not throw.
    for (const listener of captured) for (let index = 0; index < 4096; index++) listener("idle")

    expect(event.controls.listenerCount).toBe(0)
  }))
})

describe("ChromeIdle stress: subscription churn", () => {
  it.effect("churns 512 concurrent subscriptions with interruption at every stage, ending with zero listeners", () => Effect.gen(function*() {
    const event = TestEvent.makeEvent<[IdleState]>()
    const random = seeded(512)
    const stages = ["beforeStart", "registered", "midDelivery", "completes", "refused", "partial", "pulling"] as const

    type Stage = typeof stages[number]

    const subscriptions = Array.from({ length: 512 }, (_, index) => {
      const stage: Stage = stages[index < stages.length ? index : random.int(stages.length)] ?? "registered"
      const cause = new Error(`registration ${index} failed`)
      const registered = Deferred.makeUnsafe<void>()

      const source: EventSource<[IdleState]> = {
        addListener: (listener) => {
          if (stage === "refused") throw cause

          event.api.addListener(listener)
          Deferred.doneUnsafe(registered, Effect.void)

          if (stage === "partial") throw cause
        },
        removeListener: (listener) => event.api.removeListener(listener)
      }

      const blocked = Deferred.makeUnsafe<void>()
      const seen = Deferred.makeUnsafe<void>()
      const take = 1 + random.int(64)

      return { index, stage, cause, registered, blocked, seen, take, idle: make(baseApi(source)) }
    })

    const run = (subscription: typeof subscriptions[number]): Effect.Effect<ReadonlyArray<IdleState>, ChromeIdleError> => {
      const stream = subscription.idle.onStateChanged

      switch (subscription.stage) {
        case "midDelivery":
          return Stream.runCollect(Stream.tap(stream, () =>
            Effect.andThen(Deferred.succeed(subscription.seen, undefined), Deferred.await(subscription.blocked))))
        case "completes":
          return Stream.runCollect(Stream.take(stream, subscription.take))
        default:
          return Stream.runCollect(stream)
      }
    }

    const fibers = yield* Effect.forEach(subscriptions, (subscription) => Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(run(subscription))

      if (subscription.stage === "beforeStart") yield* Fiber.interrupt(fiber)

      return fiber
    }))

    const live = subscriptions.filter((subscription) =>
      subscription.stage !== "beforeStart" && subscription.stage !== "refused" && subscription.stage !== "partial")

    yield* Effect.forEach(live, (subscription) => Deferred.await(subscription.registered), { discard: true })

    for (const subscription of subscriptions) {
      const fiber = fibers[subscription.index]

      if (fiber === undefined) continue

      if (subscription.stage === "refused" || subscription.stage === "partial") {
        const error = yield* Effect.flip(Fiber.join(fiber))
        expect(error).toBeInstanceOf(ChromeIdleError)
        expect(error.operation).toBe("onStateChanged")
        expect(error.cause).toBe(subscription.cause)
      }

      if (subscription.stage === "registered") {
        const exit = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)))
        expect(Exit.hasInterrupts(exit)).toBe(true)
      }
    }

    const remaining = live.filter((subscription) => subscription.stage !== "registered").length
    expect(event.controls.listenerCount).toBe(remaining)
    const sent = Array.from({ length: 100 }, () => random.state())

    for (const state of sent) event.controls.emit(state)

    for (const subscription of subscriptions) {
      const fiber = fibers[subscription.index]

      if (fiber === undefined) continue

      if (subscription.stage === "completes") {
        expect(yield* Fiber.join(fiber)).toEqual(sent.slice(36, 36 + subscription.take))
      }

      if (subscription.stage === "midDelivery") {
        yield* Deferred.await(subscription.seen)
        expect(Exit.hasInterrupts(yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))))).toBe(true)
      }

      if (subscription.stage === "pulling" || subscription.stage === "beforeStart") {
        expect(Exit.hasInterrupts(yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))))).toBe(true)
      }
    }

    expect(event.controls.listenerCount).toBe(0)
    expect(event.controls.emit("locked")).toEqual([])
  }))

  it.effect("survives 16 rounds of 32 subscribe/emit/interrupt cycles with 4,096 events per round", () => Effect.gen(function*() {
    const event = TestEvent.makeEvent<[IdleState]>()
    const events = gated(event.api)
    const idle = make(baseApi(events.source))
    const random = seeded(16)

    for (let round = 0; round < 16; round++) {
      const fibers = yield* Effect.forEach(Array.from({ length: 32 }), () => Effect.forkChild(Stream.runDrain(idle.onStateChanged)))
      yield* events.added((round + 1) * 32)
      expect(event.controls.listenerCount).toBe(32)

      for (let index = 0; index < 4096; index++) event.controls.emit(random.state())

      yield* Fiber.interruptAll(fibers)
      expect(event.controls.listenerCount).toBe(0)
    }
  }))
})

describe("ChromeIdle stress: concurrent calls", () => {
  it.effect("settles 1,536 concurrent calls out of order with interleaved rejections and throws, each typed", () => Effect.gen(function*() {
    const random = seeded(1536)
    const outcomes = ["succeed", "reject", "throw"] as const


    type Operation = "queryState" | "setDetectionInterval" | "getAutoLockDelay"

    const operations: ReadonlyArray<Operation> = ["queryState", "setDetectionInterval", "getAutoLockDelay"]

    const plans = Array.from({ length: 1536 }, (_, index) => ({
      index,
      operation: operations[random.int(3)] ?? "queryState",
      outcome: outcomes[random.int(3)] ?? "succeed",
      cause: new Error(`call ${index}`),
      state: random.state()
    }))

    const pending: Array<{ readonly settle: () => void }> = []
    const expectedPending = plans.filter((plan) => plan.operation !== "setDetectionInterval" && plan.outcome !== "throw").length
    const allStarted = Deferred.makeUnsafe<void>()
    const byArgument = new Map(plans.map((plan) => [plan.index + minimumInterval, plan]))
    const applied: Array<number> = []

    const deferredOutcome = <A>(plan: typeof plans[number], value: A): Promise<A> => {
      if (plan.outcome === "throw") throw plan.cause

      return new Promise<A>((resolve, reject) => {
        pending.push({ settle: () => plan.outcome === "succeed" ? resolve(value) : reject(plan.cause) })

        if (pending.length === expectedPending) Deferred.doneUnsafe(allStarted, Effect.void)
      })
    }

    const api: ChromeIdleApi = {
      queryState: (seconds) => {
        const plan = byArgument.get(seconds)

        if (plan === undefined) throw new Error(`unplanned queryState(${seconds})`)

        return deferredOutcome(plan, plan.state)
      },
      setDetectionInterval: (seconds) => {
        const plan = byArgument.get(seconds)

        if (plan === undefined || plan.outcome !== "succeed") throw plan?.cause ?? new Error("unplanned")

        applied.push(seconds)
      },
      onStateChanged: TestEvent.makeEvent<[IdleState]>().api
    }

    const idle = make(api)

    const call = (plan: typeof plans[number]): Effect.Effect<IdleState | number | void, ChromeIdleError> => {
      switch (plan.operation) {
        case "queryState":
          return idle.queryState(plan.index + minimumInterval)
        case "setDetectionInterval":
          return idle.setDetectionInterval(plan.index + minimumInterval)
        case "getAutoLockDelay":
          // It takes no argument, so each plan gets its own service over the shared calls.
          return make({ ...api, getAutoLockDelay: () => deferredOutcome(plan, plan.index) }).getAutoLockDelay
      }
    }

    const results = yield* Effect.forkChild(Effect.forEach(plans, (plan) => Effect.exit(call(plan)), { concurrency: "unbounded" }))

    if (expectedPending > 0) yield* Deferred.await(allStarted)

    expect(pending.length).toBe(expectedPending)

    for (const { settle } of shuffled(pending, random)) settle()

    const exits = yield* Fiber.join(results)
    let failures = 0

    for (const plan of plans) {
      const exit = exits[plan.index]

      if (exit === undefined) throw new Error(`missing result ${plan.index}`)

      // setDetectionInterval is synchronous, so a planned rejection reaches it as a throw.
      if (plan.outcome === "succeed") {
        expect(Exit.isSuccess(exit)).toBe(true)

        if (Exit.isSuccess(exit) && plan.operation === "queryState") expect(exit.value).toBe(plan.state)

        if (Exit.isSuccess(exit) && plan.operation === "getAutoLockDelay") expect(exit.value).toBe(plan.index)
      } else {
        failures++
        const error = yield* Effect.flip(exit)
        expect(error).toBeInstanceOf(ChromeIdleError)
        expect(error.operation).toBe(plan.operation)
        expect(error.cause).toBe(plan.cause)
      }
    }

    expect(failures).toBeGreaterThan(256)
    expect(applied).toEqual(plans
      .filter((plan) => plan.operation === "setDetectionInterval" && plan.outcome === "succeed")
      .map((plan) => plan.index + minimumInterval))
  }))

  it.effect("interrupts 1,024 pending calls, then lets Chrome settle them without effect or unhandled rejections", () => Effect.gen(function*() {
    const settlers: Array<() => void> = []
    const started = Deferred.makeUnsafe<void>()
    const natives: Array<Promise<unknown>> = []
    let calls = 0

    const pendingCall = <A>(value: A): Promise<A> => {
      calls++

      const native = new Promise<A>((resolve, reject) => {
        const index = settlers.length
        settlers.push(() => index % 2 === 0 ? resolve(value) : reject(new Error(`late ${index}`)))
      })

      natives.push(native)

      if (calls === 1024) Deferred.doneUnsafe(started, Effect.void)

      return native
    }

    const idle = make({
      queryState: () => pendingCall<IdleState>("idle"),
      setDetectionInterval: () => {},
      getAutoLockDelay: () => pendingCall(0),
      onStateChanged: TestEvent.makeEvent<[IdleState]>().api
    })

    const fibers = yield* Effect.forEach(Array.from({ length: 1024 }, (_, index) => index), (index) =>
      Effect.forkChild(index % 2 === 0 ? idle.queryState(60) : idle.getAutoLockDelay))

    yield* Deferred.await(started)
    yield* Fiber.interruptAll(fibers)
    const exits = yield* Fiber.awaitAll(fibers)
    expect(exits.every(Exit.hasInterrupts)).toBe(true)

    for (const settle of settlers) settle()

    const settled = yield* Effect.promise(() => Promise.allSettled(natives))
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(512)
    expect(calls).toBe(1024)
  }))

  it.effect("applies 1,024 racing setDetectionInterval calls in order, the last one winning", () => Effect.gen(function*() {
    const fixture = makeIdle({ idleTime: 200 })
    const applied: Array<number> = []

    const idle = make({
      ...fixture.api,
      setDetectionInterval: (seconds) => {
        fixture.api.setDetectionInterval(seconds)
        applied.push(seconds)
      }
    })

    const random = seeded(1024)
    const intervals = Array.from({ length: 1024 }, () => minimumInterval + random.int(400))
    const observed: Array<IdleState> = []
    fixture.api.onStateChanged.addListener((state) => { observed.push(state) })
    yield* Effect.forEach(intervals, (seconds) => Effect.andThen(Effect.yieldNow, idle.setDetectionInterval(seconds)), { concurrency: "unbounded", discard: true })
    expect(applied).toHaveLength(1024)
    expect([...applied].sort((left, right) => left - right)).toEqual([...intervals].sort((left, right) => left - right))
    const last = applied.at(-1) ?? 0
    expect(fixture.controls.detectionInterval).toBe(last)
    expect(fixture.controls.state).toBe(200 >= last ? "idle" : "active")
    // Every reported change is a real change: no two consecutive events repeat a state.
    expect(observed.every((state, index) => index === 0 || observed[index - 1] !== state)).toBe(true)
  }))
})

describe("ChromeIdle stress: fixture and layers", () => {
  it.effect("matches a reference model over a 20,000-step seeded walk", () => Effect.gen(function*() {
    const random = seeded(20000)
    const fixture = makeIdle()
    const idle = make(fixture.api)
    const recorded: Array<IdleState> = []
    fixture.api.onStateChanged.addListener((state) => { recorded.push(state) })
    const tail = yield* Effect.forkChild(Stream.runCollect(idle.onStateChanged))
    yield* Effect.promise(() => fixture.controls.onStateChanged.waitForListener())
    const model: IdleModel = { idleTime: 0, locked: false, interval: 60, reported: "active" }
    const expected: Array<IdleState> = []
    const stateAt = (threshold: number): IdleState => model.locked ? "locked" : model.idleTime >= threshold ? "idle" : "active"

    const settle = () => {
      const next = stateAt(model.interval)

      if (next !== model.reported) {
        model.reported = next
        expected.push(next)
      }
    }

    for (let step = 0; step < 20000; step++) {
      switch (random.int(7)) {
        case 0: {
          const seconds = random.int(120)
          fixture.controls.elapse(seconds)
          model.idleTime += seconds
          break
        }

        case 1:
          fixture.controls.input()
          model.idleTime = 0
          break
        case 2:
          fixture.controls.lock()
          model.locked = true
          break
        case 3:
          fixture.controls.unlock()
          model.locked = false
          model.idleTime = 0
          break
        case 4: {
          const seconds = random.int(20000)
          const exit = yield* Effect.exit(idle.setDetectionInterval(seconds))

          if (seconds < minimumInterval) {
            expect(Exit.isFailure(exit)).toBe(true)
          } else {
            expect(Exit.isSuccess(exit)).toBe(true)
            model.interval = Math.min(seconds, maximumInterval)
          }

          break
        }

        case 5: {
          const threshold = minimumInterval + random.int(300)
          expect(yield* idle.queryState(threshold)).toBe(stateAt(threshold))
          break
        }

        default: {
          // Whole detection intervals, so thresholds are hit exactly.
          const seconds = random.int(4) * 30
          fixture.controls.elapse(seconds)
          model.idleTime += seconds
        }
      }

      settle()
      expect(fixture.controls.state).toBe(model.reported)
    }

    expect(recorded).toEqual(expected)
    expect(expected.length).toBeGreaterThan(1000)
    yield* Fiber.interrupt(tail)
    expect(fixture.controls.onStateChanged.listenerCount).toBe(1)
  }))

  it.effect("samples only while a listener exists over a 20,000-step seeded walk of subscribe/unsubscribe gaps", () => Effect.gen(function*() {
    const random = seeded(4242)
    const fixture = makeIdle({ idleTime: 30, locked: true })
    const idle = make(fixture.api)
    const recorded: Array<IdleState> = []
    const listener = (state: IdleState) => { recorded.push(state) }

    const model: IdleModel = { idleTime: 30, locked: true, interval: 60, reported: "active" }
    const expected: Array<IdleState> = []
    let listening = false
    let staleOpenings = 0
    let fresh = false
    const stateAt = (threshold: number): IdleState => model.locked ? "locked" : model.idleTime >= threshold ? "idle" : "active"

    /** Chrome's sample: only while listening, against the last sampled state. */
    const sample = () => {
      if (!listening) return
      const next = stateAt(model.interval)

      if (next !== model.reported) {
        if (fresh) staleOpenings++
        model.reported = next
        expected.push(next)
      }

      fresh = false
    }

    for (let step = 0; step < 20000; step++) {
      switch (random.int(8)) {
        case 0: {
          const seconds = random.int(4) * 30
          fixture.controls.elapse(seconds)
          model.idleTime += seconds
          sample()
          break
        }

        case 1:
          fixture.controls.input()
          model.idleTime = 0
          sample()
          break
        case 2:
          fixture.controls.lock()
          model.locked = true
          sample()
          break
        case 3:
          fixture.controls.unlock()
          model.locked = false
          model.idleTime = 0
          sample()
          break
        case 4: {
          const seconds = minimumInterval + random.int(120)
          yield* idle.setDetectionInterval(seconds)
          model.interval = seconds
          sample()
          break
        }

        case 5: {
          const threshold = minimumInterval + random.int(300)
          expect(yield* idle.queryState(threshold)).toBe(stateAt(threshold))
          break
        }

        case 6:
          fixture.controls.poll()
          sample()
          break
        default:
          // Adding a listener never samples by itself; removing one freezes the last sample.
          if (listening) {
            fixture.api.onStateChanged.removeListener(listener)
          } else {
            fixture.api.onStateChanged.addListener(listener)
            fresh = true
          }

          listening = !listening
      }

      expect(fixture.controls.state).toBe(model.reported)
    }

    expect(recorded).toEqual(expected)
    expect(expected.length).toBeGreaterThan(1000)
    // Many subscriptions opened with a change that happened while nobody listened.
    expect(staleOpenings).toBeGreaterThan(100)
  }))

  it.effect("keeps 512 concurrent fixtures and their subscriptions isolated", () => Effect.gen(function*() {
    const fixtures = Array.from({ length: 512 }, (_, index) => makeIdle({ idleTime: index }))

    // Even fixtures lock then unlock; odd ones go idle then get input. Chrome had sampled
    // none of them, so even those starting idle report it against the initial "active".
    const expectedFor = (index: number): ReadonlyArray<IdleState> => index % 2 === 0
      ? ["locked", "active"]
      : ["idle", "active"]

    const results = yield* Effect.forEach(fixtures, (fixture, index) => Effect.gen(function*() {
      const idle = make(fixture.api)
      const changes = yield* Effect.forkChild(Stream.runCollect(Stream.take(idle.onStateChanged, expectedFor(index).length)))
      yield* Effect.promise(() => fixture.controls.onStateChanged.waitForListener())

      if (index % 2 === 0) {
        fixture.controls.lock()
        fixture.controls.unlock()
      } else {
        fixture.controls.elapse(maximumInterval)
        fixture.controls.input()
      }

      return { changes: yield* Fiber.join(changes), state: yield* idle.queryState(60) }
    }), { concurrency: "unbounded" })

    for (const [index, result] of results.entries()) {
      expect(result.changes).toEqual(expectedFor(index))
      expect(result.state).toBe("active")
    }

    for (const fixture of fixtures) expect(fixture.controls.onStateChanged.listenerCount).toBe(0)
  }))

  it.effect("builds or refuses 512 live layers concurrently", () => Effect.gen(function*() {
    const fixture = makeIdle({ locked: true })
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", { idle: fixture.api })), () => Effect.sync(() => vi.unstubAllGlobals()))
    const query = Effect.flatMap(ChromeIdle, (service: ChromeIdleService) => service.queryState(60))
    const built = yield* Effect.forEach(Array.from({ length: 512 }), () => query.pipe(Effect.provide(layerLive)), { concurrency: "unbounded" })
    expect(built.every((state) => state === "locked")).toBe(true)
    vi.stubGlobal("chrome", {})
    const refused = yield* Effect.forEach(Array.from({ length: 512 }), () => Effect.flip(Layer.build(layerLive)), { concurrency: "unbounded" })
    expect(refused.every((error) => error instanceof ChromeIdleError && error.operation === "initialize")).toBe(true)
  }))
})
