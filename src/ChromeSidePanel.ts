import { Context, Effect, Exit, Layer, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeSidePanelError extends Schema.TaggedError<ChromeSidePanelError>()("ChromeSidePanelError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** The Promise-based MV3 subset this module needs. */
export interface ChromeSidePanelApi {
  setOptions(options: chrome.sidePanel.PanelOptions): Promise<void>
  getOptions(options: chrome.sidePanel.GetPanelOptions): Promise<chrome.sidePanel.PanelOptions>
  setPanelBehavior(behavior: chrome.sidePanel.PanelBehavior): Promise<void>
  getPanelBehavior(): Promise<chrome.sidePanel.PanelBehavior>
  open(options: chrome.sidePanel.OpenOptions): Promise<void>
  close(options: chrome.sidePanel.CloseOptions): Promise<void>
  getLayout(): Promise<chrome.sidePanel.PanelLayout>
  readonly onOpened: EventSource<[info: chrome.sidePanel.PanelOpenedInfo]>
  readonly onClosed: EventSource<[info: chrome.sidePanel.PanelClosedInfo]>
}

export interface ChromeSidePanelService {
  /**
   * Configures the panel for one tab, or the default for every tab without its own options
   * when `tabId` is absent. `enabled: false` hides it; `path` is extension-relative.
   */
  readonly setOptions: (options: chrome.sidePanel.PanelOptions) => Effect.Effect<void, ChromeSidePanelError>
  /** A tab's options, falling back to the default; the default options without a `tabId`. */
  readonly getOptions: (options?: chrome.sidePanel.GetPanelOptions) => Effect.Effect<chrome.sidePanel.PanelOptions, ChromeSidePanelError>
  /** Upserts the behavior, such as `openPanelOnActionClick`, which makes the action icon toggle the panel. */
  readonly setPanelBehavior: (behavior: chrome.sidePanel.PanelBehavior) => Effect.Effect<void, ChromeSidePanelError>
  readonly getPanelBehavior: Effect.Effect<chrome.sidePanel.PanelBehavior, ChromeSidePanelError>
  /**
   * Lazy: Chrome only opens the panel in response to a user action, so the caller must ensure
   * execution reaches Chrome within the gesture. Prefer `openFromUserGesture` in handlers.
   */
  readonly open: (options: chrome.sidePanel.OpenOptions) => Effect.Effect<void, ChromeSidePanelError>
  /** Explicit native boundary: calls `open` NOW, not when the returned Effect runs. */
  readonly openFromUserGesture: (options: chrome.sidePanel.OpenOptions) => Effect.Effect<void, ChromeSidePanelError>
  /** Closes a tab-specific or window-wide panel (Chrome 141+); fails when none is open there. */
  readonly close: (options: chrome.sidePanel.CloseOptions) => Effect.Effect<void, ChromeSidePanelError>
  /** Which side of the window the panel occupies (Chrome 140+). */
  readonly getLayout: Effect.Effect<chrome.sidePanel.PanelLayout, ChromeSidePanelError>
  /**
   * Observational subscriptions (Chrome 141+ and 142+) that cannot wake an MV3 service worker;
   * register wake listeners through `ChromeServiceWorker.listen`. Each buffers at most 64
   * events, dropping the oldest.
   */
  readonly onOpened: Stream.Stream<chrome.sidePanel.PanelOpenedInfo, ChromeSidePanelError>
  readonly onClosed: Stream.Stream<chrome.sidePanel.PanelClosedInfo, ChromeSidePanelError>
}

export class ChromeSidePanel extends Context.Service<ChromeSidePanel, ChromeSidePanelService>()(
  "effect-platform-chrome/ChromeSidePanel"
) {}

const invoke = invoker((operation, cause) => new ChromeSidePanelError({ operation, cause }))

const eventError = (operation: string) => (cause: unknown) => new ChromeSidePanelError({ operation, cause })

/** Attach both settlement handlers immediately, even if the returned Effect is never run. */
const openImmediately = (
  api: ChromeSidePanelApi,
  options: chrome.sidePanel.OpenOptions
): Effect.Effect<void, ChromeSidePanelError> => {
  try {
    const outcome: Promise<Exit.Exit<void, ChromeSidePanelError>> = api.open(options).then(
      () => Exit.void,
      (cause) => Exit.fail(new ChromeSidePanelError({ operation: "open", cause }))
    )

    return Effect.flatMap(Effect.promise(() => outcome), (exit) => exit)
  } catch (cause) {
    return Effect.fail(new ChromeSidePanelError({ operation: "open", cause }))
  }
}

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeSidePanelApi): ChromeSidePanelService => ChromeSidePanel.of({
  setOptions: (options) => invoke("setOptions", () => api.setOptions(options)),
  getOptions: (options = {}) => invoke("getOptions", () => api.getOptions(options)),
  setPanelBehavior: (behavior) => invoke("setPanelBehavior", () => api.setPanelBehavior(behavior)),
  getPanelBehavior: invoke("getPanelBehavior", () => api.getPanelBehavior()),
  open: (options) => invoke("open", () => api.open(options)),
  openFromUserGesture: (options) => openImmediately(api, options),
  close: (options) => invoke("close", () => api.close(options)),
  getLayout: invoke("getLayout", () => api.getLayout()),
  onOpened: observe(() => api.onOpened, (info) => info, eventError("onOpened")),
  onClosed: observe(() => api.onClosed, (info) => info, eventError("onClosed"))
})

export const layer = (api: ChromeSidePanelApi): Layer.Layer<ChromeSidePanel> => Layer.succeed(ChromeSidePanel, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeSidePanel, ChromeSidePanelError> = liveLayer(
  ChromeSidePanel, "sidePanel", (chrome) => chrome.sidePanel, make,
  (cause) => new ChromeSidePanelError({ operation: "initialize", cause })
)
