// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeIdle, ChromeIdleError, layer, layerLive, make } from "../src/ChromeIdle.js"
import type { ChromeIdleApi, IdleState } from "../src/ChromeIdle.js"
import * as TestEvent from "../src/testing/Event.js"

const mockApi = () => {
  const onStateChanged = TestEvent.makeEvent<[IdleState]>()

  const api = {
    queryState: vi.fn(async (_detectionIntervalInSeconds: number): Promise<IdleState> => "idle"),
    setDetectionInterval: vi.fn((_intervalInSeconds: number) => {}),
    getAutoLockDelay: vi.fn(async () => 300),
    onStateChanged: onStateChanged.api
  } satisfies ChromeIdleApi

  return { api, onStateChanged: onStateChanged.controls }
}

describe("ChromeIdle", () => {
  it.effect("queries state, sets the interval and reads the auto-lock delay", () => Effect.gen(function*() {
    const { api } = mockApi()
    const idle = make(api)
    expect(yield* idle.queryState(60)).toBe("idle")
    yield* idle.setDetectionInterval(30)
    expect(yield* idle.getAutoLockDelay).toBe(300)
    expect(api.queryState).toHaveBeenCalledExactlyOnceWith(60)
    expect(api.setDetectionInterval).toHaveBeenCalledExactlyOnceWith(30)
  }))

  it.effect("streams state changes while consumed and removes the listener", () => Effect.gen(function*() {
    const mock = mockApi()
    const changes = yield* Effect.forkScoped(Stream.runCollect(Stream.take(make(mock.api).onStateChanged, 2)))
    yield* Effect.promise(() => mock.onStateChanged.waitForListener())
    mock.onStateChanged.emit("locked")
    mock.onStateChanged.emit("active")
    expect(yield* Fiber.join(changes)).toEqual(["locked", "active"])
    expect(mock.onStateChanged.listenerCount).toBe(0)
  }))

  it.effect("types rejected and throwing calls, including a missing ChromeOS-only function", () => Effect.gen(function*() {
    const { api } = mockApi()
    const cause = new Error("Value must be at least 15.")
    api.queryState.mockRejectedValueOnce(cause)
    api.setDetectionInterval.mockImplementationOnce(() => { throw cause })
    const idle = make(api)
    const error = yield* Effect.flip(idle.queryState(1))
    expect(error).toBeInstanceOf(ChromeIdleError)
    expect(error).toMatchObject({ operation: "queryState", cause })
    expect(yield* Effect.flip(idle.setDetectionInterval(1))).toMatchObject({ operation: "setDetectionInterval", cause })
    // Outside ChromeOS the function is absent, so calling it throws synchronously.
    const absent = new TypeError("chrome.idle.getAutoLockDelay is not a function")
    api.getAutoLockDelay.mockImplementationOnce(() => { throw absent })
    expect(yield* Effect.flip(idle.getAutoLockDelay)).toMatchObject({ operation: "getAutoLockDelay", cause: absent })
  }))

  it.effect("types a failed listener registration with the event name", () => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("registration failed")
    mock.onStateChanged.failNext("addListener", cause)
    const error = yield* Effect.flip(Stream.runDrain(make(mock.api).onStateChanged))
    expect(error).toMatchObject({ operation: "onStateChanged", cause })
    expect(mock.onStateChanged.listenerCount).toBe(0)
  }))

  it.effect("provides an injected API and reads the global only when the live layer builds", () => Effect.gen(function*() {
    const { api } = mockApi()
    expect(yield* Effect.flatMap(ChromeIdle, (idle) => idle.queryState(15)).pipe(Effect.provide(layer(api)))).toBe("idle")
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", {})), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeIdle.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
  }))
})
