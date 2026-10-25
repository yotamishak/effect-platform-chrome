/**
 * Manifest V3 service-worker lifecycle: wake listeners installed synchronously at worker
 * startup, an initialization gate with a bounded in-memory startup queue, and disposal. This
 * is not a `chrome.*` namespace wrapper; see `docs/ChromeServiceWorker.md`.
 */
import { Cause, Effect, Exit, Fiber, Layer, ManagedRuntime } from "effect"
import type { Response, WorkerError } from "./ChromeMessage.js"

/** The reply envelope, defined in ChromeMessage so senders decode the same shape. */
export type { ErrorCode, Response, WorkerError } from "./ChromeMessage.js"

/** Structural event interface, also suitable for injected test events. */
export interface ChromeEvent<Listener> {
  readonly addListener: (listener: Listener) => void
  readonly removeListener: (listener: Listener) => void
}

/**
 * An event whose `addListener` also takes a filter, such as webNavigation's URL filters.
 * A filter keeps Chrome from waking the worker for events it would only discard.
 */
export interface FilteredChromeEvent<Listener, Filter> {
  readonly addListener: (listener: Listener, filter: Filter) => void
  readonly removeListener: (listener: Listener) => void
}

/**
 * Any event shape: `addListener` takes the listener, then whatever else that event accepts,
 * such as webNavigation's optional URL filter or webRequest's required `RequestFilter` and
 * optional `extraInfoSpec`. `ChromeEvent` and `FilteredChromeEvent` are special cases.
 */
export interface ConfigurableChromeEvent<Listener, Options extends ReadonlyArray<unknown>> {
  readonly addListener: (listener: Listener, ...options: Options) => void
  readonly removeListener: (listener: Listener) => void
}

/** Adds a listener to an event; `start` supplies one that tracks it for disposal. */
export type Install = <Listener>(event: ChromeEvent<Listener>, listener: Listener) => () => void

/** What `start` gives a wake listener when installing it, once per installation. */
export interface Gate<R, E> {
  /** Adds a native listener, tracked so that rollback, unregistration and disposal remove it. */
  readonly install: Install
  /**
   * Runs a handler behind the initialization gate. Its failure, and an event the worker cannot
   * run (startup queue full, initialization failed, disposed), goes to `onError`; `rejected`
   * also hears about an event whose handler never started. Ignored once unregistered.
   */
  readonly dispatch: (run: () => Effect.Effect<unknown, E, R>, rejected?: (error: WorkerError) => void) => void
  /**
   * Runs a handler behind the initialization gate and settles its outcome, failures included,
   * exactly once as an envelope. Returns false, without settling, once unregistered.
   */
  readonly request: <A>(run: () => Effect.Effect<A, E, R>, settle: (response: Response<A>) => void) => boolean
  /** Reports a listener-level failure to `onError`. */
  readonly report: (error: WorkerError) => void
}

/**
 * A wake listener for `start`'s `listeners` option or `ServiceWorker.register`, made with
 * `listen`, `listenReply` or `listenPort`.
 */
export interface Listener<R, E> {
  readonly attach: (gate: Gate<R, E>) => () => void
}

const handlerFailed = (cause: unknown): WorkerError => ({ code: "HandlerFailed", message: String(cause) })

const disposed: WorkerError = { code: "Disposed", message: "Service worker disposed" }

/** The event with its extra `addListener` arguments bound; only the given ones are passed. */
const bind = <Listener, Options extends ReadonlyArray<unknown>>(
  event: ConfigurableChromeEvent<Listener, Options>,
  options: Options
): ChromeEvent<Listener> => ({
  // Chrome validates arguments, so an absent filter is not passed as undefined.
  addListener: (listener) => event.addListener(listener, ...options),
  removeListener: (listener) => event.removeListener(listener)
})

/**
 * Pairs any Chrome event with an Effect handler, for `start`'s `listeners` option: for example
 * `action.onClicked`, `contextMenus.onClicked`, `commands.onCommand`, a webNavigation event
 * with its URL filter, or a webRequest event with its filter and `extraInfoSpec`. The extra
 * arguments are passed to `addListener` exactly as given. The handler's result is discarded
 * and its failure goes to `onError`. Events answered through a callback
 * (`runtime.onMessageExternal`'s `sendResponse`, `downloads.onDeterminingFilename`'s
 * `suggest`) take `listenReply`; events that hand over a port take `listenPort`.
 */
