import { Context, Effect, Layer, Schema } from "effect"
import { invoker, liveLayer } from "./internal/api.js"

export class ChromeWindowsError extends Schema.TaggedError<ChromeWindowsError>()("ChromeWindowsError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** The Promise-based MV3 subset this module needs. */
export interface ChromeWindowsApi {
  get(windowId: number, queryOptions?: chrome.windows.QueryOptions): Promise<chrome.windows.Window>
  getCurrent(queryOptions?: chrome.windows.QueryOptions): Promise<chrome.windows.Window>
  update(windowId: number, updateInfo: chrome.windows.UpdateInfo): Promise<chrome.windows.Window>
}

export interface ChromeWindowsService {
  readonly get: (windowId: number, queryOptions?: chrome.windows.QueryOptions) => Effect.Effect<chrome.windows.Window, ChromeWindowsError>
  /** The window of the calling context; in a service worker, the last focused window. */
  readonly getCurrent: (queryOptions?: chrome.windows.QueryOptions) => Effect.Effect<chrome.windows.Window, ChromeWindowsError>
  readonly update: (windowId: number, updateInfo: chrome.windows.UpdateInfo) => Effect.Effect<chrome.windows.Window, ChromeWindowsError>
  /** Brings a window to the front. */
  readonly focus: (windowId: number) => Effect.Effect<chrome.windows.Window, ChromeWindowsError>
}

export class ChromeWindows extends Context.Service<ChromeWindows, ChromeWindowsService>()("effect-platform-chrome/ChromeWindows") {}

const invoke = invoker((operation, cause) => new ChromeWindowsError({ operation, cause }))

/** Creates the service without reading browser globals. */
export const make = (api: ChromeWindowsApi): ChromeWindowsService => {
  const update = (windowId: number, updateInfo: chrome.windows.UpdateInfo) =>
    invoke("update", () => api.update(windowId, updateInfo))

  return ChromeWindows.of({
    get: (windowId, queryOptions) => invoke("get", () => queryOptions === undefined
      ? api.get(windowId)
      : api.get(windowId, queryOptions)),
    getCurrent: (queryOptions) => invoke("getCurrent", () => queryOptions === undefined
      ? api.getCurrent()
      : api.getCurrent(queryOptions)),
    update,
    focus: (windowId) => update(windowId, { focused: true })
  })
}

export const layer = (api: ChromeWindowsApi): Layer.Layer<ChromeWindows> => Layer.succeed(ChromeWindows, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeWindows, ChromeWindowsError> = liveLayer(
  ChromeWindows, "windows", (chrome) => chrome.windows, make,
  (cause) => new ChromeWindowsError({ operation: "initialize", cause })
)
