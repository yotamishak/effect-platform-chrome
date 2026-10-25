import type { Layer } from "effect"
import * as ChromeDebugger from "../ChromeDebugger.js"
import * as TestEvent from "./Event.js"

type Debuggee = ChromeDebugger.Debuggee

type CommandTarget = ChromeDebugger.CommandTarget

type CommandParams = ChromeDebugger.CommandParams

/**
 * Answers one CDP command for an attached target. Returning a Promise keeps the command
 * pending; throwing (or rejecting) fails it with that value, as a protocol error does in
 * Chrome. A missing result resolves `{}`, as in Chrome.
 */
export type DebuggerCommandHandler = (
  params: CommandParams | undefined,
  target: CommandTarget
) => object | undefined | Promise<object | undefined>

/** A command the fixture received, with params cloned as Chrome serializes them. */
export interface DebuggerSentCommand {
  readonly target: CommandTarget
  readonly method: string
  readonly params: CommandParams | undefined
}

/** The `makeEvent` controls of one simulated event. */
export type DebuggerEventControls<Args extends ReadonlyArray<unknown>> = ReturnType<typeof TestEvent.makeEvent<Args>>["controls"]

export interface DebuggerControls {
  /** Adds a debug target; its `attached` marks another client (DevTools) as attached. */
  readonly addTarget: (info: ChromeDebugger.TargetInfo) => void
  /** The target goes away: an attachment ends with "target_closed". */
  readonly removeTarget: (targetId: string) => ReadonlyArray<unknown>
  /**
   * Makes `attach` fail with `message`, as for a page the extension may not debug; an
   * existing attachment ends with "target_closed", as when the target navigates there.
   */
  readonly restrict: (targetId: string, message?: string) => ReadonlyArray<unknown>
  /** The user dismisses the debugging infobar: the attachment ends with "canceled_by_user". */
  readonly cancel: (target: Debuggee) => ReadonlyArray<unknown>
  /**
   * An attached target issues a protocol event. Like Chrome, `source` is the debuggee given
   * to `attach`, plus `sessionId` for a child session, and `params` defaults to `{}`.
   */
  readonly emit: (target: Debuggee, method: string, params?: CommandParams, sessionId?: string) => ReadonlyArray<unknown>
  /** Answers `method` with `handler` from now on; without one it resolves `{}`. */
  readonly respond: (method: string, handler: DebuggerCommandHandler | undefined) => void
  /** Whether this extension is attached to the target `debuggee` resolves to. */
  readonly isAttached: (debuggee: Debuggee) => boolean
  /** Commands sent to attached targets, in order. */
  readonly commands: ReadonlyArray<DebuggerSentCommand>
  /** Commands whose handler has not settled yet. */
  readonly pendingCommands: number
  readonly onEvent: DebuggerEventControls<[source: CommandTarget, method: string, params?: object]>
  readonly onDetach: DebuggerEventControls<[source: Debuggee, reason: ChromeDebugger.DetachReason]>
}

export interface DebuggerFixture {
  readonly api: ChromeDebugger.ChromeDebuggerApi
  readonly layer: Layer.Layer<ChromeDebugger.ChromeDebugger>
  readonly controls: DebuggerControls
}

interface Target {
  readonly info: ChromeDebugger.TargetInfo
  restriction: string | undefined
}

interface Attachment {
  readonly debuggee: Debuggee
  readonly pending: Set<(cause: Error) => void>
}

/** The three ids Chrome copies from a debuggee, without `sessionId` or unrelated keys. */
const copyDebuggee = (debuggee: Debuggee): Debuggee => {
  const copy: Debuggee = {}

  if (debuggee.tabId !== undefined) copy.tabId = debuggee.tabId

  if (debuggee.extensionId !== undefined) copy.extensionId = debuggee.extensionId

  if (debuggee.targetId !== undefined) copy.targetId = debuggee.targetId

  return copy
}

