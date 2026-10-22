# ChromeDeclarativeNetRequest

Import from `effect-platform-chrome/ChromeDeclarativeNetRequest`. `ChromeDeclarativeNetRequest`
is an Effect v4 service over `chrome.declarativeNetRequest`; `make(api)` and `layer(api)`
accept an injectable Promise-based subset, and `layerLive` reads the global only when built
(failing with `operation: "initialize"` when it is missing). Every rejection becomes a
`ChromeDeclarativeNetRequestError` carrying the Chrome method name as `operation` and the
original `cause`.

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
Matched rules report `rulesetId` `"_dynamic"` or `"_session"` for them.

Enabled rulesets persist across sessions but reset to the manifest's `enabled` flags
whenever the extension updates. Rules disabled through `updateStaticRules` (Chrome 111+)
take effect when their ruleset is next enabled if it is currently disabled.

## Atomic updates

`updateDynamicRules({ removeRuleIds, addRules })` and `updateSessionRules` first remove
the listed ids (unknown ids are ignored), then add the new rules, as **one atomic
change**: either all of it applies or Chrome rejects and nothing changes. A rule id
that already exists after the removals, or repeats within `addRules`, rejects the
whole update. To change a rule, remove and add its id in the same call.

`replaceDynamicRules(rules)` (and `replaceSessionRules`) makes `rules` the whole set:
it reads the current ids, then removes all of them and adds `rules` in a single
update. That update is atomic, but the read before it is a separate call, so two
concurrent writers can still interleave. Run writers through one fiber or a
semaphore when that matters.

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
| Dynamic rules | 30,000, of which at most 5,000 "unsafe" (any action other than block, allow, allowAllRequests and upgradeScheme) |
| Session rules | 5,000 |
| Regex rules | 1,000, counted separately for dynamic rules and for static rulesets |
| Static rules | 30,000 guaranteed across enabled rulesets; beyond that a shared, browser-wide pool (`getAvailableStaticRuleCount` reports what is left) |
| Static rulesets | 100 declared, 50 enabled at once |
| `getMatchedRules` | 20 calls per 10 minutes, except calls made in a user gesture |

Check a regex before adding it with `isRegexSupported`: Chrome uses RE2, so some
JavaScript regex syntax (lookarounds, backreferences) is rejected, as are expressions
that compile too large.

## Feedback and debugging

- `getMatchedRules(filter?)` needs the `declarativeNetRequestFeedback` permission, or
  `activeTab` granted for `filter.tabId`. Matches older than five minutes are dropped
  unless their document is still active.
- `testMatchOutcome(request)` and the `onRuleMatchedDebug` stream are for unpacked
  extensions only (the stream also needs `declarativeNetRequestFeedback`).
  `onRuleMatchedDebug` is observational, like every stream in this library: it cannot
  wake an MV3 service worker (use `ChromeServiceWorker.listen`), and buffers at most 64
  events, dropping the oldest.
- `setExtensionActionOptions({ displayActionCountAsBadgeText: true })` shows the
  per-tab matched-action count on the extension's badge.

## Permissions

`declarativeNetRequest` covers block and upgrade rules (shown as a permission warning at
install). `declarativeNetRequestWithHostAccess` has no install warning but needs host
permissions for every rule. Redirect and header-modification rules need host
permissions for the request URL and its initiator in either case. Add
`declarativeNetRequestFeedback` for `getMatchedRules` and `onRuleMatchedDebug`.

## Testing

`effect-platform-chrome/testing/DeclarativeNetRequest` exports
`makeDeclarativeNetRequest(options?, overrides?)`. It keeps dynamic and session rules
in memory with Chrome's atomic update and id-collision behavior (a collision rejects with
`Rule with id N does not have a unique ID.` and leaves the set unchanged), tracks enabled
rulesets and disabled static rule ids, records `setExtensionActionOptions` calls, and
exposes an `onRuleMatchedDebug` simulator. It never matches requests, so
`getMatchedRules` and `testMatchOutcome` return nothing unless you override them.
