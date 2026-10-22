// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Cause, Deferred, Effect, Exit, Fiber, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeDeclarativeNetRequestError, DYNAMIC_RULESET_ID, make } from "../../src/ChromeDeclarativeNetRequest.js"
import type {
  ChromeDeclarativeNetRequestApi,
  ChromeDeclarativeNetRequestService,
  GetRulesFilter,
  MatchedRuleDebug,
  Rule,
  UpdateRuleOptions
} from "../../src/ChromeDeclarativeNetRequest.js"
import type { EventSource } from "../../src/internal/event.js"
import * as TestDeclarativeNetRequest from "../../src/testing/DeclarativeNetRequest.js"
import { makeEvent } from "../../src/testing/Event.js"

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

const pick = <A>(random: () => number, values: ReadonlyArray<A>): A => {
  const value = values[Math.floor(random() * values.length)]

  if (value === undefined) throw new Error("pick from an empty list")

  return value
}

const block = (id: number, urlFilter = `host-${id}.example`): Rule => ({
  id, action: { type: "block" }, condition: { urlFilter, resourceTypes: ["script"] }
})

const redirect = (id: number): Rule => ({
  id, action: { type: "redirect", redirect: { url: "https://safe.example/" } }, condition: { urlFilter: `r-${id}` }
})

const regexRule = (id: number): Rule => ({ id, action: { type: "block" }, condition: { regexFilter: `^https://r${id}\\.example/` } })

const range = (from: number, count: number): Array<number> => Array.from({ length: count }, (_, index) => from + index)

const debugMatch = (requestId: string): MatchedRuleDebug => ({
  rule: { ruleId: 1, rulesetId: DYNAMIC_RULESET_ID },
  request: { requestId, url: "https://ads.example/a.js", method: "get", frameId: 0, parentFrameId: -1, tabId: 3, type: "script" }
})

/** An event counting registration attempts and removals, awaitable until it holds N listeners. */
const trackedEvent = () => {
  const event = makeEvent<[MatchedRuleDebug]>()
  const waiters: Array<{ readonly count: number, readonly resolve: () => void }> = []
  const counts = { attempts: 0, removals: 0 }

  const api: EventSource<[MatchedRuleDebug]> = {
    addListener: (listener) => {
      counts.attempts += 1
      event.api.addListener(listener)

      for (const waiter of waiters.splice(0)) {
        if (event.controls.listenerCount >= waiter.count) waiter.resolve()
        else waiters.push(waiter)
      }
    },
    removeListener: (listener) => {
      counts.removals += 1
      event.api.removeListener(listener)
    }
  }

  const whenListeners = (count: number) => new Promise<void>((resolve) => {
    if (event.controls.listenerCount >= count) resolve()
    else waiters.push({ count, resolve })
  })

  return { api, controls: event.controls, counts, whenListeners }
}

/** A promise the test opens explicitly, standing in for a Chrome call still in flight. */
const gate = () => {
  let open!: () => void
  const opened = new Promise<void>((resolve) => { open = resolve })

  return { opened, open }
}

const withEvent = (source: EventSource<[MatchedRuleDebug]>): ChromeDeclarativeNetRequestApi => ({
  ...TestDeclarativeNetRequest.makeDeclarativeNetRequest().api,
  onRuleMatchedDebug: source
})

