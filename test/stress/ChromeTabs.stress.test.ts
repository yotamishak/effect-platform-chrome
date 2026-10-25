// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Cause, Deferred, Effect, Exit, Fiber, Option, Predicate, Result, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChromeTabsError, make } from "../../src/ChromeTabs.js"
import type { ChromeTabsApi, ChromeTabsService } from "../../src/ChromeTabs.js"
import { makeTabs } from "../../src/testing/Tabs.js"
import * as TestPort from "../../src/testing/Port.js"
import { eventCases, mockApi, promiseOperations, runOperation, seeded, service, shuffle, tab, window } from "../ChromeTabs.mock.js"
import type { EventCase, PromiseOperation } from "../ChromeTabs.mock.js"

const burst = 4096

const capacity = 64

const range = (from: number, to: number): Array<number> => Array.from({ length: to - from }, (_, index) => from + index)

/** The item at `index`, which the caller guarantees exists. */
const at = <A>(items: ReadonlyArray<A>, index: number): A => {
  const item = items[index]

  if (item === undefined) throw new Error(`No item at ${index}`)

  return item
}

describe("ChromeTabs stress: event bursts", () => {
  it.effect("keeps exactly the newest 64 of 4,096 events emitted during registration, for every event", () => Effect.gen(function*() {
    const { api, tabs } = service()

    for (const event of eventCases) {
      event.probe(api).afterNextAdd((emitNth) => {
        for (let n = 0; n < burst; n++) emitNth(n)
      })
    }

    const collected = yield* Effect.forEach(eventCases, (event) => Stream.runCollect(Stream.take(event.keys(tabs), capacity)), {
      concurrency: "unbounded"
    })

    for (const [index, event] of eventCases.entries()) {
      expect(collected[index], event.name).toEqual(range(burst - capacity, burst))
      expect(event.probe(api).listenerCount(), event.name).toBe(0)
      expect(event.probe(api).balanced(), event.name).toBe(true)
    }
  }))

  it.effect("keeps the newest 64 of 4,096 events that arrive while a consumer is blocked mid-stream", () => Effect.gen(function*() {
    const { api, tabs } = service()

    const blocked = (event: EventCase) => Effect.gen(function*() {
      const probe = event.probe(api)
      const reached = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()

      const fiber = yield* Effect.forkChild(event.keys(tabs).pipe(
        Stream.tap((n) => n === 0 ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(gate))) : Effect.void),
        Stream.take(capacity + 1),
        Stream.runCollect
      ))

      yield* Effect.promise(() => probe.waitForListeners(1))
      probe.emitNth(0)
      yield* Deferred.await(reached)

      for (let n = 1; n <= burst; n++) probe.emitNth(n)

      yield* Deferred.succeed(gate, undefined)
      expect(yield* Fiber.join(fiber), event.name).toEqual([0, ...range(burst - capacity + 1, burst + 1)])
      expect(probe.listenerCount(), event.name).toBe(0)
      expect(probe.balanced(), event.name).toBe(true)
    })

    yield* Effect.forEach(eventCases, blocked, { concurrency: "unbounded", discard: true })
  }))

  it.effect("keeps the newest 64 updates of a 4,096-update fixture reload storm", () => Effect.gen(function*() {
    const fixture = makeTabs()
    const tabs = make(fixture.api)
    const seededIds = range(0, burst / 2).map(() => fixture.controls.seed({ active: false }).id ?? -1)
    const reached = yield* Deferred.make<void>()
    const gate = yield* Deferred.make<void>()

    const fiber = yield* Effect.forkChild(tabs.onUpdated.pipe(
      Stream.tap((update) => update.changeInfo.title === "first"
        ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(gate)))
        : Effect.void),
      Stream.take(capacity + 1),
      Stream.runCollect
    ))

    yield* Effect.promise(() => fixture.controls.onUpdated.waitForListener())
    fixture.controls.onUpdated.emit(-1, { title: "first" }, tab)
    yield* Deferred.await(reached)
    yield* Effect.forEach(seededIds, (tabId) => tabs.reload(tabId), { discard: true })
    yield* Deferred.succeed(gate, undefined)
    const updates = (yield* Fiber.join(fiber)).slice(1)

    expect(updates.map((update) => [update.tabId, update.changeInfo.status])).toEqual(
      seededIds.slice(-capacity / 2).flatMap((tabId) => [[tabId, "loading"], [tabId, "complete"]])
    )
    expect(fixture.controls.onUpdated.listenerCount).toBe(0)
  }))
})

