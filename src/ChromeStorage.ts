import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observeSome, type EventSource } from "./internal/event.js"

export type AreaName = chrome.storage.AreaName

export type Items = Record<string, unknown>

export type GetKeys = string | Array<string> | Items | null

export type Keys = string | Array<string> | null

/** Who may use an area: extension pages and the worker only, or content scripts as well. */
export type AccessLevel = `${chrome.storage.AccessLevel}`

/** The changes Chrome reports for one area in one `onChanged` event, by key. */
export type Changes = Record<string, chrome.storage.StorageChange>

/** Promise-based storage boundary; unrelated Chrome members are not required by injected APIs. */
export interface StorageAreaApi {
  readonly get: (keys: GetKeys) => Promise<Items>
  readonly getBytesInUse: (keys: Keys) => Promise<number>
  readonly set: (items: Items) => Promise<void>
  readonly remove: (keys: string | Array<string>) => Promise<void>
  readonly clear: () => Promise<void>
  /** Optional so injected APIs without it still fit; calling it then fails with a typed error. */
  readonly setAccessLevel?: (options: { readonly accessLevel: AccessLevel }) => Promise<void>
  /** Chrome 130+. Optional like `setAccessLevel`; absent, `getKeys` fails with a typed error. */
  readonly getKeys?: () => Promise<Array<string>>
}

/** The Promise-based MV3 subset this module needs. */
export interface ChromeStorageApi {
  readonly local: StorageAreaApi
  readonly sync: StorageAreaApi
  readonly session: StorageAreaApi
  readonly managed: Pick<StorageAreaApi, "get" | "getBytesInUse" | "getKeys">
  readonly onChanged: EventSource<[changes: Changes, areaName: AreaName]>
}

export class ChromeStorageError extends Schema.TaggedError<ChromeStorageError>()("ChromeStorageError", {
  operation: Schema.String,
  area: Schema.Literals(["local", "sync", "session", "managed", "all"]),
  cause: Schema.Defect()
}) {}

export interface Change {
  readonly area: AreaName
  readonly changes: Readonly<Changes>
}

/** Each subscription retains at most 64 events, dropping the oldest on overflow.
 * Chrome callbacks cannot be backpressured; consumers must re-read storage if
 * they require a complete snapshot after a burst of changes.
 */
export const changeBufferSize = 64

export interface ReadOnlyArea {
  readonly area: AreaName
  readonly get: (keys?: GetKeys) => Effect.Effect<Items, ChromeStorageError>
  readonly getBytesInUse: (keys?: Keys) => Effect.Effect<number, ChromeStorageError>
  /**
   * Every key in the area, without reading values. Needs Chrome 130+; earlier browsers
   * fail with a typed error, so fall back to `get()` where they must be supported.
   */
  readonly getKeys: Effect.Effect<Array<string>, ChromeStorageError>
  readonly onChanged: Stream.Stream<Change, ChromeStorageError>
}

export interface WritableArea extends ReadOnlyArea {
  readonly set: (items: Items) => Effect.Effect<void, ChromeStorageError>
  readonly remove: (keys: string | Array<string>) => Effect.Effect<void, ChromeStorageError>
  readonly clear: Effect.Effect<void, ChromeStorageError>
  /**
   * Restricts or opens the area to content scripts. Chrome defaults `session` to trusted
   * contexts only and `local` to all contexts; tokens kept in `local` call this with
   * `"TRUSTED_CONTEXTS"` before writing.
   */
  readonly setAccessLevel: (accessLevel: AccessLevel) => Effect.Effect<void, ChromeStorageError>
}

export interface ChromeStorageService {
  readonly local: WritableArea
  readonly sync: WritableArea
  readonly session: WritableArea
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
    get: (keys = null) => call(area, "get", () => api[area].get(keys)),
    getBytesInUse: (keys = null) => call(area, "getBytesInUse", () => api[area].getBytesInUse(keys)),
    getKeys: call(area, "getKeys", () => {
      const target = api[area]

      return target.getKeys === undefined
        ? Promise.reject(new Error(`storage.${area}.getKeys is unavailable`))
        : target.getKeys()
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
        ? Promise.reject(new Error(`storage.${area}.setAccessLevel is unavailable`))
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
