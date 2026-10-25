import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeSessionsError extends Schema.TaggedError<ChromeSessionsError>()("ChromeSessionsError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/**
 * A closed (or synced) tab or window: exactly one of `tab` and `window` is set. Its
 * `sessionId` (`tab.sessionId` or `window.sessionId`, see `sessionIdOf`) is what `restore`
 * takes. `lastModified` is in seconds since the epoch, not milliseconds. Tab URLs, titles
 * and favicons are only present with the `tabs` permission or matching host permissions.
 */
export type Session = chrome.sessions.Session

/** Another signed-in device with tab sync; its `sessions` are windows, most recently modified first. */
export type Device = chrome.sessions.Device

/** `maxResults` is an integer from 0 to `MAX_SESSION_RESULTS`; Chrome rejects anything else. */
export type Filter = chrome.sessions.Filter

/** The most entries `getRecentlyClosed` returns, and the most sessions `getDevices` lists per device. */
export const MAX_SESSION_RESULTS: typeof chrome.sessions.MAX_SESSION_RESULTS = 25

/** The id `restore` takes for this session: its tab's or window's `sessionId`, if Chrome reported one. */
export const sessionIdOf = (session: Session): Option.Option<string> =>
  Option.fromNullishOr(session.tab?.sessionId ?? session.window?.sessionId)

/** The Promise-based MV3 subset this module needs. */
export interface ChromeSessionsApi {
  getRecentlyClosed(filter?: Filter): Promise<Array<Session>>
  getDevices(filter?: Filter): Promise<Array<Device>>
  restore(sessionId?: string): Promise<Session>
  readonly onChanged: EventSource<[]>
}

/**
 * Every call needs the `sessions` permission. Each passes its optional argument to Chrome only
 * when given; a rejection or synchronous throw (such as an out-of-range `maxResults`, which
 * Chrome's bindings refuse before calling) fails with `ChromeSessionsError` naming the method.
 */
export interface ChromeSessionsService {
  /**
   * Recently closed tabs and windows, most recently closed first, at most `filter.maxResults`
   * (default and maximum `MAX_SESSION_RESULTS`). A closed tab group is listed as its tabs.
   * Closed windows list their tabs; any of those tabs' `sessionId`s can be restored on its own.
   * Chrome reports a closed tab as inactive and a closed window as a normal, unfocused window
   * without bounds, whatever it was; `restore` reopens it as it really was.
   */
  readonly getRecentlyClosed: (filter?: Filter) => Effect.Effect<Array<Session>, ChromeSessionsError>
  /**
   * Devices with synced sessions, most recently active first, or none when tab sync is off.
   * `filter.maxResults` bounds the window sessions listed per device, not the number of devices.
   */
  readonly getDevices: (filter?: Filter) => Effect.Effect<Array<Device>, ChromeSessionsError>
  /**
   * Reopens a closed tab or window by its `sessionId`, or the most recently closed entry when no
   * id is given; a synced device's session id reopens that tab or window here and leaves the
   * device's list unchanged. Resolves to the session describing the live tab or window, whose
   * `lastModified` is the restore time. Chrome parses the id as an integer (or a device tag, `.`
   * and an integer), so `"007"` names entry `7`. It fails with "There are no recently closed
   * sessions." when nothing is closed, `Invalid session id: "<id>".` for an unknown id, and also
   * in incognito contexts and when synced sessions are unavailable. Interrupting the effect does
   * not undo a restore Chrome has started; only its result is discarded.
   */
  readonly restore: (sessionId?: string) => Effect.Effect<Session, ChromeSessionsError>
  /**
   * The recently closed list changed: an entry was added, restored, evicted or cleared. One
   * change can fire it more than once (Chrome fires twice when it restores an entry), so treat it
   * as a cue to re-read `getRecentlyClosed`, not a count. Synced device changes do not fire it.
   * Observational: it cannot wake an MV3 service worker (use
   * ChromeServiceWorker for that), and each consumption owns one listener and buffers at most
   * 64 events, dropping the oldest.
   */
  readonly onChanged: Stream.Stream<void, ChromeSessionsError>
}

export class ChromeSessions extends Context.Service<ChromeSessions, ChromeSessionsService>()("effect-platform-chrome/ChromeSessions") {}

const invoke = invoker((operation, cause) => new ChromeSessionsError({ operation, cause }))

/** Calls a Chrome method whose only argument is optional, omitting it when absent. */
const withOptional = <I, A>(operation: string, call: (...input: [] | [I]) => Promise<A>) =>
  (input?: I): Effect.Effect<A, ChromeSessionsError> =>
    invoke(operation, () => input === undefined ? call() : call(input))

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeSessionsApi): ChromeSessionsService => ChromeSessions.of({
  getRecentlyClosed: withOptional("getRecentlyClosed", (...args: [] | [Filter]) => api.getRecentlyClosed(...args)),
  getDevices: withOptional("getDevices", (...args: [] | [Filter]) => api.getDevices(...args)),
  restore: withOptional("restore", (...args: [] | [string]) => api.restore(...args)),
  onChanged: observe(() => api.onChanged, () => undefined, (cause) => new ChromeSessionsError({ operation: "onChanged", cause }))
})

export const layer = (api: ChromeSessionsApi): Layer.Layer<ChromeSessions> => Layer.succeed(ChromeSessions, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeSessions, ChromeSessionsError> = liveLayer(
  ChromeSessions, "sessions", (chrome) => chrome.sessions, make,
  (cause) => new ChromeSessionsError({ operation: "initialize", cause })
)
