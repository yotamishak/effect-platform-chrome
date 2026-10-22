import { Context, Effect, Layer, Schema } from "effect"
import { invoker, liveLayer } from "./internal/api.js"

export class ChromeUserScriptsError extends Schema.TaggedError<ChromeUserScriptsError>()("ChromeUserScriptsError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/**
 * A dynamically registered user script as `getScripts` reports it, and the input of `update`,
 * where only `id` is required and only the supplied properties change.
 */
export type RegisteredUserScript = chrome.userScripts.RegisteredUserScript

/** Exactly one of `code` or `file` (extension-relative). */
export type ScriptSource = chrome.userScripts.ScriptSource

/** `USER_SCRIPT` (the default, exempt from the page's CSP) or the page's own `MAIN` world. */
export type ExecutionWorld = NonNullable<RegisteredUserScript["world"]>

/**
 * What `register` needs: Chrome rejects a script without `matches` or with an empty `js`.
 * The id must not be empty or start with `_`, and must not already be registered.
 */
export type UserScriptRegistration = RegisteredUserScript & {
  js: [ScriptSource, ...Array<ScriptSource>]
  matches: Array<string>
}

/** Selects scripts by id. Omitted `ids` selects every script; an empty list selects none. */
export type UserScriptFilter = chrome.userScripts.UserScriptFilter

/**
 * A world's configuration: `csp` (default: the isolated world's) and `messaging` (default
 * false). `worldId` (Chrome 133+) names a world; omitted or `""` is the default world.
 */
export type WorldProperties = chrome.userScripts.WorldProperties

/** The tab, and optionally `allFrames`, `frameIds` or `documentIds` (at most one of them). */
export type InjectionTarget = chrome.userScripts.InjectionTarget

export type UserScriptInjection = chrome.userScripts.UserScriptInjection

/**
 * One frame's outcome of `execute`. Code-string results are an untyped browser I/O
 * boundary; decode `result` with a schema.
 */
export type InjectionResult = chrome.userScripts.InjectionResult

/**
 * The Promise-based MV3 subset this module needs (Chrome 120+). The world-configuration
 * readers and resets are Chrome 133+ and `execute` is Chrome 135+; they are optional so
 * older browsers and injected APIs without them still fit, and calling one that is absent
 * fails with the typed error.
 */
export interface ChromeUserScriptsApi {
  register(scripts: Array<RegisteredUserScript>): Promise<void>
  update(scripts: Array<RegisteredUserScript>): Promise<void>
  unregister(filter?: UserScriptFilter): Promise<void>
  getScripts(filter?: UserScriptFilter): Promise<Array<RegisteredUserScript>>
  configureWorld(properties: WorldProperties): Promise<void>
  readonly getWorldConfigurations?: () => Promise<Array<WorldProperties>>
  readonly resetWorldConfiguration?: (worldId?: string) => Promise<void>
  readonly execute?: (injection: UserScriptInjection) => Promise<Array<InjectionResult>>
}

export interface ChromeUserScriptsService {
  /**
   * Whether the API is usable right now: a `getScripts` probe neither throws nor rejects.
   * Run it again to re-check; the user can revoke access at any time, after which every
   * other call fails synchronously with the typed error. Never fails.
   */
  readonly isAvailable: Effect.Effect<boolean>
  /**
   * Registers scripts atomically: Chrome rejects the whole call for a duplicate or reserved
   * id, a source with both or neither of `code` and `file`, a `worldId` with the `MAIN`
   * world, or a file it cannot load. Registrations are cleared when the extension updates.
   */
  readonly register: (scripts: Array<UserScriptRegistration>) => Effect.Effect<void, ChromeUserScriptsError>
  /**
   * Changes only the supplied properties; if any id is unknown or any result is invalid,
   * nothing changes. Chrome never updates `includeGlobs` or `excludeGlobs`, and
   * `worldId: ""` moves a script back to the default world.
   */
  readonly update: (scripts: Array<RegisteredUserScript>) => Effect.Effect<void, ChromeUserScriptsError>
  /**
   * Omitted filter (or omitted `ids`) unregisters ALL user scripts of this extension. Any
   * unknown id fails the call and unregisters nothing.
   */
  readonly unregister: (filter?: UserScriptFilter) => Effect.Effect<void, ChromeUserScriptsError>
  /**
   * Registered scripts in registration order, with Chrome's defaults filled in, optionally
   * only those with the filter's ids.
   */
  readonly getScripts: (filter?: UserScriptFilter) => Effect.Effect<Array<RegisteredUserScript>, ChromeUserScriptsError>
  /**
   * Sets the supplied `csp` and `messaging` of the default `USER_SCRIPT` world, or of the one
   * named by `worldId` (Chrome 133+). User scripts can message the extension only from a world
   * with `messaging: true`. Chrome refuses once 100 worlds are configured.
   */
  readonly configureWorld: (properties: WorldProperties) => Effect.Effect<void, ChromeUserScriptsError>
  /** Every configured world; the default world's entry has no `worldId` (Chrome 133+). */
  readonly getWorldConfigurations: Effect.Effect<Array<WorldProperties>, ChromeUserScriptsError>
  /**
   * Forgets `worldId`'s configuration, or the default world's when omitted, so it uses the
   * default configuration. Resetting an unconfigured world succeeds (Chrome 133+).
   */
  readonly resetWorldConfiguration: (worldId?: string) => Effect.Effect<void, ChromeUserScriptsError>
  /**
   * Injects code or files once into a tab (Chrome 135+), at `document_idle` unless
   * `injectImmediately`; a script evaluating to a promise is awaited. Results list the top
   * frame first and leave out frames Chrome could not inject into; when the target is a
   * single frame and it fails, the call fails instead. Current Chrome never sets `error`.
   */
  readonly execute: (injection: UserScriptInjection) => Effect.Effect<Array<InjectionResult>, ChromeUserScriptsError>
}

export class ChromeUserScripts extends Context.Service<ChromeUserScripts, ChromeUserScriptsService>()(
  "effect-platform-chrome/ChromeUserScripts"
) {}

const invoke = invoker((operation, cause) => new ChromeUserScriptsError({ operation, cause }))

const unavailable = (operation: string) => new Error(`userScripts.${operation} is unavailable`)

/** Explains how a user grants access; Chrome gives no reason when the API is missing. */
export const unavailableMessage = "chrome.userScripts is unavailable: declare the \"userScripts\" permission, then the user "
  + "must turn on \"Allow User Scripts\" on the extension's details page (Chrome 138+) or Developer mode at "
  + "chrome://extensions (Chrome 120-137)"

// Chrome's documented probe: the namespace is undefined (138+) or throws on access (120-137)
// while access is off, and a method call throws synchronously once access is revoked. A
// rejection also means the API is not usable now.
const probe = (getApi: () => ChromeUserScriptsApi | undefined): Effect.Effect<boolean> =>
  invoke("getScripts", () => {
    const api = getApi()

    if (api === undefined) throw new Error(unavailableMessage)

    return api.getScripts()
  }).pipe(Effect.as(true), Effect.orElseSucceed(() => false))

/**
 * Probes the global API when run (never at import time), so callers can check before
 * building `layerLive` and show the user how to enable user scripts. In Chrome 138+ the
 * namespace stays undefined after the user turns access on until the extension's context
 * reloads (for example with `chrome.runtime.reload()`).
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
  getWorldConfigurations: invoke("getWorldConfigurations", () => api.getWorldConfigurations === undefined
    ? Promise.reject(unavailable("getWorldConfigurations"))
    : api.getWorldConfigurations()),
  resetWorldConfiguration: (worldId) => invoke("resetWorldConfiguration", () => {
    if (api.resetWorldConfiguration === undefined) return Promise.reject(unavailable("resetWorldConfiguration"))

    return worldId === undefined ? api.resetWorldConfiguration() : api.resetWorldConfiguration(worldId)
  }),
  execute: (injection) => invoke("execute", () => api.execute === undefined
    ? Promise.reject(unavailable("execute"))
    : api.execute(injection))
})

export const layer = (api: ChromeUserScriptsApi): Layer.Layer<ChromeUserScripts> =>
  Layer.succeed(ChromeUserScripts, make(api))

/**
 * Reads the global once, only when built. Fails with operation "initialize" and a cause
 * pointing at the user toggle when the namespace is missing or throws on access. A layer
 * built while access is on keeps working calls only while the user leaves it on.
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
