# Stress testing

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
