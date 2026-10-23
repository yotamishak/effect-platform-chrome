import { Context, Effect, Exit, Layer, Schema, Scope, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeTabCaptureError extends Schema.TaggedError<ChromeTabCaptureError>()("ChromeTabCaptureError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** A tab's capture status: `pending` and `active` captures block a new capture of that tab. */
export type CaptureStatus = `${chrome.tabCapture.TabCaptureState}`

export type CaptureInfo = chrome.tabCapture.CaptureInfo

export type MediaStreamOptions = chrome.tabCapture.GetMediaStreamOptions

/** Which tracks `capture` requests, with optional `getUserMedia`-style constraints. */
export type CaptureOptions = chrome.tabCapture.CaptureOptions

/**
 * The MV3 subset this module needs. `getMediaStreamId` and `getCapturedTabs` are
 * Promise-based from Chrome 116. `capture` is callback-only and foreground only: Chrome
 * defines it in extension pages (popup, side panel, options, extension tabs) but not in the
 * service worker or an offscreen document, so it is optional, and calling it where it is
 * absent fails with the typed error. It reports failure as a `null` stream with `lastError`
 * set only while its callback runs, so `lastError` is part of this interface rather than
 * read from a global; an API without it still works, with a generic cause.
 */
export interface ChromeTabCaptureApi {
  getMediaStreamId(options?: MediaStreamOptions): Promise<string>
  getCapturedTabs(): Promise<Array<CaptureInfo>>
  readonly onStatusChanged: EventSource<[info: CaptureInfo]>
  readonly capture?: ((options: CaptureOptions, callback: (stream: MediaStream | null) => void) => void) | undefined
  /** `chrome.runtime.lastError`, read inside `capture`'s callback. */
  readonly lastError?: chrome.runtime.LastError | undefined
}

export interface ChromeTabCaptureService {
  /**
   * Creates a stream id for `targetTabId` (default: the active tab of the last active
   * window). The target needs the extension's `activeTab` grant, which a user invocation
   * such as an action click gives, and must not be captured already. Callable from the
   * service worker. Redeem the id once, within a few seconds, with
   * `navigator.mediaDevices.getUserMedia` using
   * `{ mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: id } }`: without
   * `consumerTabId` in a frame of this extension's process (an offscreen document or
   * extension page), with it in a frame of that tab whose origin is secure. The options are
   * passed to Chrome only when given.
   */
  readonly getMediaStreamId: (options?: MediaStreamOptions) => Effect.Effect<string, ChromeTabCaptureError>
  /** This extension's tabs whose capture is `pending` or `active`; `stopped` and `error` ones are left out. */
  readonly getCapturedTabs: Effect.Effect<Array<CaptureInfo>, ChromeTabCaptureError>
  /**
   * Captures the visible area of the current window's active tab for the life of the scope,
   * stopping every track of the stream when the scope closes, which ends the capture.
   * Foreground only: available in extension pages but not in the service worker, where
   * `getMediaStreamId` is the way to capture. The tab needs the extension's `activeTab`
   * grant from a user invocation, must not be captured already, and `options` must request
   * `audio` or `video`. While the tab's audio is captured it stops playing to the user.
   * Interrupting the wait, or closing the scope first, stops a stream Chrome delivers later;
   * an already closed scope fails without calling Chrome, and a failed attempt leaves no
   * finalizer in the scope.
   */
  readonly capture: (options: CaptureOptions) => Effect.Effect<MediaStream, ChromeTabCaptureError, Scope.Scope>
  /**
   * Observational capture status changes; this subscription cannot wake an MV3 service
   * worker (use ChromeServiceWorker.listen). Buffers at most 64 events, dropping the oldest.
   */
  readonly onStatusChanged: Stream.Stream<CaptureInfo, ChromeTabCaptureError>
}

export class ChromeTabCapture extends Context.Service<ChromeTabCapture, ChromeTabCaptureService>()(
  "effect-platform-chrome/ChromeTabCapture"
) {}

const fail = (operation: string) => (cause: unknown) => new ChromeTabCaptureError({ operation, cause })

const scopeClosed = () => fail("capture")(new Error("The capture's scope closed before Chrome delivered the stream"))

const invoke = invoker((operation, cause) => new ChromeTabCaptureError({ operation, cause }))

/** Ends the capture: Chrome stops capturing a tab once every track of its stream has stopped. */
const stopTracks = (stream: MediaStream): void => {
  for (const track of stream.getTracks()) track.stop()
}

/**
 * Bridges the callback-only `capture`. The stream is owned from the moment Chrome delivers
 * it, before the fiber resumes, so it is stopped exactly when the scope closes, when the wait
 * fails or is interrupted (including after delivery but before the fiber takes it), or at
 * once when it arrives after that. A repeated callback cannot leak a second stream. The
 * release lives in a child of the caller's scope that a failed wait closes, so failed
 * attempts in a long-lived scope (a retry loop) leave nothing behind, and a scope that is
 * already closed never starts a capture in Chrome.
 */
const captureStream = (
  api: ChromeTabCaptureApi,
  options: CaptureOptions
): Effect.Effect<MediaStream, ChromeTabCaptureError, Scope.Scope> => Effect.suspend(() => {
  let released = false
  let owned: MediaStream | null = null

  const release = () => {
    released = true

    if (owned !== null) {
      const stream = owned
      owned = null
      stopTracks(stream)
    }
  }

  const wait = Effect.callback<MediaStream, ChromeTabCaptureError>((resume) => {
    let called = false

    if (api.capture === undefined) {
      resume(Effect.fail(fail("capture")(new Error("chrome.tabCapture.capture is unavailable in this context; it is foreground only"))))

      return
    }

    if (released) {
      resume(Effect.fail(scopeClosed()))

      return
    }

    try {
      api.capture(options, (stream) => {
        // Chrome only exposes lastError for the duration of this callback.
        const lastError = api.lastError

        if (stream !== null) {
          if (called || released) stopTracks(stream)
          else owned = stream
        }

        if (called) return

        called = true

        if (released) {
          resume(Effect.fail(scopeClosed()))
        } else if (lastError !== undefined) {
          // Any stream delivered alongside the error is stopped by the failure's release.
          resume(Effect.fail(fail("capture")(lastError)))
        } else if (stream === null) {
          resume(Effect.fail(fail("capture")(new Error("chrome.tabCapture.capture delivered no stream"))))
        } else {
          resume(Effect.succeed(stream))
        }
      })
    } catch (cause) {
      resume(Effect.fail(fail("capture")(cause)))
    }
  })

  return Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
    // A closed scope yields a closed child, whose finalizer runs (and releases) at once.
    const owner = yield* Scope.fork(yield* Effect.scope)
    yield* Scope.addFinalizer(owner, Effect.sync(release))

    return yield* Effect.onError(restore(wait), (cause) => Scope.close(owner, Exit.failCause(cause)))
  }))
})

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeTabCaptureApi): ChromeTabCaptureService => ChromeTabCapture.of({
  getMediaStreamId: (options) => invoke("getMediaStreamId", () => options === undefined
    ? api.getMediaStreamId()
    : api.getMediaStreamId(options)),
  getCapturedTabs: invoke("getCapturedTabs", () => api.getCapturedTabs()),
  capture: (options) => captureStream(api, options),
  onStatusChanged: observe(() => api.onStatusChanged, (info) => info, fail("onStatusChanged"))
})

