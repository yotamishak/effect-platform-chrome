import { Context, Effect, Fiber, Layer, Option, Predicate, Queue, Schema, Semaphore, Stream } from "effect"
import { attempter } from "./internal/api.js"
import { ChromeStorage, ChromeStorageError, layerLive as storageLayerLive } from "./ChromeStorage.js"
import type { AreaName, Changes, ChromeStorageService } from "./ChromeStorage.js"

/** The entry member that failed: `observe` covers its initial read and every change it decodes. */
export type Operation = "get" | "set" | "remove" | "observe"

export class ChromeSchemaStorageError extends Schema.TaggedError<ChromeSchemaStorageError>()("ChromeSchemaStorageError", {
  operation: Schema.Literals(["get", "set", "remove", "observe"]),
  key: Schema.String,
  reason: Schema.Literals(["configuration", "envelope", "futureVersion", "migration", "json", "readOnly"]),
  cause: Schema.Defect()
}) {}

export type EntryError = ChromeStorageError | ChromeSchemaStorageError | Schema.SchemaError

/** Migrations receive JSON payloads and return the next version's encoded payload. */
export interface Migration<E = never, R = never> {
  readonly from: number
  readonly run: (payload: Schema.Json) => Effect.Effect<Schema.Json, E, R>
}

export interface EntryOptions<S extends Schema.Constraint, E = never, R = never> {
  readonly namespace: string
  readonly key: string
  readonly area: AreaName
  readonly version: number
  readonly schema: S
  readonly defaultValue?: () => Effect.Effect<S["Type"], E, R>
  readonly migrations?: ReadonlyArray<Migration<E, R>>
}

export interface ReadOptions {
  /**
   * After a successful migration, write the current version back, unless another writer
   * changed or removed the entry while the migration ran. Fails with `readOnly` for
   * `managed`. Defaults to `false`.
   */
  readonly writeBack?: boolean
}

export interface Entry<S extends Schema.Constraint, E, R> {
  /** The physical Chrome storage key: `storageKey(namespace, key)`. */
  readonly storageKey: string
  /** The decoded, migrated value; `Some(default)` when absent and a default is given, otherwise `None`. */
  readonly get: (options?: ReadOptions) => Effect.Effect<Option.Option<S["Type"]>, EntryError | E, R | S["DecodingServices"] | S["EncodingServices"]>
  /** Schema-encodes, JSON-validates and writes the current-version envelope. */
  readonly set: (value: S["Type"]) => Effect.Effect<void, EntryError, S["EncodingServices"]>
  /** Removes only this entry; never writes the default. */
  readonly remove: Effect.Effect<void, EntryError>
  /**
   * A latest-state stream: the initial value, then the value after each change from any
   * extension context. Coalesces bursts to the newest change and never writes.
   */
  readonly observe: Stream.Stream<Option.Option<S["Type"]>, EntryError | E, R | S["DecodingServices"] | S["EncodingServices"]>
}

export interface ChromeSchemaStorageService {
  /** A reusable descriptor; creating it neither reads nor writes storage. */
  readonly entry: <S extends Schema.Constraint, E = never, R = never>(options: EntryOptions<S, E, R>) => Entry<S, E, R>
}

export class ChromeSchemaStorage extends Context.Service<ChromeSchemaStorage, ChromeSchemaStorageService>()(
  "effect-platform-chrome/ChromeSchemaStorage"
) {}

const Envelope = Schema.Struct({ version: Schema.Int, payload: Schema.Unknown })

/** Exactly `{ version, payload }`: data with extra fields is foreign, not an envelope. */
const decodeEnvelope = Schema.decodeUnknownEffect(Envelope, { onExcessProperty: "error" })

const areas: ReadonlySet<string> = new Set<AreaName>(["local", "sync", "session", "managed"])

/** Collision-free tuple encoding, including empty strings and separator characters. */
export const storageKey = (namespace: string, key: string): string => JSON.stringify([namespace, key])

