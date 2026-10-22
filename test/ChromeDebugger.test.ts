// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Deferred, Effect, Exit, Fiber, Logger, Option, Scope, Stream } from "effect"
import type { LogLevel } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeDebugger, ChromeDebuggerError, layer, layerLive, make } from "../src/ChromeDebugger.js"
import type {
  ChromeDebuggerApi, ChromeDebuggerService, CommandParams, CommandTarget, Debuggee, DetachReason, TargetInfo
} from "../src/ChromeDebugger.js"
import { makeEvent } from "../src/ChromeTesting.js"
import { makeDebugger } from "../src/testing/Debugger.js"
import type { EventSource } from "../src/internal/event.js"

const tab: Debuggee = { tabId: 7 }

const page: TargetInfo = { type: "page", id: "target-7", tabId: 7, attached: false, title: "Example", url: "https://example.com/" }

/** A promise settled by the test, for holding a Chrome call open. */
const gate = <A = void>() => {
  let resolve!: (value: A) => void
  let reject!: (cause: Error) => void

  const promise = new Promise<A>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })

  return { promise, resolve, reject }
}

const mockApi = () => {
  const onEvent = makeEvent<[source: CommandTarget, method: string, params?: object]>()
  const onDetach = makeEvent<[source: Debuggee, reason: DetachReason]>()
  // Registration order seen by attach: the session must listen before attaching.
  const listenersAtAttach: Array<number> = []

  const api = {
    attach: vi.fn(async (_target: Debuggee, _requiredVersion: string) => {
      listenersAtAttach.push(onEvent.controls.listenerCount + onDetach.controls.listenerCount)
    }),
    detach: vi.fn(async (_target: Debuggee) => {}),
    sendCommand: vi.fn(async (_target: CommandTarget, _method: string, _params?: CommandParams): Promise<object | undefined> => ({ ok: true })),
    getTargets: vi.fn(async () => [page]),
    onEvent: onEvent.api,
    onDetach: onDetach.api
  } satisfies ChromeDebuggerApi

  return {
    api,
    listenersAtAttach,
    onEvent: onEvent.controls,
    onDetach: onDetach.controls,
    get listeners() { return onEvent.controls.listenerCount + onDetach.controls.listenerCount }
  }
}

type Mock = ReturnType<typeof mockApi>

/** Holds the next `attach` open; `called` resolves once the session has asked Chrome to attach. */
const holdAttach = (mock: Mock) => {
  const called = gate()
  const result = gate()
  mock.api.attach.mockImplementationOnce(async () => {
    called.resolve()

    return result.promise
  })

  return { called: Effect.promise(() => called.promise), resolve: () => result.resolve(), reject: result.reject }
}

/** An event whose `addListener` registers the listener and then throws, as Chrome may. */
const registersThenThrows = <Args extends ReadonlyArray<unknown>>(source: EventSource<Args>, cause: Error): EventSource<Args> => ({
  addListener: (listener) => {
    source.addListener(listener)
    throw cause
  },
  removeListener: (listener) => source.removeListener(listener)
})

/** Collects the levels of everything logged while `effect` runs. */
const withLogLevels = <A, E>(effect: Effect.Effect<A, E>) => Effect.gen(function*() {
  const levels: Array<LogLevel.LogLevel> = []
  const value = yield* effect.pipe(Effect.provide(Logger.layer([Logger.make((options) => { levels.push(options.logLevel) })])))

  return { value, levels }
})

/** Each Promise call, the arguments that run it, and the operation its errors name. */
const calls: ReadonlyArray<{
  readonly operation: "attach" | "detach" | "sendCommand" | "getTargets"
  readonly run: (service: ChromeDebuggerService) => Effect.Effect<void, ChromeDebuggerError>
}> = [
  { operation: "attach", run: (service) => service.attach(tab, "1.3") },
  { operation: "detach", run: (service) => service.detach(tab) },
  { operation: "sendCommand", run: (service) => Effect.asVoid(service.sendCommand(tab, "Page.enable")) },
  { operation: "getTargets", run: (service) => Effect.asVoid(service.getTargets) }
]

/** Runs one of the service's event streams to its end. */
const drain = (service: ChromeDebuggerService, operation: "onEvent" | "onDetach") =>
  operation === "onEvent" ? Stream.runDrain(service.onEvent) : Stream.runDrain(service.onDetach)

