// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Deferred, Effect, Exit, Fiber, Option, Stream } from "effect"
import type { Scope } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChromeWebNavigation, ChromeWebNavigationError, make } from "../../src/ChromeWebNavigation.js"
import type {
  ChromeWebNavigationApi, ChromeWebNavigationService, DocumentLoad, FilterableEvent, Frame, FrameDetails, FrameInfo,
  Navigation, NavigationFailure, NavigationFilter, NavigationStart, NavigationTarget, TabReplacement
} from "../../src/ChromeWebNavigation.js"
import { makeWebNavigation } from "../../src/testing/WebNavigation.js"

/** A deterministic generator (mulberry32), so every run churns the same way. */
const seeded = (seed: number) => {
  let state = seed >>> 0

  return (bound: number): number => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * bound)
  }
}

/** An element known to exist, so a seeded index cannot silently fall back. */
const pick = <A>(items: ReadonlyArray<A>, index: number): A => {
  const item = items[index]

  if (item === undefined) throw new RangeError(`No item at ${index}`)

  return item
}

/** A promise with its resolver, settled from a mock's callback. */
interface Resolvers<A> {
  readonly promise: Promise<A>
  readonly resolve: (value: A) => void
}

const resolvers = <A>(): Resolvers<A> => {
  let settle = (_value: A): void => undefined
  const promise = new Promise<A>((resolve) => { settle = resolve })

  return { promise, resolve: (value) => settle(value) }
}

const start: NavigationStart = {
  tabId: 7, frameId: 0, url: "https://app.example/next", timeStamp: 0, processId: -1,
  documentLifecycle: "active", frameType: "outermost_frame", parentFrameId: -1
}

const navigation: Navigation = { ...start, processId: 1, transitionType: "link", transitionQualifiers: [], documentId: "document-1" }

const load: DocumentLoad = { ...start, processId: 1, documentId: "document-1" }

const failure: NavigationFailure = { ...load, processId: -1, error: "net::ERR_ABORTED" }

const target: NavigationTarget = {
  sourceTabId: 7, sourceFrameId: 0, sourceProcessId: 1, tabId: 8, timeStamp: 0, url: "https://app.example/popup"
}

const replacement: TabReplacement = { replacedTabId: 7, tabId: 9, timeStamp: 0 }

const failingHost = "fail.test"

/**
 * Listener bookkeeping shared by every event of one mock: how many listeners are registered
 * right now, with promise gates that open when that number reaches a target.
 */
const makeRegistry = () => {
  const waiters: Array<{ readonly count: number; readonly resolve: () => void }> = []
  let active = 0

  const settle = () => {
    for (const waiter of waiters.filter((each) => each.count === active)) {
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve()
    }
  }

  return {
    get active() { return active },
    change: (delta: number) => {
      active += delta
      settle()
    },
    /** Resolves once exactly `count` listeners are registered. */
    whenActive: (count: number): Promise<void> => active === count
      ? Promise.resolve()
      : new Promise((resolve) => { waiters.push({ count, resolve }) })
  }
}

type Registry = ReturnType<typeof makeRegistry>

/**
 * A Chrome-like event that records how many arguments each addListener call received and
 * refuses registrations whose filter names `failingHost`, as Chrome refuses invalid filters.
 */
const trackedEvent = <A>(registry: Registry) => {
  const listeners = new Set<(details: A) => void>()
  const arities: Array<number> = []
  const removalFailures: Array<Error> = []
  let removals = 0

  const api: FilterableEvent<[A]> = {
    addListener: (...args: [listener: (details: A) => void, filter?: NavigationFilter]) => {
      arities.push(args.length)
      const [listener, filter] = args

      if (filter?.url.some((condition) => condition.hostEquals === failingHost) === true) {
        throw new Error("Invalid filter")
      }

      if (listeners.has(listener)) return

      listeners.add(listener)
      registry.change(1)
    },
    removeListener: (listener) => {
      removals++
      const failure = removalFailures.shift()

      if (failure !== undefined) throw failure

      if (listeners.delete(listener)) registry.change(-1)
    }
  }

  return {
    api,
    arities,
    get removals() { return removals },
    get count() { return listeners.size },
    /** Makes the next removeListener call throw `cause` and keep the listener. */
    failNextRemoval: (cause: Error) => { removalFailures.push(cause) },
    emit: (details: A) => {
      for (const listener of Array.from(listeners)) listener(details)
    }
  }
}

