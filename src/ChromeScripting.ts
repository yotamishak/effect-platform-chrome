import { Context, Effect, Layer, Schema } from "effect"
import { invoker, liveLayer } from "./internal/api.js"

export class ChromeScriptingError extends Schema.TaggedError<ChromeScriptingError>()("ChromeScriptingError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** The injectable, promise-based MV3 subset; callback overloads are not used. */
export interface ChromeScriptingApi {
  executeScript<Args extends Array<unknown>, Result>(injection: chrome.scripting.ScriptInjection<Args, Result>): Promise<Array<chrome.scripting.InjectionResult<Awaited<Result>>>>
  insertCSS(injection: chrome.scripting.CSSInjection): Promise<void>
  removeCSS(injection: chrome.scripting.CSSInjection): Promise<void>
  registerContentScripts(scripts: Array<chrome.scripting.RegisteredContentScript>): Promise<void>
  getRegisteredContentScripts(filter?: chrome.scripting.ContentScriptFilter): Promise<Array<chrome.scripting.RegisteredContentScript>>
  updateContentScripts(scripts: Array<ContentScriptUpdate>): Promise<void>
  unregisterContentScripts(filter?: chrome.scripting.ContentScriptFilter): Promise<void>
}

/** Functions are serialized by Chrome: closures are lost and args must be JSON-serializable. */
export type FunctionInjection<Args extends Array<unknown>, Result> =
  Omit<chrome.scripting.ScriptInjection<Args, Result>, "func" | "args" | "files"> & {
    func: (...args: Args) => Result
    files?: never
  } & ([] extends Args ? { args?: NoInfer<Args> } : { args: NoInfer<Args> })

// Files are an untyped browser I/O boundary, not a caller-supplied result contract.
export type FileInjection = Extract<chrome.scripting.ScriptInjection<[], unknown>, { files: Array<string> }> & { args?: never }

/** Chrome updates only supplied properties; unlike registration, updates may contain only an id. */
export type ContentScriptUpdate = Partial<chrome.scripting.RegisteredContentScript> & Pick<chrome.scripting.RegisteredContentScript, "id">

export interface ChromeScriptingService {
  readonly executeScript: {
    <Args extends Array<unknown>, Result>(injection: FunctionInjection<Args, Result>): Effect.Effect<Array<chrome.scripting.InjectionResult<Awaited<Result>>>, ChromeScriptingError>
    (injection: FileInjection): Effect.Effect<Array<chrome.scripting.InjectionResult<unknown>>, ChromeScriptingError>
  }
  readonly insertCSS: (injection: chrome.scripting.CSSInjection) => Effect.Effect<void, ChromeScriptingError>
  readonly removeCSS: (injection: chrome.scripting.CSSInjection) => Effect.Effect<void, ChromeScriptingError>
  readonly registerContentScripts: (scripts: Array<chrome.scripting.RegisteredContentScript>) => Effect.Effect<void, ChromeScriptingError>
  readonly getRegisteredContentScripts: (filter?: chrome.scripting.ContentScriptFilter) => Effect.Effect<Array<chrome.scripting.RegisteredContentScript>, ChromeScriptingError>
  readonly updateContentScripts: (scripts: Array<ContentScriptUpdate>) => Effect.Effect<void, ChromeScriptingError>
  /** Omitted filter unregisters ALL dynamic content scripts for this extension. */
  readonly unregisterContentScripts: (filter?: chrome.scripting.ContentScriptFilter) => Effect.Effect<void, ChromeScriptingError>
}

export class ChromeScripting extends Context.Service<ChromeScripting, ChromeScriptingService>()("effect-platform-chrome/ChromeScripting") {}

const invoke = invoker((operation, cause) => new ChromeScriptingError({ operation, cause }))

export const make = (api: ChromeScriptingApi): ChromeScriptingService => {
  function executeScript<Args extends Array<unknown>, Result>(injection: FunctionInjection<Args, Result>): Effect.Effect<Array<chrome.scripting.InjectionResult<Awaited<Result>>>, ChromeScriptingError>
  function executeScript(injection: FileInjection): Effect.Effect<Array<chrome.scripting.InjectionResult<unknown>>, ChromeScriptingError>
  function executeScript<Args extends Array<unknown>, Result>(injection: chrome.scripting.ScriptInjection<Args, Result>): Effect.Effect<Array<chrome.scripting.InjectionResult<Awaited<Result>>>, ChromeScriptingError> {
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

/** Chrome globals are read only when this layer is built. */
export const layerLive: Layer.Layer<ChromeScripting, ChromeScriptingError> = liveLayer(
  ChromeScripting, "scripting", (chrome) => chrome.scripting, make,
  (cause) => new ChromeScriptingError({ operation: "initialize", cause })
)
