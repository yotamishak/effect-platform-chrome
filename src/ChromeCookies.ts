import { Context, Effect, Layer, Option, Schema } from "effect"
import { invoker, liveLayer } from "./internal/api.js"

export class ChromeCookiesError extends Schema.TaggedError<ChromeCookiesError>()("ChromeCookiesError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

export type Cookie = chrome.cookies.Cookie

/** The Promise-based MV3 subset this module needs. */
export interface ChromeCookiesApi {
  getAll(details: chrome.cookies.GetAllDetails): Promise<Array<Cookie>>
  get(details: chrome.cookies.CookieDetails): Promise<Cookie | null>
  set(details: chrome.cookies.SetDetails): Promise<Cookie | null>
  remove(details: chrome.cookies.CookieDetails): Promise<chrome.cookies.CookieDetails | null>
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
    removeCookie: (cookie) => remove(detailsOf(cookie))
  })
}

export const layer = (api: ChromeCookiesApi): Layer.Layer<ChromeCookies> => Layer.succeed(ChromeCookies, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeCookies, ChromeCookiesError> = liveLayer(
  ChromeCookies, "cookies", (chrome) => chrome.cookies, make,
  (cause) => new ChromeCookiesError({ operation: "initialize", cause })
)