export const listen = <Args extends ReadonlyArray<unknown>, Options extends ReadonlyArray<unknown>, E, R>(
  event: ConfigurableChromeEvent<(...args: Args) => void, Options>,
  handler: (...args: Args) => Effect.Effect<unknown, E, R>,
  ...options: Options
): Listener<R, E> => ({
  attach: (gate) => gate.install(bind(event, options), (...args: Args) => { gate.dispatch(() => handler(...args)) })
})

/** The part of a native port `listenPort` needs: closing one that no handler will own. */
export interface Disconnectable {
  readonly disconnect: () => void
}

/**
 * Like `listen`, for an event that hands over a port: `runtime.onConnectExternal`,
 * `runtime.onUserScriptConnect` or `runtime.onConnectNative`. A port whose handler never starts
 * (startup queue full, initialization failed, worker disposed) is disconnected, so the other
 * end sees `onDisconnect` instead of waiting on a port nobody owns. Once the handler starts,
 * the port is its to close. `start`'s `onConnect` option works this way.
 */
export const listenPort = <Port extends Disconnectable, Options extends ReadonlyArray<unknown>, E, R>(
  event: ConfigurableChromeEvent<(port: Port) => void, Options>,
  handler: (port: Port) => Effect.Effect<unknown, E, R>,
  ...options: Options
): Listener<R, E> => ({
  attach: (gate) => gate.install(bind(event, options), (port: Port) => {
    gate.dispatch(() => handler(port), () => {
      try { port.disconnect() } catch (cause) { gate.report(handlerFailed(cause)) }
    })
  })
})

/** How `listenReply` routes and answers one event. */
export interface ReplyHandler<Args extends ReadonlyArray<unknown>, A, E, R> {
  /**
   * Synchronous routing, defaulting to every event. False leaves the event unanswered for other
   * listeners or Chrome's default (`onDeterminingFilename` keeps the tentative name); a throw
   * is reported and also leaves it unanswered.
   */
  readonly select?: (...args: Args) => boolean
  /** Produces the answer, behind the initialization gate. */
  readonly handler: (...args: Args) => Effect.Effect<A, E, R>
}

/** A `ReplyHandler` that builds the callback's argument itself, for callbacks that are not message channels. */
export interface MappedReplyHandler<Args extends ReadonlyArray<unknown>, A, Reply, E, R>
  extends ReplyHandler<Args, A, E, R>
{
  /**
   * Builds the callback's argument from the outcome, failures included. Synchronous; an
   * `undefined` result calls the callback with no argument.
   */
  readonly reply: (response: Response<A>) => Reply
}

type ReplyCallback<Reply> = (...reply: [] | [Reply]) => void

/**
 * The listener shape `listenReply` matches: the event's arguments, then the reply callback,
 * which Chrome may declare optional (webRequest's `asyncCallback`). The return type only has to
 * fit every event's listener type; the installed listener returns whether it claimed the event.
 */
type ReplyEventListener<Args extends ReadonlyArray<unknown>, Reply> =
  (...args: [...Args, reply: ((reply: Reply) => void) | undefined]) => never

/**
 * The event's arguments, read only from the event: a deferred type that a handler declaring
 * fewer parameters cannot narrow. (`NoInfer` would also stop such a handler from matching.)
 */
type FromEvent<Args extends ReadonlyArray<unknown>> = [Args][Args extends unknown ? 0 : never]

/**
 * Selects synchronously, claims a selected event by returning true (Chrome's "will answer
 * asynchronously"), and answers through the callback Chrome passes last, exactly once. If the
 * answer cannot be built or delivered, the failure is reported and a successful outcome is
 * answered once more as a `HandlerFailed` envelope, so a claimed event is still answered.
 */
