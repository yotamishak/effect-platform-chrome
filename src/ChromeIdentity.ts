import { Context, Effect, Layer, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe } from "./internal/event.js"

export class ChromeIdentityError extends Schema.TaggedError<ChromeIdentityError>()("ChromeIdentityError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** A sign-in state change of a Google account in the browser profile. */
export interface SignInChange {
  readonly account: chrome.identity.AccountInfo
  readonly signedIn: boolean
}

/**
 * The Promise-based MV3 identity subset. The web auth flow works with any OAuth provider.
 * The Google account members (`getAuthToken` and the rest) exist only in Chrome and need
 * the manifest's `oauth2` key; they are optional so injected APIs without them still fit,
 * and calling one that is absent fails with the typed error.
 */
export interface ChromeIdentityApi {
  getRedirectURL(path?: string): string
  launchWebAuthFlow(details: chrome.identity.WebAuthFlowDetails): Promise<string | undefined>
  readonly getAuthToken?: (details?: chrome.identity.TokenDetails) => Promise<chrome.identity.GetAuthTokenResult>
  readonly removeCachedAuthToken?: (details: chrome.identity.InvalidTokenDetails) => Promise<void>
  readonly clearAllCachedAuthTokens?: () => Promise<void>
  readonly getProfileUserInfo?: (details?: chrome.identity.ProfileDetails) => Promise<chrome.identity.ProfileUserInfo>
  readonly onSignInChanged?: Pick<typeof chrome.identity.onSignInChanged, "addListener" | "removeListener">
}

export interface ChromeIdentityService {
  /** The `https://<extension-id>.chromiumapp.org/` URL an OAuth provider redirects to, optionally with a path. */
  readonly getRedirectURL: (path?: string) => Effect.Effect<string, ChromeIdentityError>
  /**
   * Runs an OAuth flow and resolves to the URL the provider redirected to. Chrome rejects
   * a cancelled, failed or (non-interactive) unfinished flow; that rejection is the typed error.
   */
  readonly launchWebAuthFlow: (details: chrome.identity.WebAuthFlowDetails) => Effect.Effect<string | undefined, ChromeIdentityError>
  /**
   * A Google OAuth2 token for the manifest's (or the given) scopes, with the scopes granted.
   * Chrome serves it from its token cache when it can. A non-interactive request that would
   * need the user, a declined consent screen, or a signed-out profile is the typed error.
   */
  readonly getAuthToken: (details?: chrome.identity.TokenDetails) => Effect.Effect<chrome.identity.GetAuthTokenResult, ChromeIdentityError>
  /** Drops a token from Chrome's cache, typically one an API rejected; it does not revoke it. */
  readonly removeCachedAuthToken: (details: chrome.identity.InvalidTokenDetails) => Effect.Effect<void, ChromeIdentityError>
  /** Empties Chrome's token cache for this extension and forgets its granted consent. */
  readonly clearAllCachedAuthTokens: Effect.Effect<void, ChromeIdentityError>
  /**
   * The profile's signed-in account. Chrome returns empty `email` and `id` when no account
   * is signed in (or synced, by default) or without the `identity.email` permission.
   */
  readonly getProfileUserInfo: (details?: chrome.identity.ProfileDetails) => Effect.Effect<chrome.identity.ProfileUserInfo, ChromeIdentityError>
  /**
   * Account sign-in changes. Each consumption owns a scoped listener and retains at most 64
   * pending events, dropping the oldest. This is an observation, not an MV3 wake listener;
   * use ChromeServiceWorker.listen for that.
   */
  readonly onSignInChanged: Stream.Stream<SignInChange, ChromeIdentityError>
}

export class ChromeIdentity extends Context.Service<ChromeIdentity, ChromeIdentityService>()("effect-platform-chrome/ChromeIdentity") {}

const invoke = invoker((operation, cause) => new ChromeIdentityError({ operation, cause }))

const unavailable = (operation: string) => new Error(`identity.${operation} is unavailable`)

/** Creates the service without reading browser globals. */
export const make = (api: ChromeIdentityApi): ChromeIdentityService => ChromeIdentity.of({
  getRedirectURL: (path) => Effect.try({
    try: () => path === undefined ? api.getRedirectURL() : api.getRedirectURL(path),
    catch: (cause) => new ChromeIdentityError({ operation: "getRedirectURL", cause })
  }),
  launchWebAuthFlow: (details) => Effect.tryPromise({
    try: () => api.launchWebAuthFlow(details),
    catch: (cause) => new ChromeIdentityError({ operation: "launchWebAuthFlow", cause })
  }),
  getAuthToken: (details) => invoke("getAuthToken", () => {
    if (api.getAuthToken === undefined) return Promise.reject(unavailable("getAuthToken"))

    return details === undefined ? api.getAuthToken() : api.getAuthToken(details)
  }),
  removeCachedAuthToken: (details) => invoke("removeCachedAuthToken", () => api.removeCachedAuthToken === undefined
    ? Promise.reject(unavailable("removeCachedAuthToken"))
    : api.removeCachedAuthToken(details)),
  clearAllCachedAuthTokens: invoke("clearAllCachedAuthTokens", () => api.clearAllCachedAuthTokens === undefined
    ? Promise.reject(unavailable("clearAllCachedAuthTokens"))
    : api.clearAllCachedAuthTokens()),
  getProfileUserInfo: (details) => invoke("getProfileUserInfo", () => {
    if (api.getProfileUserInfo === undefined) return Promise.reject(unavailable("getProfileUserInfo"))

    return details === undefined ? api.getProfileUserInfo() : api.getProfileUserInfo(details)
  }),
  onSignInChanged: observe(
    () => {
      if (api.onSignInChanged === undefined) throw unavailable("onSignInChanged")

      return api.onSignInChanged
    },
    (account: chrome.identity.AccountInfo, signedIn: boolean): SignInChange => ({ account, signedIn }),
    (cause) => new ChromeIdentityError({ operation: "onSignInChanged", cause })
  )
})

export const layer = (api: ChromeIdentityApi): Layer.Layer<ChromeIdentity> => Layer.succeed(ChromeIdentity, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeIdentity, ChromeIdentityError> = liveLayer(
  ChromeIdentity, "identity", (chrome) => chrome.identity, make,
  (cause) => new ChromeIdentityError({ operation: "initialize", cause })
)
