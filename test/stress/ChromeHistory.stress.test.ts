// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Cause, Deferred, Effect, Exit, Fiber, Option, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeHistoryError, make } from "../../src/ChromeHistory.js"
import type { ChromeHistoryApi, HistoryItem, HistoryQuery, Range, RemovedResult, VisitItem } from "../../src/ChromeHistory.js"
import type { EventSource } from "../../src/internal/event.js"
import { makeEvent } from "../../src/testing/Event.js"
import { makeHistory } from "../../src/testing/History.js"
import type { HistoryOperation } from "../../src/testing/History.js"

/** mulberry32: a deterministic generator, so every run exercises the same interleavings. */
const seeded = (seed: number) => {
  let state = seed >>> 0

  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

/** A seeded Fisher-Yates shuffle of a copy. */
const shuffled = <A>(values: ReadonlyArray<A>, random: () => number): Array<A> => {
  const result = Array.from(values)

  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    const swap = result[index]
    const replacement = result[other]

    if (swap === undefined || replacement === undefined) continue

    result[index] = replacement
    result[other] = swap
  }

  return result
}

const itemAt = (index: number): HistoryItem => ({ id: String(index), url: `https://page-${index}.example/`, title: "", visitCount: 1, typedCount: 0, lastVisitTime: index })

const removalAt = (index: number): RemovedResult => ({ allHistory: false, urls: [`https://page-${index}.example/`] })

/**
 * Counts the listeners registered through an event and still present, and resolves
 * `waitFor(n)` once exactly `n` are. Removing a listener that never registered (cleanup
 * after a failed `addListener`) is not counted.
 */
const tracked = <Args extends ReadonlyArray<unknown>>(event: EventSource<Args>) => {
  const present = new Set<(...args: Args) => void>()
  let added = 0
  let removed = 0
  const waiting: Array<{ readonly count: number; readonly resolve: () => void }> = []

  const settle = () => {
    for (const waiter of waiting.filter((candidate) => candidate.count === present.size)) {
      waiting.splice(waiting.indexOf(waiter), 1)
      waiter.resolve()
    }
  }

  const source: EventSource<Args> = {
    addListener: (listener) => {
      event.addListener(listener)
      present.add(listener)
      added += 1
      settle()
    },
    removeListener: (listener) => {
      event.removeListener(listener)

      if (present.delete(listener)) removed += 1

      settle()
    }
  }

  return {
    source,
    get live() { return present.size },
    get added() { return added },
    get removed() { return removed },
    waitFor: (count: number): Promise<void> => count === present.size
      ? Promise.resolve()
      : new Promise((resolve) => { waiting.push({ count, resolve }) })
  }
}

interface EventCase {
  readonly operation: "onVisited" | "onVisitRemoved"
  /** Builds a service over a fresh API whose event under test is `wrap(source)`. */
  readonly setup: (wrap: <Args extends ReadonlyArray<unknown>>(event: EventSource<Args>) => EventSource<Args>) => {
    readonly stream: Stream.Stream<HistoryItem | RemovedResult, ChromeHistoryError>
    readonly emit: (index: number) => void
    readonly listenerCount: () => number
  }
  readonly expected: (index: number) => HistoryItem | RemovedResult
}

const unused = (): Promise<never> => Promise.reject(new Error("not under test"))

const baseApi = (): ChromeHistoryApi => ({
  search: unused,
  getVisits: unused,
  addUrl: unused,
  deleteUrl: unused,
  deleteRange: unused,
  deleteAll: unused,
  onVisited: makeEvent<[HistoryItem]>().api,
  onVisitRemoved: makeEvent<[chrome.history.RemovedResult]>().api
})

