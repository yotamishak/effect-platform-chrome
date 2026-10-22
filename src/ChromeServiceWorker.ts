import { Cause, Effect, Exit, Fiber, Layer, ManagedRuntime } from "effect"

/** Structural event interface, also suitable for injected test events. */
export interface ChromeEvent<Listener> {
  readonly addListener: (listener: Listener) => void
  readonly removeListener: (listener: Listener) => void
}

export type ErrorCode = "InitializationFailed" | "HandlerFailed" | "Overflow" | "Disposed"

export interface WorkerError {
  readonly code: ErrorCode
  readonly message: string
}

export type Response<A = unknown> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: WorkerError }

export type MessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: Response) => void
) => boolean

export interface ChromeApis {
  readonly runtime: {
    readonly onMessage?: ChromeEvent<MessageListener>
    readonly onConnect?: ChromeEvent<(port: chrome.runtime.Port) => void>
    readonly onInstalled?: ChromeEvent<(details: chrome.runtime.InstalledDetails) => void>
    readonly onStartup?: ChromeEvent<() => void>
  }
  readonly alarms?: { readonly onAlarm: ChromeEvent<(alarm: chrome.alarms.Alarm) => void> }
}

export interface Handlers<R, E = never> {
  /**
   * One-off `runtime.sendMessage` handling; give both or neither. A worker whose messaging is
   * all over ports (ChromeRpc) leaves both out, and no `onMessage` listener is installed.
   * Routing only, not validation. Must be synchronous; false leaves the channel unclaimed.
   */
  readonly selectMessage?: (message: unknown, sender: chrome.runtime.MessageSender) => boolean
  readonly onMessage?: (message: unknown, sender: chrome.runtime.MessageSender) => Effect.Effect<unknown, E, R>
  readonly onConnect?: (port: chrome.runtime.Port) => Effect.Effect<unknown, E, R>
  readonly onInstalled?: (details: chrome.runtime.InstalledDetails) => Effect.Effect<unknown, E, R>
  readonly onStartup?: () => Effect.Effect<unknown, E, R>
  readonly onAlarm?: (alarm: chrome.alarms.Alarm) => Effect.Effect<unknown, E, R>
}

export type Options<R, ER, EI = never, EH = never> = Handlers<R, EH> & {
  readonly chrome: ChromeApis
  readonly initialize?: Effect.Effect<void, EI, R>
  /** Maximum events/messages retained during initialization. Defaults to 64. */
  readonly maxPending?: number
  /** Receives initialization, event, selector, and response delivery failures. Must be synchronous. */
  readonly onError?: (error: WorkerError) => void
} & (
  | { readonly layer: Layer.Layer<R, ER, never>; readonly runtime?: never }
  | { readonly runtime: ManagedRuntime.ManagedRuntime<R, ER>; readonly layer?: never }
)

export interface ServiceWorker<R, E> {
  /** Always resolves to an Exit, including initialization failure or interruption. */
  readonly ready: Promise<Exit.Exit<void, E>>
  /** Registers immediately. Unregister stops future delivery, not already accepted work. */
  readonly register: <Args extends ReadonlyArray<unknown>, EH>(
    event: ChromeEvent<(...args: Args) => void>,
    handler: (...args: Args) => Effect.Effect<unknown, EH, R>
  ) => () => void
  /** Idempotent. Borrowed runtimes are never disposed. */
  readonly dispose: () => Promise<void>
}

/**
 * Call at the worker's top level, without awaiting anything first. All configured
 * listeners are installed before runtime/layer initialization starts. No chrome
 * global is accessed at import time. Responses must be Chrome-serializable.
 *
 * The startup queue is in-memory only. Returning true preserves the message
 * response channel, not a durable job or a guarantee against worker termination.
 */
