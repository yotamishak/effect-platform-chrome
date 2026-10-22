import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeWebNavigationError extends Schema.TaggedError<ChromeWebNavigationError>()("ChromeWebNavigationError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

export type Frame = chrome.webNavigation.GetAllFrameResultDetails

export type FrameInfo = chrome.webNavigation.GetFrameResultDetails

/** A committed navigation, history-state update or fragment update, with its transition. */
export type Navigation = chrome.webNavigation.WebNavigationTransitionCallbackDetails

/** A navigation that is about to start; it has no document yet. */
export type NavigationStart = chrome.webNavigation.WebNavigationBaseCallbackDetails

/** A document that finished parsing (`onDOMContentLoaded`) or loading (`onCompleted`). */
export type DocumentLoad = chrome.webNavigation.WebNavigationFramedCallbackDetails

export type NavigationFailure = chrome.webNavigation.WebNavigationFramedErrorCallbackDetails

/** A new tab or window created to host a navigation. */
export type NavigationTarget = chrome.webNavigation.WebNavigationSourceCallbackDetails

export type TabReplacement = chrome.webNavigation.WebNavigationReplacementCallbackDetails

/**
 * Chrome's webNavigation event filter: an event is delivered when its URL matches any of
 * the `url` conditions. Chrome ignores `schemes` and `ports` for these events.
 */
export type NavigationFilter = chrome.webNavigation.WebNavigationEventFilter

/** A webNavigation event, whose `addListener` takes an optional URL filter. */
export interface FilterableEvent<Args extends ReadonlyArray<unknown>> extends EventSource<Args> {
  addListener(listener: (...args: Args) => void, filter?: NavigationFilter): void
}

/** The Promise-based MV3 subset this module needs. */
export interface ChromeWebNavigationApi {
  getAllFrames(details: chrome.webNavigation.GetAllFrameDetails): Promise<Array<Frame> | null>
  getFrame(details: chrome.webNavigation.GetFrameDetails): Promise<FrameInfo | null>
  readonly onBeforeNavigate: FilterableEvent<[details: NavigationStart]>
  readonly onCommitted: FilterableEvent<[details: Navigation]>
  readonly onDOMContentLoaded: FilterableEvent<[details: DocumentLoad]>
  readonly onCompleted: FilterableEvent<[details: DocumentLoad]>
  readonly onErrorOccurred: FilterableEvent<[details: NavigationFailure]>
  readonly onCreatedNavigationTarget: FilterableEvent<[details: NavigationTarget]>
  readonly onReferenceFragmentUpdated: FilterableEvent<[details: Navigation]>
  readonly onHistoryStateUpdated: FilterableEvent<[details: Navigation]>
  readonly onTabReplaced: EventSource<[details: TabReplacement]>
}

/**
 * Observational subscriptions, like every stream in this library: listeners exist only
 * while the stream runs and cannot wake an MV3 service worker. Register wake listeners
 * synchronously through ChromeServiceWorker instead. Each subscription buffers at most
 * 64 events, dropping the oldest on overflow.
 */
export interface NavigationStreams {
  /** Fired before a navigation starts; it may still be cancelled or fail. */
  readonly onBeforeNavigate: Stream.Stream<NavigationStart, ChromeWebNavigationError>
  readonly onCommitted: Stream.Stream<Navigation, ChromeWebNavigationError>
  readonly onDOMContentLoaded: Stream.Stream<DocumentLoad, ChromeWebNavigationError>
  readonly onCompleted: Stream.Stream<DocumentLoad, ChromeWebNavigationError>
  /** Navigations aborted by a network error or by the user. */
  readonly onErrorOccurred: Stream.Stream<NavigationFailure, ChromeWebNavigationError>
  /** Matched against the URL opened in the new tab or window. */
  readonly onCreatedNavigationTarget: Stream.Stream<NavigationTarget, ChromeWebNavigationError>
  /** Same-document navigations that only change the URL's fragment. */
  readonly onReferenceFragmentUpdated: Stream.Stream<Navigation, ChromeWebNavigationError>
  /** Same-document navigations (pushState and friends) that change the frame's URL. */
  readonly onHistoryStateUpdated: Stream.Stream<Navigation, ChromeWebNavigationError>
}

export interface ChromeWebNavigationService extends NavigationStreams {
  /** Every frame of the tab, top frame (`frameId` 0) included. A closed or unknown tab has none. */
  readonly getAllFrames: (tabId: number) => Effect.Effect<Array<Frame>, ChromeWebNavigationError>
  /** One frame, or none when the tab, frame or document is unknown. */
  readonly getFrame: (details: chrome.webNavigation.GetFrameDetails) => Effect.Effect<Option.Option<FrameInfo>, ChromeWebNavigationError>
  /** A tab's contents replaced by another, usually prerendered, tab. Chrome takes no filter for it. */
  readonly onTabReplaced: Stream.Stream<TabReplacement, ChromeWebNavigationError>
  /**
   * The same streams, each registering its listener with `filter` so Chrome delivers only
   * matching URLs. Without a filter they equal the unfiltered properties.
   */
  readonly filtered: (filter?: NavigationFilter) => NavigationStreams
}

export class ChromeWebNavigation extends Context.Service<ChromeWebNavigation, ChromeWebNavigationService>()(
  "effect-platform-chrome/ChromeWebNavigation"
) {}

const invoke = invoker((operation, cause) => new ChromeWebNavigationError({ operation, cause }))

const eventError = (operation: string) => (cause: unknown) => new ChromeWebNavigationError({ operation, cause })

/** Chrome validates arguments, so an absent filter is never passed as `undefined`. */
const withFilter = <Args extends ReadonlyArray<unknown>>(
  event: FilterableEvent<Args>,
  filter: NavigationFilter | undefined
): EventSource<Args> => filter === undefined ? event : {
  addListener: (listener) => event.addListener(listener, filter),
  removeListener: (listener) => event.removeListener(listener)
}

const details = <A>(value: A): A => value

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeWebNavigationApi): ChromeWebNavigationService => {
  const streams = (filter?: NavigationFilter): NavigationStreams => ({
    onBeforeNavigate: observe(() => withFilter(api.onBeforeNavigate, filter), details, eventError("onBeforeNavigate")),
    onCommitted: observe(() => withFilter(api.onCommitted, filter), details, eventError("onCommitted")),
    onDOMContentLoaded: observe(() => withFilter(api.onDOMContentLoaded, filter), details, eventError("onDOMContentLoaded")),
    onCompleted: observe(() => withFilter(api.onCompleted, filter), details, eventError("onCompleted")),
    onErrorOccurred: observe(() => withFilter(api.onErrorOccurred, filter), details, eventError("onErrorOccurred")),
    onCreatedNavigationTarget: observe(
      () => withFilter(api.onCreatedNavigationTarget, filter), details, eventError("onCreatedNavigationTarget")
    ),
    onReferenceFragmentUpdated: observe(
      () => withFilter(api.onReferenceFragmentUpdated, filter), details, eventError("onReferenceFragmentUpdated")
    ),
    onHistoryStateUpdated: observe(() => withFilter(api.onHistoryStateUpdated, filter), details, eventError("onHistoryStateUpdated"))
  })

  return ChromeWebNavigation.of({
    getAllFrames: (tabId) => invoke("getAllFrames", () => api.getAllFrames({ tabId })).pipe(
      Effect.map((frames) => frames ?? [])
    ),
    getFrame: (frame) => invoke("getFrame", () => api.getFrame(frame)).pipe(Effect.map(Option.fromNullishOr)),
    ...streams(),
    onTabReplaced: observe(() => api.onTabReplaced, details, eventError("onTabReplaced")),
    filtered: streams
  })
}

export const layer = (api: ChromeWebNavigationApi): Layer.Layer<ChromeWebNavigation> =>
  Layer.succeed(ChromeWebNavigation, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeWebNavigation, ChromeWebNavigationError> = liveLayer(
  ChromeWebNavigation, "webNavigation", (chrome) => chrome.webNavigation, make,
  (cause) => new ChromeWebNavigationError({ operation: "initialize", cause })
)
