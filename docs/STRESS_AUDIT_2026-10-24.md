# Stress audit — 2026-10-24

## Scope and evidence

This report distinguishes local fixture/injected-API results from live Chrome behavior. Passing tests do not establish native-browser fidelity. This audit does **not** claim that every possible edge case has been exhausted.

- The Tabs/Windows/TabGroups/Sessions investigator ran existing stress files individually and sequentially, inspected source and tests, and ran additional in-memory source probes. Those probes used Node's TypeScript stripping with an in-memory import hook; they did not write test files or invoke Chrome.
- Other suite counts and reproduced issues below were supplied by the main audit session. Their cited source locations were inspected for this report; those reproductions were not rerun by this investigator.
- The main session subsequently extended and rebuilt the example and ran the live cases below. Library source was not changed. No commits were made.
- Source references describe the working tree inspected on this date and can shift after subsequent edits.

## Test results

### Individually executed module stress files

Command for each: `npm test -- test/stress/<file>`.

| File | Passed | Run duration |
| --- | ---: | ---: |
| `ChromeTabs.stress.test.ts` | 12 | 1.54s |
| `ChromeWindows.stress.test.ts` | 16 | 627ms |
| `ChromeTabGroups.stress.test.ts` | 22 | 425ms |
| `ChromeSessions.stress.test.ts` | 12 | 1.41s |
| **Unique isolated tests** | **62** | |

All four files passed. A subsequent Tabs run with `--reporter=verbose` passed the same 12 tests in 1.48s; this repeat is not added to the unique count of 62. Its 10,000-tab test took **1,086ms**.

### Other results supplied by the main audit session

| Audit grouping | Stress passed | Unit passed |
| --- | ---: | ---: |
| Storage | 82 | 346 |
| Messaging | 63 | 361 |
| Remaining modules | 310 | 1,353 |

The four disjoint stress groupings total **517 passing stress tests**, each file executed separately. Subsequent full-suite runs passed **2,962 tests across 76 files**. Root lint, typecheck, build, and WXT typecheck/build passed. These automated results are mock/injected-source evidence, not live Chrome results.

## Tabs timeout investigation

The main session reported a 5,000ms timeout, with 6,081ms elapsed, at `test/stress/ChromeTabs.stress.test.ts:465` during a full test run concurrent with lint/build/browser work. It did not reproduce in either isolated module run.

The test seeds 10,000 tabs over 16 windows and executes 2,000 seeded operations (`test/stress/ChromeTabs.stress.test.ts:469–488`). Relevant work includes full-window reindexing on insertion (`src/testing/Tabs.ts:170–179`), full snapshots/filtering/sorting on query (`:481–483`), and scanning all tabs to prune groups (`:243–246`). This test has no mock-registration gate or intentionally unresolved promise indicating a deterministic deadlock.

**Assessment:** resource contention is the leading hypothesis, not a demonstrated root cause. The isolated 1,086ms result does not prove the test cannot exceed 5,000ms under load. `vitest.config.ts:3–10` does not override the default test timeout.

## Reproduced fixture findings

The following affect in-memory testing implementations. They are not evidence of defects in Chrome itself; no production-wrapper defect was confirmed by these four-module probes.

### F1. Tabs: explicit seeded IDs collide with generated IDs

- Reproduction: `seed({ id: 2, active: false }); seed({ active: false })`.
- Observed query projection: `[{ id: 2, index: 1 }]`, despite two insertions. The map entry is overwritten while duplicate IDs remain in the strip.
- Evidence: `src/testing/Tabs.ts:19–22` lets supplied properties overwrite the allocated ID; `:263–269` increments the counter without advancing past an explicit ID, writes the map, and inserts into the strip.
- Missing case: explicit IDs followed by generated IDs, duplicate-ID rejection, and consistency between map cardinality and strip membership. The large stress fixture uses generated IDs only (`test/stress/ChromeTabs.stress.test.ts:469`).

### F2. Tabs: newly allocated groups collide with seeded groups

