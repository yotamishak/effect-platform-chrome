# ChromeSchemaStorage

Versioned, schema-typed Chrome storage with missing-only defaults and scoped,
cross-context observation. Imports do not access `chrome`.

## Setup and entries

```ts
import { Effect, Layer, Schema, Stream } from "effect"
import * as Storage from "effect-platform-chrome/ChromeStorage"
import * as TypedStorage from "effect-platform-chrome/ChromeSchemaStorage"

const Preferences = Schema.Struct({
  theme: Schema.Literals(["light", "dark", "system"])
})

// Neither layer reads `chrome` until it is built.
const appLayer = TypedStorage.layer.pipe(Layer.provide(Storage.layerLive))

const program = Effect.gen(function*() {
  const storage = yield* TypedStorage.ChromeSchemaStorage
  const preferences = storage.entry({
    namespace: "com.example.extension",
    key: "preferences",
    area: "local",
    version: 1,
    schema: Preferences,
    defaultValue: () => Effect.sync(() => Preferences.make({ theme: "system" }))
  })

  // Option<Preferences>; Some(default) when absent because a factory was supplied.
  const current = yield* preferences.get()
  yield* preferences.set({ theme: "dark" })
  yield* preferences.remove

  // Initial snapshot, then validated changes from every extension context.
  // Run in an owned fiber if other work must proceed concurrently.
  yield* Stream.runForEach(preferences.observe, (value) => Effect.log(value))
  return current
})

// At the application entrypoint:
// Effect.runPromise(program.pipe(Effect.provide(appLayer)))
```

`TypedStorage.layer` takes no arguments: it builds on whichever `Storage.ChromeStorage`
service is in context, so for an injected Chrome API provide `Storage.layer(api)`
instead of `Storage.layerLive`, or call `TypedStorage.make(Storage.make(api))`.
`TypedStorage.layerLive` is shorthand for `TypedStorage.layer` over `Storage.layerLive`:
it reads `chrome.storage` only when built and fails with a `ChromeStorageError` whose
operation is `"initialize"` where the namespace is missing.
Reads, writes and observation all go through that one service. Observation registers
its listener on the service's low-level `changeEvent` (the wrapped API's native
`storage.onChanged`) synchronously, before the first read, because the `onChanged`
stream has no listener-ready handshake.

## API and stored format

`entry(options)` creates a reusable descriptor, without reading or writing storage.
Options are `namespace`, `key`, `area` (`local`, `sync`, `session`, or `managed`; any
other value, possible only from untyped callers, fails every operation with `configuration`),
non-negative safe-integer `version`, `schema`, optional `defaultValue`, and optional
`migrations`. The physical key is `storageKey(namespace, key)`, the JSON encoding of
the two-string tuple. This prevents namespace/separator collisions, including empty,
Unicode, and special property names. It does not reserve keys against raw storage users.

An entry stores exactly this format:

```json
{ "version": 1, "payload": { "theme": "dark" } }
```

- `get({ writeBack?: boolean })`: returns `Effect<Option<schema.Type>>`.
  Omitted `writeBack` is `false`.
- `set(value)`: schema-encodes and JSON-validates before writing the current envelope.
- `remove`: removes only this entry. It does not write the default.
- `observe`: a cold stream; each subscription owns a listener and initial read.

Absence means **no own physical-key property** in the read result. An own property
containing `undefined`, `null`, an unwrapped value, a malformed envelope, or an invalid
payload is an error, not absence. A change with no own `newValue` means deletion.
Deletion emits `None`, or a freshly evaluated default as `Some`. An own `newValue`
of `undefined` is invalid. Defaults are evaluated only for absence/deletion, validated
through schema encoding, JSON validation, and decoding, and never persisted. Supply
an effect/factory that constructs fresh values; do not return a shared mutable singleton.

## Migrations

Each migration is `{ from, run }`, where `run` takes a JSON **encoded payload** and
returns an Effect producing the encoded payload for `from + 1`. Async operations,
typed failures, and Effect services are supported. Decode the old shape explicitly:

```ts
const OldPreferences = Schema.Struct({ dark: Schema.Boolean })

const migratedProgram = Effect.gen(function*() {
  const storage = yield* TypedStorage.ChromeSchemaStorage
  const preferences = storage.entry({
    namespace: "com.example.extension",
    key: "preferences",
    area: "local",
    version: 1,
    schema: Preferences,
    migrations: [{
      from: 0,
      run: (payload) => Effect.gen(function*() {
        const old = yield* Schema.decodeUnknownEffect(OldPreferences)(payload)
        return { theme: old.dark ? "dark" : "light" }
      })
    }]
  })
  return yield* preferences.get({ writeBack: true })
})
```

Every intermediate migration output must be JSON-compatible. The final payload
must decode with the current schema. Only after all these steps succeed does an
explicit writable-area `get({ writeBack: true })` re-read the entry and, if it still
holds the envelope that was migrated, encode and write the current value. A failing
re-read or write fails the read; it does not report success. Current-version reads do
not rewrite. Missing values do not persist defaults even with write-back enabled.
Missing migration steps, duplicate/out-of-range migration declarations, and future
stored versions fail. Unwrapped legacy data is not implicitly version zero.