/** Chrome names a debuggee in errors by its first id: tab, then extension, then target. */
const label = (debuggee: Debuggee): readonly [kind: string, id: string] =>
  debuggee.tabId !== undefined
    ? ["tab", String(debuggee.tabId)]
    : debuggee.extensionId !== undefined
    ? ["background page", debuggee.extensionId]
    : ["target", debuggee.targetId ?? ""]

/** The protocol versions Chrome accepts for `attach`. */
const supportedVersions: ReadonlySet<string> = new Set(["1.0", "1.1", "1.2", "1.3"])

/**
 * In-memory `chrome.debugger` with Chrome's rules and error messages. Targets are added
 * through `controls.addTarget`. A debuggee resolves like Chrome: `tabId` to a `page` target,
 * else `extensionId` to a `background_page` target, else `targetId` to a target id. `attach`
 * accepts protocol versions "1.0" to "1.3" and one attachment per target, so attaching by
 * `tabId` and then by the same target's `targetId` fails as already attached. `detach` and
 * `sendCommand` need an attachment; `detach` does not fire onDetach, and like Chrome's
 * closing of a target it fails the target's pending commands with "Detached while handling
 * command.". Commands resolve `{}` unless `controls.respond` installs a handler, and every
 * accepted command is recorded in `controls.commands`. `getTargets` reports `attached` for
 * targets this extension is attached to, or that were added already attached (another
 * client). Chrome's own actions are simulated through `controls`, which return the
 * exceptions thrown by listeners. Pass `overrides` to replace any API member.
 */
