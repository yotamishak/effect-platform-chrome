# Stress testing

## Deterministic module stress — `test/stress/`

`test/stress/<Module>.stress.test.ts` holds the conventions' stress cases for Alarms,
Storage, SchemaStorage, Runtime and Port, with shared helpers in `test/stress/support.ts`.
They synchronize on explicit gates (an event that completes a `Deferred` once N listeners
are registered at once; native calls held pending until N have arrived), never on sleeps,
and the whole directory runs in well under a second.

| Module | Cases |
| --- | --- |
| Alarms | 4,096-alarm burst keeps the newest 64 and removes its listener; 4 rounds of 512 concurrent subscriptions with 128 events each, interrupted odd-then-even (2,048 listeners added and removed); 1,024 concurrent calls across all five operations, every 7th throwing synchronously and the rest settled newest first with every other one rejected, each failure naming its operation; 512 calls interrupted mid-flight, then settled late |
| Storage | 4,096 local changes interleaved with 4,096 sync changes: `local.onChanged` keeps the newest 64 local ones (filtered events take no slot), the global stream the newest 64 of both; 4 rounds of 512 subscriptions spread over the four areas and the global stream; 1,024 concurrent calls over every area and operation, failures keeping `area` and `operation` |
| SchemaStorage | A 4,096-change burst (plus 8,192 unrelated key/area changes) coalesces to exactly `[initial, newest]` and removes the listener; 512 observers registered before their initial reads, half interrupted with the read still in flight; 512 concurrent `get`/`set`/`remove` with interleaved rejections keeping `area` and `operation` |
| Runtime | 4,096-event bursts on `onInstalled` and the three-argument `onMessageExternal` keep the newest 64; 4 rounds of 512 subscriptions across all six events; 1,024 concurrent calls over six Promise operations with interleaved rejections; 512 `sendMessage` calls interrupted mid-flight |
| Port | A 4,096-message burst drains its newest 64 after a clean disconnect; 512 concurrent adopt cycles (owned and borrowed) gated so all are open at once, ending by explicit disconnect, clean host disconnect, host `lastError` or scope close, with no listener left and owned ports disconnected exactly once unless Chrome reported the disconnect; 1,024 concurrent connects and sends, every 3rd connect and every other send failing, each failure keeping its operation |

## Limits runner — 2026-10-22

`examples/wxt` gained a limits runner (`popup/limits.ts`, `popup/limits-modules.ts`) that
drives every module, including the five added for extension adopters, to the Chrome
limit it meets in practice. It ran in two places:

- headless Chrome for Testing (Playwright, which passes `--disable-ipc-flooding-protection`)
  with a local stand-in for example.com: 27 of 29 stages passed, 2 skipped;
- a real Chrome 155 profile on macOS, driven over its debugging connection: 27 passed,
  0 failed, 2 skipped (capture without an `activeTab` grant, scripting without the optional
  example.com access), in 22.5 s. The original stress runner passed alongside it with zero
  errors.

What Chrome itself turned out to enforce, as observed in that real profile:

| Area | Observed |
| --- | --- |
| History updates | About 200 `pushState` calls per 10 s per frame; Chrome ignores the rest (one 500-call burst applied 98 to 298, depending on what the window had already used). Every applied update reached `onHistoryStateUpdated`, in order. Headless automation lifts the cap and delivers about 23 events/s. |
| Cookies | 400 cookies on one host kept 152, including the newest |
| Alarms | `An extension cannot have more than 500 active alarms.` |
| Storage | `local`: `Resource::kQuotaBytes quota exceeded` at the 11th 1 MB item; `session`: `Session storage quota bytes exceeded`; `sync`: `Resource::kQuotaBytesPerItem quota exceeded` for a 9000-character item |
| Capture | `captureVisibleTab` needs `<all_urls>` or `activeTab`, even on the extension's own pages |
| webNavigation | Reports nothing for `chrome-extension://` pages, so frame targets have to be web pages |
| Hidden pages | Chrome throttles a hidden runner page's timers: 10,000 redirect-URL lookups went from 29 ms to 2.2 s, and RPC readiness timeouts fired up to 3 s late |

And what the library did at those limits:

- `readyTimeout` (300 ms) failed every port that only an unrelated listener received, at
  302–314 ms; a port to a frame with no listener failed in under 15 ms.
- `finishAccepted`: 40 callers disconnected mid-call; all 40 wrapped handlers finished and
  all 40 plain ones were interrupted.
- RPC: 2048 concurrent calls on one port; a 1,000,000-character payload round-tripped and a
  1,100,000-character one was refused before sending (`Invalid or oversized outbound RPC frame`).
- Ports: 50 ports × 200 echoes with no loss under flow control; a 2000-message blast at one
  port lost 120 (and 1060 on a throttled page) to the documented 64-message sliding
  buffers, with what arrived in order and unduplicated.
- Runtime messaging: 10,000 concurrent `sendMessage` round trips in about 1.4 s.
- Schema storage: 256 subscribers all reached the last of 100 writes.


## Live Chrome observations — 2026-10-13

Tested the WXT development extension through `agent-browser`, connected to the
user-provided Chrome debugging server. These are observations from one local
browser, not portable throughput guarantees or an exhaustive proof of safety.

