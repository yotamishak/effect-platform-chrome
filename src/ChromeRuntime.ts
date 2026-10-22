import { Context, Effect, Layer, Schema, Stream } from "effect"
import { decodeResponse, type ChromeMessageError } from "./ChromeMessage.js"
import { attempter, invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeRuntimeError extends Schema.TaggedError<ChromeRuntimeError>()("ChromeRuntimeError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** The MV3 subset this module needs, with the Promise overload of `sendMessage` (Chrome 99+). */
export interface ChromeRuntimeApi {
  readonly id: string
  getManifest(): chrome.runtime.Manifest
  getURL(path: string): string
  sendMessage(
    extensionId: string | undefined | null,
    message: unknown,
    options?: chrome.runtime.MessageOptions
  ): Promise<unknown>
  getContexts(filter: chrome.runtime.ContextFilter): Promise<Array<chrome.runtime.ExtensionContext>>
  openOptionsPage(): Promise<void>
  reload(): void
  setUninstallURL(url: string): Promise<void>
  getPlatformInfo(): Promise<chrome.runtime.PlatformInfo>
  requestUpdateCheck(): Promise<chrome.runtime.RequestUpdateCheckResult>
  readonly onInstalled: EventSource<[details: chrome.runtime.InstalledDetails]>
  readonly onStartup: EventSource<[]>
  readonly onUpdateAvailable: EventSource<[details: chrome.runtime.UpdateAvailableDetails]>
  readonly onSuspend: EventSource<[]>
  readonly onMessageExternal: EventSource<[
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ]>
  readonly onConnectExternal: EventSource<[port: chrome.runtime.Port]>
}

/** A message from another extension or an externally connectable web page. */
export interface ExternalMessage {
  readonly message: unknown
  readonly sender: chrome.runtime.MessageSender
}

export interface SendMessageOptions {
  readonly extensionId?: string
  readonly options?: chrome.runtime.MessageOptions
}

export interface ChromeRuntimeService {
  readonly id: Effect.Effect<string, ChromeRuntimeError>
  readonly getManifest: Effect.Effect<chrome.runtime.Manifest, ChromeRuntimeError>
  readonly getURL: (path: string) => Effect.Effect<string, ChromeRuntimeError>
  readonly sendMessage: (
    message: unknown,
    options?: SendMessageOptions
  ) => Effect.Effect<unknown, ChromeRuntimeError>
  readonly sendMessageSchema: <Request extends Schema.Constraint, Response extends Schema.Constraint>(
    request: Request,
    response: Response,
    message: Request["Type"],
    options?: SendMessageOptions
  ) => Effect.Effect<Response["Type"], ChromeRuntimeError, Request["EncodingServices"] | Response["DecodingServices"]>
  /**
   * Like `sendMessageSchema`, for a receiver that answers with the ChromeMessage envelope,
   * as `ChromeServiceWorker.start` does: the reply is unwrapped and its value decoded with
   * `value`. A failure envelope fails with `ChromeMessageError`.
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
   * Observational subscriptions: listeners exist only while the stream runs.
   * These cannot reliably wake an MV3 service worker. Register wake listeners
   * synchronously through ChromeServiceWorker instead. Each subscriber has a
   * bounded 64-event sliding buffer; overflow discards the oldest event.
   */
  readonly onInstalled: Stream.Stream<chrome.runtime.InstalledDetails, ChromeRuntimeError>
  readonly onStartup: Stream.Stream<void, ChromeRuntimeError>
  /**
   * The extension contexts (service worker, tabs, popups, offscreen documents, side panels)
   * matching every given filter field; `{}` matches all of them. Chrome 116+ in MV3.
   */
  readonly getContexts: (
    filter: chrome.runtime.ContextFilter
  ) => Effect.Effect<Array<chrome.runtime.ExtensionContext>, ChromeRuntimeError>
  /** Opens the options page, or focuses it if already open. Fails when the manifest declares none. */
  readonly openOptionsPage: Effect.Effect<void, ChromeRuntimeError>
  /**
   * Restarts the extension, applying a pending update. Every extension context is torn
   * down, the calling one included, so nothing after this Effect is guaranteed to run.
   */
  readonly reload: Effect.Effect<void, ChromeRuntimeError>
  /** The URL Chrome opens after uninstall; an empty string clears it. Chrome caps it at 1023 characters. */
  readonly setUninstallURL: (url: string) => Effect.Effect<void, ChromeRuntimeError>
  readonly getPlatformInfo: Effect.Effect<chrome.runtime.PlatformInfo, ChromeRuntimeError>
  /**
   * Asks the update server for a new version. Chrome throttles frequent checks (status
   * `"throttled"`); an available update installs on the next idle restart or `reload`.
   */
  readonly requestUpdateCheck: Effect.Effect<chrome.runtime.RequestUpdateCheckResult, ChromeRuntimeError>
  /** An update was downloaded and waits for the extension to go idle or `reload`. Observational, like `onInstalled`. */
  readonly onUpdateAvailable: Stream.Stream<chrome.runtime.UpdateAvailableDetails, ChromeRuntimeError>
  /**
   * The context is about to unload. Observational, like `onInstalled`; asynchronous work
   * started from here is not guaranteed to finish before Chrome stops the worker.
   */
  readonly onSuspend: Stream.Stream<void, ChromeRuntimeError>
  /**
   * Messages from other extensions or externally connectable pages, with their sender.
   * Observational only: this stream never answers, leaving the response channel to other
   * listeners. Answering an external message needs a native `runtime.onMessageExternal`
   * listener registered synchronously at worker startup that calls `sendResponse`
   * (returning true to answer asynchronously); `ChromeServiceWorker.listen` handlers cannot
   * reply either. Check `sender.id` / `sender.origin` before trusting a message.
   */
  readonly onMessageExternal: Stream.Stream<ExternalMessage, ChromeRuntimeError>
  /**
   * Ports opened by other extensions or externally connectable pages. Observational, like
   * `onInstalled`; to wake the worker for them use `ChromeServiceWorker.listen`. Wrap a port
   * with `ChromePort.adopt` to message over it; its `sender` is untrusted until checked.
   */
  readonly onConnectExternal: Stream.Stream<chrome.runtime.Port, ChromeRuntimeError>
}

export class ChromeRuntime extends Context.Service<ChromeRuntime, ChromeRuntimeService>()(
  "effect-platform-chrome/ChromeRuntime"
) {}

const attempt = attempter((operation, cause) => new ChromeRuntimeError({ operation, cause }))

const invoke = invoker((operation, cause) => new ChromeRuntimeError({ operation, cause }))

const eventError = (operation: string) => (cause: unknown) => new ChromeRuntimeError({ operation, cause })

/** Creates the service without reading browser globals or registering listeners. */
export const make = (runtime: ChromeRuntimeApi): ChromeRuntimeService => {
  const sendMessage: ChromeRuntimeService["sendMessage"] = (message, options) =>
    invoke("sendMessage", () => runtime.sendMessage(options?.extensionId, message, options?.options))

  const sendMessageSchema: ChromeRuntimeService["sendMessageSchema"] = Effect.fnUntraced(function*<
    Request extends Schema.Constraint,
    Response extends Schema.Constraint
  >(request: Request, response: Response, message: Request["Type"], options?: SendMessageOptions) {
    const encoded = yield* Schema.encodeEffect(request)(message).pipe(
      Effect.mapError((cause) => new ChromeRuntimeError({ operation: "sendMessage.encodeRequest", cause }))
    )

    const result = yield* sendMessage(encoded, options)

    return yield* Schema.decodeUnknownEffect(response)(result).pipe(
      Effect.mapError((cause) => new ChromeRuntimeError({ operation: "sendMessage.decodeResponse", cause }))
    )
  })

  const request: ChromeRuntimeService["request"] = (requestSchema, value, message, options) =>
    sendMessageSchema(requestSchema, Schema.Unknown, message, options).pipe(
      Effect.flatMap(decodeResponse(value)),
      Effect.catchTag("SchemaError", (cause) => Effect.fail(new ChromeRuntimeError({ operation: "sendMessage.decodeResponse", cause })))
    )

  return ChromeRuntime.of({
    id: attempt("id", () => runtime.id),
    getManifest: attempt("getManifest", () => runtime.getManifest()),
    getURL: (path) => attempt("getURL", () => runtime.getURL(path)),
    sendMessage,
    sendMessageSchema,
    request,
    onInstalled: observe(() => runtime.onInstalled, (details) => details, eventError("onInstalled")),
    onStartup: observe(() => runtime.onStartup, () => undefined, eventError("onStartup")),
    getContexts: (filter) => invoke("getContexts", () => runtime.getContexts(filter)),
    openOptionsPage: invoke("openOptionsPage", () => runtime.openOptionsPage()),
    reload: attempt("reload", () => runtime.reload()),
    setUninstallURL: (url) => invoke("setUninstallURL", () => runtime.setUninstallURL(url)),
    getPlatformInfo: invoke("getPlatformInfo", () => runtime.getPlatformInfo()),
    requestUpdateCheck: invoke("requestUpdateCheck", () => runtime.requestUpdateCheck()),
    onUpdateAvailable: observe(() => runtime.onUpdateAvailable, (details) => details, eventError("onUpdateAvailable")),
    onSuspend: observe(() => runtime.onSuspend, () => undefined, eventError("onSuspend")),
    // The listener returns nothing, so it never claims the response channel.
    onMessageExternal: observe(
      () => runtime.onMessageExternal,
      (message, sender): ExternalMessage => ({ message, sender }),
      eventError("onMessageExternal")
    ),
    onConnectExternal: observe(() => runtime.onConnectExternal, (port) => port, eventError("onConnectExternal"))
  })
}

export const layer = (api: ChromeRuntimeApi): Layer.Layer<ChromeRuntime> => Layer.succeed(ChromeRuntime, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeRuntime, ChromeRuntimeError> = liveLayer(
  ChromeRuntime, "runtime", (chrome) => chrome.runtime, make,
  (cause) => new ChromeRuntimeError({ operation: "initialize", cause })
)
