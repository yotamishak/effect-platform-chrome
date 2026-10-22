import { Context, Effect, Layer, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeSessionsError extends Schema.TaggedError<ChromeSessionsError>()("ChromeSessionsError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** A closed tab or window; restore it by its `tab.sessionId` or `window.sessionId`. */
export type Session = chrome.sessions.Session

export type Device = chrome.sessions.Device

export type Filter = chrome.sessions.Filter

/** The most entries `getRecentlyClosed` and `getDevices` return, mirroring `chrome.sessions.MAX_SESSION_RESULTS`. */
export const MAX_SESSION_RESULTS: typeof chrome.sessions.MAX_SESSION_RESULTS = 25

/** The Promise-based MV3 subset this module needs. */
export interface ChromeSessionsApi {
  getRecentlyClosed(filter?: Filter): Promise<Array<Session>>
  getDevices(filter?: Filter): Promise<Array<Device>>
  restore(sessionId?: string): Promise<Session>
  readonly onChanged: EventSource<[]>
}

export interface ChromeSessionsService {
  /**
   * Recently closed tabs and windows, most recent first, at most `MAX_SESSION_RESULTS`.
   * Requires the `sessions` permission, as does every call here; tab URLs and titles also
   * need `tabs` or matching host permissions.
   */
  readonly getRecentlyClosed: (filter?: Filter) => Effect.Effect<Array<Session>, ChromeSessionsError>
  /** Other synced devices and their open sessions. */
  readonly getDevices: (filter?: Filter) => Effect.Effect<Array<Device>, ChromeSessionsError>
  /** Reopens a closed tab or window, or the most recently closed one when no id is given. */
  readonly restore: (sessionId?: string) => Effect.Effect<Session, ChromeSessionsError>
  /**
   * Recently closed tabs or windows changed. Observational: it cannot wake an MV3 service
   * worker (use ChromeServiceWorker for that) and buffers at most 64 events, dropping the oldest.
   */
  readonly onChanged: Stream.Stream<void, ChromeSessionsError>
}

export class ChromeSessions extends Context.Service<ChromeSessions, ChromeSessionsService>()("effect-platform-chrome/ChromeSessions") {}

const invoke = invoker((operation, cause) => new ChromeSessionsError({ operation, cause }))

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeSessionsApi): ChromeSessionsService => ChromeSessions.of({
  // Chrome validates arguments, so absent options are not passed as undefined.
  getRecentlyClosed: (filter) => invoke("getRecentlyClosed", () => filter === undefined
    ? api.getRecentlyClosed()
    : api.getRecentlyClosed(filter)),
  getDevices: (filter) => invoke("getDevices", () => filter === undefined ? api.getDevices() : api.getDevices(filter)),
  restore: (sessionId) => invoke("restore", () => sessionId === undefined ? api.restore() : api.restore(sessionId)),
  onChanged: observe(() => api.onChanged, () => undefined, (cause) => new ChromeSessionsError({ operation: "onChanged", cause }))
})

export const layer = (api: ChromeSessionsApi): Layer.Layer<ChromeSessions> => Layer.succeed(ChromeSessions, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeSessions, ChromeSessionsError> = liveLayer(
  ChromeSessions, "sessions", (chrome) => chrome.sessions, make,
  (cause) => new ChromeSessionsError({ operation: "initialize", cause })
)