describe("ChromeDebugger", () => {
  it.effect("forwards attach, detach, commands and target listing, passing params only when given", () => Effect.gen(function*() {
    const { api } = mockApi()
    const debuggerService = make(api)
    yield* debuggerService.attach(tab, "1.3")
    expect(api.attach).toHaveBeenCalledExactlyOnceWith(tab, "1.3")
    expect(yield* debuggerService.sendCommand(tab, "Page.enable")).toEqual(Option.some({ ok: true }))
    yield* debuggerService.sendCommand({ ...tab, sessionId: "child" }, "Runtime.evaluate", { expression: "1 + 1" })
    yield* debuggerService.sendCommand(tab, "Runtime.evaluate", {})
    expect(api.sendCommand.mock.calls).toEqual([
      [tab, "Page.enable"],
      [{ tabId: 7, sessionId: "child" }, "Runtime.evaluate", { expression: "1 + 1" }],
      [tab, "Runtime.evaluate", {}]
    ])
    expect(api.sendCommand.mock.calls[0]).toHaveLength(2)
    yield* debuggerService.detach(tab)
    expect(api.detach).toHaveBeenCalledExactlyOnceWith(tab)
    expect(yield* debuggerService.getTargets).toEqual([page])
    expect(api.getTargets).toHaveBeenCalledExactlyOnceWith()
  }))

  it.effect("resolves a command result as an Option, None only when the API resolves nothing", () => Effect.gen(function*() {
    const { api } = mockApi()
    const debuggerService = make(api)
    api.sendCommand.mockResolvedValueOnce(undefined)
    expect(yield* debuggerService.sendCommand(tab, "Page.enable")).toEqual(Option.none())
    api.sendCommand.mockResolvedValueOnce({})
    expect(yield* debuggerService.sendCommand(tab, "Page.enable")).toEqual(Option.some({}))
  }))

  it("is lazy: building the service and its effects calls nothing", () => {
    const mock = mockApi()
    const debuggerService = make(mock.api)

    const effects = [
      debuggerService.attach(tab, "1.3"), debuggerService.detach(tab), debuggerService.sendCommand(tab, "Page.enable"),
      debuggerService.getTargets, debuggerService.session(tab, "1.3")
    ]

    expect(effects).toHaveLength(5)
    expect(mock.api.attach).not.toHaveBeenCalled()
    expect(mock.api.detach).not.toHaveBeenCalled()
    expect(mock.api.sendCommand).not.toHaveBeenCalled()
    expect(mock.api.getTargets).not.toHaveBeenCalled()
    expect(mock.listeners).toBe(0)
  })

  it.effect("maps every call's rejection and synchronous throw to a typed error naming the operation", () => Effect.gen(function*() {
    for (const { operation, run } of calls) {
      for (const mode of ["reject", "throw"] as const) {
        const { api } = mockApi()
        const cause = new Error(`${operation} ${mode}`)
        const method = api[operation]

        if (mode === "reject") method.mockRejectedValueOnce(cause)
        else method.mockImplementationOnce(() => { throw cause })

        const error = yield* Effect.flip(run(make(api)))
        expect(error).toBeInstanceOf(ChromeDebuggerError)
        expect(error).toMatchObject({ operation, cause })
      }
    }
  }))

  it.effect("keeps Chrome's own error text, such as a protocol error, as the cause", () => Effect.gen(function*() {
    const { api } = mockApi()
    const unknownMethod = new Error("{\"code\":-32601,\"message\":\"'Nope.nope' wasn't found\"}")
    api.sendCommand.mockRejectedValueOnce(unknownMethod)
    const error = yield* Effect.flip(make(api).sendCommand(tab, "Nope.nope"))
    expect(error.cause).toBe(unknownMethod)
    expect(error.operation).toBe("sendCommand")
  }))

  it.effect("streams raw events, params as an Option, and removes the listener when the stream ends", () => Effect.gen(function*() {
    const mock = mockApi()
    const events = yield* Effect.forkScoped(Stream.runCollect(Stream.take(make(mock.api).onEvent, 3)))
    yield* Effect.promise(() => mock.onEvent.waitForListener())
    mock.onEvent.emit(tab, "Page.loadEventFired", { timestamp: 1 })
    mock.onEvent.emit({ tabId: 8 }, "Inspector.detached")
    mock.onEvent.emit({ tabId: 7, sessionId: "child" }, "Runtime.executionContextCreated", {})
    expect(yield* Fiber.join(events)).toEqual([
      { source: tab, method: "Page.loadEventFired", params: Option.some({ timestamp: 1 }) },
      { source: { tabId: 8 }, method: "Inspector.detached", params: Option.none() },
      { source: { tabId: 7, sessionId: "child" }, method: "Runtime.executionContextCreated", params: Option.some({}) }
    ])
    expect(mock.listeners).toBe(0)
  }))

  it.effect("streams Chrome's detaches and removes the listener when interrupted", () => Effect.gen(function*() {
    const mock = mockApi()
    const received = yield* Deferred.make<void>()
    const seen: Array<unknown> = []

    const fiber = yield* Effect.forkChild(Stream.runForEach(make(mock.api).onDetach, (event) => Effect.gen(function*() {
      seen.push(event)

      if (seen.length === 2) yield* Deferred.succeed(received, undefined)
    })))

    yield* Effect.promise(() => mock.onDetach.waitForListener())
    mock.onDetach.emit(tab, "target_closed")
    mock.onDetach.emit({ targetId: "worker" }, "canceled_by_user")
    yield* Deferred.await(received)
    yield* Fiber.interrupt(fiber)
    expect(seen).toEqual([{ source: tab, reason: "target_closed" }, { source: { targetId: "worker" }, reason: "canceled_by_user" }])
    expect(mock.listeners).toBe(0)
  }))

  it.effect("types each stream's registration failure, getter failure and partial registration", () => Effect.gen(function*() {
    for (const operation of ["onEvent", "onDetach"] as const) {
      const mock = mockApi()
      const cause = new Error(`${operation} unavailable`)
      mock[operation].failNext("addListener", cause)
      expect(yield* Effect.flip(drain(make(mock.api), operation))).toMatchObject({ operation, cause })

      const getter = new Error(`${operation} getter`)
      const throwing: ChromeDebuggerApi = Object.defineProperty({ ...mock.api }, operation, { get: () => { throw getter } })
      expect(yield* Effect.flip(drain(make(throwing), operation))).toMatchObject({ operation, cause: getter })

      // Chrome may register the listener and still throw; it must be removed again.
      const partial = new Error(`${operation} partially registered`)

      const partlyRegistered: ChromeDebuggerApi = operation === "onEvent"
        ? { ...mock.api, onEvent: registersThenThrows(mock.api.onEvent, partial) }
        : { ...mock.api, onDetach: registersThenThrows(mock.api.onDetach, partial) }

      expect(yield* Effect.flip(drain(make(partlyRegistered), operation))).toMatchObject({ operation, cause: partial })
      expect(mock.listeners).toBe(0)
    }
  }))

  it.effect("keeps only the newest 64 stream events when the consumer falls behind", () => Effect.gen(function*() {
    const mock = mockApi()
    const events = yield* Effect.forkScoped(Stream.runCollect(Stream.take(make(mock.api).onEvent, 64)))
    yield* Effect.promise(() => mock.onEvent.waitForListener())

    for (let index = 0; index < 100; index++) mock.onEvent.emit(tab, `Event.${index}`)

    expect((yield* Fiber.join(events)).map((event) => event.method)).toEqual(
      Array.from({ length: 64 }, (_, index) => `Event.${index + 36}`)
    )
    expect(mock.listeners).toBe(0)
  }))
})