const events: ReadonlyArray<EventCase> = [
  {
    operation: "onVisited",
    setup: (wrap) => {
      const event = makeEvent<[HistoryItem]>()

      return {
        stream: make({ ...baseApi(), onVisited: wrap(event.api) }).onVisited,
        emit: (index) => { event.controls.emit(itemAt(index)) },
        listenerCount: () => event.controls.listenerCount
      }
    },
    expected: itemAt
  },
  {
    operation: "onVisitRemoved",
    setup: (wrap) => {
      const event = makeEvent<[chrome.history.RemovedResult]>()

      return {
        stream: make({ ...baseApi(), onVisitRemoved: wrap(event.api) }).onVisitRemoved,
        emit: (index) => { event.controls.emit(removalAt(index)) },
        listenerCount: () => event.controls.listenerCount
      }
    },
    expected: removalAt
  }
]

const range = (from: number, to: number): Array<number> => Array.from({ length: to - from }, (_, offset) => from + offset)

describe("ChromeHistory stress", () => {
  it.effect.each(events)("$operation keeps exactly the newest 64 of a 4,096-event burst, in order", ({ setup, expected }) => Effect.gen(function*() {
    let gate = tracked(makeEvent<[]>().api)

    const { stream, emit, listenerCount } = setup((event) => {
      const wrapped = tracked(event)
      gate = wrapped

      return wrapped.source
    })

    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 64)))
    yield* Effect.promise(() => gate.waitFor(1))

    for (let index = 0; index < 4096; index++) emit(index)

    expect(yield* Fiber.join(fiber)).toStrictEqual(range(4032, 4096).map(expected))
    expect(listenerCount()).toBe(0)
    expect([gate.added, gate.removed]).toEqual([1, 1])
  }))

  it.effect.each(events)("$operation keeps the newest 64 of a 4,096-event burst delivered during registration", ({ setup, expected }) => Effect.gen(function*() {
    let burst = (): void => {}

    const { stream, emit, listenerCount } = setup((event) => ({
      addListener: (listener) => {
        event.addListener(listener)
        burst()
      },
      removeListener: (listener) => event.removeListener(listener)
    }))

    burst = () => {
      for (let index = 0; index < 4096; index++) emit(index)
    }

    expect(yield* Stream.runCollect(Stream.take(stream, 64))).toStrictEqual(range(4032, 4096).map(expected))
    expect(listenerCount()).toBe(0)
  }))

  it.effect.each(events)("$operation gives 32 concurrent subscriptions the same newest 64 of 4,096 events", ({ setup, expected }) => Effect.gen(function*() {
    let gate = tracked(makeEvent<[]>().api)

    const { stream, emit, listenerCount } = setup((event) => {
      const wrapped = tracked(event)
      gate = wrapped

      return wrapped.source
    })

    const fibers = yield* Effect.forEach(range(0, 32), () => Effect.forkScoped(Stream.runCollect(Stream.take(stream, 64))))
    yield* Effect.promise(() => gate.waitFor(32))

    for (let index = 0; index < 4096; index++) emit(index)

    const newest = range(4032, 4096).map(expected)

    for (const values of yield* Effect.forEach(fibers, Fiber.join)) expect(values).toStrictEqual(newest)

    expect(listenerCount()).toBe(0)
    expect([gate.added, gate.removed]).toEqual([32, 32])
  }))

  it.effect.each(events)("$operation churns 512 subscriptions interrupted at every stage down to zero listeners", ({ operation, setup, expected }) => Effect.gen(function*() {
    const random = seeded(0x0151_7a9e)
    let gate = tracked(makeEvent<[]>().api)

    const { stream, emit, listenerCount } = setup((event) => {
      const wrapped = tracked(event)
      gate = wrapped

      return wrapped.source
    })

    // 0: interrupted right after forking; 1: once registered; 2: with a full, unread buffer;
    // 3: while processing an event; 4: completes after 64 events; 5: fails on its first event.
    const stages = range(0, 512).map(() => Math.floor(random() * 6))
    const count = (stage: number) => stages.filter((candidate) => candidate === stage).length
    const processing = yield* Deferred.make<void>()
    const blocked = yield* Deferred.make<void>()
    let entered = 0
    const failure = new ChromeHistoryError({ operation: "consumer", cause: new Error("consumer failed") })

    const consumer = (stage: number) => {
      if (stage === 3) {
        return Stream.runDrain(Stream.mapEffect(stream, () => Effect.gen(function*() {
          entered += 1

          if (entered === count(3)) yield* Deferred.succeed(processing, undefined)

          yield* Deferred.await(blocked)
        })))
      }

      if (stage === 4) return Stream.runCollect(Stream.take(stream, 64))

      if (stage === 5) return Stream.runDrain(Stream.mapEffect(stream, () => Effect.fail(failure)))

      return Stream.runDrain(stream)
    }

    const fibers = yield* Effect.forEach(stages, (stage) => Effect.map(Effect.forkScoped(consumer(stage)), (fiber) => ({ stage, fiber })))
    const at = (stage: number) => fibers.filter((entry) => entry.stage === stage).map((entry) => entry.fiber)

    yield* Effect.forEach(at(0), Fiber.interrupt, { concurrency: "unbounded", discard: true })
    yield* Effect.promise(() => gate.waitFor(512 - count(0)))
    yield* Effect.forEach(at(1), Fiber.interrupt, { concurrency: "unbounded", discard: true })
    expect(gate.live).toBe(512 - count(0) - count(1))

    for (let index = 0; index < 4096; index++) emit(index)

    yield* Effect.forEach(at(2), Fiber.interrupt, { concurrency: "unbounded", discard: true })
    yield* Deferred.await(processing)
    yield* Effect.forEach(at(3), Fiber.interrupt, { concurrency: "unbounded", discard: true })

    for (const fiber of at(4)) expect(yield* Fiber.join(fiber)).toStrictEqual(range(4032, 4096).map(expected))

    for (const fiber of at(5)) expect(yield* Effect.flip(Fiber.join(fiber))).toBe(failure)

    for (const stage of [0, 1, 2, 3]) {
      for (const fiber of at(stage)) expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
    }

    for (const stage of range(0, 6)) expect(count(stage), `stage ${stage} of ${operation}`).toBeGreaterThan(0)

    expect(listenerCount()).toBe(0)
    expect(gate.live).toBe(0)
    expect(gate.removed).toBe(gate.added)
  }))

  it.effect.each(events)("$operation types 512 concurrent registrations failing at random and leaves no listener", ({ operation, setup }) => Effect.gen(function*() {
    const random = seeded(0xfa11)
    const failing = range(0, 512).map(() => random() < 0.5)
    const failures = failing.filter((fail) => fail).length
    let attempt = 0
    const cause = new Error("registration refused")
    let gate = tracked(makeEvent<[]>().api)

    const { stream, listenerCount } = setup(<Args extends ReadonlyArray<unknown>>(event: EventSource<Args>) => {
      const wrapped = tracked<Args>({
        addListener: (listener) => {
          const fail = failing[attempt] === true
          attempt += 1

          if (fail) throw cause

          event.addListener(listener)
        },
        removeListener: (listener) => event.removeListener(listener)
      })

      gate = wrapped

      return wrapped.source
    })

    const fibers = yield* Effect.forEach(failing, () => Effect.forkScoped(Effect.exit(Stream.runDrain(stream))))
    yield* Effect.promise(() => gate.waitFor(512 - failures))
    expect(attempt).toBe(512)
    yield* Effect.forEach(fibers, Fiber.interrupt, { concurrency: "unbounded", discard: true })
    const exits = yield* Effect.forEach(fibers, Fiber.await)
    const typed = exits.filter((exit) => Exit.isSuccess(exit) && Exit.isFailure(exit.value))
    expect(typed).toHaveLength(failures)

    for (const exit of typed) {
      expect(exit).toStrictEqual(Exit.succeed(Exit.fail(new ChromeHistoryError({ operation, cause }))))
    }

    expect(exits.filter((exit) => Exit.hasInterrupts(exit))).toHaveLength(512 - failures)
    expect(listenerCount()).toBe(0)
    expect([gate.added, gate.removed]).toEqual([512 - failures, 512 - failures])
  }))
})

