import { Context, Effect, Layer, Schema } from "effect"
import { invoker, liveLayer } from "./internal/api.js"

export class ChromeScriptingError extends Schema.TaggedError<ChromeScriptingError>()("ChromeScriptingError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** The cascade origin of injected CSS; Chrome defaults to `"AUTHOR"`. */
export type StyleOrigin = `${chrome.scripting.StyleOrigin}`

/** `"ISOLATED"` (the default) is the extension's own world; `"MAIN"` is shared with the page. */
export type ExecutionWorld = `${chrome.scripting.ExecutionWorld}`

/**
 * A tab and, optionally, its frames: `allFrames`, or explicit `frameIds`, or `documentIds`.
 * Without any of them Chrome targets the main frame only.
 */
export type InjectionTarget = chrome.scripting.InjectionTarget

/**
 * One frame's outcome: its `frameId`, `documentId` and the serialized `result`, which Chrome
 * may leave out. Frames Chrome could not inject into are left out of the list, unless only one
 * frame was targeted, in which case the whole call fails.
 */
export type InjectionResult<Result> = chrome.scripting.InjectionResult<Result>

/** Exactly one of `css` and `files`, a target, and an optional `origin`. */
export type CSSInjection = chrome.scripting.CSSInjection

/** A dynamic content script as `getRegisteredContentScripts` reports it. */
export type RegisteredContentScript = chrome.scripting.RegisteredContentScript

/**
 * A content script to register. Chrome requires `matches` and at least one `js` or `css`
 * file; the id must be non-empty, must not start with `_`, and must not be registered yet.
 */
export type ContentScriptRegistration = RegisteredContentScript & { matches: Array<string> }

/**
 * Selects dynamic content scripts by id. An absent or EMPTY `ids` selects every dynamic
 * content script of this extension (Chrome treats `ids: []` like no filter).
 */
export type ContentScriptFilter = chrome.scripting.ContentScriptFilter

/**
 * Changes the supplied properties of the registered script `id`; an id-only update is valid.
 * Chrome never changes a registered script's `world` on update, so there is no `world`
 * field: unregister and register again to move a script to another world.
 */
export interface ContentScriptUpdate {
  id: string
  matches?: Array<string> | undefined
  excludeMatches?: Array<string> | undefined
  js?: Array<string> | undefined
  css?: Array<string> | undefined
  allFrames?: boolean | undefined
  matchOriginAsFallback?: boolean | undefined
  runAt?: chrome.extensionTypes.RunAt | undefined
  persistAcrossSessions?: boolean | undefined
}

/** Functions are serialized by Chrome: closures are lost and args must be JSON-serializable. */
export type FunctionInjection<Args extends Array<unknown>, Result> =
  Omit<chrome.scripting.ScriptInjection<Args, Result>, "func" | "args" | "files"> & {
    func: (...args: Args) => Result
    files?: never
  } & ([] extends Args ? { args?: NoInfer<Args> } : { args: NoInfer<Args> })

// Files are an untyped browser I/O boundary, not a caller-supplied result contract.
export type FileInjection = Extract<chrome.scripting.ScriptInjection<[], unknown>, { files: Array<string> }> & { args?: never }

/** The Promise-based MV3 subset this module needs (Chrome 96+); callback overloads are not used. */
export interface ChromeScriptingApi {
  executeScript<Args extends Array<unknown>, Result>(injection: chrome.scripting.ScriptInjection<Args, Result>): Promise<Array<InjectionResult<Awaited<Result>>>>
  insertCSS(injection: CSSInjection): Promise<void>
  removeCSS(injection: CSSInjection): Promise<void>
  registerContentScripts(scripts: Array<ContentScriptRegistration>): Promise<void>
  getRegisteredContentScripts(filter?: ContentScriptFilter): Promise<Array<RegisteredContentScript>>
  updateContentScripts(scripts: Array<ContentScriptUpdate>): Promise<void>
  unregisterContentScripts(filter?: ContentScriptFilter): Promise<void>
}

export interface ChromeScriptingService {
  /**
   * Runs `func` (with `args`) or packaged `files` once in each targeted frame and resolves to
   * the per-frame results, main frame first. Chrome awaits a returned Promise. A function's
   * argument tuple and awaited result are inferred; a file injection's results are `unknown`.
   * With several frames, frames Chrome could not reach are left out rather than failing.
   */
  readonly executeScript: {
    <Args extends Array<unknown>, Result>(injection: FunctionInjection<Args, Result>): Effect.Effect<Array<InjectionResult<Awaited<Result>>>, ChromeScriptingError>
    (injection: FileInjection): Effect.Effect<Array<InjectionResult<unknown>>, ChromeScriptingError>
  }
  /**
   * Inserts a stylesheet into each targeted frame. With several frames, frames Chrome could
   * not reach are ignored, so success does not prove every frame changed.
   */
  readonly insertCSS: (injection: CSSInjection) => Effect.Effect<void, ChromeScriptingError>
  /**
   * Removes a stylesheet this extension inserted; `css` or `files` and `origin` must match the
   * insertion exactly. Removing a stylesheet that is not there succeeds and does nothing.
   */
  readonly removeCSS: (injection: CSSInjection) => Effect.Effect<void, ChromeScriptingError>
  /** Registers every script or, when any is invalid or its id is taken, none of them. */
  readonly registerContentScripts: (scripts: Array<ContentScriptRegistration>) => Effect.Effect<void, ChromeScriptingError>
  /** This extension's dynamic content scripts, all of them unless `filter.ids` names some. */
  readonly getRegisteredContentScripts: (filter?: ContentScriptFilter) => Effect.Effect<Array<RegisteredContentScript>, ChromeScriptingError>
  /** Updates every script or, when any id is not fully registered or any update is invalid, none. */
  readonly updateContentScripts: (scripts: Array<ContentScriptUpdate>) => Effect.Effect<void, ChromeScriptingError>
  /**
   * Unregisters the dynamic content scripts `filter.ids` names, failing without removing any
   * when one is unknown. An omitted filter, or one whose `ids` is absent or EMPTY, removes ALL
   * of this extension's dynamic content scripts. Code already injected stays in its pages.
   */
  readonly unregisterContentScripts: (filter?: ContentScriptFilter) => Effect.Effect<void, ChromeScriptingError>
}

export class ChromeScripting extends Context.Service<ChromeScripting, ChromeScriptingService>()("effect-platform-chrome/ChromeScripting") {}

const invoke = invoker((operation, cause) => new ChromeScriptingError({ operation, cause }))

/** Creates the service without reading browser globals. */
export const make = (api: ChromeScriptingApi): ChromeScriptingService => {
  function executeScript<Args extends Array<unknown>, Result>(injection: FunctionInjection<Args, Result>): Effect.Effect<Array<InjectionResult<Awaited<Result>>>, ChromeScriptingError>
  function executeScript(injection: FileInjection): Effect.Effect<Array<InjectionResult<unknown>>, ChromeScriptingError>
  function executeScript<Args extends Array<unknown>, Result>(injection: chrome.scripting.ScriptInjection<Args, Result>): Effect.Effect<Array<InjectionResult<Awaited<Result>>>, ChromeScriptingError> {
    return invoke("executeScript", () => api.executeScript(injection))
  }

  return ChromeScripting.of({
    executeScript,
    insertCSS: (injection) => invoke("insertCSS", () => api.insertCSS(injection)),
    removeCSS: (injection) => invoke("removeCSS", () => api.removeCSS(injection)),
    registerContentScripts: (scripts) => invoke("registerContentScripts", () => api.registerContentScripts(scripts)),
    getRegisteredContentScripts: (filter) => invoke("getRegisteredContentScripts", () => filter === undefined
      ? api.getRegisteredContentScripts()
      : api.getRegisteredContentScripts(filter)),
    updateContentScripts: (scripts) => invoke("updateContentScripts", () => api.updateContentScripts(scripts)),
    unregisterContentScripts: (filter) => invoke("unregisterContentScripts", () => filter === undefined
      ? api.unregisterContentScripts()
      : api.unregisterContentScripts(filter))
  })
}

export const layer = (api: ChromeScriptingApi): Layer.Layer<ChromeScripting> => Layer.succeed(ChromeScripting, make(api))

/** Reads `chrome.scripting` once, when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeScripting, ChromeScriptingError> = liveLayer(
  ChromeScripting, "scripting", (chrome) => chrome.scripting, make,
  (cause) => new ChromeScriptingError({ operation: "initialize", cause })
)
