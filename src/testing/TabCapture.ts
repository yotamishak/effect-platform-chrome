import * as ChromeTabCapture from "../ChromeTabCapture.js"
import * as TestEvent from "./Event.js"

type CaptureInfo = ChromeTabCapture.CaptureInfo

/** The part of a `MediaStreamTrack` the simulated streams implement. */
export interface CaptureTrack {
  readonly id: string
  readonly kind: string
  readonly readyState: MediaStreamTrackState
  stop(): void
}

/** The part of a `MediaStream` the simulated streams implement. */
export interface CaptureStream {
  readonly id: string
  readonly active: boolean
  getTracks(): Array<CaptureTrack>
  getAudioTracks(): Array<CaptureTrack>
  getVideoTracks(): Array<CaptureTrack>
}

/** The tracks a simulated stream carries. */
export interface CaptureKinds {
  readonly audio?: boolean | undefined
  readonly video?: boolean | undefined
}

/**
 * A simulated capture stream with live `<id>-audio` and `<id>-video` tracks as `kinds` asks.
 * `stop` ends a track once; `onEnded` runs once, when the last live track stops.
 */
export const makeCaptureStream = (id: string, kinds: CaptureKinds, onEnded: () => void = () => {}): CaptureStream => {
  const tracks: Array<CaptureTrack> = []

  const makeTrack = (kind: "audio" | "video"): CaptureTrack => {
    let readyState: MediaStreamTrackState = "live"

    return {
      id: `${id}-${kind}`,
      kind,
      get readyState() { return readyState },
      stop: () => {
        if (readyState === "ended") return

        readyState = "ended"

        if (tracks.every((track) => track.readyState === "ended")) onEnded()
      }
    }
  }

  if (kinds.audio === true) tracks.push(makeTrack("audio"))

  if (kinds.video === true) tracks.push(makeTrack("video"))

  return {
    id,
    get active() { return tracks.some((track) => track.readyState === "live") },
    getTracks: () => Array.from(tracks),
    getAudioTracks: () => tracks.filter((track) => track.kind === "audio"),
    getVideoTracks: () => tracks.filter((track) => track.kind === "video")
  }
}

/** Hands a simulated stream to code typed against the DOM `MediaStream`. */
export const asMediaStream = (stream: CaptureStream): MediaStream =>
  // SAFETY: the simulated stream implements the MediaStream members tab capture consumers
  // use here (`id`, `active`, the track getters and `MediaStreamTrack.stop`); code that needs
  // more, such as events or `clone`, must be given a fuller stream through `overrides`.
  stream as MediaStream

/** Chrome's messages for the failures the fixture reproduces. */
export const tabCaptureErrors = {
  findingTab: "Error finding tab to capture.",
  grant: "Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.",
  invalidTab: "Invalid tab specified.",
  insecureConsumer: "URL scheme for the specified tab is not secure.",
  sameTab: "Cannot capture a tab with an active stream.",
  noAudioOrVideo: "Capture failed. No audio or video requested."
} as const

interface CaptureOutcome {
  readonly stream: CaptureStream | null
  readonly error: string | undefined
}

interface Capture {
  info: CaptureInfo
  stream: CaptureStream | undefined
}

/**
 * An in-memory `chrome.tabCapture` for one window. Tab 1 is open, secure and active; no tab
 * has the `activeTab` grant until `controls.invoke` gives it, as an action click would, and
 * `controls.navigate` withdraws it again (a running capture survives navigation).
 *
 * `getMediaStreamId` and `capture` check, in Chrome's order, that the target tab exists
 * (`targetTabId`, default the active tab), holds the grant and is not already captured
 * (`pending` or `active`). `getMediaStreamId` also checks that a `consumerTabId` exists and
 * is secure, then registers a `pending` capture and returns `tab-capture-stream-<n>`;
 * `controls.redeem` plays `getUserMedia`, turning it `active`, and `controls.expire` lets an
 * unused id lapse. `capture` targets the active tab and also needs `audio` or `video`; it
 * starts the capture at once (`pending`, then `active`) and calls back in a microtask with
 * the stream, or with `null` and `lastError` set only while the callback runs. A capture ends
 * with `stopped` once every track of its stream stops, or through `controls.stop`,
 * `controls.closeTab` and `controls.fail` (`error`), which end its tracks too. Every status
 * change fires onStatusChanged; controls return the exceptions listeners threw. Pass
 * `overrides` to replace any API member.
 */
