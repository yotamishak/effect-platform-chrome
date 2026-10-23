// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Deferred, Effect, Exit, Fiber, Option, Result, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChromeTabGroupsError, make } from "../../src/ChromeTabGroups.js"
import type { ChromeTabGroupsApi, ChromeTabGroupsService, TabGroup } from "../../src/ChromeTabGroups.js"
import type { EventSource } from "../../src/internal/event.js"
import { makeEvent } from "../../src/testing/Event.js"
import { makeTabGroups, matchesGroupTitle } from "../../src/testing/TabGroups.js"

const eventNames = ["onCreated", "onUpdated", "onRemoved", "onMoved"] as const

type EventName = typeof eventNames[number]

type Listener = (group: TabGroup) => void

/** A small deterministic generator (mulberry32), so every run churns the same way. */
const seeded = (seed: number) => {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <A>(random: () => number, values: ReadonlyArray<A>): A => {
  const value = values[Math.floor(random() * values.length)]

  if (value === undefined) throw new Error("pick needs a non-empty list")

  return value
}

const range = (from: number, to: number): Array<number> => Array.from({ length: to - from }, (_, index) => from + index)

const groupOf = (id: number): TabGroup => ({ id, collapsed: false, color: "grey", shared: false, title: `g${id}`, windowId: 1 })

const ids = (groups: ReadonlyArray<TabGroup>): Array<number> => groups.map((group) => group.id)

/** An API whose events are the given sources and whose calls are never reached. */
const eventApi = (sources: Record<EventName, EventSource<[TabGroup]>>): ChromeTabGroupsApi => {
  const unused = () => Promise.reject(new Error("not called by event stress"))

  return { get: unused, query: unused, update: unused, move: unused, ...sources }
}

/** The four simulated events, shared by every subscription of a test. */
const makeEvents = () => ({
  onCreated: makeEvent<[TabGroup]>(),
  onUpdated: makeEvent<[TabGroup]>(),
  onRemoved: makeEvent<[TabGroup]>(),
  onMoved: makeEvent<[TabGroup]>()
})

/** The raw event APIs of `makeEvents`, keyed by event name. */
const sourcesOf = (events: ReturnType<typeof makeEvents>): Record<EventName, EventSource<[TabGroup]>> => ({
  onCreated: events.onCreated.api,
  onUpdated: events.onUpdated.api,
  onRemoved: events.onRemoved.api,
  onMoved: events.onMoved.api
})

describe("ChromeTabGroups event stress", () => {
  it.effect.each(eventNames)("keeps exactly the newest 64 of a 4,096-event %s burst during registration", (name) =>
    Effect.gen(function*() {
      const events = makeEvents()
      let removals = 0

      const source: EventSource<[TabGroup]> = {
        addListener: (listener) => {
          events[name].api.addListener(listener)

          for (let index = 0; index < 4096; index++) events[name].controls.emit(groupOf(index))
        },
        removeListener: (listener) => {
          removals++
          events[name].api.removeListener(listener)
        }
      }

      const values = yield* Stream.runCollect(Stream.take(make(eventApi({ ...sourcesOf(events), [name]: source }))[name], 64))
      expect(ids(values)).toEqual(range(4032, 4096))
      expect(events[name].controls.listenerCount).toBe(0)
      expect(removals).toBe(1)
    }))

  it.effect.each(eventNames)("keeps the newest 64 of a %s burst that arrives while the consumer is stalled", (name) =>
    Effect.gen(function*() {
      const events = makeEvents()
      const stalled = Deferred.makeUnsafe<void>()
      const release = Deferred.makeUnsafe<void>()

      const stream = Stream.mapEffect(make(eventApi(sourcesOf(events)))[name], (group) => group.id === -1
        ? Deferred.succeed(stalled, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(group))
        : Effect.succeed(group))

      const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(stream, 65)))
      yield* Effect.promise(() => events[name].controls.waitForListener())
      events[name].controls.emit(groupOf(-1))
      yield* Deferred.await(stalled)

      for (let index = 0; index < 4096; index++) events[name].controls.emit(groupOf(index))

      yield* Deferred.succeed(release, undefined)
      expect(ids(yield* Fiber.join(fiber))).toEqual([-1, ...range(4032, 4096)])
      expect(events[name].controls.listenerCount).toBe(0)
    }))

  it.effect("churns 512 subscriptions through every stage and ends with zero listeners", () => Effect.gen(function*() {
    const random = seeded(0x7AB6)
    const events = makeEvents()

    const stages = [
      "immediate", "failBeforeAdd", "failAfterAdd", "lookupFails", "completes", "stalled", "waiting", "consumerFails"
    ] as const

    type Stage = typeof stages[number]

    interface Subscription {
      readonly name: EventName
      readonly stage: Stage
      readonly added: Deferred.Deferred<void>
      readonly reached: Deferred.Deferred<void>
      readonly cause: Error
      adds: number
      removes: number
    }

    const subscriptions: Array<Subscription> = Array.from({ length: 512 }, (_, index) => ({
      // Every stage and event appears at least once; the rest is seeded.
      name: index < 32 ? eventNames[index % 4] ?? "onCreated" : pick(random, eventNames),
      stage: index < 32 ? stages[index % stages.length] ?? "waiting" : pick(random, stages),
      added: Deferred.makeUnsafe<void>(),
      reached: Deferred.makeUnsafe<void>(),
      cause: new Error(`subscription ${index} failed`),
      adds: 0,
      removes: 0
    }))

    const failure = new Error("consumer failed")
    const release = Deferred.makeUnsafe<void>()

    const run = (subscription: Subscription): Effect.Effect<void, ChromeTabGroupsError | Error> => {
      const real = events[subscription.name]

      const source: EventSource<[TabGroup]> = {
        addListener: (listener) => {
          if (subscription.stage === "failBeforeAdd") throw subscription.cause

          real.api.addListener(listener)
          subscription.adds++
          Deferred.doneUnsafe(subscription.added, Effect.void)

          if (subscription.stage === "failAfterAdd") throw subscription.cause
        },
        removeListener: (listener) => {
          subscription.removes++
          real.api.removeListener(listener)
        }
      }

      const api = eventApi({ ...sourcesOf(events), [subscription.name]: source })

      if (subscription.stage === "lookupFails") {
        Object.defineProperty(api, subscription.name, { get: () => { throw subscription.cause } })
      }

      const stream = make(api)[subscription.name]

      switch (subscription.stage) {
        case "completes":
          return Effect.asVoid(Stream.runCollect(Stream.take(stream, 1)))
        case "stalled":
          return Stream.runDrain(Stream.mapEffect(stream, () =>
            Deferred.succeed(subscription.reached, undefined).pipe(Effect.andThen(Deferred.await(release)))))
        case "consumerFails":
          return Stream.runDrain(Stream.mapEffect(stream, () => Effect.fail(failure)))
        default:
          return Stream.runDrain(stream)
      }
    }

    const fibers = yield* Effect.forEach(subscriptions, (subscription) => Effect.forkChild(Effect.result(run(subscription))))

    for (const [index, fiber] of fibers.entries()) {
      if (subscriptions[index]?.stage === "immediate") yield* Fiber.interrupt(fiber)
    }

    const listening = subscriptions.filter((subscription) =>
      ["completes", "stalled", "waiting", "consumerFails"].includes(subscription.stage))

    yield* Effect.forEach(listening, (subscription) => Deferred.await(subscription.added))

    for (const name of eventNames) {
      expect(events[name].controls.listenerCount).toBe(listening.filter((subscription) => subscription.name === name).length)
      events[name].controls.emit(groupOf(eventNames.indexOf(name)))
    }

    yield* Effect.forEach(
      subscriptions.filter((subscription) => subscription.stage === "stalled"),
      (subscription) => Deferred.await(subscription.reached)
    )

    for (const [index, fiber] of fibers.entries()) {
      const subscription = subscriptions[index]

      if (subscription === undefined) throw new Error(`missing subscription ${index}`)

      if (subscription.stage === "stalled" || subscription.stage === "waiting") yield* Fiber.interrupt(fiber)

      const exit = yield* Fiber.await(fiber)

      if (subscription.stage === "immediate" || subscription.stage === "stalled" || subscription.stage === "waiting") {
        expect(Exit.hasInterrupts(exit)).toBe(true)
      } else {
        expect(Exit.isSuccess(exit)).toBe(true)
        const result = Exit.isSuccess(exit) ? exit.value : Result.fail(new Error("interrupted"))

        if (subscription.stage === "completes") expect(Result.isSuccess(result)).toBe(true)
        else if (subscription.stage === "consumerFails") expect(result).toEqual(Result.fail(failure))
        else {
          expect(Result.isFailure(result)).toBe(true)
          const error = Result.isFailure(result) ? result.failure : undefined
          expect(error).toBeInstanceOf(ChromeTabGroupsError)
          expect(error).toMatchObject({ operation: subscription.name, cause: subscription.cause })
        }
      }

      // Cleanup is installed before registration, so a registration that threw before adding
      // still removes its (never added) listener, which Chrome ignores.
      expect(subscription.removes).toBe(subscription.stage === "failBeforeAdd" ? 1 : subscription.adds)
    }

    for (const name of eventNames) expect(events[name].controls.listenerCount).toBe(0)

    expect(subscriptions.filter((subscription) => subscription.stage !== "immediate")
      .every((subscription) => subscription.adds === (["failBeforeAdd", "lookupFails"].includes(subscription.stage) ? 0 : 1)))
      .toBe(true)
    expect(new Set(subscriptions.map((subscription) => subscription.stage)).size).toBe(stages.length)
  }))

  it.effect("ignores a listener Chrome calls after its subscription ended", () => Effect.gen(function*() {
    const events = makeEvents()
    const captured: Array<Listener> = []

    const source: EventSource<[TabGroup]> = {
      addListener: (listener) => {
        captured.push(listener)
        events.onUpdated.api.addListener(listener)
      },
      removeListener: (listener) => events.onUpdated.api.removeListener(listener)
    }

    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(make(eventApi({ ...sourcesOf(events), onUpdated: source })).onUpdated, 1)))
    yield* Effect.promise(() => events.onUpdated.controls.waitForListener())
    events.onUpdated.controls.emit(groupOf(1))
    expect(ids(yield* Fiber.join(fiber))).toEqual([1])

    for (let index = 0; index < 4096; index++) captured[0]?.(groupOf(index))

    expect(events.onUpdated.controls.listenerCount).toBe(0)
  }))

  it.effect.each(eventNames)("silences a %s listener whose removal throws, for 256 subscriptions", (name) => Effect.gen(function*() {
    const events = makeEvents()
    const cause = new Error("Extension context invalidated.")
    const captured: Array<Listener> = []
    const registered = Deferred.makeUnsafe<void>()

    const source: EventSource<[TabGroup]> = {
      addListener: (listener) => {
        captured.push(listener)
        events[name].api.addListener(listener)

        if (captured.length === 256) Deferred.doneUnsafe(registered, Effect.void)
      },
      removeListener: () => { throw cause }
    }

    const stream = make(eventApi({ ...sourcesOf(events), [name]: source }))[name]
    const fibers = yield* Effect.forEach(range(0, 256), () => Effect.forkChild(Stream.runCollect(Stream.take(stream, 1))))

    yield* Deferred.await(registered)
    events[name].controls.emit(groupOf(7))

    for (const fiber of fibers) {
      const exit = yield* Fiber.await(fiber)
      // The failed removal is a defect of the release, not a typed error of the subscription.
      expect(Exit.isFailure(exit) && !Exit.hasInterrupts(exit)).toBe(true)
      expect(String(exit)).toContain("Extension context invalidated.")
    }

    // Chrome still holds every listener, but none of them delivers anything any more.
    expect(events[name].controls.listenerCount).toBe(256)
    expect(events[name].controls.emit(groupOf(8))).toEqual([])
    expect(captured).toHaveLength(256)
  }))
})

