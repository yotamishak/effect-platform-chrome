import { Context, Effect, Layer, Schema, Stream } from "effect"
import { attempter, invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeIdleError extends Schema.TaggedError<ChromeIdleError>()("ChromeIdleError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** `"active"`, `"idle"` or `"locked"`. */
export type IdleState = `${chrome.idle.IdleState}`

/** The Promise-based MV3 subset this module needs; `setDetectionInterval` is synchronous in Chrome. */
export interface ChromeIdleApi {
  queryState(detectionIntervalInSeconds: number): Promise<IdleState>
  setDetectionInterval(intervalInSeconds: number): void
  getAutoLockDelay(): Promise<number>
  readonly onStateChanged: EventSource<[newState: IdleState]>
}

export interface ChromeIdleService {
  /**
   * `"locked"` when the screen is locked, `"idle"` when there was no input for the given
   * number of seconds (Chrome's minimum is 15), and `"active"` otherwise.
   */
  readonly queryState: (detectionIntervalInSeconds: number) => Effect.Effect<IdleState, ChromeIdleError>
  /**
   * Sets the threshold behind `onStateChanged`'s `"idle"` (default 60 seconds, minimum 15).
   * The setting is extension-wide, not per subscription.
   */
  readonly setDetectionInterval: (intervalInSeconds: number) => Effect.Effect<void, ChromeIdleError>
  /**
   * Seconds until the screen locks automatically while idle, 0 when it never does.
   * ChromeOS only: elsewhere Chrome lacks the function and this fails with the typed error.
   */
  readonly getAutoLockDelay: Effect.Effect<number, ChromeIdleError>
  /**
   * An observational subscription that cannot wake an MV3 service worker; register wake
   * listeners synchronously through `ChromeServiceWorker.listen` instead. Buffers at most
   * 64 events, dropping the oldest.
   */
  readonly onStateChanged: Stream.Stream<IdleState, ChromeIdleError>
}

export class ChromeIdle extends Context.Service<ChromeIdle, ChromeIdleService>()("effect-platform-chrome/ChromeIdle") {}

const toError = (operation: string, cause: unknown) => new ChromeIdleError({ operation, cause })

const invoke = invoker(toError)

const attempt = attempter(toError)

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeIdleApi): ChromeIdleService => ChromeIdle.of({
  queryState: (detectionIntervalInSeconds) => invoke("queryState", () => api.queryState(detectionIntervalInSeconds)),
  setDetectionInterval: (intervalInSeconds) => attempt("setDetectionInterval", () => api.setDetectionInterval(intervalInSeconds)),
  getAutoLockDelay: invoke("getAutoLockDelay", () => api.getAutoLockDelay()),
  onStateChanged: observe(() => api.onStateChanged, (newState) => newState, (cause) => toError("onStateChanged", cause))
})

export const layer = (api: ChromeIdleApi): Layer.Layer<ChromeIdle> => Layer.succeed(ChromeIdle, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeIdle, ChromeIdleError> = liveLayer(
  ChromeIdle, "idle", (chrome) => chrome.idle, make,
  (cause) => new ChromeIdleError({ operation: "initialize", cause })
)
