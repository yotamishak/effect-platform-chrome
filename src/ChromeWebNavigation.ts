import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeWebNavigationError extends Schema.TaggedError<ChromeWebNavigationError>()("ChromeWebNavigationError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

export type Frame = chrome.webNavigation.GetAllFrameResultDetails

export type FrameInfo = chrome.webNavigation.GetFrameResultDetails

export type Navigation = chrome.webNavigation.WebNavigationTransitionCallbackDetails

type NavigationEvent = EventSource<[details: Navigation]>

/** The Promise-based MV3 subset this module needs. */
export interface ChromeWebNavigationApi {
  getAllFrames(details: chrome.webNavigation.GetAllFrameDetails): Promise<Array<Frame> | null>
  getFrame(details: chrome.webNavigation.GetFrameDetails): Promise<FrameInfo | null>
  readonly onCommitted: NavigationEvent
  readonly onHistoryStateUpdated: NavigationEvent
}

export interface ChromeWebNavigationService {
  /** Every frame of the tab, top frame (`frameId` 0) included. A closed or unknown tab has none. */
  readonly getAllFrames: (tabId: number) => Effect.Effect<Array<Frame>, ChromeWebNavigationError>
  /** One frame, or none when the tab, frame or document is unknown. */
  readonly getFrame: (details: chrome.webNavigation.GetFrameDetails) => Effect.Effect<Option.Option<FrameInfo>, ChromeWebNavigationError>
  /**
   * Observational subscriptions, like every stream in this library: listeners exist only
   * while the stream runs and cannot wake an MV3 service worker. Register wake listeners
   * synchronously through ChromeServiceWorker instead. Each subscription buffers at most
   * 64 events, dropping the oldest on overflow.
   */
  readonly onCommitted: Stream.Stream<Navigation, ChromeWebNavigationError>
  /** Same-document navigations (pushState and friends) that change the frame's URL. */
  readonly onHistoryStateUpdated: Stream.Stream<Navigation, ChromeWebNavigationError>
}

export class ChromeWebNavigation extends Context.Service<ChromeWebNavigation, ChromeWebNavigationService>()(
  "effect-platform-chrome/ChromeWebNavigation"
) {}

const invoke = invoker((operation, cause) => new ChromeWebNavigationError({ operation, cause }))

const navigations = (operation: string, getSource: () => NavigationEvent): Stream.Stream<Navigation, ChromeWebNavigationError> =>
  observe(getSource, (details) => details, (cause) => new ChromeWebNavigationError({ operation, cause }))

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeWebNavigationApi): ChromeWebNavigationService => ChromeWebNavigation.of({
  getAllFrames: (tabId) => invoke("getAllFrames", () => api.getAllFrames({ tabId })).pipe(
    Effect.map((frames) => frames ?? [])
  ),
  getFrame: (details) => invoke("getFrame", () => api.getFrame(details)).pipe(Effect.map(Option.fromNullishOr)),
  onCommitted: navigations("onCommitted", () => api.onCommitted),
  onHistoryStateUpdated: navigations("onHistoryStateUpdated", () => api.onHistoryStateUpdated)
})

export const layer = (api: ChromeWebNavigationApi): Layer.Layer<ChromeWebNavigation> =>
  Layer.succeed(ChromeWebNavigation, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeWebNavigation, ChromeWebNavigationError> = liveLayer(
  ChromeWebNavigation, "webNavigation", (chrome) => chrome.webNavigation, make,
  (cause) => new ChromeWebNavigationError({ operation: "initialize", cause })
)
