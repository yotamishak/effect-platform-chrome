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

// Call at a browser runtime boundary, not during module initialization.
const makeAppLayer = () => TypedStorage.layer(chrome.storage.onChanged).pipe(
  Layer.provide(Storage.layer)
)

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
// Effect.runPromise(program.pipe(Effect.provide(makeAppLayer())))
```

For an injected Chrome API, use `TypedStorage.make(Storage.make(api), api.onChanged)`.
Alternatively provide `Storage.ChromeStorage` and build `TypedStorage.layer(api.onChanged)`.
The event source **must belong to the same API/backend** as the storage service.
It is supplied explicitly because `ChromeStorage.onChanged` does not expose a
listener-ready handshake: synchronous registration is necessary before the first read.

## API and stored format

`entry(options)` creates a reusable descriptor, without reading or writing storage.
Options are `namespace`, `key`, `area` (`local`, `sync`, `session`, or `managed`),
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
explicit writable-area `get({ writeBack: true })` encode and write the current value.
Write failure fails the read; it does not report success. Current-version reads do
not rewrite. Missing values do not persist defaults even with write-back enabled.
Missing migration steps, duplicate/out-of-range migration declarations, and future
stored versions fail. Unwrapped legacy data is not implicitly version zero.

Managed storage supports migrations **in memory only**. `set`, `remove`, and any
`get({ writeBack: true })` fail with `readOnly`, even for missing/current values.
`observe` never persists migrations in any area.

Migration write-back is a non-atomic read/transform/write. Chrome storage provides
no compare-and-swap here: another context can write during migration and be overwritten.
Migrations should be deterministic, repeatable, and preferably free of side effects.
Use an application-level single writer if concurrent migration writes are unacceptable.
The default `get()` and `observe` migrate only their captured snapshots, so a newer
concurrent write is preserved, although the returned snapshot may already be stale.
Opting into write-back can overwrite even a current/future-version envelope written
while the migration is suspended. No retry or second read can provide atomicity;
coordinate all writers externally rather than treating write-back as a transaction.

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

Listeners register synchronously before the initial get. Relevant events received
during registration/read invalidate that read's result, including typed failures.
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

The deterministic stress suite uses 20,000 queued event updates, 256 simultaneous
subscribers (half cancelled during gated reads), and 64 concurrent migration reads
in each write-back mode. These are bounded mocked races, not browser quota, heap,
cross-process scheduling, or atomicity benchmarks.

Errors preserve `ChromeStorageError` and `Schema.SchemaError`. Library failures use
`ChromeSchemaStorageError` with `key`, `reason`, and `cause`; reasons are
`configuration`, `envelope`, `futureVersion`, `migration`, `json`, and `readOnly`.
Migration/default typed failures propagate unchanged. Schema encode/decode service
requirements and migration/default requirements remain in the returned Effect/Stream
types; callers provide them at execution time. Reads/observation include encoding
requirements for default validation and optional write-back. This is not a transaction,
locking mechanism, quota manager, or persistence guarantee after worker shutdown.