const makeReplyListener = <Args extends ReadonlyArray<unknown>, A, Reply, Options extends ReadonlyArray<unknown>, E, R>(
  event: ConfigurableChromeEvent<(...input: Array<unknown>) => boolean, Options>,
  options: Options,
  handler: MappedReplyHandler<Args, A, Reply, E, R>
): Listener<R, E> => ({
  attach: (gate) => gate.install(bind(event, options), (...input: Array<unknown>): boolean => {
    // SAFETY: Chrome passes the event's own arguments first and its reply callback last. A
    // missing callback throws when called, which is reported like any undeliverable answer.
    const callback = input.at(-1) as ReplyCallback<Reply>
    // SAFETY: the same native argument order. Args is the event's parameter list, which
    // TypeScript cannot relate to a sliced array without passing through unknown.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions
    const args = input.slice(0, -1) as unknown as Args

    try {
      if (handler.select !== undefined && !handler.select(...args)) return false
    } catch (cause) {
      gate.report(handlerFailed(cause))

      return false
    }

    const send = (response: Response<A>): void => {
      const reply = handler.reply(response)

      // An optional callback argument is passed only when given; Chrome validates arguments.
      if (reply === undefined) callback()
      else callback(reply)
    }

    return gate.request(() => handler.handler(...args), (response) => {
      try { send(response) } catch (cause) {
        gate.report(handlerFailed(cause))

        if (!response.ok) return

        try { send({ ok: false, error: handlerFailed(cause) }) } catch (fallback) { gate.report(handlerFailed(fallback)) }
      }
    })
  })
})

/**
 * Pairs a Chrome event answered through a callback passed as its last argument with an Effect
 * handler: `runtime.onMessageExternal` or `runtime.onUserScriptMessage` (`sendResponse`),
 * `downloads.onDeterminingFilename` (`suggest`), or `webRequest.onAuthRequired` with
 * `["asyncBlocking"]` (`asyncCallback`). Extra arguments go to `addListener` as with `listen`.
 * For a selected event the listener returns true, keeping the callback open, and calls it
 * exactly once: with the handler's outcome, or with the failure when the handler fails or never
 * runs (startup queue full, initialization failed, worker disposed). Unregistering stops future
 * events, not already claimed ones.
 *
 * Without `reply`, the callback receives the `ChromeMessage` envelope that `start`'s
 * `onMessage` sends, which `ChromeMessage.decodeResponse` and `ChromeRuntime.request` unwrap.
 * With `reply`, it receives what `reply` builds from that envelope, for example
 * `(response) => response.ok ? response.value : undefined` for a filename suggestion. A
 * blocking webRequest callback must always be called, so leave `select` out there and decide
 * in the handler. Check `sender.id` / `sender.origin` before trusting an external message.
 */
export function listenReply<
  Args extends ReadonlyArray<unknown>,
  Reply,
  A,
  Options extends ReadonlyArray<unknown>,
  E,
  R
>(
  event: ConfigurableChromeEvent<ReplyEventListener<Args, Reply>, Options>,
  handler: MappedReplyHandler<FromEvent<Args>, A, NoInfer<Reply>, E, R>,
  ...options: Options
): Listener<R, E>
export function listenReply<Args extends ReadonlyArray<unknown>, A, Options extends ReadonlyArray<unknown>, E, R>(
  event: ConfigurableChromeEvent<ReplyEventListener<Args, Response<NoInfer<A>>>, Options>,
  handler: ReplyHandler<FromEvent<Args>, A, E, R>,
  ...options: Options
): Listener<R, E>
export function listenReply<Args extends ReadonlyArray<unknown>, A, Reply, Options extends ReadonlyArray<unknown>, E, R>(
  event: ConfigurableChromeEvent<ReplyEventListener<Args, Reply>, Options>,
  handler: ReplyHandler<Args, A, E, R> & { readonly reply?: (response: Response<A>) => Reply },
  ...options: Options
): Listener<R, E> {
  const { reply } = handler
  // SAFETY: the overloads matched the event's listener type. The installed listener takes the
  // event's arguments and reply callback as Chrome passes them, and returns a boolean, which
  // every Chrome listener type accepts; `ReplyEventListener` returns never only to match them.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions
  const target = event as unknown as ConfigurableChromeEvent<(...input: Array<unknown>) => boolean, Options>

  return reply === undefined
    ? makeReplyListener(target, options, { ...handler, reply: (response: Response<A>) => response })
    : makeReplyListener(target, options, { ...handler, reply })
}

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
   * One-off `runtime.sendMessage` / `tabs.sendMessage` handling; give both or neither. A worker
   * whose messaging is all over ports (ChromeRpc) leaves both out, and no `onMessage` listener
   * is installed. Routing only, not validation. Must be synchronous; false, or a throw (which is
   * reported), leaves the channel unclaimed for other listeners.
   */
  readonly selectMessage?: (message: unknown, sender: chrome.runtime.MessageSender) => boolean
  /**
   * Answers a selected message with the `ChromeMessage` envelope exactly once: the value, or the
   * failure (handler failure, startup queue full, initialization failed, disposed). If Chrome
   * cannot deliver the value, for example one it cannot serialize, the delivery error is
   * reported and a `HandlerFailed` envelope is sent instead.
   */
  readonly onMessage?: (message: unknown, sender: chrome.runtime.MessageSender) => Effect.Effect<unknown, E, R>
  /** Like `listenPort`: a port whose handler never starts is disconnected. */
  readonly onConnect?: (port: chrome.runtime.Port) => Effect.Effect<unknown, E, R>
  readonly onInstalled?: (details: chrome.runtime.InstalledDetails) => Effect.Effect<unknown, E, R>
  readonly onStartup?: () => Effect.Effect<unknown, E, R>
  readonly onAlarm?: (alarm: chrome.alarms.Alarm) => Effect.Effect<unknown, E, R>
  /**
   * Any other wake listeners, made with `listen`, `listenReply` or `listenPort`. They are
   * installed after the named ones, synchronously and all-or-nothing: if one cannot be added,
   * none stay registered.
   */
  readonly listeners?: ReadonlyArray<Listener<R, E>>
}

