import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe } from "./internal/event.js"

export class ChromeCookiesError extends Schema.TaggedError<ChromeCookiesError>()("ChromeCookiesError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

export type Cookie = chrome.cookies.Cookie

export type CookieStore = chrome.cookies.CookieStore

/** Why a cookie changed: `"explicit"` for a set/remove call, otherwise overwrite, expiry or eviction. */
export type ChangeCause = chrome.cookies.CookieChangeInfo["cause"]

/** One `onChanged` notification. Overwriting a cookie reports the old one removed, then the new one added. */
export interface CookieChange {
  readonly cookie: Cookie
  readonly cause: ChangeCause
  readonly removed: boolean
}

/** The Promise-based MV3 subset this module needs. */
export interface ChromeCookiesApi {
  getAll(details: chrome.cookies.GetAllDetails): Promise<Array<Cookie>>
  get(details: chrome.cookies.CookieDetails): Promise<Cookie | null>
  set(details: chrome.cookies.SetDetails): Promise<Cookie | null>
  remove(details: chrome.cookies.CookieDetails): Promise<chrome.cookies.CookieDetails | null>
  getAllCookieStores(): Promise<Array<CookieStore>>
  readonly onChanged: Pick<typeof chrome.cookies.onChanged, "addListener" | "removeListener">
}

export interface ChromeCookiesService {
  readonly getAll: (details: chrome.cookies.GetAllDetails) => Effect.Effect<Array<Cookie>, ChromeCookiesError>
  /** The cookie with the longest path for the URL and name, if any. */
  readonly get: (details: chrome.cookies.CookieDetails) => Effect.Effect<Option.Option<Cookie>, ChromeCookiesError>
  /** The cookie as stored; none when Chrome refused to set it. */
  readonly set: (details: chrome.cookies.SetDetails) => Effect.Effect<Option.Option<Cookie>, ChromeCookiesError>
  readonly remove: (details: chrome.cookies.CookieDetails) => Effect.Effect<void, ChromeCookiesError>
  /**
   * Removes a cookie read from `getAll`, rebuilding the URL Chrome needs from its domain,
   * path and secure flag, and keeping its store and partition.
   */
  readonly removeCookie: (cookie: Cookie) => Effect.Effect<void, ChromeCookiesError>
  /** The regular store, plus incognito stores and their tab ids while incognito windows are open. */
  readonly getAllCookieStores: Effect.Effect<Array<CookieStore>, ChromeCookiesError>
  /**
   * Cookie changes the extension has host access to. Each consumption owns a scoped
   * listener and retains at most 64 pending events, dropping the oldest. This is an
   * observation, not an MV3 wake listener; use ChromeServiceWorker.listen for that.
   */
  readonly onChanged: Stream.Stream<CookieChange, ChromeCookiesError>
}

export class ChromeCookies extends Context.Service<ChromeCookies, ChromeCookiesService>()("effect-platform-chrome/ChromeCookies") {}

const invoke = invoker((operation, cause) => new ChromeCookiesError({ operation, cause }))

/** The details that address exactly this cookie for `remove`. */
export const detailsOf = (cookie: Cookie): chrome.cookies.CookieDetails => {
  const details: chrome.cookies.CookieDetails = {
    url: `${cookie.secure ? "https" : "http"}://${cookie.domain.replace(/^\./, "")}${cookie.path}`,
    name: cookie.name,
    storeId: cookie.storeId
  }

  if (cookie.partitionKey !== undefined) details.partitionKey = cookie.partitionKey

  return details
}

/** Creates the service without reading browser globals. */
export const make = (api: ChromeCookiesApi): ChromeCookiesService => {
  const remove = (details: chrome.cookies.CookieDetails) => invoke("remove", () => api.remove(details)).pipe(Effect.asVoid)

  return ChromeCookies.of({
    getAll: (details) => invoke("getAll", () => api.getAll(details)),
    get: (details) => invoke("get", () => api.get(details)).pipe(Effect.map(Option.fromNullishOr)),
    set: (details) => invoke("set", () => api.set(details)).pipe(Effect.map(Option.fromNullishOr)),
    remove,
    removeCookie: (cookie) => remove(detailsOf(cookie)),
    getAllCookieStores: invoke("getAllCookieStores", () => api.getAllCookieStores()),
    onChanged: observe(
      () => api.onChanged,
      ({ cookie, cause, removed }: chrome.cookies.CookieChangeInfo): CookieChange => ({ cookie, cause, removed }),
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
