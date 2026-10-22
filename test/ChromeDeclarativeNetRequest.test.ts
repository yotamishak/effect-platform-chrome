// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Cause, Effect, Exit, Fiber, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import {
  ChromeDeclarativeNetRequest,
  ChromeDeclarativeNetRequestError,
  DYNAMIC_RULESET_ID,
  layer,
  layerLive,
  make,
  SESSION_RULESET_ID
} from "../src/ChromeDeclarativeNetRequest.js"
import type {
  ChromeDeclarativeNetRequestApi,
  ChromeDeclarativeNetRequestService,
  GetDisabledRuleIdsOptions,
  GetRulesFilter,
  MatchedRuleDebug,
  MatchedRuleInfo,
  MatchedRulesFilter,
  Rule,
  RuleCondition,
  TestMatchRequest,
  UpdateRuleOptions,
  UpdateStaticRulesOptions
} from "../src/ChromeDeclarativeNetRequest.js"
import type { EventSource } from "../src/internal/event.js"
import * as TestDeclarativeNetRequest from "../src/testing/DeclarativeNetRequest.js"
import { makeEvent } from "../src/testing/Event.js"

const block = (id: number, urlFilter: string): Rule => ({
  id, priority: 1, action: { type: "block" }, condition: { urlFilter, resourceTypes: ["script"] }
})

const debugMatch = (requestId: string): MatchedRuleDebug => ({
  rule: { ruleId: 1, rulesetId: DYNAMIC_RULESET_ID },
  request: { requestId, url: "https://ads.example/a.js", method: "get", frameId: 0, parentFrameId: -1, tabId: 3, type: "script" }
})

const matchInfo: MatchedRuleInfo = { rule: { ruleId: 1, rulesetId: DYNAMIC_RULESET_ID }, tabId: 3, timeStamp: 10 }

/** An optional Api member the fixture always provides unless told otherwise. */
const present = <F>(member: F | undefined): F => {
  if (member === undefined) throw new Error("fixture member is absent")

  return member
}

/** A promise the test opens explicitly, standing in for a Chrome call still in flight. */
const gate = () => {
  let open!: () => void
  const opened = new Promise<void>((resolve) => { open = resolve })

  return { opened, open }
}

/** An event that can be awaited until it holds a given number of listeners. */
const countedEvent = () => {
  const event = makeEvent<[MatchedRuleDebug]>()
  const waiters: Array<{ readonly count: number, readonly resolve: () => void }> = []

  const api: EventSource<[MatchedRuleDebug]> = {
    addListener: (listener) => {
      event.api.addListener(listener)

      for (const waiter of waiters.splice(0)) {
        if (event.controls.listenerCount >= waiter.count) waiter.resolve()
        else waiters.push(waiter)
      }
    },
    removeListener: (listener) => event.api.removeListener(listener)
  }

  const whenListeners = (count: number) => new Promise<void>((resolve) => {
    if (event.controls.listenerCount >= count) resolve()
    else waiters.push({ count, resolve })
  })

  return { api, controls: event.controls, whenListeners }
}

/** A call-recording API over the in-memory fixture, so each test owns fresh state. */
const mockApi = () => {
  const fixture = TestDeclarativeNetRequest.makeDeclarativeNetRequest({ enabledRulesets: ["default"], availableStaticRuleCount: 1200 })
  const { api } = fixture

  const recorded = {
    updateDynamicRules: vi.fn((options: UpdateRuleOptions) => api.updateDynamicRules(options)),
    getDynamicRules: vi.fn((filter?: GetRulesFilter) => filter === undefined ? api.getDynamicRules() : api.getDynamicRules(filter)),
    updateSessionRules: vi.fn((options: UpdateRuleOptions) => api.updateSessionRules(options)),
    getSessionRules: vi.fn((filter?: GetRulesFilter) => filter === undefined ? api.getSessionRules() : api.getSessionRules(filter)),
    updateEnabledRulesets: vi.fn((options: chrome.declarativeNetRequest.UpdateRulesetOptions) => api.updateEnabledRulesets(options)),
    getEnabledRulesets: vi.fn(() => api.getEnabledRulesets()),
    updateStaticRules: vi.fn((options: UpdateStaticRulesOptions) => present(api.updateStaticRules)(options)),
    getDisabledRuleIds: vi.fn((options: GetDisabledRuleIdsOptions) => present(api.getDisabledRuleIds)(options)),
    getAvailableStaticRuleCount: vi.fn(() => api.getAvailableStaticRuleCount()),
    isRegexSupported: vi.fn((options: chrome.declarativeNetRequest.RegexOptions) => api.isRegexSupported(options)),
    getMatchedRules: vi.fn(async (_filter?: MatchedRulesFilter) => ({ rulesMatchedInfo: [matchInfo] })),
    testMatchOutcome: vi.fn(async (_request: TestMatchRequest) => ({ matchedRules: [matchInfo.rule] })),
    setExtensionActionOptions: vi.fn((options: chrome.declarativeNetRequest.ExtensionActionOptions) => api.setExtensionActionOptions(options)),
    onRuleMatchedDebug: present(api.onRuleMatchedDebug)
  } satisfies ChromeDeclarativeNetRequestApi

  return { api: recorded, controls: fixture.controls }
}

type Operation = Exclude<keyof ChromeDeclarativeNetRequestApi, "onRuleMatchedDebug">

