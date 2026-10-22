// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import {
  ChromeDeclarativeNetRequest,
  ChromeDeclarativeNetRequestError,
  layerLive,
  make
} from "../src/ChromeDeclarativeNetRequest.js"
import type { ChromeDeclarativeNetRequestApi, MatchedRuleDebug, Rule } from "../src/ChromeDeclarativeNetRequest.js"
import * as TestDeclarativeNetRequest from "../src/testing/DeclarativeNetRequest.js"

const block = (id: number, urlFilter: string): Rule => ({
  id, priority: 1, action: { type: "block" }, condition: { urlFilter, resourceTypes: ["script"] }
})

const matched: MatchedRuleDebug = {
  rule: { ruleId: 1, rulesetId: "_dynamic" },
  request: { requestId: "1", url: "https://ads.example/a.js", method: "get", frameId: 0, parentFrameId: -1, tabId: 3, type: "script" }
}

/** A call-recording API over the in-memory fixture, so each test owns fresh state. */
const mockApi = () => {
  const fixture = TestDeclarativeNetRequest.makeDeclarativeNetRequest({ enabledRulesets: ["default"], availableStaticRuleCount: 1200 })
  const { api } = fixture

  const recorded = {
    ...api,
    updateDynamicRules: vi.fn((options: chrome.declarativeNetRequest.UpdateRuleOptions) => api.updateDynamicRules(options)),
    getDynamicRules: vi.fn((filter?: chrome.declarativeNetRequest.GetRulesFilter) => filter === undefined ? api.getDynamicRules() : api.getDynamicRules(filter)),
    updateSessionRules: vi.fn((options: chrome.declarativeNetRequest.UpdateRuleOptions) => api.updateSessionRules(options)),
    getSessionRules: vi.fn((filter?: chrome.declarativeNetRequest.GetRulesFilter) => filter === undefined ? api.getSessionRules() : api.getSessionRules(filter)),
    getMatchedRules: vi.fn(async (_filter?: chrome.declarativeNetRequest.MatchedRulesFilter) => ({
      rulesMatchedInfo: [{ rule: matched.rule, tabId: 3, timeStamp: 10 }]
    })),
    testMatchOutcome: vi.fn(async (_request: chrome.declarativeNetRequest.TestMatchRequestDetails) => ({ matchedRules: [matched.rule] })),
    getDisabledRuleIds: vi.fn((options: chrome.declarativeNetRequest.GetDisabledRuleIdsOptions) => api.getDisabledRuleIds(options))
  } satisfies ChromeDeclarativeNetRequestApi

  return { api: recorded, controls: fixture.controls }
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
    expect(mock.api.getDynamicRules.mock.calls).toEqual([[], [{ ruleIds: [2] }]])
    expect(mock.api.getSessionRules.mock.calls).toEqual([[]])
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

  it.effect("manages static rulesets and individual static rules", () => Effect.gen(function*() {
    const mock = mockApi()
    const rules = make(mock.api)
    yield* rules.updateEnabledRulesets({ disableRulesetIds: ["default"], enableRulesetIds: ["strict"] })
    expect(yield* rules.getEnabledRulesets).toEqual(["strict"])
    yield* rules.updateStaticRules({ rulesetId: "strict", disableRuleIds: [5, 6] })
    yield* rules.updateStaticRules({ rulesetId: "strict", enableRuleIds: [5] })
    expect(yield* rules.getDisabledRuleIds("strict")).toEqual([6])
    expect(mock.api.getDisabledRuleIds).toHaveBeenCalledExactlyOnceWith({ rulesetId: "strict" })
    expect(yield* rules.getAvailableStaticRuleCount).toBe(1200)
  }))

  it.effect("unwraps matched rules and test outcomes and checks regexes", () => Effect.gen(function*() {
    const mock = mockApi()
    const rules = make(mock.api)
    expect(yield* rules.getMatchedRules()).toEqual([{ rule: matched.rule, tabId: 3, timeStamp: 10 }])
    yield* rules.getMatchedRules({ tabId: 3 })
    expect(mock.api.getMatchedRules.mock.calls).toEqual([[], [{ tabId: 3 }]])
    expect(yield* rules.testMatchOutcome({ url: "https://ads.example/a.js", type: "script" })).toEqual([matched.rule])
    expect(yield* rules.isRegexSupported({ regex: "^https://(a|b)\\.example/" })).toEqual({ isSupported: true })
    expect(yield* rules.isRegexSupported({ regex: "(" })).toEqual({ isSupported: false, reason: "syntaxError" })
    yield* rules.setExtensionActionOptions({ displayActionCountAsBadgeText: true })
    expect(mock.controls.actionOptions).toEqual([{ displayActionCountAsBadgeText: true }])
  }))

  it.effect("streams debug matches while consumed and types a failed registration", () => Effect.gen(function*() {
    const mock = mockApi()
    const rules = make(mock.api)
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(rules.onRuleMatchedDebug, 1)))
    yield* Effect.promise(() => mock.controls.onRuleMatchedDebug.waitForListener())
    mock.controls.onRuleMatchedDebug.emit(matched)
    expect(yield* Fiber.join(fiber)).toEqual([matched])
    expect(mock.controls.onRuleMatchedDebug.listenerCount).toBe(0)
    const cause = new Error("requires declarativeNetRequestFeedback")
    mock.controls.onRuleMatchedDebug.failNext("addListener", cause)
    expect(yield* Effect.flip(Stream.runDrain(rules.onRuleMatchedDebug))).toMatchObject({ operation: "onRuleMatchedDebug", cause })
    expect(mock.controls.onRuleMatchedDebug.listenerCount).toBe(0)
  }))

  it.effect("types rejected calls with their operation", () => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("This extension has exceeded the getMatchedRules quota.")
    mock.api.getMatchedRules.mockRejectedValueOnce(cause)
    mock.api.getSessionRules.mockRejectedValueOnce(cause)
    const rules = make(mock.api)
    expect(yield* Effect.flip(rules.getMatchedRules())).toMatchObject({ operation: "getMatchedRules", cause })
    expect(yield* Effect.flip(rules.replaceSessionRules([]))).toMatchObject({ operation: "getSessionRules", cause })
    expect(mock.api.updateSessionRules).not.toHaveBeenCalled()
  }))

  it.effect("provides the fixture layer and reads the global only when the live layer builds", () => Effect.gen(function*() {
    const fixture = TestDeclarativeNetRequest.makeDeclarativeNetRequest()

    const ids = yield* Effect.gen(function*() {
      const rules = yield* ChromeDeclarativeNetRequest
      yield* rules.replaceDynamicRules([block(7, "a.example")])

      return (yield* rules.getDynamicRules()).map((rule) => rule.id)
    }).pipe(Effect.provide(fixture.layer))

    expect(ids).toEqual([7])
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", {})), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeDeclarativeNetRequest.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
  }))
})