type Tracked<A> = ReturnType<typeof trackedEvent<A>>

/** Wraps a fixture event so `ready` resolves once `count` listeners have been added through it. */
const registrationGate = <A>(event: FilterableEvent<[A]>, count: number) => {
  const ready = resolvers<void>()
  let registered = 0

  const gated: FilterableEvent<[A]> = {
    addListener: (...args: [listener: (details: A) => void, filter?: NavigationFilter]) => {
      event.addListener(...args)
      registered++

      if (registered === count) ready.resolve()
    },
    removeListener: (listener) => event.removeListener(listener)
  }

  return { event: gated, ready: ready.promise }
}

const mockApi = () => {
  const registry = makeRegistry()

  const events = {
    onBeforeNavigate: trackedEvent<NavigationStart>(registry),
    onCommitted: trackedEvent<Navigation>(registry),
    onDOMContentLoaded: trackedEvent<DocumentLoad>(registry),
    onCompleted: trackedEvent<DocumentLoad>(registry),
    onErrorOccurred: trackedEvent<NavigationFailure>(registry),
    onCreatedNavigationTarget: trackedEvent<NavigationTarget>(registry),
    onReferenceFragmentUpdated: trackedEvent<Navigation>(registry),
    onHistoryStateUpdated: trackedEvent<Navigation>(registry),
    onTabReplaced: trackedEvent<TabReplacement>(registry)
  }

  const api: ChromeWebNavigationApi = {
    getAllFrames: async () => [],
    getFrame: async () => null,
    onBeforeNavigate: events.onBeforeNavigate.api,
    onCommitted: events.onCommitted.api,
    onDOMContentLoaded: events.onDOMContentLoaded.api,
    onCompleted: events.onCompleted.api,
    onErrorOccurred: events.onErrorOccurred.api,
    onCreatedNavigationTarget: events.onCreatedNavigationTarget.api,
    onReferenceFragmentUpdated: events.onReferenceFragmentUpdated.api,
    onHistoryStateUpdated: events.onHistoryStateUpdated.api,
    onTabReplaced: events.onTabReplaced.api
  }

  return { api, registry, events }
}

type Mock = ReturnType<typeof mockApi>

/** One event under test: its stream (filtered when Chrome allows), its mock and a sample. */
interface EventCase<A extends { readonly timeStamp: number }> {
  readonly name: string
  readonly stream: (service: ChromeWebNavigationService, filter: NavigationFilter | undefined) => Stream.Stream<A, ChromeWebNavigationError>
  readonly event: (mock: Mock) => Tracked<A>
  readonly sample: A
}

/**
 * Emits a 4,096-event burst into one running subscription before it can drain, waits until
 * the consumer has taken what survived, then emits a sentinel: the consumer must see exactly
 * the newest 64 in order, then the sentinel, and leave no listener behind.
 */
const burst = <A extends { readonly timeStamp: number }>(eventCase: EventCase<A>) => Effect.gen(function*() {
  const mock = mockApi()
  const event = eventCase.event(mock)
  const seen: Array<number> = []
  const drained = yield* Deferred.make<void>()

  const consumer = yield* Effect.forkScoped(Stream.runDrain(Stream.take(eventCase.stream(make(mock.api), filterFor(1)), 65).pipe(
    Stream.tap((details) => Effect.suspend(() => {
      seen.push(details.timeStamp)

      return seen.length === 64 ? Deferred.succeed(drained, undefined) : Effect.void
    }))
  )))

  yield* Effect.promise(() => mock.registry.whenActive(1))

  for (let index = 0; index < 4096; index++) event.emit({ ...eventCase.sample, timeStamp: index })

  yield* Deferred.await(drained)
  event.emit({ ...eventCase.sample, timeStamp: -1 })
  yield* Fiber.join(consumer)
  expect(seen).toEqual([...Array.from({ length: 64 }, (_, index) => 4032 + index), -1])
  expect(event.count).toBe(0)
  expect(event.removals).toBe(1)
})

