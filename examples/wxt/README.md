# WXT example: all twelve Chrome integrations

Vanilla TypeScript, WXT **0.21.4**, Effect **4.0.4**, Chrome Manifest V3.
The popup is example UI, not a library UI abstraction. No Action, SidePanel,
or other UI-focused library modules are introduced.

## Build and load

Use Node **22.12+** (or a newer version supported by the root package).
From the repository root, build the library first:

```sh
npm install
npm run build
cd examples/wxt
npm ci
npm run typecheck
npm run build
```

The example depends on `effect-platform-chrome` through `file:../..`. Rebuild
the root after library changes, then rebuild the example. Its own lockfile pins
WXT and Effect; Vite deduplicates Effect across the linked library and example.
WXT auto-imports use the scope-aware `acorn` parser so linked library parameters
named `storage` are not rewritten into imports of `wxt/utils/storage`.

1. In Chrome 120+, visit `chrome://extensions` and enable Developer mode.
2. Click **Load unpacked**, choosing `examples/wxt/.output/chrome-mv3`.
3. Pin the extension and open its popup.

For development, `npm run dev` uses WXT's actual Chrome CLI (`wxt -b chrome`).
**Use the production build for worker suspension/wakeup checks**: WXT's dev
bootstrap deliberately keeps the worker alive.

## Manual checks

| Module | What to try / expected result |
| --- | --- |
| **ChromeStorage** | Change the input and click **Write local / sync / session**, then **Read demo keys**. All three contain the value; live `storage changed` entries show area and old/new values. Write a different value on a second click (identical writes need not emit events). **Read managed policy** either displays policy, reports an empty policy, or gracefully skips unavailable managed storage. Managed is read-only. Session values survive worker restarts but not a browser restart. |
| **ChromeKeyValueStore** | **Round-trip namespaced string + binary** returns the input string and `[0,1,127,128,255]`. **Clear only demo namespace** leaves the ChromeStorage demo key untouched; check using **Read demo keys**. |
| **ChromeRuntime** | **Metadata** displays extension ID, manifest and popup URL. **Schema ping** uses request encoding/response decoding and returns the worker's `{ok:true,value}` envelope. |
| **ChromePort** | **Connect** logs the background greeting and an automatic echo, then **Send value** produces another echo. **Disconnect / close scope** interrupts the popup fiber and releases its owned native port. Reconnect works; closing the popup also ends the background's scoped adopted connection. Initial sends wait for a greeting because adoption is gated by worker initialization. |
| **ChromeTabs** | **Query tabs** lists current-window tabs. **Open example.com** explicitly creates a tab; reopening the popup and clicking **Message example.com content script** returns the page title/URL. Refresh an existing example.com tab after installing/reloading the extension so its script is present. Create/update/remove/activate events are observed while the popup is open. Nothing navigates or closes existing tabs automatically. |
| **ChromeAlarms** | **Schedule one-shot (~1 min)** creates only the demo alarm. **Query demo alarm** reads it and lists current alarms. **Clear demo alarm** clears only that name. Leaving the popup open shows an observational alarm event; the independent synchronous background wake handler saves the handled alarm in local storage. |
| **ChromeServiceWorker** | **Worker / lifecycle / last alarm** shows initialization time, boot ID, last lifecycle event and last handled alarm. **Intentional handler error** produces a clean `{ok:false,error:{code:"HandlerFailed",...}}` response, not a hung response channel. Installation/startup and alarms use synchronous wake listeners; an extra synchronous tab-activation registration uses `worker.register`. |
| **ChromeRpc** | **Typed ping / fail / stream cancellation** opens a dedicated scoped port, waits for the adapter's Ping/Pong handshake, round-trips the input, decodes `DemoRejected`, and takes five streamed numbers (cancelling the remainder). The caller scope releases its connection; the worker's synchronous `onConnect` dispatch selects the RPC port name and serves until disconnect. |
| **ChromeSchemaStorage** | **Validated local entry** writes a schema-validated version-1 envelope. **Seed v0 / migrate to v1** deliberately replaces only the demo entry with a legacy envelope, validates/migrates it, and writes back version 1. **Subscribe** observes the initial value and updates; **Stop subscription** interrupts its fiber and removes the listener. Closing the popup also releases it. |
| **ChromePermissions** | **Contains / getAll** reads permission state. **Request example.com access** alone requests optional host access; its click handler calls `requestFromUserGesture` synchronously using an already-resolved service, before any asynchronous Effect execution. No scripted revocation. |
| **ChromeScripting** | First request example.com access, activate an example.com tab, then click **Read active example.com title via injection**. A self-contained function returns title/URL from only that active target. It does not modify the page or inject into arbitrary tabs. Chrome remains authoritative if a target navigates between query and injection. |
| **ChromeTesting** | `development/fixtures.ts` exports `fixtureExample()` with fresh storage/event/port fixtures, a migration, scoped subscription cleanup, and manually flushed port delivery. It is typechecked but not imported by any browser entrypoint. Run it in a development test host with `Effect.runPromise(fixtureExample())`; expected `received:7`, `frames:1`, `listeners:0`, `pendingFrames:0`. |

