import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observeSome, type EventSource } from "./internal/event.js"

export type AreaName = chrome.storage.AreaName

export type Items = Record<string, unknown>

/**
 * What `get` reads: one key, several keys, an object whose values are defaults for missing
 * keys, or `null` for the whole area. An empty array or object reads nothing.
 */
export type GetKeys = string | Array<string> | Items | null

/** What `getBytesInUse` measures: one key, several keys, or `null` for the whole area. */
export type Keys = string | Array<string> | null

/** Who may use an area: extension pages and the worker only, or content scripts as well. */
export type AccessLevel = `${chrome.storage.AccessLevel}`

/** One key's change: `oldValue` is absent for a new key, `newValue` for a removed one. */
export type StorageChange = chrome.storage.StorageChange

/** The changes Chrome reports for one area in one `onChanged` event, by key. */
export type Changes = Record<string, StorageChange>

/** Promise-based storage boundary; unrelated Chrome members are not required by injected APIs. */
export interface StorageAreaApi {
  /** Called without an argument when the caller gives none; Chrome then reads the whole area. */
  readonly get: (keys?: GetKeys) => Promise<Items>
  /** Called without an argument when the caller gives none; Chrome then measures the whole area. */
  readonly getBytesInUse: (keys?: Keys) => Promise<number>
  readonly set: (items: Items) => Promise<void>
  readonly remove: (keys: string | Array<string>) => Promise<void>
  readonly clear: () => Promise<void>
  /** Chrome 102+. Optional so injected APIs without it still fit; calling it then fails with a typed error. */
  readonly setAccessLevel?: (options: { readonly accessLevel: AccessLevel }) => Promise<void>
  /** Chrome 130+. Optional like `setAccessLevel`; absent, `getKeys` fails with a typed error. */
  readonly getKeys?: () => Promise<Array<string>>
}

/** The read-only members of `storage.managed`, which enterprise policy fills. */
export type ManagedAreaApi = Pick<StorageAreaApi, "get" | "getBytesInUse" | "getKeys">

/** The Promise-based MV3 subset this module needs. */
export interface ChromeStorageApi {
  readonly local: StorageAreaApi
  readonly sync: StorageAreaApi
  /** Chrome 102+. A missing area fails each call on it with a typed error. */
  readonly session: StorageAreaApi
  readonly managed: ManagedAreaApi
  readonly onChanged: EventSource<[changes: Changes, areaName: AreaName]>
}

export class ChromeStorageError extends Schema.TaggedError<ChromeStorageError>()("ChromeStorageError", {
  operation: Schema.String,
  /** The area the call or subscription used; `"all"` for `onChanged` across areas and `initialize`. */
  area: Schema.Literals(["local", "sync", "session", "managed", "all"]),
  cause: Schema.Defect()
}) {}

/** One `onChanged` notification: the area that changed and its changed keys. */
export interface Change {
  readonly area: AreaName
  readonly changes: Readonly<Changes>
}

/** Each subscription retains at most 64 events, dropping the oldest on overflow.
 * Chrome callbacks cannot be backpressured; consumers must re-read storage if
 * they require a complete snapshot after a burst of changes.
 */
export const changeBufferSize = 64

/** The quota constants Chrome defines on each writable area, typed by Chrome's literals. */
export interface Limits {
  readonly local: Readonly<Pick<chrome.storage.LocalStorageArea, "QUOTA_BYTES">>
  readonly sync: Readonly<Pick<
    chrome.storage.SyncStorageArea,
    "QUOTA_BYTES" | "QUOTA_BYTES_PER_ITEM" | "MAX_ITEMS" | "MAX_WRITE_OPERATIONS_PER_HOUR" | "MAX_WRITE_OPERATIONS_PER_MINUTE"
  >>
  readonly session: Readonly<Pick<chrome.storage.SessionStorageArea, "QUOTA_BYTES">>
}

/**
 * Chrome's storage limits, mirroring the constants on `chrome.storage.local`, `sync` and
 * `session`. `local.QUOTA_BYTES` does not apply with the `unlimitedStorage` permission. A
 * write beyond a limit fails with a typed error carrying Chrome's message.
 */
export const limits: Limits = {
  local: { QUOTA_BYTES: 10485760 },
  sync: {
    QUOTA_BYTES: 102400,
    QUOTA_BYTES_PER_ITEM: 8192,
    MAX_ITEMS: 512,
    MAX_WRITE_OPERATIONS_PER_HOUR: 1800,
    MAX_WRITE_OPERATIONS_PER_MINUTE: 120
  },
  session: { QUOTA_BYTES: 10485760 }
}

export interface ReadOnlyArea {
  readonly area: AreaName
  /**
   * The selected items; without `keys`, every item in the area. Keys that are not stored
   * are left out, unless `keys` is an object giving their defaults.
   */
  readonly get: (keys?: GetKeys) => Effect.Effect<Items, ChromeStorageError>
  /** The bytes the selected keys use; without `keys`, the whole area. */
  readonly getBytesInUse: (keys?: Keys) => Effect.Effect<number, ChromeStorageError>
  /**
   * Every key in the area, without reading values. Needs Chrome 130+; earlier browsers
   * fail with a typed error, so fall back to `get()` where they must be supported.
   */
  readonly getKeys: Effect.Effect<Array<string>, ChromeStorageError>
  /**
   * This area's changes, observed through the global `storage.onChanged` event and
   * filtered, so other areas' changes never take a buffer slot. Observational: it cannot
   * wake an MV3 service worker. Each subscription buffers at most 64 events, dropping the oldest.
   */
  readonly onChanged: Stream.Stream<Change, ChromeStorageError>
}