/** An event case with its payload type erased to the timestamps that identify events. */
interface Case {
  readonly name: string
  readonly burst: () => Effect.Effect<void, ChromeWebNavigationError, Scope.Scope>
  readonly stream: (service: ChromeWebNavigationService, filter: NavigationFilter | undefined) => Stream.Stream<number, ChromeWebNavigationError>
  readonly emit: (mock: Mock, timeStamp: number) => void
  readonly tracked: (mock: Mock) => { readonly arities: ReadonlyArray<number>; readonly count: number }
}

const eventCase = <A extends { readonly timeStamp: number }>(each: EventCase<A>): Case => ({
  name: each.name,
  burst: () => burst(each),
  stream: (service, filter) => Stream.map(each.stream(service, filter), (details) => details.timeStamp),
  emit: (mock, timeStamp) => each.event(mock).emit({ ...each.sample, timeStamp }),
  tracked: each.event
})

const cases: ReadonlyArray<Case> = [
  eventCase({ name: "onBeforeNavigate", stream: (service, filter) => service.onBeforeNavigate(filter), event: (mock) => mock.events.onBeforeNavigate, sample: start }),
  eventCase({ name: "onCommitted", stream: (service, filter) => service.onCommitted(filter), event: (mock) => mock.events.onCommitted, sample: navigation }),
  eventCase({ name: "onDOMContentLoaded", stream: (service, filter) => service.onDOMContentLoaded(filter), event: (mock) => mock.events.onDOMContentLoaded, sample: load }),
  eventCase({ name: "onCompleted", stream: (service, filter) => service.onCompleted(filter), event: (mock) => mock.events.onCompleted, sample: load }),
  eventCase({ name: "onErrorOccurred", stream: (service, filter) => service.onErrorOccurred(filter), event: (mock) => mock.events.onErrorOccurred, sample: failure }),
  eventCase({
    name: "onCreatedNavigationTarget", stream: (service, filter) => service.onCreatedNavigationTarget(filter),
    event: (mock) => mock.events.onCreatedNavigationTarget, sample: target
  }),
  eventCase({
    name: "onReferenceFragmentUpdated", stream: (service, filter) => service.onReferenceFragmentUpdated(filter),
    event: (mock) => mock.events.onReferenceFragmentUpdated, sample: navigation
  }),
  eventCase({
    name: "onHistoryStateUpdated", stream: (service, filter) => service.onHistoryStateUpdated(filter),
    event: (mock) => mock.events.onHistoryStateUpdated, sample: navigation
  }),
  // Chrome takes no filter for onTabReplaced, so its case ignores the one given.
  eventCase({ name: "onTabReplaced", stream: (service) => service.onTabReplaced, event: (mock) => mock.events.onTabReplaced, sample: replacement })
]

const filterFor = (index: number): NavigationFilter => ({ url: [{ hostEquals: `host-${index}.test` }] })

type Stage = "beforeRegistration" | "registered" | "midStream" | "completed" | "registrationFailure"

const stages: ReadonlyArray<Stage> = ["beforeRegistration", "registered", "midStream", "completed", "registrationFailure"]

