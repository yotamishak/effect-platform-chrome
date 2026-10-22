import * as ChromeDeclarativeNetRequest from "../ChromeDeclarativeNetRequest.js"
import * as TestEvent from "./Event.js"

// Injected failures are raw rejection causes, as Chrome's would be.
/* oxlint-disable anti-slop/no-unknown-parameters */

type Rule = ChromeDeclarativeNetRequest.Rule

export type DeclarativeNetRequestOperation =
  | "updateDynamicRules" | "getDynamicRules" | "updateSessionRules" | "getSessionRules"
  | "updateEnabledRulesets" | "getEnabledRulesets" | "updateStaticRules" | "getDisabledRuleIds"
  | "getAvailableStaticRuleCount" | "isRegexSupported" | "getMatchedRules" | "testMatchOutcome"
  | "setExtensionActionOptions"

/** Chrome 121+ limits, mirroring `chrome.declarativeNetRequest.MAX_NUMBER_OF_*` where Chrome exposes them. */
export const declarativeNetRequestLimits = {
  dynamicRules: 30000,
  unsafeDynamicRules: 5000,
  sessionRules: 5000,
  unsafeSessionRules: 5000,
  /** One budget shared by dynamic and session rules. */
  regexRules: 1000,
  enabledRulesets: 50,
  /** Across every static ruleset. */
  disabledStaticRules: 5000
} as const

/** Rules with any other action count towards the "unsafe" limits. */
const safeActions: ReadonlySet<string> = new Set(["block", "allow", "allowAllRequests", "upgradeScheme"])

const isAscii = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) > 0x7f) return false

  return true
}

/** RE2's largest repeat count: `a{1001}` is a syntax error. */
const maxRepeat = 1000

/** The letter escapes RE2 defines outside a character class; any other letter is a syntax error. */
const re2Escapes: ReadonlySet<string> = new Set("afnrtvxdDsSwWbBAzQECpP")

/** Inside a class RE2 allows only C escapes, `\x`, Perl classes and Unicode groups. */
const re2ClassEscapes: ReadonlySet<string> = new Set("afnrtvxdDsSwWpP")

const isOctal = (char: string): boolean => char >= "0" && char <= "7"

/** A JavaScript `\uXXXX` escape, clamped to the BMP: only whether it compiles matters. */
const unitEscape = (codePoint: number): string => `\\u${Math.min(codePoint, 0xffff).toString(16).padStart(4, "0")}`

/**
 * Reads the escape starting at the backslash `regex[index]` as RE2 does: its JavaScript
 * equivalent and length, or undefined when RE2 rejects it.
 */
