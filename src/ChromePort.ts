import { Cause, Context, Effect, Layer, Option, Queue, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { liveLayer } from "./internal/api.js"
import * as PortLink from "./internal/port.js"

/** A port Chrome created: from `connect`, `connectNative`, `tabs.connect` or an `onConnect*` event. */
export type NativePort = chrome.runtime.Port

export type Ownership = "owned" | "borrowed"

/** The subset of `chrome.runtime` this module needs; importing it never accesses Chrome. */
export interface ChromePortApi {
  connect(connectInfo?: chrome.runtime.ConnectInfo): NativePort
  connect(extensionId: string, connectInfo?: chrome.runtime.ConnectInfo): NativePort
  /** Present only when the extension declares the `"nativeMessaging"` permission. */
  readonly connectNative?: (application: string) => NativePort
  /** Set by Chrome only while a callback runs; here, inside a port's `onDisconnect`. */
  readonly lastError: chrome.runtime.LastError | undefined
}

export class ChromePortError extends Schema.TaggedError<ChromePortError>()("ChromePortError", {
  /**
   * `"connect"` / `"connectNative"` (the Chrome call or the port's listener registration
   * failed), `"adopt"` (listener registration on a delivered port failed), `"send"`
   * (`postMessage`), `"disconnect"` (`disconnect`, or `onDisconnect` reporting `lastError`)
   * or `"initialize"` (no `chrome.runtime`).
   */
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.Defect()
}) {}

type Operation = "connect" | "connectNative" | "adopt" | "send" | "disconnect" | "initialize"

export interface Port {
  /** The name given to `connect` or `tabs.connect`; empty when none was given. */
  readonly name: string
  /**
   * Who opened the port. Chrome sets it only on ports passed to `onConnect`,
   * `onConnectExternal` or `onConnectNative`; it is untrusted until checked.
   */
  readonly sender: Option.Option<chrome.runtime.MessageSender>
  /**
   * The port's `onMessage` events, ending with its `onDisconnect`. Unlike the observational
   * `on*` streams of other modules, this is a single-consumer stream (concurrent consumers
   * compete, not broadcast) whose listeners are installed during acquisition, so messages
   * arriving before it is consumed are kept. Each pull takes a single message, so a consumer
   * that stops early (`runHead`, `take`, interruption) leaves the rest buffered for the next
   * consumption. The buffer holds 64 messages, dropping the
   * oldest on overflow. A clean disconnect drains buffered messages then ends; a disconnect
   * reporting `lastError` drains them then fails with operation `"disconnect"`.
   * Closing the acquisition scope discards the buffer and interrupts consumers.
   */
  readonly messages: Stream.Stream<unknown, ChromePortError>
  /**
   * Chrome's `postMessage`: JSON-serializes `message` for the other end. Fails with
   * operation `"send"`, or with the disconnect error Chrome reported, once the port is closed.
   */
  readonly send: (message: unknown) => Effect.Effect<void, ChromePortError>
  /**
   * Closes this wrapper; disconnects the native port only when owned, and Chrome then fires
   * `onDisconnect` only at the other end. Idempotent: only the first attempt can fail.
   * Explicit disconnect failures are typed; automatic scope release performs best-effort
   * cleanup.
   */
  readonly disconnect: Effect.Effect<void, ChromePortError>
}

export interface ConnectOptions {
  /** The extension to connect to; this extension when omitted. */
  readonly extensionId?: string
  /** The port's name, as the other end's `onConnect` / `onConnectExternal` sees it. */
  readonly name?: string
  /** Whether Chrome passes the TLS channel id to the other extension's `onConnectExternal`. */
  readonly includeTlsChannelId?: boolean
}

export interface ChromePortService {
  /**
   * Opens an owned port to this extension, or to `extensionId`, released with the scope.
   * Chrome returns a port even when nothing listens, then disconnects it with `lastError`
   * ("Receiving end does not exist"), failing `messages`.
   */
  readonly connect: (options?: ConnectOptions) => Effect.Effect<Port, ChromePortError, Scope.Scope>
  /**
   * Opens an owned port to the native messaging host `application`, released with the scope.
   * Needs the `"nativeMessaging"` permission; without it Chrome has no `connectNative` and
   * this fails with operation `"connectNative"`. A missing or exiting host disconnects the
   * port with `lastError`.
   */
  readonly connectNative: (application: string) => Effect.Effect<Port, ChromePortError, Scope.Scope>
  /**
   * Wraps a port Chrome delivered (`onConnect`, `onConnectExternal`, `tabs.connect`).
   * Ownership is mandatory: a borrowed port is never disconnected by the wrapper.
   */
  readonly adopt: (port: NativePort, ownership: Ownership) => Effect.Effect<Port, ChromePortError, Scope.Scope>
}

export class ChromePort extends Context.Service<ChromePort, ChromePortService>()("effect-platform-chrome/ChromePort") {}

const error = (operation: Operation, cause: unknown, message: string) =>
  new ChromePortError({ operation, cause, message })

const acquire = (
  api: ChromePortApi,
  getPort: () => NativePort,
  ownership: Ownership,
  operation: "connect" | "connectNative" | "adopt"
): Effect.Effect<Port, ChromePortError, Scope.Scope> => Effect.acquireRelease(
  Effect.gen(function*() {
    const queue = yield* Queue.make<unknown, ChromePortError | Cause.Done>({ capacity: 64, strategy: "sliding" })

    return yield* Effect.try({
      try: () => {
        const native = getPort()
        let disconnectError: ChromePortError | undefined

        const fail = (failure: ChromePortError) => {
          disconnectError = failure
          Queue.failCauseUnsafe(queue, Cause.fail(failure))
        }

        const link: PortLink.Link = PortLink.make(native, ownership, () => api.lastError, {
          onMessage: (message) => { Queue.offerUnsafe(queue, message) },
          onDisconnect: (lastError) => {
            if (lastError !== undefined) {
              const message = lastError.message ?? "Chrome port disconnected with an error"
              fail(error("disconnect", { message }, message))
            } else {
              Queue.endUnsafe(queue)
            }

            // A removal failure must not escape into Chrome's event dispatch.
            try { link.detach() } catch { /* The disconnect is already delivered. */ }
          }
        })

        const disconnect = Effect.try({
          try: () => {
            if (!link.isOpen()) return

            try {
              link.disconnect()
            } catch (cause) {
              const failure = error("disconnect", cause, "Chrome port disconnect failed")
              link.close()
              fail(failure)

              try { link.detach() } catch { /* Preserve the native disconnect failure. */ }

              throw failure
            }

            // A native disconnect may report its own lastError synchronously, closing the link.
            if (link.close()) {
              Queue.endUnsafe(queue)
              link.detach()
            }

            if (disconnectError !== undefined) throw disconnectError
          },
          catch: (cause) => cause instanceof ChromePortError
            ? cause
            : error("disconnect", cause, "Chrome port disconnect failed")
        })

        const release = Effect.sync(() => {
          const wasOpen = link.close()

          try { link.detach() } catch { /* Finalizers must not mask the scope's exit. */ }

          Queue.shutdownUnsafe(queue)

          // A port Chrome or an explicit disconnect already closed is not disconnected again.
          if (wasOpen) {
            try { link.disconnect() } catch { /* Best-effort native release. */ }
          }
        })

        // Read before registering: once listeners are attached, a throw here would leak them.
        let name: string
        let sender: Option.Option<chrome.runtime.MessageSender>

        try {
          name = native.name
          sender = Option.fromNullishOr(native.sender)
        } catch (cause) {
          Queue.shutdownUnsafe(queue)

          try { link.disconnect() } catch { /* Preserve the property failure. */ }

          throw cause
        }

        try {
          link.register()
        } catch (cause) {
          Queue.shutdownUnsafe(queue)

          throw cause
        }

        const port: Port = {
          name,
          sender,
          // One message per pull: a consumer that stops early (`runHead`, `take`, interruption)
          // leaves the rest buffered for the next one, instead of discarding a taken batch.
          messages: Stream.fromEffectRepeat(Queue.take(queue)),
          send: (message) => Effect.try({
            try: () => {
              if (!link.isOpen()) throw disconnectError ?? error("send", undefined, "Chrome port is closed")
              native.postMessage(message)
            },
            catch: (cause) => cause instanceof ChromePortError
              ? cause
              : error("send", cause, "Chrome port postMessage failed")
          }),
          disconnect
        }

        return { port, release }
      },
      catch: (cause) => error(operation, cause, `Chrome port ${operation} failed`)
    })
  }),
  ({ release }) => release
).pipe(Effect.map(({ port }) => port))

/** The `connectInfo` Chrome receives, or none when no field is given. */
const connectInfo = ({ name, includeTlsChannelId }: ConnectOptions): chrome.runtime.ConnectInfo | undefined => {
  if (name === undefined && includeTlsChannelId === undefined) return undefined

  const info: chrome.runtime.ConnectInfo = {}

  if (name !== undefined) info.name = name

  if (includeTlsChannelId !== undefined) info.includeTlsChannelId = includeTlsChannelId

  return info
}

/** Creates the service without reading browser globals or opening ports. */
export const make = (api: ChromePortApi): ChromePortService => ChromePort.of({
  connect: (options = {}) => acquire(api, () => {
    const info = connectInfo(options)

    if (options.extensionId === undefined) return info === undefined ? api.connect() : api.connect(info)

    return info === undefined ? api.connect(options.extensionId) : api.connect(options.extensionId, info)
  }, "owned", "connect"),
  connectNative: (application) => acquire(api, () => {
    if (api.connectNative === undefined) {
      throw new Error("chrome.runtime.connectNative is unavailable; it needs the nativeMessaging permission")
    }

    return api.connectNative(application)
  }, "owned", "connectNative"),
  adopt: (port, ownership) => acquire(api, () => port, ownership, "adopt")
})

export const layer = (api: ChromePortApi): Layer.Layer<ChromePort> => Layer.succeed(ChromePort, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromePort, ChromePortError> = liveLayer(
  ChromePort, "runtime", (chrome) => chrome.runtime, make,
  (cause) => error("initialize", cause, "Chrome runtime is unavailable")
)