describe("ChromeWebNavigation stress", () => {
  it.effect.each(cases.map((each) => [each.name, each] as const))(
    "keeps exactly the newest 64 of a 4,096-event %s burst, in order",
    ([_name, each]) => each.burst()
  )

  it.effect("churns 512 concurrent subscriptions, interrupted at every stage, down to zero listeners", () => Effect.gen(function*() {
    const random = seeded(0x5eed)
    const mock = mockApi()
    const service = make(mock.api)

    const plans = Array.from({ length: 512 }, (_, index) => {
      const stage = pick(stages, index % stages.length)
      const eventCase = pick(cases, random(cases.length))

      const filter = stage === "registrationFailure"
        ? { url: [{ hostEquals: failingHost }] }
        : random(2) === 0 ? undefined : filterFor(index)

      // onTabReplaced takes no filter, so it cannot be refused one; it completes instead.
      const effective: Stage = stage === "registrationFailure" && eventCase.name === "onTabReplaced" ? "completed" : stage

      return { stage: effective, eventCase, filter }
    })

    let received = 0
    const midStreamReady = yield* Deferred.make<void>()
    const midStreamCount = plans.filter((plan) => plan.stage === "midStream").length

    const runs = yield* Effect.forEach(plans, (plan) => Effect.forkScoped(
      Stream.runCollect(Stream.take(plan.eventCase.stream(service, plan.filter), plan.stage === "completed" ? 1 : 2).pipe(
        Stream.tap(() => Effect.suspend(() => {
          if (plan.stage !== "midStream") return Effect.void

          received++

          return received === midStreamCount ? Deferred.succeed(midStreamReady, undefined) : Effect.void
        }))
      )).pipe(Effect.map((collected) => collected.length))
    ).pipe(Effect.map((fiber) => ({ plan, fiber }))))

    const fiberOf = (stage: Stage) => runs.filter((run) => run.plan.stage === stage).map((run) => run.fiber)

    // Interrupted at once: some never reach addListener, the rest must remove what they added.
    yield* Fiber.interruptAll(fiberOf("beforeRegistration"))

    const live = plans.filter((plan) => plan.stage === "registered" || plan.stage === "midStream" || plan.stage === "completed").length
    yield* Effect.promise(() => mock.registry.whenActive(live))

    yield* Fiber.interruptAll(fiberOf("registered"))
    expect(mock.registry.active).toBe(live - plans.filter((plan) => plan.stage === "registered").length)

    for (const eventCase of cases) eventCase.emit(mock, 1)

    yield* Deferred.await(midStreamReady)
    yield* Fiber.interruptAll(fiberOf("midStream"))

    for (const fiber of fiberOf("completed")) expect(yield* Fiber.join(fiber)).toBe(1)

    for (const { plan, fiber } of runs) {
      const exit = yield* Fiber.await(fiber)

      if (plan.stage === "registrationFailure") {
        const error = Option.getOrThrow(Exit.findErrorOption(exit))
        expect(error).toBeInstanceOf(ChromeWebNavigationError)
        expect(error.operation).toBe(plan.eventCase.name)
      } else if (plan.stage === "completed") {
        expect(Exit.isSuccess(exit)).toBe(true)
      } else {
        expect(Exit.hasInterrupts(exit)).toBe(true)
      }
    }

    expect(mock.registry.active).toBe(0)

    // A filter reached Chrome exactly when one was given. Subscriptions interrupted at once
    // may never have called addListener, so they bound the counts from above only.
    for (const eventCase of cases) {
      const event = eventCase.tracked(mock)
      const own = plans.filter((plan) => plan.eventCase === eventCase)
      const withFilter = own.filter((plan) => plan.filter !== undefined && eventCase.name !== "onTabReplaced")
      const withoutFilter = own.filter((plan) => !withFilter.includes(plan))
      const certain = (group: typeof own) => group.filter((plan) => plan.stage !== "beforeRegistration").length
      const filtered = event.arities.filter((arity) => arity === 2).length
      const unfiltered = event.arities.filter((arity) => arity === 1).length
      expect(event.count).toBe(0)
      expect(filtered + unfiltered).toBe(event.arities.length)
      expect(filtered).toBeGreaterThanOrEqual(certain(withFilter))
      expect(filtered).toBeLessThanOrEqual(withFilter.length)
      expect(unfiltered).toBeGreaterThanOrEqual(certain(withoutFilter))
      expect(unfiltered).toBeLessThanOrEqual(withoutFilter.length)
    }
  }))

  it.effect("maps 2,048 concurrent calls with interleaved results, rejections and throws", () => Effect.gen(function*() {
    const random = seeded(2048)
    const outcomes = Array.from({ length: 2048 }, () => (["frames", "absent", "reject", "throw"] as const)[random(4)] ?? "frames")
    const asynchronous = outcomes.filter((outcome) => outcome !== "throw").length
    const gate = resolvers<void>()
    const allInFlight = resolvers<void>()
    let inFlight = 0

    const respond = <A>(index: number, value: A): Promise<A | null> => {
      const outcome = outcomes[index]

      if (outcome === "throw") throw new Error(`throw ${index}`)

      inFlight++

      if (inFlight === asynchronous) allInFlight.resolve()

      return gate.promise.then(() => {
        if (outcome === "reject") throw new Error(`reject ${index}`)

        return outcome === "absent" ? null : value
      })
    }

    const frameAt = (index: number): Frame => ({
      frameId: index, parentFrameId: -1, processId: 1, url: `https://app.example/${index}`, documentId: `document-${index}`,
      documentLifecycle: "active", errorOccurred: false, frameType: "outermost_frame"
    })

    const api: ChromeWebNavigationApi = {
      ...mockApi().api,
      getAllFrames: ({ tabId }) => respond(tabId, [frameAt(tabId)]),
      getFrame: (details: FrameDetails) => {
        const index = details.tabId ?? -1
        const { frameId: _frameId, processId: _processId, ...info } = frameAt(index)

        return respond<FrameInfo>(index, info)
      }
    }

    const service = make(api)

    const calls = yield* Effect.forkScoped(Effect.forEach(outcomes, (_, index) => Effect.exit(index % 2 === 0
      ? Effect.map(service.getAllFrames(index), (frames) => Option.map(frames, (all) => all[0]?.url))
      : Effect.map(service.getFrame({ tabId: index, frameId: 0 }), (frame) => Option.map(frame, (each) => each.url))
    ), { concurrency: "unbounded" }))

    yield* Effect.promise(() => allInFlight.promise)
    expect(inFlight).toBe(asynchronous)
    gate.resolve()
    const exits = yield* Fiber.join(calls)

    exits.forEach((exit, index) => {
      const outcome = outcomes[index]
      const operation = index % 2 === 0 ? "getAllFrames" : "getFrame"

      if (outcome === "frames") {
        expect(exit).toEqual(Exit.succeed(Option.some(`https://app.example/${index}`)))
      } else if (outcome === "absent") {
        expect(exit).toEqual(Exit.succeed(Option.none()))
      } else {
        const error = Option.getOrThrow(Exit.findErrorOption(exit))
        expect(error).toBeInstanceOf(ChromeWebNavigationError)
        expect(error.operation).toBe(operation)
        expect(error.cause).toEqual(new Error(`${outcome} ${index}`))
      }
    })
  }))

  it.effect("interrupts 1,024 calls stuck in Chrome without waiting for them", () => Effect.gen(function*() {
    const gate = resolvers<null>()
    const allInFlight = resolvers<void>()
    let inFlight = 0

    const service = make({
      ...mockApi().api,
      getAllFrames: () => {
        inFlight++

        if (inFlight === 1024) allInFlight.resolve()

        return gate.promise
      }
    })

    const calls = yield* Effect.forkScoped(Effect.forEach(Array.from({ length: 1024 }, (_, index) => index), service.getAllFrames, {
      concurrency: "unbounded"
    }))

    yield* Effect.promise(() => allInFlight.promise)
    yield* Fiber.interrupt(calls)
    expect(Exit.hasInterrupts(yield* Fiber.await(calls))).toBe(true)
    // Chrome answering afterwards reaches no one and raises nothing.
    gate.resolve(null)
    yield* Effect.promise(() => gate.promise)
  }))

  it.effect("serves 4,096 fixture frames across 256 tabs to concurrent lookups", () => Effect.gen(function*() {
    const fixture = makeWebNavigation()
    const service = yield* ChromeWebNavigation.pipe(Effect.provide(fixture.layer))
    const tabIds = Array.from({ length: 256 }, (_, index) => index + 1)

    for (const tabId of tabIds) {
      fixture.controls.addFrame(tabId, { url: `https://tab-${tabId}.test/` })

      for (let frameId = 1; frameId < 16; frameId++) fixture.controls.addFrame(tabId, { frameId, url: `https://tab-${tabId}.test/frame-${frameId}` })
    }

    const lists = yield* Effect.forEach([...tabIds, 1000, 1001], service.getAllFrames, { concurrency: "unbounded" })
    expect(lists.slice(0, 256).map((list) => Option.getOrThrow(list).length)).toEqual(tabIds.map(() => 16))
    expect(lists.slice(256).every(Option.isNone)).toBe(true)

    const documents = tabIds.flatMap((tabId) => Array.from({ length: 16 }, (_, frameId) => ({
      tabId, frameId, documentId: fixture.controls.frame(tabId, frameId)?.documentId ?? ""
    })))

    expect(new Set(documents.map((each) => each.documentId)).size).toBe(4096)

    const found = yield* Effect.forEach(documents, ({ documentId }) => service.getFrame({ documentId }), { concurrency: "unbounded" })
    expect(found.map((frame) => Option.getOrThrow(frame).documentId)).toEqual(documents.map((each) => each.documentId))

    // A document id checked against the wrong tab finds nothing.
    const mismatched = yield* Effect.forEach(documents.slice(0, 256), ({ tabId, documentId }) =>
      service.getFrame({ tabId: tabId + 1000, documentId }), { concurrency: "unbounded" })

    expect(mismatched.every(Option.isNone)).toBe(true)
  }))

  it.effect("routes 1,024 navigations through 256 distinct URL filters, each seeing only its own host in order", () => Effect.gen(function*() {
    const random = seeded(256)
    const fixture = makeWebNavigation()
    const committed = registrationGate(fixture.api.onCommitted, 256)
    const service = make({ ...fixture.api, onCommitted: committed.event })
    const hosts = Array.from({ length: 256 }, (_, index) => index)

    const subscribers = yield* Effect.forEach(hosts, (host) => Effect.forkScoped(Stream.runCollect(
      Stream.take(service.onCommitted(filterFor(host)), 4).pipe(Stream.map((details) => details.url))
    )))

    yield* Effect.promise(() => committed.ready)

    // Every host is visited four times, in a seeded interleaving; at most 4 events per filter fit the buffer.
    const visits = hosts.flatMap((host) => [0, 1, 2, 3].map((visit) => ({ host, visit })))

    for (let index = visits.length - 1; index > 0; index--) {
      const swap = random(index + 1)
      const current = visits[index]
      const other = visits[swap]

      if (current !== undefined && other !== undefined) {
        visits[index] = other
        visits[swap] = current
      }
    }

    const order = new Map<number, Array<string>>()

    for (const { host, visit } of visits) {
      const url = `https://host-${host}.test/visit-${visit}`
      const urls = order.get(host) ?? []
      urls.push(url)
      order.set(host, urls)
      fixture.controls.navigate(1, url)
    }

    const results = yield* Fiber.joinAll(subscribers)
    expect(results).toEqual(hosts.map((host) => order.get(host)))
    expect(fixture.controls.onCommitted.listenerCount).toBe(0)
  }))

  it.effect("keeps skipped events out of a filtered subscription's buffer during a 4,096-navigation burst", () => Effect.gen(function*() {
    const fixture = makeWebNavigation()
    const service = yield* ChromeWebNavigation.pipe(Effect.provide(fixture.layer))
    const matching = { url: [{ hostEquals: "match.test" }] }
    const seen: Array<string> = []
    const drained = yield* Deferred.make<void>()

    const consumer = yield* Effect.forkScoped(Stream.runDrain(Stream.take(service.onCompleted(matching), 65).pipe(
      Stream.tap((details) => Effect.suspend(() => {
        seen.push(details.url)

        return seen.length === 64 ? Deferred.succeed(drained, undefined) : Effect.void
      }))
    )))

    yield* Effect.promise(() => fixture.controls.onCompleted.waitForListener())

    // One navigation in eight matches; the other 3,584 must not displace them.
    for (let index = 0; index < 4096; index++) {
      fixture.controls.navigate(1, index % 8 === 0 ? `https://match.test/${index}` : `https://other.test/${index}`)
    }

    yield* Deferred.await(drained)
    fixture.controls.navigate(1, "https://match.test/sentinel")
    yield* Fiber.join(consumer)
    expect(seen).toEqual([
      ...Array.from({ length: 64 }, (_, index) => `https://match.test/${(index + 448) * 8}`),
      "https://match.test/sentinel"
    ])
    expect(fixture.controls.onCompleted.listenerCount).toBe(0)
  }))

  it.effect("races 128 consumers against a producer, each receiving its events in order without duplicates", () => Effect.gen(function*() {
    const random = seeded(128)
    const fixture = makeWebNavigation()
    const service = yield* ChromeWebNavigation.pipe(Effect.provide(fixture.layer))
    const wanted = Array.from({ length: 128 }, () => 1 + random(48))

    const consumers = yield* Effect.forEach(wanted, (count) => Effect.forkScoped(Stream.runCollect(
      Stream.take(service.onHistoryStateUpdated(), count).pipe(Stream.map((details) => details.timeStamp))
    )))

    fixture.controls.addFrame(1, { url: "https://app.example/" })
    let done = false
    let pushes = 0

    // Interleaves 16-event batches with scheduler turns until every consumer has finished.
    const produce: Effect.Effect<void> = Effect.suspend(() => done ? Effect.void : Effect.sync(() => {
      for (let index = 0; index < 16; index++) fixture.controls.updateHistoryState(1, `https://app.example/#${pushes++}`)
    }).pipe(Effect.andThen(Effect.yieldNow), Effect.andThen(produce)))

    const producer = yield* Effect.forkScoped(produce)

    const results = yield* Fiber.joinAll(consumers)
    done = true
    yield* Fiber.join(producer)

    results.forEach((stamps, index) => {
      expect(stamps).toHaveLength(wanted[index] ?? 0)
      expect(stamps.every((stamp, position) => position === 0 || stamp > (stamps[position - 1] ?? 0))).toBe(true)
    })
    expect(fixture.controls.onHistoryStateUpdated.listenerCount).toBe(0)
  }))

  it.effect("surfaces a failing removeListener as a defect while sibling subscriptions still clean up", () => Effect.gen(function*() {
    const mock = mockApi()
    const service = make(mock.api)
    const cause = new Error("removeListener failed")
    const first = yield* Effect.forkScoped(Effect.exit(Stream.runCollect(Stream.take(service.onTabReplaced, 1))))
    const second = yield* Effect.forkScoped(Effect.exit(Stream.runCollect(Stream.take(service.onTabReplaced, 1))))
    yield* Effect.promise(() => mock.registry.whenActive(2))
    mock.events.onTabReplaced.failNextRemoval(cause)
    mock.events.onTabReplaced.emit(replacement)
    const exits = [yield* Fiber.join(first), yield* Fiber.join(second)]
    const defects = exits.filter((exit) => Exit.hasDies(exit))
    expect(defects).toHaveLength(1)
    expect(Exit.findDefect(defects[0] ?? Exit.void)).toEqual(expect.objectContaining({ success: cause }))
    expect(exits.filter(Exit.isSuccess)).toHaveLength(1)
    // The listener whose removal threw stays registered, as it would in Chrome.
    expect(mock.events.onTabReplaced.count).toBe(1)
    expect(mock.events.onTabReplaced.removals).toBe(2)
  }))
})
