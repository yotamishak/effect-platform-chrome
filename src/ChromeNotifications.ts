import { Context, Effect, Layer, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeNotificationsError extends Schema.TaggedError<ChromeNotificationsError>()("ChromeNotificationsError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

export interface ClosedEvent {
  readonly notificationId: string
  readonly byUser: boolean
}

/** The Promise-based MV3 subset this module needs. */
export interface ChromeNotificationsApi {
  create(notificationId: string, options: chrome.notifications.NotificationCreateOptions): Promise<string>
  create(options: chrome.notifications.NotificationCreateOptions): Promise<string>
  clear(notificationId: string): Promise<boolean>
  readonly onClicked: EventSource<[notificationId: string]>
  readonly onClosed: EventSource<[notificationId: string, byUser: boolean]>
}

export interface ChromeNotificationsService {
  /** Shows (or replaces) a notification and resolves to its id; Chrome generates one when none is given. */
  readonly create: (
    options: chrome.notifications.NotificationCreateOptions,
    notificationId?: string
  ) => Effect.Effect<string, ChromeNotificationsError>
  /** Whether a notification was showing and is now cleared. */
  readonly clear: (notificationId: string) => Effect.Effect<boolean, ChromeNotificationsError>
  /**
   * Observational subscriptions that cannot wake an MV3 service worker; register wake
   * listeners through ChromeServiceWorker. Each buffers at most 64 events, dropping the oldest.
   */
  readonly onClicked: Stream.Stream<string, ChromeNotificationsError>
  readonly onClosed: Stream.Stream<ClosedEvent, ChromeNotificationsError>
}

export class ChromeNotifications extends Context.Service<ChromeNotifications, ChromeNotificationsService>()(
  "effect-platform-chrome/ChromeNotifications"
) {}

const invoke = invoker((operation, cause) => new ChromeNotificationsError({ operation, cause }))

const eventError = (operation: string) => (cause: unknown) => new ChromeNotificationsError({ operation, cause })

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeNotificationsApi): ChromeNotificationsService => ChromeNotifications.of({
  create: (options, notificationId) => invoke("create", () => notificationId === undefined
    ? api.create(options)
    : api.create(notificationId, options)),
  clear: (notificationId) => invoke("clear", () => api.clear(notificationId)),
  onClicked: observe(() => api.onClicked, (notificationId) => notificationId, eventError("onClicked")),
  onClosed: observe(() => api.onClosed, (notificationId, byUser) => ({ notificationId, byUser }), eventError("onClosed"))
})

export const layer = (api: ChromeNotificationsApi): Layer.Layer<ChromeNotifications> =>
  Layer.succeed(ChromeNotifications, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeNotifications, ChromeNotificationsError> = liveLayer(
  ChromeNotifications, "notifications", (chrome) => chrome.notifications, make,
  (cause) => new ChromeNotificationsError({ operation: "initialize", cause })
)