- Reproduction: seed a tab with `groupId: 1`, seed an ungrouped tab, then group the latter without specifying `groupId`.
- Observed: the new group ID is also 1; unrelated tabs now share it.
- Evidence: `src/testing/Tabs.ts:123` initializes the allocator to 1; `:273` records seeded groups without advancing it; `:569–571` allocates unchecked.
- Missing case: generated group identity after seeding arbitrary group IDs.

### F3. Tabs: grouping ignores the requested destination window

- Reproduction: seed tabs in windows 1 and 2; call `group({ tabIds: [a, b], createProperties: { windowId: 3 } })`.
- Observed: both tabs receive group 1 while remaining in windows 1 and 2.
- Evidence: `src/testing/Tabs.ts:558–573` validates conflicting options but never applies `createProperties.windowId`; `setGroup` only changes group IDs (`:336–345`). The service describes the destination-window behavior at `src/ChromeTabs.ts:143–145`.
- Missing cases: grouping across windows, joining an existing group in another window, group contiguity, and group/window ownership invariants.

### F4. Tabs: navigation retains zoom settings

- Reproduction: set `{ mode: "manual", scope: "per-tab" }`, then update the tab URL.
- Observed: `getZoomSettings` still returns manual/per-tab settings.
- Evidence: `src/testing/Tabs.ts:384–390` updates navigation history/URL without resetting the settings stored at `:434–442`; history navigation likewise only changes the URL (`:347–361`). The service documents navigation resets at `src/ChromeTabs.ts:177–179`.
- Missing case: navigation after custom zoom settings, including history navigation.

### F5. Sessions: partial restore leaves stale selection/index state

- Reproduction: close a two-tab window whose first tab is active; restore that child tab; inspect the remaining closed window, then restore that window.
- Observed: its sole remaining tab has `index: 1, active: false`, including in the restored live-window result.
- Evidence: `src/testing/Sessions.ts:177–185` splices the child without reindexing or choosing another active tab; `:136–143` copies the remaining fields when restoring the window. The fixture promises exactly one active tab at `:90–92`.
- Missing cases: restore the selected child, restore the first/middle/last child, then validate the remaining window and its later restored form.

### F6. Tabs: wildcard matching exhibits pathological backtracking

- Reproduction: one tab with title `"a".repeat(28)`; query title `"*a".repeat(14) + "b"`.
- Observed: no matches; one query took **624ms** in the local source probe. This is one measurement, not a benchmark distribution.
- Evidence: `src/testing/Tabs.ts:36–41` translates every wildcard to regex `.*`, permitting combinatorial backtracking on failing inputs.
- Missing case: bounded adversarial title/URL matching tests. TabGroups already has a long-pattern performance test (`test/stress/ChromeTabGroups.stress.test.ts:665–671`); Tabs does not have its equivalent in the inspected stress file.

## Stress-test weaknesses and unverified leads

### Confirmed assertion/planning weaknesses

1. **Tautological group invariant.** `test/stress/ChromeTabs.stress.test.ts:530–531` builds a set from all observed group IDs, then asserts each observed ID belongs to that same set. It cannot detect nonexistent groups, cross-window groups, or discontiguous groups.
2. **Deferred `getCurrent` values do not mix optional outcomes.** At `test/stress/ChromeTabs.stress.test.ts:388`, settlement reads mutable `calls`. The test waits until all 1,024 calls have occurred before settling (`:392–395`), so every successful settlement sees the same even count and resolves to `tab`. The test accounts for success/failure counts (`:398–402`) but does not exercise mixed `Some`/`None` successes.
3. **Sessions' reference model omits tab invariants.** `test/stress/ChromeSessions.stress.test.ts:557–565,608–624` models IDs and changes, not active selection or tab indices, allowing F5 to pass.
4. **TabGroups replay is not an independent native-semantics oracle.** The concurrent move test replays the same fixture implementation (`test/stress/ChromeTabGroups.stress.test.ts:543–635`). Its additional strip/count invariants are useful, but equality with that replay alone cannot establish Chrome parity.

### Reproduced discrepancy requiring native-parity confirmation