const readEscape = (regex: string, index: number, inClass: boolean): { readonly js: string, readonly length: number } | undefined => {
  const next = regex.charAt(index + 1)

  // \0, and \1-\7 followed by an octal digit, are octal escapes of up to three digits; a lone
  // \1-\9 would be a backreference, and \8 or \9 is nothing.
  if (next >= "0" && next <= "9") {
    if (next === "8" || next === "9" || (next !== "0" && !isOctal(regex.charAt(index + 2)))) return undefined

    let digits = next

    while (digits.length < 3 && isOctal(regex.charAt(index + 1 + digits.length))) digits += regex.charAt(index + 1 + digits.length)

    return { js: unitEscape(Number.parseInt(digits, 8)), length: 1 + digits.length }
  }

  if (next === "x") {
    const hex = /^(?:([0-9A-Fa-f]{2})|\{([0-9A-Fa-f]+)\})/.exec(regex.slice(index + 2))

    if (hex === null) return undefined

    const codePoint = Number.parseInt(hex[1] ?? hex[2] ?? "", 16)

    return codePoint > 0x10ffff ? undefined : { js: unitEscape(codePoint), length: 2 + hex[0].length }
  }

  // \Q…\E (or to the end) is literal text.
  if (!inClass && next === "Q") {
    const end = regex.indexOf("\\E", index + 2)
    const text = regex.slice(index + 2, end === -1 ? regex.length : end)

    return { js: text.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&"), length: (end === -1 ? regex.length : end + 2) - index }
  }

  if (/^[A-Za-z]$/.test(next) && !(inClass ? re2ClassEscapes : re2Escapes).has(next)) return undefined

  // Punctuation is literal; a trailing backslash is left for RegExp to reject.
  return { js: `\\${next}`, length: 2 }
}

/**
 * Translates an RE2 pattern into JavaScript that compiles when RE2 would parse it, or
 * returns undefined when RE2 rejects it outright. RE2-only syntax (flag groups such as
 * `(?i)`, `(?P<name>…)`, `\A`, `\z`, `\Q…\E`, `\C`, `\x{…}`, octal escapes, a leading `]` in a
 * class) is translated; what JavaScript accepts but RE2 does not (lookarounds,
 * backreferences, undefined letter escapes such as `\u` or `\Z`, repeat counts above 1000)
 * is rejected.
 */
const toJavaScript = (regex: string): string | undefined => {
  let js = ""
  let inClass = false
  let index = 0

  while (index < regex.length) {
    const char = regex.charAt(index)

    if (char === "\\") {
      const escape = readEscape(regex, index, inClass)

      if (escape === undefined) return undefined

      js += escape.js
      index += escape.length
      continue
    }

    if (inClass) {
      if (char === "]") inClass = false

      js += char
      index += 1
      continue
    }

    if (char === "[") {
      const opening = regex.charAt(index + 1) === "^" ? "[^" : "["
      const literalBracket = regex.charAt(index + opening.length) === "]"
      inClass = true
      js += literalBracket ? `${opening}\\]` : opening
      index += opening.length + (literalBracket ? 1 : 0)
      continue
    }

    if (char === "{") {
      const repeat = /^\{(\d+)(?:,(\d*))?\}/.exec(regex.slice(index))

      if (repeat !== null && [repeat[1], repeat[2]].some((count) => count !== undefined && count !== "" && Number(count) > maxRepeat)) return undefined
    }

    if (char === "(" && regex.charAt(index + 1) === "?") {
      const rest = regex.slice(index + 2)

      // Lookarounds and (?P=name) backreferences.
      if (/^(?:[=!]|<[=!]|P=)/.test(rest)) return undefined

      if (rest.startsWith("P<")) {
        js += "(?<"
        index += 4
        continue
      }

      const flags = /^([imsU]*(?:-[imsU]+)?)([:)])/.exec(rest)

      if (flags !== null) {
        const set = flags[1] ?? ""
        const end = flags[2] ?? ""

        // `(?)` sets no flags and opens no group.
        if (set === "" && end === ")") return undefined

        js += end === ":" ? "(?:" : ""
        index += 2 + flags[0].length
        continue
      }
    }

    js += char
    index += 1
  }

  return js
}

/**
 * Approximates RE2 by compiling the `toJavaScript` translation with `RegExp`. Expressions
 * are never too large, and invalid names in `\p{…}` or `[[:…:]]` are not detected.
 */
const regexSupport = (options: ChromeDeclarativeNetRequest.RegexOptions): ChromeDeclarativeNetRequest.RegexSupport => {
  const translated = toJavaScript(options.regex)

  if (translated === undefined) return { isSupported: false, reason: "syntaxError" }

  try {
    new RegExp(translated, options.isCaseSensitive === false ? "i" : "")

    return { isSupported: true }
  } catch {
    return { isSupported: false, reason: "syntaxError" }
  }
}

/** The condition lists Chrome refuses to accept empty. */
const nonEmptyLists = ["domains", "initiatorDomains", "requestDomains", "topDomains", "resourceTypes", "requestMethods", "tabIds"] as const

