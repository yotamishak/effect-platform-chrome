import { Context, Effect, Layer, Queue, Schema, Stream } from "effect"

export class ChromeRuntimeError extends Schema.TaggedError<ChromeRuntimeError>()(
  "ChromeRuntimeError",
  { operation: Schema.String, cause: Schema.Unknown }
) {}

/** The Promise overload of runtime.sendMessage (Manifest V3 / Chrome 99+). */
export interface RuntimeApi {
  readonly id: string
  getManifest(): chrome.runtime.Manifest
  getURL(path: string): string
  sendMessage(
    extensionId: string | undefined | null,
    message: unknown,
    options?: chrome.runtime.MessageOptions
  ): Promise<unknown>
  readonly onInstalled: Pick<typeof chrome.runtime.onInstalled, "addListener" | "removeListener">
  readonly onStartup: Pick<typeof chrome.runtime.onStartup, "addListener" | "removeListener">
}

export interface SendMessageOptions {
  readonly extensionId?: string
  readonly options?: chrome.runtime.MessageOptions
}

export interface ChromeRuntime {
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
   * Observational subscriptions: listeners exist only while the stream runs.
   * These cannot reliably wake an MV3 service worker. Register wake listeners
   * synchronously through ChromeServiceWorker instead. Each subscriber has a
   * bounded 64-event sliding buffer; overflow discards the oldest event.
   */
  readonly onInstalled: Stream.Stream<chrome.runtime.InstalledDetails, ChromeRuntimeError>
  readonly onStartup: Stream.Stream<void, ChromeRuntimeError>
}

export const ChromeRuntime = Context.Service<ChromeRuntime>("effect-platform-chrome/ChromeRuntime")

const attempt = <A>(operation: string, body: () => A): Effect.Effect<A, ChromeRuntimeError> =>
  Effect.try({ try: body, catch: (cause) => new ChromeRuntimeError({ operation, cause }) })

/** Creates a service without accessing browser globals or registering listeners. */
export const make = (runtime: RuntimeApi): ChromeRuntime => {
  const sendMessage: ChromeRuntime["sendMessage"] = (message, options) => Effect.tryPromise({
    try: () => runtime.sendMessage(options?.extensionId, message, options?.options),
    catch: (cause) => new ChromeRuntimeError({ operation: "sendMessage", cause })
  })

  const sendMessageSchema: ChromeRuntime["sendMessageSchema"] = Effect.fnUntraced(function*<
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

  const onInstalled = Stream.callback<chrome.runtime.InstalledDetails, ChromeRuntimeError>((queue) =>
    Effect.gen(function*() {
      const listener = (details: chrome.runtime.InstalledDetails) => { Queue.offerUnsafe(queue, details) }

      // Register cleanup first, including for APIs that throw after partially adding.
      yield* Effect.addFinalizer(() => attempt("onInstalled.removeListener", () =>
        runtime.onInstalled.removeListener(listener)).pipe(Effect.orDie))
      yield* attempt("onInstalled.addListener", () => runtime.onInstalled.addListener(listener))
    }), { bufferSize: 64, strategy: "sliding" })

  const onStartup = Stream.callback<void, ChromeRuntimeError>((queue) =>
    Effect.gen(function*() {
      const listener = () => { Queue.offerUnsafe(queue, undefined) }

      yield* Effect.addFinalizer(() => attempt("onStartup.removeListener", () =>
        runtime.onStartup.removeListener(listener)).pipe(Effect.orDie))
      yield* attempt("onStartup.addListener", () => runtime.onStartup.addListener(listener))
    }), { bufferSize: 64, strategy: "sliding" })

  return ChromeRuntime.of({
    id: attempt("id", () => runtime.id),
    getManifest: attempt("getManifest", () => runtime.getManifest()),
    getURL: (path) => attempt("getURL", () => runtime.getURL(path)),
    sendMessage,
    sendMessageSchema,
    onInstalled,
    onStartup
  })
}

/** Accesses chrome.runtime only when the layer is built, never at import time. */
export const layer = Layer.effect(ChromeRuntime, attempt("runtime", () => make(globalThis.chrome.runtime)))

/** The same live layer as `layer`, under the name the other modules use. */
export const layerLive = layer
