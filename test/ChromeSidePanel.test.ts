// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Exit, Fiber, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeSidePanel, ChromeSidePanelError, layer, layerLive, make } from "../src/ChromeSidePanel.js"
import type { ChromeSidePanelApi, ChromeSidePanelService } from "../src/ChromeSidePanel.js"
import { makeEvent } from "../src/testing/Event.js"

const opened: chrome.sidePanel.PanelOpenedInfo = { path: "panel.html", tabId: 7, windowId: 1 }

const closed: chrome.sidePanel.PanelClosedInfo = { path: "panel.html", windowId: 1 }

const mockApi = () => {
  const onOpened = makeEvent<[chrome.sidePanel.PanelOpenedInfo]>()
  const onClosed = makeEvent<[chrome.sidePanel.PanelClosedInfo]>()

  const api = {
    setOptions: vi.fn(async (_options: chrome.sidePanel.PanelOptions) => {}),
    getOptions: vi.fn(async (options: chrome.sidePanel.GetPanelOptions): Promise<chrome.sidePanel.PanelOptions> => ({ ...options, enabled: true, path: "panel.html" })),
    setPanelBehavior: vi.fn(async (_behavior: chrome.sidePanel.PanelBehavior) => {}),
    getPanelBehavior: vi.fn(async (): Promise<chrome.sidePanel.PanelBehavior> => ({ openPanelOnActionClick: true })),
    open: vi.fn(async (_options: chrome.sidePanel.OpenOptions) => {}),
    close: vi.fn(async (_options: chrome.sidePanel.CloseOptions) => {}),
    getLayout: vi.fn(async (): Promise<chrome.sidePanel.PanelLayout> => ({ side: "right" })),
    onOpened: onOpened.api,
    onClosed: onClosed.api
  } satisfies ChromeSidePanelApi

  return { api, events: { onOpened: onOpened.controls, onClosed: onClosed.controls } }
}

type Method = "setOptions" | "getOptions" | "setPanelBehavior" | "getPanelBehavior" | "open" | "close" | "getLayout"

const methods: ReadonlyArray<Method> = ["setOptions", "getOptions", "setPanelBehavior", "getPanelBehavior", "open", "close", "getLayout"]

/** Runs one service operation as Effect<void>, keyed by its Chrome member. */
const call = (panel: ChromeSidePanelService, method: Method): Effect.Effect<void, ChromeSidePanelError> => {
  switch (method) {
    case "setOptions": return panel.setOptions({ tabId: 7, path: "tab.html", enabled: true })
    case "getOptions": return Effect.asVoid(panel.getOptions({ tabId: 7 }))
    case "setPanelBehavior": return panel.setPanelBehavior({ openPanelOnActionClick: true })
    case "getPanelBehavior": return Effect.asVoid(panel.getPanelBehavior)
    case "open": return panel.open({ tabId: 7 })
    case "close": return panel.close({ windowId: 1 })
    case "getLayout": return Effect.asVoid(panel.getLayout)
  }
}

