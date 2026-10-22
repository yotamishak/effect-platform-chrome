import { Context, Effect, Layer, Schema } from "effect"
import { invoker, liveLayer } from "./internal/api.js"

export class ChromeUserScriptsError extends Schema.TaggedError<ChromeUserScriptsError>()("ChromeUserScriptsError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

export type RegisteredUserScript = chrome.userScripts.RegisteredUserScript

export type UserScriptFilter = chrome.userScripts.UserScriptFilter

export type WorldProperties = chrome.userScripts.WorldProperties

export type UserScriptInjection = chrome.userScripts.UserScriptInjection

/** Code-string results are an untyped browser I/O boundary; decode them with a schema. */
export type InjectionResult = chrome.userScripts.InjectionResult

/** The Promise-based MV3 subset this module needs (Chrome 120+; worlds 133+; `execute` 135+). */
export interface ChromeUserScriptsApi {
  register(scripts: Array<RegisteredUserScript>): Promise<void>
  update(scripts: Array<RegisteredUserScript>): Promise<void>
  unregister(filter?: UserScriptFilter): Promise<void>
  getScripts(filter?: UserScriptFilter): Promise<Array<RegisteredUserScript>>
  configureWorld(properties: WorldProperties): Promise<void>
  getWorldConfigurations(): Promise<Array<WorldProperties>>
  resetWorldConfiguration(worldId?: string): Promise<void>
  execute(injection: UserScriptInjection): Promise<Array<InjectionResult>>
}

export interface ChromeUserScriptsService {
  /**
   * Whether the API is usable right now: its probe call neither throws nor rejects. The user
   * can revoke access at any time, after which every other call fails synchronously.
   */
  readonly isAvailable: Effect.Effect<boolean>
  /** Each script needs a non-empty `js` and `matches`; ids must not start with `_`. */
  readonly register: (scripts: Array<RegisteredUserScript>) => Effect.Effect<void, ChromeUserScriptsError>
  /** Updates only the supplied properties; if any id is unknown, nothing is updated. */
  readonly update: (scripts: Array<RegisteredUserScript>) => Effect.Effect<void, ChromeUserScriptsError>
  /** Omitted filter unregisters ALL user scripts of this extension. */
  readonly unregister: (filter?: UserScriptFilter) => Effect.Effect<void, ChromeUserScriptsError>
  readonly getScripts: (filter?: UserScriptFilter) => Effect.Effect<Array<RegisteredUserScript>, ChromeUserScriptsError>
  /** Configures the default `USER_SCRIPT` world, or the one named by `worldId` (Chrome 133+). */
  readonly configureWorld: (properties: WorldProperties) => Effect.Effect<void, ChromeUserScriptsError>
  /** Chrome 133+. */
  readonly getWorldConfigurations: Effect.Effect<Array<WorldProperties>, ChromeUserScriptsError>
  /** Resets `worldId`'s configuration, or the default world's when omitted (Chrome 133+). */
  readonly resetWorldConfiguration: (worldId?: string) => Effect.Effect<void, ChromeUserScriptsError>
  /**
   * Injects code or files once into a tab (Chrome 135+). Results are per frame and unknown:
   * the code is a string, so no result type can be inferred. A frame whose script threw
   * reports `error` instead of `result`.
   */
  readonly execute: (injection: UserScriptInjection) => Effect.Effect<Array<InjectionResult>, ChromeUserScriptsError>
}

export class ChromeUserScripts extends Context.Service<ChromeUserScripts, ChromeUserScriptsService>()(
  "effect-platform-chrome/ChromeUserScripts"
) {}

const invoke = invoker((operation, cause) => new ChromeUserScriptsError({ operation, cause }))

/** Explains how a user grants access; Chrome gives no reason when the API is missing. */
export const unavailableMessage = "chrome.userScripts is unavailable: declare the \"userScripts\" permission, then the user "
  + "must turn on \"Allow User Scripts\" on the extension's details page (Chrome 138+) or Developer mode at "
  + "chrome://extensions (Chrome 120-137)"

// Chrome's documented probe: the namespace is undefined (138+) or throws on access (120-137)
// while access is off, and a method call throws synchronously once access is revoked.
const probe = (getApi: () => Pick<ChromeUserScriptsApi, "getScripts"> | undefined): Effect.Effect<boolean> =>
  Effect.tryPromise(() => {
    const api = getApi()

    return api === undefined ? Promise.resolve(false) : api.getScripts().then(() => true)
  }).pipe(Effect.orElseSucceed(() => false))

/**
 * Probes the global API when run (never at import time), so callers can check before
 * building `layerLive` and show the user how to enable user scripts.
 */
export const isAvailable: Effect.Effect<boolean> = probe(() => typeof chrome === "undefined" ? undefined : chrome.userScripts)

/** Creates the service without reading browser globals. */
export const make = (api: ChromeUserScriptsApi): ChromeUserScriptsService => ChromeUserScripts.of({
  isAvailable: probe(() => api),
  register: (scripts) => invoke("register", () => api.register(scripts)),
  update: (scripts) => invoke("update", () => api.update(scripts)),
  unregister: (filter) => invoke("unregister", () => filter === undefined
    ? api.unregister()
    : api.unregister(filter)),
  getScripts: (filter) => invoke("getScripts", () => filter === undefined
    ? api.getScripts()
    : api.getScripts(filter)),
  configureWorld: (properties) => invoke("configureWorld", () => api.configureWorld(properties)),
  getWorldConfigurations: invoke("getWorldConfigurations", () => api.getWorldConfigurations()),
  resetWorldConfiguration: (worldId) => invoke("resetWorldConfiguration", () => worldId === undefined
    ? api.resetWorldConfiguration()
    : api.resetWorldConfiguration(worldId)),
  execute: (injection) => invoke("execute", () => api.execute(injection))
})

export const layer = (api: ChromeUserScriptsApi): Layer.Layer<ChromeUserScripts> =>
  Layer.succeed(ChromeUserScripts, make(api))

/**
 * Reads the global only when built. Fails with operation "initialize" and a cause pointing
 * at the user toggle when the namespace is missing or throws on access.
 */
export const layerLive: Layer.Layer<ChromeUserScripts, ChromeUserScriptsError> = liveLayer(
  ChromeUserScripts, "userScripts", (chrome) => {
    let api: ChromeUserScriptsApi | undefined

    try {
      api = chrome.userScripts
    } catch (cause) {
      throw new Error(unavailableMessage, { cause })
    }

    if (api === undefined) throw new Error(unavailableMessage)

    return api
  }, make,
  (cause) => new ChromeUserScriptsError({ operation: "initialize", cause })
)