describe("ChromeDebugger.session", () => {
  it.effect("binds a session to its target, listening before attach and detaching on release", () => Effect.gen(function*() {
    const mock = mockApi()

    const events = yield* Effect.scoped(Effect.gen(function*() {
      const session = yield* make(mock.api).session(tab, "1.3")
      expect(mock.listenersAtAttach).toEqual([2])
      expect(mock.api.attach).toHaveBeenCalledExactlyOnceWith(tab, "1.3")
      expect(session.target).toBe(tab)
      expect(yield* session.sendCommand("Network.enable")).toEqual(Option.some({ ok: true }))
      yield* session.sendCommand("Runtime.evaluate", { expression: "1" }, "child")
      yield* session.sendCommand("Runtime.enable", undefined, "child")
      expect(mock.api.sendCommand.mock.calls).toEqual([
        [tab, "Network.enable"],
        [{ tabId: 7, sessionId: "child" }, "Runtime.evaluate", { expression: "1" }],
        [{ tabId: 7, sessionId: "child" }, "Runtime.enable"]
      ])
      // Delivered before anyone consumes: the session's listener buffers them.
      mock.onEvent.emit(tab, "Network.requestWillBeSent", { requestId: "1" })
      mock.onEvent.emit({ tabId: 8 }, "Network.requestWillBeSent", { requestId: "other tab" })
      mock.onEvent.emit({ targetId: "worker" }, "Runtime.consoleAPICalled")
      mock.onEvent.emit({ tabId: 7, sessionId: "child" }, "Runtime.executionContextCreated")
      mock.onDetach.emit({ tabId: 8 }, "target_closed")
      expect(mock.api.detach).not.toHaveBeenCalled()

      return yield* Stream.runCollect(Stream.take(session.events, 2))
    }))

    expect(events).toEqual([
      { method: "Network.requestWillBeSent", params: Option.some({ requestId: "1" }), sessionId: Option.none() },
      { method: "Runtime.executionContextCreated", params: Option.none(), sessionId: Option.some("child") }
    ])
    expect(mock.api.detach).toHaveBeenCalledExactlyOnceWith(tab)
    expect(mock.listeners).toBe(0)
  }))

  it.effect("routes events by every id the target names", () => Effect.gen(function*() {
    const mock = mockApi()
    const debuggerService = make(mock.api)

    const methods = yield* Effect.scoped(Effect.gen(function*() {
      const byExtension = yield* debuggerService.session({ extensionId: "abc" }, "1.3")
      const byTarget = yield* debuggerService.session({ targetId: "worker" }, "1.3")
      mock.onEvent.emit({ extensionId: "abc" }, "Extension.event")
      mock.onEvent.emit({ extensionId: "other" }, "Other.extension")
      mock.onEvent.emit({ targetId: "worker", sessionId: "s" }, "Worker.event")
      mock.onEvent.emit({ targetId: "other" }, "Other.target")
      mock.onEvent.emit(tab, "Tab.event")
      mock.onDetach.emit({ extensionId: "abc" }, "target_closed")
      mock.onDetach.emit({ targetId: "worker" }, "canceled_by_user")

      return {
        extension: (yield* Stream.runCollect(byExtension.events)).map((event) => event.method),
        target: (yield* Stream.runCollect(byTarget.events)).map((event) => event.method),
        reasons: [yield* byExtension.detached, yield* byTarget.detached]
      }
    }))

    expect(methods).toEqual({ extension: ["Extension.event"], target: ["Worker.event"], reasons: ["target_closed", "canceled_by_user"] })
    expect(mock.api.detach).not.toHaveBeenCalled()
    expect(mock.listeners).toBe(0)
  }))

  it.effect("ends a session's events when Chrome detaches its target, then skips detaching", () => Effect.gen(function*() {
    const mock = mockApi()

    const reason = yield* Effect.scoped(Effect.gen(function*() {
      const session = yield* make(mock.api).session(tab, "1.3")
      mock.onEvent.emit(tab, "Page.frameNavigated", { frame: {} })
      mock.onDetach.emit(tab, "canceled_by_user")
      mock.onEvent.emit(tab, "Page.loadEventFired")
      mock.onDetach.emit(tab, "target_closed")
      expect((yield* Stream.runCollect(session.events)).map((event) => event.method)).toEqual(["Page.frameNavigated"])
      // Ended streams stay ended for later consumers.
      expect(yield* Stream.runCollect(session.events)).toEqual([])

      return yield* session.detached
    }))

    expect(reason).toBe("canceled_by_user")
    expect(mock.api.detach).not.toHaveBeenCalled()
    expect(mock.listeners).toBe(0)
  }))

  it.effect("ignores events and detaches of an earlier attachment while attach is pending", () => Effect.gen(function*() {
    const mock = mockApi()
    const attach = holdAttach(mock)
    const scope = yield* Scope.make()
    const acquiring = yield* Effect.forkChild(make(mock.api).session(tab, "1.3").pipe(Scope.provide(scope)))
    yield* attach.called
    // Another context of this extension is still ending its own attachment to the tab.
    mock.onEvent.emit(tab, "Stale.event")
    mock.onDetach.emit(tab, "canceled_by_user")
    attach.resolve()
    const session = yield* Fiber.join(acquiring)
    mock.onEvent.emit(tab, "Fresh.event")
    mock.onDetach.emit(tab, "target_closed")
    expect((yield* Stream.runCollect(session.events)).map((event) => event.method)).toEqual(["Fresh.event"])
    expect(yield* session.detached).toBe("target_closed")
    yield* Scope.close(scope, Exit.void)
    expect(mock.api.detach).not.toHaveBeenCalled()
    expect(mock.listeners).toBe(0)
  }))

  it.effect("waits for a pending attach when interrupted, then detaches", () => Effect.gen(function*() {
    const mock = mockApi()
    const attach = holdAttach(mock)
    const fiber = yield* Effect.forkChild(Effect.scoped(Effect.andThen(make(mock.api).session(tab, "1.3"), Effect.never)))
    yield* attach.called
    const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))
    expect(mock.api.detach).not.toHaveBeenCalled()
    expect(mock.listeners).toBe(2)
    attach.resolve()
    yield* Fiber.join(interrupting)
    expect(mock.api.detach).toHaveBeenCalledExactlyOnceWith(tab)
    expect(mock.listeners).toBe(0)
    expect(Exit.hasInterrupts(yield* Effect.exit(Fiber.join(fiber)))).toBe(true)
  }))

  it.effect("removes its listeners without detaching when a pending attach fails during interruption", () => Effect.gen(function*() {
    const mock = mockApi()
    const attach = holdAttach(mock)
    const fiber = yield* Effect.forkChild(Effect.scoped(make(mock.api).session(tab, "1.3")))
    yield* attach.called
    const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))
    attach.reject(new Error("Another debugger is already attached to the tab with id: 7."))
    yield* Fiber.join(interrupting)
    expect(mock.api.detach).not.toHaveBeenCalled()
    expect(mock.listeners).toBe(0)
  }))

  it.effect("removes its listeners without detaching when attach or registration fails", () => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("Cannot access a chrome:// URL")
    mock.api.attach.mockRejectedValueOnce(cause)
    expect(yield* Effect.flip(Effect.scoped(make(mock.api).session(tab, "1.3")))).toMatchObject({ operation: "attach", cause })
    expect(mock.listeners).toBe(0)
    const thrown = new Error("thrown synchronously")
    mock.api.attach.mockImplementationOnce(() => { throw thrown })
    expect(yield* Effect.flip(Effect.scoped(make(mock.api).session(tab, "1.3")))).toMatchObject({ operation: "attach", cause: thrown })
    expect(mock.listeners).toBe(0)

    for (const operation of ["onEvent", "onDetach"] as const) {
      const registration = new Error(`${operation} unavailable`)
      mock[operation].failNext("addListener", registration)
      expect(yield* Effect.flip(Effect.scoped(make(mock.api).session(tab, "1.3")))).toMatchObject({ operation, cause: registration })
      expect(mock.listeners).toBe(0)

      const getter = new Error(`${operation} getter`)
      const throwing: ChromeDebuggerApi = Object.defineProperty({ ...mock.api }, operation, { get: () => { throw getter } })
      expect(yield* Effect.flip(Effect.scoped(make(throwing).session(tab, "1.3")))).toMatchObject({ operation, cause: getter })
      expect(mock.listeners).toBe(0)
    }

    expect(mock.api.attach).toHaveBeenCalledTimes(2)
    expect(mock.api.detach).not.toHaveBeenCalled()
  }))

  it.effect("rejects an invalid capacity before registering or attaching", () => Effect.gen(function*() {
    const mock = mockApi()

    for (const capacity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      const error = yield* Effect.flip(Effect.scoped(make(mock.api).session(tab, "1.3", { capacity })))
      expect(error).toMatchObject({ operation: "session" })
      expect(error.cause).toBeInstanceOf(RangeError)
    }

    expect(mock.api.attach).not.toHaveBeenCalled()
    expect(mock.listeners).toBe(0)

    const kept = yield* Effect.scoped(Effect.gen(function*() {
      const session = yield* make(mock.api).session(tab, "1.3", { capacity: 1 })

      for (const method of ["a", "b", "c"]) mock.onEvent.emit(tab, method)

      mock.onDetach.emit(tab, "target_closed")

      return (yield* Stream.runCollect(session.events)).map((event) => event.method)
    }))

    expect(kept).toEqual(["c"])
  }))

  it.effect("ignores release failures, warning only for unexpected ones", () => Effect.gen(function*() {
    const silent = [
      "Debugger is not attached to the tab with id: 7.",
      "No tab with given id 7.",
      "No background page with given id abc.",
      "No target with given id worker."
    ]

    for (const message of silent) {
      const mock = mockApi()
      mock.api.detach.mockRejectedValueOnce(new Error(message))
      const { value: exit, levels } = yield* withLogLevels(Effect.exit(Effect.scoped(make(mock.api).session(tab, "1.3"))))
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(levels).toEqual([])
      expect(mock.api.detach).toHaveBeenCalledOnce()
    }

    for (const fail of ["reject", "throw"] as const) {
      const mock = mockApi()
      const unexpected = new Error("unexpected")

      if (fail === "reject") mock.api.detach.mockRejectedValueOnce(unexpected)
      else mock.api.detach.mockImplementationOnce(() => { throw unexpected })

      const { value: exit, levels } = yield* withLogLevels(Effect.exit(Effect.scoped(make(mock.api).session(tab, "1.3"))))
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(levels).toEqual(["Warn"])
      expect(mock.listeners).toBe(0)
    }
  }))

  it.effect("keeps the scope's exit when removing a listener throws during release", () => Effect.gen(function*() {
    const mock = mockApi()
    mock.onEvent.failNext("removeListener", new Error("removeListener failed"))
    const exit = yield* Effect.exit(Effect.scoped(Effect.as(make(mock.api).session(tab, "1.3"), "done")))
    expect(exit).toEqual(Exit.succeed("done"))
    expect(mock.api.detach).toHaveBeenCalledOnce()
    expect(mock.onDetach.listenerCount).toBe(0)
  }))

  it.effect("detaches and interrupts event consumers when the owning fiber is interrupted", () => Effect.gen(function*() {
    const mock = mockApi()
    const ready = yield* Deferred.make<void>()

    const fiber = yield* Effect.forkChild(Effect.scoped(Effect.gen(function*() {
      const session = yield* make(mock.api).session(tab, "1.3", { capacity: 2 })
      yield* Deferred.succeed(ready, undefined)

      return yield* Stream.runDrain(session.events)
    })))

    yield* Deferred.await(ready)
    expect(mock.onEvent.listenerCount).toBe(1)
    yield* Fiber.interrupt(fiber)
    expect(mock.api.detach).toHaveBeenCalledExactlyOnceWith(tab)
    expect(mock.listeners).toBe(0)
  }))

  it.effect("interrupts consumers in other fibers and later consumers once the scope closes", () => Effect.gen(function*() {
    const mock = mockApi()
    const scope = yield* Scope.make()
    const session = yield* make(mock.api).session(tab, "1.3").pipe(Scope.provide(scope))
    mock.onEvent.emit(tab, "Buffered.event")
    const consumer = yield* Effect.forkChild(Stream.runDrain(Stream.drop(session.events, 1)))
    yield* Scope.close(scope, Exit.void)
    expect(Exit.hasInterrupts(yield* Effect.exit(Fiber.join(consumer)))).toBe(true)
    expect(Exit.hasInterrupts(yield* Effect.exit(Stream.runCollect(session.events)))).toBe(true)
    // Nothing reaches a released session, and `detached` reports no Chrome detach.
    expect(mock.onEvent.emit(tab, "Late.event")).toEqual([])
    expect(mock.onDetach.emit(tab, "target_closed")).toEqual([])
    expect(yield* Effect.raceFirst(session.detached, Effect.succeed("still waiting"))).toBe("still waiting")
    expect(mock.listeners).toBe(0)
  }))

  it.effect("fails commands with a typed error once Chrome has detached the target", () => Effect.gen(function*() {
    const mock = mockApi()

    const error = yield* Effect.scoped(Effect.gen(function*() {
      const session = yield* make(mock.api).session(tab, "1.3")
      mock.onDetach.emit(tab, "target_closed")
      const detached = new Error("Debugger is not attached to the tab with id: 7.")
      mock.api.sendCommand.mockRejectedValueOnce(detached)

      return yield* Effect.flip(session.sendCommand("Page.reload"))
    }))

    expect(error).toMatchObject({ operation: "sendCommand" })
    expect(mock.api.detach).not.toHaveBeenCalled()
  }))

  it.effect("keeps the newest events when a session's buffer overflows", () => Effect.gen(function*() {
    const mock = mockApi()

    const methods = yield* Effect.scoped(Effect.gen(function*() {
      const session = yield* make(mock.api).session(tab, "1.3", { capacity: 2 })

      for (const method of ["a", "b", "c"]) mock.onEvent.emit(tab, method)

      mock.onDetach.emit(tab, "target_closed")

      return (yield* Stream.runCollect(session.events)).map((event) => event.method)
    }))

    expect(methods).toEqual(["b", "c"])
  }))
})

