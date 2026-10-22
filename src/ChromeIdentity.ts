import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { attempter, invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

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
 * The Google account members (`getAuthToken` and the rest) need a Google account in the
 * profile, and the token calls the manifest's `oauth2` key. They are optional so injected
 * APIs without them, Chromium browsers that leave them out, Chrome before 87
 * (`clearAllCachedAuthTokens`) and non-dev channels (`getAccounts`) still fit; calling one
 * that is absent fails with the typed error.
 */
export interface ChromeIdentityApi {
  getRedirectURL(path?: string): string
  launchWebAuthFlow(details: chrome.identity.WebAuthFlowDetails): Promise<string | undefined>
  readonly getAuthToken?: (details?: chrome.identity.TokenDetails) => Promise<chrome.identity.GetAuthTokenResult>
  readonly removeCachedAuthToken?: (details: chrome.identity.InvalidTokenDetails) => Promise<void>
  readonly clearAllCachedAuthTokens?: () => Promise<void>
  readonly getProfileUserInfo?: (details?: chrome.identity.ProfileDetails) => Promise<chrome.identity.ProfileUserInfo>
  /** Chrome documents this as dev channel only. */
  readonly getAccounts?: () => Promise<Array<chrome.identity.AccountInfo>>
  readonly onSignInChanged?: EventSource<[account: chrome.identity.AccountInfo, signedIn: boolean]>
}

export interface ChromeIdentityService {
  /**
   * The `https://<extension-id>.chromiumapp.org/` URL an OAuth provider redirects to; Chrome
   * appends `path`, adding the leading `/` it lacks.
   */
  readonly getRedirectURL: (path?: string) => Effect.Effect<string, ChromeIdentityError>
  /**
   * Runs an OAuth flow in a Chrome-owned window and resolves to the URL the provider
   * redirected to (a `chromiumapp.org` URL), or None when Chrome reports no URL. Chrome
   * rejects a cancelled, failed or (non-interactive) unfinished flow; that rejection is the
   * typed error. Interrupting the Effect stops waiting but cannot close Chrome's window.
   */
  readonly launchWebAuthFlow: (
    details: chrome.identity.WebAuthFlowDetails
  ) => Effect.Effect<Option.Option<string>, ChromeIdentityError>
  /**
   * A Google OAuth2 token for the manifest's (or the given) scopes, with the scopes granted,
   * as Chrome's result object unchanged (Chrome types both fields as optional; `grantedScopes`
   * is filled since Chrome 87). Chrome serves it from its token cache when it can. A non-interactive request that would
   * need the user, a declined consent screen, or a signed-out profile is the typed error.
   * Interrupting an interactive request stops waiting but cannot dismiss Chrome's prompt.
   */
  readonly getAuthToken: (
    details?: chrome.identity.TokenDetails
  ) => Effect.Effect<chrome.identity.GetAuthTokenResult, ChromeIdentityError>
  /** Drops a token from Chrome's cache, typically one an API rejected; it does not revoke it. */
  readonly removeCachedAuthToken: (details: chrome.identity.InvalidTokenDetails) => Effect.Effect<void, ChromeIdentityError>
  /**
   * Resets the identity state of this extension: empties the token cache, forgets the
   * user's account preferences and de-authorizes every auth flow.
   */
  readonly clearAllCachedAuthTokens: Effect.Effect<void, ChromeIdentityError>
  /**
   * The profile's primary account. Chrome returns empty `email` and `id` when no account
   * is signed in (or synced, unless `accountStatus` is `"ANY"`) or without the
   * `identity.email` permission.
   */
  readonly getProfileUserInfo: (
    details?: chrome.identity.ProfileDetails
  ) => Effect.Effect<chrome.identity.ProfileUserInfo, ChromeIdentityError>
  /** The accounts on the profile. Chrome supports this only on the dev channel and rejects it elsewhere. */
  readonly getAccounts: Effect.Effect<Array<chrome.identity.AccountInfo>, ChromeIdentityError>
  /**
   * Account sign-in changes. Each consumption owns a scoped listener and retains at most 64
   * pending events, dropping the oldest. This is an observation, not an MV3 wake listener;
   * use ChromeServiceWorker.listen for that.
   */
  readonly onSignInChanged: Stream.Stream<SignInChange, ChromeIdentityError>
}

export class ChromeIdentity extends Context.Service<ChromeIdentity, ChromeIdentityService>()("effect-platform-chrome/ChromeIdentity") {}

const onError = (operation: string, cause: unknown) => new ChromeIdentityError({ operation, cause })

const invoke = invoker(onError)

const attempt = attempter(onError)

const unavailable = (operation: string) => new Error(`identity.${operation} is unavailable`)

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeIdentityApi): ChromeIdentityService => ChromeIdentity.of({
  getRedirectURL: (path) => attempt("getRedirectURL", () => path === undefined ? api.getRedirectURL() : api.getRedirectURL(path)),
  launchWebAuthFlow: (details) => invoke("launchWebAuthFlow", () => api.launchWebAuthFlow(details)).pipe(
    Effect.map(Option.fromNullishOr)
  ),
  getAuthToken: (details) => invoke("getAuthToken", () => {
    if (api.getAuthToken === undefined) throw unavailable("getAuthToken")

    return details === undefined ? api.getAuthToken() : api.getAuthToken(details)
  }),
  removeCachedAuthToken: (details) => invoke("removeCachedAuthToken", () => {
    if (api.removeCachedAuthToken === undefined) throw unavailable("removeCachedAuthToken")

    return api.removeCachedAuthToken(details)
  }),
  clearAllCachedAuthTokens: invoke("clearAllCachedAuthTokens", () => {
    if (api.clearAllCachedAuthTokens === undefined) throw unavailable("clearAllCachedAuthTokens")

    return api.clearAllCachedAuthTokens()
  }),
  getProfileUserInfo: (details) => invoke("getProfileUserInfo", () => {
    if (api.getProfileUserInfo === undefined) throw unavailable("getProfileUserInfo")

    return details === undefined ? api.getProfileUserInfo() : api.getProfileUserInfo(details)
  }),
  getAccounts: invoke("getAccounts", () => {
    if (api.getAccounts === undefined) throw unavailable("getAccounts")

    return api.getAccounts()
  }),
  onSignInChanged: observe(
    () => {
      if (api.onSignInChanged === undefined) throw unavailable("onSignInChanged")

      return api.onSignInChanged
    },
    (account, signedIn): SignInChange => ({ account, signedIn }),
    (cause) => onError("onSignInChanged", cause)
  )
})

export const layer = (api: ChromeIdentityApi): Layer.Layer<ChromeIdentity> => Layer.succeed(ChromeIdentity, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeIdentity, ChromeIdentityError> = liveLayer(
  ChromeIdentity, "identity", (chrome) => chrome.identity, make,
  (cause) => onError("initialize", cause)
)
