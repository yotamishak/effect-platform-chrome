// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeWindows, ChromeWindowsError, layer, layerLive, make } from "../src/ChromeWindows.js"
import type { ChromeWindowsApi } from "../src/ChromeWindows.js"

const window: chrome.windows.Window = {
  id: 3, focused: false, alwaysOnTop: false, incognito: false, state: "normal", type: "normal"
}

const mockApi = () => ({
  get: vi.fn(async (windowId: number, _queryOptions?: chrome.windows.QueryOptions) => ({ ...window, id: windowId })),
  getCurrent: vi.fn(async (_queryOptions?: chrome.windows.QueryOptions) => window),
  update: vi.fn(async (windowId: number, updateInfo: chrome.windows.UpdateInfo) => ({ ...window, id: windowId, focused: updateInfo.focused ?? false }))
}) satisfies ChromeWindowsApi

describe("ChromeWindows", () => {
  it.effect("reads windows, passing query options only when given", () => Effect.gen(function*() {
    const api = mockApi()
    const windows = make(api)
    expect((yield* windows.get(5)).id).toBe(5)
    expect((yield* windows.getCurrent({ populate: true })).id).toBe(3)
    expect(api.get.mock.calls).toEqual([[5]])
    expect(api.getCurrent.mock.calls).toEqual([[{ populate: true }]])
  }))

  it.effect("focuses a window through update", () => Effect.gen(function*() {
    const api = mockApi()
    expect((yield* make(api).focus(3)).focused).toBe(true)
    expect(api.update).toHaveBeenCalledExactlyOnceWith(3, { focused: true })
  }))

  it.effect("types rejected calls", () => Effect.gen(function*() {
    const api = mockApi()
    const cause = new Error("No window with id: 9.")
    api.update.mockRejectedValueOnce(cause)
    const error = yield* Effect.flip(make(api).focus(9))
    expect(error).toBeInstanceOf(ChromeWindowsError)
    expect(error).toMatchObject({ operation: "update", cause })
  }))

  it.effect("provides an injected API and reads the global only when the live layer builds", () => Effect.gen(function*() {
    const api = mockApi()
    expect((yield* Effect.flatMap(ChromeWindows, (windows) => windows.get(4)).pipe(Effect.provide(layer(api)))).id).toBe(4)
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", {})), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeWindows.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
  }))
})