describe("ChromeDebugger layers", () => {
  it.effect("provides an injected API and reads the global only when the live layer builds", () => Effect.gen(function*() {
    const { api } = mockApi()
    expect(yield* Effect.flatMap(ChromeDebugger, (service) => service.getTargets).pipe(Effect.provide(layer(api)))).toEqual([page])
    yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => vi.unstubAllGlobals()))
    vi.stubGlobal("chrome", undefined)
    const missing = yield* Effect.flip(ChromeDebugger.pipe(Effect.provide(layerLive)))
    expect(missing).toMatchObject({ operation: "initialize" })
    expect(missing.cause).toBeInstanceOf(Error)
    vi.stubGlobal("chrome", {})
    const unavailable = yield* Effect.flip(ChromeDebugger.pipe(Effect.provide(layerLive)))
    expect(unavailable).toMatchObject({ operation: "initialize", cause: new Error("chrome.debugger is unavailable in this context") })
    vi.stubGlobal("chrome", { debugger: api })
    expect(yield* Effect.flatMap(ChromeDebugger, (service) => service.getTargets).pipe(Effect.provide(layerLive))).toEqual([page])
  }))

  it.effect("types a throwing chrome.debugger getter as an initialize failure", () => Effect.gen(function*() {
    yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => vi.unstubAllGlobals()))
    const cause = new Error("'debugger' permission missing")
    vi.stubGlobal("chrome", Object.defineProperty({}, "debugger", { get: () => { throw cause } }))
    expect(yield* Effect.flip(ChromeDebugger.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize", cause })
  }))
})

