import { Context, Effect, Layer, Queue, Schema, Stream } from "effect"

export class ChromeNotificationsError extends Schema.TaggedError<ChromeNotificationsError>()("ChromeNotificationsError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

export interface ClosedEvent {
  readonly notificationId: string
  readonly byUser: boolean
}

interface Event<Args extends Array<unknown>> {
  addListener(listener: (...args: Args) => void): void
  removeListener(listener: (...args: Args) => void): void
}

/** The Promise-based MV3 subset this module needs. */
export interface ChromeNotificationsApi {
  create(notificationId: string, options: chrome.notifications.NotificationCreateOptions): Promise<string>
  create(options: chrome.notifications.NotificationCreateOptions): Promise<string>
  clear(notificationId: string): Promise<boolean>
  readonly onClicked: Event<[notificationId: string]>
  readonly onClosed: Event<[notificationId: string, byUser: boolean]>
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

const invoke = <A>(operation: string, run: () => Promise<A>): Effect.Effect<A, ChromeNotificationsError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ChromeNotificationsError({ operation, cause })
  })

const observe = <Args extends Array<unknown>, A>(
  operation: string,
  getSource: () => Event<Args>,
  project: (...args: Args) => A
): Stream.Stream<A, ChromeNotificationsError> => Stream.callback<A, ChromeNotificationsError>((queue) => {
  const listener = (...args: Args) => { Queue.offerUnsafe(queue, project(...args)) }

  return Effect.gen(function*() {
    const source = yield* Effect.try({
      try: getSource,
      catch: (cause) => new ChromeNotificationsError({ operation, cause })
    })

    // Install cleanup before registration, which may partially succeed then throw.
    yield* Effect.acquireRelease(
      Effect.succeed(listener),
      () => Effect.sync(() => source.removeListener(listener))
    )
    yield* Effect.try({
      try: () => source.addListener(listener),
      catch: (cause) => new ChromeNotificationsError({ operation, cause })
    })
  })
}, { bufferSize: 64, strategy: "sliding" })

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeNotificationsApi): ChromeNotificationsService => ChromeNotifications.of({
  create: (options, notificationId) => invoke("create", () => notificationId === undefined
    ? api.create(options)
    : api.create(notificationId, options)),
  clear: (notificationId) => invoke("clear", () => api.clear(notificationId)),
  onClicked: observe("onClicked", () => api.onClicked, (notificationId) => notificationId),
  onClosed: observe("onClosed", () => api.onClosed, (notificationId, byUser) => ({ notificationId, byUser }))
})

export const layer = (api: ChromeNotificationsApi): Layer.Layer<ChromeNotifications> =>
  Layer.succeed(ChromeNotifications, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeNotifications, ChromeNotificationsError> = Layer.effect(ChromeNotifications, Effect.try({
  try: () => {
    const api = typeof chrome === "undefined" ? undefined : chrome.notifications

    if (api === undefined) {
      throw new Error("chrome.notifications is unavailable in this context")
    }

    return make(api)
  },
  catch: (cause) => new ChromeNotificationsError({ operation: "initialize", cause })
}))
