import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeCookiesError extends Schema.TaggedError<ChromeCookiesError>()("ChromeCookiesError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

export type Cookie = chrome.cookies.Cookie

export type CookieStore = chrome.cookies.CookieStore

/** Addresses one cookie by URL and name, optionally in a store and partition. */
export type CookieDetails = chrome.cookies.CookieDetails

/** A partitioned (CHIPS) cookie's partition: its top-level site and cross-site ancestry. */
export type CookiePartitionKey = chrome.cookies.CookiePartitionKey

/** A frame by tab and frame id, or by document id. */
export type FrameDetails = chrome.cookies.FrameDetails

/**
 * Why a cookie changed: `"explicit"` for an insertion or a `remove` call, `"overwrite"` for
 * the removal half of a `set` that replaced it, `"expired_overwrite"` when a `set` with a
 * past expiry deleted it, and `"expired"` or `"evicted"` when Chrome dropped it.
 */
export type ChangeCause = chrome.cookies.CookieChangeInfo["cause"]

/** One `onChanged` notification. Overwriting a cookie reports the old one removed, then the new one added. */
export interface CookieChange {
  readonly cookie: Cookie
  readonly cause: ChangeCause
  readonly removed: boolean
}

/**
 * The Promise-based MV3 subset this module needs. Chrome reports a missing cookie as
 * `null` or `undefined` depending on the version, so both are accepted. `getPartitionKey`
 * is Chrome 132+; it is optional so injected APIs without it still fit, and calling it when
 * absent fails with the typed error.
 */
export interface ChromeCookiesApi {
  get(details: CookieDetails): Promise<Cookie | null | undefined>
  getAll(details: chrome.cookies.GetAllDetails): Promise<Array<Cookie>>
  set(details: chrome.cookies.SetDetails): Promise<Cookie | null | undefined>
  remove(details: CookieDetails): Promise<CookieDetails | null | undefined>
  getAllCookieStores(): Promise<Array<CookieStore>>
  readonly getPartitionKey?: (details: FrameDetails) => Promise<{ partitionKey: CookiePartitionKey }>
  readonly onChanged: EventSource<[changeInfo: chrome.cookies.CookieChangeInfo]>
}

export interface ChromeCookiesService {
  /**
   * The cookie a request to `url` would send with this name, the longest path first and
   * then the earliest created; none when there is no such cookie. Fails without host
   * permission for the URL.
   */
  readonly get: (details: CookieDetails) => Effect.Effect<Option.Option<Cookie>, ChromeCookiesError>
  /**
   * The cookies of one store matching every given filter, longest path first and then the
   * earliest created. Only cookies on hosts the extension has permission for are listed;
   * without `partitionKey` only unpartitioned cookies are, and `partitionKey: {}` lists
   * every partition.
   */
  readonly getAll: (details: chrome.cookies.GetAllDetails) => Effect.Effect<Array<Cookie>, ChromeCookiesError>
  /**
   * Sets or overwrites a cookie and returns it as stored. Chrome rejects a cookie it
   * cannot set (a domain the URL cannot set, a secure cookie on an insecure URL, no host
   * permission); none when it was accepted but is not stored, as when `expirationDate`
   * is already past, which deletes an existing cookie instead.
   */
  readonly set: (details: chrome.cookies.SetDetails) => Effect.Effect<Option.Option<Cookie>, ChromeCookiesError>
  /**
   * Deletes every cookie with this name that a request to `url` would send, in the store
   * and partition given (unpartitioned without `partitionKey`), so a same-named cookie on a
   * shorter path or a parent domain goes too. Returns the details Chrome resolved
   * (normalized URL, store and partition), whether or not anything was deleted; none only
   * if Chrome reports nothing.
   */
  readonly remove: (details: CookieDetails) => Effect.Effect<Option.Option<CookieDetails>, ChromeCookiesError>
  /**
   * Removes a cookie read from `get` or `getAll` through `remove`, rebuilding the URL from
   * its domain, path and secure flag and keeping its store and partition. Like `remove`, it
   * also deletes same-named cookies that URL receives from a shorter path or parent domain.
   * Fails with the `"remove"` operation.
   */
  readonly removeCookie: (cookie: Cookie) => Effect.Effect<Option.Option<CookieDetails>, ChromeCookiesError>
  /** The regular store, plus incognito stores and their tab ids while incognito windows are open. */
  readonly getAllCookieStores: Effect.Effect<Array<CookieStore>, ChromeCookiesError>
  /**
   * The partition key cookies set by the frame would use (Chrome 132+). Fails when the
   * frame does not exist, or with the typed error when the browser lacks the method.
   */
  readonly getPartitionKey: (details: FrameDetails) => Effect.Effect<CookiePartitionKey, ChromeCookiesError>
  /**
   * Cookie changes the extension has host access to. Each consumption owns a scoped
   * listener and retains at most 64 pending events, dropping the oldest. This is an
   * observation, not an MV3 wake listener; use ChromeServiceWorker.listen for that.
   */
  readonly onChanged: Stream.Stream<CookieChange, ChromeCookiesError>
}

export class ChromeCookies extends Context.Service<ChromeCookies, ChromeCookiesService>()("effect-platform-chrome/ChromeCookies") {}

const invoke = invoker((operation, cause) => new ChromeCookiesError({ operation, cause }))

const unavailable = (operation: string) => new Error(`cookies.${operation} is unavailable`)

/** The details that address exactly this cookie for `remove`. */
export const detailsOf = (cookie: Cookie): CookieDetails => {
  const details: CookieDetails = {
    url: `${cookie.secure ? "https" : "http"}://${cookie.domain.replace(/^\./, "")}${cookie.path}`,
    name: cookie.name,
    storeId: cookie.storeId
  }

  if (cookie.partitionKey !== undefined) details.partitionKey = cookie.partitionKey

  return details
}

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeCookiesApi): ChromeCookiesService => {
  const remove = (details: CookieDetails) => invoke("remove", () => api.remove(details)).pipe(Effect.map(Option.fromNullishOr))

  return ChromeCookies.of({
    get: (details) => invoke("get", () => api.get(details)).pipe(Effect.map(Option.fromNullishOr)),
    getAll: (details) => invoke("getAll", () => api.getAll(details)),
    set: (details) => invoke("set", () => api.set(details)).pipe(Effect.map(Option.fromNullishOr)),
    remove,
    removeCookie: (cookie) => remove(detailsOf(cookie)),
    getAllCookieStores: invoke("getAllCookieStores", () => api.getAllCookieStores()),
    getPartitionKey: (details) => invoke("getPartitionKey", () => api.getPartitionKey === undefined
      ? Promise.reject(unavailable("getPartitionKey"))
      : api.getPartitionKey(details)).pipe(Effect.map(({ partitionKey }) => partitionKey)),
    onChanged: observe(
      () => api.onChanged,
      ({ cookie, cause, removed }): CookieChange => ({ cookie, cause, removed }),
      (cause) => new ChromeCookiesError({ operation: "onChanged", cause })
    )
  })
}

export const layer = (api: ChromeCookiesApi): Layer.Layer<ChromeCookies> => Layer.succeed(ChromeCookies, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeCookies, ChromeCookiesError> = liveLayer(
  ChromeCookies, "cookies", (chrome) => chrome.cookies, make,
  (cause) => new ChromeCookiesError({ operation: "initialize", cause })
)