describe("ChromeTabGroups call stress", () => {
  /**
   * Native calls that stay pending until the test settles them; every 7th arrival throws
   * synchronously instead, as Chrome's argument validation does.
   */
  const pendingApi = (total: number) => {
    interface Pending {
      readonly operation: string
      readonly resolve: () => void
      readonly reject: (cause: Error) => void
    }

    const pending: Array<Pending> = []
    const thrown = new Map<Error, string>()
    const arrived = Deferred.makeUnsafe<void>()
    let arrivals = 0

    /** Batch indices whose call threw synchronously. */
    const thrownCalls = new Set<number>()

    const call = <A>(operation: string, key: number, value: () => A): Promise<A> => {
      const arrival = arrivals++

      try {
        if (arrival % 7 === 0) {
          const cause = new Error(`${operation} ${arrival} threw`)
          thrown.set(cause, operation)
          thrownCalls.add(key)

          throw cause
        }

        return new Promise<A>((resolve, reject) => {
          pending.push({ operation, resolve: () => resolve(value()), reject })
        })
      } finally {
        if (arrivals === total) Deferred.doneUnsafe(arrived, Effect.void)
      }
    }

    const api: ChromeTabGroupsApi = {
      get: (groupId) => call("get", groupId, () => groupOf(groupId)),
      query: (queryInfo) => call("query", queryInfo.windowId ?? -1, () => [{ ...groupOf(0), windowId: queryInfo.windowId ?? 0 }]),
      update: (groupId, properties) =>
        call("update", groupId, () => groupId % 2 === 0 ? undefined : { ...groupOf(groupId), ...properties }),
      move: (groupId, properties) =>
        call("move", groupId, () => groupId % 2 === 0 ? undefined : { ...groupOf(groupId), windowId: properties.windowId ?? 1 }),
      ...sourcesOf(makeEvents())
    }

    /** Settles every pending call newest first, rejecting every other one. */
    const settleInterleaved = (): Map<Error, string> => {
      const rejected = new Map<Error, string>()

      for (let index = pending.length - 1; index >= 0; index--) {
        const call = pending[index]

        if (call === undefined) continue

        if (index % 2 === 0) {
          const cause = new Error(`${call.operation} ${index} rejected`)
          rejected.set(cause, call.operation)
          call.reject(cause)
        } else {
          call.resolve()
        }
      }

      return rejected
    }

    return { api, pending, thrown, thrownCalls, arrived: Deferred.await(arrived), settleInterleaved }
  }

  /** Call `index` of a mixed batch, with what it must yield when Chrome resolves it. */
  interface MixedCall {
    readonly operation: string
    readonly effect: Effect.Effect<unknown, ChromeTabGroupsError>
    readonly expected: unknown
  }

  const mixedCall = (groups: ChromeTabGroupsService, index: number): MixedCall => {
    switch (index % 4) {
      case 0:
        return { operation: "get", effect: groups.get(index), expected: groupOf(index) }
      case 1:
        return { operation: "query", effect: groups.query({ windowId: index }), expected: [{ ...groupOf(0), windowId: index }] }
      case 2:
        return { operation: "update", effect: groups.update(index, { title: `t${index}` }), expected: Option.none() }
      default:
        return {
          operation: "move",
          effect: groups.move(index, { index: -1, windowId: index }),
          expected: Option.some({ ...groupOf(index), windowId: index })
        }
    }
  }

  it.effect("types 2,048 concurrent calls with interleaved rejections, throws and results", () => Effect.gen(function*() {
    const total = 2048
    const native = pendingApi(total)
    const groups = make(native.api)
    const batch = range(0, total).map((index) => mixedCall(groups, index))

    const fiber = yield* Effect.forkChild(Effect.forEach(batch, ({ effect }) => Effect.result(effect), { concurrency: "unbounded" }))

    yield* native.arrived
    expect(native.pending).toHaveLength(total - Math.ceil(total / 7))
    const rejected = native.settleInterleaved()
    const results = yield* Fiber.join(fiber)
    const seen = new Set<unknown>()

    for (const [index, result] of results.entries()) {
      const call = batch[index]

      if (call === undefined) throw new Error(`missing call ${index}`)

      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(ChromeTabGroupsError)
        expect(result.failure.operation).toBe(call.operation)
        const cause = result.failure.cause
        expect(cause).toBeInstanceOf(Error)

        if (cause instanceof Error) expect(native.thrown.get(cause) ?? rejected.get(cause)).toBe(call.operation)

        seen.add(cause)
      } else {
        expect(result.success).toEqual(call.expected)
      }
    }

    expect(seen.size).toBe(native.thrown.size + rejected.size)
    expect(results.filter(Result.isFailure)).toHaveLength(native.thrown.size + rejected.size)
    expect(native.thrown.size).toBe(Math.ceil(total / 7))
  }))

  it.effect("interrupts 512 of 1,024 pending calls while the rest complete with their own results", () => Effect.gen(function*() {
    const total = 1024
    const native = pendingApi(total)
    const groups = make(native.api)
    const batch = range(0, total).map((index) => mixedCall(groups, index))
    const fibers = yield* Effect.forEach(batch, ({ effect }) => Effect.forkChild(Effect.result(effect)))
    yield* native.arrived

    const interrupted = new Set(range(0, total).filter((index) => index % 2 === 1))

    yield* Effect.forEach(fibers.filter((_, index) => interrupted.has(index)), Fiber.interrupt, { concurrency: "unbounded" })

    const rejected = native.settleInterleaved()
    let cancelled = 0

    for (const [index, fiber] of fibers.entries()) {
      const exit = yield* Fiber.await(fiber)
      const call = batch[index]

      if (interrupted.has(index)) {
        // A call that threw synchronously finished before it could be interrupted.
        const threw = Exit.isSuccess(exit) && Result.isFailure(exit.value) && exit.value.failure.cause instanceof Error
          && native.thrown.has(exit.value.failure.cause)

        expect(Exit.hasInterrupts(exit) || threw).toBe(true)
        cancelled += Exit.hasInterrupts(exit) ? 1 : 0
        continue
      }

      expect(Exit.isSuccess(exit)).toBe(true)

      if (!Exit.isSuccess(exit) || call === undefined) continue

      const result = exit.value

      if (Result.isFailure(result)) {
        expect(result.failure.operation).toBe(call.operation)
        const cause = result.failure.cause
        expect(cause instanceof Error && (native.thrown.get(cause) ?? rejected.get(cause))).toBe(call.operation)
      } else {
        expect(result.success).toEqual(call.expected)
      }
    }

    expect(cancelled).toBe(Array.from(interrupted).filter((index) => !native.thrownCalls.has(index)).length)
  }))
})

