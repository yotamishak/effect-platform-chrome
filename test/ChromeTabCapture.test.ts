// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeTabCapture, ChromeTabCaptureError, layer, layerLive, make } from "../src/ChromeTabCapture.js"
import type { CaptureInfo, ChromeTabCaptureApi, MediaStreamOptions } from "../src/ChromeTabCapture.js"
import { makeEvent } from "../src/ChromeTesting.js"

const active: CaptureInfo = { tabId: 7, status: "active", fullscreen: false }

const mockApi = () => {
  const onStatusChanged = makeEvent<[CaptureInfo]>()

  return {
    api: {
      getMediaStreamId: vi.fn(async (_options?: MediaStreamOptions) => "stream-id"),
      getCapturedTabs: vi.fn(async () => [active]),
      onStatusChanged: onStatusChanged.api
    } satisfies ChromeTabCaptureApi,
    onStatusChanged: onStatusChanged.controls
  }
}

describe("ChromeTabCapture", () => {
  it.effect("creates stream ids, preserving omitted options, and lists captured tabs", () => Effect.gen(function*() {
    const { api } = mockApi()
    const capture = make(api)
    expect(yield* capture.getMediaStreamId()).toBe("stream-id")
    expect(yield* capture.getMediaStreamId({ targetTabId: 7 })).toBe("stream-id")
    expect(api.getMediaStreamId.mock.calls).toEqual([[], [{ targetTabId: 7 }]])
    expect(yield* capture.getCapturedTabs).toEqual([active])
  }))

  it.effect("types rejected and synchronous failures by operation", () => Effect.gen(function*() {
    const { api } = mockApi()
    const capture = make(api)
    const busy = new Error("Cannot capture a tab with an active stream.")
    api.getMediaStreamId.mockRejectedValueOnce(busy)
    const error = yield* Effect.flip(capture.getMediaStreamId({ targetTabId: 7 }))
    expect(error).toBeInstanceOf(ChromeTabCaptureError)
    expect(error).toMatchObject({ operation: "getMediaStreamId", cause: busy })
    const cause = new Error("tabCapture unavailable")
    api.getCapturedTabs.mockImplementationOnce(() => { throw cause })
    expect(yield* Effect.flip(capture.getCapturedTabs)).toMatchObject({ operation: "getCapturedTabs", cause })
  }))

  it.effect("streams status changes while consumed and removes its listener", () => Effect.gen(function*() {
    const mock = mockApi()
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(make(mock.api).onStatusChanged, 2)))
    yield* Effect.promise(() => mock.onStatusChanged.waitForListener())
    mock.onStatusChanged.emit(active)
    mock.onStatusChanged.emit({ ...active, status: "stopped" })
    expect((yield* Fiber.join(fiber)).map((info) => info.status)).toEqual(["active", "stopped"])
    expect(mock.onStatusChanged.listenerCount).toBe(0)
    const cause = new Error("event unavailable")
    mock.onStatusChanged.failNext("addListener", cause)
    expect(yield* Effect.flip(Stream.runDrain(make(mock.api).onStatusChanged))).toMatchObject({ operation: "onStatusChanged", cause })
  }))

  it.effect("provides an injected API and reads the global only when the live layer builds", () => Effect.gen(function*() {
    const { api } = mockApi()
    expect(yield* Effect.flatMap(ChromeTabCapture, (service) => service.getCapturedTabs).pipe(Effect.provide(layer(api)))).toEqual([active])
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", {})), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeTabCapture.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
    vi.stubGlobal("chrome", { tabCapture: api })
    expect(yield* Effect.flatMap(ChromeTabCapture, (service) => service.getMediaStreamId()).pipe(Effect.provide(layerLive))).toBe("stream-id")
  }))
})