`matchesGroupTitle("aaab", "*a?b")` returns `false`. The stated wildcard semantics admit a match (the star consumes one `a`, literal `a` consumes the next, `?` consumes the third, then `b`). The implementation does not revisit an earlier wildcard decision (`src/testing/TabGroups.ts:59–107`; contract at `:48–51`). **This is a reproduced contract discrepancy, not a verified difference from Chrome's actual matcher.** Native parity remains unverified.

### Static retention finding, not a measured heap leak

Windows stores every opened window's subject metadata at `src/testing/Windows.ts:227`. Removal deletes the live window and other state but never deletes its `subjects` entry (`:338–350`). Metadata is needed while queued events are dispatched, but no eventual pruning is present. The 10,000-window stress test checks visible windows/focus, not retained metadata (`test/stress/ChromeWindows.stress.test.ts:577–614`). Heap growth was not measured.

### Further coverage priorities

- Tabs: split-view invariants after moving/grouping/pinning; mutation from synchronous fixture event listeners; explicit-ID/group-ID combinations.
- Sessions: partial-window restore selection/index invariants and nested event-triggered changes.
- Windows: event-metadata lifetime after heavy create/remove churn.
- TabGroups: an independent wildcard oracle and native-parity checks beyond sequential replay.

These are follow-up targets, not additional reproduced bugs. Windows already exercises listener reentrancy in stress (`test/stress/ChromeWindows.stress.test.ts:687–773`); TabGroups also has targeted reentrancy tests in `test/ChromeTabGroups.test.ts:673–767`.

## Main-session reproduced injected/source issues

The main session supplied the following reproduced observations. Source references were checked here. Unless explicitly stated otherwise, these remain **injected/source-level findings with no live Chrome confirmation recorded in this report**.

| Issue | Reported observation and evidence | Classification |
| --- | --- | --- |
| Cookies target URL normalization | `ChromeCookies.detailsOf` interpolates raw cookie paths into a URL (`src/ChromeCookies.ts:111–120`), used by `removeCookie` (`:132`). Injected raw paths `/a?b`, `/a#b`, `/a/../b` expose targeting differences. Live Chrome instead stores `/a%3Fb`, `/a%23b`, `/b`; removal of cookies read back from Chrome passed. | Fixture/native normalization discrepancy; **not confirmed as a native adapter removal bug**. |
| SchemaStorage lone-surrogate round trip | Strings are accepted unconditionally (`src/ChromeSchemaStorage.ts:90–91`); encoding parses JSON back into an object (`:204–208`) and submits it to storage (`:296–301`). Live local/session storage replaced high and low lone surrogates with U+FFFD and collapsed two distinct nested object keys into one. | **Confirmed through native Chrome storage: six failed round-trip invariants.** Valid Unicode controls and cleanup passed. |
| Debugger failed-session listener retention | Repeated failed `session` acquisitions retained **100 `onEvent` + 100 `onDetach` listeners** until the parent scope closed. `listen` adds finalizers to the ambient scope (`src/ChromeDebugger.ts:185–197`); both listeners are acquired before the failing native attach (`:248–259`), without a per-attempt child scope in `session` (`:208–270`). | Reproduced injected acquisition-lifecycle issue; retention until parent close, not permanent after closure. |
| TabCapture callback getter throw | An asynchronously invoked capture callback whose injected `lastError` getter throws escapes before stream ownership is recorded, leaving a pending fiber and unstopped tracks. The getter precedes `owned = stream` (`src/ChromeTabCapture.ts:129–135`); the outer synchronous call catch (`:128–155`) cannot catch a later asynchronous callback exception. | **Injected only**; no assertion that Chrome's native getter throws. |
| RPC impossible Ping frame limit | `maxFrameLength: 1` passes positive-integer validation (`src/ChromeRpc.ts:104–114`). Ping exceeds the limit and fails outbound validation (`:192–194`), but the readiness sender ignores that error (`:259–264`). Requests await readiness (`:292–297`); omitted timeout installs no deadline (`:114,266–278`). | **Confirmed with native Chrome ports:** normal-limit control succeeded; tiny-limit call stalled until the external 500ms deadline (503ms with cleanup). |
| ServiceWorker structural listener lifecycle | A custom `Listener.attach` that installs through `gate.install` then throws retains installed listeners until disposal; a custom returned cleanup is skipped by disposal; an attach that does not call `install` can execute after disposal. `Listener` is structural (`src/ChromeServiceWorker.ts:63–64`); `install` alone guards disposal and tracks removers (`:423–445`); `attach` lacks rollback/disposed checking and returns custom cleanup only to its caller (`:448–485`); disposal drains installed removers (`:586–595`). Startup's separate catch does clean tracked removers (`:539–549`), so the retention finding concerns subsequent registration. | Reproduced with custom structural listeners; do not generalize to every built-in listener. |
| ServiceWorker error conversion throws | A callback throwing a null-prototype value reaches `String(cause)`, which can itself throw. `handlerFailed` performs unguarded coercion (`src/ChromeServiceWorker.ts:67`); callback catches call it before entering guarded `report` (`:460,471`; report guard at `:385–391`). | Reproduced injected callback/error-value issue. |
| Runtime cross-realm function guard | `message instanceof Function` misses functions from another realm, allowing them past the intended callback-overload guard. Evidence: `src/ChromeRuntime.ts:303–314`, specifically `:307`. | Reproduced again in Chrome with a real iframe function and **injected** sendMessage: one native-boundary invocation would have occurred. Actual Chrome function serialization was not invoked. |

