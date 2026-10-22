// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Option, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeWebNavigation, ChromeWebNavigationError, layer, layerLive, make } from "../src/ChromeWebNavigation.js"
import type { ChromeWebNavigationApi, Frame, FrameInfo, Navigation } from "../src/ChromeWebNavigation.js"
import { makeEvent } from "../src/ChromeTesting.js"

const frame: Frame = {
  frameId: 0, parentFrameId: -1, processId: 1, url: "https://app.example/", documentId: "document-1",
  documentLifecycle: "active", errorOccurred: false, frameType: "outermost_frame"
}

const navigation: Navigation = {
  tabId: 7, frameId: 0, url: "https://app.example/next", timeStamp: 0, processId: 1,
  transitionType: "link", transitionQualifiers: [], documentId: "document-1",
  documentLifecycle: "active", frameType: "outermost_frame", parentFrameId: -1
}

const mockApi = () => {
  const onCommitted = makeEvent<[Navigation]>()
  const onHistoryStateUpdated = makeEvent<[Navigation]>()

  return {
    api: {
      getAllFrames: vi.fn(async (_details: chrome.webNavigation.GetAllFrameDetails): Promise<Array<Frame> | null> => [frame]),
      getFrame: vi.fn(async (_details: chrome.webNavigation.GetFrameDetails): Promise<FrameInfo | null> => frame),
      onCommitted: onCommitted.api,
      onHistoryStateUpdated: onHistoryStateUpdated.api
    } satisfies ChromeWebNavigationApi,
    onCommitted: onCommitted.controls,
    onHistoryStateUpdated: onHistoryStateUpdated.controls
  }
}

describe("ChromeWebNavigation", () => {
  it.effect("lists a tab's frames and reads a closed tab as having none", () => Effect.gen(function*() {
    const { api } = mockApi()
    const navigationService = make(api)
    expect(yield* navigationService.getAllFrames(7)).toEqual([frame])
    expect(api.getAllFrames).toHaveBeenCalledExactlyOnceWith({ tabId: 7 })
    api.getAllFrames.mockResolvedValueOnce(null)
    expect(yield* navigationService.getAllFrames(8)).toEqual([])
  }))

  it.effect("reads one frame as an option", () => Effect.gen(function*() {
    const { api } = mockApi()
    const navigationService = make(api)
    expect(yield* navigationService.getFrame({ tabId: 7, frameId: 0 })).toEqual(Option.some(frame))
    api.getFrame.mockResolvedValueOnce(null)
    expect(Option.isNone(yield* navigationService.getFrame({ tabId: 7, frameId: 9 }))).toBe(true)
  }))

  it.effect("types rejected lookups", () => Effect.gen(function*() {
    const { api } = mockApi()
    const cause = new Error("No tab with id: 9.")
    api.getAllFrames.mockRejectedValueOnce(cause)
    const error = yield* Effect.flip(make(api).getAllFrames(9))
    expect(error).toBeInstanceOf(ChromeWebNavigationError)
    expect(error).toMatchObject({ operation: "getAllFrames", cause })
  }))

  it.effect.each(["onCommitted", "onHistoryStateUpdated"] as const)("streams %s while consumed and removes its listener", (name) => Effect.gen(function*() {
    const mock = mockApi()
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(make(mock.api)[name], 2)))
    yield* Effect.promise(() => mock[name].waitForListener())
    mock[name].emit(navigation)
    mock[name].emit({ ...navigation, url: "https://app.example/later" })
    expect((yield* Fiber.join(fiber)).map((details) => details.url)).toEqual([
      "https://app.example/next", "https://app.example/later"
    ])
    expect(mock[name].listenerCount).toBe(0)
  }))

  it.effect("reports a failing registration in the typed error channel", () => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("event unavailable")
    mock.onCommitted.failNext("addListener", cause)
    expect(yield* Effect.flip(Stream.runDrain(make(mock.api).onCommitted))).toMatchObject({ operation: "onCommitted", cause })
  }))

  it.effect("provides an injected API and reads the global only when the live layer builds", () => Effect.gen(function*() {
    const { api } = mockApi()
    expect(yield* Effect.flatMap(ChromeWebNavigation, (service) => service.getAllFrames(7)).pipe(Effect.provide(layer(api)))).toEqual([frame])
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", {})), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeWebNavigation.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
    vi.stubGlobal("chrome", { webNavigation: api })
    expect(yield* Effect.flatMap(ChromeWebNavigation, (service) => service.getAllFrames(7)).pipe(Effect.provide(layerLive))).toEqual([frame])
  }))
})
