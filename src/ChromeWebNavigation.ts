import { Context, Effect, Layer, Option, Queue, Schema, Stream } from "effect"

export class ChromeWebNavigationError extends Schema.TaggedError<ChromeWebNavigationError>()("ChromeWebNavigationError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

export type Frame = chrome.webNavigation.GetAllFrameResultDetails

export type FrameInfo = chrome.webNavigation.GetFrameResultDetails

export type Navigation = chrome.webNavigation.WebNavigationTransitionCallbackDetails

interface NavigationEvent {
  addListener(listener: (details: Navigation) => void): void
  removeListener(listener: (details: Navigation) => void): void
}

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

const invoke = <A>(operation: string, run: () => Promise<A>): Effect.Effect<A, ChromeWebNavigationError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ChromeWebNavigationError({ operation, cause })
  })

const observe = (operation: string, getSource: () => NavigationEvent): Stream.Stream<Navigation, ChromeWebNavigationError> =>
  Stream.callback<Navigation, ChromeWebNavigationError>((queue) => {
    const listener = (details: Navigation) => { Queue.offerUnsafe(queue, details) }

    return Effect.gen(function*() {
      const source = yield* Effect.try({
        try: getSource,
        catch: (cause) => new ChromeWebNavigationError({ operation, cause })
      })

      // Install cleanup before registration, which may partially succeed then throw.
      yield* Effect.acquireRelease(
        Effect.succeed(listener),
        () => Effect.sync(() => source.removeListener(listener))
      )
      yield* Effect.try({
        try: () => source.addListener(listener),
        catch: (cause) => new ChromeWebNavigationError({ operation, cause })
      })
    })
  }, { bufferSize: 64, strategy: "sliding" })

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeWebNavigationApi): ChromeWebNavigationService => ChromeWebNavigation.of({
  getAllFrames: (tabId) => invoke("getAllFrames", () => api.getAllFrames({ tabId })).pipe(
    Effect.map((frames) => frames ?? [])
  ),
  getFrame: (details) => invoke("getFrame", () => api.getFrame(details)).pipe(Effect.map(Option.fromNullishOr)),
  onCommitted: observe("onCommitted", () => api.onCommitted),
  onHistoryStateUpdated: observe("onHistoryStateUpdated", () => api.onHistoryStateUpdated)
})

export const layer = (api: ChromeWebNavigationApi): Layer.Layer<ChromeWebNavigation> =>
  Layer.succeed(ChromeWebNavigation, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeWebNavigation, ChromeWebNavigationError> = Layer.effect(ChromeWebNavigation, Effect.try({
  try: () => {
    const api = typeof chrome === "undefined" ? undefined : chrome.webNavigation

    if (api === undefined) {
      throw new Error("chrome.webNavigation is unavailable in this context")
    }

    return make(api)
  },
  catch: (cause) => new ChromeWebNavigationError({ operation: "initialize", cause })
}))