type Stage = "beforeStart" | "registered" | "midStream" | "completed"

const stages: ReadonlyArray<Stage> = ["beforeStart", "registered", "midStream", "completed"]

describe("ChromeTabs stress: subscription churn", () => {
  it.effect("churns 512 concurrent subscriptions across every event, interrupted at every stage, to zero listeners", () =>
    Effect.gen(function*() {
      const random = seeded(0x7AB5)
      const { api, tabs } = service()

      const plans = range(0, 512).map((index) => ({
        event: at(eventCases, index % eventCases.length),
        // Every stage appears for every event; the rest is seeded.
        stage: at(stages, index < stages.length * eventCases.length
          ? Math.floor(index / eventCases.length)
          : Math.floor(random() * stages.length))
      }))

      const subscriptions = yield* Effect.forEach(plans, ({ event, stage }) => Effect.gen(function*() {
        const first = yield* Deferred.make<void>()

        const keys = event.keys(tabs).pipe(Stream.tap(() => stage === "midStream"
          ? Deferred.succeed(first, undefined).pipe(Effect.andThen(Effect.never))
          : Deferred.succeed(first, undefined)))

        const fiber = yield* Effect.forkChild(Stream.runCollect(stage === "completed" ? Stream.take(keys, 2) : keys))

        if (stage === "beforeStart") yield* Fiber.interrupt(fiber)

        return { event, stage, first, fiber }
      }))

      for (const event of eventCases) {
        const live = subscriptions.filter((subscription) => subscription.event === event && subscription.stage !== "beforeStart")
        yield* Effect.promise(() => event.probe(api).waitForListeners(live.length))
      }

      const inStage = (stage: Stage) => subscriptions.filter((subscription) => subscription.stage === stage)

      yield* Fiber.interruptAll(inStage("registered").map((subscription) => subscription.fiber))

      for (const event of eventCases) event.probe(api).emitNth(1)

      yield* Effect.forEach(inStage("midStream"), (subscription) => Deferred.await(subscription.first), { discard: true })

      for (const event of eventCases) event.probe(api).emitNth(2)

      for (const subscription of inStage("completed")) expect(yield* Fiber.join(subscription.fiber)).toEqual([1, 2])

      for (const event of eventCases) {
        for (let n = 3; n < 3 + capacity * 2; n++) event.probe(api).emitNth(n)
      }

      yield* Fiber.interruptAll(inStage("midStream").map((subscription) => subscription.fiber))

      for (const subscription of subscriptions) {
        const exit = yield* Fiber.await(subscription.fiber)

        if (subscription.stage === "completed") expect(Exit.isSuccess(exit)).toBe(true)
        else expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      }

      for (const event of eventCases) {
        const probe = event.probe(api)
        expect(probe.listenerCount(), event.name).toBe(0)
        expect(probe.balanced(), event.name).toBe(true)
        expect(probe.addCount(), event.name).toBeGreaterThanOrEqual(
          subscriptions.filter((subscription) => subscription.event === event && subscription.stage !== "beforeStart").length
        )
      }
    }))

  it.effect("types 256 registration failures thrown after the listener was added, leaving no listener behind", () => Effect.gen(function*() {
    const { api, tabs } = service()
    const causes = range(0, 256).map((n) => new Error(`registration ${n}`))

    const failures = yield* Effect.forEach(causes, (cause, index) => Effect.gen(function*() {
      const event = at(eventCases, index % eventCases.length)
      event.probe(api).afterNextAdd((emitNth) => {
        emitNth(index)
        throw cause
      })

      return { event, cause, error: yield* Effect.flip(Stream.runDrain(event.keys(tabs))) }
    }))

    for (const { event, cause, error } of failures) {
      expect(error).toBeInstanceOf(ChromeTabsError)
      expect(error).toMatchObject({ operation: event.name, cause })
    }

    for (const event of eventCases) {
      expect(event.probe(api).listenerCount()).toBe(0)
      expect(event.probe(api).balanced()).toBe(true)
    }
  }))

  it.effect("survives 256 releases whose removeListener re-enters Chrome or throws, delivering nothing afterwards", () =>
    Effect.gen(function*() {
      const { api, tabs } = service()
      let removals = 0

      api.onUpdated.removeListener.mockImplementation((listener) => {
        removals++
        listener(...api.onUpdated.nth(-1))

        if (removals % 4 === 0) throw new Error(`removal ${removals} failed`)

        api.onUpdated.listeners.delete(listener)
      })

      const exits = yield* Effect.forEach(range(0, 256), (n) => Effect.gen(function*() {
        const before = api.onUpdated.listeners.size
        const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(tabs.onUpdated, 1)))
        yield* Effect.promise(() => api.onUpdated.probe.waitForListeners(before + 1))
        const [newest] = Array.from(api.onUpdated.listeners).slice(-1)
        newest?.(...api.onUpdated.nth(n))
        const exit = yield* Fiber.await(fiber)
        newest?.(...api.onUpdated.nth(n + 1))

        return exit
      }))

      exits.forEach((exit, n) => {
        if ((n + 1) % 4 === 0) {
          expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
        } else {
          expect(Exit.isSuccess(exit) ? exit.value.map((update) => update.tabId) : undefined).toEqual([n])
        }
      })
      // The 64 listeners whose removal threw stay registered with Chrome but are inert.
      expect(api.onUpdated.listeners.size).toBe(64)
      api.onUpdated.emit(...api.onUpdated.nth(9999))
    }))
})

