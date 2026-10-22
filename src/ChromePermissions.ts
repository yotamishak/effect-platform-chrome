import { Context, Effect, Exit, Layer, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe } from "./internal/event.js"

export class ChromePermissionsError extends Schema.TaggedError<ChromePermissionsError>()("ChromePermissionsError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/**
 * Promise-based MV3 permissions subset. The host access request members are Chrome 133+;
 * they are optional so injected APIs without them still fit, and calling one that is
 * absent fails with the typed error.
 */
export interface ChromePermissionsApi {
  getAll(): Promise<chrome.permissions.Permissions>
  contains(permissions: chrome.permissions.Permissions): Promise<boolean>
  request(permissions: chrome.permissions.Permissions): Promise<boolean>
  remove(permissions: chrome.permissions.Permissions): Promise<boolean>
  readonly onAdded: Pick<typeof chrome.permissions.onAdded, "addListener" | "removeListener">
  readonly onRemoved: Pick<typeof chrome.permissions.onRemoved, "addListener" | "removeListener">
  readonly addHostAccessRequest?: (request: chrome.permissions.AddHostAccessRequest) => Promise<void>
  readonly removeHostAccessRequest?: (request: chrome.permissions.RemoveHostAccessRequest) => Promise<void>
}

export interface ChromePermissionsService {
  readonly getAll: Effect.Effect<chrome.permissions.Permissions, ChromePermissionsError>
  readonly contains: (permissions: chrome.permissions.Permissions) => Effect.Effect<boolean, ChromePermissionsError>
  /** Lazy: caller must ensure execution reaches Chrome within a user gesture. */
  readonly request: (permissions: chrome.permissions.Permissions) => Effect.Effect<boolean, ChromePermissionsError>
  /** Explicit native boundary: starts the request NOW, not when the returned Effect runs. */
  readonly requestFromUserGesture: (permissions: chrome.permissions.Permissions) => Effect.Effect<boolean, ChromePermissionsError>
  readonly remove: (permissions: chrome.permissions.Permissions) => Effect.Effect<boolean, ChromePermissionsError>
  readonly onAdded: Stream.Stream<chrome.permissions.Permissions, ChromePermissionsError>
  readonly onRemoved: Stream.Stream<chrome.permissions.Permissions, ChromePermissionsError>
  /**
   * Chrome 133+: signals in the toolbar that the extension wants access to the site in a
   * tab (or document); accepting grants persistent access to its top origin. Needs no user
   * gesture. Chrome rejects hosts the extension cannot be granted, and resets the request
   * on cross-origin navigation.
   */
  readonly addHostAccessRequest: (request: chrome.permissions.AddHostAccessRequest) => Effect.Effect<void, ChromePermissionsError>
  /** Chrome 133+: withdraws a request added for the same tab or document and exact pattern. */
  readonly removeHostAccessRequest: (request: chrome.permissions.RemoveHostAccessRequest) => Effect.Effect<void, ChromePermissionsError>
}

export class ChromePermissions extends Context.Service<ChromePermissions, ChromePermissionsService>()("effect-platform-chrome/ChromePermissions") {}

const invoke = invoker((operation, cause) => new ChromePermissionsError({ operation, cause }))

const unavailable = (operation: string) => new Error(`permissions.${operation} is unavailable`)

/** Attach both settlement handlers immediately, even if the returned Effect is never run. */
const requestImmediately = (
  api: ChromePermissionsApi,
  permissions: chrome.permissions.Permissions
): Effect.Effect<boolean, ChromePermissionsError> => {
  try {
    const outcome: Promise<Exit.Exit<boolean, ChromePermissionsError>> = api.request(permissions).then(
      (granted) => Exit.succeed(granted),
      (cause) => Exit.fail(new ChromePermissionsError({ operation: "request", cause }))
    )

    return Effect.flatMap(Effect.promise(() => outcome), (exit) => exit)
  } catch (cause) {
    return Effect.fail(new ChromePermissionsError({ operation: "request", cause }))
  }
}

const permissionEvents = (
  operation: "onAdded" | "onRemoved",
  getSource: () => ChromePermissionsApi["onAdded"]
): Stream.Stream<chrome.permissions.Permissions, ChromePermissionsError> =>
  observe(getSource, (permissions) => permissions, (cause) => new ChromePermissionsError({ operation, cause }))

/**
 * Each consumption owns a scoped listener. At most 64 pending events are retained;
 * overflow drops the oldest because native Chrome callbacks cannot backpressure.
 * These streams are observations, not synchronous MV3 wakeup registrations.
 */
export const make = (api: ChromePermissionsApi): ChromePermissionsService => ChromePermissions.of({
  getAll: invoke("getAll", () => api.getAll()),
  contains: (permissions) => invoke("contains", () => api.contains(permissions)),
  request: (permissions) => invoke("request", () => api.request(permissions)),
  requestFromUserGesture: (permissions) => requestImmediately(api, permissions),
  remove: (permissions) => invoke("remove", () => api.remove(permissions)),
  onAdded: permissionEvents("onAdded", () => api.onAdded),
  onRemoved: permissionEvents("onRemoved", () => api.onRemoved),
  addHostAccessRequest: (request) => invoke("addHostAccessRequest", () => api.addHostAccessRequest === undefined
    ? Promise.reject(unavailable("addHostAccessRequest"))
    : api.addHostAccessRequest(request)),
  removeHostAccessRequest: (request) => invoke("removeHostAccessRequest", () => api.removeHostAccessRequest === undefined
    ? Promise.reject(unavailable("removeHostAccessRequest"))
    : api.removeHostAccessRequest(request))
})

export const layer = (api: ChromePermissionsApi): Layer.Layer<ChromePermissions> => Layer.succeed(ChromePermissions, make(api))

/** The global is accessed only when this layer is built. */
export const layerLive: Layer.Layer<ChromePermissions, ChromePermissionsError> = liveLayer(
  ChromePermissions, "permissions", (chrome) => chrome.permissions, make,
  (cause) => new ChromePermissionsError({ operation: "initialize", cause })
)