describe("DeclarativeNetRequest fixture", () => {
  it.effect("rejects id collisions atomically, as Chrome does", () => Effect.gen(function*() {
    const { api, controls } = TestDeclarativeNetRequest.makeDeclarativeNetRequest()
    yield* Effect.promise(() => api.updateDynamicRules({ addRules: [block(1, "a.example")] }))
    const collision = yield* Effect.flip(Effect.tryPromise(() => api.updateDynamicRules({ addRules: [block(2, "b.example"), block(1, "c.example")] })))
    expect(String(collision.cause)).toContain("Rule with id 1 does not have a unique ID.")
    expect(controls.dynamicRules()).toEqual([block(1, "a.example")])
    yield* Effect.promise(() => api.updateDynamicRules({ removeRuleIds: [1, 99], addRules: [block(1, "c.example")] }))
    expect(controls.dynamicRules()).toEqual([block(1, "c.example")])
    const invalid = yield* Effect.flip(Effect.tryPromise(() => api.updateSessionRules({ addRules: [block(0, "z.example")] })))
    expect(String(invalid.cause)).toContain("Rule with id 0")
  }))

  it.effect("keeps dynamic and session id spaces apart and returns copies", () => Effect.gen(function*() {
    const { api, controls } = TestDeclarativeNetRequest.makeDeclarativeNetRequest()
    yield* Effect.promise(() => api.updateDynamicRules({ addRules: [block(1, "a.example")] }))
    yield* Effect.promise(() => api.updateSessionRules({ addRules: [block(1, "b.example")] }))
    const [rule] = yield* Effect.promise(() => api.getSessionRules())
    expect(rule).toEqual(block(1, "b.example"))
    rule?.condition.resourceTypes?.push("image")
    expect(controls.sessionRules()).toEqual([block(1, "b.example")])
    expect(controls.dynamicRules()).toEqual([block(1, "a.example")])
  }))
})