type Outcome = "success" | "reject" | "throw"

const outcomes: ReadonlyArray<Outcome> = ["success", "reject", "throw"]

type Operation = PromiseOperation | "connect"

/** A planned api: each call's outcome is decided by the key embedded in its arguments. */
const plannedApi = (plans: ReadonlyArray<{ readonly operation: Operation; readonly outcome: Outcome; readonly cause: Error }>) => {
  const pending: Array<() => void> = []
  const mismatches: Array<string> = []
  let calls = 0
  let notify = () => {}

  const allCalled = new Promise<void>((resolve) => { notify = resolve })

  const respond = <A>(operation: Operation, key: number, value: A): Promise<A> => {
    const plan = plans[key]
    calls++

    if (calls === plans.length) notify()

    if (plan?.operation !== operation) mismatches.push(`${operation} received key ${key}`)

    if (plan?.outcome === "throw") throw plan.cause

    return new Promise<A>((resolve, reject) => {
      pending.push(() => plan?.outcome === "reject" ? reject(plan.cause) : resolve(value))
    })
  }

  const first = (ids: number | ReadonlyArray<number> | undefined): number => [ids ?? -1].flat()[0] ?? -1

  const api: ChromeTabsApi = {
    ...mockApi(),
    get: (n) => respond("get", n, tab),
    getCurrent: () => respond("getCurrent", -1, tab),
    query: (info) => respond("query", info.index ?? -1, [tab]),
    create: (properties) => respond("create", properties.index ?? -1, tab),
    duplicate: (n) => respond("duplicate", n, tab),
    update: (...args: [chrome.tabs.UpdateProperties] | [number, chrome.tabs.UpdateProperties]) =>
      respond("update", args.length === 2 ? args[0] : -1, tab),
    move: (ids) => respond("move", first(ids), tab),
    reload: (...args: [] | [number] | [chrome.tabs.ReloadProperties] | [number, chrome.tabs.ReloadProperties]) =>
      respond("reload", Predicate.isNumber(args[0]) ? args[0] : -1, undefined),
    remove: (ids) => respond("remove", first(ids), undefined),
    highlight: (info) => respond("highlight", first(info.tabs), window),
    group: (options) => respond("group", first(options.tabIds), 1),
    ungroup: (ids) => respond("ungroup", first(ids), undefined),
    createSplit: ([n]) => respond("createSplit", n, 1),
    unsplit: (n) => respond("unsplit", n, undefined),
    discard: (n) => respond("discard", n ?? -1, tab),
    goBack: (n) => respond("goBack", n ?? -1, undefined),
    goForward: (n) => respond("goForward", n ?? -1, undefined),
    getZoom: (n) => respond("getZoom", n ?? -1, 1),
    setZoom: (...args: [number] | [number, number]) => respond("setZoom", args.length === 2 ? args[0] : -1, undefined),
    getZoomSettings: (n) => respond("getZoomSettings", n ?? -1, {}),
    setZoomSettings: (...args: [chrome.tabs.ZoomSettings] | [number, chrome.tabs.ZoomSettings]) =>
      respond("setZoomSettings", args.length === 2 ? args[0] : -1, undefined),
    detectLanguage: (n) => respond("detectLanguage", n ?? -1, "und"),
    sendMessage: (n) => respond("sendMessage", n, "reply"),
    captureVisibleTab: (...args: [] | [number] | [chrome.extensionTypes.ImageDetails] | [number, chrome.extensionTypes.ImageDetails]) =>
      respond("captureVisibleTab", Predicate.isNumber(args[0]) ? args[0] : -1, "data:"),
    connect: (n, connectInfo) => {
      const plan = plans[n]
      calls++

      if (calls === plans.length) notify()

      if (plan?.operation !== "connect") mismatches.push(`connect received key ${n}`)

      if (plan?.outcome !== "success") throw plan?.cause ?? new Error("unplanned")

      return TestPort.makePortPair(connectInfo?.name).left.port
    }
  }

  return { api, pending, mismatches, allCalled }
}

