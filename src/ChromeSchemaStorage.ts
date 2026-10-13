import { Context, Effect, Layer, Option, Predicate, Queue, Schema, Stream } from "effect"
import { ChromeStorage, ChromeStorageError } from "./ChromeStorage.js"
import type { AreaName, Service as StorageService, StorageApi } from "./ChromeStorage.js"

export class ChromeSchemaStorageError extends Schema.TaggedError<ChromeSchemaStorageError>()("ChromeSchemaStorageError", {
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

export interface Entry<S extends Schema.Constraint, E, R> {
  readonly storageKey: string
  readonly get: (options?: { readonly writeBack?: boolean }) => Effect.Effect<Option.Option<S["Type"]>, EntryError | E, R | S["DecodingServices"] | S["EncodingServices"]>
  readonly set: (value: S["Type"]) => Effect.Effect<void, EntryError, S["EncodingServices"]>
  readonly remove: Effect.Effect<void, EntryError>
  readonly observe: Stream.Stream<Option.Option<S["Type"]>, EntryError | E, R | S["DecodingServices"] | S["EncodingServices"]>
}

export interface Service {
  readonly entry: <S extends Schema.Constraint, E = never, R = never>(options: EntryOptions<S, E, R>) => Entry<S, E, R>
}

export class ChromeSchemaStorage extends Context.Service<ChromeSchemaStorage, Service>()(
  "effect-platform-chrome/ChromeSchemaStorage"
) {}

const Envelope = Schema.Struct({ version: Schema.Int, payload: Schema.Unknown })

/** Collision-free tuple encoding, including empty strings and separator characters. */
export const storageKey = (namespace: string, key: string): string => JSON.stringify([namespace, key])

/** JSON validation alone accepts some JS objects that JSON serialization changes.
 * Check the round-trip recursively, rejecting prototypes, accessors, cycles,
 * sparse arrays, non-finite numbers, symbols, and omitted properties.
 */
// Raw schema encodings and Chrome payloads must be checked before recursive decoding.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
const jsonPayload = (key: string, payload: unknown) => Effect.try({
  try: () => {
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
  },
  catch: (cause) => new ChromeSchemaStorageError({ key, reason: "json", cause })
}).pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Json))))

