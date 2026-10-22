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

export type DetachReason = `${chrome.debugger.DetachReason}`

/** Chrome DevTools Protocol parameters: raw JSON shaped by the protocol, not by this library. */
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- CDP params are free-form protocol JSON.
export type CommandParams = { readonly [key: string]: unknown }

/** A protocol event from any target this extension is attached to. `params` is raw CDP JSON. */
export interface DebuggerEvent {
  readonly source: CommandTarget
  readonly method: string
  readonly params: unknown
}

export interface DetachEvent {
  readonly source: Debuggee
  readonly reason: DetachReason
}

/** A protocol event of one session's target; `sessionId` names the child session, if any. */
export interface SessionEvent {
  readonly method: string
  readonly params: unknown
  readonly sessionId: Option.Option<string>
}

// oxlint-disable-next-line anti-slop/no-object-parameters -- Chrome's native onEvent callback passes raw CDP params.
type EventListener = (source: CommandTarget, method: string, params?: object) => void

type DetachListener = (source: Debuggee, reason: DetachReason) => void

/** The Promise-based MV3 subset this module needs. */
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
   * Sends a CDP command to this target, or to its child session `sessionId`. The result is
   * raw protocol JSON (`undefined` for commands without one); decode it with a schema.
   */
  readonly sendCommand: (method: string, params?: CommandParams, sessionId?: string) => Effect.Effect<unknown, ChromeDebuggerError>
  /**
   * This target's protocol events, child sessions included. The listener is installed
   * before attaching, so events caused by the first commands are not lost. Single-consumer;
   * buffers `capacity` events (default 64), dropping the oldest. Ends when Chrome detaches
   * the target; closing the session's scope discards the buffer and interrupts consumers.
   */
  readonly events: Stream.Stream<SessionEvent>
  /** Completes with the reason once Chrome detaches the target; never after a normal release. */
  readonly detached: Effect.Effect<DetachReason>
}

export interface SessionOptions {
  /** Events buffered for `events` before the oldest is dropped. */
  readonly capacity?: number
}

export interface ChromeDebuggerService {
  /** Fails if another debugger (including DevTools or another extension) is already attached. */
  readonly attach: (target: Debuggee, requiredVersion: string) => Effect.Effect<void, ChromeDebuggerError>
  readonly detach: (target: Debuggee) => Effect.Effect<void, ChromeDebuggerError>
  /** The result is raw protocol JSON (`undefined` for commands without one); decode it with a schema. */
  readonly sendCommand: (target: CommandTarget, method: string, params?: CommandParams) => Effect.Effect<unknown, ChromeDebuggerError>
  readonly getTargets: Effect.Effect<Array<TargetInfo>, ChromeDebuggerError>
  /**
   * Observational subscriptions that cannot wake an MV3 service worker; register wake
   * listeners through ChromeServiceWorker.listen. Each buffers at most 64 events, dropping
   * the oldest. Prefer `session(...).events`, which cannot miss early events.
   */
  readonly onEvent: Stream.Stream<DebuggerEvent, ChromeDebuggerError>
  /** Chrome ended a session: the target closed or the user cancelled the debugging infobar. */
  readonly onDetach: Stream.Stream<DetachEvent, ChromeDebuggerError>
  /**
   * Attaches on acquisition and detaches when the scope closes. Detaching is skipped once
   * Chrome has detached the target, and release ignores failures because the target may
   * already be gone. Chrome may stop the worker without running finalizers, so a new worker
   * should check `getTargets` for leftover `attached` targets it owns.
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

/** Whether `source` is the root target `target`, or one of its child sessions: every id the target names matches. */
const isTarget = (target: Debuggee, source: Debuggee): boolean =>
  (target.tabId === undefined || source.tabId === target.tabId)
  && (target.extensionId === undefined || source.extensionId === target.extensionId)
  && (target.targetId === undefined || source.targetId === target.targetId)

/** Detaching an already detached target fails with this; it is expected during release. */
const isNotAttached = (error: ChromeDebuggerError): boolean =>
  error.cause instanceof Error && /not attached|no (tab|target) with given id/i.test(error.cause.message)

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
  const sendCommand = (target: CommandTarget, method: string, params?: CommandParams): Effect.Effect<unknown, ChromeDebuggerError> =>
    invoke("sendCommand", () => params === undefined
      ? api.sendCommand(target, method)
      : api.sendCommand(target, method, params))

  const detach = (target: Debuggee) => invoke("detach", () => api.detach(target))

  const session = (target: Debuggee, requiredVersion: string, options?: SessionOptions) => Effect.gen(function*() {
    const queue = yield* Queue.make<SessionEvent, Cause.Done>({ capacity: options?.capacity ?? bufferSize, strategy: "sliding" })
    const detached = yield* Deferred.make<DetachReason>()
    let open = true

    // Registered first, so it runs last: after detaching and removing the listeners.
    yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => {
      open = false
      Queue.shutdownUnsafe(queue)
    }))

    const onEvent: EventListener = (source, method, params) => {
      if (open && isTarget(target, source)) {
        Queue.offerUnsafe(queue, { method, params, sessionId: Option.fromNullishOr(source.sessionId) })
      }
    }

    const onDetach: DetachListener = (source, reason) => {
      if (!open || !isTarget(target, source)) return
      open = false
      Deferred.doneUnsafe(detached, Effect.succeed(reason))
      Queue.endUnsafe(queue)
    }

    yield* listen("onEvent", () => api.onEvent, onEvent)
    yield* listen("onDetach", () => api.onDetach, onDetach)
    yield* Effect.acquireRelease(
      invoke("attach", () => api.attach(target, requiredVersion)),
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
    onEvent: observe(() => api.onEvent, (source, method, params) => ({ source, method, params }), debuggerError("onEvent")),
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