type Mode = "resolve" | "reject" | "throw"

interface Plan {
  readonly operation: HistoryOperation
  readonly mode: Mode
  readonly cause: Error
}

type Outcome = ReadonlyArray<HistoryItem | VisitItem> | void

describe("ChromeHistory concurrent calls", () => {
  it.effect("settles 3,072 concurrent calls out of order, each rejection and throw typed with its operation", () => Effect.gen(function*() {
    const random = seeded(0xca11)
    const operations: ReadonlyArray<HistoryOperation> = ["search", "getVisits", "addUrl", "deleteUrl", "deleteRange", "deleteAll"]
    const modes: ReadonlyArray<Mode> = ["resolve", "reject", "throw"]

    const plans: Array<Plan> = range(0, 3072).map((index) => {
      const operation = operations[index % operations.length] ?? "search"
      const mode = modes[Math.floor(random() * modes.length)] ?? "resolve"

      return { operation, mode, cause: new Error(`${operation} #${index} ${mode}`) }
    })

    const pending: Array<{ readonly settle: () => void }> = []
    const asynchronous = plans.filter((plan) => plan.mode !== "throw").length
    let invoked!: () => void
    const allInvoked = new Promise<void>((resolve) => { invoked = resolve })

    /** Calls `index`'s plan: a synchronous throw, or a promise settled later in seeded order. */
    const respond = <A>(index: number, value: A): Promise<A> => {
      const plan = plans[index]

      if (plan === undefined) throw new Error(`no plan for call ${index}`)

      if (plan.mode === "throw") throw plan.cause

      const promise = new Promise<A>((resolve, reject) => {
        pending.push({ settle: () => plan.mode === "reject" ? reject(plan.cause) : resolve(value) })
      })

      if (pending.length === asynchronous) invoked()

      return promise
    }

    let deleteAllCalls = 0
    const deleteAllIndexes = plans.flatMap((plan, index) => plan.operation === "deleteAll" ? [index] : [])
    const indexOf = (url: string): number => Number(new URL(url).pathname.slice(1))

    const api: ChromeHistoryApi = {
      ...baseApi(),
      search: vi.fn((query: HistoryQuery) => respond(Number(query.text), [itemAt(Number(query.text))])),
      getVisits: vi.fn((details: chrome.history.UrlDetails) => respond(indexOf(details.url), [])),
      addUrl: vi.fn((details: chrome.history.UrlDetails) => respond(indexOf(details.url), undefined)),
      deleteUrl: vi.fn((details: chrome.history.UrlDetails) => respond(indexOf(details.url), undefined)),
      deleteRange: vi.fn((range: Range) => respond(range.startTime, undefined)),
      deleteAll: vi.fn(() => {
        const index = deleteAllIndexes[deleteAllCalls] ?? -1
        deleteAllCalls += 1

        return respond(index, undefined)
      })
    }

    const history = make(api)

    const call = (index: number, operation: HistoryOperation): Effect.Effect<Outcome, ChromeHistoryError> => {
      const url = `https://call.example/${index}`

      switch (operation) {
        case "search": return history.search({ text: String(index) })
        case "getVisits": return history.getVisits(url)
        case "addUrl": return history.addUrl(url)
        case "deleteUrl": return history.deleteUrl(url)
        case "deleteRange": return history.deleteRange({ startTime: index, endTime: index + 1 })
        case "deleteAll": return history.deleteAll
      }
    }

    const results = yield* Effect.forkScoped(Effect.forEach(
      plans,
      (plan, index) => Effect.exit(call(index, plan.operation)),
      { concurrency: "unbounded" }
    ))

    yield* Effect.promise(() => allInvoked)

    for (const entry of shuffled(pending, random)) entry.settle()

    const exits = yield* Fiber.join(results)
    expect(plans.filter((plan) => plan.mode === "throw").length).toBeGreaterThan(900)
    expect(plans.filter((plan) => plan.mode === "reject").length).toBeGreaterThan(900)

    exits.forEach((exit, index) => {
      const plan = plans[index]

      if (plan === undefined) throw new Error(`no plan for call ${index}`)

      // deleteAll calls cannot be told apart by argument; their causes are checked as a set below.
      if (plan.operation === "deleteAll") return

      if (plan.mode === "resolve") expect(Exit.isSuccess(exit)).toBe(true)
      else expect(exit).toStrictEqual(Exit.fail(new ChromeHistoryError({ operation: plan.operation, cause: plan.cause })))
    })

    const deleteAllCauses = exits.flatMap((exit, index) => {
      if (plans[index]?.operation !== "deleteAll" || Exit.isSuccess(exit)) return []

      return Option.toArray(Cause.findErrorOption(exit.cause))
    })

    expect(deleteAllCauses.every((error) => error.operation === "deleteAll")).toBe(true)
    const plannedCauses = plans.flatMap((plan) => plan.operation === "deleteAll" && plan.mode !== "resolve" ? [plan.cause] : [])
    expect(deleteAllCauses).toHaveLength(plannedCauses.length)
    expect(new Set(deleteAllCauses.map((error) => error.cause))).toEqual(new Set(plannedCauses))
    expect(deleteAllCalls).toBe(512)
  }))

  it.effect("interrupts 1,024 calls whose promises never settle in time, then absorbs their late outcomes", () => Effect.gen(function*() {
    const random = seeded(0x1a7e)
    const pending: Array<{ readonly resolve: () => void; readonly reject: (cause: Error) => void }> = []
    let started!: () => void
    const allStarted = new Promise<void>((resolve) => { started = resolve })

    const hold = (): Promise<void> => {
      const promise = new Promise<void>((resolve, reject) => { pending.push({ resolve: () => resolve(), reject }) })

      if (pending.length === 1024) started()

      return promise
    }

    const history = make({ ...baseApi(), addUrl: vi.fn(hold), deleteUrl: vi.fn(hold) })

    const fibers = yield* Effect.forEach(range(0, 1024), (index) => Effect.forkScoped(
      index % 2 === 0 ? history.addUrl(`https://held.example/${index}`) : history.deleteUrl(`https://held.example/${index}`)
    ))

    yield* Effect.promise(() => allStarted)
    yield* Effect.forEach(fibers, Fiber.interrupt, { concurrency: "unbounded", discard: true })

    for (const fiber of fibers) expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)

    for (const entry of shuffled(pending, random)) {
      if (random() < 0.5) entry.resolve()
      else entry.reject(new Error("settled after interruption"))
    }

    // Late rejections must be handled, not reported as unhandled; give them a turn to surface.
    yield* Effect.promise(() => new Promise<void>((resolve) => { setImmediate(resolve) }))
  }))
})