## Live Chrome verification — completed

Chrome **155** on macOS; existing unpacked WXT extension, rebuilt from this worktree and reloaded through `chrome://extensions`. Agent-browser **0.39.2**, retained session `effect-chrome-stress`, user-provided server port 62939. The expanded example declares the permissions needed by its test modules; example.com access was granted. UserScripts was initially unavailable; its toggle was enabled for the bounded test and restored to **off** afterwards.

The final serial run covered **37 module groups plus 4 regression groups**: **38 passed, 3 regression groups failed (8 failed invariants)**. Passing groups still have the explicitly listed operation-level skips. ChromeMessage runs browser-side schema logic; ChromeTesting runs browser-side fixtures. Neither is claimed as a native API test.

| Module | Final exercised workload / result |
| --- | --- |
| ChromeRuntime | 10,000 concurrent verified messages passed |
| ChromeServiceWorker | 40 accepted handlers finished; 40 ordinary handlers interrupted after caller disconnect |
| ChromeStorage | 800 access-level calls; local/session quota refusal after ten 1MB items; oversized sync item refused; cleanup passed |
| ChromeKeyValueStore | 2,000 keys and 4MB binary round trip passed; namespace empty afterwards |
| ChromeAlarms | 500 accepted, 100 refused at Chrome's cap; all owned alarms removed |
| ChromePort | 10,000 controlled echoes passed; blast delivered 1,732/2,000, ordered and unique, with expected sliding-buffer loss |
| ChromeRpc | 2,048 concurrent calls; size boundaries; 20 readiness timeouts and 50 absent listeners passed |
| ChromeSchemaStorage | 256 observers reached final value after 100 writes |
| ChromePermissions | 5,000 concurrent contains calls passed |
| ChromeScripting | 100 injections × 7 frames passed |
| ChromeTabs | 2,000 fan-out echoes and 300 port churn cycles passed; capture skipped without toolbar activeTab grant |
| ChromeWebNavigation | 2,000 frame reads; 100 paced events; 98/500 burst updates applied by Chrome, all observed; 50 navigations passed |
| ChromeCookies | 120 set/read/remove cycles; 400-cookie cap left 152 including newest; cleanup passed |
| ChromeIdentity | 10,000 redirect URL reads and 10 noninteractive failure paths passed |
| ChromeWindows | 4,000 reads passed |
| ChromeNotifications | 250 create/update/clear operations passed |
| ChromeBookmarks | 240 reads plus owned folder/move/empty-title/invalid-operation checks passed |
| ChromeHistory | 240 visit reads plus unique URL insertion/search/deletion passed |
| ChromeDownloads | Tiny owned file, 240 reads/waits, completion and invalid pause checks passed; file and record removed |
| ChromeTabGroups | 240 reads plus owned grouping, title/collapse, ungroup/regroup and disappearance checks passed |
| ChromeSessions | 240 bounded reads and invalid-limit checks passed; no user session restored |
| ChromeManagement | 240 read-only self/inventory checks passed |
| ChromeI18n | 240 message/locale/detection calls plus missing/empty/short-input checks passed |
| ChromeDebugger | Four attach/command/event/detach cycles, 48 CDP commands passed; extension ownership released |
| ChromeOffscreen | Owned context create, 16 concurrent ensure calls and verified close passed |
| ChromeDeclarativeNetRequest | Eight dynamic and eight session rules: register/match/update/remove passed |
| ChromeWebRequest | Six actual HTTP requests observed with exact registration/removal accounting |
| ChromeUserScripts | Eight scripts registered, updated and unregistered after explicit Chrome toggle enablement |
| ChromeAction | 50 title/badge rounds and 100 scoped event subscriptions passed; original UI state restored |
| ChromeCommands | 200 reads and 100 scoped subscriptions passed |
| ChromeContextMenus | 100 owned hidden menu lifecycles and 100 scoped subscriptions passed |
| ChromeIdle | 100 state reads/subscriptions passed; unavailable ChromeOS-only auto-lock call verified as typed error |
| ChromeOmnibox | 200 scoped subscriptions and 200 local suggestion projections passed; no native typing simulated |
| ChromeSidePanel | 100 own-tab option round trips and 100 subscriptions passed; tab closed |
| ChromeTabCapture | 200 inventory reads and 100 subscriptions passed; no media captured |
| ChromeMessage | 5,000 schema/JSON cases passed: values, failures, void and malformed envelopes |
| ChromeTesting | 100 fresh fixture examples passed, including cleanup checks |
| ChromeRpc-edgecases | **Failed:** locally unsendable readiness frame stalls; control and cleanup passed |
| ChromeRuntime-edgecases | **Failed:** cross-realm callable reaches injected sendMessage; iframe cleanup passed |
| ChromeSchemaStorage-edgecases | **Six failures:** high surrogate, low surrogate, nested-key collapse, each in local/session; controls and cleanup passed |
| ChromeCookies-edgecases | **26 checks passed:** native normalization, removal through stored Cookie, shorter-path semantics, cleanup |