export const makeDebugger = (overrides: Partial<ChromeDebugger.ChromeDebuggerApi> = {}): DebuggerFixture => {
  const targets = new Map<string, Target>()
  const attachments = new Map<string, Attachment>()
  const handlers = new Map<string, DebuggerCommandHandler>()
  const commands: Array<DebuggerSentCommand> = []
  const onEvent = TestEvent.makeEvent<[source: CommandTarget, method: string, params?: object]>()
  const onDetach = TestEvent.makeEvent<[source: Debuggee, reason: ChromeDebugger.DetachReason]>()

  /** The first target, in insertion order, that `matches`; iterated without copying the map. */
  const first = (matches: (info: ChromeDebugger.TargetInfo) => boolean): Target | undefined => {
    for (const target of targets.values()) {
      if (matches(target.info)) return target
    }

    return undefined
  }

  const find = (debuggee: Debuggee): Target | undefined => {
    if (debuggee.tabId !== undefined) return first((info) => info.type === "page" && info.tabId === debuggee.tabId)

    if (debuggee.extensionId !== undefined) {
      return first((info) => info.type === "background_page" && info.extensionId === debuggee.extensionId)
    }

    return debuggee.targetId === undefined ? undefined : targets.get(debuggee.targetId)
  }

  const resolve = (debuggee: Debuggee): Target => {
    if (debuggee.tabId === undefined && debuggee.extensionId === undefined && debuggee.targetId === undefined) {
      throw new Error("Either tab id or extension id must be specified.")
    }

    const target = find(debuggee)
    const [kind, id] = label(debuggee)

    if (target === undefined) throw new Error(`No ${kind} with given id ${id}.`)

    return target
  }

  const attachment = (debuggee: Debuggee): Attachment => {
    const found = attachments.get(resolve(debuggee).info.id)
    const [kind, id] = label(debuggee)

    if (found === undefined) throw new Error(`Debugger is not attached to the ${kind} with id: ${id}.`)

    return found
  }

  const failPending = (found: Attachment) => {
    for (const reject of Array.from(found.pending)) reject(new Error("Detached while handling command."))
    found.pending.clear()
  }

  /** Chrome ends an attachment on its own: pending commands fail, then onDetach fires. */
  const end = (targetId: string, reason: ChromeDebugger.DetachReason): ReadonlyArray<unknown> => {
    const found = attachments.get(targetId)

    if (found === undefined) return []

    attachments.delete(targetId)
    failPending(found)

    return onDetach.controls.emit(copyDebuggee(found.debuggee), reason)
  }

  /** Runs the handler now; the command stays pending until it settles or the attachment ends. */
  const run = (handler: DebuggerCommandHandler, params: CommandParams | undefined, target: CommandTarget, found: Attachment) =>
    new Promise<object | undefined>((resolveCommand, rejectCommand) => {
      found.pending.add(rejectCommand)

      const settle = (complete: () => void) => {
        if (found.pending.delete(rejectCommand)) complete()
      }

      try {
        Promise.resolve(handler(params, target)).then(
          (result) => settle(() => resolveCommand(result ?? {})),
          (cause: unknown) => settle(() => rejectCommand(cause))
        )
      } catch (cause) {
        settle(() => rejectCommand(cause))
      }
    })

  const api: ChromeDebugger.ChromeDebuggerApi = {
    attach: async (target, requiredVersion) => {
      const found = resolve(target)
      const [kind, id] = label(target)

      if (found.restriction !== undefined) throw new Error(found.restriction)

      if (!supportedVersions.has(requiredVersion)) {
        throw new Error(`Requested protocol version is not supported: ${requiredVersion}.`)
      }

      if (attachments.has(found.info.id)) throw new Error(`Another debugger is already attached to the ${kind} with id: ${id}.`)

      attachments.set(found.info.id, { debuggee: copyDebuggee(target), pending: new Set() })
    },
    detach: async (target) => {
      const found = attachment(target)
      attachments.delete(resolve(target).info.id)
      failPending(found)
    },
    sendCommand: async (target, method, commandParams) => {
      const found = attachment(target)
      const params = commandParams === undefined ? undefined : structuredClone(commandParams)
      commands.push({ target: structuredClone(target), method, params })

      return run(handlers.get(method) ?? (() => ({})), params, structuredClone(target), found)
    },
    getTargets: async () => Array.from(targets.values(), ({ info }) => ({
      ...structuredClone(info),
      attached: info.attached || attachments.has(info.id)
    })),
    onEvent: onEvent.api,
    onDetach: onDetach.api,
    ...overrides
  }

  return {
    api,
    layer: ChromeDebugger.layer(api),
    controls: {
      addTarget: (info: ChromeDebugger.TargetInfo): void => {
        if (targets.has(info.id)) throw new Error(`Target ${info.id} already exists`)
        targets.set(info.id, { info: structuredClone(info), restriction: undefined })
      },
      removeTarget: (targetId: string): ReadonlyArray<unknown> => {
        if (!targets.has(targetId)) throw new Error(`No target ${targetId}`)
        const errors = end(targetId, "target_closed")
        targets.delete(targetId)

        return errors
      },
      restrict: (targetId: string, message = "Cannot attach to this target."): ReadonlyArray<unknown> => {
        const target = targets.get(targetId)

        if (target === undefined) throw new Error(`No target ${targetId}`)

        target.restriction = message

        return end(targetId, "target_closed")
      },
      cancel: (target: Debuggee): ReadonlyArray<unknown> => {
        attachment(target)

        return end(resolve(target).info.id, "canceled_by_user")
      },
      emit: (target: Debuggee, method: string, params: CommandParams = {}, sessionId?: string): ReadonlyArray<unknown> => {
        const source = copyDebuggee(attachment(target).debuggee)

        return onEvent.controls.emit(
          sessionId === undefined ? source : { ...source, sessionId },
          method,
          structuredClone(params)
        )
      },
      respond: (method: string, handler: DebuggerCommandHandler | undefined): void => {
        if (handler === undefined) handlers.delete(method)
        else handlers.set(method, handler)
      },
      isAttached: (debuggee: Debuggee): boolean => {
        const target = find(debuggee)

        return target !== undefined && attachments.has(target.info.id)
      },
      get commands(): ReadonlyArray<DebuggerSentCommand> { return commands },
      get pendingCommands(): number {
        return Array.from(attachments.values()).reduce((count, found) => count + found.pending.size, 0)
      },
      onEvent: onEvent.controls,
      onDetach: onDetach.controls
    }
  }
}
