import { Context, Effect, Layer, Schema, Stream } from "effect"
import { decodeResponse, type ChromeMessageError } from "./ChromeMessage.js"
import { attempter, invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

/**
 * A failed `chrome.runtime` call or event registration. `operation` is the Chrome member
 * name (`"getContexts"`, `"onMessage"`), or `"initialize"` when `chrome.runtime` is missing.
 * The schema helpers add two phases of `sendMessage`: `"sendMessage.encodeRequest"` when
 * the message does not encode (nothing is sent) and `"sendMessage.decodeResponse"` when the
 * reply does not decode.
 */
export class ChromeRuntimeError extends Schema.TaggedError<ChromeRuntimeError>()("ChromeRuntimeError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** The arguments Chrome passes to `onMessage`-style listeners. */
export type MessageListenerArguments = [
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
]

/** A value native messaging can carry: Chrome serializes it as JSON. */
export type JsonValue = string | number | boolean | null | ReadonlyArray<JsonValue> | { readonly [key: string]: JsonValue }

/** A native messaging message: Chrome requires a JSON object. */
export interface NativeMessage {
  readonly [key: string]: JsonValue
}

export type RestartRequiredReason = `${chrome.runtime.OnRestartRequiredReason}`

/**
 * The Promise-based MV3 `chrome.runtime` subset. Members that only exist in some Chrome
 * versions, platforms or contexts are optional so injected APIs without them still fit;
 * using one that is absent fails with the typed error. Content scripts get little more than `id`,
 * `getManifest`, `getURL`, `sendMessage`, `onMessage` and `onConnect`;
 * anything else fails there with the typed error too.
 */
export interface ChromeRuntimeApi {
  /** Undefined once this context is invalidated, as in a content script orphaned by an extension reload. */
  readonly id: string | undefined
  getManifest(): chrome.runtime.Manifest
  getURL(path: string): string
  /** Chrome 143+. */
  readonly getVersion?: () => string
  /**
   * The Promise overloads. With two arguments Chrome reads `(extensionId, message)` only
   * when the first is a string or null, and `(message, options)` otherwise, so `make`
   * sends options without an extension id as three arguments with an `undefined` id.
   */
  sendMessage(message: unknown, options?: chrome.runtime.MessageOptions): Promise<unknown>
  sendMessage(
    extensionId: string | undefined | null,
    message: unknown,
    options?: chrome.runtime.MessageOptions
  ): Promise<unknown>
  sendNativeMessage(application: string, message: NativeMessage): Promise<unknown>
  getContexts(filter: chrome.runtime.ContextFilter): Promise<Array<chrome.runtime.ExtensionContext>>
  /** Extension pages only (Chrome 122+ for the Promise form); absent in service workers. */
  readonly getPackageDirectoryEntry?: () => Promise<DirectoryEntry>
  openOptionsPage(): Promise<void>
  reload(): void
  restart(): void
  restartAfterDelay(seconds: number): Promise<void>
  setUninstallURL(url: string): Promise<void>
  getPlatformInfo(): Promise<chrome.runtime.PlatformInfo>
  requestUpdateCheck(): Promise<chrome.runtime.RequestUpdateCheckResult>
  readonly onInstalled: EventSource<[details: chrome.runtime.InstalledDetails]>
  readonly onStartup: EventSource<[]>
  readonly onUpdateAvailable: EventSource<[details: chrome.runtime.UpdateAvailableDetails]>
  readonly onSuspend: EventSource<[]>
  readonly onSuspendCanceled: EventSource<[]>
  readonly onRestartRequired: EventSource<[reason: RestartRequiredReason]>
  /** Chrome 155+. */
  readonly onEnabled?: EventSource<[]>
  readonly onMessage: EventSource<MessageListenerArguments>
  readonly onMessageExternal: EventSource<MessageListenerArguments>
  /** Chrome 115+, with the `"userScripts"` permission. */
  readonly onUserScriptMessage?: EventSource<MessageListenerArguments>
  readonly onConnect: EventSource<[port: chrome.runtime.Port]>
  readonly onConnectExternal: EventSource<[port: chrome.runtime.Port]>
  /** ChromeOS only, with the `"nativeMessaging"` permission. */
  readonly onConnectNative?: EventSource<[port: chrome.runtime.Port]>
  /** Chrome 115+, with the `"userScripts"` permission. */
  readonly onUserScriptConnect?: EventSource<[port: chrome.runtime.Port]>
}

/** A one-off message a stream observed, with its sender; untrusted until `sender` is checked. */
export interface ReceivedMessage {
  readonly message: unknown
  readonly sender: chrome.runtime.MessageSender
}

export interface SendMessageOptions {
  /** Another extension to message; without it the message goes to this extension. */
  readonly extensionId?: string
  readonly options?: chrome.runtime.MessageOptions
}

export interface ChromeRuntimeService {
  /** This extension's id; fails once the context is invalidated (an orphaned content script). */
  readonly id: Effect.Effect<string, ChromeRuntimeError>
  /** The parsed manifest. */
  readonly getManifest: Effect.Effect<chrome.runtime.Manifest, ChromeRuntimeError>
  /** The `chrome-extension://` URL of a path inside the extension package. */
  readonly getURL: (path: string) => Effect.Effect<string, ChromeRuntimeError>
  /** Chrome 143+: the manifest `version`. */
  readonly getVersion: Effect.Effect<string, ChromeRuntimeError>
  /**
   * Sends one message to this extension's `onMessage` listeners (every frame except the
   * sender's) or, with `extensionId`, to another extension's `onMessageExternal`. It never
   * reaches content scripts; use `ChromeTabs.sendMessage` for those. Succeeds with the first
   * listener's answer, unvalidated, and fails when nothing receives the message. Extension
   * id and options reach Chrome only when given.
   */
  readonly sendMessage: (
    message: unknown,
    options?: SendMessageOptions
  ) => Effect.Effect<unknown, ChromeRuntimeError>
  /**
   * `sendMessage` with an encoded request and a decoded reply. An invalid message fails
   * with `"sendMessage.encodeRequest"` before anything is sent; an invalid reply with
   * `"sendMessage.decodeResponse"`.
   */
  readonly sendMessageSchema: <Request extends Schema.Constraint, Response extends Schema.Constraint>(
    request: Request,
    response: Response,
    message: Request["Type"],
    options?: SendMessageOptions
  ) => Effect.Effect<Response["Type"], ChromeRuntimeError, Request["EncodingServices"] | Response["DecodingServices"]>
  /**
   * Like `sendMessageSchema`, for a receiver that answers with the ChromeMessage envelope,
   * as `ChromeServiceWorker.start` does: the reply is unwrapped and its value decoded with
   * `value`. A failure envelope fails with `ChromeMessageError`; anything that is not an
   * envelope of `value` (including no answer) with `"sendMessage.decodeResponse"`.
   */
  readonly request: <Request extends Schema.Constraint, Value extends Schema.Constraint>(
    request: Request,
    value: Value,
    message: Request["Type"],
    options?: SendMessageOptions
  ) => Effect.Effect<
    Value["Type"],
    ChromeRuntimeError | ChromeMessageError,
    Request["EncodingServices"] | Value["DecodingServices"]
  >
  /**
   * Sends one message to a native messaging host, starting it for this message only. Needs
   * the `"nativeMessaging"` permission. The reply is unvalidated.
   */
  readonly sendNativeMessage: (application: string, message: NativeMessage) => Effect.Effect<unknown, ChromeRuntimeError>
  /**
   * The extension contexts (service worker, tabs, popups, offscreen documents, side panels,
   * developer tools) matching every given filter field; `{}` matches all of them. Chrome 116+.
   */
  readonly getContexts: (
    filter: chrome.runtime.ContextFilter
  ) => Effect.Effect<Array<chrome.runtime.ExtensionContext>, ChromeRuntimeError>
  /** The package directory as a legacy FileSystem entry. Extension pages only, not service workers. */
  readonly getPackageDirectoryEntry: Effect.Effect<DirectoryEntry, ChromeRuntimeError>
  /** Opens the options page, or focuses it if already open. Fails when the manifest declares none. */
  readonly openOptionsPage: Effect.Effect<void, ChromeRuntimeError>
  /**
   * Restarts the extension, applying a pending update. Every extension context is torn
   * down, the calling one included, so nothing after this Effect is guaranteed to run.
   * Not supported in kiosk mode; use `restart` there.
   */
  readonly reload: Effect.Effect<void, ChromeRuntimeError>
  /** Restarts the ChromeOS device when running as a kiosk app; does nothing otherwise. */
  readonly restart: Effect.Effect<void, ChromeRuntimeError>
  /**
   * Schedules a kiosk-mode ChromeOS device restart in `seconds`, postponing an earlier
   * schedule; `-1` cancels it. Does nothing outside kiosk mode. Only the first extension to
   * call it may call it again.
   */
  readonly restartAfterDelay: (seconds: number) => Effect.Effect<void, ChromeRuntimeError>
  /**
   * The http(s) URL Chrome opens after uninstall, at most 1023 characters; an empty string
   * clears it. Chrome fails the call for other schemes or longer URLs.
   */
  readonly setUninstallURL: (url: string) => Effect.Effect<void, ChromeRuntimeError>
  readonly getPlatformInfo: Effect.Effect<chrome.runtime.PlatformInfo, ChromeRuntimeError>
  /**
   * Asks the update server for a new version. Chrome throttles frequent checks (status
   * `"throttled"`); an available update installs on the next idle restart or `reload`.
   */
  readonly requestUpdateCheck: Effect.Effect<chrome.runtime.RequestUpdateCheckResult, ChromeRuntimeError>
  /**
   * Observational subscriptions: listeners exist only while the stream runs, so they cannot
   * wake an MV3 service worker. Register wake listeners synchronously through
   * ChromeServiceWorker instead. Each subscriber has a bounded 64-event sliding buffer;
   * overflow discards the oldest event. An event missing in this context (an older Chrome,
   * another platform, a content script) fails with the typed error.
   *
   * Install, extension update, Chrome update or shared module update.
   */
  readonly onInstalled: Stream.Stream<chrome.runtime.InstalledDetails, ChromeRuntimeError>
  /** A profile with this extension started; not fired for incognito profiles. */
  readonly onStartup: Stream.Stream<void, ChromeRuntimeError>
  /** An update was downloaded and waits for the extension to go idle or `reload`. */
  readonly onUpdateAvailable: Stream.Stream<chrome.runtime.UpdateAvailableDetails, ChromeRuntimeError>
  /**
   * The context is about to unload. Asynchronous work started from here is not guaranteed
   * to finish before Chrome stops the worker.
   */
  readonly onSuspend: Stream.Stream<void, ChromeRuntimeError>
  /** Activity after `onSuspend` kept the context alive after all. */
  readonly onSuspendCanceled: Stream.Stream<void, ChromeRuntimeError>
  /**
   * ChromeOS kiosk apps only: the app or device must restart, within a 24-hour grace period
   * before Chrome enforces it.
   */
  readonly onRestartRequired: Stream.Stream<RestartRequiredReason, ChromeRuntimeError>
  /** Chrome 155+: the extension went from disabled to enabled. */
  readonly onEnabled: Stream.Stream<void, ChromeRuntimeError>
  /**
   * Messages from `runtime.sendMessage` or `tabs.sendMessage` reaching this context. The
   * listener never answers, leaving the response channel to other listeners, but its
   * presence means a sender to a context with no other listener gets no answer instead of
   * a missing-receiver failure. Answering needs a native listener registered synchronously,
   * such as `ChromeServiceWorker.start`'s.
   */
  readonly onMessage: Stream.Stream<ReceivedMessage, ChromeRuntimeError>
  /**
   * Messages from other extensions or externally connectable pages; like `onMessage` it never
   * answers (a native `runtime.onMessageExternal` listener calling `sendResponse` must).
   * Check `sender.id` / `sender.origin` before trusting a message.
   */
  readonly onMessageExternal: Stream.Stream<ReceivedMessage, ChromeRuntimeError>
  /** Chrome 115+, `"userScripts"` permission: messages from this extension's user scripts. Never answers. */
  readonly onUserScriptMessage: Stream.Stream<ReceivedMessage, ChromeRuntimeError>
  /**
   * Ports opened to this context with `runtime.connect` (or `tabs.connect`, in a content
   * script). Every listener receives the same port: wrap it with `ChromePort.adopt`, as
   * `"borrowed"` when another listener owns it.
   */
  readonly onConnect: Stream.Stream<chrome.runtime.Port, ChromeRuntimeError>
  /** Ports opened by other extensions or externally connectable pages; `sender` is untrusted until checked. */
  readonly onConnectExternal: Stream.Stream<chrome.runtime.Port, ChromeRuntimeError>
  /** ChromeOS only, `"nativeMessaging"` permission: ports opened by a native application. */
  readonly onConnectNative: Stream.Stream<chrome.runtime.Port, ChromeRuntimeError>
  /** Chrome 115+, `"userScripts"` permission: ports opened by this extension's user scripts. */
  readonly onUserScriptConnect: Stream.Stream<chrome.runtime.Port, ChromeRuntimeError>
}

export class ChromeRuntime extends Context.Service<ChromeRuntime, ChromeRuntimeService>()(
  "effect-platform-chrome/ChromeRuntime"
) {}

const runtimeError = (operation: string, cause: unknown) => new ChromeRuntimeError({ operation, cause })

const attempt = attempter(runtimeError)

const invoke = invoker(runtimeError)

const unavailable = (member: string) => new Error(`chrome.runtime.${member} is unavailable in this context`)

/** Fails with the typed error when Chrome leaves `value` out, as for a member this context lacks. */
const present = <A>(member: string, value: A | undefined): A => {
  if (value === undefined) throw unavailable(member)

  return value
}

/**
 * Observes a runtime event, failing with the typed error when this context lacks it (a
 * content script, an older Chrome) instead of failing to remove a listener it never added.
 */
const runtimeEvent = <Args extends ReadonlyArray<unknown>, A>(
  operation: string,
  getSource: () => EventSource<Args> | undefined,
  project: (...args: Args) => A
): Stream.Stream<A, ChromeRuntimeError> =>
  observe(() => present(operation, getSource()), project, (cause) => runtimeError(operation, cause))

// The listener returns nothing, so it never claims the response channel.
const received = (message: unknown, sender: chrome.runtime.MessageSender): ReceivedMessage => ({ message, sender })

const voidEvent = () => undefined

const port = (value: chrome.runtime.Port) => value

/** Creates the service without reading browser globals or registering listeners. */
export const make = (runtime: ChromeRuntimeApi): ChromeRuntimeService => {
  const sendMessage: ChromeRuntimeService["sendMessage"] = (message, options) =>
    invoke("sendMessage", () => {
      const extensionId = options?.extensionId
      const messageOptions = options?.options

      if (messageOptions !== undefined) return runtime.sendMessage(extensionId, message, messageOptions)

      return extensionId === undefined ? runtime.sendMessage(message) : runtime.sendMessage(extensionId, message)
    })

  const sendMessageSchema: ChromeRuntimeService["sendMessageSchema"] = Effect.fnUntraced(function*<
    Request extends Schema.Constraint,
    Response extends Schema.Constraint
  >(request: Request, response: Response, message: Request["Type"], options?: SendMessageOptions) {
    const encoded = yield* Schema.encodeEffect(request)(message).pipe(
      Effect.mapError((cause) => runtimeError("sendMessage.encodeRequest", cause))
    )

    const result = yield* sendMessage(encoded, options)

    return yield* Schema.decodeUnknownEffect(response)(result).pipe(
      Effect.mapError((cause) => runtimeError("sendMessage.decodeResponse", cause))
    )
  })

  const request: ChromeRuntimeService["request"] = (requestSchema, value, message, options) =>
    sendMessageSchema(requestSchema, Schema.Unknown, message, options).pipe(
      Effect.flatMap(decodeResponse(value)),
      Effect.catchTag("SchemaError", (cause) => Effect.fail(runtimeError("sendMessage.decodeResponse", cause)))
    )

  return ChromeRuntime.of({
    id: attempt("id", () => present("id", runtime.id)),
    getManifest: attempt("getManifest", () => runtime.getManifest()),
    getURL: (path) => attempt("getURL", () => runtime.getURL(path)),
    getVersion: attempt("getVersion", () => {
      if (runtime.getVersion === undefined) throw unavailable("getVersion")

      return runtime.getVersion()
    }),
    sendMessage,
    sendMessageSchema,
    request,
    sendNativeMessage: (application, message) =>
      invoke("sendNativeMessage", () => runtime.sendNativeMessage(application, message)),
    getContexts: (filter) => invoke("getContexts", () => runtime.getContexts(filter)),
    getPackageDirectoryEntry: invoke("getPackageDirectoryEntry", () => runtime.getPackageDirectoryEntry === undefined
      ? Promise.reject(unavailable("getPackageDirectoryEntry"))
      : runtime.getPackageDirectoryEntry()),
    openOptionsPage: invoke("openOptionsPage", () => runtime.openOptionsPage()),
    reload: attempt("reload", () => runtime.reload()),
    restart: attempt("restart", () => runtime.restart()),
    restartAfterDelay: (seconds) => invoke("restartAfterDelay", () => runtime.restartAfterDelay(seconds)),
    setUninstallURL: (url) => invoke("setUninstallURL", () => runtime.setUninstallURL(url)),
    getPlatformInfo: invoke("getPlatformInfo", () => runtime.getPlatformInfo()),
    requestUpdateCheck: invoke("requestUpdateCheck", () => runtime.requestUpdateCheck()),
    onInstalled: runtimeEvent("onInstalled", () => runtime.onInstalled, (details) => details),
    onStartup: runtimeEvent("onStartup", () => runtime.onStartup, voidEvent),
    onUpdateAvailable: runtimeEvent("onUpdateAvailable", () => runtime.onUpdateAvailable, (details) => details),
    onSuspend: runtimeEvent("onSuspend", () => runtime.onSuspend, voidEvent),
    onSuspendCanceled: runtimeEvent("onSuspendCanceled", () => runtime.onSuspendCanceled, voidEvent),
    onRestartRequired: runtimeEvent("onRestartRequired", () => runtime.onRestartRequired, (reason) => reason),
    onEnabled: runtimeEvent("onEnabled", () => runtime.onEnabled, voidEvent),
    onMessage: runtimeEvent("onMessage", () => runtime.onMessage, received),
    onMessageExternal: runtimeEvent("onMessageExternal", () => runtime.onMessageExternal, received),
    onUserScriptMessage: runtimeEvent("onUserScriptMessage", () => runtime.onUserScriptMessage, received),
    onConnect: runtimeEvent("onConnect", () => runtime.onConnect, port),
    onConnectExternal: runtimeEvent("onConnectExternal", () => runtime.onConnectExternal, port),
    onConnectNative: runtimeEvent("onConnectNative", () => runtime.onConnectNative, port),
    onUserScriptConnect: runtimeEvent("onUserScriptConnect", () => runtime.onUserScriptConnect, port)
  })
}

export const layer = (api: ChromeRuntimeApi): Layer.Layer<ChromeRuntime> => Layer.succeed(ChromeRuntime, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeRuntime, ChromeRuntimeError> = liveLayer(
  ChromeRuntime, "runtime", (chrome) => chrome.runtime, make,
  (cause) => new ChromeRuntimeError({ operation: "initialize", cause })
)