### Bounded browser stress

Click **Run 100 / 1000 / 5000 RPC + local churn** and keep the popup open, or open
`chrome-extension://<id>/popup.html` in a tab to avoid popup auto-close. The typed
automation hook is `await window.effectChromeStress.run()`; cancel using
`window.effectChromeStress.cancel()` or **Cancel stress**. Only one run is allowed
at a time. The overall deadline is five minutes.

Stages run sequentially: 100, 1000, then 5000 verified RPC echoes; 20 streams
cancelled after five verified values; 20 typed RPC failures; 1000 local storage
write/read/remove cycles with fresh scoped observers. Each observer's initial
emission gates registration explicitly. A unique `wxt-stress-<UUID>` namespace
isolates storage from the original demos; its one key is removed by a finalizer
on success, error or cancellation (abrupt browser termination cannot guarantee
finalizers). No sync writes, permission prompts/removals, or tab injection are
part of stress. Counts and timings are reported per stage, including partial
counts on failure; the returned report includes errors and total time. Success
means all six stages completed with counts 100/1000/5000/20/20/1000 and no errors.

Optional Chrome `performance.memory.usedJSHeapSize` snapshots describe the popup
heap only, not the worker or native resources. They are coarse, affected by GC,
and **do not prove absence or presence of leaks**. Existing raw storage-change
logging remains active and its display is capped at 24,000 characters. Browser
stress is explicitly opt-in, not a build-time test or a benchmark guarantee.

### Popup ↔ background ↔ content

- Popup → background: `ChromeRuntime.sendMessageSchema`, decoded by the
  worker handler; `ChromeServiceWorker` wraps its result exactly once.
- Content → background: the limited `https://example.com/*` content script
  sends the same schema ping and logs its response in the **page** console.
- Popup → content: `ChromeTabs.sendMessage` addresses an example.com tab;
  the content listener answers synchronously with a compatible success envelope.
- Popup ↔ background port: both endpoints acquire owned, scoped wrappers;
  port stream completion or interruption releases their listeners/connections.

Transport or schema failures appear as errors in popup output. A correctly
decoded worker failure envelope is a normal response, displayed as `ok:false`.
Listeners return `false` for unrelated message channels and never claim them.
No content-script storage.session access level is changed.

### Worker gating and real suspension

WXT 0.21.4's generated background entrypoint calls `definition.main()`
synchronously. `entrypoints/background.ts` calls `ChromeServiceWorker.start`
directly inside that callback, without awaiting anything. This installs message,
port, install, startup and alarm listeners before layer construction and the
deliberate 250 ms initialization delay. `worker.register` is also called before
returning. Up to 32 events/messages can wait for initialization. The queue is
in-memory, not durable; Chrome's message channel is not a permanent worker lease.

To manually investigate wakeup:

1. Use the production unpacked build. Read worker status and note its boot ID.
2. Schedule the one-minute alarm, then close the popup and any **worker DevTools**
   (inspecting the worker can keep it alive). Do not leave a demo port connected.
3. Avoid tab activation during the wait: this example also registers tab
   activation as a wake event. Wait at least 90 seconds; Chrome may delay alarms.
4. Reopen the popup and read status. The saved alarm should have a handling
   timestamp and the boot ID of the worker that handled it. The current worker
   may have a newer boot ID if reopening the popup woke it again.
5. To check a cold message path, let the worker become inactive, then open the
   popup and immediately click **Schema ping**. It should answer only after the
   initialization gate. Startup events require a browser restart; install events
   happen on installation/update, not on every worker wake. The lifecycle field
   records only the latest event and may be replaced by tab activation.

`worker.ready` logs its initialization Exit. There is no reliable graceful Chrome
worker termination callback: this example does not dispose the worker after a
request, or claim async finalizers run during browser termination. Popup pagehide
cleanup is best effort; context destruction also drops its native listeners and
ports. Observational stream buffers are bounded and sliding, not durable logs.

## Permissions and scope

- `storage`: local/sync/session, optional managed read and namespaced KV backing.
- `alarms`: one-shot demo alarm and wake event.
- `tabs`: tab title/URL queries and selecting an example.com message target.
- `scripting`: explicit function injection into the active example.com tab.
- Optional host permission: **only** `https://example.com/*`, requested only
  through the user button. Inspect **Contains / getAll** before/after the request.
- Content script injection matches **only** `https://example.com/*`; no
  `<all_urls>` or additional broad host permission is requested.
- WXT generates the ordinary `action.default_popup` manifest entry for the UI.

The example writes only its demo storage keys / KV namespace and clears only its
named alarm. Sync storage writes remain subject to Chrome's sync quotas.

## Verification / limitations

`npm run typecheck` and `npm run build` were run successfully. The generated
manifest contains MV3, its popup, its limited content-script match,
`storage`, `alarms`, `tabs`, `scripting` permissions and the optional example.com
host permission. No real-browser automation or
manual browser run was performed. In particular, actual worker suspension,
alarm wake timing, browser-restart startup events, managed enterprise policy,
and cross-device sync remain **unverified in a real browser**; the steps above
are a manual checklist, not claimed test results.
