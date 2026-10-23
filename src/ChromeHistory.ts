import { Context, Effect, Layer, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeHistoryError extends Schema.TaggedError<ChromeHistoryError>()("ChromeHistoryError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/**
 * A page in history. Chrome sets every field, though its declared type leaves all but `id`
 * optional: `title` is empty when unknown, and `lastVisitTime` is the page's latest visit,
 * whatever the query's range. Each item is a copy the caller owns.
 */
export interface HistoryItem {
  id: string
  url: string
  title: string
  lastVisitTime: number
  visitCount: number
  typedCount: number
}

/**
 * One visit to a page, linked to its `HistoryItem` by `id`. Chrome always sets `visitTime`;
 * `isLocal` needs Chrome 115.
 */
export interface VisitItem extends chrome.history.VisitItem {
  visitTime: number
}

/** How a visit was reached from its referrer, such as `"link"` or `"typed"`. */
export type TransitionType = VisitItem["transition"]

export type HistoryQuery = chrome.history.HistoryQuery

/** A time range in milliseconds since the epoch, from `startTime` inclusive to `endTime` exclusive. */
export type Range = chrome.history.Range

/**
 * One `onVisitRemoved` notification. `allHistory` is set by `deleteAll` and the browser's own
 * clearing of everything, with no `urls`; otherwise `urls` lists the pages that lost their
 * last visit, which is empty when only some of a page's visits were removed.
 */
export interface RemovedResult {
  readonly allHistory: boolean
  readonly urls: Array<string>
}

/** The Promise-based MV3 subset this module needs. */
export interface ChromeHistoryApi {
  search(query: HistoryQuery): Promise<Array<chrome.history.HistoryItem>>
  getVisits(details: chrome.history.UrlDetails): Promise<Array<chrome.history.VisitItem>>
  addUrl(details: chrome.history.UrlDetails): Promise<void>
  deleteUrl(details: chrome.history.UrlDetails): Promise<void>
  deleteRange(range: Range): Promise<void>
  deleteAll(): Promise<void>
  readonly onVisited: EventSource<[result: chrome.history.HistoryItem]>
  readonly onVisitRemoved: EventSource<[removed: chrome.history.RemovedResult]>
}

/**
 * Every call requires the `history` permission. A URL argument must be valid and not
 * `isolated-app:`, or Chrome rejects with "Url is invalid."; the delete calls reject with
 * "Browsing history is not allowed to be deleted." while the AllowDeletingBrowserHistory
 * policy forbids it.
 */
export interface ChromeHistoryService {
  /**
   * One item per page with a visit in the query's range, most recently visited first.
   * `text` (empty for all) matches words of the URL or title. Without `startTime` the range
   * starts 24 hours ago, and without `endTime` it ends now; `maxResults` defaults to 100,
   * and 0 means no limit, while a negative or fractional one fails. Subframe and
   * keyword-generated visits never match, nor do visits answered with a 404.
   */
  readonly search: (query: HistoryQuery) => Effect.Effect<Array<HistoryItem>, ChromeHistoryError>
  /** Every visit to the URL except those answered with a 404, oldest first; empty for a URL not in history. */
  readonly getVisits: (url: string) => Effect.Effect<Array<VisitItem>, ChromeHistoryError>
  /**
   * Records a visit to the URL now, with the "link" transition, firing `onVisited`. A URL
   * Chrome keeps out of history (`about:`, `chrome:`, `chrome-untrusted:`, `devtools:`,
   * `javascript:`, `view-source:` and Chrome's other internal schemes) succeeds without
   * recording anything or firing `onVisited`.
   */
  readonly addUrl: (url: string) => Effect.Effect<void, ChromeHistoryError>
  /** Removes the page and every visit to it, firing `onVisitRemoved` when it was in history. */
  readonly deleteUrl: (url: string) => Effect.Effect<void, ChromeHistoryError>
  /**
   * Removes visits from `startTime` inclusive to `endTime` exclusive, in milliseconds since
   * the epoch. A page is removed only when every one of its visits is; `onVisitRemoved`
   * fires when any visit was removed.
   */
  readonly deleteRange: (range: Range) => Effect.Effect<void, ChromeHistoryError>
  /** Removes all history, firing `onVisitRemoved` with `allHistory` set. */
  readonly deleteAll: Effect.Effect<void, ChromeHistoryError>
  /**
   * Observational subscriptions that cannot wake an MV3 service worker; register wake
   * listeners through ChromeServiceWorker. Each buffers at most 64 events, dropping the oldest.
   * `onVisited` reports the visited page before it loads, including `addUrl` visits but not
   * visits answered with a 404.
   */
  readonly onVisited: Stream.Stream<HistoryItem, ChromeHistoryError>
  /** Removals; `urls` is always present, empty when Chrome reports none. */
  readonly onVisitRemoved: Stream.Stream<RemovedResult, ChromeHistoryError>
}

export class ChromeHistory extends Context.Service<ChromeHistory, ChromeHistoryService>()("effect-platform-chrome/ChromeHistory") {}

const invoke = invoker((operation, cause) => new ChromeHistoryError({ operation, cause }))

const eventError = (operation: string) => (cause: unknown) => new ChromeHistoryError({ operation, cause })

/**
 * Chrome sets every field, so the fallbacks only cover a non-conforming API. The copy keeps
 * Chrome's event argument, which every listener in the context shares, safe from consumers.
 */
const historyItem = (item: chrome.history.HistoryItem): HistoryItem => ({
  ...item,
  url: item.url ?? "",
  title: item.title ?? "",
  lastVisitTime: item.lastVisitTime ?? 0,
  visitCount: item.visitCount ?? 0,
  typedCount: item.typedCount ?? 0
})

const visitItem = (visit: chrome.history.VisitItem): VisitItem => ({ ...visit, visitTime: visit.visitTime ?? 0 })

/** Chrome always sends `urls`, but its declared type leaves it optional; the copy is the consumer's own. */
const removedResult = (removed: chrome.history.RemovedResult): RemovedResult => ({
  allHistory: removed.allHistory,
  urls: Array.from(removed.urls ?? [])
})

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeHistoryApi): ChromeHistoryService => ChromeHistory.of({
  search: (query) => invoke("search", () => api.search(query)).pipe(Effect.map((items) => items.map(historyItem))),
  getVisits: (url) => invoke("getVisits", () => api.getVisits({ url })).pipe(Effect.map((visits) => visits.map(visitItem))),
  addUrl: (url) => invoke("addUrl", () => api.addUrl({ url })),
  deleteUrl: (url) => invoke("deleteUrl", () => api.deleteUrl({ url })),
  deleteRange: (range) => invoke("deleteRange", () => api.deleteRange(range)),
  deleteAll: invoke("deleteAll", () => api.deleteAll()),
  onVisited: observe(() => api.onVisited, historyItem, eventError("onVisited")),
  onVisitRemoved: observe(() => api.onVisitRemoved, removedResult, eventError("onVisitRemoved"))
})

export const layer = (api: ChromeHistoryApi): Layer.Layer<ChromeHistory> => Layer.succeed(ChromeHistory, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeHistory, ChromeHistoryError> = liveLayer(
  ChromeHistory, "history", (chrome) => chrome.history, make,
  (cause) => new ChromeHistoryError({ operation: "initialize", cause })
)
