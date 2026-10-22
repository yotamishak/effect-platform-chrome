import { Cause, Context, Effect, Layer, Queue, Schema, Stream } from "effect"
import type { Scope } from "effect"
import * as PortLink from "./internal/port.js"

/** The runtime API is injected; importing this module never accesses Chrome. */
export type RuntimeApi = Pick<typeof chrome.runtime, "connect" | "lastError">

export type NativePort = chrome.runtime.Port

export type Ownership = "owned" | "borrowed"

export class ChromePortError extends Schema.TaggedError<ChromePortError>()("ChromePortError", {
  operation: Schema.Literals(["connect", "adopt", "send", "disconnect", "unavailable"]),
  message: Schema.String,
  cause: Schema.Unknown
}) {}

export interface Port {
  readonly name: string
  /**
   * Single-consumer stream (concurrent consumers compete, not broadcast).
   * Listeners are installed during acquisition, before the stream is consumed.
   * The buffer holds 64 messages, dropping the oldest on overflow. A clean
   * disconnect drains buffered messages then ends; lastError fails the stream.
   * Closing the acquisition scope discards the buffer and interrupts consumers.
   */
  readonly messages: Stream.Stream<unknown, ChromePortError>
  readonly send: (message: unknown) => Effect.Effect<void, ChromePortError>
  /**
   * Closes this wrapper; disconnects the native port only when owned.
   * Idempotent: only the first attempt can fail. Explicit disconnect failures
   * are typed; automatic scope release performs best-effort cleanup.
   */
  readonly disconnect: Effect.Effect<void, ChromePortError>
}

export interface ConnectOptions {
  readonly extensionId?: string
  readonly name?: string
}

const error = (operation: ChromePortError["operation"], cause: unknown, message: string) =>
  new ChromePortError({ operation, cause, message })

const acquire = (
  api: RuntimeApi,
  getPort: () => NativePort,
  ownership: Ownership,
  operation: "connect" | "adopt"
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

            link.detach()
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

        try {
          link.register()
        } catch (cause) {
          Queue.shutdownUnsafe(queue)

          throw cause
        }

        const port: Port = {
          name: native.name,
          messages: Stream.fromQueue(queue),
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

export const make = (api: RuntimeApi) => ({
  connect: (options: ConnectOptions = {}): Effect.Effect<Port, ChromePortError, Scope.Scope> =>
    acquire(api, () => options.extensionId === undefined
      ? api.connect(options.name === undefined ? {} : { name: options.name })
      : api.connect(options.extensionId, options.name === undefined ? {} : { name: options.name }), "owned", "connect"),
  /** Ownership is mandatory: borrowed adoption never disconnects the native port. */
  adopt: (port: NativePort, ownership: Ownership): Effect.Effect<Port, ChromePortError, Scope.Scope> =>
    acquire(api, () => port, ownership, "adopt")
})

export class ChromePort extends Context.Service<ChromePort, ReturnType<typeof make>>()(
  "effect-platform-chrome/ChromePort"
) {
  static readonly layer = (api: RuntimeApi) => Layer.succeed(ChromePort, make(api))
  /** Chrome is looked up only when the layer is built, never at import time. */
  static readonly layerLive = Layer.effect(ChromePort, Effect.try({
    try: () => {
      if (typeof globalThis.chrome === "undefined" || globalThis.chrome.runtime === undefined) {
        throw new Error("Chrome runtime is unavailable")
      }

      return make(globalThis.chrome.runtime)
    },
    catch: (cause) => error("unavailable", cause, "Chrome runtime is unavailable")
  }))
}
