import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { liveLayer } from "./internal/api.js"
import { observeSome } from "./internal/event.js"

export type AreaName = chrome.storage.AreaName

export type Items = Record<string, unknown>

export type GetKeys = string | Array<string> | Items | null

export type Keys = string | Array<string> | null

/** Who may use an area: extension pages and the worker only, or content scripts as well. */
export type AccessLevel = `${chrome.storage.AccessLevel}`

/** Promise-based storage boundary; unrelated Chrome members are not required by injected APIs. */
export interface StorageAreaApi {
  readonly get: (keys: GetKeys) => Promise<Items>
  readonly getBytesInUse: (keys: Keys) => Promise<number>
  readonly set: (items: Items) => Promise<void>
  readonly remove: (keys: string | Array<string>) => Promise<void>
  readonly clear: () => Promise<void>
  /** Optional so injected APIs without it still fit; calling it then fails with a typed error. */
  readonly setAccessLevel?: (options: { readonly accessLevel: AccessLevel }) => Promise<void>
}

export interface StorageApi {
  readonly local: StorageAreaApi
  readonly sync: StorageAreaApi
  readonly session: StorageAreaApi
  readonly managed: Pick<StorageAreaApi, "get" | "getBytesInUse">
  readonly onChanged: Pick<typeof chrome.storage.onChanged, "addListener" | "removeListener">
}

export class ChromeStorageError extends Schema.TaggedError<ChromeStorageError>()("ChromeStorageError", {
  operation: Schema.String,
  area: Schema.Literals(["local", "sync", "session", "managed", "all"]),
  cause: Schema.Defect()
}) {}

export interface Change {
  readonly area: AreaName
  readonly changes: Readonly<Record<string, chrome.storage.StorageChange>>
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

export interface Service {
  readonly local: WritableArea
  readonly sync: WritableArea
  readonly session: WritableArea
  readonly managed: ReadOnlyArea
  readonly onChanged: Stream.Stream<Change, ChromeStorageError>
}

export class ChromeStorage extends Context.Service<ChromeStorage, Service>()(
  "effect-platform-chrome/ChromeStorage"
) {}

/** Wraps the Manifest V3 Promise API. Chrome rejects these promises on API errors.
 * All API access occurs inside effects, including missing-area failures.
 */
export const make = (api: StorageApi): Service => {
  const call = <A>(area: AreaName, operation: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => new ChromeStorageError({ area, operation, cause })
    })

  const changes = (area?: AreaName): Stream.Stream<Change, ChromeStorageError> => observeSome(
    () => api.onChanged,
    (changes: Record<string, chrome.storage.StorageChange>, changedArea: AreaName) => area === undefined || changedArea === area
      ? Option.some({ area: changedArea, changes })
      : Option.none(),
    (cause) => new ChromeStorageError({ area: area ?? "all", operation: "onChanged.addListener", cause }),
    changeBufferSize
  )

  const readOnly = (area: AreaName): ReadOnlyArea => ({
    area,
    get: (keys = null) => call(area, "get", () => api[area].get(keys)),
    getBytesInUse: (keys = null) => call(area, "getBytesInUse", () => api[area].getBytesInUse(keys)),
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
    onChanged: changes()
  })
}

/** Resolves the global only when the layer is built, never during import. */
export const layerLive: Layer.Layer<ChromeStorage, ChromeStorageError> = liveLayer(
  ChromeStorage, "storage", (chrome) => chrome.storage, make,
  (cause) => new ChromeStorageError({ area: "all", operation: "initialize", cause })
)

/** The same live layer as `layerLive`, under this module's original name. */
export const layer = layerLive
