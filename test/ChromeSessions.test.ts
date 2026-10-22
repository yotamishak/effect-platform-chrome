// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeSessions, ChromeSessionsError, layer, layerLive, make, MAX_SESSION_RESULTS } from "../src/ChromeSessions.js"
import type { ChromeSessionsApi, Device, Session } from "../src/ChromeSessions.js"
import { makeEvent } from "../src/ChromeTesting.js"

const session: Session = {
  lastModified: 1000,
  tab: {
    id: 4, sessionId: "tab-session", index: 0, windowId: 1, highlighted: false, active: true, pinned: false, incognito: false,
    discarded: false, autoDiscardable: true, groupId: -1, frozen: false, selected: true, lastAccessed: 0
  }
}

const device: Device = { deviceName: "Laptop", sessions: [session] }

const mockApi = () => {
  const onChanged = makeEvent<[]>()

  return {
    api: {
      getRecentlyClosed: vi.fn(async (_filter?: chrome.sessions.Filter) => [session]),
      getDevices: vi.fn(async (_filter?: chrome.sessions.Filter) => [device]),
      restore: vi.fn(async (_sessionId?: string) => session),
      onChanged: onChanged.api
    } satisfies ChromeSessionsApi,
    onChanged: onChanged.controls
  }
}

describe("ChromeSessions", () => {
  it.effect("passes filters and session ids only when given", () => Effect.gen(function*() {
    const { api } = mockApi()
    const sessions = make(api)
    expect(yield* sessions.getRecentlyClosed()).toEqual([session])
    expect(yield* sessions.getRecentlyClosed({ maxResults: 1 })).toEqual([session])
    expect(yield* sessions.getDevices()).toEqual([device])
    expect(yield* sessions.getDevices({ maxResults: MAX_SESSION_RESULTS })).toEqual([device])
    expect(yield* sessions.restore()).toEqual(session)
    expect(yield* sessions.restore("tab-session")).toEqual(session)
    expect(api.getRecentlyClosed.mock.calls).toEqual([[], [{ maxResults: 1 }]])
    expect(api.getDevices.mock.calls).toEqual([[], [{ maxResults: 25 }]])
    expect(api.restore.mock.calls).toEqual([[], ["tab-session"]])
  }))

  it.effect("types rejected calls", () => Effect.gen(function*() {
    const { api } = mockApi()
    const cause = new Error("Invalid session id: \"missing\".")
    api.restore.mockRejectedValueOnce(cause)
    const error = yield* Effect.flip(make(api).restore("missing"))
    expect(error).toBeInstanceOf(ChromeSessionsError)
    expect(error).toMatchObject({ operation: "restore", cause })
  }))

  it.effect("streams changes while consumed", () => Effect.gen(function*() {
    const mock = mockApi()
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(make(mock.api).onChanged, 2)))
    yield* Effect.promise(() => mock.onChanged.waitForListener())
    mock.onChanged.emit()
    mock.onChanged.emit()
    expect(yield* Fiber.join(fiber)).toEqual([undefined, undefined])
    expect(mock.onChanged.listenerCount).toBe(0)
  }))

  it.effect("reports a failing registration with the event's operation", () => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("event unavailable")
    mock.onChanged.failNext("addListener", cause)
    expect(yield* Effect.flip(Stream.runDrain(make(mock.api).onChanged))).toMatchObject({ operation: "onChanged", cause })
  }))

  it.effect("provides an injected API and reads the global only when the live layer builds", () => Effect.gen(function*() {
    const { api } = mockApi()
    expect(yield* Effect.flatMap(ChromeSessions, (sessions) => sessions.restore()).pipe(Effect.provide(layer(api)))).toEqual(session)
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", {})), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeSessions.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
    vi.stubGlobal("chrome", { sessions: api })
    expect(yield* Effect.flatMap(ChromeSessions, (sessions) => sessions.getDevices()).pipe(Effect.provide(layerLive))).toEqual([device])
  }))
})
