import { Context, Effect, Layer, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeManagementError extends Schema.TaggedError<ChromeManagementError>()("ChromeManagementError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

export type ExtensionInfo = chrome.management.ExtensionInfo

export type UninstallOptions = chrome.management.UninstallOptions

type InfoEvent = EventSource<[info: ExtensionInfo]>

/**
 * The Promise-based MV3 subset this module needs. Chrome App-only calls (`launchApp`,
 * `setLaunchType`, `createAppShortcut`, `generateAppForLink`, `installReplacementWebApp`)
 * are deliberately not wrapped: Chrome Apps are deprecated and extensions cannot use them.
 */
export interface ChromeManagementApi {
  getSelf(): Promise<ExtensionInfo>
  getAll(): Promise<Array<ExtensionInfo>>
  get(id: string): Promise<ExtensionInfo>
  getPermissionWarningsById(id: string): Promise<Array<string>>
  getPermissionWarningsByManifest(manifestStr: string): Promise<Array<string>>
  setEnabled(id: string, enabled: boolean): Promise<void>
  uninstall(id: string, options?: UninstallOptions): Promise<void>
  uninstallSelf(options?: UninstallOptions): Promise<void>
  readonly onInstalled: InfoEvent
  readonly onUninstalled: EventSource<[id: string]>
  readonly onEnabled: InfoEvent
  readonly onDisabled: InfoEvent
}

/**
 * `getSelf`, `getPermissionWarningsByManifest` and `uninstallSelf` work without the
 * "management" permission; every other call and event requires it.
 */
export interface ChromeManagementService {
  /** The calling extension's own entry. */
  readonly getSelf: Effect.Effect<ExtensionInfo, ChromeManagementError>
  /** Every installed extension, app and theme. */
  readonly getAll: Effect.Effect<Array<ExtensionInfo>, ChromeManagementError>
  /** One installed item; an unknown id fails. */
  readonly get: (id: string) => Effect.Effect<ExtensionInfo, ChromeManagementError>
  readonly getPermissionWarningsById: (id: string) => Effect.Effect<Array<string>, ChromeManagementError>
  /** Warnings Chrome would show for a manifest, given as its JSON text. */
  readonly getPermissionWarningsByManifest: (manifestJson: string) => Effect.Effect<Array<string>, ChromeManagementError>
  /**
   * Enables or disables another item. Chrome usually requires a user gesture and may show
   * a confirmation prompt, so calls from a service worker without one can fail.
   */
  readonly setEnabled: (id: string, enabled: boolean) => Effect.Effect<void, ChromeManagementError>
  /** Uninstalls another item; Chrome always confirms with the user, and fails if they cancel. */
  readonly uninstall: (id: string, options?: UninstallOptions) => Effect.Effect<void, ChromeManagementError>
  /**
   * Uninstalls the calling extension. Without a confirmation dialog this tears the
   * extension down, so the Effect may never complete; with one, a cancel fails.
   */
  readonly uninstallSelf: (options?: UninstallOptions) => Effect.Effect<void, ChromeManagementError>
  /**
   * Observational subscriptions about other items (use ChromeRuntime for this extension's
   * own install/update). They cannot wake an MV3 service worker; register wake listeners
   * through ChromeServiceWorker.listen. Each buffers at most 64 events, dropping the oldest.
   */
  readonly onInstalled: Stream.Stream<ExtensionInfo, ChromeManagementError>
  /** The id of each uninstalled item. */
  readonly onUninstalled: Stream.Stream<string, ChromeManagementError>
  readonly onEnabled: Stream.Stream<ExtensionInfo, ChromeManagementError>
  readonly onDisabled: Stream.Stream<ExtensionInfo, ChromeManagementError>
}

export class ChromeManagement extends Context.Service<ChromeManagement, ChromeManagementService>()(
  "effect-platform-chrome/ChromeManagement"
) {}

const invoke = invoker((operation, cause) => new ChromeManagementError({ operation, cause }))

const eventError = (operation: string) => (cause: unknown) => new ChromeManagementError({ operation, cause })

const infos = (operation: string, getSource: () => InfoEvent): Stream.Stream<ExtensionInfo, ChromeManagementError> =>
  observe(getSource, (info) => info, eventError(operation))

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeManagementApi): ChromeManagementService => ChromeManagement.of({
  getSelf: invoke("getSelf", () => api.getSelf()),
  getAll: invoke("getAll", () => api.getAll()),
  get: (id) => invoke("get", () => api.get(id)),
  getPermissionWarningsById: (id) => invoke("getPermissionWarningsById", () => api.getPermissionWarningsById(id)),
  getPermissionWarningsByManifest: (manifestJson) => invoke(
    "getPermissionWarningsByManifest", () => api.getPermissionWarningsByManifest(manifestJson)
  ),
  setEnabled: (id, enabled) => invoke("setEnabled", () => api.setEnabled(id, enabled)),
  uninstall: (id, options) => invoke("uninstall", () => options === undefined
    ? api.uninstall(id)
    : api.uninstall(id, options)),
  uninstallSelf: (options) => invoke("uninstallSelf", () => options === undefined
    ? api.uninstallSelf()
    : api.uninstallSelf(options)),
  onInstalled: infos("onInstalled", () => api.onInstalled),
  onUninstalled: observe(() => api.onUninstalled, (id) => id, eventError("onUninstalled")),
  onEnabled: infos("onEnabled", () => api.onEnabled),
  onDisabled: infos("onDisabled", () => api.onDisabled)
})

export const layer = (api: ChromeManagementApi): Layer.Layer<ChromeManagement> =>
  Layer.succeed(ChromeManagement, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeManagement, ChromeManagementError> = liveLayer(
  ChromeManagement, "management", (chrome) => chrome.management, make,
  (cause) => new ChromeManagementError({ operation: "initialize", cause })
)
