# ChromeDeclarativeNetRequest

Import from `effect-platform-chrome/ChromeDeclarativeNetRequest`. `ChromeDeclarativeNetRequest`
is an Effect v4 service over `chrome.declarativeNetRequest`; `make(api)` and `layer(api)`
accept an injectable Promise-based subset, and `layerLive` reads the global only when built
(failing with `operation: "initialize"` when it is missing). Every rejection or synchronous
throw becomes a `ChromeDeclarativeNetRequestError` carrying the Chrome method name as
`operation` and the original `cause`.

This is the MV3 way to block, redirect, upgrade or rewrite headers of requests. Chrome
evaluates the rules itself, so they apply even while the service worker is stopped.
`ChromeWebRequest` can only observe requests.

## Dynamic, session and static rules

| Kind | Where it lives | Lifetime | Changed with |
| --- | --- | --- | --- |
| Dynamic | Added at runtime | Survives browser restarts and extension updates | `updateDynamicRules`, `replaceDynamicRules` |
| Session | Added at runtime, in memory | Survives service-worker restarts; cleared when the browser closes or the extension is updated or reloaded | `updateSessionRules`, `replaceSessionRules` |
| Static | JSON rulesets in the package, declared under `declarative_net_request.rule_resources` | Shipped with each version | `updateEnabledRulesets` (whole rulesets), `updateStaticRules` (single rules) |

Dynamic and session rules are separate sets: the same rule id may exist in both.
Matched rules report `rulesetId` `DYNAMIC_RULESET_ID` (`"_dynamic"`) or
`SESSION_RULESET_ID` (`"_session"`) for them; both constants are exported. Only session
rules may use the `tabIds` and `excludedTabIds` conditions.

`updateEnabledRulesets({ disableRulesetIds, enableRulesetIds })` rejects unknown ids;
an id in both lists ends up enabled. Enabled rulesets persist across sessions but reset
to the manifest's `enabled` flags whenever the extension updates.
`updateStaticRules({ rulesetId, disableRuleIds, enableRuleIds })` (Chrome 111+) switches
single rules off or on; an id in both lists ends up disabled, and changes to a disabled
ruleset take effect when it is next enabled. `getDisabledRuleIds({ rulesetId })` lists
the switched-off ids in ascending order.

## Atomic updates

`updateDynamicRules({ removeRuleIds, addRules })` and `updateSessionRules` first remove
the listed ids (unknown ids are ignored), then add the new rules, as **one atomic
change**: either all of it applies or Chrome rejects and nothing changes. A rule id
that already exists after the removals, or repeats within `addRules`, rejects the
whole update, as does any invalid rule or a limit below. To change a rule, remove and
add its id in the same call.

`replaceDynamicRules(rules)` (and `replaceSessionRules`) makes `rules` the whole set:
it reads the current ids, then removes all of them and adds `rules` in a single
update. Each service runs its writes to one set (updates and replacements) one at a
time, so concurrent replacements from the same service never read a stale set and
collide. Writers in other extension contexts (a popup, an options page) have their own
service and can still interleave with a replacement; keep rule writes in one context
when that matters. Session writes do not wait for dynamic ones.

```ts
import { Effect } from "effect"
import * as ChromeDeclarativeNetRequest from "effect-platform-chrome/ChromeDeclarativeNetRequest"

const blockHosts = (hosts: ReadonlyArray<string>) => Effect.gen(function*() {
  const rules = yield* ChromeDeclarativeNetRequest.ChromeDeclarativeNetRequest
  yield* rules.replaceDynamicRules(hosts.map((host, index) => ({
    id: index + 1,
    action: { type: "block" },
    condition: { requestDomains: [host], resourceTypes: ["script", "xmlhttprequest"] }
  })))
})
```

## Limits

Chrome rejects an update that would exceed a limit; the error is the typed failure.

| Limit | Value |
| --- | --- |
| Dynamic rules | 30,000 (Chrome 121+), of which at most 5,000 "unsafe" (any action other than block, allow, allowAllRequests and upgradeScheme) |
| Session rules | 5,000 (Chrome 120+), of which at most 5,000 unsafe |
| Regex rules | 1,000 shared by dynamic and session rules; static rulesets have their own 1,000 |
| Static rules | 30,000 guaranteed across enabled rulesets; beyond that a shared, browser-wide pool (`getAvailableStaticRuleCount` reports what is left) |
| Static rulesets | 100 declared, 50 enabled at once |
| Disabled static rules | 5,000 across all rulesets |
| `getMatchedRules` | 20 calls per 10 minutes, except calls made in a user gesture |