describe("makeDebugger", () => {
  const worker: TargetInfo = { type: "worker", id: "worker-1", attached: false, title: "sw", url: "chrome-extension://abc/sw.js" }

  const background: TargetInfo = {
    type: "background_page", id: "bg-1", extensionId: "abc", attached: false, title: "bg", url: "chrome-extension://abc/bg.html"
  }

  const fixture = () => {
    const debuggerFixture = makeDebugger()
    debuggerFixture.controls.addTarget(page)
    debuggerFixture.controls.addTarget(worker)
    debuggerFixture.controls.addTarget(background)

    return debuggerFixture
  }

  const attachError = (api: ChromeDebuggerApi, target: Debuggee, version = "1.3") =>
    Effect.flip(make(api).attach(target, version)).pipe(Effect.map((error) => error.cause))

  it.effect("attaches with Chrome's rules and error messages", () => Effect.gen(function*() {
    const { api, controls } = fixture()
    expect(yield* attachError(api, {})).toEqual(new Error("Either tab id or extension id must be specified."))
    expect(yield* attachError(api, { tabId: 99 })).toEqual(new Error("No tab with given id 99."))
    expect(yield* attachError(api, { extensionId: "zzz" })).toEqual(new Error("No background page with given id zzz."))
    expect(yield* attachError(api, { targetId: "nope" })).toEqual(new Error("No target with given id nope."))
    // A tab id resolves to a page target only.
    expect(yield* attachError(api, { tabId: 7, targetId: "worker-1" }, "0.1")).toEqual(new Error("Requested protocol version is not supported: 0.1."))
    expect(yield* attachError(api, tab, "2.0")).toEqual(new Error("Requested protocol version is not supported: 2.0."))

    for (const version of ["1.0", "1.1", "1.2", "1.3"]) {
      yield* make(api).attach(tab, version)
      expect(controls.isAttached({ targetId: "target-7" })).toBe(true)
      yield* make(api).detach({ targetId: "target-7" })
    }

    yield* make(api).attach(tab, "1.3")
    expect(yield* attachError(api, { targetId: "target-7" })).toEqual(new Error("Another debugger is already attached to the target with id: target-7."))
    expect(yield* attachError(api, tab)).toEqual(new Error("Another debugger is already attached to the tab with id: 7."))
    yield* make(api).attach({ extensionId: "abc" }, "1.3")
    expect(controls.isAttached({ targetId: "bg-1" })).toBe(true)
    expect(controls.isAttached({ tabId: 99 })).toBe(false)
    controls.restrict("worker-1")
    expect(yield* attachError(api, { targetId: "worker-1" })).toEqual(new Error("Cannot attach to this target."))
  }))

  it.effect("detaches only attached targets, without onDetach, failing their pending commands", () => Effect.gen(function*() {
    const { api, controls } = fixture()
    const service = make(api)
    expect(yield* Effect.flip(service.detach(tab))).toMatchObject({
      operation: "detach", cause: new Error("Debugger is not attached to the tab with id: 7.")
    })
    expect(yield* Effect.flip(service.detach({ tabId: 1 }))).toMatchObject({ cause: new Error("No tab with given id 1.") })
    expect(yield* Effect.flip(service.sendCommand(tab, "Page.enable"))).toMatchObject({
      operation: "sendCommand", cause: new Error("Debugger is not attached to the tab with id: 7.")
    })
    yield* service.attach(tab, "1.3")
    const invoked = gate()
    const held = gate<object>()
    const detaches = vi.fn()
    api.onDetach.addListener(detaches)
    controls.respond("Debugger.pause", () => {
      invoked.resolve()

      return held.promise
    })
    const pending = yield* Effect.forkChild(service.sendCommand(tab, "Debugger.pause"))
    yield* Effect.promise(() => invoked.promise)
    expect(controls.pendingCommands).toBe(1)
    yield* service.detach(tab)
    expect(controls.pendingCommands).toBe(0)
    expect(yield* Effect.flip(Fiber.join(pending))).toMatchObject({ cause: new Error("Detached while handling command.") })
    held.resolve({ late: true })
    expect(detaches).not.toHaveBeenCalled()
    expect(controls.isAttached(tab)).toBe(false)
    api.onDetach.removeListener(detaches)
  }))

  it.effect("answers commands with {} or a handler, records them, and types protocol errors", () => Effect.gen(function*() {
    const { api, controls } = fixture()
    const service = make(api)
    yield* service.attach(tab, "1.3")
    expect(yield* service.sendCommand(tab, "Page.enable")).toEqual(Option.some({}))
    controls.respond("Runtime.evaluate", (params) => ({ result: { value: params?.["expression"] } }))
    const params = { expression: "document.title" }
    expect(yield* service.sendCommand({ ...tab, sessionId: "child" }, "Runtime.evaluate", params)).toEqual(Option.some({ result: { value: "document.title" } }))
    controls.respond("Nope.nope", () => { throw new Error("{\"code\":-32601,\"message\":\"'Nope.nope' wasn't found\"}") })
    expect(yield* Effect.flip(service.sendCommand(tab, "Nope.nope"))).toMatchObject({
      operation: "sendCommand", cause: new Error("{\"code\":-32601,\"message\":\"'Nope.nope' wasn't found\"}")
    })
    controls.respond("Async.fails", async () => Promise.reject(new Error("async failure")))
    expect(yield* Effect.flip(service.sendCommand(tab, "Async.fails"))).toMatchObject({ cause: new Error("async failure") })
    controls.respond("Runtime.evaluate", undefined)
    expect(yield* service.sendCommand(tab, "Runtime.evaluate", params)).toEqual(Option.some({}))
    controls.respond("Empty.result", () => undefined)
    expect(yield* service.sendCommand(tab, "Empty.result")).toEqual(Option.some({}))
    expect(controls.commands.map((command) => [command.target, command.method, command.params])).toEqual([
      [tab, "Page.enable", undefined],
      [{ tabId: 7, sessionId: "child" }, "Runtime.evaluate", params],
      [tab, "Nope.nope", undefined],
      [tab, "Async.fails", undefined],
      [tab, "Runtime.evaluate", params],
      [tab, "Empty.result", undefined]
    ])
    expect(controls.commands[1]?.params).not.toBe(params)
  }))

  it.effect("lists copies of its targets with this extension's attachments", () => Effect.gen(function*() {
    const { api, controls } = fixture()
    controls.addTarget({ ...page, id: "devtools-open", tabId: 8, attached: true })
    expect(() => controls.addTarget(page)).toThrow("Target target-7 already exists")
    const service = make(api)
    yield* service.attach(tab, "1.3")
    const targets = yield* service.getTargets
    expect(targets.map((target) => [target.id, target.attached])).toEqual([
      ["target-7", true], ["worker-1", false], ["bg-1", false], ["devtools-open", true]
    ])

    for (const target of targets) target.title = "changed"

    expect((yield* service.getTargets).map((target) => target.title)).toEqual(["Example", "sw", "bg", "Example"])
    // Another client (DevTools) does not stop this extension attaching.
    yield* service.attach({ tabId: 8 }, "1.3")
  }))

  it.effect("emits events from the attach debuggee and ends attachments like Chrome", () => Effect.gen(function*() {
    const { api, controls } = fixture()
    const service = make(api)
    expect(() => controls.emit(tab, "Page.loadEventFired")).toThrow("Debugger is not attached to the tab with id: 7.")
    yield* service.attach({ targetId: "target-7" }, "1.3")
    const events = yield* Effect.forkScoped(Stream.runCollect(Stream.take(service.onEvent, 2)))
    const detaches = yield* Effect.forkScoped(Stream.runCollect(Stream.take(service.onDetach, 3)))
    yield* Effect.promise(() => controls.onEvent.waitForListener())
    yield* Effect.promise(() => controls.onDetach.waitForListener())
    controls.emit(tab, "Page.loadEventFired")
    controls.emit(tab, "Runtime.consoleAPICalled", { type: "log" }, "child")
    expect(yield* Fiber.join(events)).toEqual([
      { source: { targetId: "target-7" }, method: "Page.loadEventFired", params: Option.some({}) },
      { source: { targetId: "target-7", sessionId: "child" }, method: "Runtime.consoleAPICalled", params: Option.some({ type: "log" }) }
    ])
    const thrown = new Error("listener failed")
    const throwing = () => { throw thrown }

    api.onDetach.addListener(throwing)
    expect(controls.cancel(tab)).toEqual([thrown])
    api.onDetach.removeListener(throwing)
    expect(() => controls.cancel(tab)).toThrow("Debugger is not attached to the tab with id: 7.")
    yield* service.attach(tab, "1.3")
    controls.restrict("target-7", "Cannot access a chrome:// URL")
    expect(yield* attachError(api, tab)).toEqual(new Error("Cannot access a chrome:// URL"))
    yield* service.attach({ extensionId: "abc" }, "1.3")
    expect(controls.removeTarget("bg-1")).toEqual([])
    expect(controls.removeTarget("worker-1")).toEqual([])
    expect(() => controls.removeTarget("worker-1")).toThrow("No target worker-1")
    expect(() => controls.restrict("worker-1")).toThrow("No target worker-1")
    expect(yield* Fiber.join(detaches)).toEqual([
      { source: { targetId: "target-7" }, reason: "canceled_by_user" },
      { source: tab, reason: "target_closed" },
      { source: { extensionId: "abc" }, reason: "target_closed" }
    ])
    expect(controls.onEvent.listenerCount + controls.onDetach.listenerCount).toBe(0)
  }))

  it.effect("drives sessions: Chrome closing the tab ends events and skips detaching", () => Effect.gen(function*() {
    const { api, controls } = fixture()

    const result = yield* Effect.scoped(Effect.gen(function*() {
      const session = yield* make(api).session(tab, "1.3")
      yield* session.sendCommand("Network.enable")
      controls.emit(tab, "Network.requestWillBeSent", { requestId: "1" })
      controls.removeTarget("target-7")

      return { events: yield* Stream.runCollect(session.events), reason: yield* session.detached }
    }))

    expect(result).toEqual({
      events: [{ method: "Network.requestWillBeSent", params: Option.some({ requestId: "1" }), sessionId: Option.none() }],
      reason: "target_closed"
    })
    expect(controls.onEvent.listenerCount + controls.onDetach.listenerCount).toBe(0)
  }))

  it.effect("drives sessions: release detaches, so the target can be attached again", () => Effect.gen(function*() {
    const { api, controls } = fixture()
    const service = make(api)
    yield* Effect.scoped(service.session(tab, "1.3"))
    expect(controls.isAttached(tab)).toBe(false)
    yield* Effect.scoped(Effect.gen(function*() {
      yield* service.session(tab, "1.3")
      expect(yield* Effect.flip(Effect.scoped(service.session({ targetId: "target-7" }, "1.3")))).toMatchObject({
        operation: "attach", cause: new Error("Another debugger is already attached to the target with id: target-7.")
      })
      expect(controls.isAttached(tab)).toBe(true)
    }))
    expect(controls.isAttached(tab)).toBe(false)
    expect(controls.onEvent.listenerCount + controls.onDetach.listenerCount).toBe(0)
  }))

  it.effect("takes overrides and provides a layer", () => Effect.gen(function*() {
    const getTargets = vi.fn(async () => [worker])
    const { layer: fixtureLayer } = makeDebugger({ getTargets })
    expect(yield* Effect.flatMap(ChromeDebugger, (service) => service.getTargets).pipe(Effect.provide(fixtureLayer))).toEqual([worker])
    expect(getTargets).toHaveBeenCalledOnce()
  }))
})