Managed storage supports migrations **in memory only**. `set`, `remove`, and any
`get({ writeBack: true })` fail with `readOnly`, even for missing/current values.
`observe` never persists migrations in any area.

Migration write-back is a read/transform/check/write, not a transaction. Before writing,
it re-reads the entry and writes only if the stored envelope still has the migrated
snapshot's version and JSON payload. A write, replacement, corruption, or removal by
another context while the migration ran therefore wins: the read still returns the
migrated snapshot, and nothing is written (a removed entry is not resurrected). Chrome
storage has no compare-and-swap, so a write landing between that re-read and the
write-back can still be overwritten; the window is two storage calls, not the whole
migration. Concurrent write-back readers of the same snapshot each write the same
current envelope. Migrations should be deterministic, repeatable, and preferably free
of side effects. Use an application-level single writer if any lost write is
unacceptable. The default `get()` and `observe` migrate only their captured snapshots
and never write, so a newer concurrent write is preserved, although the returned
snapshot may already be stale.

## JSON contract

The schema's **encoded** representation must be strict JSON. A `DateFromString`
schema is supported; a raw `Schema.Date` is not. Serialization validates before
calling Chrome and performs a real JSON round-trip. Supported values are null,
booleans, strings, finite numbers other than negative zero, dense undecorated arrays,
and plain objects (including null-prototype objects), recursively.

Undefined, bigint, functions, symbols, NaN/infinity/negative zero, Date/Map/class
instances, cycles, sparse arrays, array extra properties, accessors, symbol keys,
non-enumerable properties, and custom `toJSON` functions are rejected rather than
silently omitted or coerced. Repeated non-cyclic references are allowed and become
independent JSON values. Schema encoding may intentionally transform/filter domain
values; validation applies to its resulting encoded payload. Very deep structures
may exceed the JS stack and produce a typed JSON error.
Strings, including Unicode, escaped characters, and lone surrogates, round-trip
through JSON without a library size limit. JS string length is not a UTF-8 byte or
Chrome quota calculation; storage quota failures propagate as `ChromeStorageError`.

## Observation and errors

Configuration is checked before anything is registered. Listeners then register
synchronously before the initial get. A relevant event delivered during registration
skips the initial read entirely; one received during the read invalidates its result,
including typed failures.
An event arriving during async decoding/migration similarly invalidates the obsolete
result. Processing is sequential; obsolete computations finish before the latest
event is decoded. Defects are not suppressed. Filters match both area and physical key.

Both pending events and emitted values use one-element sliding buffers. This is a
**latest-state stream**, not a lossless event log: bursts and slow consumers coalesce
updates, possibly including invalid intermediate values. Values are not deduplicated.
Current validation, migration, default, read, and registration failures terminate the
stream. Listeners are removed on completion, failure, downstream failure, or interruption.
Chrome worker termination may skip finalizers; listeners are not worker wakeup handlers.
Cleanup is installed before registration, including when an injected API registers
and then throws. A throwing `removeListener` is a finalizer defect, not a successful
stream completion; if the API throws before removal, actual removal cannot be
guaranteed. Cancellation interrupts owned asynchronous migrations/defaults but
cannot undo their external side effects or a Chrome operation already submitted.

The unit suite uses 20,000 queued event updates, 256 simultaneous subscribers (half
cancelled during gated reads), and 64 concurrent migration reads in each write-back
mode. `test/stress/ChromeSchemaStorage.stress.test.ts` adds: a 4,096-change burst
coalescing to exactly `[initial, newest]`; a blocked consumer receiving exactly the
newest change of each seeded chunk, in order; 4,096 superseded failing migrations
dropped, with only a current failure ending the stream; 512 observers interrupted in
seeded order before starting, during the initial read, default, or migration, while
idle, and while migrating a change, ending with every listener removed and no writes;
2,048 observed entries through a clear-like deletion and a migrating change; 1,024
concurrent write-back migrations of one envelope with and without a concurrent writer;
and 1,536 concurrent `get`/`set`/`remove` calls with interleaved rejections and
synchronous throws, each reported with its area and operation. These are bounded mocked
races, not browser quota, heap, cross-process scheduling, or atomicity benchmarks.

Errors preserve `ChromeStorageError` (with the Chrome `area` and `operation`, such as
`"get"`, `"set"`, `"remove"`, or `"onChanged"` for listener registration) and
`Schema.SchemaError`. Library failures use `ChromeSchemaStorageError` with `operation`
(the entry member: `"get"`, `"set"`, `"remove"`, or `"observe"`, which covers its
initial read and each change), `key`, `reason`, and `cause`; reasons are
`configuration`, `envelope`, `futureVersion`, `migration`, `json`, and `readOnly`.
Migration/default typed failures propagate unchanged. Schema encode/decode service
requirements and migration/default requirements remain in the returned Effect/Stream
types; callers provide them at execution time. Reads/observation include encoding
requirements for default validation and optional write-back. This is not a transaction,
locking mechanism, quota manager, or persistence guarantee after worker shutdown.