describe("ChromeSidePanel", () => {
  it.effect("passes each call through unchanged and returns Chrome's result", () => Effect.gen(function*() {
    const { api } = mockApi()
    const panel = make(api)
    yield* panel.setOptions({ tabId: 7, path: "tab.html", enabled: true })
    yield* panel.setPanelBehavior({ openPanelOnActionClick: true })
    expect(yield* panel.getOptions({ tabId: 7 })).toEqual({ tabId: 7, enabled: true, path: "panel.html" })
    expect(yield* panel.getPanelBehavior).toEqual({ openPanelOnActionClick: true })
    expect(yield* panel.getLayout).toEqual({ side: "right" })
    yield* panel.open({ windowId: 1 })
    yield* panel.close({ tabId: 7 })
    expect(api.setOptions).toHaveBeenCalledExactlyOnceWith({ tabId: 7, path: "tab.html", enabled: true })
    expect(api.setPanelBehavior).toHaveBeenCalledExactlyOnceWith({ openPanelOnActionClick: true })
    expect(api.getOptions).toHaveBeenCalledExactlyOnceWith({ tabId: 7 })
    expect(api.getPanelBehavior).toHaveBeenCalledExactlyOnceWith()
    expect(api.getLayout).toHaveBeenCalledExactlyOnceWith()
    expect(api.open).toHaveBeenCalledExactlyOnceWith({ windowId: 1 })
    expect(api.close).toHaveBeenCalledExactlyOnceWith({ tabId: 7 })
  }))

  it.effect("reads the default options with {} when getOptions is given no argument", () => Effect.gen(function*() {
    const { api } = mockApi()
    expect(yield* make(api).getOptions()).toEqual({ enabled: true, path: "panel.html" })
    expect(api.getOptions.mock.calls).toEqual([[{}]])
  }))

  it.effect("keeps every operation lazy and re-runs Chrome on each execution", () => Effect.gen(function*() {
    const { api } = mockApi()
    const panel = make(api)
    const effects = methods.map((method) => call(panel, method))

    for (const method of methods) expect(api[method]).not.toHaveBeenCalled()

    for (const effect of effects) {
      yield* effect
      yield* effect
    }

    for (const method of methods) expect(api[method]).toHaveBeenCalledTimes(2)
  }))

  it.effect.each(methods)("maps a rejection and a synchronous throw from %s to the typed error", (method) => Effect.gen(function*() {
    for (const synchronous of [false, true]) {
      const { api } = mockApi()
      const cause = new Error(`${method} failed`)

      vi.mocked(api[method]).mockImplementation(() => {
        if (synchronous) throw cause

        return Promise.reject(cause)
      })

      const error = yield* Effect.flip(call(make(api), method))
      expect(error).toBeInstanceOf(ChromeSidePanelError)
      expect(error.operation).toBe(method)
      expect(error.cause).toBe(cause)
    }
  }))

  it.effect.each(["open", "close", "getLayout"] as const)("fails %s with a typed error on a browser without it", (method) => Effect.gen(function*() {
    const { api } = mockApi()
    const { [method]: _absent, ...older } = api
    const panel = make(older)
    const error = yield* Effect.flip(call(panel, method))
    expect(error).toBeInstanceOf(ChromeSidePanelError)
    expect(error.operation).toBe(method)
    expect(String(error.cause)).toContain(`sidePanel.${method} is unavailable`)
  }))

  it.effect("fails openFromUserGesture with a typed open error on a browser without open", () => Effect.gen(function*() {
    const { api } = mockApi()
    const { open: _absent, ...older } = api
    const outcome = make(older).openFromUserGesture({ tabId: 7 })
    expect(yield* Effect.flip(outcome)).toMatchObject({ operation: "open" })
  }))

  describe("openFromUserGesture", () => {
    it.effect("calls Chrome before the Effect runs and replays one outcome", () => Effect.gen(function*() {
      const { api } = mockApi()
      const panel = make(api)
      const outcome = panel.openFromUserGesture({ windowId: 2 })
      expect(api.open).toHaveBeenCalledExactlyOnceWith({ windowId: 2 })
      yield* outcome
      yield* outcome
      expect(api.open).toHaveBeenCalledOnce()
      const lazy = panel.open({ windowId: 2 })
      expect(api.open).toHaveBeenCalledOnce()
      yield* lazy
      expect(api.open).toHaveBeenCalledTimes(2)
    }))

    // A synchronous click handler is an intentional native boundary.
    it("starts the open on the handler's synchronous stack", async () => {
      const { api } = mockApi()
      let inHandler = false
      api.open.mockImplementation(async () => { expect(inHandler).toBe(true) })
      const panel = make(api)

      const onClick = () => {
        inHandler = true
        const outcome = panel.openFromUserGesture({ tabId: 3 })
        inHandler = false

        return outcome
      }

      await Effect.runPromise(onClick())
      expect(api.open).toHaveBeenCalledOnce()
    })

    it.effect("types a rejection and a synchronous throw as open, without reopening", () => Effect.gen(function*() {
      for (const synchronous of [false, true]) {
        const { api } = mockApi()
        const cause = new Error("`sidePanel.open()` may only be called in response to a user gesture.")
        api.open.mockImplementation(() => {
          if (synchronous) throw cause

          return Promise.reject(cause)
        })
        const outcome = make(api).openFromUserGesture({ tabId: 7 })

        for (let round = 0; round < 2; round++) {
          const error = yield* Effect.flip(outcome)
          expect(error).toBeInstanceOf(ChromeSidePanelError)
          expect(error).toMatchObject({ operation: "open", cause })
        }

        expect(api.open).toHaveBeenCalledOnce()
      }
    }))

    it.effect("stops waiting when interrupted and still reports the late outcome", () => Effect.gen(function*() {
      const { api } = mockApi()
      let finish!: () => void
      api.open.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
      const outcome = make(api).openFromUserGesture({ tabId: 7 })
      const waiting = yield* Effect.forkChild(outcome)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(waiting)
      expect(Exit.hasInterrupts(yield* Fiber.await(waiting))).toBe(true)
      finish()
      yield* outcome
      expect(api.open).toHaveBeenCalledOnce()
    }))
  })

  describe.each([["onOpened", opened], ["onClosed", closed]] as const)("%s", (event, info) => {
    it.effect("delivers events in order and removes its listener when the stream ends", () => Effect.gen(function*() {
      const mock = mockApi()
      const stream: Stream.Stream<chrome.sidePanel.PanelOpenedInfo | chrome.sidePanel.PanelClosedInfo, ChromeSidePanelError> = make(mock.api)[event]
      const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 2)))
      yield* Effect.promise(() => mock.events[event].waitForListener())
      mock.events[event].emit(info)
      mock.events[event].emit({ ...info, windowId: 9 })
      expect(yield* Fiber.join(fiber)).toEqual([info, { ...info, windowId: 9 }])
      expect(mock.events[event].listenerCount).toBe(0)
    }))

    it.effect("removes its listener when interrupted", () => Effect.gen(function*() {
      const mock = mockApi()
      const fiber = yield* Effect.forkScoped(Stream.runDrain(make(mock.api)[event]))
      yield* Effect.promise(() => mock.events[event].waitForListener())
      expect(mock.events[event].listenerCount).toBe(1)
      yield* Fiber.interrupt(fiber)
      expect(mock.events[event].listenerCount).toBe(0)
    }))

    it.effect("types a registration failure with the event name", () => Effect.gen(function*() {
      const mock = mockApi()
      const cause = new Error("listener rejected")
      mock.events[event].failNext("addListener", cause)
      const error = yield* Effect.flip(Stream.runDrain(make(mock.api)[event]))
      expect(error).toBeInstanceOf(ChromeSidePanelError)
      expect(error).toMatchObject({ operation: event, cause })
      expect(mock.events[event].listenerCount).toBe(0)
    }))

    it.effect("fails with a typed error on a browser without the event", () => Effect.gen(function*() {
      const { api } = mockApi()
      const { [event]: _absent, ...older } = api
      const error = yield* Effect.flip(Stream.runDrain(make(older)[event]))
      expect(error).toBeInstanceOf(ChromeSidePanelError)
      expect(error.operation).toBe(event)
      expect(String(error.cause)).toContain(`sidePanel.${event} is unavailable`)
    }))
  })

  it.effect("reads version-gated members when used, not when the service is made", () => Effect.gen(function*() {
    const { api } = mockApi()
    const getter = vi.fn(() => api.getLayout)
    const lazy: ChromeSidePanelApi = { ...api }
    Object.defineProperty(lazy, "getLayout", { get: getter })
    const panel = make(lazy)
    expect(getter).not.toHaveBeenCalled()
    expect(yield* panel.getLayout).toEqual({ side: "right" })
    expect(getter).toHaveBeenCalled()
  }))

  it.effect("provides an injected API through layer", () => Effect.gen(function*() {
    const { api } = mockApi()
    expect(yield* Effect.flatMap(ChromeSidePanel, (panel) => panel.getLayout).pipe(Effect.provide(layer(api)))).toEqual({ side: "right" })
  }))

  it.effect("fails layerLive with initialize without chrome, and builds from a fake global", () => Effect.gen(function*() {
    yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => vi.unstubAllGlobals()))
    vi.stubGlobal("chrome", undefined)
    expect(yield* Effect.flip(ChromeSidePanel.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
    vi.stubGlobal("chrome", {})
    const missing = yield* Effect.flip(ChromeSidePanel.pipe(Effect.provide(layerLive)))
    expect(missing).toBeInstanceOf(ChromeSidePanelError)
    expect(String(missing.cause)).toContain("chrome.sidePanel is unavailable")
    const { api } = mockApi()
    vi.stubGlobal("chrome", { sidePanel: api })
    const panel = yield* ChromeSidePanel.pipe(Effect.provide(layerLive))
    expect(yield* panel.getPanelBehavior).toEqual({ openPanelOnActionClick: true })
  }))
})
