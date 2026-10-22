import { Context, Effect, Layer, Schema } from "effect"

export class ChromeIdentityError extends Schema.TaggedError<ChromeIdentityError>()("ChromeIdentityError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** The web auth flow subset of the Promise-based MV3 API; Google account token APIs are not wrapped. */
export interface ChromeIdentityApi {
  getRedirectURL(path?: string): string
  launchWebAuthFlow(details: chrome.identity.WebAuthFlowDetails): Promise<string | undefined>
}

export interface ChromeIdentityService {
  /** The `https://<extension-id>.chromiumapp.org/` URL an OAuth provider redirects to, optionally with a path. */
  readonly getRedirectURL: (path?: string) => Effect.Effect<string, ChromeIdentityError>
  /**
   * Runs an OAuth flow and resolves to the URL the provider redirected to. Chrome rejects
   * a cancelled, failed or (non-interactive) unfinished flow; that rejection is the typed error.
   */
  readonly launchWebAuthFlow: (details: chrome.identity.WebAuthFlowDetails) => Effect.Effect<string | undefined, ChromeIdentityError>
}

export class ChromeIdentity extends Context.Service<ChromeIdentity, ChromeIdentityService>()("effect-platform-chrome/ChromeIdentity") {}

/** Creates the service without reading browser globals. */
export const make = (api: ChromeIdentityApi): ChromeIdentityService => ChromeIdentity.of({
  getRedirectURL: (path) => Effect.try({
    try: () => path === undefined ? api.getRedirectURL() : api.getRedirectURL(path),
    catch: (cause) => new ChromeIdentityError({ operation: "getRedirectURL", cause })
  }),
  launchWebAuthFlow: (details) => Effect.tryPromise({
    try: () => api.launchWebAuthFlow(details),
    catch: (cause) => new ChromeIdentityError({ operation: "launchWebAuthFlow", cause })
  })
})

export const layer = (api: ChromeIdentityApi): Layer.Layer<ChromeIdentity> => Layer.succeed(ChromeIdentity, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeIdentity, ChromeIdentityError> = Layer.effect(ChromeIdentity, Effect.try({
  try: () => {
    const api = typeof chrome === "undefined" ? undefined : chrome.identity

    if (api === undefined) {
      throw new Error("chrome.identity is unavailable in this context")
    }

    return make(api)
  },
  catch: (cause) => new ChromeIdentityError({ operation: "initialize", cause })
}))