describe("ChromeTabGroups fixture stress", () => {
  it.effect("keeps the newest 64 of 4,096 fixture updates delivered to a stalled subscriber", () => Effect.gen(function*() {
    const fixture = makeTabGroups()
    const groups = make(fixture.api)
    const target = fixture.controls.create()
    const stalled = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()

    const stream = Stream.mapEffect(groups.onUpdated, (group) => group.title === "first"
      ? Deferred.succeed(stalled, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(group))
      : Effect.succeed(group))

    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(stream, 65)))
    yield* Effect.promise(() => fixture.controls.onUpdated.waitForListener())
    yield* groups.update(target.id, { title: "first" })
    yield* Deferred.await(stalled)

    for (let index = 0; index < 4096; index++) yield* groups.update(target.id, { title: `t${index}` })

    yield* Deferred.succeed(release, undefined)
    const titles = (yield* Fiber.join(fiber)).map((group) => group.title)
    expect(titles).toEqual(["first", ...range(4032, 4096).map((index) => `t${index}`)])
    expect(fixture.controls.onUpdated.listenerCount).toBe(0)
    expect(fixture.controls.group(target.id)?.title).toBe("t4095")
  }))

  it.effect("serialises 1,024 concurrent updates of one group in invocation order", () => Effect.gen(function*() {
    const invoked: Array<string> = []
    const inner = makeTabGroups()

    const fixture = makeTabGroups({
      update: (groupId, properties) => {
        invoked.push(properties.title ?? "")

        return inner.api.update(groupId, properties)
      },
      onUpdated: inner.api.onUpdated
    })

    const groups = make(fixture.api)
    const target = inner.controls.create()
    const delivered: Array<string> = []
    inner.api.onUpdated.addListener((group) => { delivered.push(group.title ?? "") })

    const results = yield* Effect.forEach(range(0, 1024), (index) => groups.update(target.id, { title: `t${index}` }), {
      concurrency: "unbounded"
    })

    expect(results.map((result) => Option.map(result, (group) => group.title))).toEqual(range(0, 1024).map((index) => Option.some(`t${index}`)))
    expect(invoked).toHaveLength(1024)
    expect(new Set(invoked).size).toBe(1024)
    expect(delivered).toEqual(invoked)
    expect(inner.controls.group(target.id)?.title).toBe(invoked.at(-1))
  }))

  it.effect("matches a sequential replay after 1,024 concurrent seeded moves across four windows", () => Effect.gen(function*() {
    const random = seeded(0x51DE)

    const setup = () => {
      const fixture = makeTabGroups()
      const windows = [1, fixture.controls.openWindow({ ungroupedTabs: 3 }), fixture.controls.openWindow({ pinnedTabs: 2 }), fixture.controls.openWindow()]
      const log: Array<string> = []

      for (const name of eventNames) fixture.api[name].addListener((group) => { log.push(`${name}:${group.id}@${group.windowId}`) })

      const created = range(0, 128).map((index) => fixture.controls.create({
        windowId: windows[index % 4] ?? 1,
        tabCount: 1 + (index % 3)
      }))

      log.length = 0

      return { fixture, windows, log, created }
    }

    const live = setup()
    const replay = setup()
    const tabs = new Map(live.created.map((group, index) => [group.id, 1 + (index % 3)]))

    const moves = range(0, 1024).map(() => {
      const moveProperties: chrome.tabGroups.MoveProperties = { index: Math.floor(random() * 40) - 1 }
      const roll = random()

      if (roll < 0.4) moveProperties.windowId = pick(random, live.windows)
      else if (roll < 0.45) moveProperties.windowId = -2

      return { groupId: pick(random, live.created).id, moveProperties }
    })

    const order: Array<number> = []

    const traced = make({
      ...live.fixture.api,
      move: (groupId, moveProperties) => {
        order.push(moves.findIndex((move) => move.moveProperties === moveProperties))

        return live.fixture.api.move(groupId, moveProperties)
      }
    })

    const results = yield* Effect.forEach(moves, ({ groupId, moveProperties }) => Effect.result(traced.move(groupId, moveProperties)), {
      concurrency: "unbounded"
    })

    expect([...order].sort((left, right) => left - right)).toEqual(range(0, 1024))

    const replayed = yield* Effect.forEach(order, (index) => {
      const move = moves[index]

      return move === undefined ? Effect.die(new Error(`missing move ${index}`)) : Effect.result(make(replay.fixture.api).move(move.groupId, move.moveProperties))
    })

    const failures = results.filter(Result.isFailure)
    expect(failures.length).toBeGreaterThan(0)
    expect(failures.length).toBeLessThan(1024)

    for (const failure of failures) {
      expect(failure.failure.operation).toBe("move")
      expect(String(failure.failure.cause)).toMatch(/middle of (another group|pinned tabs)/)
    }

    expect(order.map((index) => Result.isFailure(results[index] ?? Result.succeed(Option.none())))).toEqual(replayed.map(Result.isFailure))
    expect(live.log).toEqual(replay.log)

    for (const windowId of live.windows) {
      const strip = live.fixture.controls.strip(windowId)
      expect(strip).toEqual(replay.fixture.controls.strip(windowId))

      const seen = new Set<number>()

      for (const [index, slot] of strip.entries()) {
        if (slot === -1 || seen.has(slot)) continue

        seen.add(slot)
        const length = tabs.get(slot) ?? 0
        expect(strip.slice(index, index + length)).toEqual(Array.from({ length }, () => slot))
        expect(strip.lastIndexOf(slot)).toBe(index + length - 1)
        expect(live.fixture.controls.group(slot)?.windowId).toBe(windowId)
      }
    }

    const all = live.windows.flatMap((windowId) => live.fixture.controls.strip(windowId))
    expect(all.filter((slot) => slot !== -1)).toHaveLength(Array.from(tabs.values()).reduce((sum, count) => sum + count, 0))
    expect(all.filter((slot) => slot === -1)).toHaveLength(5)
    expect(live.log.filter((entry) => entry.startsWith("onRemoved")).length)
      .toBe(live.log.filter((entry) => entry.startsWith("onCreated")).length)
    expect(live.log.some((entry) => entry.startsWith("onMoved"))).toBe(true)
    expect(live.log.some((entry) => entry.startsWith("onRemoved"))).toBe(true)
  }))

  it.effect("queries 4,096 groups across 16 windows like a direct filter does", () => Effect.gen(function*() {
    const random = seeded(0xC0105)
    const fixture = makeTabGroups()
    const groups = make(fixture.api)
    const windows = [1, ...range(0, 15).map(() => fixture.controls.openWindow({ ungroupedTabs: 1 }))]
    const colors = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"] as const

    const created = range(0, 4096).map((index) => fixture.controls.create({
      windowId: pick(random, windows),
      title: `${pick(random, ["alpha", "beta", "gamma"])}-${index}`,
      color: pick(random, colors),
      collapsed: random() < 0.5,
      shared: random() < 0.1
    }))

    fixture.controls.focusWindow(windows[7] ?? 1)
    const order = [windows[7] ?? 1, ...windows.filter((windowId) => windowId !== windows[7])]
    const inOrder = order.flatMap((windowId) => created.filter((group) => group.windowId === windowId))
    expect(ids(yield* groups.query({}))).toEqual(ids(inOrder))
    expect(ids(yield* groups.query({ windowId: -2 }))).toEqual(ids(inOrder.filter((group) => group.windowId === windows[7])))
    expect(ids(yield* groups.query({ color: "red", collapsed: true }))).toEqual(ids(inOrder.filter((group) => group.color === "red" && group.collapsed)))
    expect(ids(yield* groups.query({ shared: true }))).toEqual(ids(inOrder.filter((group) => group.shared === true)))
    expect(ids(yield* groups.query({ title: "beta-*" }))).toEqual(ids(inOrder.filter((group) => group.title?.startsWith("beta-"))))
    expect(ids(yield* groups.query({ title: "*-40??" }))).toEqual(ids(inOrder.filter((group) => /-40\d{0,2}$/.test(group.title ?? ""))))
    expect(ids(yield* groups.query({ title: "gamma-1" }))).toEqual(ids(inOrder.filter((group) => group.title === "gamma-1")))
  }))

  it("matches long titles against many wildcards without backtracking blow-up", () => {
    const title = "a".repeat(4096)
    expect(matchesGroupTitle(title, "*a".repeat(256))).toBe(true)
    expect(matchesGroupTitle(title, `${"*a".repeat(256)}b`)).toBe(false)
    expect(matchesGroupTitle(title, `${"?".repeat(4096)}`)).toBe(true)
    expect(matchesGroupTitle(`${title}b`, `${"?".repeat(4096)}`)).toBe(false)
    expect(matchesGroupTitle(title, `${"a".repeat(4095)}\\*`)).toBe(false)
  })

  it.effect("closes a window of 1,024 groups in strip order while a subscriber keeps the newest 64", () => Effect.gen(function*() {
    const fixture = makeTabGroups()
    const windowId = fixture.controls.openWindow()
    const created = range(0, 1024).map(() => fixture.controls.create({ windowId, index: 0 }))
    const removed: Array<number> = []
    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(make(fixture.api).onRemoved, 64)))
    yield* Effect.promise(() => fixture.controls.onRemoved.waitForListener())
    fixture.api.onRemoved.addListener((group) => { removed.push(group.id) })
    expect(fixture.controls.onRemoved.listenerCount).toBe(2)
    fixture.controls.closeWindow(windowId)
    const expected = ids(created).reverse()
    expect(removed).toEqual(expected)
    expect(ids(yield* Fiber.join(fiber))).toEqual(expected.slice(-64))
    expect(fixture.controls.onRemoved.listenerCount).toBe(1)
    expect(yield* make(fixture.api).query({ windowId })).toEqual([])
  }))
})