const operations: ReadonlyArray<Operation> = [
  "updateDynamicRules", "getDynamicRules", "updateSessionRules", "getSessionRules", "updateEnabledRulesets",
  "getEnabledRulesets", "updateStaticRules", "getDisabledRuleIds", "getAvailableStaticRuleCount", "isRegexSupported",
  "getMatchedRules", "testMatchOutcome", "setExtensionActionOptions"
]

/** One call of each operation, built when asked for so nothing reaches Chrome before it runs. */
const callOf = (rules: ChromeDeclarativeNetRequestService, operation: Operation): Effect.Effect<void, ChromeDeclarativeNetRequestError> => {
  switch (operation) {
    case "updateDynamicRules": return rules.updateDynamicRules({ addRules: [block(1, "a.example")] })
    case "getDynamicRules": return Effect.asVoid(rules.getDynamicRules())
    case "updateSessionRules": return rules.updateSessionRules({ removeRuleIds: [1] })
    case "getSessionRules": return Effect.asVoid(rules.getSessionRules({ ruleIds: [1] }))
    case "updateEnabledRulesets": return rules.updateEnabledRulesets({ enableRulesetIds: ["strict"] })
    case "getEnabledRulesets": return Effect.asVoid(rules.getEnabledRulesets)
    case "updateStaticRules": return rules.updateStaticRules({ rulesetId: "default", disableRuleIds: [1] })
    case "getDisabledRuleIds": return Effect.asVoid(rules.getDisabledRuleIds({ rulesetId: "default" }))
    case "getAvailableStaticRuleCount": return Effect.asVoid(rules.getAvailableStaticRuleCount)
    case "isRegexSupported": return Effect.asVoid(rules.isRegexSupported({ regex: "a+" }))
    case "getMatchedRules": return Effect.asVoid(rules.getMatchedRules({ tabId: 3 }))
    case "testMatchOutcome": return Effect.asVoid(rules.testMatchOutcome({ url: "https://a.example/", type: "script" }))
    case "setExtensionActionOptions": return rules.setExtensionActionOptions({ displayActionCountAsBadgeText: true })
  }
}

