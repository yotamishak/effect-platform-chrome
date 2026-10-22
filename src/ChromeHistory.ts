import { Context, Effect, Layer, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeHistoryError extends Schema.TaggedError<ChromeHistoryError>()("ChromeHistoryError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

export type HistoryItem = chrome.history.HistoryItem

export type VisitItem = chrome.history.VisitItem

export type HistoryQuery = chrome.history.HistoryQuery

export type Range = chrome.history.Range

/** What `onVisitRemoved` reports: every URL when `allHistory` is set, otherwise the removed `urls`. */
export type RemovedResult = chrome.history.RemovedResult

/** The Promise-based MV3 subset this module needs. */
export interface ChromeHistoryApi {
  search(query: HistoryQuery): Promise<Array<HistoryItem>>
  getVisits(details: chrome.history.UrlDetails): Promise<Array<VisitItem>>
  addUrl(details: chrome.history.UrlDetails): Promise<void>
  deleteUrl(details: chrome.history.UrlDetails): Promise<void>
  deleteRange(range: Range): Promise<void>
  deleteAll(): Promise<void>
  readonly onVisited: EventSource<[result: HistoryItem]>
  readonly onVisitRemoved: EventSource<[removed: RemovedResult]>
}

export interface ChromeHistoryService {
  /**
   * The last visit of each page matching `text` (empty for all), most recent first. Without
   * `startTime`, only the past 24 hours are searched; `maxResults` defaults to 100.
   * Requires the `history` permission, as does every call here.
   */
  readonly search: (query: HistoryQuery) => Effect.Effect<Array<HistoryItem>, ChromeHistoryError>
  readonly getVisits: (url: string) => Effect.Effect<Array<VisitItem>, ChromeHistoryError>
  /** Records a visit to the URL now, with the "link" transition. */
  readonly addUrl: (url: string) => Effect.Effect<void, ChromeHistoryError>
  /** Removes every visit to the URL. */
  readonly deleteUrl: (url: string) => Effect.Effect<void, ChromeHistoryError>
  /** Removes visits between the range's times, in milliseconds since the epoch; pages are removed only if every visit is. */
  readonly deleteRange: (range: Range) => Effect.Effect<void, ChromeHistoryError>
  readonly deleteAll: Effect.Effect<void, ChromeHistoryError>
  /**
   * Observational subscriptions that cannot wake an MV3 service worker; register wake
   * listeners through ChromeServiceWorker. Each buffers at most 64 events, dropping the oldest.
   */
  readonly onVisited: Stream.Stream<HistoryItem, ChromeHistoryError>
  readonly onVisitRemoved: Stream.Stream<RemovedResult, ChromeHistoryError>
}

export class ChromeHistory extends Context.Service<ChromeHistory, ChromeHistoryService>()("effect-platform-chrome/ChromeHistory") {}

const invoke = invoker((operation, cause) => new ChromeHistoryError({ operation, cause }))

const eventError = (operation: string) => (cause: unknown) => new ChromeHistoryError({ operation, cause })

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeHistoryApi): ChromeHistoryService => ChromeHistory.of({
  search: (query) => invoke("search", () => api.search(query)),
  getVisits: (url) => invoke("getVisits", () => api.getVisits({ url })),
  addUrl: (url) => invoke("addUrl", () => api.addUrl({ url })),
  deleteUrl: (url) => invoke("deleteUrl", () => api.deleteUrl({ url })),
  deleteRange: (range) => invoke("deleteRange", () => api.deleteRange(range)),
  deleteAll: invoke("deleteAll", () => api.deleteAll()),
  onVisited: observe(() => api.onVisited, (result) => result, eventError("onVisited")),
  onVisitRemoved: observe(() => api.onVisitRemoved, (removed) => removed, eventError("onVisitRemoved"))
})

export const layer = (api: ChromeHistoryApi): Layer.Layer<ChromeHistory> => Layer.succeed(ChromeHistory, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeHistory, ChromeHistoryError> = liveLayer(
  ChromeHistory, "history", (chrome) => chrome.history, make,
  (cause) => new ChromeHistoryError({ operation: "initialize", cause })
)
