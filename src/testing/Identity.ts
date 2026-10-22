import * as ChromeIdentity from "../ChromeIdentity.js"
import * as TestEvent from "./Event.js"

// Scripted rejections and injected failures are raw rejection causes, as Chrome's would be.
/* oxlint-disable anti-slop/no-unknown-parameters */

export type IdentityOperation =
  | "getRedirectURL" | "launchWebAuthFlow" | "getAuthToken" | "removeCachedAuthToken"
  | "clearAllCachedAuthTokens" | "getProfileUserInfo"

export interface IdentityOptions {
  /** The extension's redirect URL; paths passed to `getRedirectURL` are appended to it. */
  readonly redirectURL?: string
  /** Replaces any member of the simulated API. */
  readonly overrides?: Partial<ChromeIdentity.ChromeIdentityApi>
}

/** What the next `launchWebAuthFlow` does: resolve to a URL, or reject with a cause. */
type FlowOutcome =
  | { readonly resolve: (details: chrome.identity.WebAuthFlowDetails) => string | undefined }
  | { readonly reject: unknown }

interface CachedToken {
  readonly token: string
  readonly grantedScopes: Array<string>
}

const scopesKey = (scopes: ReadonlyArray<string> | undefined): string => JSON.stringify(Array.from(scopes ?? []).sort())

const signedOut: chrome.identity.ProfileUserInfo = { email: "", id: "" }

/**
 * An in-memory identity API. `launchWebAuthFlow` plays scripted outcomes in order; an
 * unscripted flow rejects as Chrome does when the user closes the window (interactive) or
 * interaction would be needed (non-interactive). `getAuthToken` serves its token cache,
 * keyed by the requested scope set: a miss rejects when non-interactive, and otherwise
 * consumes the next token queued with `controls.grantNext`, as a consent screen would,
 * rejecting when none is queued. A signed-out profile rejects every token request.
 * `signIn` / `signOut` change the profile and emit `onSignInChanged`; signing out empties
 * the cache. Every call can be failed once with `controls.failNext`.
 */
export const makeIdentity = (options: IdentityOptions = {}) => {
  const redirectURL = options.redirectURL ?? "https://test-extension-id.chromiumapp.org/"
  const signInChanged = TestEvent.makeEvent<[chrome.identity.AccountInfo, boolean]>()
  const failures = new Map<IdentityOperation, Array<unknown>>()
  const outcomes: Array<FlowOutcome> = []
  const flows: Array<chrome.identity.WebAuthFlowDetails> = []
  const grants: Array<string> = []
  const cache = new Map<string, CachedToken>()
  let profile: chrome.identity.ProfileUserInfo = signedOut

  const check = (operation: IdentityOperation) => {
    const queue = failures.get(operation)

    if (queue !== undefined && queue.length > 0) throw queue.shift()
  }

  const api: ChromeIdentity.ChromeIdentityApi = {
    getRedirectURL: (path) => {
      check("getRedirectURL")

      return `${redirectURL}${(path ?? "").replace(/^\//, "")}`
    },
    launchWebAuthFlow: async (details) => {
      check("launchWebAuthFlow")
      flows.push(structuredClone(details))
      const outcome = outcomes.shift()

      if (outcome === undefined) {
        throw new Error(details.interactive === true ? "The user did not approve access." : "User interaction required.")
      }

      if ("reject" in outcome) throw outcome.reject

      return outcome.resolve(details)
    },
    getAuthToken: async (details = {}) => {
      check("getAuthToken")

      if (profile.id === "") throw new Error("The user is not signed in.")

      const key = scopesKey(details.scopes)
      const cached = cache.get(key)

      if (cached !== undefined) return { token: cached.token, grantedScopes: Array.from(cached.grantedScopes) }

      if (details.interactive !== true) throw new Error("OAuth2 not granted or revoked.")

      const token = grants.shift()

      if (token === undefined) throw new Error("The user did not approve access.")

      const granted: CachedToken = { token, grantedScopes: Array.from(details.scopes ?? []) }
      cache.set(key, granted)

      return { token, grantedScopes: Array.from(granted.grantedScopes) }
    },
    removeCachedAuthToken: async ({ token }) => {
      check("removeCachedAuthToken")

      for (const [key, cached] of Array.from(cache)) {
        if (cached.token === token) cache.delete(key)
      }
    },
    clearAllCachedAuthTokens: async () => {
      check("clearAllCachedAuthTokens")
      cache.clear()
    },
    getProfileUserInfo: async () => {
      check("getProfileUserInfo")

      return { ...profile }
    },
    onSignInChanged: signInChanged.api,
    ...options.overrides
  }

  return {
    api,
    layer: ChromeIdentity.layer(api),
    controls: {
      onSignInChanged: signInChanged.controls,
      /** Every `launchWebAuthFlow` request, in call order. */
      flows,
      /** Resolves the next web auth flow to this URL, or to what the function returns for its details. */
      resolveNextFlow: (redirect: string | ((details: chrome.identity.WebAuthFlowDetails) => string | undefined)) => {
        outcomes.push({ resolve: (details) => redirect instanceof Function ? redirect(details) : redirect })
      },
      /** Rejects the next web auth flow with this cause, such as a provider error. */
      rejectNextFlow: (cause: unknown) => { outcomes.push({ reject: cause }) },
      /** Queues a token the next interactive cache miss grants. */
      grantNext: (token: string) => { grants.push(token) },
      /** Caches a token for a scope set, as if consent had been given earlier. */
      cacheToken: (token: string, scopes: ReadonlyArray<string> = []) => {
        cache.set(scopesKey(scopes), { token, grantedScopes: Array.from(scopes) })
      },
      /** The cached tokens, in caching order. */
      cachedTokens: (): Array<string> => Array.from(cache.values(), (cached) => cached.token),
      signIn: (user: chrome.identity.ProfileUserInfo) => {
        profile = { ...user }
        signInChanged.controls.emit({ id: user.id }, true)
      },
      signOut: () => {
        const { id } = profile
        profile = signedOut
        cache.clear()
        signInChanged.controls.emit({ id }, false)
      },
      failNext: (operation: IdentityOperation, cause: unknown) => {
        const queue = failures.get(operation) ?? []
        queue.push(cause)
        failures.set(operation, queue)
      }
    }
  }
}
