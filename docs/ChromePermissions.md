# ChromePermissions

Import from `effect-platform-chrome/ChromePermissions`. `ChromePermissions` is an
Effect v4 service; `make(api)` and `layer(api)` accept an injectable promise-based
`chrome.permissions` subset. `layerLive` reads the global only when built, so
importing the module needs no Chrome global.
Each live layer build snapshots the API property once; accessor failures use the
typed initialization error boundary.

- `getAll` is an Effect value: each execution queries fresh permissions.
- `contains(permissions)`, `request(permissions)`, and `remove(permissions)` are
  lazy Effects returning Chrome's boolean unchanged. Missing access, user denial,
  or unsuccessful removal (`false`) is not an exception.
- API synchronous throws and promise rejections become `ChromePermissionsError`,
  preserving `operation` and the original `cause`; live initialization uses
  `operation: "initialize"`.
- `onAdded` and `onRemoved` emit `chrome.permissions.Permissions`. Each consumption
  installs its own scoped listener and removes it on completion, registration
  failure (including partial insertion), or interruption. Late callbacks are
  ignored. Each subscription buffers at most **64 pending events**, dropping the
  oldest on overflow. Events are changes, not complete permission snapshots.
  Event properties are resolved lazily per consumption; a throwing getter becomes
  a typed error with the event name as `operation`, rather than throwing from `make`.

## Requests and user gestures

[Chrome requires requests inside a user gesture](https://developer.chrome.com/docs/extensions/reference/api/permissions#implement_optional_permissions).
Declare optional API permissions in `optional_permissions` and host patterns in
`optional_host_permissions` in the manifest. Chrome validates what is requestable;
this module does not grant access or bypass that validation.

Normal `request` stays lazy: composing it inside a click handler does not call
Chrome. Effect 4.0.4's `runFork` begins evaluation immediately, and `tryPromise`
invokes the native thunk when reached, but preceding async work, runtime/layer
initialization, or yielding can move that invocation outside the gesture.
`runSync` cannot await Chrome's asynchronous result. Neither runner is a blanket
user-activation guarantee.

Use **`requestFromUserGesture` directly on the synchronous handler stack**, before
any `await`, timer, message hop, or Effect scheduling. This explicitly imperative
bridge calls Chrome immediately and returns an Effect for the already-started
request's outcome. Do not invoke it while composing reusable programs. It does not
create a gesture; Chrome still decides whether the current call is eligible.

```ts
import { Effect } from "effect"
import * as ChromePermissions from "effect-platform-chrome/ChromePermissions"

// Extension page setup, before the gesture (not module import in shared code).
const permissions = ChromePermissions.make(chrome.permissions)
const button = document.querySelector<HTMLButtonElement>("#enable-tabs")!

button.addEventListener("click", () => {
  // Native request begins here synchronously, before runFork is involved.
  const outcome = permissions.requestFromUserGesture({ permissions: ["tabs"] })
  Effect.runFork(outcome.pipe(
    Effect.tap((granted) => Effect.log(granted ? "Granted" : "Declined")),
    Effect.catch((error) => Effect.logError(error))
  ))
})
```

Repeatedly executing the bridge's returned Effect observes the **same request**,
not a new prompt; call the bridge again only for a new gesture. Rejection handlers
are attached immediately even if the outcome Effect is never consumed.
Interruption stops waiting; it cannot cancel Chrome's prompt or undo a grant.
Ordinary lazy calls similarly cannot cancel native permission operations.

## MV3 worker wakeups

Scoped streams are runtime observations, **not worker wakeup registration**.
Install wakeup listeners synchronously at worker startup via
`ChromeServiceWorker.register`, before awaiting `worker.ready`:

```ts
import { Effect } from "effect"
import * as ChromePermissions from "effect-platform-chrome/ChromePermissions"
import * as ChromeServiceWorker from "effect-platform-chrome/ChromeServiceWorker"

const worker = ChromeServiceWorker.start({
  chrome,
  layer: ChromePermissions.layerLive,
  selectMessage: () => false,
  onMessage: () => Effect.void
})

worker.register(chrome.permissions.onAdded, (added) => Effect.log("Permissions added", added))
worker.register(chrome.permissions.onRemoved, (removed) => Effect.log("Permissions revoked", removed))
```

Worker startup buffering follows `ChromeServiceWorker`'s bounded startup queue,
not the streams' sliding buffer. Chrome can terminate workers without finalizers;
these events and buffers are not durable history. Recheck `getAll`/`contains` before
permission-dependent work, and handle revocation races in the relevant API call.
No host-access request UI APIs are included.

## Stress coverage

Injected tests cover each event's newest-64 retention after 4096 synchronous
startup events, then 16 rounds of 32 concurrent subscriptions with 4096-event
bursts per round (512 subscriptions and 65536 emissions per event). Registration
gates and joined interruptions verify cleanup without sleeps. Another test runs
4096 observers of one immediate gesture outcome and verifies a single native call.
No test prompts for real permissions.
