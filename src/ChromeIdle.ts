import { Context, Layer, Schema, Stream } from "effect"
import type { Effect } from "effect"
import { attempter, invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeIdleError extends Schema.TaggedError<ChromeIdleError>()("ChromeIdleError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** `"active"`, `"idle"` or `"locked"`. */
export type IdleState = `${chrome.idle.IdleState}`

/**
 * The Promise-based MV3 subset of `chrome.idle` (manifest permission `"idle"`), which
 * `chrome.idle` itself satisfies. `setDetectionInterval` is synchronous in Chrome.
 * `getAutoLockDelay` (Chrome 73+) is optional so injected APIs without it still fit;
 * calling it when absent fails with the typed error.
 */
export interface ChromeIdleApi {
  queryState(detectionIntervalInSeconds: number): Promise<IdleState>
  setDetectionInterval(intervalInSeconds: number): void
  getAutoLockDelay?(): Promise<number>
  readonly onStateChanged: EventSource<[newState: IdleState]>
}

export interface ChromeIdleService {
  /**
   * `"locked"` when the screen is locked or the screensaver is active, otherwise `"idle"`
   * when there was no user input for `detectionIntervalInSeconds` seconds, and `"active"`
   * otherwise. Chrome requires an integer of at least 15 (it throws for anything else,
   * failing with the typed error) and treats values above 14400 (four hours) as 14400.
   */
  readonly queryState: (detectionIntervalInSeconds: number) => Effect.Effect<IdleState, ChromeIdleError>
  /**
   * Sets the threshold behind `onStateChanged`'s `"idle"`: an integer of at least 15
   * (otherwise the typed error), capped at 14400. Chrome's default is 60. The setting
   * belongs to the extension, not to a subscription or a worker, and the last write
   * wins; it does not affect `queryState`.
   */
  readonly setDetectionInterval: (intervalInSeconds: number) => Effect.Effect<void, ChromeIdleError>
  /**
   * Seconds until the screen locks automatically while idle, 0 when it never does.
   * Meaningful on ChromeOS only: other platforms report 0. Fails with the typed error
   * when the API lacks the function (Chrome before 73 or an injected API without it).
   */
  readonly getAutoLockDelay: Effect.Effect<number, ChromeIdleError>
  /**
   * The state each time it changes. Chrome samples it at the detection interval about once
   * a second while the extension has any idle listener, and fires when a sample differs
   * from the last one it took, which starts as `"active"` and is not updated while no
   * listener exists. The first event after subscribing can therefore report the state the
   * machine was already in, or a change made while nobody listened; there is no
   * guaranteed initial event, so read the current state with `queryState`. `"locked"` can
   * follow `"active"` directly. This is an observational
   * subscription that cannot wake an MV3 service worker; register wake listeners
   * synchronously through `ChromeServiceWorker.listen` instead. Buffers at most 64
   * events, dropping the oldest.
   */
  readonly onStateChanged: Stream.Stream<IdleState, ChromeIdleError>
}

export class ChromeIdle extends Context.Service<ChromeIdle, ChromeIdleService>()("effect-platform-chrome/ChromeIdle") {}

const toError = (operation: string, cause: unknown) => new ChromeIdleError({ operation, cause })

const invoke = invoker(toError)

const attempt = attempter(toError)

/** Creates the service without reading browser globals, the API's members, or registering listeners. */
export const make = (api: ChromeIdleApi): ChromeIdleService => ChromeIdle.of({
  queryState: (detectionIntervalInSeconds) => invoke("queryState", () => api.queryState(detectionIntervalInSeconds)),
  setDetectionInterval: (intervalInSeconds) => attempt("setDetectionInterval", () => api.setDetectionInterval(intervalInSeconds)),
  getAutoLockDelay: invoke("getAutoLockDelay", () => api.getAutoLockDelay === undefined
    ? Promise.reject(new Error("idle.getAutoLockDelay is unavailable"))
    : api.getAutoLockDelay()),
  onStateChanged: observe(() => api.onStateChanged, (newState) => newState, (cause) => toError("onStateChanged", cause))
})

export const layer = (api: ChromeIdleApi): Layer.Layer<ChromeIdle> => Layer.succeed(ChromeIdle, make(api))

/**
 * Reads `chrome.idle` when the layer is built, never at import time; it fails with
 * operation `"initialize"` when the namespace is missing (no `"idle"` permission, or not
 * an extension context).
 */
export const layerLive: Layer.Layer<ChromeIdle, ChromeIdleError> = liveLayer(
  ChromeIdle, "idle", (chrome) => chrome.idle, make,
  (cause) => new ChromeIdleError({ operation: "initialize", cause })
)