export type Options<R, ER, EI = never, EH = never> = Handlers<R, EH> & {
  readonly chrome: ChromeApis
  readonly initialize?: Effect.Effect<void, EI, R>
  /**
   * Maximum events and messages retained during initialization, a non-negative safe integer;
   * defaults to 64. The queue keeps the oldest: a later event fails with `Overflow` at once,
   * which answers a claimed message or reply instead of holding its channel open.
   */
  readonly maxPending?: number
  /**
   * Receives initialization, event, selector, and answer delivery failures. Must be
   * synchronous; defaults to `console.error`, and a throw is ignored.
   */
  readonly onError?: (error: WorkerError) => void
} & (
  | { readonly layer: Layer.Layer<R, ER, never>; readonly runtime?: never }
  | { readonly runtime: ManagedRuntime.ManagedRuntime<R, ER>; readonly layer?: never }
)

export interface ServiceWorker<R, E> {
  /** Always resolves to an Exit, including initialization failure or interruption. */
  readonly ready: Promise<Exit.Exit<void, E>>
  /**
   * Registers immediately: a listener made with `listen`, `listenReply` or `listenPort`, or an
   * event and handler with `addListener`'s extra arguments, as `listen` takes them. The
   * returned function is idempotent and stops future delivery, not already accepted work.
   * Prefer `start`'s `listeners` for wake listeners, so a failed registration rolls the others
   * back. Throws when the native registration throws, or once the worker is disposed.
   */
  readonly register: {
    <EH>(listener: Listener<R, EH>): () => void
    <Args extends ReadonlyArray<unknown>, Options extends ReadonlyArray<unknown>, EH>(
      event: ConfigurableChromeEvent<(...args: Args) => void, Options>,
      handler: (...args: Args) => Effect.Effect<unknown, EH, R>,
      ...options: Options
    ): () => void
  }
  /** Idempotent. Borrowed runtimes are never disposed. */
  readonly dispose: () => Promise<void>
}

const runtimeOf = <R, ER>(
  options: { readonly layer?: Layer.Layer<R, ER, never>; readonly runtime?: ManagedRuntime.ManagedRuntime<R, ER> }
): ManagedRuntime.ManagedRuntime<R, ER> => {
  if (options.runtime !== undefined && options.layer === undefined) return options.runtime

  if (options.layer !== undefined && options.runtime === undefined) return ManagedRuntime.make(options.layer)

  throw new TypeError("Exactly one of layer or runtime must be given")
}