/** Chrome's first complaint about one rule, with its message, or undefined when it parses. */
const ruleError = (rule: Rule, scope: "dynamic" | "session"): string | undefined => {
  const id = rule.id
  const { condition } = rule

  if (!Number.isInteger(id) || id < 1) return `Rule with id ${id} has an invalid value for id key. This should be greater than or equal to 1.`

  if (rule.priority !== undefined && (!Number.isInteger(rule.priority) || rule.priority < 1)) {
    return `Rule with id ${id} has an invalid value for priority key. This should be greater than or equal to 1.`
  }

  for (const key of nonEmptyLists) {
    if (condition[key]?.length === 0) return `Rule with id ${id} cannot have an empty list as the value for ${key} key.`
  }

  if (scope === "dynamic" && (condition.tabIds !== undefined || condition.excludedTabIds !== undefined)) {
    return `Rule with id ${id} specifies a value for "tabIds" or "excludedTabIds" key. These are only supported for session-scoped rules.`
  }

  if (condition.urlFilter !== undefined && condition.regexFilter !== undefined) {
    return `Rule with id ${id} can only specify one of "urlFilter" or "regexFilter" keys.`
  }

  if (condition.urlFilter === "") return `Rule with id ${id} cannot have an empty value for urlFilter key.`

  if (condition.urlFilter !== undefined && !isAscii(condition.urlFilter)) {
    return `Rule with id ${id} cannot have non-ascii characters as part of "urlFilter" key.`
  }

  if (condition.regexFilter === "") return `Rule with id ${id} cannot have an empty value for regexFilter key.`

  if (condition.regexFilter !== undefined && !isAscii(condition.regexFilter)) {
    return `Rule with id ${id} cannot have non-ascii characters as part of "regexFilter" key.`
  }

  if (condition.regexFilter !== undefined && !regexSupport({ regex: condition.regexFilter }).isSupported) {
    return `Rule with id ${id} specifies an incorrect value for the "regexFilter" key.`
  }

  return undefined
}

/**
 * One in-memory rule set (dynamic or session) with Chrome's update order: drop
 * `removeRuleIds` (unknown ids are ignored), append `addRules`, check the rule, unsafe-rule
 * and shared regex-rule counts, then parse every rule. Any failure rejects with Chrome's
 * message and leaves the set unchanged.
 */
const makeRuleSet = (
  scope: "dynamic" | "session",
  ruleLimit: number,
  unsafeLimit: number,
  otherRegexCount: () => number
) => {
  const rules = new Map<number, Rule>()
  const label = scope === "dynamic" ? "Dynamic" : "Session"
  const regexCount = () => Array.from(rules.values()).filter((rule) => rule.condition.regexFilter !== undefined).length

  const update = (options: ChromeDeclarativeNetRequest.UpdateRuleOptions): void => {
    const removed = new Set(options.removeRuleIds ?? [])
    const next = [...Array.from(rules.values()).filter((rule) => !removed.has(rule.id)), ...(options.addRules ?? [])]

    if (next.length > ruleLimit) throw new Error(`${label} rule count exceeded.`)

    if (next.filter((rule) => !safeActions.has(rule.action.type)).length > unsafeLimit) {
      throw new Error(`${label} unsafe rule count exceeded.`)
    }

    if (next.filter((rule) => rule.condition.regexFilter !== undefined).length > declarativeNetRequestLimits.regexRules - otherRegexCount()) {
      throw new Error(`${label} rule count for regex rules exceeded.`)
    }

    const parsed = new Map<number, Rule>()

    for (const rule of next) {
      const error = ruleError(rule, scope)

      if (error !== undefined) throw new Error(error)

      if (parsed.has(rule.id)) throw new Error(`Rule with id ${rule.id} does not have a unique ID.`)

      parsed.set(rule.id, structuredClone(rule))
    }

    rules.clear()

    for (const [id, rule] of parsed) rules.set(id, rule)
  }

  const get = (filter?: ChromeDeclarativeNetRequest.GetRulesFilter): Array<Rule> => {
    const ids = filter?.ruleIds === undefined ? undefined : new Set(filter.ruleIds)

    return structuredClone(Array.from(rules.values()).filter((rule) => ids === undefined || ids.has(rule.id)))
  }

  return { rules, update, get, regexCount }
}

