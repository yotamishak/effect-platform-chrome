# ChromeTesting

Import `effect-platform-chrome/ChromeTesting`. These injected fixtures have no
Vitest runtime dependency and never access Chrome globals. They cover the
`ChromeStorage`, `ChromeTabs` and `ChromePort` adapters, not every Chrome service;
the other services take a plain object through `make(api)` or `layer(api)`.
Create a fixture **inside each test**. Its layer and raw API intentionally share
that fixture's state; calling the factory again creates independent state.

## Storage service consumers

```ts
import { Effect } from "effect"
import { expect, it } from "@effect/vitest"
import * as ChromeStorage from "effect-platform-chrome/ChromeStorage"
import * as ChromeTesting from "effect-platform-chrome/ChromeTesting"

const readTheme = Effect.gen(function*() {
  const storage = yield* ChromeStorage.ChromeStorage
  return yield* storage.local.get({ theme: "light" })
})

it.effect("reads configured settings", () => Effect.gen(function*() {
  const fixture = ChromeTesting.makeStorage()
  fixture.controls.seed("local", { theme: "dark" })
  expect(yield* readTheme.pipe(Effect.provide(fixture.layer)))
    .toEqual({ theme: "dark" })
}))
```

Alternatively use `ChromeStorage.make(fixture.api)` directly. The raw API is a
structural Promise-based subset, **not** `typeof chrome.storage`: callback
overloads and quota constants are absent. Access levels are recorded per area,
starting from Chrome's defaults (`session` trusted contexts only, the others open);
`controls.accessLevel(area)` reads the current one.

- `local`, `sync`, `session` support `get`, `set`, `remove`, `clear`,
  `getBytesInUse` and per-area `onChanged`. `managed` exposes only reads/events.
- `get()`/`get(null)` reads all keys, a string/array selects existing keys, and
  an object supplies defaults for missing keys (stored `null` overrides defaults).
  Duplicate array selectors are deduplicated; `__proto__`, `constructor` and
  `toString` remain ordinary own data keys, including in defaults.
- `controls.seed(area, items, emit = false)` **replaces** the entire area,
  including managed policy. This is privileged test setup, not a service write.
- `controls.failNext(area, operation, cause)` queues a one-shot Promise rejection
  before any mutation. Failures are isolated by area and operation.
- Only changed keys emit; object key order does not affect equality. Removal
  contains `oldValue` only; insertion contains `newValue` only. Missing-key
  removal, equal writes and empty clears do not emit.
- Changes dispatch synchronously after mutation, before the operation's Promise
  settles: global event first, per-area second, with separate cloned payloads.
  This deterministic ordering is not a browser timing guarantee. Reentrant
  writes can nest emissions. Listener exceptions do not reject successful writes.
- Inputs, reads/defaults and event payloads do not alias backend state. The
  serialization model is `JSON.stringify`/`JSON.parse`: undefined object entries
  disappear, dates become strings, unsupported array entries become null,
  cycles/BigInt reject atomically. Chrome's handling of non-JSON objects can
  differ; prefer schema-validated JSON data. This is not structured-clone storage.
- Bytes are approximately UTF-8 key bytes plus UTF-8 JSON value bytes, with
  duplicate selectors counted once. This **does not implement Chrome quotas**,
  session memory accounting, persistence, sync propagation or managed policy APIs.

For streams, fork an owned consumer, then await
`Effect.promise(() => fixture.controls.onChanged.waitForListener())` before
writing. Join or interrupt the fiber before asserting `listenerCount === 0`.
The service registers global listeners even for area-filtered streams.

## Typed events

`makeEvent<[value: string, count: number]>()` returns `{ api, controls }`.
The API has `addListener`, `removeListener`, `hasListener`, `hasListeners`.
Declarative-rule methods exist only for structural compatibility and throw.