describe("ChromeDeclarativeNetRequest", () => {
  it.effect("updates and reads dynamic and session rules, passing filters only when given", () => Effect.gen(function*() {
    const mock = mockApi()
    const rules = make(mock.api)
    yield* rules.updateDynamicRules({ addRules: [block(1, "ads.example"), block(2, "track.example")] })
    yield* rules.updateSessionRules({ addRules: [block(1, "session.example")] })
    expect((yield* rules.getDynamicRules()).map((rule) => rule.id)).toEqual([1, 2])
    expect(yield* rules.getDynamicRules({ ruleIds: [2] })).toEqual([block(2, "track.example")])
    expect(yield* rules.getSessionRules()).toEqual([block(1, "session.example")])
    expect(yield* rules.getSessionRules({ ruleIds: [] })).toEqual([])
    expect(mock.api.getDynamicRules.mock.calls).toEqual([[], [{ ruleIds: [2] }]])
    expect(mock.api.getSessionRules.mock.calls).toEqual([[], [{ ruleIds: [] }]])
    expect(mock.api.updateDynamicRules.mock.calls).toEqual([[{ addRules: [block(1, "ads.example"), block(2, "track.example")] }]])
  }))

  it.effect("replaces dynamic and session rules with one atomic update each", () => Effect.gen(function*() {
    const mock = mockApi()
    const rules = make(mock.api)
    yield* rules.updateDynamicRules({ addRules: [block(1, "a.example"), block(2, "b.example")] })
    yield* rules.replaceDynamicRules([block(2, "c.example"), block(3, "d.example")])
    expect(mock.api.updateDynamicRules).toHaveBeenLastCalledWith({
      removeRuleIds: [1, 2], addRules: [block(2, "c.example"), block(3, "d.example")]
    })
    expect(mock.controls.dynamicRules()).toEqual([block(2, "c.example"), block(3, "d.example")])
    yield* rules.replaceSessionRules([block(9, "s.example")])
    expect(mock.api.updateSessionRules).toHaveBeenCalledExactlyOnceWith({ removeRuleIds: [], addRules: [block(9, "s.example")] })
    expect(mock.controls.sessionRules()).toEqual([block(9, "s.example")])
    yield* rules.replaceSessionRules([])
    expect(mock.api.updateSessionRules).toHaveBeenLastCalledWith({ removeRuleIds: [9], addRules: [] })
    expect(mock.controls.sessionRules()).toEqual([])
  }))

  it.effect("copies the replacement, so later changes to the caller's array do not leak in", () => Effect.gen(function*() {
    const mock = mockApi()
    const replacement = [block(1, "a.example")]
    yield* make(mock.api).replaceDynamicRules(replacement)
    expect(mock.api.updateDynamicRules.mock.calls[0]?.[0].addRules).not.toBe(replacement)
    replacement.push(block(2, "b.example"))
    expect(mock.controls.dynamicRules()).toEqual([block(1, "a.example")])
  }))

  it.effect("keeps the old rules when a replacement collides with itself", () => Effect.gen(function*() {
    const mock = mockApi()
    const rules = make(mock.api)
    yield* rules.replaceDynamicRules([block(1, "a.example")])
    const error = yield* Effect.flip(rules.replaceDynamicRules([block(4, "x.example"), block(4, "y.example")]))
    expect(error).toBeInstanceOf(ChromeDeclarativeNetRequestError)
    expect(error).toMatchObject({ operation: "updateDynamicRules" })
    expect(String(error.cause)).toContain("Rule with id 4 does not have a unique ID.")
    expect(mock.controls.dynamicRules()).toEqual([block(1, "a.example")])
  }))

  it.effect("fails a replacement at the read without writing, typed with the read's operation", () => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("Internal error while getting dynamic rules.")
    mock.api.getDynamicRules.mockRejectedValueOnce(cause)
    mock.api.getSessionRules.mockImplementationOnce(() => { throw cause })
    const rules = make(mock.api)
    expect(yield* Effect.flip(rules.replaceDynamicRules([block(1, "a.example")]))).toMatchObject({ operation: "getDynamicRules", cause })
    expect(yield* Effect.flip(rules.replaceSessionRules([]))).toMatchObject({ operation: "getSessionRules", cause })
    expect(mock.api.updateDynamicRules).not.toHaveBeenCalled()
    expect(mock.api.updateSessionRules).not.toHaveBeenCalled()
  }))

  it.effect("runs a service's writes to one rule set one at a time, so a replacement never reads a stale set", () => Effect.gen(function*() {
    const mock = mockApi()
    const read = gate()
    const realGet = mock.api.getDynamicRules.getMockImplementation()

    mock.api.getDynamicRules.mockImplementationOnce(async (filter) => {
      await read.opened

      return present(realGet)(filter)
    })

    const rules = make(mock.api)
    const first = yield* Effect.forkScoped(rules.replaceDynamicRules([block(1, "a.example")]), { startImmediately: true })
    expect(mock.api.getDynamicRules).toHaveBeenCalledTimes(1)
    const second = yield* Effect.forkScoped(rules.replaceDynamicRules([block(1, "b.example")]), { startImmediately: true })
    const update = yield* Effect.forkScoped(rules.updateDynamicRules({ addRules: [block(2, "c.example")] }), { startImmediately: true })
    // Both wait for the first replacement: neither has reached Chrome yet.
    expect(mock.api.getDynamicRules).toHaveBeenCalledTimes(1)
    expect(mock.api.updateDynamicRules).not.toHaveBeenCalled()
    // Session writes use their own permit and are not held up.
    yield* rules.updateSessionRules({ addRules: [block(1, "s.example")] })
    read.open()
    yield* Fiber.join(first)
    yield* Fiber.join(second)
    yield* Fiber.join(update)
    expect(mock.api.updateDynamicRules.mock.calls).toEqual([
      [{ removeRuleIds: [], addRules: [block(1, "a.example")] }],
      [{ removeRuleIds: [1], addRules: [block(1, "b.example")] }],
      [{ addRules: [block(2, "c.example")] }]
    ])
    expect(mock.controls.dynamicRules()).toEqual([block(1, "b.example"), block(2, "c.example")])
  }))

  it.effect("manages static rulesets and individual static rules", () => Effect.gen(function*() {
    const mock = mockApi()
    const rules = make(mock.api)
    yield* rules.updateEnabledRulesets({ disableRulesetIds: ["default"], enableRulesetIds: ["strict"] })
    expect(yield* rules.getEnabledRulesets).toEqual(["strict"])
    yield* rules.updateStaticRules({ rulesetId: "strict", disableRuleIds: [6, 5] })
    yield* rules.updateStaticRules({ rulesetId: "strict", enableRuleIds: [5] })
    expect(yield* rules.getDisabledRuleIds({ rulesetId: "strict" })).toEqual([6])
    expect(mock.api.getDisabledRuleIds).toHaveBeenCalledExactlyOnceWith({ rulesetId: "strict" })
    expect(mock.api.updateStaticRules.mock.calls).toEqual([
      [{ rulesetId: "strict", disableRuleIds: [6, 5] }], [{ rulesetId: "strict", enableRuleIds: [5] }]
    ])
    expect(yield* rules.getAvailableStaticRuleCount).toBe(1200)
    expect(mock.api.getEnabledRulesets.mock.calls).toEqual([[]])
    expect(mock.api.getAvailableStaticRuleCount.mock.calls).toEqual([[]])
  }))

  it.effect("re-runs Effect-valued operations on every run", () => Effect.gen(function*() {
    const mock = mockApi()
    const rules = make(mock.api)
    const enabled = rules.getEnabledRulesets
    expect(mock.api.getEnabledRulesets).not.toHaveBeenCalled()
    expect(yield* enabled).toEqual(["default"])
    yield* rules.updateEnabledRulesets({ enableRulesetIds: ["strict"] })
    expect(yield* enabled).toEqual(["default", "strict"])
    expect(mock.api.getEnabledRulesets).toHaveBeenCalledTimes(2)
  }))

  it.effect("unwraps matched rules and test outcomes, checks regexes and sets action options", () => Effect.gen(function*() {
    const mock = mockApi()
    const rules = make(mock.api)
    expect(yield* rules.getMatchedRules()).toEqual([matchInfo])
    yield* rules.getMatchedRules({ tabId: 3, minTimeStamp: 5 })
    expect(mock.api.getMatchedRules.mock.calls).toEqual([[], [{ tabId: 3, minTimeStamp: 5 }]])
    const request: TestMatchRequest = { url: "https://ads.example/a.js", type: "script" }
    expect(yield* rules.testMatchOutcome(request)).toEqual([matchInfo.rule])
    expect(mock.api.testMatchOutcome).toHaveBeenCalledExactlyOnceWith(request)
    expect(yield* rules.isRegexSupported({ regex: "^https://(a|b)\\.example/" })).toEqual({ isSupported: true })
    expect(yield* rules.isRegexSupported({ regex: "(" })).toEqual({ isSupported: false, reason: "syntaxError" })
    yield* rules.setExtensionActionOptions({ displayActionCountAsBadgeText: true, tabUpdate: { tabId: 3, increment: 2 } })
    expect(mock.controls.actionOptions).toEqual([{ displayActionCountAsBadgeText: true, tabUpdate: { tabId: 3, increment: 2 } }])
    expect(mock.controls.actionCount(3)).toBe(2)
  }))

  it.effect("starts getMatchedRulesFromUserGesture before its Effect runs", () => Effect.gen(function*() {
    const mock = mockApi()
    const rules = make(mock.api)
    const withFilter = rules.getMatchedRulesFromUserGesture({ tabId: 3 })
    const withoutFilter = rules.getMatchedRulesFromUserGesture()
    expect(mock.api.getMatchedRules.mock.calls).toEqual([[{ tabId: 3 }], []])
    expect(yield* withFilter).toEqual([matchInfo])
    expect(yield* withoutFilter).toEqual([matchInfo])
    // Running the Effect again does not call Chrome again: the call happened once, at the gesture.
    expect(yield* withFilter).toEqual([matchInfo])
    expect(mock.api.getMatchedRules).toHaveBeenCalledTimes(2)
  }))

  it.effect("types a gesture call's rejection and synchronous throw, even when its Effect never runs", () => Effect.gen(function*() {
    const mock = mockApi()
    const rules = make(mock.api)
    const rejected = new Error("This extension has exceeded the getMatchedRules quota.")
    const thrown = new Error("Invalid tab ID.")
    mock.api.getMatchedRules.mockRejectedValueOnce(rejected)
    mock.api.getMatchedRules.mockImplementationOnce(() => { throw thrown })
    mock.api.getMatchedRules.mockRejectedValueOnce(rejected)
    const rejection = rules.getMatchedRulesFromUserGesture()
    const throwing = rules.getMatchedRulesFromUserGesture({ tabId: -1 })
    // Never run: its rejection is still handled, so no unhandled rejection is reported.
    const neverRun = rules.getMatchedRulesFromUserGesture()
    expect(Effect.isEffect(neverRun)).toBe(true)
    const rejectionError = yield* Effect.flip(rejection)
    expect(rejectionError).toBeInstanceOf(ChromeDeclarativeNetRequestError)
    expect(rejectionError).toMatchObject({ operation: "getMatchedRules", cause: rejected })
    expect(yield* Effect.flip(throwing)).toMatchObject({ operation: "getMatchedRules", cause: thrown })
    expect(mock.api.getMatchedRules).toHaveBeenCalledTimes(3)
  }))

  it.effect.each(operations)("types a synchronous throw and a rejection from %s", (operation) => Effect.gen(function*() {
    for (const synchronous of [true, false]) {
      const cause = new Error(`${operation} failed`)

      const fail = (): Promise<never> => {
        if (synchronous) throw cause

        return Promise.reject(cause)
      }

      const api: ChromeDeclarativeNetRequestApi = { ...mockApi().api, [operation]: fail }
      const error = yield* Effect.flip(callOf(make(api), operation))
      expect(error).toBeInstanceOf(ChromeDeclarativeNetRequestError)
      expect(error).toMatchObject({ operation, cause })
    }
  }))

  it.effect.each(operations)("resolves %s after a failure, with nothing cached", (operation) => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("transient")
    mock.api[operation].mockRejectedValueOnce(cause)
    const rules = make(mock.api)
    expect(yield* Effect.flip(callOf(rules, operation))).toMatchObject({ operation, cause })
    yield* callOf(rules, operation)
    expect(mock.api[operation]).toHaveBeenCalledTimes(2)
  }))

  it.effect("fails members Chrome leaves out with a typed error naming them", () => Effect.gen(function*() {
    const fixture = TestDeclarativeNetRequest.makeDeclarativeNetRequest({
      absent: ["updateStaticRules", "getDisabledRuleIds", "testMatchOutcome", "onRuleMatchedDebug"]
    })

    expect(Object.keys(fixture.api)).not.toContain("testMatchOutcome")
    const rules = make(fixture.api)

    for (const [operation, effect] of [
      ["updateStaticRules", rules.updateStaticRules({ rulesetId: "default", disableRuleIds: [1] })],
      ["getDisabledRuleIds", rules.getDisabledRuleIds({ rulesetId: "default" })],
      ["testMatchOutcome", rules.testMatchOutcome({ url: "https://a.example/", type: "script" })],
      ["onRuleMatchedDebug", Stream.runDrain(rules.onRuleMatchedDebug)]
    ] as const) {
      const exit = yield* Effect.exit(effect)
      expect(Exit.isFailure(exit)).toBe(true)

      if (Exit.isFailure(exit)) {
        // A typed failure only: a missing event must not also die in the listener cleanup.
        expect(Cause.hasDies(exit.cause)).toBe(false)
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(ChromeDeclarativeNetRequestError)
        expect(error).toMatchObject({ operation })
        expect(String(error instanceof ChromeDeclarativeNetRequestError ? error.cause : error)).toContain(`chrome.declarativeNetRequest.${operation} is unavailable`)
      }
    }

    expect(yield* rules.getDynamicRules()).toEqual([])
  }))

  it.effect("streams debug matches while consumed and removes the listener when the stream ends", () => Effect.gen(function*() {
    const mock = mockApi()
    const rules = make(mock.api)
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(rules.onRuleMatchedDebug, 2)))
    yield* Effect.promise(() => mock.controls.onRuleMatchedDebug.waitForListener())
    expect(mock.controls.onRuleMatchedDebug.listenerCount).toBe(1)
    mock.controls.onRuleMatchedDebug.emit(debugMatch("1"))
    mock.controls.onRuleMatchedDebug.emit(debugMatch("2"))
    mock.controls.onRuleMatchedDebug.emit(debugMatch("3"))
    expect(yield* Fiber.join(fiber)).toEqual([debugMatch("1"), debugMatch("2")])
    expect(mock.controls.onRuleMatchedDebug.listenerCount).toBe(0)
  }))

  it.effect("gives each consumption its own listener and removes it on interruption", () => Effect.gen(function*() {
    const event = countedEvent()
    const rules = make({ ...mockApi().api, onRuleMatchedDebug: event.api })
    const first = yield* Effect.forkScoped(Stream.runCollect(Stream.take(rules.onRuleMatchedDebug, 1)))
    const second = yield* Effect.forkScoped(Stream.runDrain(rules.onRuleMatchedDebug))
    yield* Effect.promise(() => event.whenListeners(2))
    event.controls.emit(debugMatch("1"))
    expect(yield* Fiber.join(first)).toEqual([debugMatch("1")])
    expect(event.controls.listenerCount).toBe(1)
    yield* Fiber.interrupt(second)
    expect(event.controls.listenerCount).toBe(0)
  }))

  it.effect("types a failed registration or lookup and leaves no listener", () => Effect.gen(function*() {
    const mock = mockApi()
    const rules = make(mock.api)
    const cause = new Error("requires declarativeNetRequestFeedback")
    mock.controls.onRuleMatchedDebug.failNext("addListener", cause)
    const error = yield* Effect.flip(Stream.runDrain(rules.onRuleMatchedDebug))
    expect(error).toBeInstanceOf(ChromeDeclarativeNetRequestError)
    expect(error).toMatchObject({ operation: "onRuleMatchedDebug", cause })
    expect(mock.controls.onRuleMatchedDebug.listenerCount).toBe(0)

    const getter: ChromeDeclarativeNetRequestApi = {
      ...mock.api,
      get onRuleMatchedDebug(): EventSource<[MatchedRuleDebug]> { throw cause }
    }

    expect(yield* Effect.flip(Stream.runDrain(make(getter).onRuleMatchedDebug))).toMatchObject({ operation: "onRuleMatchedDebug", cause })
    // A failed subscription does not poison the next one.
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(rules.onRuleMatchedDebug, 1)))
    yield* Effect.promise(() => mock.controls.onRuleMatchedDebug.waitForListener())
    mock.controls.onRuleMatchedDebug.emit(debugMatch("after"))
    expect(yield* Fiber.join(fiber)).toEqual([debugMatch("after")])
  }))

  it.effect("looks the event up only when a stream starts", () => Effect.gen(function*() {
    const mock = mockApi()
    let lookups = 0

    const counting: ChromeDeclarativeNetRequestApi = {
      ...mock.api,
      get onRuleMatchedDebug() {
        lookups += 1

        return mock.api.onRuleMatchedDebug
      }
    }

    const rules = make(counting)
    expect(lookups).toBe(0)
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(rules.onRuleMatchedDebug, 1)))
    yield* Effect.promise(() => mock.controls.onRuleMatchedDebug.waitForListener())
    mock.controls.onRuleMatchedDebug.emit(debugMatch("1"))
    yield* Fiber.join(fiber)
    expect(lookups).toBe(1)
  }))

  it.effect("provides the fixture layer and reads the global only when the live layer builds", () => Effect.gen(function*() {
    const fixture = TestDeclarativeNetRequest.makeDeclarativeNetRequest()

    const ids = yield* Effect.gen(function*() {
      const rules = yield* ChromeDeclarativeNetRequest
      yield* rules.replaceDynamicRules([block(7, "a.example")])

      return (yield* rules.getDynamicRules()).map((rule) => rule.id)
    }).pipe(Effect.provide(fixture.layer))

    expect(ids).toEqual([7])
    expect(yield* Effect.flatMap(ChromeDeclarativeNetRequest, (rules) => rules.getDynamicRules()).pipe(Effect.provide(layer(fixture.api))))
      .toEqual([block(7, "a.example")])
    // No chrome global at all, as in a Node test or a page without extension APIs.
    expect("chrome" in globalThis).toBe(false)
    const missing = yield* Effect.flip(ChromeDeclarativeNetRequest.pipe(Effect.provide(layerLive)))
    expect(missing).toBeInstanceOf(ChromeDeclarativeNetRequestError)
    expect(missing).toMatchObject({ operation: "initialize" })
    expect(String(missing.cause)).toContain("chrome.declarativeNetRequest is unavailable")
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", {})), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeDeclarativeNetRequest.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
    vi.stubGlobal("chrome", { declarativeNetRequest: fixture.api })
    expect(yield* Effect.flatMap(ChromeDeclarativeNetRequest, (rules) => rules.getDynamicRules()).pipe(Effect.provide(layerLive)))
      .toEqual([block(7, "a.example")])
  }))

  it("exports Chrome's reserved ruleset ids", () => {
    expect([DYNAMIC_RULESET_ID, SESSION_RULESET_ID]).toEqual(["_dynamic", "_session"])
  })
})