export interface WritableArea extends ReadOnlyArea {
  /** Writes the items, leaving other keys alone. Fails beyond the area's quota (`limits`). */
  readonly set: (items: Items) => Effect.Effect<void, ChromeStorageError>
  readonly remove: (keys: string | Array<string>) => Effect.Effect<void, ChromeStorageError>
  readonly clear: Effect.Effect<void, ChromeStorageError>
  /**
   * Restricts or opens the area to content scripts (Chrome 102+). Chrome defaults
   * `session` to trusted contexts only and `local` and `sync` to all contexts; tokens kept
   * in `local` call this with `"TRUSTED_CONTEXTS"` before writing. Only trusted contexts
   * may call it.
   */
  readonly setAccessLevel: (accessLevel: AccessLevel) => Effect.Effect<void, ChromeStorageError>
}

export interface ChromeStorageService {
  readonly local: WritableArea
  readonly sync: WritableArea
  readonly session: WritableArea
  /** Policy set by an administrator; read-only. */
  readonly managed: ReadOnlyArea
  /**
   * Changes in every area, as observational subscriptions that cannot wake an MV3 service
   * worker. Each buffers at most 64 events, dropping the oldest.
   */
  readonly onChanged: Stream.Stream<Change, ChromeStorageError>
  /**
   * Low level: the native `storage.onChanged` event of the API this service wraps, for
   * code that must add a listener synchronously before an Effect starts, such as a read
   * that must not miss a change made while it is in flight (ChromeSchemaStorage). The
   * caller owns each listener it adds and must remove it; prefer `onChanged`, which does.
   */
  readonly changeEvent: EventSource<[changes: Changes, areaName: AreaName]>
}

export class ChromeStorage extends Context.Service<ChromeStorage, ChromeStorageService>()(
  "effect-platform-chrome/ChromeStorage"
) {}

const invokers = {
  local: invoker((operation, cause) => new ChromeStorageError({ area: "local", operation, cause })),
  sync: invoker((operation, cause) => new ChromeStorageError({ area: "sync", operation, cause })),
  session: invoker((operation, cause) => new ChromeStorageError({ area: "session", operation, cause })),
  managed: invoker((operation, cause) => new ChromeStorageError({ area: "managed", operation, cause }))
}

/** The rejection for a version-gated member this browser does not provide. */
const unavailable = (area: AreaName, operation: string): Promise<never> =>
  Promise.reject(new Error(`storage.${area}.${operation} is unavailable in this browser`))

/**
 * Creates the service without reading browser globals or registering listeners. Chrome
 * rejects these promises on API errors; every API access, a missing area included,
 * happens inside an Effect.
 */
export const make = (api: ChromeStorageApi): ChromeStorageService => {
  const call = <A>(area: AreaName, operation: string, run: () => Promise<A>) => invokers[area](operation, run)

  const changes = (area?: AreaName): Stream.Stream<Change, ChromeStorageError> => observeSome(
    () => api.onChanged,
    (changes, changedArea) => area === undefined || changedArea === area
      ? Option.some({ area: changedArea, changes })
      : Option.none(),
    (cause) => new ChromeStorageError({ area: area ?? "all", operation: "onChanged", cause }),
    changeBufferSize
  )

  const readOnly = (area: AreaName): ReadOnlyArea => ({
    area,
    get: (keys) => call(area, "get", () => keys === undefined ? api[area].get() : api[area].get(keys)),
    getBytesInUse: (keys) => call(area, "getBytesInUse", () =>
      keys === undefined ? api[area].getBytesInUse() : api[area].getBytesInUse(keys)),
    getKeys: call(area, "getKeys", () => {
      const target = api[area]

      // Called on the area, never detached, so native members keep their receiver.
      return target.getKeys === undefined ? unavailable(area, "getKeys") : target.getKeys()
    }),
    onChanged: changes(area)
  })

  const writable = (area: "local" | "sync" | "session"): WritableArea => ({
    ...readOnly(area),
    set: (items) => call(area, "set", () => api[area].set(items)),
    remove: (keys) => call(area, "remove", () => api[area].remove(keys)),
    clear: call(area, "clear", () => api[area].clear()),
    setAccessLevel: (accessLevel) => call(area, "setAccessLevel", () => {
      const target = api[area]

      return target.setAccessLevel === undefined
        ? unavailable(area, "setAccessLevel")
        : target.setAccessLevel({ accessLevel })
    })
  })

  return ChromeStorage.of({
    local: writable("local"),
    sync: writable("sync"),
    session: writable("session"),
    managed: readOnly("managed"),
    onChanged: changes(),
    // Looked up on each call, so building the service never touches the event.
    changeEvent: {
      addListener: (listener) => api.onChanged.addListener(listener),
      removeListener: (listener) => api.onChanged.removeListener(listener)
    }
  })
}

export const layer = (api: ChromeStorageApi): Layer.Layer<ChromeStorage> => Layer.succeed(ChromeStorage, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeStorage, ChromeStorageError> = liveLayer(
  ChromeStorage, "storage", (chrome) => chrome.storage, make,
  (cause) => new ChromeStorageError({ area: "all", operation: "initialize", cause })
)
