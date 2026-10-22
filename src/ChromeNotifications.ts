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

export interface ButtonClickedEvent {
  readonly notificationId: string
  /** Zero-based position of the button in the notification's `buttons`. */
  readonly buttonIndex: number
}

/** Whether the user allows this extension's notifications. */
export type PermissionLevel = `${chrome.notifications.PermissionLevel}`

/** The Promise-based MV3 subset this module needs. */
export interface ChromeNotificationsApi {
  create(notificationId: string, options: chrome.notifications.NotificationCreateOptions): Promise<string>
  create(options: chrome.notifications.NotificationCreateOptions): Promise<string>
  update(notificationId: string, options: chrome.notifications.NotificationOptions): Promise<boolean>
  clear(notificationId: string): Promise<boolean>
  getAll(): Promise<{ [notificationId: string]: true }>
  getPermissionLevel(): Promise<PermissionLevel>
  readonly onClicked: EventSource<[notificationId: string]>
  readonly onButtonClicked: EventSource<[notificationId: string, buttonIndex: number]>
  readonly onClosed: EventSource<[notificationId: string, byUser: boolean]>
  readonly onPermissionLevelChanged: EventSource<[level: PermissionLevel]>
}

export interface ChromeNotificationsService {
  /** Shows (or replaces) a notification and resolves to its id; Chrome generates one when none is given. */
  readonly create: (
    options: chrome.notifications.NotificationCreateOptions,
    notificationId?: string
  ) => Effect.Effect<string, ChromeNotificationsError>
  /**
   * Changes the given fields of a showing notification. Resolves to whether it existed;
   * an unknown id is left alone rather than created.
   */
  readonly update: (
    notificationId: string,
    options: chrome.notifications.NotificationOptions
  ) => Effect.Effect<boolean, ChromeNotificationsError>
  /** Whether a notification was showing and is now cleared. */
  readonly clear: (notificationId: string) => Effect.Effect<boolean, ChromeNotificationsError>
  /** The ids of this extension's showing notifications. */
  readonly getAll: Effect.Effect<Array<string>, ChromeNotificationsError>
  readonly getPermissionLevel: Effect.Effect<PermissionLevel, ChromeNotificationsError>
  /**
   * Observational subscriptions that cannot wake an MV3 service worker; register wake
   * listeners through ChromeServiceWorker. Each buffers at most 64 events, dropping the oldest.
   */
  readonly onClicked: Stream.Stream<string, ChromeNotificationsError>
  readonly onButtonClicked: Stream.Stream<ButtonClickedEvent, ChromeNotificationsError>
  readonly onClosed: Stream.Stream<ClosedEvent, ChromeNotificationsError>
  /** Changes to the user's choice; only some platforms (ChromeOS) have UI that fires it. */
  readonly onPermissionLevelChanged: Stream.Stream<PermissionLevel, ChromeNotificationsError>
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
  update: (notificationId, options) => invoke("update", () => api.update(notificationId, options)),
  clear: (notificationId) => invoke("clear", () => api.clear(notificationId)),
  getAll: invoke("getAll", () => api.getAll()).pipe(Effect.map((notifications) => Object.keys(notifications))),
  getPermissionLevel: invoke("getPermissionLevel", () => api.getPermissionLevel()),
  onClicked: observe(() => api.onClicked, (notificationId) => notificationId, eventError("onClicked")),
  onButtonClicked: observe(
    () => api.onButtonClicked,
    (notificationId, buttonIndex) => ({ notificationId, buttonIndex }),
    eventError("onButtonClicked")
  ),
  onClosed: observe(() => api.onClosed, (notificationId, byUser) => ({ notificationId, byUser }), eventError("onClosed")),
  onPermissionLevelChanged: observe(() => api.onPermissionLevelChanged, (level) => level, eventError("onPermissionLevelChanged"))
})

export const layer = (api: ChromeNotificationsApi): Layer.Layer<ChromeNotifications> =>
  Layer.succeed(ChromeNotifications, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeNotifications, ChromeNotificationsError> = liveLayer(
  ChromeNotifications, "notifications", (chrome) => chrome.notifications, make,
  (cause) => new ChromeNotificationsError({ operation: "initialize", cause })
)