describe("DeclarativeNetRequest fixture", () => {
  const run = <A>(promise: () => Promise<A>) => Effect.tryPromise(promise)
  const rejection = <A>(promise: () => Promise<A>) => Effect.map(Effect.flip(run(promise)), (error) => String(error.cause))

  it.effect("rejects id collisions and invalid ids atomically, with Chrome's messages", () => Effect.gen(function*() {
    const { api, controls } = TestDeclarativeNetRequest.makeDeclarativeNetRequest()
    yield* run(() => api.updateDynamicRules({ addRules: [block(1, "a.example")] }))
    expect(yield* rejection(() => api.updateDynamicRules({ addRules: [block(2, "b.example"), block(1, "c.example")] })))
      .toContain("Rule with id 1 does not have a unique ID.")
    expect(controls.dynamicRules()).toEqual([block(1, "a.example")])
    yield* run(() => api.updateDynamicRules({ removeRuleIds: [1, 99], addRules: [block(1, "c.example")] }))
    expect(controls.dynamicRules()).toEqual([block(1, "c.example")])
    expect(yield* rejection(() => api.updateSessionRules({ addRules: [block(0, "z.example")] })))
      .toContain("Rule with id 0 has an invalid value for id key. This should be greater than or equal to 1.")
    expect(yield* rejection(() => api.updateSessionRules({ addRules: [block(1.5, "z.example")] }))).toContain("Rule with id 1.5 has an invalid value for id key")
    expect(yield* rejection(() => api.updateSessionRules({ addRules: [{ ...block(3, "z.example"), priority: 0 }] })))
      .toContain("Rule with id 3 has an invalid value for priority key. This should be greater than or equal to 1.")
    expect(controls.sessionRules()).toEqual([])
    // An empty update is a no-op, as in Chrome.
    yield* run(() => api.updateDynamicRules({}))
    expect(controls.dynamicRules()).toEqual([block(1, "c.example")])
  }))

  const invalidConditions: ReadonlyArray<readonly [RuleCondition, string]> = [
    [{ urlFilter: "a", resourceTypes: [] }, "Rule with id 5 cannot have an empty list as the value for resourceTypes key."],
    [{ requestDomains: [] }, "Rule with id 5 cannot have an empty list as the value for requestDomains key."],
    [{ urlFilter: "a", regexFilter: "a" }, "Rule with id 5 can only specify one of \"urlFilter\" or \"regexFilter\" keys."],
    [{ urlFilter: "" }, "Rule with id 5 cannot have an empty value for urlFilter key."],
    [{ regexFilter: "" }, "Rule with id 5 cannot have an empty value for regexFilter key."],
    [{ urlFilter: "\u0444" }, "Rule with id 5 cannot have non-ascii characters as part of \"urlFilter\" key."],
    [{ regexFilter: "(?=a)b" }, "Rule with id 5 specifies an incorrect value for the \"regexFilter\" key."],
    [{ tabIds: [3] }, "Rule with id 5 specifies a value for \"tabIds\" or \"excludedTabIds\" key. These are only supported for session-scoped rules."]
  ]

  it.effect.each(invalidConditions)("rejects an invalid dynamic rule: %j", ([condition, message]) => Effect.gen(function*() {
    const { api, controls } = TestDeclarativeNetRequest.makeDeclarativeNetRequest()
    const rule: Rule = { id: 5, action: { type: "block" }, condition }
    expect(yield* rejection(() => api.updateDynamicRules({ addRules: [block(1, "kept.example"), rule] }))).toContain(message)
    expect(controls.dynamicRules()).toEqual([])
  }))

  it.effect("accepts tab conditions on session rules only", () => Effect.gen(function*() {
    const { api, controls } = TestDeclarativeNetRequest.makeDeclarativeNetRequest()
    const rule: Rule = { id: 1, action: { type: "block" }, condition: { tabIds: [3], excludedTabIds: [-1] } }
    yield* run(() => api.updateSessionRules({ addRules: [rule] }))
    expect(controls.sessionRules()).toEqual([rule])
    expect(yield* rejection(() => api.updateDynamicRules({ addRules: [{ ...rule, condition: { excludedTabIds: [4] } }] })))
      .toContain("These are only supported for session-scoped rules.")
  }))

  it.effect("keeps dynamic and session id spaces apart and returns copies", () => Effect.gen(function*() {
    const { api, controls } = TestDeclarativeNetRequest.makeDeclarativeNetRequest()
    yield* run(() => api.updateDynamicRules({ addRules: [block(1, "a.example")] }))
    yield* run(() => api.updateSessionRules({ addRules: [block(1, "b.example")] }))
    const [rule] = yield* run(() => api.getSessionRules())
    expect(rule).toEqual(block(1, "b.example"))
    rule?.condition.resourceTypes?.push("image")
    const added = block(2, "c.example")
    yield* run(() => api.updateSessionRules({ addRules: [added] }))
    added.condition.resourceTypes?.push("image")
    expect(controls.sessionRules()).toEqual([block(1, "b.example"), block(2, "c.example")])
    expect(controls.dynamicRules()).toEqual([block(1, "a.example")])
  }))

  it.effect("keeps insertion order across removals and filters by id", () => Effect.gen(function*() {
    const { api } = TestDeclarativeNetRequest.makeDeclarativeNetRequest()
    yield* run(() => api.updateDynamicRules({ addRules: [block(3, "c"), block(1, "a"), block(2, "b")] }))
    yield* run(() => api.updateDynamicRules({ removeRuleIds: [1], addRules: [block(1, "again")] }))
    expect((yield* run(() => api.getDynamicRules())).map((rule) => rule.id)).toEqual([3, 2, 1])
    expect((yield* run(() => api.getDynamicRules({ ruleIds: [1, 3, 42] }))).map((rule) => rule.id)).toEqual([3, 1])
    expect(yield* run(() => api.getDynamicRules({ ruleIds: [] }))).toEqual([])
  }))

  it.effect("lets enable win over disable, validates declared rulesets and caps enabled ones at 50", () => Effect.gen(function*() {
    const declared = Array.from({ length: 60 }, (_, index) => `set-${index}`)
    const { api, controls } = TestDeclarativeNetRequest.makeDeclarativeNetRequest({ rulesets: declared, enabledRulesets: ["set-0"] })
    yield* run(() => api.updateEnabledRulesets({ disableRulesetIds: ["set-0", "set-1"], enableRulesetIds: ["set-1"] }))
    expect(controls.enabledRulesets()).toEqual(["set-0", "set-1"].filter((id) => id !== "set-0"))
    expect(yield* rejection(() => api.updateEnabledRulesets({ enableRulesetIds: ["set-2", "missing"] }))).toContain("Invalid ruleset id: missing.")
    expect(yield* rejection(() => api.updateEnabledRulesets({ disableRulesetIds: ["gone"] }))).toContain("Invalid ruleset id: gone.")
    expect(controls.enabledRulesets()).toEqual(["set-1"])
    yield* run(() => api.updateEnabledRulesets({ enableRulesetIds: declared.slice(0, 50) }))
    expect(controls.enabledRulesets()).toHaveLength(50)
    expect(yield* rejection(() => api.updateEnabledRulesets({ enableRulesetIds: ["set-50"] })))
      .toContain("The number of enabled static rulesets exceeds the enabled ruleset count limit.")
    yield* run(() => api.updateEnabledRulesets({ disableRulesetIds: ["set-0"], enableRulesetIds: ["set-50"] }))
    expect(controls.enabledRulesets()).toHaveLength(50)
    expect(controls.enabledRulesets()).toContain("set-50")
    expect(controls.enabledRulesets()).not.toContain("set-0")
  }))

  it.effect("accepts any ruleset id when none are declared", () => Effect.gen(function*() {
    const { api } = TestDeclarativeNetRequest.makeDeclarativeNetRequest()
    yield* run(() => api.updateEnabledRulesets({ enableRulesetIds: ["anything"] }))
    yield* run(() => present(api.updateStaticRules)({ rulesetId: "anything", disableRuleIds: [1] }))
    expect(yield* run(() => api.getEnabledRulesets())).toEqual(["anything"])
    expect(yield* run(() => present(api.getDisabledRuleIds)({ rulesetId: "unknown" }))).toEqual([])
  }))

  it.effect("lets disable win over enable, sorts disabled ids and caps them at 5000 across rulesets", () => Effect.gen(function*() {
    const { api, controls } = TestDeclarativeNetRequest.makeDeclarativeNetRequest({ rulesets: ["a", "b"] })
    const updateStaticRules = present(api.updateStaticRules)
    const getDisabledRuleIds = present(api.getDisabledRuleIds)
    yield* run(() => updateStaticRules({ rulesetId: "a", disableRuleIds: [9, 3, 7], enableRuleIds: [3] }))
    expect(yield* run(() => getDisabledRuleIds({ rulesetId: "a" }))).toEqual([3, 7, 9])
    yield* run(() => updateStaticRules({ rulesetId: "a", enableRuleIds: [7, 100] }))
    expect(controls.disabledRuleIds("a")).toEqual([3, 9])
    expect(yield* rejection(() => updateStaticRules({ rulesetId: "c", disableRuleIds: [1] }))).toContain("Invalid ruleset id: c.")
    expect(yield* rejection(() => getDisabledRuleIds({ rulesetId: "c" }))).toContain("Invalid ruleset id: c.")
    yield* run(() => updateStaticRules({ rulesetId: "b", disableRuleIds: Array.from({ length: 4998 }, (_, index) => index + 1) }))
    expect(yield* rejection(() => updateStaticRules({ rulesetId: "a", disableRuleIds: [1] })))
      .toContain("The number of disabled static rules exceeds the disabled rule count limit.")
    expect(controls.disabledRuleIds("a")).toEqual([3, 9])
    // Re-enabling and disabling in one call stays within the limit.
    yield* run(() => updateStaticRules({ rulesetId: "a", disableRuleIds: [1], enableRuleIds: [3] }))
    expect(controls.disabledRuleIds("a")).toEqual([1, 9])
    yield* run(() => updateStaticRules({ rulesetId: "a", enableRuleIds: [1, 9] }))
    expect(yield* run(() => getDisabledRuleIds({ rulesetId: "a" }))).toEqual([])
  }))

  it.effect("approximates RE2 in isRegexSupported", () => Effect.gen(function*() {
    const { api } = TestDeclarativeNetRequest.makeDeclarativeNetRequest()

    const supported = (regex: string, isCaseSensitive?: boolean) =>
      run(() => api.isRegexSupported(isCaseSensitive === undefined ? { regex } : { regex, isCaseSensitive }))
        .pipe(Effect.map((result) => result.isSupported))

    for (const regex of ["^https://a\\.example/", "\\(?=", "[(?=]", "a(?:b)c", "(a)|\\\\", "[\\1]"]) {
      expect(yield* supported(regex)).toBe(true)
    }

    for (const regex of ["(?=a)", "(?!a)", "(?<=a)b", "(?<!a)b", "(a)\\1", "(?<x>a)\\k<x>", "(", "[a"]) {
      expect(yield* supported(regex)).toBe(false)
    }

    expect(yield* supported("A", false)).toBe(true)
    expect(yield* run(() => api.isRegexSupported({ regex: "(?=x)" }))).toEqual({ isSupported: false, reason: "syntaxError" })
  }))

  it.effect("returns recorded matches filtered by tab and an inclusive minimum timestamp", () => Effect.gen(function*() {
    const { api, controls } = TestDeclarativeNetRequest.makeDeclarativeNetRequest()
    const at = (tabId: number, timeStamp: number): MatchedRuleInfo => ({ rule: { ruleId: timeStamp, rulesetId: SESSION_RULESET_ID }, tabId, timeStamp })
    expect(yield* run(() => api.getMatchedRules())).toEqual({ rulesMatchedInfo: [] })
    const recorded = at(1, 10)
    controls.recordMatch(recorded)
    recorded.tabId = 99
    controls.recordMatch(at(2, 20))
    controls.recordMatch(at(-1, 30))
    expect(yield* run(() => api.getMatchedRules())).toEqual({ rulesMatchedInfo: [at(1, 10), at(2, 20), at(-1, 30)] })
    expect(yield* run(() => api.getMatchedRules({ tabId: -1 }))).toEqual({ rulesMatchedInfo: [at(-1, 30)] })
    expect(yield* run(() => api.getMatchedRules({ minTimeStamp: 20 }))).toEqual({ rulesMatchedInfo: [at(2, 20), at(-1, 30)] })
    expect(yield* run(() => api.getMatchedRules({ tabId: 1, minTimeStamp: 11 }))).toEqual({ rulesMatchedInfo: [] })
  }))

  it.effect("validates test requests like Chrome and matches nothing", () => Effect.gen(function*() {
    const { api } = TestDeclarativeNetRequest.makeDeclarativeNetRequest()
    const testMatchOutcome = present(api.testMatchOutcome)
    expect(yield* run(() => testMatchOutcome({ url: "https://a.example/", type: "main_frame", tabId: -1 }))).toEqual({ matchedRules: [] })
    expect(yield* rejection(() => testMatchOutcome({ url: "not a url", type: "script" }))).toContain("Invalid test request URL.")
    expect(yield* rejection(() => testMatchOutcome({ url: "https://a.example/", initiator: "::", type: "script" })))
      .toContain("Invalid test request initiator.")
    expect(yield* rejection(() => testMatchOutcome({ url: "https://a.example/", tabId: -2, type: "script" })))
      .toContain("Invalid test request tab ID.")
    expect(yield* rejection(() => testMatchOutcome({ url: "https://a.example/", topUrl: "", type: "script" })))
      .toContain("Invalid test request top URL.")
  }))

  it.effect("keeps the badge preference and clamped action counts, rejecting tab updates while it is off", () => Effect.gen(function*() {
    const { api, controls } = TestDeclarativeNetRequest.makeDeclarativeNetRequest()
    expect(yield* rejection(() => api.setExtensionActionOptions({ tabUpdate: { tabId: 1, increment: 1 } })))
      .toContain("Cannot increment action count unless displaying action count as badge text.")
    expect(controls.actionOptions).toEqual([])
    yield* run(() => api.setExtensionActionOptions({ displayActionCountAsBadgeText: true, tabUpdate: { tabId: 1, increment: 2 } }))
    yield* run(() => api.setExtensionActionOptions({ tabUpdate: { tabId: 1, increment: -5 } }))
    expect(controls.actionCount(1)).toBe(0)
    yield* run(() => api.setExtensionActionOptions({ tabUpdate: { tabId: 1, increment: 3 } }))
    expect(controls.actionCount(1)).toBe(3)
    // Switching the preference off is stored even though the tab update in the same call is refused.
    expect(yield* rejection(() => api.setExtensionActionOptions({ displayActionCountAsBadgeText: false, tabUpdate: { tabId: 1, increment: 1 } })))
      .toContain("Cannot increment action count")
    expect(controls.displayActionCountAsBadgeText()).toBe(false)
    expect(controls.actionOptions).toHaveLength(3)
    const preset = TestDeclarativeNetRequest.makeDeclarativeNetRequest({ displayActionCountAsBadgeText: true })
    yield* run(() => preset.api.setExtensionActionOptions({ tabUpdate: { tabId: 2, increment: 1 } }))
    expect(preset.controls.actionCount(2)).toBe(1)
  }))

  it.effect("reports the configured available static rule count", () => Effect.gen(function*() {
    const fixture = TestDeclarativeNetRequest.makeDeclarativeNetRequest()
    expect(yield* run(() => fixture.api.getAvailableStaticRuleCount())).toBe(30000)
    fixture.controls.setAvailableStaticRuleCount(0)
    expect(yield* run(() => fixture.api.getAvailableStaticRuleCount())).toBe(0)
  }))

  it.effect.each(operations)("fails %s once per queued cause, then recovers", (operation) => Effect.gen(function*() {
    const fixture = TestDeclarativeNetRequest.makeDeclarativeNetRequest()
    const rules = make(fixture.api)
    const first = new Error("first")
    const second = new Error("second")
    fixture.controls.failNext(operation, first)
    fixture.controls.failNext(operation, second)
    expect(yield* Effect.flip(callOf(rules, operation))).toMatchObject({ operation, cause: first })
    expect(yield* Effect.flip(callOf(rules, operation))).toMatchObject({ operation, cause: second })
    yield* callOf(rules, operation)
  }))

  it.effect("replaces members through overrides", () => Effect.gen(function*() {
    const getEnabledRulesets = vi.fn(async () => ["override"])
    const fixture = TestDeclarativeNetRequest.makeDeclarativeNetRequest({}, { getEnabledRulesets })
    expect(yield* make(fixture.api).getEnabledRulesets).toEqual(["override"])
    expect(getEnabledRulesets).toHaveBeenCalledOnce()
  }))
})