Check a regex before adding it with `isRegexSupported`: Chrome uses RE2, so some
JavaScript regex syntax (lookarounds, backreferences) is rejected, as are expressions
that compile too large (`reason: "memoryLimitExceeded"`).

## Feedback and debugging

- `getMatchedRules(filter?)` needs the `declarativeNetRequestFeedback` permission, or
  `activeTab` granted for `filter.tabId` (`-1` selects requests without an open tab).
  `filter.minTimeStamp` is inclusive. Matches older than five minutes are dropped unless
  their document is still active. It is lazy, so it counts against the quota;
  `getMatchedRulesFromUserGesture(filter?)` calls Chrome immediately, so calling it
  synchronously in a gesture handler (a click in a popup, say) is exempt, and its
  outcome is handled even if the returned Effect never runs.
- `testMatchOutcome(request)` (Chrome 103+) lists the rules that would act on a
  hypothetical request. It and the `onRuleMatchedDebug` stream exist only in unpacked
  extensions (the stream also needs `declarativeNetRequestFeedback`); elsewhere Chrome
  leaves them out and they fail with the typed error, as do `updateStaticRules` and
  `getDisabledRuleIds` before Chrome 111. `onRuleMatchedDebug` is observational, like
  every stream in this library: it cannot wake an MV3 service worker (use
  `ChromeServiceWorker.listen`), and buffers at most 64 events, dropping the oldest.
- `setExtensionActionOptions({ displayActionCountAsBadgeText: true })` shows the
  per-tab matched-action count on the extension's badge (a persisted preference);
  `tabUpdate: { tabId, increment }` adjusts a tab's count, never below zero, and is
  rejected while the count is not shown as badge text.

## Permissions

`declarativeNetRequest` covers block and upgrade rules (shown as a permission warning at
install). `declarativeNetRequestWithHostAccess` has no install warning but needs host
permissions for every rule. Redirect and header-modification rules need host
permissions for the request URL and its initiator in either case. Add
`declarativeNetRequestFeedback` for `getMatchedRules` and `onRuleMatchedDebug`.

## Testing

`effect-platform-chrome/testing/DeclarativeNetRequest` exports
`makeDeclarativeNetRequest(setup?, overrides?)`, returning `{ api, layer, controls }`.
It follows Chromium's implementation:

- Dynamic and session rules are kept in memory with Chrome's atomic updates, limits
  (`declarativeNetRequestLimits`) and messages, such as
  `Rule with id N does not have a unique ID.` or `Dynamic rule count exceeded.`, and a
  subset of its rule validation: ids and priorities of at least 1, non-empty condition
  lists, `tabIds` on session rules only, one non-empty ASCII `urlFilter` or
  `regexFilter`, and an RE2-like regex check.
- Static rulesets: pass `setup.rulesets` (the declared ids) to have unknown ids rejected
  with `Invalid ruleset id: <id>.`; the 50-enabled and 5,000-disabled limits and the
  enable/disable precedence match Chrome. Ruleset sizes are not modelled;
  `getAvailableStaticRuleCount` reports `setup.availableStaticRuleCount` (30,000 by
  default) until `controls.setAvailableStaticRuleCount`.
- `isRegexSupported` approximates RE2: JavaScript's `RegExp` minus lookarounds and
  backreferences.
- Requests are never matched: `getMatchedRules` returns what `controls.recordMatch`
  recorded (filtered like Chrome, with no quota), and `testMatchOutcome` validates the
  request and returns no rules.
- `setExtensionActionOptions` keeps the badge preference (`setup.displayActionCountAsBadgeText`)
  and per-tab counts (`controls.actionCount(tabId)`), and records accepted calls in
  `controls.actionOptions`.
- `controls.onRuleMatchedDebug` simulates the debug event; `controls.failNext(operation,
  cause)` makes the next call of an operation reject; `setup.absent` leaves out the
  members Chrome omits from packed extensions or older versions; `overrides` replaces any
  member.
