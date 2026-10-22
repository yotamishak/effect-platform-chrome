// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Deferred, Effect, Exit, Fiber, Option, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeDebugger, ChromeDebuggerError, layer, layerLive, make } from "../src/ChromeDebugger.js"
import type { ChromeDebuggerApi, CommandParams, CommandTarget, Debuggee, DetachReason, TargetInfo } from "../src/ChromeDebugger.js"
import { makeEvent } from "../src/ChromeTesting.js"

const tab: Debuggee = { tabId: 7 }

const page: TargetInfo = { type: "page", id: "target-7", tabId: 7, attached: false, title: "Example", url: "https://example.com/" }

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

  return { api, listenersAtAttach, onEvent: onEvent.controls, onDetach: onDetach.controls }
}

describe("ChromeDebugger", () => {
  it.effect("forwards attach, detach, commands and target listing", () => Effect.gen(function*() {
    const { api } = mockApi()
    const debuggerService = make(api)
    yield* debuggerService.attach(tab, "1.3")
    expect(api.attach).toHaveBeenCalledExactlyOnceWith(tab, "1.3")
    expect(yield* debuggerService.sendCommand(tab, "Page.enable")).toEqual({ ok: true })
    yield* debuggerService.sendCommand({ ...tab, sessionId: "child" }, "Runtime.evaluate", { expression: "1 + 1" })
    expect(api.sendCommand.mock.calls).toEqual([[tab, "Page.enable"], [{ tabId: 7, sessionId: "child" }, "Runtime.evaluate", { expression: "1 + 1" }]])
    yield* debuggerService.detach(tab)
    expect(api.detach).toHaveBeenCalledExactlyOnceWith(tab)
    expect(yield* debuggerService.getTargets).toEqual([page])
  }))

  it.effect("types rejected and synchronous failures by operation", () => Effect.gen(function*() {
    const { api } = mockApi()
    const debuggerService = make(api)
    const busy = new Error("Another debugger is already attached to the tab with id: 7.")
    api.attach.mockRejectedValueOnce(busy)
    const error = yield* Effect.flip(debuggerService.attach(tab, "1.3"))
    expect(error).toBeInstanceOf(ChromeDebuggerError)
    expect(error).toMatchObject({ operation: "attach", cause: busy })
    const unknownMethod = new Error("{\"code\":-32601,\"message\":\"'Nope.nope' wasn't found\"}")
    api.sendCommand.mockImplementationOnce(() => { throw unknownMethod })
    expect(yield* Effect.flip(Effect.asVoid(debuggerService.sendCommand(tab, "Nope.nope")))).toMatchObject({ operation: "sendCommand", cause: unknownMethod })
  }))

  it.effect("streams raw events and detaches while consumed", () => Effect.gen(function*() {
    const mock = mockApi()
    const debuggerService = make(mock.api)
    const events = yield* Effect.forkScoped(Stream.runCollect(Stream.take(debuggerService.onEvent, 2)))
    const detaches = yield* Effect.forkScoped(Stream.runCollect(Stream.take(debuggerService.onDetach, 1)))
    yield* Effect.promise(() => mock.onEvent.waitForListener())
    yield* Effect.promise(() => mock.onDetach.waitForListener())
    mock.onEvent.emit(tab, "Page.loadEventFired", { timestamp: 1 })
    mock.onEvent.emit({ tabId: 8 }, "Inspector.detached")
    mock.onDetach.emit(tab, "target_closed")
    expect(yield* Fiber.join(events)).toEqual([
      { source: tab, method: "Page.loadEventFired", params: { timestamp: 1 } },
      { source: { tabId: 8 }, method: "Inspector.detached", params: undefined }
    ])
    expect(yield* Fiber.join(detaches)).toEqual([{ source: tab, reason: "target_closed" }])
    expect(mock.onEvent.listenerCount + mock.onDetach.listenerCount).toBe(0)
    const cause = new Error("event unavailable")
    mock.onDetach.failNext("addListener", cause)
    expect(yield* Effect.flip(Stream.runDrain(debuggerService.onDetach))).toMatchObject({ operation: "onDetach", cause })
  }))

  it.effect("binds a session to its target, listening before attach and detaching on release", () => Effect.gen(function*() {
    const mock = mockApi()
    const debuggerService = make(mock.api)

    const events = yield* Effect.scoped(Effect.gen(function*() {
      const session = yield* debuggerService.session(tab, "1.3")
      expect(mock.listenersAtAttach).toEqual([2])
      expect(session.target).toBe(tab)
      expect(yield* session.sendCommand("Network.enable")).toEqual({ ok: true })
      yield* session.sendCommand("Runtime.evaluate", { expression: "1" }, "child")
      expect(mock.api.sendCommand.mock.calls).toEqual([
        [tab, "Network.enable"], [{ tabId: 7, sessionId: "child" }, "Runtime.evaluate", { expression: "1" }]
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
      { method: "Network.requestWillBeSent", params: { requestId: "1" }, sessionId: Option.none() },
      { method: "Runtime.executionContextCreated", params: undefined, sessionId: Option.some("child") }
    ])
    expect(mock.api.detach).toHaveBeenCalledExactlyOnceWith(tab)
    expect(mock.onEvent.listenerCount + mock.onDetach.listenerCount).toBe(0)
  }))

  it.effect("ends a session's events when Chrome detaches its target, then skips detaching", () => Effect.gen(function*() {
    const mock = mockApi()

    const reason = yield* Effect.scoped(Effect.gen(function*() {
      const session = yield* make(mock.api).session(tab, "1.3")
      mock.onEvent.emit(tab, "Page.frameNavigated", { frame: {} })
      mock.onDetach.emit(tab, "canceled_by_user")
      mock.onEvent.emit(tab, "Page.loadEventFired")
      expect((yield* Stream.runCollect(session.events)).map((event) => event.method)).toEqual(["Page.frameNavigated"])

      return yield* session.detached
    }))

    expect(reason).toBe("canceled_by_user")
    expect(mock.api.detach).not.toHaveBeenCalled()
    expect(mock.onEvent.listenerCount + mock.onDetach.listenerCount).toBe(0)
  }))

  it.effect("ignores release failures because the target may already be gone", () => Effect.gen(function*() {
    const mock = mockApi()

    for (const cause of [new Error("Debugger is not attached to the tab with id: 7."), new Error("unexpected")]) {
      mock.api.detach.mockRejectedValueOnce(cause)
      const exit = yield* Effect.exit(Effect.scoped(make(mock.api).session(tab, "1.3")))
      expect(Exit.isSuccess(exit)).toBe(true)
    }

    expect(mock.api.detach).toHaveBeenCalledTimes(2)
    expect(mock.onEvent.listenerCount + mock.onDetach.listenerCount).toBe(0)
  }))

  it.effect("removes its listeners without detaching when attach or registration fails", () => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("Cannot access a chrome:// URL")
    mock.api.attach.mockRejectedValueOnce(cause)
    expect(yield* Effect.flip(Effect.scoped(make(mock.api).session(tab, "1.3")))).toMatchObject({ operation: "attach", cause })
    expect(mock.onEvent.listenerCount + mock.onDetach.listenerCount).toBe(0)
    const registration = new Error("event unavailable")
    mock.onDetach.failNext("addListener", registration)
    expect(yield* Effect.flip(Effect.scoped(make(mock.api).session(tab, "1.3")))).toMatchObject({ operation: "onDetach", cause: registration })
    expect(mock.onEvent.listenerCount + mock.onDetach.listenerCount).toBe(0)
    expect(mock.api.attach).toHaveBeenCalledTimes(1)
    expect(mock.api.detach).not.toHaveBeenCalled()
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
    expect(mock.onEvent.listenerCount + mock.onDetach.listenerCount).toBe(0)
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

  it.effect("provides an injected API and reads the global only when the live layer builds", () => Effect.gen(function*() {
    const { api } = mockApi()
    expect(yield* Effect.flatMap(ChromeDebugger, (service) => service.getTargets).pipe(Effect.provide(layer(api)))).toEqual([page])
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", {})), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeDebugger.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
    vi.stubGlobal("chrome", { debugger: api })
    expect(yield* Effect.flatMap(ChromeDebugger, (service) => service.getTargets).pipe(Effect.provide(layerLive))).toEqual([page])
  }))
})
