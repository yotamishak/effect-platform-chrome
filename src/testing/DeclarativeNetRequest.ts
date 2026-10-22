import * as ChromeDeclarativeNetRequest from "../ChromeDeclarativeNetRequest.js"
import * as TestEvent from "./Event.js"

type Rule = ChromeDeclarativeNetRequest.Rule

/**
 * One in-memory rule set (dynamic or session). Updates are atomic like Chrome's: unknown
 * `removeRuleIds` are ignored, removals apply first, and a rule id that repeats within
 * `addRules` or is still present after the removals rejects the whole update with Chrome's
 * "does not have a unique ID" message, leaving the set unchanged. Ids below 1 are rejected too.
 */
const makeRuleSet = () => {
  const rules = new Map<number, Rule>()

  const update = async (options: ChromeDeclarativeNetRequest.UpdateRuleOptions): Promise<void> => {
    const next = new Map(rules)

    for (const id of options.removeRuleIds ?? []) next.delete(id)

    for (const rule of options.addRules ?? []) {
      if (!Number.isInteger(rule.id) || rule.id < 1) throw new Error(`Rule with id ${rule.id} has an invalid ID.`)

      if (next.has(rule.id)) throw new Error(`Rule with id ${rule.id} does not have a unique ID.`)

      next.set(rule.id, structuredClone(rule))
    }

    rules.clear()

    for (const [id, rule] of next) rules.set(id, rule)
  }

  const get = async (filter?: ChromeDeclarativeNetRequest.GetRulesFilter): Promise<Array<Rule>> => {
    const ids = filter?.ruleIds

    return Array.from(rules.values(), (rule) => structuredClone(rule))
      .filter((rule) => ids === undefined || ids.includes(rule.id))
  }

  return { rules, update, get }
}

/**
 * An in-memory `chrome.declarativeNetRequest`. Dynamic and session rules are separate sets
 * with Chrome's atomic update and id-collision semantics (see `makeRuleSet`); no request is
 * ever matched, so `getMatchedRules` and `testMatchOutcome` return nothing unless
 * overridden. Enabled rulesets and disabled static rule ids are tracked without validation
 * against a manifest. `isRegexSupported` accepts what JavaScript's `RegExp` compiles, which
 * is broader than Chrome's RE2. Pass `overrides` to replace any member.
 */
export const makeDeclarativeNetRequest = (
  options: { readonly enabledRulesets?: ReadonlyArray<string>, readonly availableStaticRuleCount?: number } = {},
  overrides: Partial<ChromeDeclarativeNetRequest.ChromeDeclarativeNetRequestApi> = {}
) => {
  const dynamic = makeRuleSet()
  const session = makeRuleSet()
  const enabledRulesets = new Set(options.enabledRulesets ?? [])
  const disabledRuleIds = new Map<string, Set<number>>()
  const actionOptions: Array<ChromeDeclarativeNetRequest.ExtensionActionOptions> = []
  const ruleMatchedDebug = TestEvent.makeEvent<[ChromeDeclarativeNetRequest.MatchedRuleDebug]>()

  const api: ChromeDeclarativeNetRequest.ChromeDeclarativeNetRequestApi = {
    updateDynamicRules: dynamic.update,
    getDynamicRules: dynamic.get,
    updateSessionRules: session.update,
    getSessionRules: session.get,
    updateEnabledRulesets: async (update) => {
      for (const id of update.disableRulesetIds ?? []) enabledRulesets.delete(id)

      for (const id of update.enableRulesetIds ?? []) enabledRulesets.add(id)
    },
    getEnabledRulesets: async () => Array.from(enabledRulesets),
    updateStaticRules: async (update) => {
      const disabled = disabledRuleIds.get(update.rulesetId) ?? new Set<number>()

      for (const id of update.disableRuleIds ?? []) disabled.add(id)

      for (const id of update.enableRuleIds ?? []) disabled.delete(id)

      disabledRuleIds.set(update.rulesetId, disabled)
    },
    getDisabledRuleIds: async ({ rulesetId }) => Array.from(disabledRuleIds.get(rulesetId) ?? []),
    getAvailableStaticRuleCount: async () => options.availableStaticRuleCount ?? 30000,
    isRegexSupported: async ({ regex }) => {
      try {
        new RegExp(regex)

        return { isSupported: true }
      } catch {
        return { isSupported: false, reason: "syntaxError" }
      }
    },
    getMatchedRules: async () => ({ rulesMatchedInfo: [] }),
    testMatchOutcome: async () => ({ matchedRules: [] }),
    setExtensionActionOptions: async (update) => { actionOptions.push(structuredClone(update)) },
    onRuleMatchedDebug: ruleMatchedDebug.api,
    ...overrides
  }

  return {
    api,
    layer: ChromeDeclarativeNetRequest.layer(api),
    controls: {
      /** The current dynamic rules, in insertion order. */
      dynamicRules: (): ReadonlyArray<Rule> => Array.from(dynamic.rules.values(), (rule) => structuredClone(rule)),
      /** The current session rules, in insertion order. */
      sessionRules: (): ReadonlyArray<Rule> => Array.from(session.rules.values(), (rule) => structuredClone(rule)),
      enabledRulesets: (): ReadonlyArray<string> => Array.from(enabledRulesets),
      /** Every `setExtensionActionOptions` call, oldest first. */
      actionOptions,
      onRuleMatchedDebug: ruleMatchedDebug.controls
    }
  }
}