The original six-stage RPC/storage stress runner also passed (100/1,000/5,000 RPC calls, 20 cancellations, 20 typed errors, 1,000 storage churn cycles).

### Harness corrections and artifacts

- Idle's `getAutoLockDelay` is ChromeOS-only, so macOS absence is a verified typed-error capability check, not an adapter failure.
- `debugger.getTargets().attached` includes other CDP clients, including agent-browser. The corrected cleanup assertion verifies this extension cannot send a command after scope closure. It passed; the earlier global-attached assertion was invalid.
- Chrome normalizes cookie paths at SET. A SET using the root URL can also return the matching root cookie; the regression now reads the actual target back with `getAll` before removal. No native raw-path removal defect was demonstrated.
- A daemon response was lost while a resource-creating action had already run. The CLI now records a unique run token and inspects state instead of replaying an uncertain action.
- Final full report: `examples/wxt/.browser-stress/report-2026-10-24T14-22-01.682Z.json` (gitignored); console log: `.browser-stress/full-run.log`.
- Final inventory: zero offscreen documents, owned regression cookies, owned regression storage keys, owned download records, and reserved test DNR rules. See `.browser-stress/final-cleanup.json`.
- Saved connection: `.browser-stress/connection.json`; repeat using `npm run stress:live` from `examples/wxt`. The connection remains attached; Chrome controls its own approval prompts.

Gesture-only panel opening/capture, actual command/omnibox user input, native idle transitions, natural worker suspension, browser restart, enterprise policy and cross-device sync remain unexercised. TabGroups wildcard native parity remains unverified. The separate injected-only findings above are not promoted to native Chrome defects.
