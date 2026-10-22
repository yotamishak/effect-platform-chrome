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

/** The promise-based subset of Chrome StorageArea required by this adapter. */
export interface StorageArea {
  readonly get: (keys: string | null) => Promise<Record<string, unknown>>
  readonly set: (items: Record<string, unknown>) => Promise<void>
  readonly remove: (keys: string | Array<string>) => Promise<void>
  /**
   * Chrome 130+. When present, `size` and `clear` list keys with it instead of reading
   * every value in the area; without it they fall back to `get(null)`.
   */
  readonly getKeys?: () => Promise<Array<string>>
}

export interface Options {
  readonly namespace?: string
}

export const defaultNamespace = "effect-platform-chrome"

const StoredValue = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), type: Schema.Literal("string"), value: Schema.String }),
  Schema.Struct({ version: Schema.Literal(1), type: Schema.Literal("uint8array"), value: Schema.Uint8ArrayFromBase64 })
])

const decodeValue = Schema.decodeUnknownSync(StoredValue)

const encoder = new TextEncoder()

const storageError = (method: string, cause: unknown, key?: string) => {
  const fields = {
    method,
    message: `Chrome KeyValueStore ${method} failed`,
    cause
  }

  return new KeyValueStore.KeyValueStoreError(key === undefined ? fields : { ...fields, key })
}

/**
 * Creates an independent, namespaced store without accessing global Chrome APIs.
 * Namespace lengths make the key encoding unambiguous, even for empty names,
 * colons, Unicode, and names that are prefixes of other names.
 *
 * Missing keys return undefined. Like Effect's memory store, get reads binary
 * values as base64 and getUint8Array reads strings as UTF-8. Invalid envelopes
 * fail with KeyValueStoreError; has and size report physical key existence.
 * clear only removes namespaced keys, never calls StorageArea.clear. size and clear
 * list keys with getKeys where the browser has it (Chrome 130+), else read the area.
 */
export const make = (area: StorageArea, options: Options = {}): KeyValueStore.KeyValueStore => {
  const namespace = options.namespace ?? defaultNamespace
  const prefix = `effect-platform-chrome/KeyValueStore/v1:${namespace.length}:${namespace}:`
  const encodedKey = (key: string) => prefix + key

  const attempt = <A>(method: string, run: () => Promise<A>, key?: string) =>
    invoker((operation, cause) => storageError(operation, cause, key))(method, run)

  const namespacedKeys = async () => {
    const keys = area.getKeys === undefined ? Object.keys(await area.get(null)) : await area.getKeys()

    return keys.filter((key) => key.startsWith(prefix))
  }

  const read = (method: string, key: string) => attempt(method, async () => {
    const name = encodedKey(key)
    const items = await area.get(name)

    return Object.hasOwn(items, name) ? decodeValue(items[name]) : undefined
  }, key)

  return KeyValueStore.make({
    get: (key) => Effect.map(read("get", key), (entry) =>
      entry === undefined ? undefined : entry.type === "string" ? entry.value : Base64.encode(entry.value)),
    getUint8Array: (key) => Effect.map(read("getUint8Array", key), (entry) =>
      entry === undefined ? undefined : entry.type === "string" ? encoder.encode(entry.value) : entry.value),
    set: (key, value) => attempt("set", async () => {
      await area.set({
        [encodedKey(key)]: {
          version: 1,
          type: Predicate.isString(value) ? "string" : "uint8array",
          value: Predicate.isString(value) ? value : Base64.encode(value)
        }
      })
    }, key),
    remove: (key) => attempt("remove", async () => { await area.remove(encodedKey(key)) }, key),
    has: (key) => attempt("has", async () => {
      const name = encodedKey(key)

      return Object.hasOwn(await area.get(name), name)
    }, key),
    clear: attempt("clear", async () => {
      const keys = await namespacedKeys()

      if (keys.length > 0) await area.remove(keys)
    }),
    size: attempt("size", async () => (await namespacedKeys()).length)
  })
}

/** Provides a store backed by an injected storage area. */
export const layer = (area: StorageArea, options: Options = {}): Layer.Layer<KeyValueStore.KeyValueStore> =>
  Layer.succeed(KeyValueStore.KeyValueStore, make(area, options))

const areaLayer = (
  name: "local" | "sync" | "session",
  options: Options
): Layer.Layer<KeyValueStore.KeyValueStore, KeyValueStore.KeyValueStoreError> => liveLayer(
  KeyValueStore.KeyValueStore, `storage.${name}`,
  // `chrome.storage` itself is absent without the storage permission.
  (chrome) => chrome.storage?.[name],
  (area) => make(area, options),
  (cause) => storageError("initialize", cause)
)

/** Chrome APIs are resolved only when the layer is built. Requires storage permission. */
export const layerLocal = (options: Options = {}): Layer.Layer<KeyValueStore.KeyValueStore, KeyValueStore.KeyValueStoreError> =>
  areaLayer("local", options)

export const layerSync = (options: Options = {}): Layer.Layer<KeyValueStore.KeyValueStore, KeyValueStore.KeyValueStoreError> =>
  areaLayer("sync", options)

export const layerSession = (options: Options = {}): Layer.Layer<KeyValueStore.KeyValueStore, KeyValueStore.KeyValueStoreError> =>
  areaLayer("session", options)
