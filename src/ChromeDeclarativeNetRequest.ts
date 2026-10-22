import { Context, Effect, Layer, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeDeclarativeNetRequestError extends Schema.TaggedError<ChromeDeclarativeNetRequestError>()(
  "ChromeDeclarativeNetRequestError",
  {
    operation: Schema.String,
    cause: Schema.Defect()
  }
) {}

export type Rule = chrome.declarativeNetRequest.Rule

export type UpdateRuleOptions = chrome.declarativeNetRequest.UpdateRuleOptions

export type GetRulesFilter = chrome.declarativeNetRequest.GetRulesFilter

export type UpdateRulesetOptions = chrome.declarativeNetRequest.UpdateRulesetOptions

export type UpdateStaticRulesOptions = chrome.declarativeNetRequest.UpdateStaticRulesOptions

export type RegexOptions = chrome.declarativeNetRequest.RegexOptions

export type RegexSupport = chrome.declarativeNetRequest.IsRegexSupportedResult

export type MatchedRule = chrome.declarativeNetRequest.MatchedRule

export type MatchedRuleInfo = chrome.declarativeNetRequest.MatchedRuleInfo

export type MatchedRulesFilter = chrome.declarativeNetRequest.MatchedRulesFilter

export type MatchedRuleDebug = chrome.declarativeNetRequest.MatchedRuleInfoDebug

export type ExtensionActionOptions = chrome.declarativeNetRequest.ExtensionActionOptions

export type TestMatchRequest = chrome.declarativeNetRequest.TestMatchRequestDetails

/** The Promise-based MV3 subset this module needs. */
export interface ChromeDeclarativeNetRequestApi {
  updateDynamicRules(options: UpdateRuleOptions): Promise<void>
  getDynamicRules(filter?: GetRulesFilter): Promise<Array<Rule>>
  updateSessionRules(options: UpdateRuleOptions): Promise<void>
  getSessionRules(filter?: GetRulesFilter): Promise<Array<Rule>>
  updateEnabledRulesets(options: UpdateRulesetOptions): Promise<void>
  getEnabledRulesets(): Promise<Array<string>>
  updateStaticRules(options: UpdateStaticRulesOptions): Promise<void>
  getDisabledRuleIds(options: chrome.declarativeNetRequest.GetDisabledRuleIdsOptions): Promise<Array<number>>
  getAvailableStaticRuleCount(): Promise<number>
  isRegexSupported(regexOptions: RegexOptions): Promise<RegexSupport>
  getMatchedRules(filter?: MatchedRulesFilter): Promise<chrome.declarativeNetRequest.RulesMatchedDetails>
  testMatchOutcome(request: TestMatchRequest): Promise<chrome.declarativeNetRequest.TestMatchOutcomeResult>
  setExtensionActionOptions(options: ExtensionActionOptions): Promise<void>
  readonly onRuleMatchedDebug: EventSource<[info: MatchedRuleDebug]>
}

/**
 * Declarative request blocking, redirecting and header rewriting. Dynamic rules persist
 * across browser restarts and extension updates; session rules live in memory until the
 * browser closes; static rulesets ship in the package (`declarative_net_request.rule_resources`)
 * and can only be enabled, disabled or have individual rules switched off.
 */
export interface ChromeDeclarativeNetRequestService {
  /**
   * Removes `removeRuleIds` (unknown ids are ignored) and then adds `addRules`, as one
   * atomic change: Chrome applies all of it or rejects with the typed error, such as on a
   * duplicate rule id or the 30000 dynamic (5000 unsafe, 1000 regex) rule limit.
   */
  readonly updateDynamicRules: (options: UpdateRuleOptions) => Effect.Effect<void, ChromeDeclarativeNetRequestError>
  readonly getDynamicRules: (filter?: GetRulesFilter) => Effect.Effect<Array<Rule>, ChromeDeclarativeNetRequestError>
  /**
   * Makes `rules` the whole dynamic rule set: reads the current ids, then removes them and
   * adds `rules` in a single atomic `updateDynamicRules`. Another update landing between the
   * read and the write is not covered by that atomicity; serialize writers if that matters.
   */
  readonly replaceDynamicRules: (rules: ReadonlyArray<Rule>) => Effect.Effect<void, ChromeDeclarativeNetRequestError>
  /** Like `updateDynamicRules` for in-memory session rules (5000 rules, 5000 unsafe). */
  readonly updateSessionRules: (options: UpdateRuleOptions) => Effect.Effect<void, ChromeDeclarativeNetRequestError>
  readonly getSessionRules: (filter?: GetRulesFilter) => Effect.Effect<Array<Rule>, ChromeDeclarativeNetRequestError>
  /** Like `replaceDynamicRules` for session rules. */
  readonly replaceSessionRules: (rules: ReadonlyArray<Rule>) => Effect.Effect<void, ChromeDeclarativeNetRequestError>
  /**
   * Disables then enables static rulesets by manifest id (at most 50 enabled). The choice
   * persists across sessions but resets to the manifest's `enabled` flags on extension update.
   */
  readonly updateEnabledRulesets: (options: UpdateRulesetOptions) => Effect.Effect<void, ChromeDeclarativeNetRequestError>
  readonly getEnabledRulesets: Effect.Effect<Array<string>, ChromeDeclarativeNetRequestError>
  /** Switches individual rules of one static ruleset off or on (Chrome 111+). */
  readonly updateStaticRules: (options: UpdateStaticRulesOptions) => Effect.Effect<void, ChromeDeclarativeNetRequestError>
  /** The ids of the switched-off rules in one static ruleset (Chrome 111+). */
  readonly getDisabledRuleIds: (rulesetId: string) => Effect.Effect<Array<number>, ChromeDeclarativeNetRequestError>
  /** How many more static rules can be enabled before the browser-wide limit is reached. */
  readonly getAvailableStaticRuleCount: Effect.Effect<number, ChromeDeclarativeNetRequestError>
  /** Whether a `regexFilter` is accepted; when not, `reason` says why. */
  readonly isRegexSupported: (regexOptions: RegexOptions) => Effect.Effect<RegexSupport, ChromeDeclarativeNetRequestError>
  /**
   * Rules matched recently (within five minutes unless the document is still active). Needs
   * `declarativeNetRequestFeedback`, or `activeTab` granted for `filter.tabId`; Chrome allows
   * 20 calls per 10 minutes outside user gestures and rejects the rest.
   */
  readonly getMatchedRules: (filter?: MatchedRulesFilter) => Effect.Effect<Array<MatchedRuleInfo>, ChromeDeclarativeNetRequestError>
  /** The rules that would match a hypothetical request. Unpacked extensions only. */
  readonly testMatchOutcome: (request: TestMatchRequest) => Effect.Effect<Array<MatchedRule>, ChromeDeclarativeNetRequestError>
  /** Shows the per-tab matched-action count as badge text and/or adjusts a tab's count. */
  readonly setExtensionActionOptions: (options: ExtensionActionOptions) => Effect.Effect<void, ChromeDeclarativeNetRequestError>
  /**
   * Every rule match, for debugging: unpacked extensions with `declarativeNetRequestFeedback`
   * only. Observational like every stream here; it cannot wake an MV3 service worker (use
   * `ChromeServiceWorker.listen`) and buffers at most 64 events, dropping the oldest.
   */
  readonly onRuleMatchedDebug: Stream.Stream<MatchedRuleDebug, ChromeDeclarativeNetRequestError>
}

export class ChromeDeclarativeNetRequest extends Context.Service<ChromeDeclarativeNetRequest, ChromeDeclarativeNetRequestService>()(
  "effect-platform-chrome/ChromeDeclarativeNetRequest"
) {}

const invoke = invoker((operation, cause) => new ChromeDeclarativeNetRequestError({ operation, cause }))

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeDeclarativeNetRequestApi): ChromeDeclarativeNetRequestService => {
  const updateDynamicRules = (options: UpdateRuleOptions) => invoke("updateDynamicRules", () => api.updateDynamicRules(options))

  const getDynamicRules = (filter?: GetRulesFilter) => invoke("getDynamicRules", () => filter === undefined
    ? api.getDynamicRules()
    : api.getDynamicRules(filter))

  const updateSessionRules = (options: UpdateRuleOptions) => invoke("updateSessionRules", () => api.updateSessionRules(options))

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
    updateDynamicRules,
    getDynamicRules,
    replaceDynamicRules: replace(getDynamicRules(), updateDynamicRules),
    updateSessionRules,
    getSessionRules,
    replaceSessionRules: replace(getSessionRules(), updateSessionRules),
    updateEnabledRulesets: (options) => invoke("updateEnabledRulesets", () => api.updateEnabledRulesets(options)),
    getEnabledRulesets: invoke("getEnabledRulesets", () => api.getEnabledRulesets()),
    updateStaticRules: (options) => invoke("updateStaticRules", () => api.updateStaticRules(options)),
    getDisabledRuleIds: (rulesetId) => invoke("getDisabledRuleIds", () => api.getDisabledRuleIds({ rulesetId })),
    getAvailableStaticRuleCount: invoke("getAvailableStaticRuleCount", () => api.getAvailableStaticRuleCount()),
    isRegexSupported: (regexOptions) => invoke("isRegexSupported", () => api.isRegexSupported(regexOptions)),
    getMatchedRules: (filter) => invoke("getMatchedRules", () => filter === undefined
      ? api.getMatchedRules()
      : api.getMatchedRules(filter)).pipe(Effect.map((details) => details.rulesMatchedInfo)),
    testMatchOutcome: (request) => invoke("testMatchOutcome", () => api.testMatchOutcome(request)).pipe(
      Effect.map((result) => result.matchedRules)
    ),
    setExtensionActionOptions: (options) => invoke("setExtensionActionOptions", () => api.setExtensionActionOptions(options)),
    onRuleMatchedDebug: observe(
      () => api.onRuleMatchedDebug,
      (info) => info,
      (cause) => new ChromeDeclarativeNetRequestError({ operation: "onRuleMatchedDebug", cause })
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
