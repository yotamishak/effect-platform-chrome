import { Context, Effect, Exit, Layer, Schema, Semaphore, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeDeclarativeNetRequestError extends Schema.TaggedError<ChromeDeclarativeNetRequestError>()(
  "ChromeDeclarativeNetRequestError",
  {
    operation: Schema.String,
    cause: Schema.Defect()
  }
) {}

/** The `rulesetId` Chrome reports for matched dynamic rules (`chrome.declarativeNetRequest.DYNAMIC_RULESET_ID`). */
export const DYNAMIC_RULESET_ID = "_dynamic"

/** The `rulesetId` Chrome reports for matched session rules (`chrome.declarativeNetRequest.SESSION_RULESET_ID`). */
export const SESSION_RULESET_ID = "_session"

export type Rule = chrome.declarativeNetRequest.Rule

export type RuleAction = chrome.declarativeNetRequest.RuleAction

export type RuleCondition = chrome.declarativeNetRequest.RuleCondition

export type UpdateRuleOptions = chrome.declarativeNetRequest.UpdateRuleOptions

export type GetRulesFilter = chrome.declarativeNetRequest.GetRulesFilter

export type UpdateRulesetOptions = chrome.declarativeNetRequest.UpdateRulesetOptions

export type UpdateStaticRulesOptions = chrome.declarativeNetRequest.UpdateStaticRulesOptions

export type GetDisabledRuleIdsOptions = chrome.declarativeNetRequest.GetDisabledRuleIdsOptions

export type RegexOptions = chrome.declarativeNetRequest.RegexOptions

export type RegexSupport = chrome.declarativeNetRequest.IsRegexSupportedResult

export type MatchedRule = chrome.declarativeNetRequest.MatchedRule

export type MatchedRuleInfo = chrome.declarativeNetRequest.MatchedRuleInfo

export type MatchedRulesFilter = chrome.declarativeNetRequest.MatchedRulesFilter

export type RulesMatchedDetails = chrome.declarativeNetRequest.RulesMatchedDetails

export type MatchedRuleDebug = chrome.declarativeNetRequest.MatchedRuleInfoDebug

export type RequestDetails = chrome.declarativeNetRequest.RequestDetails

export type ExtensionActionOptions = chrome.declarativeNetRequest.ExtensionActionOptions

export type TestMatchRequest = chrome.declarativeNetRequest.TestMatchRequestDetails

export type TestMatchOutcomeResult = chrome.declarativeNetRequest.TestMatchOutcomeResult

/**
 * The Promise-based MV3 subset this module needs. Members Chrome leaves out of some
 * contexts are optional, so injected APIs without them still fit; using one that is absent
 * fails with the typed error for that member.
 */
export interface ChromeDeclarativeNetRequestApi {
  updateDynamicRules(options: UpdateRuleOptions): Promise<void>
  getDynamicRules(filter?: GetRulesFilter): Promise<Array<Rule>>
  updateSessionRules(options: UpdateRuleOptions): Promise<void>
  getSessionRules(filter?: GetRulesFilter): Promise<Array<Rule>>
  updateEnabledRulesets(options: UpdateRulesetOptions): Promise<void>
  getEnabledRulesets(): Promise<Array<string>>
  getAvailableStaticRuleCount(): Promise<number>
  isRegexSupported(regexOptions: RegexOptions): Promise<RegexSupport>
  getMatchedRules(filter?: MatchedRulesFilter): Promise<RulesMatchedDetails>
  setExtensionActionOptions(options: ExtensionActionOptions): Promise<void>
  /** Chrome 111+. */
  readonly updateStaticRules?: (options: UpdateStaticRulesOptions) => Promise<void>
  /** Chrome 111+. */
  readonly getDisabledRuleIds?: (options: GetDisabledRuleIdsOptions) => Promise<Array<number>>
  /** Chrome 103+, and only in unpacked extensions: Chrome omits it from packed ones. */
  readonly testMatchOutcome?: (request: TestMatchRequest) => Promise<TestMatchOutcomeResult>
  /** Only in unpacked extensions with `declarativeNetRequestFeedback`: Chrome omits it otherwise. */
  readonly onRuleMatchedDebug?: EventSource<[info: MatchedRuleDebug]>
}

/**
 * Declarative request blocking, redirecting and header rewriting. Dynamic rules persist
 * across browser restarts and extension updates; session rules live in memory until the
 * browser closes or the extension updates; static rulesets ship in the package
 * (`declarative_net_request.rule_resources`) and can only be enabled, disabled or have
 * individual rules switched off.
 *
 * Each service runs its dynamic-rule writes (`updateDynamicRules`, `replaceDynamicRules`)
 * one at a time, and likewise its session-rule writes, so a replacement's read and write
 * are never interleaved with another write from the same service. Chrome queues rule
 * updates but serves reads at once and cannot cancel an update it has, so interrupting a
 * writer (or timing it out) waits for Chrome to settle its update before the next one
 * starts.
 */
export interface ChromeDeclarativeNetRequestService {
  /**
   * Removes `removeRuleIds` (unknown ids are ignored) and then adds `addRules`, as one
   * atomic change: Chrome applies all of it or rejects with the typed error and changes
   * nothing, such as on a repeated or still-present rule id, an invalid rule, or the 30000
   * dynamic (5000 unsafe) rule limit. Dynamic and session rules share one budget of 1000
   * regex rules.
   */
  readonly updateDynamicRules: (options: UpdateRuleOptions) => Effect.Effect<void, ChromeDeclarativeNetRequestError>
  /** The dynamic rules, all of them or only those whose id is in `filter.ruleIds`. */
  readonly getDynamicRules: (filter?: GetRulesFilter) => Effect.Effect<Array<Rule>, ChromeDeclarativeNetRequestError>
  /**
   * Makes `rules` the whole dynamic rule set: reads the current ids, then removes them and
   * adds `rules` in a single atomic `updateDynamicRules`. Writes through this service wait
   * for each other; writes from another extension context (a popup, another service) can
   * still land between the read and the write.
   */
  readonly replaceDynamicRules: (rules: ReadonlyArray<Rule>) => Effect.Effect<void, ChromeDeclarativeNetRequestError>
  /**
   * Like `updateDynamicRules` for in-memory session rules (5000 rules, 5000 unsafe). Only
   * session rules may use the `tabIds` and `excludedTabIds` conditions.
   */
  readonly updateSessionRules: (options: UpdateRuleOptions) => Effect.Effect<void, ChromeDeclarativeNetRequestError>
  /** The session rules, all of them or only those whose id is in `filter.ruleIds`. */
  readonly getSessionRules: (filter?: GetRulesFilter) => Effect.Effect<Array<Rule>, ChromeDeclarativeNetRequestError>
  /** Like `replaceDynamicRules` for session rules. */
  readonly replaceSessionRules: (rules: ReadonlyArray<Rule>) => Effect.Effect<void, ChromeDeclarativeNetRequestError>
  /**
   * Disables then enables static rulesets by manifest id; an id in both lists ends up
   * enabled. Rejects unknown ids and more than 50 enabled rulesets or the static rule
   * limit, changing nothing. The choice persists across sessions but resets to the
   * manifest's `enabled` flags on extension update.
   */
  readonly updateEnabledRulesets: (options: UpdateRulesetOptions) => Effect.Effect<void, ChromeDeclarativeNetRequestError>
  /** The ids of the enabled static rulesets. */
  readonly getEnabledRulesets: Effect.Effect<Array<string>, ChromeDeclarativeNetRequestError>
  /**
   * Switches individual rules of one static ruleset off or on (Chrome 111+); an id in both
   * lists ends up disabled. At most 5000 rules can be disabled across all rulesets. Changes
   * to a disabled ruleset apply when it is next enabled.
   */
  readonly updateStaticRules: (options: UpdateStaticRulesOptions) => Effect.Effect<void, ChromeDeclarativeNetRequestError>
  /** The ids of the switched-off rules in one static ruleset, ascending (Chrome 111+). */
  readonly getDisabledRuleIds: (options: GetDisabledRuleIdsOptions) => Effect.Effect<Array<number>, ChromeDeclarativeNetRequestError>
  /** How many more static rules can be enabled before the browser-wide limit is reached. */
  readonly getAvailableStaticRuleCount: Effect.Effect<number, ChromeDeclarativeNetRequestError>
  /** Whether Chrome's RE2 accepts a `regexFilter`; when it does not, `reason` says why. */
  readonly isRegexSupported: (regexOptions: RegexOptions) => Effect.Effect<RegexSupport, ChromeDeclarativeNetRequestError>
  /**
   * Rules matched recently (within five minutes unless the document is still active),
   * optionally only for `filter.tabId` (-1 for requests without an open tab) and at or
   * after `filter.minTimeStamp`. Needs `declarativeNetRequestFeedback`, or `activeTab`
   * granted for `filter.tabId`. Chrome allows 20 calls per 10 minutes and rejects the rest;
   * calls made within a user gesture are exempt, which this lazy call cannot guarantee:
   * use `getMatchedRulesFromUserGesture` in gesture handlers.
   */
  readonly getMatchedRules: (filter?: MatchedRulesFilter) => Effect.Effect<Array<MatchedRuleInfo>, ChromeDeclarativeNetRequestError>
  /**
   * Explicit native boundary: calls `getMatchedRules` NOW, not when the returned Effect
   * runs, so a call made synchronously inside a user gesture is exempt from the quota.
   */
  readonly getMatchedRulesFromUserGesture: (
    filter?: MatchedRulesFilter
  ) => Effect.Effect<Array<MatchedRuleInfo>, ChromeDeclarativeNetRequestError>
  /**
   * The rules that would act on a hypothetical request, in Chrome's evaluation order
   * (Chrome 103+). Unpacked extensions only: elsewhere it fails with the typed error.
   */
  readonly testMatchOutcome: (request: TestMatchRequest) => Effect.Effect<Array<MatchedRule>, ChromeDeclarativeNetRequestError>
  /**
   * Shows the per-tab matched-action count as badge text (a persisted preference) and/or
   * adjusts a tab's count by `tabUpdate.increment`. Chrome rejects a `tabUpdate` unless the
   * count is displayed as badge text.
   */
  readonly setExtensionActionOptions: (options: ExtensionActionOptions) => Effect.Effect<void, ChromeDeclarativeNetRequestError>
  /**
   * Every rule match, for debugging: unpacked extensions with `declarativeNetRequestFeedback`
   * only; elsewhere the stream fails with the typed error. Observational like every stream
   * here; it cannot wake an MV3 service worker (use `ChromeServiceWorker.listen`) and
   * buffers at most 64 events, dropping the oldest.
   */
  readonly onRuleMatchedDebug: Stream.Stream<MatchedRuleDebug, ChromeDeclarativeNetRequestError>
}

export class ChromeDeclarativeNetRequest extends Context.Service<ChromeDeclarativeNetRequest, ChromeDeclarativeNetRequestService>()(
  "effect-platform-chrome/ChromeDeclarativeNetRequest"
) {}

const fail = (operation: string, cause: unknown) => new ChromeDeclarativeNetRequestError({ operation, cause })

const invoke = invoker(fail)

const unavailable = (member: string) => new Error(`chrome.declarativeNetRequest.${member} is unavailable in this context`)

/** Attach both settlement handlers immediately, even if the returned Effect is never run. */
const getMatchedRulesImmediately = (
  api: ChromeDeclarativeNetRequestApi,
  filter: MatchedRulesFilter | undefined
): Effect.Effect<RulesMatchedDetails, ChromeDeclarativeNetRequestError> => {
  try {
    const pending = filter === undefined ? api.getMatchedRules() : api.getMatchedRules(filter)

    const outcome: Promise<Exit.Exit<RulesMatchedDetails, ChromeDeclarativeNetRequestError>> = pending.then(
      (details) => Exit.succeed(details),
      (cause) => Exit.fail(fail("getMatchedRules", cause))
    )

    return Effect.flatMap(Effect.promise(() => outcome), (exit) => exit)
  } catch (cause) {
    return Effect.fail(fail("getMatchedRules", cause))
  }
}

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeDeclarativeNetRequestApi): ChromeDeclarativeNetRequestService => {
  // One permit per rule set: a replacement's read-then-write is a critical section.
  const dynamicWrites = Semaphore.makeUnsafe(1)
  const sessionWrites = Semaphore.makeUnsafe(1)

  // Chrome queues rule updates but serves reads at once, and cannot cancel an update it
  // has. An interrupted writer therefore keeps the permit until Chrome settles its update;
  // otherwise the next replacement could read the set before that update lands.
  const updateDynamicRules = (options: UpdateRuleOptions) => Effect.uninterruptible(
    invoke("updateDynamicRules", () => api.updateDynamicRules(options))
  )

  const getDynamicRules = (filter?: GetRulesFilter) => invoke("getDynamicRules", () => filter === undefined
    ? api.getDynamicRules()
    : api.getDynamicRules(filter))

  const updateSessionRules = (options: UpdateRuleOptions) => Effect.uninterruptible(
    invoke("updateSessionRules", () => api.updateSessionRules(options))
  )

  const getSessionRules = (filter?: GetRulesFilter) => invoke("getSessionRules", () => filter === undefined
    ? api.getSessionRules()
    : api.getSessionRules(filter))

  const replace = (
    current: Effect.Effect<Array<Rule>, ChromeDeclarativeNetRequestError>,
    update: (options: UpdateRuleOptions) => Effect.Effect<void, ChromeDeclarativeNetRequestError>
  ) => (rules: ReadonlyArray<Rule>) => Effect.flatMap(current, (existing) => update({
    removeRuleIds: existing.map((rule) => rule.id),
    addRules: [...rules]
  }))

  return ChromeDeclarativeNetRequest.of({
    updateDynamicRules: (options) => dynamicWrites.withPermit(updateDynamicRules(options)),
    getDynamicRules,
    replaceDynamicRules: (rules) => dynamicWrites.withPermit(replace(getDynamicRules(), updateDynamicRules)(rules)),
    updateSessionRules: (options) => sessionWrites.withPermit(updateSessionRules(options)),
    getSessionRules,
    replaceSessionRules: (rules) => sessionWrites.withPermit(replace(getSessionRules(), updateSessionRules)(rules)),
    updateEnabledRulesets: (options) => invoke("updateEnabledRulesets", () => api.updateEnabledRulesets(options)),
    getEnabledRulesets: invoke("getEnabledRulesets", () => api.getEnabledRulesets()),
    updateStaticRules: (options) => invoke("updateStaticRules", () => api.updateStaticRules === undefined
      ? Promise.reject(unavailable("updateStaticRules"))
      : api.updateStaticRules(options)),
    getDisabledRuleIds: (options) => invoke("getDisabledRuleIds", () => api.getDisabledRuleIds === undefined
      ? Promise.reject(unavailable("getDisabledRuleIds"))
      : api.getDisabledRuleIds(options)),
    getAvailableStaticRuleCount: invoke("getAvailableStaticRuleCount", () => api.getAvailableStaticRuleCount()),
    isRegexSupported: (regexOptions) => invoke("isRegexSupported", () => api.isRegexSupported(regexOptions)),
    getMatchedRules: (filter) => invoke("getMatchedRules", () => filter === undefined
      ? api.getMatchedRules()
      : api.getMatchedRules(filter)).pipe(Effect.map((details) => details.rulesMatchedInfo)),
    getMatchedRulesFromUserGesture: (filter) => getMatchedRulesImmediately(api, filter).pipe(
      Effect.map((details) => details.rulesMatchedInfo)
    ),
    testMatchOutcome: (request) => invoke("testMatchOutcome", () => api.testMatchOutcome === undefined
      ? Promise.reject(unavailable("testMatchOutcome"))
      : api.testMatchOutcome(request)).pipe(Effect.map((result) => result.matchedRules)),
    setExtensionActionOptions: (options) => invoke("setExtensionActionOptions", () => api.setExtensionActionOptions(options)),
    onRuleMatchedDebug: observe(
      () => {
        const source = api.onRuleMatchedDebug

        if (source === undefined) throw unavailable("onRuleMatchedDebug")

        return source
      },
      (info) => info,
      (cause) => fail("onRuleMatchedDebug", cause)
    )
  })
}

export const layer = (api: ChromeDeclarativeNetRequestApi): Layer.Layer<ChromeDeclarativeNetRequest> =>
  Layer.succeed(ChromeDeclarativeNetRequest, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeDeclarativeNetRequest, ChromeDeclarativeNetRequestError> = liveLayer(
  ChromeDeclarativeNetRequest, "declarativeNetRequest", (chrome) => chrome.declarativeNetRequest, make,
  (cause) => new ChromeDeclarativeNetRequestError({ operation: "initialize", cause })
)
