import { Context, Effect, Layer, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeNotificationsError extends Schema.TaggedError<ChromeNotificationsError>()("ChromeNotificationsError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** A notification's contents; every field is optional, as `update` takes them. */
export type NotificationOptions = chrome.notifications.NotificationOptions

/** The contents `create` needs: `type`, `iconUrl`, `title` and `message` are required. */
export type NotificationCreateOptions = chrome.notifications.NotificationCreateOptions

/** The template a notification uses: `"basic"`, `"image"`, `"list"` or `"progress"`. */
export type TemplateType = `${chrome.notifications.TemplateType}`

/** Whether the user allows this extension's notifications. */
export type PermissionLevel = `${chrome.notifications.PermissionLevel}`

export interface ClosedEvent {
  readonly notificationId: string
  /** True when the user dismissed it; false when the system or the extension closed it. */
  readonly byUser: boolean
}

export interface ButtonClickedEvent {
  readonly notificationId: string
  /** Zero-based position of the button in the notification's `buttons`. */
  readonly buttonIndex: number
}

/**
 * The Promise-based MV3 subset this module needs (Promises since Chrome 116). The deprecated
 * `onShowSettings` is left out: no Chrome UI has dispatched it since Chrome 65.
 */
export interface ChromeNotificationsApi {
  create(notificationId: string, options: NotificationCreateOptions): Promise<string>
  create(options: NotificationCreateOptions): Promise<string>
  update(notificationId: string, options: NotificationOptions): Promise<boolean>
  clear(notificationId: string): Promise<boolean>
  getAll(): Promise<{ [notificationId: string]: true }>
  getPermissionLevel(): Promise<PermissionLevel>
  readonly onClicked: EventSource<[notificationId: string]>
  readonly onButtonClicked: EventSource<[notificationId: string, buttonIndex: number]>
  readonly onClosed: EventSource<[notificationId: string, byUser: boolean]>
  readonly onPermissionLevelChanged: EventSource<[level: PermissionLevel]>
}

/**
 * While the user has turned this extension's notifications off (`getPermissionLevel` is
 * `"denied"`), Chrome refuses every call except `getPermissionLevel`, and the call fails with
 * a cause whose message is `"Unknown error."`.
 */
export interface ChromeNotificationsService {
  /**
   * Shows a notification and resolves to its id. Without an id, or with an empty one, Chrome
   * generates a unique id. A showing notification with the same id is replaced in place,
   * without an `onClosed` event. Chrome rejects ids over 500 bytes of UTF-8 (its documentation
   * says characters, but non-ASCII characters count once per byte), a missing required
   * field, `progress` outside 0 to 100 or on a template other than `"progress"`, a `"list"`
   * without `items` or `items` on another template, an `"image"` without `imageUrl` or
   * `imageUrl` on another template, images it cannot load, and, except on ChromeOS, a
   * negative `priority`. A `priority` or `progress` that is not an integer throws
   * synchronously from Chrome's argument validation. Buttons past the second are ignored.
   */
  readonly create: (
    options: NotificationCreateOptions,
    notificationId?: string
  ) => Effect.Effect<string, ChromeNotificationsError>
  /**
   * Changes the given fields of a showing notification and resolves to whether it was
   * showing; an unknown id is left alone rather than created. The fields are checked against
   * the template the notification ends up with, as `create` checks them, and nothing changes
   * when Chrome rejects them.
   */
  readonly update: (
    notificationId: string,
    options: NotificationOptions
  ) => Effect.Effect<boolean, ChromeNotificationsError>
  /**
   * Whether the notification was showing and is now closed. Chrome may report the closure
   * through `onClosed` with `byUser` false; whether it does depends on the platform's
   * notification backend (Chrome's own notification center does).
   */
  readonly clear: (notificationId: string) => Effect.Effect<boolean, ChromeNotificationsError>
  /** The ids of this extension's showing notifications, in Chrome's order. */
  readonly getAll: Effect.Effect<Array<string>, ChromeNotificationsError>
  /** Whether the user allows this extension's notifications; Chrome answers even when denied. */
  readonly getPermissionLevel: Effect.Effect<PermissionLevel, ChromeNotificationsError>
  /**
   * Clicks on the body (not a button) of a notification; Chrome does not clear it. Observational
   * subscriptions that cannot wake an MV3 service worker; register wake listeners through
   * ChromeServiceWorker. Each buffers at most 64 events, dropping the oldest. Chrome dispatches
   * clicks and user dismissals as user gestures, but stream consumers run after the listener
   * returns, so the gesture does not reach them.
   */
  readonly onClicked: Stream.Stream<string, ChromeNotificationsError>
  /** Presses on a notification's buttons. */
  readonly onButtonClicked: Stream.Stream<ButtonClickedEvent, ChromeNotificationsError>
  /** Notifications that closed: dismissed by the user, or closed by the system or (see `clear`) the extension. */
  readonly onClosed: Stream.Stream<ClosedEvent, ChromeNotificationsError>
  /** Changes to the user's choice; only ChromeOS has UI that fires it. */
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