/** JSON validation alone accepts some JS objects that JSON serialization changes.
 * Check the round-trip recursively, rejecting prototypes, accessors, cycles,
 * sparse arrays, non-finite numbers, symbols, and omitted properties, and return the
 * JSON text.
 */
// Raw schema encodings and Chrome payloads must be checked before recursive decoding.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
const jsonText = (payload: unknown): string => {
  const ancestors = new Set<object>()

  // This recursion validates the JSON serialization boundary, not domain values.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  const visit = (value: unknown): void => {
    if (value === null || Predicate.isString(value) || Predicate.isBoolean(value)) return

    if (Predicate.isNumber(value) && Number.isFinite(value) && !Object.is(value, -0)) return

    if (!Predicate.isObjectOrArray(value)) throw new Error("Value is not JSON-compatible")

    if (ancestors.has(value)) throw new Error("Cyclic JSON payload")
    const prototype = Object.getPrototypeOf(value)

    if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new Error("Only plain JSON objects and arrays are supported")
    }

    ancestors.add(value)
    const keys = Reflect.ownKeys(value)

    for (const property of keys) {
      if (Array.isArray(value) && property === "length") continue
      const descriptor = Object.getOwnPropertyDescriptor(value, property)

      if (!Predicate.isString(property) || descriptor?.get !== undefined || descriptor?.set !== undefined || !descriptor?.enumerable) {
        throw new Error("JSON payload contains a symbol, accessor, or hidden property")
      }
    }

    if (Array.isArray(value)) {
      if (keys.length !== value.length + 1) throw new Error("Sparse or decorated JSON array")

      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) throw new Error("Sparse JSON array")
        visit(value[index]!)
      }
    } else {
      for (const child of Object.values(value)) visit(child)
    }

    ancestors.delete(value)
  }

  visit(payload)

  return JSON.stringify(payload)
}

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json))

/**
 * Creates the service over a ChromeStorage service, reading and observing through it.
 * Observation registers on its `changeEvent` synchronously, before the initial read.
 */
