import { Context, Effect, Layer, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"
import { starter } from "./internal/gesture.js"

export class ChromePermissionsError extends Schema.TaggedError<ChromePermissionsError>()("ChromePermissionsError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

export type Permissions = chrome.permissions.Permissions

/**
 * Where a host access request shows: exactly one of a tab or a top-level document. Chrome
 * rejects a request naming both or neither ("Must specify either 'documentId' or 'tabId'."),
 * which `chrome.permissions`' own optional fields allow.
 */
export type HostAccessTarget =
  | { readonly tabId: number, readonly documentId?: never }
  | { readonly documentId: string, readonly tabId?: never }

/** A host access request for one tab or document, optionally limited to URLs matching `pattern`. */
export type AddHostAccessRequest = HostAccessTarget & { readonly pattern?: string }

/** Withdraws the request for one tab or document; a given `pattern` must match the added one exactly. */
export type RemoveHostAccessRequest = HostAccessTarget & { readonly pattern?: string }

/**
 * The Promise-based MV3 subset this module needs. The host access request members are
 * Chrome 133+; they are optional so older browsers and injected APIs without them still fit,
 * and calling one that is absent fails with the typed error.
 */
export interface ChromePermissionsApi {
  getAll(): Promise<Permissions>
  contains(permissions: Permissions): Promise<boolean>
  request(permissions: Permissions): Promise<boolean>
  remove(permissions: Permissions): Promise<boolean>
  readonly addHostAccessRequest?: (request: AddHostAccessRequest) => Promise<void>
  readonly removeHostAccessRequest?: (request: RemoveHostAccessRequest) => Promise<void>
  readonly onAdded: EventSource<[permissions: Permissions]>
  readonly onRemoved: EventSource<[permissions: Permissions]>
}

export interface ChromePermissionsService {
  /** The extension's current API permissions and host origins. */
  readonly getAll: Effect.Effect<Permissions, ChromePermissionsError>
  /** Whether the extension has every listed permission and origin; `false` is not an error. */
  readonly contains: (permissions: Permissions) => Effect.Effect<boolean, ChromePermissionsError>
  /**
   * Asks the user for optional permissions (`optional_permissions`, `optional_host_permissions`,
   * or required ones the user withheld), resolving to whether they were granted. Chrome only
   * prompts inside a user gesture and rejects otherwise. Lazy: composing it inside a handler
   * does not call Chrome, so prefer `requestFromUserGesture` there.
   */
  readonly request: (permissions: Permissions) => Effect.Effect<boolean, ChromePermissionsError>
  /**
   * The user-gesture bridge for `request`: calls Chrome NOW, on the caller's synchronous stack,
   * and returns an Effect observing that one request. Running it again replays the outcome
   * rather than prompting again; interrupting it stops waiting but cannot cancel the prompt.
   */
  readonly requestFromUserGesture: (permissions: Permissions) => Effect.Effect<boolean, ChromePermissionsError>
  /**
   * Gives up optional permissions, resolving to whether they were removed. Chrome rejects
   * removing required permissions; a later `request` usually re-grants without a prompt.
   */
  readonly remove: (permissions: Permissions) => Effect.Effect<boolean, ChromePermissionsError>
  /**
   * Chrome 133+: signals in the toolbar that the extension wants access to the site in a tab
   * or top-level document (`tabId` or `documentId`, optionally narrowed by `pattern`);
   * accepting grants persistent access to its top origin. Needs no user gesture and grants
   * nothing by itself. A new request replaces the tab's previous one, and Chrome drops it on
   * cross-origin navigation. Chrome rejects hosts the extension cannot be granted.
   */
  readonly addHostAccessRequest: (request: AddHostAccessRequest) => Effect.Effect<void, ChromePermissionsError>
  /**
   * Chrome 133+: withdraws the request for the same tab or document; a given `pattern` must
   * match the added one exactly. Succeeds when there is no request.
   */
  readonly removeHostAccessRequest: (request: RemoveHostAccessRequest) => Effect.Effect<void, ChromePermissionsError>
  /**
   * Permissions and origins newly granted (a change, not a snapshot). Observational: these
   * streams cannot wake an MV3 service worker; register wake listeners through
   * ChromeServiceWorker. Each buffers at most 64 events, dropping the oldest.
   */
  readonly onAdded: Stream.Stream<Permissions, ChromePermissionsError>
  /** Permissions and origins removed, by the extension or by the user. */
  readonly onRemoved: Stream.Stream<Permissions, ChromePermissionsError>
}

export class ChromePermissions extends Context.Service<ChromePermissions, ChromePermissionsService>()(
  "effect-platform-chrome/ChromePermissions"
) {}

const onError = (operation: string, cause: unknown) => new ChromePermissionsError({ operation, cause })

const invoke = invoker(onError)

const start = starter(onError)

const unavailable = (operation: string) => new Error(`permissions.${operation} is unavailable`)

const permissionEvents = (
  operation: "onAdded" | "onRemoved",
  getSource: () => EventSource<[permissions: Permissions]>
): Stream.Stream<Permissions, ChromePermissionsError> =>
  observe(getSource, (permissions) => permissions, (cause) => onError(operation, cause))

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromePermissionsApi): ChromePermissionsService => ChromePermissions.of({
  getAll: invoke("getAll", () => api.getAll()),
  contains: (permissions) => invoke("contains", () => api.contains(permissions)),
  request: (permissions) => invoke("request", () => api.request(permissions)),
  requestFromUserGesture: (permissions) => start("request", () => api.request(permissions)),
  remove: (permissions) => invoke("remove", () => api.remove(permissions)),
  addHostAccessRequest: (request) => invoke("addHostAccessRequest", () => api.addHostAccessRequest === undefined
    ? Promise.reject(unavailable("addHostAccessRequest"))
    : api.addHostAccessRequest(request)),
  removeHostAccessRequest: (request) => invoke("removeHostAccessRequest", () => api.removeHostAccessRequest === undefined
    ? Promise.reject(unavailable("removeHostAccessRequest"))
    : api.removeHostAccessRequest(request)),
  onAdded: permissionEvents("onAdded", () => api.onAdded),
  onRemoved: permissionEvents("onRemoved", () => api.onRemoved)
})

export const layer = (api: ChromePermissionsApi): Layer.Layer<ChromePermissions> => Layer.succeed(ChromePermissions, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromePermissions, ChromePermissionsError> = liveLayer(
  ChromePermissions, "permissions", (chrome) => chrome.permissions, make,
  (cause) => new ChromePermissionsError({ operation: "initialize", cause })
)