/**
 * Call at the worker's top level, without awaiting anything first. All configured
 * listeners are installed before runtime/layer initialization starts. No chrome
 * global is accessed at import time. Responses must be Chrome-serializable.
 *
 * Throws, leaving nothing registered, on an invalid `maxPending`, a missing or doubled
 * `layer` / `runtime`, a `selectMessage` without `onMessage`, a configured but unavailable
 * event, or a native registration failure.
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
  const runtime = runtimeOf<R, ER>(options)
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
    if (state === "disposed") fail(disposed)
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
      else fail(state === "disposed" ? disposed : { code: "HandlerFailed", message: Cause.pretty(exit.cause) })
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

  const attach = <EL>(listener: Listener<R, EL>): (() => void) => {
    let registered = true

    const remove = listener.attach({
      install,
      report,
      dispatch: (run, rejected) => {
        if (!registered) return

        submit(() => execute(run, () => {}, report), (error) => {
          report(error)

          try { rejected?.(error) } catch (cause) { report(handlerFailed(cause)) }
        })
      },
      request: <A>(run: () => Effect.Effect<A, EL, R>, settle: (response: Response<A>) => void): boolean => {
        if (!registered) return false
        let settled = false

        const once = (response: Response<A>): void => {
          if (settled) return
          settled = true

          try { settle(response) } catch (cause) { report(handlerFailed(cause)) }
        }

        const fail = (error: WorkerError): void => { once({ ok: false, error }) }

        submit(() => execute(run, (value) => once({ ok: true, value }), fail), fail)

        return true
      }
    })

    return () => {
      registered = false
      remove()
    }
  }

  function register<EL>(listener: Listener<R, EL>): () => void
  function register<Args extends ReadonlyArray<unknown>, Options extends ReadonlyArray<unknown>, EL>(
    event: ConfigurableChromeEvent<(...args: Args) => void, Options>,
    handler: (...args: Args) => Effect.Effect<unknown, EL, R>,
    ...options: Options
  ): () => void
  function register<Args extends ReadonlyArray<unknown>, Options extends ReadonlyArray<unknown>, EL>(
    target: Listener<R, EL> | ConfigurableChromeEvent<(...args: Args) => void, Options>,
    handler?: (...args: Args) => Effect.Effect<unknown, EL, R>,
    ...options: Options
  ): () => void {
    if ("attach" in target) return attach(target)

    if (handler === undefined) throw new TypeError("register needs a handler for an event")

    return attach(listen(target, handler, ...options))
  }

  try {
    const { selectMessage, onMessage } = options

    if ((selectMessage === undefined) !== (onMessage === undefined)) {
      throw new Error("selectMessage and onMessage must be configured together")
    }

    if (selectMessage !== undefined && onMessage !== undefined) {
      if (!options.chrome.runtime.onMessage) throw new Error("Configured onMessage event is unavailable")
      attach(listenReply(options.chrome.runtime.onMessage, { select: selectMessage, handler: onMessage }))
    }

    if (options.onConnect) {
      if (!options.chrome.runtime.onConnect) throw new Error("Configured onConnect event is unavailable")
      attach(listenPort(options.chrome.runtime.onConnect, options.onConnect))
    }

    if (options.onInstalled) {
      if (!options.chrome.runtime.onInstalled) throw new Error("Configured onInstalled event is unavailable")
      attach(listen(options.chrome.runtime.onInstalled, options.onInstalled))
    }

    if (options.onStartup) {
      if (!options.chrome.runtime.onStartup) throw new Error("Configured onStartup event is unavailable")
      attach(listen(options.chrome.runtime.onStartup, options.onStartup))
    }

    if (options.onAlarm) {
      if (!options.chrome.alarms) throw new Error("Configured onAlarm event is unavailable")
      attach(listen(options.chrome.alarms.onAlarm, options.onAlarm))
    }

    for (const listener of options.listeners ?? []) attach(listener)
  } catch (error) {
    state = "disposed"

    for (const remove of removers) {
      try { remove() } catch { /* Preserve the registration error. */ }
    }

    for (const task of pending.splice(0)) task.fail(disposed)

    if (owned) void runtime.dispose().catch((cause: unknown) => report(handlerFailed(cause)))
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
          else task.fail(disposed)
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
          try { remove() } catch (error) { report(handlerFailed(error)) }
        }

        for (const task of pending.splice(0)) task.fail(disposed)
        await Effect.runPromise(Fiber.interruptAll([...fibers]))

        if (owned) await runtime.dispose()
      })
      // Mark rejection as observed even when callers discard the disposal promise.
      void disposal.catch((error: unknown) => report(handlerFailed(error)))

      return disposal
    }
  }
}