export const make = (storage: ChromeStorageService): ChromeSchemaStorageService => {
  /**
   * One mutex per area and physical key, shared by every descriptor of this service and
   * dropped once unused. Chrome applies storage calls in submission order, so a write-back
   * holds it from its re-read until its write is submitted, and `set`/`remove` hold it only
   * while submitting. A write from this context therefore lands either before the re-read,
   * which then sees it, or after the write-back; it is never silently overwritten.
   */
  const locks = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>()

  const exclusive = (lockKey: string) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => Effect.acquireUseRelease(
    Effect.sync(() => {
      const lock = locks.get(lockKey) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 }
      lock.users++
      locks.set(lockKey, lock)

      return lock
    }),
    (lock) => lock.semaphore.withPermit(effect),
    (lock) => Effect.sync(() => {
      lock.users--

      if (lock.users === 0) locks.delete(lockKey)
    })
  )

  const entry = <S extends Schema.Constraint, E = never, R = never>(options: EntryOptions<S, E, R>): Entry<S, E, R> => {
    const key = storageKey(options.namespace, options.key)
    const locked = exclusive(JSON.stringify([options.area, key]))
    // Undefined only for an area name the types rule out; `configuration` reports it.
    const area = areas.has(options.area) ? storage[options.area] : undefined
    const writable = options.area !== "managed" && areas.has(options.area) ? storage[options.area] : undefined

    const error = (operation: Operation, reason: ChromeSchemaStorageError["reason"], cause: string) =>
      new ChromeSchemaStorageError({ operation, key, reason, cause })

    const registration = attempter((operation, cause) => new ChromeStorageError({ area: options.area, operation, cause }))

    const configuration = (operation: Operation) => Effect.suspend(() => {
      const versions = new Set<number>()

      if (area === undefined) return Effect.fail(error(operation, "configuration", `Unknown storage area ${String(options.area)}`))

      if (!Number.isSafeInteger(options.version) || options.version < 0) return Effect.fail(error(operation, "configuration", "Version must be a non-negative safe integer"))

      for (const migration of options.migrations ?? []) {
        if (!Number.isSafeInteger(migration.from) || migration.from < 0 || migration.from >= options.version || versions.has(migration.from)) {
          return Effect.fail(error(operation, "configuration", "Migration versions must be unique and older than the current version"))
        }

        versions.add(migration.from)
      }

      return Effect.succeed(area)
    })

    // Raw schema encodings, migration outputs and Chrome payloads are untrusted here.
    // oxlint-disable-next-line anti-slop/no-unknown-parameters
    const validJson = (operation: Operation, payload: unknown) => Effect.try({
      try: () => jsonText(payload),
      catch: (cause) => new ChromeSchemaStorageError({ operation, key, reason: "json", cause })
    })

    const encode = Effect.fnUntraced(function*(operation: Operation, value: S["Type"]) {
      const encoded = yield* Schema.encodeEffect(options.schema)(value)

      return yield* decodeJson(yield* validJson(operation, encoded))
    })

    /**
     * Submits a Chrome write under the lock and awaits it outside, so plain writes stay
     * concurrent. The child starts immediately, which runs the call synchronously to Chrome.
     */
    const submit = (call: Effect.Effect<void, ChromeStorageError>) =>
      Effect.flatMap(locked(Effect.forkChild(call, { startImmediately: true })), Fiber.join)

    /**
     * A comparable form of a raw stored envelope, `None` when it is not a valid envelope.
     * Write-back compares it with the migrated snapshot before writing.
     */
    // The raw Chrome storage value is an untrusted I/O boundary.
    // oxlint-disable-next-line anti-slop/no-unknown-parameters
    const fingerprint = (operation: Operation, raw: unknown) => decodeEnvelope(raw).pipe(
      Effect.flatMap((envelope) => Effect.map(validJson(operation, envelope.payload), (text) => `${envelope.version}:${text}`)),
      Effect.option
    )

    /**
     * Writes a migrated value only if the entry still holds the snapshot that was migrated.
     * A concurrent write or removal wins. Writers in this context wait for the lock; a
     * write from another context between this read and the write cannot be excluded,
     * because Chrome storage has no compare-and-swap.
     */
    const writeBack = Effect.fnUntraced(function*(operation: Operation, snapshot: string, value: S["Type"]) {
      if (writable === undefined) return yield* error(operation, "readOnly", "Managed storage cannot write migrations")
      // Encoded before taking the lock, which then covers only storage calls.
      const payload = yield* encode(operation, value)

      yield* locked(Effect.gen(function*() {
        const items = yield* writable.get(key)

        if (!Object.hasOwn(items, key)) return
        const current = yield* fingerprint(operation, items[key])

        if (Option.isSome(current) && current.value === snapshot) yield* writable.set({ [key]: { version: options.version, payload } })
      }))
    })

    // The raw Chrome event / storage value is an untrusted I/O boundary.
    // oxlint-disable-next-line anti-slop/no-unknown-parameters
    const decode = Effect.fnUntraced(function*(operation: Operation, raw: unknown, missing: boolean, persist: boolean) {
      if (missing) {
        if (options.defaultValue === undefined) return Option.none<S["Type"]>()
        const value = yield* options.defaultValue()
        const payload = yield* encode(operation, value)

        return Option.some(yield* Schema.decodeEffect(options.schema)(payload))
      }

      const envelope = yield* decodeEnvelope(raw).pipe(
        Effect.mapError((cause) => new ChromeSchemaStorageError({ operation, key, reason: "envelope", cause }))
      )

      if (envelope.version < 0 || !Number.isSafeInteger(envelope.version)) return yield* error(operation, "envelope", "Invalid version")

      if (envelope.version > options.version) return yield* error(operation, "futureVersion", "Stored version is newer than this entry")
      const stored = yield* validJson(operation, envelope.payload)
      let payload = yield* decodeJson(stored)

      for (let version = envelope.version; version < options.version; version++) {
        const migration = options.migrations?.find((candidate) => candidate.from === version)

        if (migration === undefined) return yield* error(operation, "migration", `Missing migration from version ${version}`)
        payload = yield* migration.run(payload)
        payload = yield* decodeJson(yield* validJson(operation, payload))
      }

      const value = yield* Schema.decodeEffect(options.schema)(payload)

      if (persist && envelope.version < options.version) yield* writeBack(operation, `${envelope.version}:${stored}`, value)

      return Option.some(value)
    })

    const read = Effect.fnUntraced(function*(operation: Operation, persist: boolean) {
      const target = yield* configuration(operation)

      if (persist && writable === undefined) return yield* error(operation, "readOnly", "Managed storage cannot write migrations")
      const items = yield* target.get(key)

      return yield* decode(operation, items[key], !Object.hasOwn(items, key), persist)
    })

    const get = (readOptions?: ReadOptions) => read("get", readOptions?.writeBack ?? false)

    const set = Effect.fnUntraced(function*(value: S["Type"]) {
      yield* configuration("set")

      if (writable === undefined) return yield* error("set", "readOnly", "Managed storage is read-only")
      const payload = yield* encode("set", value)
      yield* submit(writable.set({ [key]: { version: options.version, payload } }))
    })

    const remove = Effect.gen(function*() {
      yield* configuration("remove")

      if (writable === undefined) return yield* error("remove", "readOnly", "Managed storage is read-only")
      yield* submit(writable.remove(key))
    })

    const observe = Stream.callback<Option.Option<S["Type"]>, EntryError | E, R | S["DecodingServices"] | S["EncodingServices"]>((output) => Effect.gen(function*() {
      yield* configuration("observe")
      const signals = yield* Queue.sliding<{ readonly revision: number; readonly change: chrome.storage.StorageChange | undefined }>(1)
      let revision = 0

      // Chrome's newValue is untyped. Decode it at this boundary, never assert it.
      const listener = (changes: Changes, changedArea: AreaName) => {
        if (changedArea !== options.area || !Object.hasOwn(changes, key)) return
        revision++
        Queue.offerUnsafe(signals, { revision, change: changes[key] })
      }

      // Install cleanup before registration: injected APIs may register then throw.
      yield* Effect.acquireRelease(
        Effect.void,
        () => Effect.sync(() => storage.changeEvent.removeListener(listener))
      )
      // Synchronous registration before the initial read, so no change can slip between them.
      yield* registration("onChanged", () => storage.changeEvent.addListener(listener))

      // A change delivered during registration already supersedes any initial read.
      if (revision === 0) {
        const initial = yield* Effect.result(read("observe", false))

        // A change during the read or its decoding makes the result, even a failure, obsolete.
        if (revision === 0) yield* Queue.offer(output, yield* Effect.fromResult(initial))
      }

      while (true) {
        const signal = yield* Queue.take(signals)
        const missing = signal.change === undefined || !Object.hasOwn(signal.change, "newValue")
        const value = yield* Effect.result(decode("observe", signal.change?.newValue, missing, false))

        if (signal.revision === revision) yield* Queue.offer(output, yield* Effect.fromResult(value))
      }
    }), { bufferSize: 1, strategy: "sliding" })

    return { storageKey: key, get, set, remove, observe }
  }

  return ChromeSchemaStorage.of({ entry })
}

/** Builds on the ChromeStorage service in context, injected or live. */
export const layer: Layer.Layer<ChromeSchemaStorage, never, ChromeStorage> = Layer.effect(
  ChromeSchemaStorage,
  Effect.map(ChromeStorage, make)
)

/**
 * Builds on `ChromeStorage.layerLive`, reading `chrome.storage` only when built and failing
 * with operation `"initialize"` where it is missing.
 */
export const layerLive: Layer.Layer<ChromeSchemaStorage, ChromeStorageError> = layer.pipe(Layer.provide(storageLayerLive))