describe("makeHistory stress", () => {
  const now = 1_700_000_000_000

  it.effect("searches, counts and deletes across 10,000 pages and 40,000 visits", () => Effect.gen(function*() {
    const random = seeded(0x5ea4c4)
    const fixture = makeHistory()
    fixture.controls.setNow(now)
    const history = make(fixture.api)

    for (let index = 0; index < 40_000; index++) {
      fixture.controls.seed({
        url: `https://site-${index % 10_000}.example/`,
        visitTime: now - 1 - Math.floor(random() * 1_000_000),
        transition: random() < 0.25 ? "typed" : "link"
      })
    }

    const pages = fixture.controls.pages()
    expect(pages).toHaveLength(10_000)
    expect(pages.reduce((total, item) => total + (item.visitCount ?? 0), 0)).toBe(40_000)

    const all = yield* history.search({ text: "", maxResults: 0 })
    expect(all).toHaveLength(10_000)
    expect(all.every((item, index) => index === 0 || (all[index - 1]?.lastVisitTime ?? 0) >= (item.lastVisitTime ?? 0))).toBe(true)
    expect(yield* history.search({ text: "" })).toStrictEqual(all.slice(0, 100))
    expect(yield* history.search({ text: "site-9999" })).toHaveLength(1)

    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(history.onVisitRemoved, 2)))
    yield* Effect.promise(fixture.controls.onVisitRemoved.waitForListener)
    yield* history.deleteRange({ startTime: now - 500_000, endTime: now })
    const remaining = fixture.controls.pages()
    expect(remaining.every((item) => (item.lastVisitTime ?? now) < now - 500_000)).toBe(true)
    yield* history.deleteAll
    const [ranged, cleared] = yield* Fiber.join(fiber)
    expect(ranged?.allHistory).toBe(false)
    const kept = new Set(remaining.map((item) => item.url))
    const purged = pages.flatMap((item) => item.url === undefined || kept.has(item.url) ? [] : [item.url])
    expect(purged.length).toBeGreaterThan(0)
    expect(kept.size).toBeGreaterThan(0)
    expect(ranged?.urls).toHaveLength(purged.length)
    expect(new Set(ranged?.urls)).toEqual(new Set(purged))
    expect(cleared).toStrictEqual({ allHistory: true, urls: [] })
    expect(fixture.controls.pages()).toEqual([])
  }))

  it.effect("keeps history consistent with its event log across 2,048 racing adds and deletes of one URL", () => Effect.gen(function*() {
    const random = seeded(0xd0d0)
    const fixture = makeHistory()
    fixture.controls.setNow(now)
    const history = make(fixture.api)
    const url = "https://contended.example/"
    const log: Array<"visited" | "removed"> = []
    fixture.api.onVisited.addListener(() => { log.push("visited") })
    fixture.api.onVisitRemoved.addListener(() => { log.push("removed") })

    const adds = range(0, 2048).map(() => random() < 0.5)
    yield* Effect.forEach(adds, (add) => add ? history.addUrl(url) : history.deleteUrl(url), { concurrency: "unbounded", discard: true })

    const addCount = adds.filter((add) => add).length
    const removals = log.filter((entry) => entry === "removed").length
    expect(log.filter((entry) => entry === "visited")).toHaveLength(addCount)
    expect(removals).toBeGreaterThan(0)
    expect(removals).toBeLessThanOrEqual(adds.length - addCount)
    // A deletion reports only a page that exists, so every removal follows a visit.
    expect(log.every((entry, index) => entry === "visited" || log[index - 1] === "visited")).toBe(true)
    const sinceLastRemoval = log.length - 1 - log.lastIndexOf("removed")
    expect(yield* history.getVisits(url)).toHaveLength(sinceLastRemoval)
    expect(fixture.controls.pages()).toHaveLength(sinceLastRemoval > 0 ? 1 : 0)
  }))

  it.effect("records 1,024 concurrent addUrl calls, while a subscriber keeps only what it can buffer", () => Effect.gen(function*() {
    const fixture = makeHistory()
    fixture.controls.setNow(now)
    const history = make(fixture.api)
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(history.onVisited, 64)))
    yield* Effect.promise(fixture.controls.onVisited.waitForListener)
    yield* Effect.forEach(range(0, 1024), (index) => history.addUrl(`https://concurrent-${index}.example/`), { concurrency: "unbounded", discard: true })
    const seen = yield* Fiber.join(fiber)
    expect(seen).toHaveLength(64)
    expect(new Set(seen.map((item) => item.url)).size).toBe(64)
    expect(fixture.controls.pages()).toHaveLength(1024)
    expect(fixture.controls.onVisited.listenerCount).toBe(0)
    expect(yield* history.search({ text: "concurrent", maxResults: 0 })).toHaveLength(1024)
  }))
})