export const layer = (api: ChromeTabCaptureApi): Layer.Layer<ChromeTabCapture> =>
  Layer.succeed(ChromeTabCapture, make(api))

/** Joins `chrome.tabCapture` with a live view of `chrome.runtime.lastError`. */
const fromChrome = (chrome: typeof globalThis.chrome): ChromeTabCaptureApi | undefined => {
  // The typings declare these members, but they are absent without the permission, in the
  // service worker (`capture`), or outside extensions.
  const tabCapture: typeof chrome.tabCapture | undefined = chrome.tabCapture

  if (tabCapture === undefined) return undefined

  const runtime: typeof chrome.runtime | undefined = chrome.runtime
  const capture: typeof chrome.tabCapture.capture | undefined = tabCapture.capture

  return {
    getMediaStreamId: (options) => options === undefined
      ? tabCapture.getMediaStreamId()
      : tabCapture.getMediaStreamId(options),
    getCapturedTabs: () => tabCapture.getCapturedTabs(),
    get onStatusChanged() { return tabCapture.onStatusChanged },
    capture: capture === undefined ? undefined : (options, callback) => tabCapture.capture(options, callback),
    get lastError() { return runtime?.lastError }
  }
}

/** The globals are read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeTabCapture, ChromeTabCaptureError> = liveLayer(
  ChromeTabCapture, "tabCapture", fromChrome, make,
  (cause) => new ChromeTabCaptureError({ operation: "initialize", cause })
)
