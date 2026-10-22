// This adapter intentionally targets Effect 4's unstable persistence API; the compatible
// Effect version is pinned in development and upgrades must validate this module's tests.
/* oxlint-disable effecttsgo/unstable-api-usage */
import * as Effect from "effect/Effect"
import * as Base64 from "effect/encoding/Base64"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as Schema from "effect/Schema"
import { invoker, liveLayer } from "./internal/api.js"

/** The writable `chrome.storage` areas a store can live in; `managed` is read-only. */
export type AreaName = "local" | "sync" | "session"

/** The Promise-based subset of a Chrome `StorageArea` this adapter needs. */
export interface ChromeKeyValueStoreApi {
  /** Reads one physical key, or every item in the area for `null`. */
  readonly get: (keys: string | null) => Promise<Record<string, unknown>>
  readonly set: (items: Record<string, unknown>) => Promise<void>
  readonly remove: (keys: string | Array<string>) => Promise<void>
  /**
   * Chrome 130+. When present, `size`, `isEmpty` and `clear` list keys with it instead of
   * reading every value in the area; without it they fall back to `get(null)`.
   */
  readonly getKeys?: () => Promise<Array<string>>
}

export interface Options {
  /** Isolates this store's keys from other stores and unrelated data in the same area. */
  readonly namespace?: string
}

export interface LiveOptions extends Options {
  /** The `chrome.storage` area to use; `"local"` when omitted. */
  readonly area?: AreaName
}

export const defaultNamespace = "effect-platform-chrome"

const StoredValue = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), type: Schema.Literal("string"), value: Schema.String }),
  Schema.Struct({ version: Schema.Literal(1), type: Schema.Literal("uint8array"), value: Schema.Uint8ArrayFromBase64 })
])

const decodeValue = Schema.decodeUnknownEffect(StoredValue)

const encoder = new TextEncoder()

const storageError = (method: string, cause: unknown, key?: string) => {
  const fields = {
    method,
    message: `Chrome KeyValueStore ${method} failed`,
    cause
  }

  return new KeyValueStore.KeyValueStoreError(key === undefined ? fields : { ...fields, key })
}

const invokeKeyless = invoker((method, cause) => storageError(method, cause))

/**
 * Creates an independent, namespaced store over `api` without accessing global Chrome APIs.
 * Namespace lengths make the key encoding unambiguous, even for empty names, colons,
 * Unicode, and names that are prefixes of other names.
 *
 * Missing keys read as `undefined`, as the `KeyValueStore` contract requires. Like Effect's
 * memory store, `get` reads binary values as base64 and `getUint8Array` reads strings as
 * UTF-8. Invalid envelopes fail with `KeyValueStoreError`; `has`, `size` and `isEmpty`
 * report physical key existence. Every error's `method` names the store operation and,
 * for single-key operations, its `key`.
 *
 * `clear` removes only this namespace's keys, in one `remove` call, and never calls
 * `StorageArea.clear`. `size`, `isEmpty` and `clear` list keys with `getKeys` where the
 * browser has it (Chrome 130+), else read the whole area. Operations are not
 * transactions: `modify` and `clear` read, then write, and concurrent writers interleave.
 * An interrupted operation does not cancel a Chrome call already in flight, but an
 * interrupted `clear` never starts its removal after interruption.
 */
export const make = (api: ChromeKeyValueStoreApi, options: Options = {}): KeyValueStore.KeyValueStore => {
  const namespace = options.namespace ?? defaultNamespace
  const prefix = `effect-platform-chrome/KeyValueStore/v1:${namespace.length}:${namespace}:`
  const encodedKey = (key: string) => prefix + key

  const invokeKeyed = <A>(method: string, key: string, run: () => Promise<A>) =>
    invoker((operation, cause) => storageError(operation, cause, key))(method, run)

  const namespacedKeys = (method: string) => Effect.map(
    invokeKeyless(method, async () => {
      if (api.getKeys === undefined) return Object.keys(await api.get(null))

      return api.getKeys()
    }),
    (keys) => keys.filter((key) => key.startsWith(prefix))
  )

  const read = (method: string, key: string) => {
    const name = encodedKey(key)

    return Effect.flatMap(
      invokeKeyed(method, key, () => api.get(name)),
      (items) => Object.hasOwn(items, name)
        ? Effect.mapError(decodeValue(items[name]), (cause) => storageError(method, cause, key))
        : Effect.undefined
    )
  }

  return KeyValueStore.make({
    get: (key) => Effect.map(read("get", key), (entry) =>
      entry === undefined ? undefined : entry.type === "string" ? entry.value : Base64.encode(entry.value)),
    getUint8Array: (key) => Effect.map(read("getUint8Array", key), (entry) =>
      entry === undefined ? undefined : entry.type === "string" ? encoder.encode(entry.value) : entry.value),
    set: (key, value) => invokeKeyed("set", key, () => api.set({
      [encodedKey(key)]: Predicate.isString(value)
        ? { version: 1, type: "string", value }
        : { version: 1, type: "uint8array", value: Base64.encode(value) }
    })),
    remove: (key) => invokeKeyed("remove", key, () => api.remove(encodedKey(key))),
    has: (key) => {
      const name = encodedKey(key)

      return Effect.map(invokeKeyed("has", key, () => api.get(name)), (items) => Object.hasOwn(items, name))
    },
    clear: Effect.flatMap(namespacedKeys("clear"), (keys) =>
      keys.length === 0 ? Effect.void : invokeKeyless("clear", () => api.remove(keys))),
    size: Effect.map(namespacedKeys("size"), (keys) => keys.length),
    isEmpty: Effect.map(namespacedKeys("isEmpty"), (keys) => keys.length === 0)
  })
}

/** Provides a store backed by an injected storage area. */
export const layer = (api: ChromeKeyValueStoreApi, options: Options = {}): Layer.Layer<KeyValueStore.KeyValueStore> =>
  Layer.succeed(KeyValueStore.KeyValueStore, make(api, options))

/**
 * Provides a store backed by `chrome.storage[options.area ?? "local"]`, read when the layer
 * is built, never at import time. Fails with method `"initialize"` where that area is
 * missing: outside an extension, or without the `storage` permission. Content scripts can
 * use `"session"` only after the extension opens it with `setAccessLevel`.
 */
export const layerLive = (options: LiveOptions = {}): Layer.Layer<KeyValueStore.KeyValueStore, KeyValueStore.KeyValueStoreError> => {
  const area = options.area ?? "local"

  return liveLayer(
    KeyValueStore.KeyValueStore, `storage.${area}`,
    // `chrome.storage` itself is absent without the storage permission.
    (chrome) => chrome.storage?.[area],
    (api) => make(api, options),
    (cause) => storageError("initialize", cause)
  )
}
