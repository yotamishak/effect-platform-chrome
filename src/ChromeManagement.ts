import { Context, Effect, Exit, Layer, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeManagementError extends Schema.TaggedError<ChromeManagementError>()("ChromeManagementError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** An installed extension, app or theme, as Chrome reports it. */
export type ExtensionInfo = chrome.management.ExtensionInfo

/** Whether `uninstallSelf` (or `uninstall` of this extension's own id) asks the user first. */
export type UninstallOptions = chrome.management.UninstallOptions

/** How an app opens; check the app's `availableLaunchTypes` before `setLaunchType`. */
export type LaunchType = `${chrome.management.LaunchType}`

type InfoEvent = EventSource<[info: ExtensionInfo]>

/**
 * The Promise-based MV3 surface of `chrome.management`, which exists only in extension
 * contexts (not content scripts). Without the "management" permission Chrome exposes only
 * `getSelf`, `getPermissionWarningsByManifest` and `uninstallSelf`, so every other member is
 * optional here, and a call or event whose member is absent fails with the typed error.
 * `installReplacementWebApp` exists only for an extension whose manifest declares
 * `replacement_web_app`, and not on desktop Android.
 */
export interface ChromeManagementApi {
  getSelf(): Promise<ExtensionInfo>
  getPermissionWarningsByManifest(manifestStr: string): Promise<Array<string>>
  uninstallSelf(options?: UninstallOptions): Promise<void>
  readonly getAll?: () => Promise<Array<ExtensionInfo>>
  readonly get?: (id: string) => Promise<ExtensionInfo>
  readonly getPermissionWarningsById?: (id: string) => Promise<Array<string>>
  readonly setEnabled?: (id: string, enabled: boolean) => Promise<void>
  readonly uninstall?: (id: string, options?: UninstallOptions) => Promise<void>
  readonly launchApp?: (id: string) => Promise<void>
  readonly setLaunchType?: (id: string, launchType: LaunchType) => Promise<void>
  readonly createAppShortcut?: (id: string) => Promise<void>
  readonly generateAppForLink?: (url: string, title: string) => Promise<ExtensionInfo>
  readonly installReplacementWebApp?: () => Promise<void>
  readonly onInstalled?: InfoEvent
  readonly onUninstalled?: EventSource<[id: string]>
  readonly onEnabled?: InfoEvent
  readonly onDisabled?: InfoEvent
}

/**
 * `getSelf`, `getPermissionWarningsByManifest` and `uninstallSelf` work without the
 * "management" permission; `installReplacementWebApp` needs the `replacement_web_app`
 * manifest key instead; every other call and event needs the permission.
 *
 * Chrome honours some calls only inside a user gesture (a click handler, for example).
 * Each has a lazy form, which reaches Chrome only when the Effect runs, and an
 * `xFromUserGesture` form, which starts the native call immediately (still inside the
 * gesture) and returns an Effect awaiting its outcome. Running that Effect again, or
 * interrupting it, never repeats or cancels the native call.
 */
export interface ChromeManagementService {
  /** The calling extension's own entry. */
  readonly getSelf: Effect.Effect<ExtensionInfo, ChromeManagementError>
  /** Every installed extension, app and theme, this extension included. */
  readonly getAll: Effect.Effect<Array<ExtensionInfo>, ChromeManagementError>
  /** One installed item; an unknown id fails. */
  readonly get: (id: string) => Effect.Effect<ExtensionInfo, ChromeManagementError>
  /** The warnings Chrome shows for an installed item's permissions; an unknown id fails. */
  readonly getPermissionWarningsById: (id: string) => Effect.Effect<Array<string>, ChromeManagementError>
  /** The warnings Chrome would show for a manifest given as its JSON text; invalid JSON fails. */
  readonly getPermissionWarningsByManifest: (manifestStr: string) => Effect.Effect<Array<string>, ChromeManagementError>
  /**
   * Enables or disables an item. Disabling needs no gesture. Re-enabling an item Chrome
   * disabled for a permissions increase (`disabledReason: "permissions_increase"`) needs a
   * user gesture and shows a re-enable prompt, so use `setEnabledFromUserGesture` there;
   * for a supervised user Chrome may ask a parent instead. Fails for an unknown id, for an
   * item policy keeps in its state (`mayDisable`/`mayEnable` false), and when the user
   * declines the prompt.
   */
  readonly setEnabled: (id: string, enabled: boolean) => Effect.Effect<void, ChromeManagementError>
  /** `setEnabled`, started now so a re-enable prompt runs inside the caller's user gesture. */
  readonly setEnabledFromUserGesture: (id: string, enabled: boolean) => Effect.Effect<void, ChromeManagementError>
  /**
   * Uninstalls another item. Chrome always asks the user (`options` only matter when `id`
   * is this extension's own) and so needs a user gesture: without one, or when the user
   * cancels, or when policy forbids removal, it fails. Use `uninstallFromUserGesture`.
   */
  readonly uninstall: (id: string, options?: UninstallOptions) => Effect.Effect<void, ChromeManagementError>
  /** `uninstall`, started now so its confirmation dialog runs inside the caller's user gesture. */
  readonly uninstallFromUserGesture: (id: string, options?: UninstallOptions) => Effect.Effect<void, ChromeManagementError>
  /**
   * Uninstalls the calling extension. Without `showConfirmDialog` this tears the extension
   * down at once, so the Effect may never complete. With it Chrome needs a user gesture
   * (use `uninstallSelfFromUserGesture`), and a cancel fails.
   */
  readonly uninstallSelf: (options?: UninstallOptions) => Effect.Effect<void, ChromeManagementError>
  /** `uninstallSelf`, started now so its confirmation dialog runs inside the caller's user gesture. */
  readonly uninstallSelfFromUserGesture: (options?: UninstallOptions) => Effect.Effect<void, ChromeManagementError>
  /**
   * Launches an installed app. Fails for an item that is not an app, for Chrome Apps where
   * Chrome no longer runs them (Windows, macOS and Linux), and on Android.
   */
  readonly launchApp: (id: string) => Effect.Effect<void, ChromeManagementError>
  /**
   * Sets how an app opens. Needs a user gesture (use `setLaunchTypeFromUserGesture`) and a
   * type from the app's `availableLaunchTypes`; fails for an item that is not an app.
   */
  readonly setLaunchType: (id: string, launchType: LaunchType) => Effect.Effect<void, ChromeManagementError>
  /** `setLaunchType`, started now inside the caller's user gesture. */
  readonly setLaunchTypeFromUserGesture: (id: string, launchType: LaunchType) => Effect.Effect<void, ChromeManagementError>
  /**
   * Shows Chrome's dialog for creating shortcuts to an app (on macOS only packaged apps) and
   * fails if the user cancels it. Needs a user gesture (use `createAppShortcutFromUserGesture`)
   * and a browser window; unsupported on Android.
   */
  readonly createAppShortcut: (id: string) => Effect.Effect<void, ChromeManagementError>
  /** `createAppShortcut`, started now inside the caller's user gesture. */
  readonly createAppShortcutFromUserGesture: (id: string) => Effect.Effect<void, ChromeManagementError>
  /**
   * Installs an http(s) URL as a web app titled `title` and resolves to its entry. Needs a
   * user gesture (use `generateAppForLinkFromUserGesture`); other schemes, an empty title and
   * Android fail.
   */
  readonly generateAppForLink: (url: string, title: string) => Effect.Effect<ExtensionInfo, ChromeManagementError>
  /** `generateAppForLink`, started now inside the caller's user gesture. */
  readonly generateAppForLinkFromUserGesture: (url: string, title: string) => Effect.Effect<ExtensionInfo, ChromeManagementError>
  /**
   * Launches the web app named by the manifest's `replacement_web_app`, prompting the user
   * to install it first if needed. Only for a Chrome Web Store install declaring that key,
   * and only inside a user gesture (use `installReplacementWebAppFromUserGesture`).
   */
  readonly installReplacementWebApp: Effect.Effect<void, ChromeManagementError>
  /** `installReplacementWebApp`, started when called, inside the caller's user gesture. */
  // oxlint-disable-next-line effecttsgo/lazy-effect -- calling it is the gesture boundary: the native call starts then, not when the Effect runs.
  readonly installReplacementWebAppFromUserGesture: () => Effect.Effect<void, ChromeManagementError>
  /**
   * Observational subscriptions about installed items (use ChromeRuntime for this
   * extension's own install and update). They cannot wake an MV3 service worker; register
   * wake listeners through ChromeServiceWorker.listen. Each consumption owns one listener
   * and buffers at most 64 events, dropping the oldest.
   */
  readonly onInstalled: Stream.Stream<ExtensionInfo, ChromeManagementError>
  /** The id of each uninstalled item. */
  readonly onUninstalled: Stream.Stream<string, ChromeManagementError>
  readonly onEnabled: Stream.Stream<ExtensionInfo, ChromeManagementError>
  readonly onDisabled: Stream.Stream<ExtensionInfo, ChromeManagementError>
}

// oxlint-disable-next-line effecttsgo/lazy-effect -- installReplacementWebAppFromUserGesture must start the native call when called.
export class ChromeManagement extends Context.Service<ChromeManagement, ChromeManagementService>()(
  "effect-platform-chrome/ChromeManagement"
) {}

const invoke = invoker((operation, cause) => new ChromeManagementError({ operation, cause }))

const eventError = (operation: string) => (cause: unknown) => new ChromeManagementError({ operation, cause })

/** Thrown when Chrome left a member out because the extension lacks what it requires. */
const unavailable = (member: string): never => {
  const requirement = member === "installReplacementWebApp"
    ? "the \"replacement_web_app\" manifest key"
    : "the \"management\" permission"

  throw new Error(`chrome.management.${member} is unavailable: it requires ${requirement}`)
}

/**
 * Starts the native call before returning, so it runs inside the caller's user gesture,
 * and settles it into an Exit at once, so a rejection is never unhandled even if the
 * returned Effect never runs. The Effect only awaits that one outcome.
 */
const startNow = <A>(operation: string, run: () => Promise<A>): Effect.Effect<A, ChromeManagementError> => {
  try {
    const outcome: Promise<Exit.Exit<A, ChromeManagementError>> = run().then(
      (value) => Exit.succeed(value),
      (cause) => Exit.fail(new ChromeManagementError({ operation, cause }))
    )

    return Effect.flatMap(Effect.promise(() => outcome), (exit) => exit)
  } catch (cause) {
    return Effect.fail(new ChromeManagementError({ operation, cause }))
  }
}

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeManagementApi): ChromeManagementService => {
  const setEnabled = (id: string, enabled: boolean) => () => api.setEnabled === undefined
    ? unavailable("setEnabled")
    : api.setEnabled(id, enabled)

  const uninstall = (id: string, options: UninstallOptions | undefined) => () => {
    if (api.uninstall === undefined) return unavailable("uninstall")

    return options === undefined ? api.uninstall(id) : api.uninstall(id, options)
  }

  const uninstallSelf = (options: UninstallOptions | undefined) => () => options === undefined
    ? api.uninstallSelf()
    : api.uninstallSelf(options)

  const setLaunchType = (id: string, launchType: LaunchType) => () => api.setLaunchType === undefined
    ? unavailable("setLaunchType")
    : api.setLaunchType(id, launchType)

  const createAppShortcut = (id: string) => () => api.createAppShortcut === undefined
    ? unavailable("createAppShortcut")
    : api.createAppShortcut(id)

  const generateAppForLink = (url: string, title: string) => () => api.generateAppForLink === undefined
    ? unavailable("generateAppForLink")
    : api.generateAppForLink(url, title)

  const installReplacementWebApp = () => api.installReplacementWebApp === undefined
    ? unavailable("installReplacementWebApp")
    : api.installReplacementWebApp()

  const infos = (operation: string, getSource: () => InfoEvent | undefined): Stream.Stream<ExtensionInfo, ChromeManagementError> =>
    observe(() => getSource() ?? unavailable(operation), (info) => info, eventError(operation))

  return ChromeManagement.of({
    getSelf: invoke("getSelf", () => api.getSelf()),
    getAll: invoke("getAll", () => api.getAll === undefined ? unavailable("getAll") : api.getAll()),
    get: (id) => invoke("get", () => api.get === undefined ? unavailable("get") : api.get(id)),
    getPermissionWarningsById: (id) => invoke("getPermissionWarningsById", () => api.getPermissionWarningsById === undefined
      ? unavailable("getPermissionWarningsById")
      : api.getPermissionWarningsById(id)),
    getPermissionWarningsByManifest: (manifestStr) => invoke(
      "getPermissionWarningsByManifest", () => api.getPermissionWarningsByManifest(manifestStr)
    ),
    setEnabled: (id, enabled) => invoke("setEnabled", setEnabled(id, enabled)),
    setEnabledFromUserGesture: (id, enabled) => startNow("setEnabled", setEnabled(id, enabled)),
    uninstall: (id, options) => invoke("uninstall", uninstall(id, options)),
    uninstallFromUserGesture: (id, options) => startNow("uninstall", uninstall(id, options)),
    uninstallSelf: (options) => invoke("uninstallSelf", uninstallSelf(options)),
    uninstallSelfFromUserGesture: (options) => startNow("uninstallSelf", uninstallSelf(options)),
    launchApp: (id) => invoke("launchApp", () => api.launchApp === undefined ? unavailable("launchApp") : api.launchApp(id)),
    setLaunchType: (id, launchType) => invoke("setLaunchType", setLaunchType(id, launchType)),
    setLaunchTypeFromUserGesture: (id, launchType) => startNow("setLaunchType", setLaunchType(id, launchType)),
    createAppShortcut: (id) => invoke("createAppShortcut", createAppShortcut(id)),
    createAppShortcutFromUserGesture: (id) => startNow("createAppShortcut", createAppShortcut(id)),
    generateAppForLink: (url, title) => invoke("generateAppForLink", generateAppForLink(url, title)),
    generateAppForLinkFromUserGesture: (url, title) => startNow("generateAppForLink", generateAppForLink(url, title)),
    installReplacementWebApp: invoke("installReplacementWebApp", installReplacementWebApp),
    installReplacementWebAppFromUserGesture: () => startNow("installReplacementWebApp", installReplacementWebApp),
    onInstalled: infos("onInstalled", () => api.onInstalled),
    onUninstalled: observe(() => api.onUninstalled ?? unavailable("onUninstalled"), (id) => id, eventError("onUninstalled")),
    onEnabled: infos("onEnabled", () => api.onEnabled),
    onDisabled: infos("onDisabled", () => api.onDisabled)
  })
}

export const layer = (api: ChromeManagementApi): Layer.Layer<ChromeManagement> =>
  Layer.succeed(ChromeManagement, make(api))

/**
 * The global is read only when the layer is built, never at import time. The namespace
 * exists without the "management" permission, so this builds and the gated calls fail.
 */
export const layerLive: Layer.Layer<ChromeManagement, ChromeManagementError> = liveLayer(
  ChromeManagement, "management", (chrome) => chrome.management, make,
  (cause) => new ChromeManagementError({ operation: "initialize", cause })
)
