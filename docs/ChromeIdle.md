# ChromeIdle

Import from `effect-platform-chrome/ChromeIdle`. `ChromeIdle` is an Effect v4 service over
`chrome.idle` (manifest permission `"idle"`); `make(api)` and `layer(api)` accept an
injectable Promise-based subset, which `chrome.idle` itself satisfies. `layerLive` reads the
global only when built and fails with `ChromeIdleError` operation `"initialize"` when the
namespace is missing, which is what Chrome does without the permission.

| Member | Chrome call | Notes |
| --- | --- | --- |
| `queryState(seconds)` | `queryState` | `"locked"` (screen locked or screensaver), else `"idle"` once there was no input for `seconds`, else `"active"`. |
| `setDetectionInterval(seconds)` | `setDetectionInterval` | Synchronous in Chrome. Sets the threshold behind `onStateChanged`'s `"idle"`; the default is 60. |
| `getAutoLockDelay` | `getAutoLockDelay` | An Effect value. Seconds before the screen locks while idle, 0 when it never does. Only ChromeOS reports a real delay; other platforms resolve 0. |
| `onStateChanged` | `onStateChanged` | A `Stream<IdleState>` of changes. |

- Every rejection or synchronous throw becomes `ChromeIdleError` with the Chrome member
  name as `operation` and the original `cause`, unchanged.
- Arguments go to Chrome unchanged. Chrome accepts an integer of at least 15 for both
  intervals and throws synchronously for anything else (`Value must be at least 15.`,
  `Invalid type: expected integer, found number.`), which the service reports as the typed
  error. Values above 14400 (four hours) are treated as 14400.
- The detection interval belongs to the extension: it is shared by every subscription and
  context, the last write wins, and it does not change `queryState`'s threshold.
- `getAutoLockDelay` is optional in `ChromeIdleApi` (Chrome 73+), so injected APIs without
  it still fit; running the Effect without it fails with the typed error instead of
  throwing. Whether it exists is checked each time the Effect runs.
- `make` reads no member of the API. Each call reads the member it needs when it runs,
  and each stream consumption reads `onStateChanged` when it starts; a throwing lookup is
  the typed error for that operation, not a defect.

## State changes

Chrome samples the state about once a second while a listener exists and fires
`onStateChanged` only when the state differs from the last one it saw: there is no initial
event, so read the current state with `queryState`. A locked screen wins over idleness, so
`"locked"` can follow `"active"` directly.

Each consumption of `onStateChanged` installs its own listener and removes it when the
stream ends, fails, or is interrupted, including after a registration that added the
listener and then threw. Callbacks arriving during or after removal are ignored. Each
subscription buffers at most **64 pending events**, dropping the oldest, because Chrome
callbacks cannot be backpressured.

The stream is an observation, **not an MV3 worker wakeup registration**. To be woken when
the user returns, register the listener synchronously at worker startup:

```ts
import { Effect } from "effect"
import * as ChromeIdle from "effect-platform-chrome/ChromeIdle"
import * as ChromeServiceWorker from "effect-platform-chrome/ChromeServiceWorker"

const worker = ChromeServiceWorker.start({
  chrome,
  layer: ChromeIdle.layerLive,
  listeners: [
    ChromeServiceWorker.listen(chrome.idle.onStateChanged, (state) => Effect.log("Idle state", state))
  ]
})
```

## Testing

`makeIdle(options)` from `effect-platform-chrome/testing/Idle` returns
`{ api, layer, controls }` over a simulated machine: an idle time (seconds since the last
input) and a lock. Options set the starting `idleTime`, `locked`, `detectionInterval` and
`autoLockDelay`, and `overrides` replaces any API member.

- `queryState` and `setDetectionInterval` validate like Chrome's bindings (a synchronous
  `TypeError`) and cap intervals at `maximumInterval` (14400); `minimumInterval` is 15.
- `controls.elapse(seconds)`, `input()`, `lock()` and `unlock()` (which counts as input)
  change the machine; input alone does not unlock. Time never passes on its own and
  nothing locks automatically.
- After every change, including `setDetectionInterval`, the state at the detection
  interval is evaluated at once and `onStateChanged` fires if it differs from the last one;
  `controls.state` reads it. Changes made from inside a listener are queued behind the
  current emission, so every listener sees the states in order.
- Controls return the exceptions listeners threw. `controls.failNext(operation, cause)`
  fails the next call once: `setDetectionInterval` throws, the others reject.

```ts
import { Effect, Fiber, Stream } from "effect"
import { expect, it } from "@effect/vitest"
import * as ChromeIdle from "effect-platform-chrome/ChromeIdle"
import { makeIdle } from "effect-platform-chrome/testing/Idle"

it.effect("reports the user going idle", () => Effect.gen(function*() {
  const fixture = makeIdle()
  const idle = ChromeIdle.make(fixture.api)
  const next = yield* Effect.forkChild(Stream.runHead(idle.onStateChanged))
  yield* Effect.promise(() => fixture.controls.onStateChanged.waitForListener())
  fixture.controls.elapse(60)
  expect(yield* Fiber.join(next)).toMatchObject({ value: "idle" })
}))
```

## Stress coverage

`test/stress/ChromeIdle.stress.test.ts` covers: the newest 64 of a 4,096-event burst, in
order, with nothing older left buffered, for one subscriber, for 64 concurrent
subscribers, and for a burst delivered during registration; callbacks during and after
removal; 512 concurrent subscriptions interrupted before start, after registration,
mid-delivery and while pulling, completing, or refused (fully or after a partial
registration), ending with zero listeners; 16 rounds of 32 subscriptions with 4,096 events
each; 1,536 concurrent calls settled in a seeded random order with interleaved rejections
and throws, each typed with its operation and cause; 1,024 pending calls interrupted and
settled later; 1,024 racing `setDetectionInterval` calls; a 20,000-step seeded walk of the
fixture against a reference model; 512 isolated fixtures; and 512 concurrent live-layer
builds and refusals. All schedules are seeded and gated, with no sleeps.