const runPlanned = (tabs: ChromeTabsService, operation: Operation, n: number): Effect.Effect<void, ChromeTabsError> =>
  operation === "connect" ? Effect.asVoid(tabs.connect(n, { name: `port-${n}` })) : runOperation(tabs, operation, n)

describe("ChromeTabs stress: concurrent calls", () => {
  it.effect("settles 1,536 concurrent calls with interleaved successes, rejections and throws, each typed by operation", () =>
    Effect.gen(function*() {
      const random = seeded(0xC0FFEE)
      const keyed = [...promiseOperations.filter((operation) => operation !== "getCurrent"), "connect" as const]

      const plans = range(0, 1536).map((n) => {
        const operation = keyed[n % keyed.length] ?? "get"

        const outcome = operation === "connect"
          ? (random() < 0.5 ? "success" : "throw")
          : outcomes[Math.floor(random() * outcomes.length)] ?? "success"

        return { operation, outcome, cause: new Error(`${operation} ${n} ${outcome}`) }
      })

      const planned = plannedApi(plans)
      const tabs = make(planned.api)

      const fiber = yield* Effect.forkChild(Effect.forEach(plans, ({ operation }, n) => Effect.result(runPlanned(tabs, operation, n)), {
        concurrency: "unbounded"
      }))

      yield* Effect.promise(() => planned.allCalled)

      for (const settle of shuffle(planned.pending, random)) settle()

      const results = yield* Fiber.join(fiber)
      expect(planned.mismatches).toEqual([])

      results.forEach((result, n) => {
        const plan = plans[n]

        if (plan?.outcome === "success") {
          expect(Result.isSuccess(result)).toBe(true)
        } else {
          const error = Result.isFailure(result) ? result.failure : undefined
          expect(error).toBeInstanceOf(ChromeTabsError)
          expect(error).toMatchObject({ operation: plan?.operation, cause: plan?.cause })
        }
      })
      expect(new Set(plans.map((plan) => plan.operation)).size).toBe(keyed.length)
      expect(new Set(plans.map((plan) => plan.outcome))).toEqual(new Set(outcomes))
    }))

  it.effect("settles 1,024 concurrent getCurrent runs of one Effect value, each outcome accounted for", () => Effect.gen(function*() {
    const random = seeded(42)
    const api = mockApi()
    const tabs = make(api)
    const plan = range(0, 1024).map((n) => ({ outcome: outcomes[Math.floor(random() * outcomes.length)] ?? "success", cause: new Error(`getCurrent ${n}`) }))
    const pending: Array<() => void> = []
    let calls = 0
    let notify = () => {}

    const allCalled = new Promise<void>((resolve) => { notify = resolve })

    api.getCurrent.mockImplementation(() => {
      const next = plan[calls++]

      if (calls === plan.length) notify()

      if (next?.outcome === "throw") throw next.cause

      return new Promise((resolve, reject) => {
        pending.push(() => next?.outcome === "reject" ? reject(next.cause) : resolve(calls % 2 === 0 ? tab : undefined))
      })
    })

    const fiber = yield* Effect.forkChild(Effect.forEach(plan, () => Effect.result(tabs.getCurrent), { concurrency: "unbounded" }))
    yield* Effect.promise(() => allCalled)

    for (const settle of shuffle(pending, random)) settle()

    const results = yield* Fiber.join(fiber)
    const failures = results.flatMap((result) => Result.isFailure(result) ? [result.failure] : [])

    expect(failures.every((error) => error.operation === "getCurrent")).toBe(true)
    expect(new Set(failures.map((error) => error.cause))).toEqual(new Set(plan.flatMap((each) => each.outcome === "success" ? [] : [each.cause])))
    expect(results.length - failures.length).toBe(plan.filter((each) => each.outcome === "success").length)
  }))

  it.effect("interrupts 512 in-flight calls whose Chrome promises settle afterwards, then runs fresh calls", () => Effect.gen(function*() {
    const { api, tabs } = service()
    const pending: Array<{ readonly resolve: () => void; readonly reject: () => void }> = []
    let notify = () => {}

    const allCalled = new Promise<void>((resolve) => { notify = resolve })

    api.get.mockImplementation(() => new Promise((resolve, reject) => {
      pending.push({ resolve: () => resolve(tab), reject: () => reject(new Error("late")) })

      if (pending.length === 512) notify()
    }))

    const fiber = yield* Effect.forkChild(Effect.forEach(range(0, 512), (n) => tabs.get(n), { concurrency: "unbounded" }))
    yield* Effect.promise(() => allCalled)
    yield* Fiber.interrupt(fiber)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)

    pending.forEach((settle, n) => {
      if (n % 2 === 0) settle.resolve()
      else settle.reject()
    })

    api.get.mockImplementation(async () => tab)
    expect(yield* Effect.forEach(range(0, 512), (n) => tabs.get(n), { concurrency: "unbounded" })).toHaveLength(512)
  }))

  it.effect("fails 1,024 concurrent Split View calls with the typed error where Chrome lacks the members", () => Effect.gen(function*() {
    const { createSplit: _createSplit, unsplit: _unsplit, ...older } = mockApi()
    const tabs = make(older)

    const errors = yield* Effect.forEach(range(0, 1024), (n) =>
      Effect.flip(n % 2 === 0 ? Effect.asVoid(tabs.createSplit([n, n + 1])) : tabs.unsplit(n)), { concurrency: "unbounded" })

    errors.forEach((error, n) => {
      expect(error.operation).toBe(n % 2 === 0 ? "createSplit" : "unsplit")
    })
  }))
})

