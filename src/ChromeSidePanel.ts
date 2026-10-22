import { Context, Effect, Layer, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"
import { starter } from "./internal/gesture.js"

export class ChromeSidePanelError extends Schema.TaggedError<ChromeSidePanelError>()("ChromeSidePanelError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/**
 * The Promise-based MV3 subset this module needs (`chrome.sidePanel` is Chrome 114+). The
 * newer members are optional so older browsers and injected APIs without them still fit:
 * `open` is Chrome 116+, `getLayout` 140+, `close` and `onOpened` 141+, `onClosed` 142+.
 * Calling or subscribing to an absent member fails with the typed error.
 */
export interface ChromeSidePanelApi {
  setOptions(options: chrome.sidePanel.PanelOptions): Promise<void>
  getOptions(options: chrome.sidePanel.GetPanelOptions): Promise<chrome.sidePanel.PanelOptions>
  setPanelBehavior(behavior: chrome.sidePanel.PanelBehavior): Promise<void>
  getPanelBehavior(): Promise<chrome.sidePanel.PanelBehavior>
  readonly open?: (options: chrome.sidePanel.OpenOptions) => Promise<void>
  readonly close?: (options: chrome.sidePanel.CloseOptions) => Promise<void>
  readonly getLayout?: () => Promise<chrome.sidePanel.PanelLayout>
  readonly onOpened?: EventSource<[info: chrome.sidePanel.PanelOpenedInfo]>
  readonly onClosed?: EventSource<[info: chrome.sidePanel.PanelClosedInfo]>
}

export interface ChromeSidePanelService {
  /**
   * Configures the panel for one tab, or the default for every tab without its own options
   * when `tabId` is absent. `enabled: false` hides it; `path` is extension-relative.
   */
  readonly setOptions: (options: chrome.sidePanel.PanelOptions) => Effect.Effect<void, ChromeSidePanelError>
  /**
   * A tab's options, or the default options without a `tabId`. Chrome requires the argument,
   * so omitting it sends `{}`, which reads the default options.
   */
  readonly getOptions: (options?: chrome.sidePanel.GetPanelOptions) => Effect.Effect<chrome.sidePanel.PanelOptions, ChromeSidePanelError>
  /** Upserts the behavior, such as `openPanelOnActionClick`, which makes the action icon toggle the panel. */
  readonly setPanelBehavior: (behavior: chrome.sidePanel.PanelBehavior) => Effect.Effect<void, ChromeSidePanelError>
  readonly getPanelBehavior: Effect.Effect<chrome.sidePanel.PanelBehavior, ChromeSidePanelError>
  /**
   * Opens the panel in a tab or window (Chrome 116+). Chrome only opens it in response to a
   * user action and rejects otherwise. Lazy: composing it inside a handler does not call
   * Chrome, so prefer `openFromUserGesture` there.
   */
  readonly open: (options: chrome.sidePanel.OpenOptions) => Effect.Effect<void, ChromeSidePanelError>
  /**
   * The user-gesture bridge for `open`: calls Chrome NOW, on the caller's synchronous stack,
   * and returns an Effect observing that one call. Running it again replays the outcome
   * rather than opening again.
   */
  readonly openFromUserGesture: (options: chrome.sidePanel.OpenOptions) => Effect.Effect<void, ChromeSidePanelError>
  /**
   * Closes the panel (Chrome 141+): a `tabId` closes that tab's tab-specific panel, a
   * `windowId` the window's global panel. A no-op when the panel is already closed; since
   * Chrome 145 it rejects when given a `tabId` whose tab only shows the global panel.
   */
  readonly close: (options: chrome.sidePanel.CloseOptions) => Effect.Effect<void, ChromeSidePanelError>
  /** Which side of the window the panel occupies (Chrome 140+). */
  readonly getLayout: Effect.Effect<chrome.sidePanel.PanelLayout, ChromeSidePanelError>
  /**
   * Panel openings (Chrome 141+); `tabId` is present only for a tab-specific panel.
   * Observational: these streams cannot wake an MV3 service worker; register wake listeners
   * through ChromeServiceWorker. Each buffers at most 64 events, dropping the oldest.
   */
  readonly onOpened: Stream.Stream<chrome.sidePanel.PanelOpenedInfo, ChromeSidePanelError>
  /** Panel closings (Chrome 142+); `tabId` is present only for a tab-specific panel. */
  readonly onClosed: Stream.Stream<chrome.sidePanel.PanelClosedInfo, ChromeSidePanelError>
}

export class ChromeSidePanel extends Context.Service<ChromeSidePanel, ChromeSidePanelService>()(
  "effect-platform-chrome/ChromeSidePanel"
) {}

const onError = (operation: string, cause: unknown) => new ChromeSidePanelError({ operation, cause })

const invoke = invoker(onError)

const start = starter(onError)

const unavailable = (operation: string) => new Error(`sidePanel.${operation} is unavailable`)

/**
 * Creates the service without reading browser globals or registering listeners. Version-gated
 * members are read when used, never when the service is made, and called as methods of `api`.
 */
export const make = (api: ChromeSidePanelApi): ChromeSidePanelService => {
  const open = (options: chrome.sidePanel.OpenOptions): Promise<void> => {
    if (api.open === undefined) throw unavailable("open")

    return api.open(options)
  }

  return ChromeSidePanel.of({
    setOptions: (options) => invoke("setOptions", () => api.setOptions(options)),
    getOptions: (options) => invoke("getOptions", () => api.getOptions(options ?? {})),
    setPanelBehavior: (behavior) => invoke("setPanelBehavior", () => api.setPanelBehavior(behavior)),
    getPanelBehavior: invoke("getPanelBehavior", () => api.getPanelBehavior()),
    open: (options) => invoke("open", () => open(options)),
    openFromUserGesture: (options) => start("open", () => open(options)),
    close: (options) => invoke("close", () => {
      if (api.close === undefined) throw unavailable("close")

      return api.close(options)
    }),
    getLayout: invoke("getLayout", () => {
      if (api.getLayout === undefined) throw unavailable("getLayout")

      return api.getLayout()
    }),
    onOpened: observe(() => {
      if (api.onOpened === undefined) throw unavailable("onOpened")

      return api.onOpened
    }, (info) => info, (cause) => onError("onOpened", cause)),
    onClosed: observe(() => {
      if (api.onClosed === undefined) throw unavailable("onClosed")

      return api.onClosed
    }, (info) => info, (cause) => onError("onClosed", cause))
  })
}

export const layer = (api: ChromeSidePanelApi): Layer.Layer<ChromeSidePanel> => Layer.succeed(ChromeSidePanel, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeSidePanel, ChromeSidePanelError> = liveLayer(
  ChromeSidePanel, "sidePanel", (chrome) => chrome.sidePanel, make,
  (cause) => new ChromeSidePanelError({ operation: "initialize", cause })
)
