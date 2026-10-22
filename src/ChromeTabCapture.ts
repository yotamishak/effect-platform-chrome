import { Context, Effect, Layer, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeTabCaptureError extends Schema.TaggedError<ChromeTabCaptureError>()("ChromeTabCaptureError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

export type CaptureInfo = chrome.tabCapture.CaptureInfo

export type MediaStreamOptions = chrome.tabCapture.GetMediaStreamOptions

/**
 * The Promise-based MV3 subset this module needs (Chrome 116+). `capture` is deliberately
 * left out: it is callback-only, needs a DOM `MediaStream`, and is unavailable in the MV3
 * service worker. Use `getMediaStreamId` and consume the id in an offscreen document or page.
 */
export interface ChromeTabCaptureApi {
  getMediaStreamId(options?: MediaStreamOptions): Promise<string>
  getCapturedTabs(): Promise<Array<CaptureInfo>>
  readonly onStatusChanged: EventSource<[info: CaptureInfo]>
}

export interface ChromeTabCaptureService {
  /**
   * Creates a short-lived stream id for `targetTabId` (default: the active tab), which must
   * have an `activeTab` grant from a user gesture such as an action click. Callable from the
   * service worker. Redeem it with `navigator.mediaDevices.getUserMedia` using
   * `{ mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: id } }` in an offscreen
   * document or extension page (or in `consumerTabId`, when given). Unused ids expire within
   * seconds; a tab already being captured fails.
   */
  readonly getMediaStreamId: (options?: MediaStreamOptions) => Effect.Effect<string, ChromeTabCaptureError>
  /** Tabs whose capture is pending or active. */
  readonly getCapturedTabs: Effect.Effect<Array<CaptureInfo>, ChromeTabCaptureError>
  /**
   * Observational capture status changes; this subscription cannot wake an MV3 service
   * worker (use ChromeServiceWorker.listen). Buffers at most 64 events, dropping the oldest.
   */
  readonly onStatusChanged: Stream.Stream<CaptureInfo, ChromeTabCaptureError>
}

export class ChromeTabCapture extends Context.Service<ChromeTabCapture, ChromeTabCaptureService>()(
  "effect-platform-chrome/ChromeTabCapture"
) {}

const invoke = invoker((operation, cause) => new ChromeTabCaptureError({ operation, cause }))

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeTabCaptureApi): ChromeTabCaptureService => ChromeTabCapture.of({
  getMediaStreamId: (options) => invoke("getMediaStreamId", () => options === undefined
    ? api.getMediaStreamId()
    : api.getMediaStreamId(options)),
  getCapturedTabs: invoke("getCapturedTabs", () => api.getCapturedTabs()),
  onStatusChanged: observe(
    () => api.onStatusChanged, (info) => info,
    (cause) => new ChromeTabCaptureError({ operation: "onStatusChanged", cause })
  )
})

export const layer = (api: ChromeTabCaptureApi): Layer.Layer<ChromeTabCapture> =>
  Layer.succeed(ChromeTabCapture, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeTabCapture, ChromeTabCaptureError> = liveLayer(
  ChromeTabCapture, "tabCapture", (chrome) => chrome.tabCapture, make,
  (cause) => new ChromeTabCaptureError({ operation: "initialize", cause })
)