/** Every window's indices follow its order, ids are unique, and at most one tab per window is active. */
const checkStrip = (all: ReadonlyArray<chrome.tabs.Tab>) => {
  const byWindow = new Map<number, Array<chrome.tabs.Tab>>()

  for (const each of all) {
    const strip = byWindow.get(each.windowId) ?? []
    strip.push(each)
    byWindow.set(each.windowId, strip)
  }

  expect(new Set(all.map((each) => each.id)).size).toBe(all.length)

  for (const strip of byWindow.values()) {
    expect(strip.map((each) => each.index)).toEqual(range(0, strip.length))
    expect(strip.filter((each) => each.active).length).toBeLessThanOrEqual(1)
  }
}

describe("ChromeTabs stress: fixture extremes", () => {
  it.effect("keeps a 10,000-tab, 16-window strip consistent through 2,000 seeded operations", () => Effect.gen(function*() {
    const random = seeded(2026)
    const fixture = makeTabs()
    const tabs = make(fixture.api)
    const live = range(0, 10_000).map(() => fixture.controls.seed({ windowId: 1 + Math.floor(random() * 16), active: random() < 0.05 }).id ?? -1)

    checkStrip(yield* tabs.query({}))
    expect(yield* tabs.query({})).toHaveLength(10_000)

    for (let step = 0; step < 2000; step++) {
      const target = at(live, Math.floor(random() * live.length))
      const choice = Math.floor(random() * 6)

      if (choice === 0) yield* tabs.move(target, { index: Math.floor(random() * 700) - 1, windowId: 1 + Math.floor(random() * 16) })
      else if (choice === 1) yield* tabs.update(target, { active: true })
      else if (choice === 2) {
        yield* tabs.remove(target)
        live.splice(live.indexOf(target), 1)
      } else if (choice === 3) live.push((yield* tabs.create({ windowId: 1 + Math.floor(random() * 16), active: random() < 0.5 })).id ?? -1)
      else if (choice === 4) live.push(Option.match(yield* tabs.duplicate(target), { onNone: () => -1, onSome: (copy) => copy.id ?? -1 }))
      else yield* tabs.highlight({ windowId: (yield* tabs.get(target)).windowId, tabs: [0] })

      if (step % 250 === 0) checkStrip(yield* tabs.query({}))
    }

    const all = yield* tabs.query({})
    checkStrip(all)
    expect(all.map((each) => each.id).sort((left, right) => (left ?? 0) - (right ?? 0))).toEqual([...live].sort((left, right) => left - right))
  }))

  it.effect("races 1,024 concurrent calls over overlapping tabs, typing every failure and keeping the strip consistent", () =>
    Effect.gen(function*() {
      const random = seeded(99)
      const fixture = makeTabs()
      const tabs = make(fixture.api)
      const ids = range(0, 64).map((n) => fixture.controls.seed({ windowId: 1 + (n % 4), active: n < 4 }).id ?? -1)
      const pick = () => ids[Math.floor(random() * ids.length)] ?? -1

      const calls: ReadonlyArray<Effect.Effect<void, ChromeTabsError>> = range(0, 1024).map(() => {
        const target = pick()

        switch (Math.floor(random() * 6)) {
          case 0: return Effect.asVoid(tabs.move(target, { index: 0, windowId: 1 + Math.floor(random() * 4) }))
          case 1: return Effect.asVoid(tabs.update(target, { active: true, pinned: random() < 0.5 }))
          case 2: return tabs.remove(target)
          case 3: return Effect.asVoid(tabs.group({ tabIds: [target, pick()] }))
          case 4: return tabs.ungroup(target)
          default: return Effect.asVoid(tabs.discard(target))
        }
      })

      const results = yield* Effect.forEach(calls, Effect.result, { concurrency: "unbounded" })
      const failures = results.flatMap((result) => Result.isFailure(result) ? [result.failure] : [])

      expect(failures.length).toBeGreaterThan(0)
      expect(results.length - failures.length).toBeGreaterThan(0)

      for (const error of failures) {
        expect(error).toBeInstanceOf(ChromeTabsError)
        expect(["move", "update", "remove", "group", "ungroup", "discard"]).toContain(error.operation)
        expect(String(error.cause)).toMatch(/No tab with id: \d+\.|Cannot discard tab with id: \d+\./)
      }

      const all = yield* tabs.query({})
      checkStrip(all)
      const groups = new Set(all.map((each) => each.groupId))
      expect(all.every((each) => each.groupId === -1 || groups.has(each.groupId))).toBe(true)
    }))
})
