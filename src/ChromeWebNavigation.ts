import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeWebNavigationError extends Schema.TaggedError<ChromeWebNavigationError>()("ChromeWebNavigationError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** A frame as `getAllFrames` reports it, with its frame and process ids. */
export type Frame = chrome.webNavigation.GetAllFrameResultDetails

/** A frame as `getFrame` reports it: the same fields without `frameId` and `processId`. */
export type FrameInfo = chrome.webNavigation.GetFrameResultDetails

/**
 * Identifies one frame for `getFrame`: a `documentId`, or a `tabId` with a `frameId`. Ids
 * given alongside a `documentId` must match its document.
 */
export type FrameDetails = chrome.webNavigation.GetFrameDetails

/** A committed navigation, history-state update or fragment update, with its transition. */
export type Navigation = chrome.webNavigation.WebNavigationTransitionCallbackDetails

/**
 * A navigation that is about to start; it has no document yet, and Chrome reports
 * `processId` as -1 because no renderer has been chosen.
 */
export type NavigationStart = chrome.webNavigation.WebNavigationBaseCallbackDetails

/** A document that finished parsing (`onDOMContentLoaded`) or loading (`onCompleted`). */
export type DocumentLoad = chrome.webNavigation.WebNavigationFramedCallbackDetails

/** An aborted navigation; Chrome reports its deprecated `processId` as -1. */
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
  /** Resolves to no list (`null` in the typings, `undefined` in the docs) for an unknown tab. */
  getAllFrames(details: chrome.webNavigation.GetAllFrameDetails): Promise<Array<Frame> | null | undefined>
  getFrame(details: FrameDetails): Promise<FrameInfo | null | undefined>
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
 * The event streams are observational subscriptions that cannot wake an MV3 service worker;
 * register wake listeners through ChromeServiceWorker. Each buffers at most 64 events,
 * dropping the oldest. A `filter` is passed to Chrome only when one is given, and Chrome then
 * delivers only events whose URL matches it.
 */
export interface ChromeWebNavigationService {
  /**
   * Every frame of the tab, top frame (`frameId` 0) included; None when Chrome reports no
   * list because the tab is unknown or closed. Frames of a prerendered tab that has not been
   * swapped in cannot be listed.
   */
  readonly getAllFrames: (tabId: number) => Effect.Effect<Option.Option<Array<Frame>>, ChromeWebNavigationError>
  /** One frame; None when Chrome reports none for the tab, frame or document. */
  readonly getFrame: (details: FrameDetails) => Effect.Effect<Option.Option<FrameInfo>, ChromeWebNavigationError>
  /** Fired before a navigation starts; it may still be cancelled or fail. */
  readonly onBeforeNavigate: (filter?: NavigationFilter) => Stream.Stream<NavigationStart, ChromeWebNavigationError>
  /** Navigations Chrome has committed to; the document may still be loading. */
  readonly onCommitted: (filter?: NavigationFilter) => Stream.Stream<Navigation, ChromeWebNavigationError>
  /** Documents whose DOM is constructed; their resources may still be loading. */
  readonly onDOMContentLoaded: (filter?: NavigationFilter) => Stream.Stream<DocumentLoad, ChromeWebNavigationError>
  /** Documents that, with their resources, finished loading. */
  readonly onCompleted: (filter?: NavigationFilter) => Stream.Stream<DocumentLoad, ChromeWebNavigationError>
  /** Navigations aborted by a network error or by the user. */
  readonly onErrorOccurred: (filter?: NavigationFilter) => Stream.Stream<NavigationFailure, ChromeWebNavigationError>
  /** New tabs or windows hosting a navigation; the filter matches the URL opened in them. */
  readonly onCreatedNavigationTarget: (filter?: NavigationFilter) => Stream.Stream<NavigationTarget, ChromeWebNavigationError>
  /** Same-document navigations that only change the URL's fragment. */
  readonly onReferenceFragmentUpdated: (filter?: NavigationFilter) => Stream.Stream<Navigation, ChromeWebNavigationError>
  /** Same-document navigations (pushState and friends) that change the frame's URL. */
  readonly onHistoryStateUpdated: (filter?: NavigationFilter) => Stream.Stream<Navigation, ChromeWebNavigationError>
  /** A tab's contents replaced by another, usually prerendered, tab. Chrome takes no filter for it. */
  readonly onTabReplaced: Stream.Stream<TabReplacement, ChromeWebNavigationError>
}

export class ChromeWebNavigation extends Context.Service<ChromeWebNavigation, ChromeWebNavigationService>()(
  "effect-platform-chrome/ChromeWebNavigation"
) {}

const invoke = invoker((operation, cause) => new ChromeWebNavigationError({ operation, cause }))

const eventError = (operation: string) => (cause: unknown) => new ChromeWebNavigationError({ operation, cause })

/** Binds an optional filter, so Chrome never receives an explicit undefined. */
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
  const filterable = <A>(operation: string, getEvent: () => FilterableEvent<[A]>) =>
    (filter?: NavigationFilter): Stream.Stream<A, ChromeWebNavigationError> =>
      observe(() => withFilter(getEvent(), filter), details<A>, eventError(operation))

  return ChromeWebNavigation.of({
    getAllFrames: (tabId) => invoke("getAllFrames", () => api.getAllFrames({ tabId })).pipe(Effect.map(Option.fromNullishOr)),
    getFrame: (frame) => invoke("getFrame", () => api.getFrame(frame)).pipe(Effect.map(Option.fromNullishOr)),
    onBeforeNavigate: filterable("onBeforeNavigate", () => api.onBeforeNavigate),
    onCommitted: filterable("onCommitted", () => api.onCommitted),
    onDOMContentLoaded: filterable("onDOMContentLoaded", () => api.onDOMContentLoaded),
    onCompleted: filterable("onCompleted", () => api.onCompleted),
    onErrorOccurred: filterable("onErrorOccurred", () => api.onErrorOccurred),
    onCreatedNavigationTarget: filterable("onCreatedNavigationTarget", () => api.onCreatedNavigationTarget),
    onReferenceFragmentUpdated: filterable("onReferenceFragmentUpdated", () => api.onReferenceFragmentUpdated),
    onHistoryStateUpdated: filterable("onHistoryStateUpdated", () => api.onHistoryStateUpdated),
    onTabReplaced: observe(() => api.onTabReplaced, details, eventError("onTabReplaced"))
  })
}

export const layer = (api: ChromeWebNavigationApi): Layer.Layer<ChromeWebNavigation> =>
  Layer.succeed(ChromeWebNavigation, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeWebNavigation, ChromeWebNavigationError> = liveLayer(
  ChromeWebNavigation, "webNavigation", (chrome) => chrome.webNavigation, make,
  (cause) => new ChromeWebNavigationError({ operation: "initialize", cause })
)