describe("ChromeDeclarativeNetRequest stress", () => {
  it.effect("keeps exactly the newest 64 of a 4096-event burst, in order, per consumer, and removes every listener", () => Effect.gen(function*() {
    const event = trackedEvent()
    const rules = make(withEvent(event.api))
    const consumers = 8
    const release = yield* Deferred.make<void>()
    const primed = yield* Effect.forEach(range(0, consumers), () => Deferred.make<void>())

    const fibers = yield* Effect.forEach(primed, (ready) => Effect.forkScoped(rules.onRuleMatchedDebug.pipe(
      // Each consumer holds the primer until the whole burst has been emitted.
      Stream.mapEffect((info) => info.request.requestId === "primer"
        ? Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(info))
        : Effect.succeed(info)),
      Stream.takeUntil((info) => info.request.requestId === "4095"),
      Stream.runCollect
    )))

    yield* Effect.promise(() => event.whenListeners(consumers))
    event.controls.emit(debugMatch("primer"))
    yield* Effect.forEach(primed, Deferred.await, { discard: true })

    for (const index of range(0, 4096)) event.controls.emit(debugMatch(String(index)))

    yield* Deferred.succeed(release, undefined)
    const expected = ["primer", ...range(4032, 64).map(String)]

    for (const fiber of fibers) {
      expect((yield* Fiber.join(fiber)).map((info) => info.request.requestId)).toEqual(expected)
    }

    expect(event.controls.listenerCount).toBe(0)
    expect(event.counts).toEqual({ attempts: consumers, removals: consumers })
  }))

  it.effect("churns 512 subscriptions, interrupting them at every stage, and ends with zero listeners", () => Effect.gen(function*() {
    const random = seeded(512)
    const event = trackedEvent()
    const rules = make(withEvent(event.api))
    const stages = range(0, 512).map(() => pick(random, ["unstarted", "registered", "delivering", "completed", "failed"] as const))
    const count = (stage: (typeof stages)[number]) => stages.filter((each) => each === stage).length
    expect(stages.filter((stage, index) => stages.indexOf(stage) === index)).toHaveLength(5)

    // Forked and interrupted before they ever run.
    for (const _ of range(0, count("unstarted"))) {
      const fiber = yield* Effect.forkChild(Stream.runDrain(rules.onRuleMatchedDebug))
      yield* Fiber.interrupt(fiber)
    }

    expect(event.controls.listenerCount).toBe(0)
    const blocked = yield* Deferred.make<void>()
    const registered = yield* Effect.forEach(range(0, count("registered")), () => Effect.forkScoped(Stream.runDrain(rules.onRuleMatchedDebug)))

    const delivering = yield* Effect.forEach(range(0, count("delivering")), () => Effect.gen(function*() {
      const received = yield* Deferred.make<void>()

      const fiber = yield* Effect.forkScoped(rules.onRuleMatchedDebug.pipe(
        Stream.mapEffect(() => Deferred.succeed(received, undefined).pipe(Effect.andThen(Deferred.await(blocked)))),
        Stream.runDrain
      ))

      return { fiber, received }
    }))

    const completed = yield* Effect.forEach(range(0, count("completed")), () =>
      Effect.forkScoped(Stream.runCollect(Stream.take(rules.onRuleMatchedDebug, 3))))

    const live = registered.length + delivering.length + completed.length
    yield* Effect.promise(() => event.whenListeners(live))
    expect(event.controls.listenerCount).toBe(live)
    // Registered and idle: interrupted before any event arrives.
    yield* Fiber.interruptAll(registered)
    expect(event.controls.listenerCount).toBe(delivering.length + completed.length)

    for (const index of range(0, 3)) event.controls.emit(debugMatch(String(index)))

    for (const fiber of completed) {
      expect((yield* Fiber.join(fiber)).map((info) => info.request.requestId)).toEqual(["0", "1", "2"])
    }

    // Mid-delivery: each holds an event in its pipeline when interrupted.
    yield* Effect.forEach(delivering, ({ received }) => Deferred.await(received), { discard: true })
    expect(event.controls.listenerCount).toBe(delivering.length)
    yield* Fiber.interruptAll(delivering.map(({ fiber }) => fiber))
    expect(event.controls.listenerCount).toBe(0)
    // Registration failures: every one typed, every one cleaned up.
    const causes = range(0, count("failed")).map((index) => new Error(`registration ${index} refused`))

    for (const cause of causes) event.controls.failNext("addListener", cause)

    const failures = yield* Effect.forEach(causes, () => Effect.flip(Stream.runDrain(rules.onRuleMatchedDebug)), { concurrency: "unbounded" })

    for (const error of failures) {
      expect(error).toBeInstanceOf(ChromeDeclarativeNetRequestError)
      expect(error.operation).toBe("onRuleMatchedDebug")
    }

    expect(new Set(failures.map((error) => error.cause))).toEqual(new Set(causes))
    expect(event.controls.listenerCount).toBe(0)
    expect(event.counts.removals).toBe(event.counts.attempts)
    expect(event.counts.attempts).toBeGreaterThanOrEqual(live + causes.length)
  }))

  it.effect("types 1536 concurrent calls with interleaved rejections and synchronous throws by the member that failed", () => Effect.gen(function*() {
    const random = seeded(1536)
    const calls: Array<{ readonly member: string, readonly message: string, readonly failed: boolean }> = []
    const counters = new Map<string, number>()

    // Settles after 0-3 extra microtask hops, so completions interleave across calls.
    const settle = <A>(member: string, value: (n: number) => A): Promise<A> => {
      const n = counters.get(member) ?? 0
      counters.set(member, n + 1)
      const mode = pick(random, ["resolve", "reject", "throw"] as const)
      const message = `${member}#${n}:${mode}`
      calls.push({ member, message, failed: mode !== "resolve" })

      if (mode === "throw") throw new Error(message)

      let pending = Promise.resolve()

      for (const _ of range(0, Math.floor(random() * 4))) pending = pending.then(() => undefined)

      return pending.then(() => {
        if (mode === "reject") throw new Error(message)

        return value(n)
      })
    }

    const api: ChromeDeclarativeNetRequestApi = {
      updateDynamicRules: () => settle("updateDynamicRules", () => undefined),
      getDynamicRules: () => settle("getDynamicRules", (n) => [block(n + 1)]),
      updateSessionRules: () => settle("updateSessionRules", () => undefined),
      getSessionRules: () => settle("getSessionRules", (n) => [block(n + 1)]),
      updateEnabledRulesets: () => settle("updateEnabledRulesets", () => undefined),
      getEnabledRulesets: () => settle("getEnabledRulesets", (n) => [`set-${n}`]),
      updateStaticRules: () => settle("updateStaticRules", () => undefined),
      getDisabledRuleIds: () => settle("getDisabledRuleIds", (n) => [n]),
      getAvailableStaticRuleCount: () => settle("getAvailableStaticRuleCount", (n) => n),
      isRegexSupported: () => settle("isRegexSupported", () => ({ isSupported: true })),
      getMatchedRules: () => settle("getMatchedRules", (n) => ({ rulesMatchedInfo: [{ rule: { ruleId: n, rulesetId: "_dynamic" }, tabId: 1, timeStamp: n }] })),
      testMatchOutcome: () => settle("testMatchOutcome", (n) => ({ matchedRules: [{ ruleId: n, rulesetId: "_session" }] })),
      setExtensionActionOptions: () => settle("setExtensionActionOptions", () => undefined),
      onRuleMatchedDebug: makeEvent<[MatchedRuleDebug]>().api
    }

    const rules = make(api)

    const tasks: ReadonlyArray<readonly [ReadonlyArray<string>, (service: ChromeDeclarativeNetRequestService) => Effect.Effect<unknown, ChromeDeclarativeNetRequestError>]> = [
      [["updateDynamicRules"], (service) => service.updateDynamicRules({ addRules: [block(1)] })],
      [["getDynamicRules"], (service) => service.getDynamicRules()],
      [["getDynamicRules", "updateDynamicRules"], (service) => service.replaceDynamicRules([block(1)])],
      [["updateSessionRules"], (service) => service.updateSessionRules({ removeRuleIds: [1] })],
      [["getSessionRules"], (service) => service.getSessionRules({ ruleIds: [1] })],
      [["getSessionRules", "updateSessionRules"], (service) => service.replaceSessionRules([])],
      [["updateEnabledRulesets"], (service) => service.updateEnabledRulesets({ enableRulesetIds: ["a"] })],
      [["getEnabledRulesets"], (service) => service.getEnabledRulesets],
      [["updateStaticRules"], (service) => service.updateStaticRules({ rulesetId: "a", disableRuleIds: [1] })],
      [["getDisabledRuleIds"], (service) => service.getDisabledRuleIds({ rulesetId: "a" })],
      [["getAvailableStaticRuleCount"], (service) => service.getAvailableStaticRuleCount],
      [["isRegexSupported"], (service) => service.isRegexSupported({ regex: "a" })],
      [["getMatchedRules"], (service) => service.getMatchedRules()],
      [["getMatchedRules"], (service) => Effect.suspend(() => service.getMatchedRulesFromUserGesture({ tabId: 1 }))],
      [["testMatchOutcome"], (service) => service.testMatchOutcome({ url: "https://a.example/", type: "script" })],
      [["setExtensionActionOptions"], (service) => service.setExtensionActionOptions({ displayActionCountAsBadgeText: true })]
    ]

    const planned = range(0, 1536).map(() => pick(random, tasks))

    const exits = yield* Effect.forEach(planned, ([members, run]) => Effect.map(Effect.exit(run(rules)), (exit) => ({ members, exit })), {
      concurrency: "unbounded"
    })

    const surfaced: Array<string> = []

    for (const { members, exit } of exits) {
      if (Exit.isSuccess(exit)) continue

      expect(Cause.hasDies(exit.cause)).toBe(false)
      expect(Cause.hasInterrupts(exit.cause)).toBe(false)
      const error = Cause.squash(exit.cause)
      expect(error).toBeInstanceOf(ChromeDeclarativeNetRequestError)

      if (!(error instanceof ChromeDeclarativeNetRequestError) || !(error.cause instanceof Error)) throw new Error("untyped failure")

      const [member] = error.cause.message.split("#")
      expect(error.operation).toBe(member)
      expect(members).toContain(error.operation)
      surfaced.push(error.cause.message)
    }

    // Every failed Chrome call surfaced exactly once, and nothing else failed.
    const failed = calls.flatMap((call) => call.failed ? [call.message] : [])
    expect([...surfaced].sort()).toEqual([...failed].sort())
    expect(failed.length).toBeGreaterThan(600)
    expect(exits.length - surfaced.length).toBeGreaterThan(300)
  }))

  it.effect("applies 512 concurrent replacements and updates as if one at a time, never reading a stale set", () => Effect.gen(function*() {
    const random = seeded(4242)
    const fixture = TestDeclarativeNetRequest.makeDeclarativeNetRequest()
    const applied: Array<{ readonly scope: "dynamic" | "session", readonly options: UpdateRuleOptions }> = []

    const api: ChromeDeclarativeNetRequestApi = {
      ...fixture.api,
      updateDynamicRules: (options) => {
        applied.push({ scope: "dynamic", options: structuredClone(options) })

        return fixture.api.updateDynamicRules(options)
      },
      updateSessionRules: (options) => {
        applied.push({ scope: "session", options: structuredClone(options) })

        return fixture.api.updateSessionRules(options)
      }
    }

    const rules = make(api)
    let nextUnique = 100000

    const operations = range(0, 512).map((index) => {
      const kind = pick(random, ["replaceDynamic", "replaceSession", "addDynamic", "addSession"] as const)
      // Replacements reuse a small id space, so a stale read would collide.
      const replacement = range(1 + Math.floor(random() * 5), 1 + Math.floor(random() * 6)).map((id) => block(id, `v${index}`))

      switch (kind) {
        case "replaceDynamic": return rules.replaceDynamicRules(replacement)
        case "replaceSession": return rules.replaceSessionRules(replacement)
        case "addDynamic": return rules.updateDynamicRules({ addRules: [block(nextUnique++)] })
        case "addSession": return rules.updateSessionRules({ addRules: [block(nextUnique++)] })
      }
    })

    yield* Effect.all(operations, { concurrency: "unbounded", discard: true })
    expect(applied).toHaveLength(512)
    // Replaying the recorded writes in order reproduces the final sets, and every
    // replacement removed exactly the ids present when it ran.
    const replay = { dynamic: new Map<number, Rule>(), session: new Map<number, Rule>() }

    for (const { scope, options } of applied) {
      const set = replay[scope]

      if (options.removeRuleIds !== undefined) expect([...options.removeRuleIds].sort((a, b) => a - b)).toEqual(Array.from(set.keys()).sort((a, b) => a - b))

      for (const id of options.removeRuleIds ?? []) set.delete(id)

      for (const rule of options.addRules ?? []) set.set(rule.id, rule)
    }

    expect([...fixture.controls.dynamicRules()].sort((a, b) => a.id - b.id)).toEqual(Array.from(replay.dynamic.values()).sort((a, b) => a.id - b.id))
    expect([...fixture.controls.sessionRules()].sort((a, b) => a.id - b.id)).toEqual(Array.from(replay.session.values()).sort((a, b) => a.id - b.id))
  }))

  it.effect("releases the write permit when a replacement is interrupted waiting, reading or writing", () => Effect.gen(function*() {
    const fixture = TestDeclarativeNetRequest.makeDeclarativeNetRequest()
    const read = gate()
    const write = gate()
    const getDynamicRules = vi.fn((filter?: GetRulesFilter) => filter === undefined ? fixture.api.getDynamicRules() : fixture.api.getDynamicRules(filter))
    const updateDynamicRules = vi.fn((options: UpdateRuleOptions) => fixture.api.updateDynamicRules(options))
    const rules = make({ ...fixture.api, getDynamicRules, updateDynamicRules })

    // Interrupted while its read is in flight; the read's late result is ignored.
    getDynamicRules.mockImplementationOnce(async () => {
      await read.opened

      return fixture.api.getDynamicRules()
    })

    const reading = yield* Effect.forkScoped(rules.replaceDynamicRules([block(1, "reading")]), { startImmediately: true })
    const waiting = yield* Effect.forkScoped(rules.replaceDynamicRules([block(1, "waiting")]), { startImmediately: true })
    expect(getDynamicRules).toHaveBeenCalledTimes(1)
    yield* Fiber.interrupt(waiting)
    yield* Fiber.interrupt(reading)
    read.open()
    // Interrupted while its write is in flight: Chrome still applies it.
    const writeStarted = gate()
    let landed: Promise<void> = Promise.resolve()

    updateDynamicRules.mockImplementationOnce((options) => {
      writeStarted.open()
      landed = write.opened.then(() => fixture.api.updateDynamicRules(options))

      return landed
    })

    const writing = yield* Effect.forkScoped(rules.replaceDynamicRules([block(2, "writing")]), { startImmediately: true })
    yield* Effect.promise(() => writeStarted.opened)
    // Chrome cannot cancel the write, so the interruption waits for it before freeing the permit.
    const interrupting = yield* Effect.forkScoped(Fiber.interrupt(writing), { startImmediately: true })
    const after = yield* Effect.forkScoped(rules.replaceDynamicRules([block(3, "after")]), { startImmediately: true })
    expect(getDynamicRules).toHaveBeenCalledTimes(2)
    expect(interrupting.pollUnsafe()).toBeUndefined()
    write.open()
    yield* Fiber.join(interrupting)
    expect(Exit.hasInterrupts(yield* Fiber.await(writing))).toBe(true)
    yield* Effect.promise(() => landed)
    yield* Fiber.join(after)
    expect(fixture.controls.dynamicRules()).toEqual([block(3, "after")])
    expect(updateDynamicRules.mock.calls.map(([options]) => options)).toEqual([
      { removeRuleIds: [], addRules: [block(2, "writing")] },
      { removeRuleIds: [2], addRules: [block(3, "after")] }
    ])
  }))

  it.effect("interrupts 512 queued writers at random and lets the rest run in order", () => Effect.gen(function*() {
    const random = seeded(99)
    const fixture = TestDeclarativeNetRequest.makeDeclarativeNetRequest()
    const read = gate()
    const updateDynamicRules = vi.fn((options: UpdateRuleOptions) => fixture.api.updateDynamicRules(options))
    const getDynamicRules = vi.fn((filter?: GetRulesFilter) => filter === undefined ? fixture.api.getDynamicRules() : fixture.api.getDynamicRules(filter))

    getDynamicRules.mockImplementationOnce(async () => {
      await read.opened

      return fixture.api.getDynamicRules()
    })

    const rules = make({ ...fixture.api, getDynamicRules, updateDynamicRules })
    const holder = yield* Effect.forkScoped(rules.replaceDynamicRules([block(1, "holder")]), { startImmediately: true })

    const queued = yield* Effect.forEach(range(0, 512), (index) => Effect.forkScoped(
      index % 2 === 0 ? rules.replaceDynamicRules([block(1, `q${index}`)]) : rules.updateDynamicRules({ removeRuleIds: [10000 + index] }),
      { startImmediately: true }
    ))

    expect(getDynamicRules).toHaveBeenCalledTimes(1)
    const cancelled = queued.filter(() => random() < 0.5)
    yield* Fiber.interruptAll(cancelled)
    read.open()
    yield* Fiber.join(holder)
    const survivors = queued.filter((fiber) => !cancelled.includes(fiber))
    yield* Effect.forEach(survivors, Fiber.join, { discard: true })
    expect(updateDynamicRules).toHaveBeenCalledTimes(1 + survivors.length)
    expect(fixture.controls.dynamicRules()).toHaveLength(1)
  }))

  it.effect("holds Chrome's rule-count limits at full size and leaves the set unchanged when exceeded", () => Effect.gen(function*() {
    const fixture = TestDeclarativeNetRequest.makeDeclarativeNetRequest()
    const rules = make(fixture.api)
    const full = range(1, 30000).map((id) => block(id))
    yield* rules.replaceDynamicRules(full)
    expect(fixture.controls.dynamicRules()).toHaveLength(30000)
    const overflow = yield* Effect.flip(rules.updateDynamicRules({ addRules: [block(30001)] }))
    expect(overflow).toMatchObject({ operation: "updateDynamicRules" })
    expect(String(overflow.cause)).toContain("Dynamic rule count exceeded.")
    // Replacing every rule at the limit is one atomic swap that stays within it.
    yield* rules.replaceDynamicRules(range(30001, 30000).map((id) => block(id)))
    const current = yield* rules.getDynamicRules()
    expect(current).toHaveLength(30000)
    expect(current[0]?.id).toBe(30001)
    expect((yield* rules.getDynamicRules({ ruleIds: range(50001, 20000) })).map((rule) => rule.id)).toEqual(range(50001, 10000))
    yield* rules.replaceDynamicRules([])
    // Unsafe rules: 5000 of them, then one more is refused.
    yield* rules.updateDynamicRules({ addRules: range(1, 5000).map(redirect) })
    expect(String((yield* Effect.flip(rules.updateDynamicRules({ addRules: [redirect(5001)] }))).cause)).toContain("Dynamic unsafe rule count exceeded.")
    yield* rules.updateDynamicRules({ addRules: [block(5001)] })
    yield* rules.replaceDynamicRules([])
    // Session rules: 5000, then one more is refused.
    yield* rules.replaceSessionRules(range(1, 5000).map((id) => block(id)))
    expect(String((yield* Effect.flip(rules.updateSessionRules({ addRules: [block(5001)] }))).cause)).toContain("Session rule count exceeded.")
    expect(fixture.controls.sessionRules()).toHaveLength(5000)
    yield* rules.replaceSessionRules([])
    // Regex rules: one budget of 1000 shared by dynamic and session rules.
    yield* rules.updateDynamicRules({ addRules: range(1, 600).map(regexRule) })
    yield* rules.updateSessionRules({ addRules: range(1, 400).map(regexRule) })
    expect(String((yield* Effect.flip(rules.updateSessionRules({ addRules: [regexRule(401)] }))).cause)).toContain("Session rule count for regex rules exceeded.")
    expect(String((yield* Effect.flip(rules.updateDynamicRules({ addRules: [regexRule(601)] }))).cause)).toContain("Dynamic rule count for regex rules exceeded.")
    yield* rules.updateDynamicRules({ removeRuleIds: [1], addRules: [regexRule(601)] })
    expect(fixture.controls.dynamicRules()).toHaveLength(600)
    expect(fixture.controls.sessionRules()).toHaveLength(400)
  }))

  it.effect("never reads a stale set when 384 writers are interrupted at random points while Chrome queues their updates", () => Effect.gen(function*() {
    const random = seeded(384)
    const fixture = TestDeclarativeNetRequest.makeDeclarativeNetRequest()
    /** Settles after `count` microtask hops. */
    const hops = (count: number): Promise<void> => range(0, count).reduce((pending) => pending.then(() => undefined), Promise.resolve())
    const applied: Array<{ readonly scope: "dynamic" | "session", readonly options: UpdateRuleOptions }> = []
    const rejected: Array<unknown> = []
    /** The operations whose replacement Chrome has but has not applied yet. */
    const inFlight = new Set<number>()
    const operationOf = (options: UpdateRuleOptions) => Number(options.addRules?.[0]?.condition.urlFilter?.slice(3) ?? Number.NaN)
    // Chrome applies updates one at a time in call order, each a few hops after the last,
    // but serves reads immediately from the current set.
    let tail: Promise<unknown> = Promise.resolve()

    const queued = (scope: "dynamic" | "session", apply: (options: UpdateRuleOptions) => Promise<void>) => (options: UpdateRuleOptions) => {
      const delay = Math.floor(random() * 6)
      const operation = operationOf(options)
      inFlight.add(operation)

      const result = tail.then(() => hops(delay)).then(() => apply(options)).finally(() => inFlight.delete(operation)).then(
        () => { applied.push({ scope, options: structuredClone(options) }) },
        (cause: unknown) => {
          rejected.push(cause)
          throw cause
        }
      )

      tail = result.catch(() => undefined)

      return result
    }

    const rules = make({
      ...fixture.api,
      updateDynamicRules: queued("dynamic", (options) => fixture.api.updateDynamicRules(options)),
      updateSessionRules: queued("session", (options) => fixture.api.updateSessionRules(options))
    })

    const fibers: Array<Fiber.Fiber<void, ChromeDeclarativeNetRequestError>> = []
    const interrupters: Array<Fiber.Fiber<void>> = []

    for (const index of range(0, 384)) {
      // Every replacement reuses ids 1..k, so one built from a stale read collides.
      const replacement = range(1, 1 + Math.floor(random() * 4)).map((id) => block(id, `op-${index}`))

      const operations = {
        replaceDynamic: rules.replaceDynamicRules(replacement),
        replaceSession: rules.replaceSessionRules(replacement),
        removeDynamic: rules.updateDynamicRules({ removeRuleIds: [1] })
      }

      const kind = pick(random, ["replaceDynamic", "replaceSession", "removeDynamic"] as const)
      fibers.push(yield* Effect.forkScoped(operations[kind], { startImmediately: true }))

      if (random() < 0.4) {
        // Half the time, a writer whose update Chrome already holds.
        const writer = inFlight.size > 0 && random() < 0.5 ? fibers[pick(random, Array.from(inFlight))] : undefined
        const target = writer ?? pick(random, fibers)
        interrupters.push(yield* Effect.forkScoped(Fiber.interrupt(target), { startImmediately: true }))
      }

      yield* Effect.promise(() => hops(Math.floor(random() * 8)))
    }

    yield* Effect.forEach(interrupters, Fiber.join, { discard: true })
    const exits = yield* Effect.forEach(fibers, Fiber.await)
    yield* Effect.promise(() => tail)
    // No write ever collided with a rule its replacement failed to see.
    expect(rejected).toEqual([])

    for (const exit of exits) {
      if (Exit.isFailure(exit)) expect(Exit.hasInterrupts(exit) && !Cause.hasFails(exit.cause)).toBe(true)
    }

    const interrupted = exits.filter(Exit.hasInterrupts).length
    expect(interrupted).toBeGreaterThan(40)
    expect(exits.length - interrupted).toBeGreaterThan(150)

    // Some writers were interrupted after Chrome already had their update.
    const writtenThenInterrupted = exits.filter((exit, index) => Exit.hasInterrupts(exit)
      && applied.some(({ options }) => options.addRules?.some((rule) => rule.condition.urlFilter === `op-${index}`))).length

    expect(writtenThenInterrupted).toBeGreaterThan(5)
    // Replaying Chrome's applied updates in order reproduces the final sets, and every
    // replacement removed exactly the ids present when Chrome applied it.
    const replay = { dynamic: new Map<number, Rule>(), session: new Map<number, Rule>() }

    for (const { scope, options } of applied) {
      const set = replay[scope]

      if (options.addRules !== undefined) expect([...(options.removeRuleIds ?? [])].sort((a, b) => a - b)).toEqual(Array.from(set.keys()).sort((a, b) => a - b))

      for (const id of options.removeRuleIds ?? []) set.delete(id)

      for (const rule of options.addRules ?? []) set.set(rule.id, rule)
    }

    expect(fixture.controls.dynamicRules()).toEqual(Array.from(replay.dynamic.values()))
    expect(fixture.controls.sessionRules()).toEqual(Array.from(replay.session.values()))
  }))

  it.effect("starts 4096 gesture calls at once, settling run and abandoned ones without leaks", () => Effect.gen(function*() {
    const random = seeded(4096)
    const modes = range(0, 4096).map(() => pick(random, ["resolve", "reject", "throw"] as const))
    let call = 0

    const api: ChromeDeclarativeNetRequestApi = {
      ...TestDeclarativeNetRequest.makeDeclarativeNetRequest().api,
      getMatchedRules: (filter) => {
        const index = call++
        const mode = modes[index]

        if (mode === "throw") throw new Error(`throw ${index}`)

        return mode === "reject"
          ? Promise.reject(new Error(`reject ${index}`))
          : Promise.resolve({ rulesMatchedInfo: [{ rule: { ruleId: index, rulesetId: "_dynamic" }, tabId: filter?.tabId ?? -1, timeStamp: index }] })
      }
    }

    const rules = make(api)
    const started = range(0, 4096).map((index) => rules.getMatchedRulesFromUserGesture({ tabId: index }))
    expect(call).toBe(4096)
    // Every other call is abandoned: its settlement is still handled.
    const results = yield* Effect.forEach(started.filter((_, index) => index % 2 === 0), Effect.exit, { concurrency: "unbounded" })

    results.forEach((exit, position) => {
      const index = position * 2

      if (modes[index] === "resolve") {
        expect(exit).toEqual(Exit.succeed([{ rule: { ruleId: index, rulesetId: "_dynamic" }, tabId: index, timeStamp: index }]))
      } else {
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({ operation: "getMatchedRules", cause: new Error(`${modes[index]} ${index}`) })
      }
    })
  }))
})