/** Events must come from the same API as the injected storage service. */
export const make = (storage: StorageService, events: StorageApi["onChanged"]): Service => {
  const entry = <S extends Schema.Constraint, E = never, R = never>(options: EntryOptions<S, E, R>): Entry<S, E, R> => {
    const key = storageKey(options.namespace, options.key)
    const area = storage[options.area]

    const error = (reason: ChromeSchemaStorageError["reason"], cause: string) =>
      new ChromeSchemaStorageError({ key, reason, cause })

    const configuration = Effect.suspend(() => {
      const versions = new Set<number>()

      if (!Number.isSafeInteger(options.version) || options.version < 0) return Effect.fail(error("configuration", "Version must be a non-negative safe integer"))

      for (const migration of options.migrations ?? []) {
        if (!Number.isSafeInteger(migration.from) || migration.from < 0 || migration.from >= options.version || versions.has(migration.from)) {
          return Effect.fail(error("configuration", "Migration versions must be unique and older than the current version"))
        }

        versions.add(migration.from)
      }

      return Effect.void
    })

    const encode = Effect.fnUntraced(function*(value: S["Type"]) {
      const encoded = yield* Schema.encodeEffect(options.schema)(value)

      return yield* jsonPayload(key, encoded)
    })

    const set = Effect.fnUntraced(function*(value: S["Type"]) {
      yield* configuration

      if (!("set" in area)) return yield* error("readOnly", "Managed storage is read-only")
      const payload = yield* encode(value)
      yield* area.set({ [key]: { version: options.version, payload } })
    })

    // The raw Chrome event / storage value is an untrusted I/O boundary.
    // oxlint-disable-next-line anti-slop/no-unknown-parameters
    const decode = Effect.fnUntraced(function*(raw: unknown, missing: boolean, writeBack: boolean) {
      yield* configuration

      if (writeBack && !("set" in area)) return yield* error("readOnly", "Managed storage cannot write migrations")

      if (missing) {
        if (options.defaultValue === undefined) return Option.none<S["Type"]>()
        const value = yield* options.defaultValue()
        const payload = yield* encode(value)

        return Option.some(yield* Schema.decodeEffect(options.schema)(payload))
      }

      const envelope = yield* Schema.decodeUnknownEffect(Envelope)(raw).pipe(
        Effect.mapError((cause) => new ChromeSchemaStorageError({ key, reason: "envelope", cause }))
      )

      if (envelope.version < 0 || !Number.isSafeInteger(envelope.version)) return yield* error("envelope", "Invalid version")

      if (envelope.version > options.version) return yield* error("futureVersion", "Stored version is newer than this entry")
      let payload = yield* jsonPayload(key, envelope.payload)

      for (let version = envelope.version; version < options.version; version++) {
        const migration = options.migrations?.find((candidate) => candidate.from === version)

        if (migration === undefined) return yield* error("migration", `Missing migration from version ${version}`)
        payload = yield* migration.run(payload)
        payload = yield* jsonPayload(key, payload)
      }

      const value = yield* Schema.decodeEffect(options.schema)(payload)

      if (writeBack && envelope.version < options.version) yield* set(value)

      return Option.some(value)
    })

    const get = Effect.fnUntraced(function*(readOptions?: { readonly writeBack?: boolean }) {
      yield* configuration

      if (readOptions?.writeBack && !("set" in area)) return yield* error("readOnly", "Managed storage cannot write migrations")
      const items = yield* area.get(key)

      return yield* decode(items[key], !Object.hasOwn(items, key), readOptions?.writeBack ?? false)
    })

    const remove = Effect.gen(function*() {
      yield* configuration

      if (!("remove" in area)) return yield* error("readOnly", "Managed storage is read-only")
      yield* area.remove(key)
    })

    const observe = Stream.callback<Option.Option<S["Type"]>, EntryError | E, R | S["DecodingServices"] | S["EncodingServices"]>((output) => Effect.gen(function*() {
      const signals = yield* Queue.sliding<{ readonly revision: number; readonly change: chrome.storage.StorageChange | undefined }>(1)
      let revision = 0

      // Chrome's newValue is untyped. Decode it at this boundary, never assert it.
      const listener: Parameters<StorageApi["onChanged"]["addListener"]>[0] = (changes, changedArea) => {
        if (changedArea !== options.area || !Object.hasOwn(changes, key)) return
        revision++
        Queue.offerUnsafe(signals, { revision, change: changes[key] })
      }

      const before = revision
      // Install cleanup before registration: injected APIs may register then throw.
      yield* Effect.acquireRelease(
        Effect.void,
        () => Effect.sync(() => events.removeListener(listener))
      )
      yield* Effect.try({
        try: () => { events.addListener(listener) },
        catch: (cause) => new ChromeStorageError({ area: options.area, operation: "onChanged.addListener", cause })
      })
      const initial = yield* Effect.result(get())

      if (before === revision) yield* Queue.offer(output, yield* Effect.fromResult(initial))

      while (true) {
        const signal = yield* Queue.take(signals)
        const missing = signal.change === undefined || !Object.hasOwn(signal.change, "newValue")
        const value = yield* Effect.result(decode(signal.change?.newValue, missing, false))

        if (signal.revision === revision) yield* Queue.offer(output, yield* Effect.fromResult(value))
      }
    }), { bufferSize: 1, strategy: "sliding" })

    return { storageKey: key, get, set, remove, observe }
  }

  return ChromeSchemaStorage.of({ entry })
}

export const layer = (events: StorageApi["onChanged"]) => Layer.effect(
  ChromeSchemaStorage,
  Effect.map(ChromeStorage, (storage) => make(storage, events))
)