/** What `makeDeclarativeNetRequest` starts from. */
export interface DeclarativeNetRequestSetup {
  /**
   * The static ruleset ids the manifest declares. When given, unknown ids are rejected with
   * Chrome's `Invalid ruleset id: <id>.`; when omitted, every id is accepted.
   */
  readonly rulesets?: ReadonlyArray<string>
  /** The initially enabled static rulesets. */
  readonly enabledRulesets?: ReadonlyArray<string>
  /** What `getAvailableStaticRuleCount` reports until `controls.setAvailableStaticRuleCount`; 30000 by default. */
  readonly availableStaticRuleCount?: number
  /** The persisted badge-text preference before any `setExtensionActionOptions`; false by default. */
  readonly displayActionCountAsBadgeText?: boolean
  /**
   * Optional members to leave out, as Chrome does: `testMatchOutcome` and
   * `onRuleMatchedDebug` in packed extensions (the event also without
   * `declarativeNetRequestFeedback`), `updateStaticRules` and `getDisabledRuleIds` before
   * Chrome 111.
   */
  readonly absent?: ReadonlyArray<DeclarativeNetRequestOptionalMember>
}

/** The Api members Chrome leaves out of some extensions or versions. */
export type DeclarativeNetRequestOptionalMember = "updateStaticRules" | "getDisabledRuleIds" | "testMatchOutcome" | "onRuleMatchedDebug"

type Writable<T> = { -readonly [K in keyof T]: T[K] }

/**
 * An in-memory `chrome.declarativeNetRequest`, following Chromium's implementation:
 *
 * - Dynamic and session rules are separate sets (`makeRuleSet`) with atomic updates, the
 *   30000/5000 dynamic and 5000/5000 session rule and unsafe-rule limits, one regex budget
 *   of 1000 shared by both, and a subset of Chrome's rule validation (ids and priorities
 *   of at least 1, unique ids, non-empty condition lists, `tabIds` only on session rules,
 *   one non-empty ASCII URL or regex filter, and an RE2-like regex check).
 * - `updateEnabledRulesets` lets an id in both lists end up enabled and allows 50 enabled
 *   rulesets; `updateStaticRules` lets an id in both lists end up disabled and allows 5000
 *   disabled rules across rulesets; `getDisabledRuleIds` is ascending. Ruleset sizes and
 *   the static rule limit are not modelled.
 * - `isRegexSupported` approximates RE2 (see `regexSupport`).
 * - `getMatchedRules` returns the matches recorded with `controls.recordMatch`, filtered by
 *   `tabId` and an inclusive `minTimeStamp`, oldest first; it enforces no quota.
 * - `testMatchOutcome` validates the request like Chrome and returns no matches.
 * - `setExtensionActionOptions` keeps the badge-text preference and per-tab action counts
 *   (never below 0), and rejects a `tabUpdate` while the preference is off.
 *
 * Each `controls.failNext` makes the next call of that operation reject with the cause;
 * `setup.absent` leaves optional members out; pass `overrides` to replace any member.
 */
