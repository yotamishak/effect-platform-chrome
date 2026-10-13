import { Context, Effect, Layer, Queue, Schema, Stream } from "effect"

export type AreaName = chrome.storage.AreaName

export type Items = Record<string, unknown>

export type GetKeys = string | Array<string> | Items | null

export type Keys = string | Array<string> | null

/** Promise-based storage boundary; unrelated Chrome members are not required by injected APIs. */
export interface StorageAreaApi {
  readonly get: (keys: GetKeys) => Promise<Items>
  readonly getBytesInUse: (keys: Keys) => Promise<number>
  readonly set: (items: Items) => Promise<void>
  readonly remove: (keys: string | Array<string>) => Promise<void>
  readonly clear: () => Promise<void>
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

  const changes = (area?: AreaName): Stream.Stream<Change, ChromeStorageError> =>
    Stream.callback<Change, ChromeStorageError>((queue) => {
      const listener = (changes: Record<string, chrome.storage.StorageChange>, changedArea: AreaName) => {
        if (area === undefined || changedArea === area) {
          Queue.offerUnsafe(queue, { area: changedArea, changes })
        }
      }

      return Effect.acquireRelease(
        Effect.try({
          try: () => {
            const event = api.onChanged
            event.addListener(listener)

            return event
          },
          catch: (cause) => new ChromeStorageError({ area: area ?? "all", operation: "onChanged.addListener", cause })
        }),
        (event) => Effect.sync(() => event.removeListener(listener))
      )
    }, { bufferSize: changeBufferSize, strategy: "sliding" })

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
    clear: call(area, "clear", () => api[area].clear())
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
export const layer = Layer.effect(ChromeStorage, Effect.try({
  try: () => {
    if (typeof chrome === "undefined" || chrome.storage === undefined) {
      throw new Error("Chrome storage API is unavailable")
    }

    return make(chrome.storage)
  },
  catch: (cause) => new ChromeStorageError({ area: "all", operation: "initialize", cause })
}))