| Scenario | Observed result |
| --- | --- |
| 1,000 concurrent request/reply messages | 1,000 exact echoes; no failures; 150 ms |
| 5,000 concurrent request/reply messages | 5,000 exact echoes; no failures; 572 ms |
| 10,000 concurrent request/reply messages | 10,000 exact echoes; no failures; 1,294 ms |
| 50 simultaneous ports, 200 messages each | 10,000 echoes; no loss, duplicates, or cross-client replies; 236 ms |
| 500 immediate connect/disconnect cycles | Subsequent request/reply succeeded |
| Missing fields, wrong field types, unknown operation | `HandlerFailed` response envelopes |
| Null, empty object, unrelated channel | No demo response; no handler claim |
| Empty string, Unicode/NUL string, 1 MB string | Exact echo |
| Explicit extension reload | New worker boot ID; messaging recovered; local/sync keys persisted; session storage cleared |
| Scheduled alarm | Popup observed event; background handler persisted result |
| Alarm cancellation | Clear returned true; subsequent query absent |
| Namespaced key-value clear | Demo namespace empty; unrelated storage key retained |
| example.com content script | Correct title/URL response |

The attempted worker-stop test did not establish a stopped worker or a changed
boot ID. Its subsequent 100 successful messages therefore do **not** establish
cold-start overflow behavior. Development tooling and other extension events can
affect worker lifetime. Test natural suspension and cold startup separately with
a production build, without an attached worker inspector or development keepalive.

## Second live load pass

After the additional modules were implemented, the existing runtime/port demo
was exercised again with larger loads:

- **100,000 request/reply messages**, in ten consecutive batches of 10,000:
  every response matched its request, with zero rejected or incorrect responses.
  Batch durations ranged from 1,097 to 1,379 ms.
- **100 simultaneous ports, 1,000 messages per port**: all 100,000 messages
  returned, with zero duplicates, crossed-client responses, or failures; 2,094 ms.
- Popup JS heap samples rose from 27,365,688 to 35,348,996 bytes during the request
  workload. Garbage collection was not forced, and the sample excludes the worker.
  This is **not** evidence for or against a memory leak.

These workloads exercise the existing ChromeRuntime/ChromeServiceWorker/ChromePort
path. They do not establish throughput for the new Effect RPC transport or
schema-backed storage. Those integrations have separate stress coverage.

## Automated edge cases

### Final expanded-module validation

After integrating all twelve public modules, **332 tests across twelve suites**
pass, with zero lint warnings/errors, passing root typecheck/build, and passing
WXT typecheck/production build.

New-module deterministic stress includes:

- RPC: 2,048 simultaneous requests, 1,024 pending-call disconnects, 512 request
  cancellations, 4,096 stream chunks, and 128 stream cancellations.
- Schema storage: 20,000 events, 256 subscribers (128 cancelled), and 64
  concurrent migrations for each write-back mode.
- Permissions/scripting/fixtures: 512 subscriptions per event, 65,536 emissions
  per event, 4,096 gesture observers, 4,096 scripting runs, 4,096-listener
  snapshots, and 8,192 paired-port messages.

Additional fixes cover RPC readiness-cancellation hangs, disconnect under stream
backpressure, registration leaks and reentrant cleanup, schema-storage partial
registration leaks, duplicate storage selector handling in fixtures, and typed
handling of permissions API getter failures.

The updated WXT example was exercised in real Chrome after explicitly reloading
the extension (refreshing the popup alone had left an older background worker
running and caused the first RPC demo to time out). The updated worker passed:

- Typed RPC ping/failure and stream cancellation.
- Sequential RPC stages of 100, 1,000, and 5,000 calls (6,100 total).
- 20 stream-cancellation cases and 20 typed RPC failures.
- 1,000 isolated local schema-storage cycles with cleanup.
- Schema v0-to-v1 migration and validated writes.
- Permission inspection and script injection reading the example.com title/URL.

The stress runner reported zero errors in 1,504.5 ms. These RPC stages are
**sequential**, not concurrent; concurrent RPC behavior is covered by injected
transport tests. Optional permission prompting/revocation and natural worker
suspension were not exercised in the live browser pass. ChromeTesting is tested
as a development fixture, not a Chrome platform API.

First-pass integrated validation: **172 tests passed across seven files**, with zero
lint warnings/errors and passing library typecheck/build. WXT typecheck/build
also passed after the changes.

Stress coverage includes 4,096-event bursts, repeated subscription/interruption
cycles, 1,024-message startup overflow, 300 concurrent worker handlers, disposal
at each initialization stage, malformed storage encodings, namespace collisions,
and injected quota/access failures.

Confirmed defects fixed:

- Tabs and alarms could leak listeners after partially successful registration.
- Port cleanup exceptions could replace the original disconnect failure.
- Worker registration could leak listeners on partial or reentrant failures.
- Startup registration failure could leave queued responses unsettled.
- Unregistered generic worker callbacks could still execute when invoked late.
- Configured but unavailable worker events were silently ignored; startup now
  fails synchronously and cleans up registrations.

The `test/` suites use injected Chrome APIs so quota failures, unavailable APIs,
malformed stored values, registration failures, overflow, and cleanup races can
be reproduced without filling real storage or disrupting unrelated tabs.

Run:

```sh
npm run lint
npm run typecheck
npm run build
npm test
```

The WXT example has separate typecheck/build commands in `examples/wxt`.
Cross-device sync, enterprise-managed policy, actual quota ceilings, natural
worker suspension, and sustained heap-growth measurements remain separate
integration scenarios. No real storage quota exhaustion was attempted.