export const makeDeclarativeNetRequest = (
  setup: DeclarativeNetRequestSetup = {},
  overrides: Partial<ChromeDeclarativeNetRequest.ChromeDeclarativeNetRequestApi> = {}
) => {
  const dynamic = makeRuleSet("dynamic", declarativeNetRequestLimits.dynamicRules, declarativeNetRequestLimits.unsafeDynamicRules, () => session.regexCount())
  const session = makeRuleSet("session", declarativeNetRequestLimits.sessionRules, declarativeNetRequestLimits.unsafeSessionRules, () => dynamic.regexCount())
  const declared = setup.rulesets === undefined ? undefined : new Set(setup.rulesets)
  const enabledRulesets = new Set(setup.enabledRulesets ?? [])
  const disabledRuleIds = new Map<string, ReadonlySet<number>>()
  const matches: Array<ChromeDeclarativeNetRequest.MatchedRuleInfo> = []
  const actionOptions: Array<ChromeDeclarativeNetRequest.ExtensionActionOptions> = []
  const actionCounts = new Map<number, number>()
  const ruleMatchedDebug = TestEvent.makeEvent<[ChromeDeclarativeNetRequest.MatchedRuleDebug]>()
  const failures = new Map<DeclarativeNetRequestOperation, Array<unknown>>()
  let availableStaticRuleCount = setup.availableStaticRuleCount ?? 30000
  let displayActionCountAsBadgeText = setup.displayActionCountAsBadgeText ?? false

  const check = (operation: DeclarativeNetRequestOperation) => {
    const queue = failures.get(operation)

    if (queue !== undefined && queue.length > 0) throw queue.shift()
  }

  const checkRuleset = (id: string) => {
    if (declared !== undefined && !declared.has(id)) throw new Error(`Invalid ruleset id: ${id}.`)
  }

  const validUrl = (url: string): boolean => {
    try {
      new URL(url)

      return true
    } catch {
      return false
    }
  }

  const api: Writable<ChromeDeclarativeNetRequest.ChromeDeclarativeNetRequestApi> = {
    updateDynamicRules: async (options) => {
      check("updateDynamicRules")
      dynamic.update(options)
    },
    getDynamicRules: async (filter) => {
      check("getDynamicRules")

      return dynamic.get(filter)
    },
    updateSessionRules: async (options) => {
      check("updateSessionRules")
      session.update(options)
    },
    getSessionRules: async (filter) => {
      check("getSessionRules")

      return session.get(filter)
    },
    updateEnabledRulesets: async (options) => {
      check("updateEnabledRulesets")
      const enable = new Set(options.enableRulesetIds ?? [])

      for (const id of enable) checkRuleset(id)

      for (const id of options.disableRulesetIds ?? []) checkRuleset(id)

      const next = new Set(enabledRulesets)

      for (const id of options.disableRulesetIds ?? []) if (!enable.has(id)) next.delete(id)

      for (const id of enable) next.add(id)

      if (next.size > declarativeNetRequestLimits.enabledRulesets) {
        throw new Error("The number of enabled static rulesets exceeds the enabled ruleset count limit.")
      }

      enabledRulesets.clear()

      for (const id of next) enabledRulesets.add(id)
    },
    getEnabledRulesets: async () => {
      check("getEnabledRulesets")

      return Array.from(enabledRulesets)
    },
    updateStaticRules: async (options) => {
      check("updateStaticRules")
      checkRuleset(options.rulesetId)
      const disable = new Set(options.disableRuleIds ?? [])
      const enable = new Set((options.enableRuleIds ?? []).filter((id) => !disable.has(id)))
      const before = disabledRuleIds.get(options.rulesetId) ?? new Set<number>()
      const after = new Set([...Array.from(before).filter((id) => !enable.has(id)), ...disable])
      let total = after.size

      for (const [rulesetId, ids] of disabledRuleIds) if (rulesetId !== options.rulesetId) total += ids.size

      if (total > declarativeNetRequestLimits.disabledStaticRules) {
        throw new Error("The number of disabled static rules exceeds the disabled rule count limit.")
      }

      if (after.size === 0) disabledRuleIds.delete(options.rulesetId)
      else disabledRuleIds.set(options.rulesetId, after)
    },
    getDisabledRuleIds: async (options) => {
      check("getDisabledRuleIds")
      checkRuleset(options.rulesetId)

      return Array.from(disabledRuleIds.get(options.rulesetId) ?? []).sort((left, right) => left - right)
    },
    getAvailableStaticRuleCount: async () => {
      check("getAvailableStaticRuleCount")

      return availableStaticRuleCount
    },
    isRegexSupported: async (options) => {
      check("isRegexSupported")

      return regexSupport(options)
    },
    getMatchedRules: async (filter) => {
      check("getMatchedRules")

      return {
        rulesMatchedInfo: structuredClone(matches.filter((info) =>
          (filter?.tabId === undefined || info.tabId === filter.tabId)
          && (filter?.minTimeStamp === undefined || info.timeStamp >= filter.minTimeStamp)))
      }
    },
    testMatchOutcome: async (request) => {
      check("testMatchOutcome")

      if (!validUrl(request.url)) throw new Error("Invalid test request URL.")

      if (request.initiator !== undefined && !validUrl(request.initiator)) throw new Error("Invalid test request initiator.")

      if (request.tabId !== undefined && request.tabId < -1) throw new Error("Invalid test request tab ID.")

      if (request.topUrl !== undefined && !validUrl(request.topUrl)) throw new Error("Invalid test request top URL.")

      return { matchedRules: [] }
    },
    setExtensionActionOptions: async (options) => {
      check("setExtensionActionOptions")

      // Chrome stores the preference before it validates the tab update.
      if (options.displayActionCountAsBadgeText !== undefined) displayActionCountAsBadgeText = options.displayActionCountAsBadgeText

      if (options.tabUpdate !== undefined) {
        if (!displayActionCountAsBadgeText) {
          throw new Error("Cannot increment action count unless displaying action count as badge text.")
        }

        const { tabId, increment } = options.tabUpdate
        actionCounts.set(tabId, Math.max((actionCounts.get(tabId) ?? 0) + increment, 0))
      }

      actionOptions.push(structuredClone(options))
    },
    onRuleMatchedDebug: ruleMatchedDebug.api,
    ...overrides
  }

  for (const member of setup.absent ?? []) delete api[member]

  const finished: ChromeDeclarativeNetRequest.ChromeDeclarativeNetRequestApi = api

  return {
    api: finished,
    layer: ChromeDeclarativeNetRequest.layer(finished),
    controls: {
      /** The current dynamic rules, in insertion order. */
      dynamicRules: (): ReadonlyArray<Rule> => structuredClone(Array.from(dynamic.rules.values())),
      /** The current session rules, in insertion order. */
      sessionRules: (): ReadonlyArray<Rule> => structuredClone(Array.from(session.rules.values())),
      enabledRulesets: (): ReadonlyArray<string> => Array.from(enabledRulesets),
      /** The disabled static rule ids of one ruleset, ascending. */
      disabledRuleIds: (rulesetId: string): ReadonlyArray<number> =>
        Array.from(disabledRuleIds.get(rulesetId) ?? []).sort((left, right) => left - right),
      setAvailableStaticRuleCount: (count: number) => { availableStaticRuleCount = count },
      /** Records a match for `getMatchedRules`, as Chrome's action tracker would. */
      recordMatch: (info: ChromeDeclarativeNetRequest.MatchedRuleInfo) => { matches.push(structuredClone(info)) },
      /** Every accepted `setExtensionActionOptions` call, oldest first. */
      actionOptions,
      /** The persisted badge-text preference. */
      displayActionCountAsBadgeText: (): boolean => displayActionCountAsBadgeText,
      /** A tab's action count as adjusted through `tabUpdate`. */
      actionCount: (tabId: number): number => actionCounts.get(tabId) ?? 0,
      onRuleMatchedDebug: ruleMatchedDebug.controls,
      failNext: (operation: DeclarativeNetRequestOperation, cause: unknown) => {
        const queue = failures.get(operation) ?? []
        queue.push(cause)
        failures.set(operation, queue)
      }
    }
  }
}
