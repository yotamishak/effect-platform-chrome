// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeSidePanel, ChromeSidePanelError, layer, layerLive, make } from "../src/ChromeSidePanel.js"
import type { ChromeSidePanelApi } from "../src/ChromeSidePanel.js"
import { makeEvent } from "../src/testing/Event.js"

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

  return { api, onOpened: onOpened.controls, onClosed: onClosed.controls }
}

describe("ChromeSidePanel", () => {
  it.effect("configures options and behavior, defaulting getOptions to the default panel", () => Effect.gen(function*() {
    const { api } = mockApi()
    const panel = make(api)
    yield* panel.setOptions({ tabId: 7, path: "tab.html", enabled: true })
    yield* panel.setPanelBehavior({ openPanelOnActionClick: true })
    expect(yield* panel.getOptions()).toEqual({ enabled: true, path: "panel.html" })
    expect(yield* panel.getOptions({ tabId: 7 })).toEqual({ tabId: 7, enabled: true, path: "panel.html" })
    expect(yield* panel.getPanelBehavior).toEqual({ openPanelOnActionClick: true })
    expect(yield* panel.getLayout).toEqual({ side: "right" })
    yield* panel.close({ windowId: 1 })
    expect(api.setOptions).toHaveBeenCalledExactlyOnceWith({ tabId: 7, path: "tab.html", enabled: true })
    expect(api.getOptions.mock.calls).toEqual([[{}], [{ tabId: 7 }]])
    expect(api.close).toHaveBeenCalledExactlyOnceWith({ windowId: 1 })
  }))

  it.effect("opens lazily, only when the Effect runs", () => Effect.gen(function*() {
    const { api } = mockApi()
    const open = make(api).open({ tabId: 7 })
    expect(api.open).not.toHaveBeenCalled()
    yield* open
    yield* open
    expect(api.open.mock.calls).toEqual([[{ tabId: 7 }], [{ tabId: 7 }]])
  }))

  it.effect("starts a gesture open immediately and observes that one call", () => Effect.gen(function*() {
    const { api } = mockApi()
    const outcome = make(api).openFromUserGesture({ windowId: 2 })
    expect(api.open).toHaveBeenCalledExactlyOnceWith({ windowId: 2 })
    yield* outcome
    yield* outcome
    expect(api.open).toHaveBeenCalledTimes(1)
  }))

  it.effect("types gesture open rejections and synchronous throws", () => Effect.gen(function*() {
    const { api } = mockApi()
    const panel = make(api)
    const cause = new Error("`sidePanel.open()` may only be called in response to a user gesture.")
    api.open.mockRejectedValueOnce(cause)
    const rejected = panel.openFromUserGesture({ tabId: 7 })
    api.open.mockImplementationOnce(() => { throw cause })
    const thrown = panel.openFromUserGesture({ tabId: 7 })
    const error = yield* Effect.flip(rejected)
    expect(error).toBeInstanceOf(ChromeSidePanelError)
    expect(error).toMatchObject({ operation: "open", cause })
    expect(yield* Effect.flip(thrown)).toMatchObject({ operation: "open", cause })
    api.close.mockRejectedValueOnce(cause)
    expect(yield* Effect.flip(panel.close({ tabId: 7 }))).toMatchObject({ operation: "close", cause })
  }))

  it.effect("streams opens and closes while consumed", () => Effect.gen(function*() {
    const mock = mockApi()
    const panel = make(mock.api)
    const opened = yield* Effect.forkScoped(Stream.runCollect(Stream.take(panel.onOpened, 1)))
    const closed = yield* Effect.forkScoped(Stream.runCollect(Stream.take(panel.onClosed, 1)))
    yield* Effect.promise(() => mock.onOpened.waitForListener())
    yield* Effect.promise(() => mock.onClosed.waitForListener())
    mock.onOpened.emit({ path: "panel.html", tabId: 7, windowId: 1 })
    mock.onClosed.emit({ path: "panel.html", windowId: 1 })
    expect(yield* Fiber.join(opened)).toEqual([{ path: "panel.html", tabId: 7, windowId: 1 }])
    expect(yield* Fiber.join(closed)).toEqual([{ path: "panel.html", windowId: 1 }])
    expect(mock.onOpened.listenerCount + mock.onClosed.listenerCount).toBe(0)
  }))

  it.effect("types event registration failures with the event name", () => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("listener rejected")
    mock.onClosed.failNext("addListener", cause)
    expect(yield* Effect.flip(Stream.runDrain(make(mock.api).onClosed))).toMatchObject({ operation: "onClosed", cause })
    expect(mock.onClosed.listenerCount).toBe(0)
  }))

  it.effect("provides an injected API and reads the global only when the live layer builds", () => Effect.gen(function*() {
    const { api } = mockApi()
    expect(yield* Effect.flatMap(ChromeSidePanel, (panel) => panel.getLayout).pipe(Effect.provide(layer(api)))).toEqual({ side: "right" })
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", {})), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeSidePanel.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
  }))
})