export const makeTabCapture = (overrides: Partial<ChromeTabCapture.ChromeTabCaptureApi> = {}) => {
  const statusChanged = TestEvent.makeEvent<[CaptureInfo]>()
  const tabs = new Map<number, { readonly secure: boolean }>([[1, { secure: true }]])
  const granted = new Set<number>()
  const captures = new Map<number, Capture>()
  const unredeemed = new Map<string, number>()
  let activeTabId: number | undefined = 1
  let lastError: chrome.runtime.LastError | undefined
  let nextStreamId = 1
  let nextMedia = 1

  const emit = (info: CaptureInfo) => statusChanged.controls.emit({ ...info })

  const setStatus = (tabId: number, status: ChromeTabCapture.CaptureStatus): ReadonlyArray<unknown> => {
    const capture = captures.get(tabId)

    if (capture === undefined) return []

    capture.info = { ...capture.info, status }

    if (status === "stopped" || status === "error") {
      captures.delete(tabId)

      for (const [id, owner] of unredeemed) if (owner === tabId) unredeemed.delete(id)
    }

    return emit(capture.info)
  }

  const end = (tabId: number, status: "stopped" | "error"): ReadonlyArray<unknown> => {
    const capture = captures.get(tabId)

    if (capture === undefined) throw new Error(`Tab ${tabId} is not being captured`)

    const errors = setStatus(tabId, status)

    // The tracks end with the capture; it is already gone, so they report nothing more.
    for (const track of capture.stream?.getTracks() ?? []) track.stop()

    return errors
  }

  const streamFor = (tabId: number, kinds: CaptureKinds): CaptureStream => {
    const stream: CaptureStream = makeCaptureStream(`tab-capture-media-${nextMedia++}`, kinds, () => {
      if (captures.get(tabId)?.stream === stream) setStatus(tabId, "stopped")
    })

    return stream
  }

  const checkTarget = (targetTabId: number | undefined): number => {
    if (targetTabId !== undefined && !tabs.has(targetTabId)) throw new Error(tabCaptureErrors.invalidTab)

    const tabId = targetTabId ?? activeTabId

    if (tabId === undefined) throw new Error(tabCaptureErrors.findingTab)

    if (!granted.has(tabId)) throw new Error(tabCaptureErrors.grant)

    return tabId
  }

  const checkFree = (tabId: number): void => {
    if (captures.has(tabId)) throw new Error(tabCaptureErrors.sameTab)
  }

  const register = (tabId: number): void => {
    const info: CaptureInfo = { tabId, status: "pending", fullscreen: false }
    captures.set(tabId, { info, stream: undefined })
    emit(info)
  }

  const activate = (tabId: number, stream: CaptureStream) => {
    const capture = captures.get(tabId)

    if (capture === undefined) return

    capture.stream = stream
    setStatus(tabId, "active")
  }

  /** Runs `capture`'s checks and starts the capture, or reports the error Chrome would. */
  const startCapture = (options: ChromeTabCapture.CaptureOptions): CaptureOutcome => {
    try {
      const tabId = checkTarget(undefined)

      if (options.audio !== true && options.video !== true) throw new Error(tabCaptureErrors.noAudioOrVideo)

      checkFree(tabId)
      register(tabId)
      const stream = streamFor(tabId, options)
      activate(tabId, stream)

      return { stream, error: undefined }
    } catch (cause) {
      return { stream: null, error: cause instanceof Error ? cause.message : String(cause) }
    }
  }

  const api: ChromeTabCapture.ChromeTabCaptureApi = {
    getMediaStreamId: async (options = {}) => {
      const tabId = checkTarget(options.targetTabId)

      if (options.consumerTabId !== undefined) {
        const consumer = tabs.get(options.consumerTabId)

        if (consumer === undefined) throw new Error(tabCaptureErrors.invalidTab)

        if (!consumer.secure) throw new Error(tabCaptureErrors.insecureConsumer)
      }

      checkFree(tabId)
      register(tabId)
      const id = `tab-capture-stream-${nextStreamId++}`
      unredeemed.set(id, tabId)

      return id
    },
    getCapturedTabs: async () => Array.from(captures.values(), (capture) => ({ ...capture.info })),
    onStatusChanged: statusChanged.api,
    capture: (options, callback) => {
      const outcome = startCapture(options)

      queueMicrotask(() => {
        lastError = outcome.error === undefined ? undefined : { message: outcome.error }

        try {
          callback(outcome.stream === null ? null : asMediaStream(outcome.stream))
        } finally {
          lastError = undefined
        }
      })
    },
    get lastError() { return lastError },
    ...overrides
  }

  return {
    api,
    layer: ChromeTabCapture.layer(api),
    controls: {
      /** Captures that are `pending` or `active`, in the order they were requested. */
      captures: (): Array<CaptureInfo> => Array.from(captures.values(), (capture) => ({ ...capture.info })),
      /** The stream of a tab's running capture, once `capture` or `redeem` produced one. */
      stream: (tabId: number): CaptureStream | undefined => captures.get(tabId)?.stream,
      /** Whether the extension holds the `activeTab` grant for a tab. */
      isGranted: (tabId: number): boolean => granted.has(tabId),
      /** Opens a tab; `secure` (default true) decides whether it may consume a stream id. */
      openTab: (tabId: number, secure = true): void => { tabs.set(tabId, { secure }) },
      /** Closes a tab, ending its capture and its grant; no tab is active after closing the active one. */
      closeTab: (tabId: number): ReadonlyArray<unknown> => {
        tabs.delete(tabId)
        granted.delete(tabId)

        if (activeTabId === tabId) activeTabId = undefined

        return captures.has(tabId) ? end(tabId, "stopped") : []
      },
      /** Makes an open tab the active one, or leaves no tab active. */
      setActiveTab: (tabId: number | undefined): void => {
        if (tabId !== undefined && !tabs.has(tabId)) throw new Error(`Tab ${tabId} is not open`)

        activeTabId = tabId
      },
      /** The user invokes the extension on a tab (default: the active one), granting `activeTab`. */
      invoke: (tabId = activeTabId): void => {
        if (tabId === undefined || !tabs.has(tabId)) throw new Error("No open tab to invoke the extension on")

        granted.add(tabId)
      },
      /** A navigation withdraws the tab's `activeTab` grant; a running capture continues. */
      navigate: (tabId: number): void => { granted.delete(tabId) },
      /**
       * Plays `getUserMedia` with an unused stream id: the capture turns `active` and its
       * stream is returned, with a video track and, when `audio` is true, an audio track.
       */
      redeem: (streamId: string, audio = false): CaptureStream => {
        const tabId = unredeemed.get(streamId)

        if (tabId === undefined) throw new Error(`Stream id ${streamId} is unknown, used or expired`)

        unredeemed.delete(streamId)
        const stream = streamFor(tabId, { audio, video: true })
        activate(tabId, stream)

        return stream
      },
      /** An unused stream id lapses, as Chrome lets one after a few seconds: its capture stops. */
      expire: (streamId: string): ReadonlyArray<unknown> => {
        const tabId = unredeemed.get(streamId)

        if (tabId === undefined) throw new Error(`Stream id ${streamId} is unknown, used or expired`)

        return end(tabId, "stopped")
      },
      /** The capture ends from outside the extension. */
      stop: (tabId: number): ReadonlyArray<unknown> => end(tabId, "stopped"),
      /** The capture fails. */
      fail: (tabId: number): ReadonlyArray<unknown> => end(tabId, "error"),
      /** An element in the captured tab enters or leaves fullscreen; nothing fires when unchanged. */
      setFullscreen: (tabId: number, fullscreen: boolean): ReadonlyArray<unknown> => {
        const capture = captures.get(tabId)

        if (capture === undefined) throw new Error(`Tab ${tabId} is not being captured`)

        if (capture.info.fullscreen === fullscreen) return []

        capture.info = { ...capture.info, fullscreen }

        return emit(capture.info)
      },
      onStatusChanged: statusChanged.controls
    }
  }
}