`controls.emit(...args)` synchronously visits an insertion-ordered snapshot.
Duplicate listener identities register once; removals/additions affect subsequent
emissions, not the current snapshot. Reentrant emissions take a fresh snapshot.
All listeners run even when one throws: `emit` returns the caught exceptions in
order instead of throwing/logging. Async listener rejections are not captured.
Arguments are shared between listeners within one emission (not cloned).

Controls also expose `listenerCount`, `waitForListener()` (resolves immediately
if already registered), and `failNext("addListener" | "removeListener", cause)`.
Use the gate for explicit registration synchronization, not scheduler sleeps.
The gate has no cancellation or timeout; await it only when registration is
expected. Assertions inside listeners can be swallowed; assert captured data or
the returned exception list **outside** the callback.

## Paired ports

```ts
const pair = ChromeTesting.makePortPair("test")
const ports = ChromePort.make(pair.left.api)
// Within an Effect scope:
const port = yield* ports.connect()
pair.right.port.postMessage({ reply: "ok" })
pair.controls.flush()
// port.messages now contains the reply; owned acquisition cleans up on scope exit.
```

Import `ChromePort` from `effect-platform-chrome/ChromePort` for this snippet.
Each endpoint exposes `{ port, api, layer }`; layers provide `ChromePort` to service
consumers. `connect` returns that one endpoint; it does not create new connections
or route extension IDs/options. The constructor sets the connection name.

Messages are JSON-cloned when posted and queued FIFO. `flushOne()` delivers one
task and returns whether a task existed. `flush()` drains only its initial queue
snapshot: reentrant posts wait for another flush. `pendingCount` counts queued
tasks, including disconnect notifications and deliveries that will be discarded.

Native `port.disconnect()` closes both ends immediately, drops pending messages,
and queues **only the peer's** disconnect event, at most once. Further sends
throw. `controls.disconnect(error?)` simulates an external loss and queues one
notification for each end. `api.lastError` is set only during that endpoint's
disconnect dispatch and cleared even if listeners throw. Owned service release
removes listeners and closes the connection; borrowed adoption only detaches.

`controls.left/right` expose `message`/`disconnect` event controls and
`failNext("postMessage" | "disconnect" | "connect", cause)` for synchronous
one-shot native failures. Event `emit` is a deliberate low-level escape hatch;
it bypasses connection state. Automatic dispatch discards listener exceptions,
like storage; use direct event controls when inspecting exception behavior.

This models one two-endpoint connection, not browser task scheduling, multiple
receivers, sender metadata, worker lifetime, transferables or native messaging.
Use real-browser tests for those behaviors.

## Stress coverage

Tests cover 4096-listener snapshots with reentrant removal and throwing callbacks,
8192 bidirectional FIFO port messages, and disconnect after the first of 4097
queued messages (discarding the remaining 4096). Double disconnects do not replace
callback-scoped `lastError`; throwing/reentrant listeners do not leak it. Storage
tests check duplicate selectors, prototype-like keys, defaults, and nested cloning
at synchronous get/set boundaries. These are deterministic fixture contracts,
not claims about native browser scheduling or serialization fidelity.

## Tabs

`makeTabs(overrides?)` is an in-memory tab strip behind `ChromeTabs.layer`. Tabs
keep the properties they were created, seeded or updated with; `query` matches
`active`, `windowId` and exact `url`s (no match patterns). `create`, `update` and
`remove` emit the matching events synchronously. `get`, `update` and `remove` reject
an unknown id as Chrome does, and `sendMessage` rejects as Chrome does with no
receiver.

- `controls.seed(properties)` adds a tab and returns it with its id;
  `controls.tab(id)` reads the live record.
- `connect` returns one end of a `makePortPair`, and records the connection in
  `controls.connections` with the pair, so a test can serve the other end
  (`ChromeRpc.serve` on `pair.right.port`) or leave it unanswered.
- `captureVisibleTab` resolves to an empty JPEG data URL.
- `overrides` replaces any member, for behaviour the strip does not model, such as a
  `get` that reports `about:blank` until a navigation commits.
