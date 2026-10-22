import { Cause, Context, Deferred, Effect, Layer, Option, Queue, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { bufferSize, observe, type EventSource } from "./internal/event.js"

export class ChromeDebuggerError extends Schema.TaggedError<ChromeDebuggerError>()("ChromeDebuggerError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** A root target: exactly one of `tabId`, `extensionId` or `targetId`. */
export type Debuggee = chrome.debugger.Debuggee

/** A root target, optionally narrowed to a child protocol session by `sessionId` (Chrome 125+). */
export type CommandTarget = chrome.debugger.DebuggerSession

export type TargetInfo = chrome.debugger.TargetInfo

/** The kind of a debug target: `"page"`, `"background_page"`, `"worker"` or `"other"`. */
export type TargetType = `${chrome.debugger.TargetInfoType}`

/**
 * Why Chrome ended an attachment: `"target_closed"` when the target went away (the tab closed,
 * or navigated somewhere the extension may not debug), `"canceled_by_user"` when the user
 * dismissed the debugging infobar.
 */
export type DetachReason = `${chrome.debugger.DetachReason}`

/** Chrome DevTools Protocol parameters: raw JSON shaped by the protocol, not by this library. */
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- CDP params are free-form protocol JSON.
export type CommandParams = { readonly [key: string]: unknown }

/**
 * A protocol event from any target this extension is attached to. `source` is the debuggee
 * given to `attach`, plus `sessionId` for a child session. `params` is raw CDP JSON; Chrome
 * passes `{}` for events without parameters, so None means the API left them out.
 */
export interface DebuggerEvent {
  readonly source: CommandTarget
  readonly method: string
  readonly params: Option.Option<object>
}

export interface DetachEvent {
  /** The debuggee given to `attach`. */
  readonly source: Debuggee
  readonly reason: DetachReason
}

/** A protocol event of one session's target; `sessionId` names the child session, if any. */
export interface SessionEvent {
  readonly method: string
  /** Raw CDP JSON; Chrome passes `{}` for events without parameters. */
  readonly params: Option.Option<object>
  readonly sessionId: Option.Option<string>
}

// oxlint-disable-next-line anti-slop/no-object-parameters -- Chrome's native onEvent callback passes raw CDP params.
type EventListener = (source: CommandTarget, method: string, params?: object) => void

type DetachListener = (source: Debuggee, reason: DetachReason) => void

/** The Promise-based MV3 `chrome.debugger` namespace (Chrome 96+ for Promises). */
export interface ChromeDebuggerApi {
  attach(target: Debuggee, requiredVersion: string): Promise<void>
  detach(target: Debuggee): Promise<void>
  sendCommand(target: CommandTarget, method: string, commandParams?: CommandParams): Promise<object | undefined>
  getTargets(): Promise<Array<TargetInfo>>
  readonly onEvent: EventSource<Parameters<EventListener>>
  readonly onDetach: EventSource<Parameters<DetachListener>>
}

/** One attachment, bound to its target. */
export interface Session {
  readonly target: Debuggee
  /**
   * Sends a CDP command to this target, or to its child session `sessionId` (Chrome 125+).
   * The result is raw protocol JSON; Chrome resolves `{}` for commands without one, so None
   * means the API resolved nothing. Decode it with a schema.
   */
  readonly sendCommand: (
    method: string,
    params?: CommandParams,
    sessionId?: string
  ) => Effect.Effect<Option.Option<object>, ChromeDebuggerError>
  /**
   * This target's protocol events, child sessions included, from the moment `attach`
   * resolves: the listener is installed before attaching, so no event caused by a command
   * is lost. Single-consumer; buffers `capacity` events (default 64), dropping the oldest.
   * Ends when Chrome detaches the target. Closing the session's scope discards the buffer
   * and interrupts readers, unless Chrome had already ended the stream.
   */
  readonly events: Stream.Stream<SessionEvent>
  /** Completes with the reason once Chrome detaches the target; never after a normal release. */
  readonly detached: Effect.Effect<DetachReason>
}

export interface SessionOptions {
  /** Events buffered for `events` before the oldest is dropped; a positive safe integer, 64 by default. */
  readonly capacity?: number
}

export interface ChromeDebuggerService {
  /**
   * Attaches to a target. Fails when this extension is already attached to it (from any of
   * its contexts), when the target does not exist or may not be debugged (for example a
   * `chrome://` page or the Web Store), when policy forbids debugging, or when Chrome does
   * not support `requiredVersion`. DevTools and other extensions may be attached alongside.
   */
  readonly attach: (target: Debuggee, requiredVersion: string) => Effect.Effect<void, ChromeDebuggerError>
  /** Ends this extension's attachment; Chrome does not fire `onDetach` for it. */
  readonly detach: (target: Debuggee) => Effect.Effect<void, ChromeDebuggerError>
  /**
   * Sends a CDP command; `params` is passed only when given. The result is raw protocol JSON:
   * Chrome resolves `{}` for commands without one, so None means the API resolved nothing.
   * Decode it with a schema. Protocol errors fail with Chrome's JSON error text as the cause.
   */
  readonly sendCommand: (
    target: CommandTarget,
    method: string,
    params?: CommandParams
  ) => Effect.Effect<Option.Option<object>, ChromeDebuggerError>
  /** Every available debug target; `attached` is true for targets any client is attached to. */
  readonly getTargets: Effect.Effect<Array<TargetInfo>, ChromeDebuggerError>
  /**
   * Observational subscriptions that cannot wake an MV3 service worker; register wake
   * listeners through ChromeServiceWorker.listen. Each buffers at most 64 events, dropping
   * the oldest. Prefer `session(...).events`, which cannot miss early events.
   */
  readonly onEvent: Stream.Stream<DebuggerEvent, ChromeDebuggerError>
  /** Chrome ended an attachment: the target went away or the user cancelled the debugging infobar. */
  readonly onDetach: Stream.Stream<DetachEvent, ChromeDebuggerError>
  /**
   * Attaches on acquisition and detaches when the scope closes. Interrupting acquisition
   * waits for a pending `attach` and detaches if it succeeded. Detaching is skipped once
   * Chrome has detached the target, and release ignores failures because the target may
   * already be gone. Fails with operation `"session"` when `capacity` is not a positive safe
   * integer. Chrome may stop the worker without running finalizers, so a new worker may
   * need to `detach` targets it still owns before attaching again; `getTargets` marks a
   * target `attached` for any client, DevTools included.
   */
  readonly session: (
    target: Debuggee,
    requiredVersion: string,
    options?: SessionOptions
  ) => Effect.Effect<Session, ChromeDebuggerError, Scope.Scope>
}

export class ChromeDebugger extends Context.Service<ChromeDebugger, ChromeDebuggerService>()(
  "effect-platform-chrome/ChromeDebugger"
) {}

const debuggerError = (operation: string) => (cause: unknown) => new ChromeDebuggerError({ operation, cause })

const invoke = invoker((operation, cause) => new ChromeDebuggerError({ operation, cause }))

/**
 * Whether `source` is the root target `target`, or one of its child sessions. Chrome reports
 * the debuggee given to `attach`, so every id the target names must match.
 */
const isTarget = (target: Debuggee, source: Debuggee): boolean =>
  (target.tabId === undefined || source.tabId === target.tabId)
  && (target.extensionId === undefined || source.extensionId === target.extensionId)
  && (target.targetId === undefined || source.targetId === target.targetId)

/**
 * Detaching a target that is no longer attached or no longer exists fails with one of Chrome's
 * "Debugger is not attached to the tab with id: 7." or "No background page with given id x."
 * messages; that is expected during release.
 */
const isNotAttached = (error: ChromeDebuggerError): boolean =>
  error.cause instanceof Error && /not attached|no (?:tab|background page|target) with given id/i.test(error.cause.message)

const listen = <Args extends ReadonlyArray<unknown>>(
  operation: string,
  getSource: () => EventSource<Args>,
  listener: (...args: Args) => void
): Effect.Effect<void, ChromeDebuggerError, Scope.Scope> => Effect.gen(function*() {
  const source = yield* Effect.try({ try: getSource, catch: debuggerError(operation) })

  // Install cleanup before registration, which may partially succeed then throw.
  yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => {
    try { source.removeListener(listener) } catch { /* Finalizers must not mask the scope's exit. */ }
  }))
  yield* Effect.try({ try: () => source.addListener(listener), catch: debuggerError(operation) })
})

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeDebuggerApi): ChromeDebuggerService => {
  const sendCommand = (target: CommandTarget, method: string, params?: CommandParams) =>
    invoke("sendCommand", () => params === undefined
      ? api.sendCommand(target, method)
      : api.sendCommand(target, method, params)).pipe(Effect.map(Option.fromNullishOr))

  const detach = (target: Debuggee) => invoke("detach", () => api.detach(target))

  const session = (target: Debuggee, requiredVersion: string, options?: SessionOptions) => Effect.gen(function*() {
    const capacity = options?.capacity ?? bufferSize

    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      return yield* new ChromeDebuggerError({
        operation: "session",
        cause: new RangeError(`Session capacity must be a positive safe integer, got ${String(capacity)}`)
      })
    }

    const queue = yield* Queue.make<SessionEvent, Cause.Done>({ capacity, strategy: "sliding" })
    const detached = yield* Deferred.make<DetachReason>()
    // Chrome allows one attachment per target and extension, so until `attach` resolves, any
    // event for the target belongs to an earlier attachment (for example one another context
    // of this extension is ending) and must not reach, or end, this session.
    let state: "attaching" | "attached" | "ended" = "attaching"

    // Registered first, so it runs last: after detaching and removing the listeners.
    yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => {
      state = "ended"
      Queue.shutdownUnsafe(queue)
    }))

    const onEvent: EventListener = (source, method, params) => {
      if (state === "attached" && isTarget(target, source)) {
        Queue.offerUnsafe(queue, { method, params: Option.fromNullishOr(params), sessionId: Option.fromNullishOr(source.sessionId) })
      }
    }

    const onDetach: DetachListener = (source, reason) => {
      if (state !== "attached" || !isTarget(target, source)) return
      state = "ended"
      Deferred.doneUnsafe(detached, Effect.succeed(reason))
      Queue.endUnsafe(queue)
    }

    yield* listen("onEvent", () => api.onEvent, onEvent)
    yield* listen("onDetach", () => api.onDetach, onDetach)
    yield* Effect.acquireRelease(
      // Marked in the resolution callback itself, before Chrome can dispatch a later event.
      invoke("attach", () => api.attach(target, requiredVersion).then(() => { state = "attached" })),
      () => Deferred.isDoneUnsafe(detached)
        ? Effect.void
        : detach(target).pipe(Effect.catchIf(isNotAttached, () => Effect.void), Effect.ignore({ log: "Warn" }))
    )

    return {
      target,
      sendCommand: (method, params, sessionId) =>
        sendCommand(sessionId === undefined ? target : { ...target, sessionId }, method, params),
      events: Stream.fromQueue(queue),
      detached: Deferred.await(detached)
    } satisfies Session
  })

  return ChromeDebugger.of({
    attach: (target, requiredVersion) => invoke("attach", () => api.attach(target, requiredVersion)),
    detach,
    sendCommand,
    getTargets: invoke("getTargets", () => api.getTargets()),
    onEvent: observe(
      () => api.onEvent,
      (source, method, params) => ({ source, method, params: Option.fromNullishOr(params) }),
      debuggerError("onEvent")
    ),
    onDetach: observe(() => api.onDetach, (source, reason) => ({ source, reason }), debuggerError("onDetach")),
    session
  })
}

export const layer = (api: ChromeDebuggerApi): Layer.Layer<ChromeDebugger> => Layer.succeed(ChromeDebugger, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeDebugger, ChromeDebuggerError> = liveLayer(
  ChromeDebugger, "debugger", (chrome) => chrome.debugger, make,
  (cause) => new ChromeDebuggerError({ operation: "initialize", cause })
)