export const start = <R, ER, EI = never, EH = never>(options: Options<R, ER, EI, EH>): ServiceWorker<R, ER | EI> => {
  const maxPending = options.maxPending ?? 64

  if (!Number.isSafeInteger(maxPending) || maxPending < 0) {
    throw new RangeError("maxPending must be a non-negative safe integer")
  }

  const owned = options.runtime === undefined
  const runtime = options.runtime ?? ManagedRuntime.make(options.layer!)
  const removers = new Set<() => void>()
  const fibers = new Set<Fiber.Fiber<unknown, unknown>>()
  const pending: Array<{ run: () => void; fail: (error: WorkerError) => void }> = []
  let state: "pending" | "ready" | "failed" | "disposed" = "pending"
  let initializationError: WorkerError | undefined
  let disposal: Promise<void> | undefined
  let resolveReady!: (exit: Exit.Exit<void, ER | EI>) => void
  const ready = new Promise<Exit.Exit<void, ER | EI>>((resolve) => { resolveReady = resolve })

  const report = (error: WorkerError): void => {
    try {
      if (options.onError) options.onError(error)
      else console.error("ChromeServiceWorker", error)
    } catch {
      // Error observers must not throw into Chrome callbacks or fiber observers.
    }
  }

  const track = <A, E>(fiber: Fiber.Fiber<A, E>, complete: (exit: Exit.Exit<A, E>) => void): void => {
    fibers.add(fiber)
    fiber.addObserver((exit) => {
      fibers.delete(fiber)
      complete(exit)
    })
  }

  const submit = (run: () => void, fail: (error: WorkerError) => void): void => {
    if (state === "disposed") fail({ code: "Disposed", message: "Service worker disposed" })
    else if (state === "failed") fail(initializationError!)
    else if (state === "ready") run()
    else if (pending.length >= maxPending) fail({ code: "Overflow", message: "Startup queue is full" })
    else pending.push({ run, fail })
  }

  const execute = <A, E>(
    handler: () => Effect.Effect<A, E, R>,
    success: (value: A) => void,
    fail: (error: WorkerError) => void
  ): void => {
    track(runtime.runFork(Effect.suspend(handler)), (exit) => {
      if (Exit.isSuccess(exit)) success(exit.value)
      else fail({
        code: state === "disposed" ? "Disposed" : "HandlerFailed",
        message: state === "disposed" ? "Service worker disposed" : Cause.pretty(exit.cause)
      })
    })
  }

  const isDisposed = (): boolean => state === "disposed"

  const install = <Listener>(event: ChromeEvent<Listener>, listener: Listener): (() => void) => {
    if (isDisposed()) throw new Error("Service worker disposed")

    try { event.addListener(listener) } catch (error) {
      // Injected/native event adapters may throw after partially registering.
      try { event.removeListener(listener) } catch { /* Preserve the registration error. */ }

      throw error
    }

    if (isDisposed()) {
      event.removeListener(listener)
      throw new Error("Service worker disposed")
    }

    const remove = (): void => {
      if (!removers.delete(remove)) return
      event.removeListener(listener)
    }

    removers.add(remove)

    return remove
  }

  const register: ServiceWorker<R, ER | EI>["register"] = (event, handler) => {
    let registered = true

    const remove = install(event, (...args) => {
      if (!registered) return
      submit(() => execute(() => handler(...args), () => {}, report), report)
    })

    return () => {
      registered = false
      remove()
    }
  }

  const messageListener = (
    selectMessage: (message: unknown, sender: chrome.runtime.MessageSender) => boolean,
    onMessage: (message: unknown, sender: chrome.runtime.MessageSender) => Effect.Effect<unknown, EH, R>
  ): MessageListener => (message, sender, sendResponse) => {
    try {
      if (!selectMessage(message, sender)) return false
    } catch (error) {
      report({ code: "HandlerFailed", message: String(error) })

      return false
    }

    let responded = false

    const respond = (response: Response): void => {
      if (responded) return
      responded = true

      try { sendResponse(response) } catch (error) {
        report({ code: "HandlerFailed", message: String(error) })
      }
    }

    const fail = (error: WorkerError): void => { respond({ ok: false, error }) }

    submit(() => execute(() => onMessage(message, sender),
      (value) => respond({ ok: true, value }), fail), fail)

    return true
  }

  try {
    const { selectMessage, onMessage } = options

    if ((selectMessage === undefined) !== (onMessage === undefined)) {
      throw new Error("selectMessage and onMessage must be configured together")
    }

    if (selectMessage !== undefined && onMessage !== undefined) {
      if (!options.chrome.runtime.onMessage) throw new Error("Configured onMessage event is unavailable")
      install(options.chrome.runtime.onMessage, messageListener(selectMessage, onMessage))
    }

    if (options.onConnect) {
      if (!options.chrome.runtime.onConnect) throw new Error("Configured onConnect event is unavailable")
      register(options.chrome.runtime.onConnect, options.onConnect)
    }

    if (options.onInstalled) {
      if (!options.chrome.runtime.onInstalled) throw new Error("Configured onInstalled event is unavailable")
      register(options.chrome.runtime.onInstalled, options.onInstalled)
    }

    if (options.onStartup) {
      if (!options.chrome.runtime.onStartup) throw new Error("Configured onStartup event is unavailable")
      register(options.chrome.runtime.onStartup, options.onStartup)
    }

    if (options.onAlarm) {
      if (!options.chrome.alarms) throw new Error("Configured onAlarm event is unavailable")
      register(options.chrome.alarms.onAlarm, options.onAlarm)
    }
  } catch (error) {
    state = "disposed"

    for (const remove of removers) {
      try { remove() } catch { /* Preserve the registration error. */ }
    }

    for (const task of pending.splice(0)) task.fail({ code: "Disposed", message: "Service worker disposed" })

    if (owned) void runtime.dispose().catch((cause: unknown) => report({ code: "HandlerFailed", message: String(cause) }))
    throw error
  }

  // Defer even synchronous layer effects until the whole registration call returns.
  queueMicrotask(() => {
    if (state === "disposed") {
      resolveReady(Exit.interrupt())

      return
    }

    track(runtime.runFork(options.initialize ?? Effect.void), (exit) => {
      resolveReady(exit)

      if (state === "disposed") return

      if (Exit.isFailure(exit)) {
        state = "failed"
        initializationError = { code: "InitializationFailed", message: Cause.pretty(exit.cause) }
        report(initializationError)

        for (const task of pending.splice(0)) task.fail(initializationError)
      } else {
        state = "ready"

        for (const task of pending.splice(0)) {
          // A response callback can synchronously dispose the worker.
          if (state === "ready") task.run()
          else task.fail({ code: "Disposed", message: "Service worker disposed" })
        }
      }
    })
  })

  return {
    ready,
    register,
    dispose: () => {
      if (disposal) return disposal
      state = "disposed"
      // Assign the promise before callbacks, to support reentrant disposal.
      disposal = Promise.resolve().then(async () => {
        // Snapshot before calling native removal hooks, which can be reentrant.
        // oxlint-disable-next-line unicorn/no-useless-spread
        for (const remove of [...removers]) {
          try { remove() } catch (error) { report({ code: "HandlerFailed", message: String(error) }) }
        }

        for (const task of pending.splice(0)) task.fail({ code: "Disposed", message: "Service worker disposed" })
        await Effect.runPromise(Fiber.interruptAll([...fibers]))

        if (owned) await runtime.dispose()
      })
      // Mark rejection as observed even when callers discard the disposal promise.
      void disposal.catch((error: unknown) => report({ code: "HandlerFailed", message: String(error) }))

      return disposal
    }
  }
}
