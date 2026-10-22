// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeHistory, ChromeHistoryError, layer, layerLive, make } from "../src/ChromeHistory.js"
import type { ChromeHistoryApi, HistoryItem, RemovedResult, VisitItem } from "../src/ChromeHistory.js"
import { makeEvent } from "../src/ChromeTesting.js"

const page: HistoryItem = { id: "1", url: "https://app.example/", title: "App", visitCount: 2, typedCount: 1, lastVisitTime: 1000 }

const visit: VisitItem = { id: "1", visitId: "10", referringVisitId: "0", transition: "typed", isLocal: true, visitTime: 1000 }

const mockApi = () => {
  const onVisited = makeEvent<[HistoryItem]>()
  const onVisitRemoved = makeEvent<[RemovedResult]>()

  return {
    api: {
      search: vi.fn(async (_query: chrome.history.HistoryQuery) => [page]),
      getVisits: vi.fn(async (_details: chrome.history.UrlDetails) => [visit]),
      addUrl: vi.fn(async (_details: chrome.history.UrlDetails) => {}),
      deleteUrl: vi.fn(async (_details: chrome.history.UrlDetails) => {}),
      deleteRange: vi.fn(async (_range: chrome.history.Range) => {}),
      deleteAll: vi.fn(async () => {}),
      onVisited: onVisited.api,
      onVisitRemoved: onVisitRemoved.api
    } satisfies ChromeHistoryApi,
    onVisited: onVisited.controls,
    onVisitRemoved: onVisitRemoved.controls
  }
}

describe("ChromeHistory", () => {
  it.effect("searches and reads visits", () => Effect.gen(function*() {
    const { api } = mockApi()
    const history = make(api)
    expect(yield* history.search({ text: "app", maxResults: 5 })).toEqual([page])
    expect(yield* history.getVisits("https://app.example/")).toEqual([visit])
    expect(api.search).toHaveBeenCalledExactlyOnceWith({ text: "app", maxResults: 5 })
    expect(api.getVisits).toHaveBeenCalledExactlyOnceWith({ url: "https://app.example/" })
  }))

  it.effect("adds and deletes by URL, range or all", () => Effect.gen(function*() {
    const { api } = mockApi()
    const history = make(api)
    yield* history.addUrl("https://app.example/new")
    yield* history.deleteUrl("https://app.example/old")
    yield* history.deleteRange({ startTime: 0, endTime: 1000 })
    yield* history.deleteAll
    expect(api.addUrl).toHaveBeenCalledExactlyOnceWith({ url: "https://app.example/new" })
    expect(api.deleteUrl).toHaveBeenCalledExactlyOnceWith({ url: "https://app.example/old" })
    expect(api.deleteRange).toHaveBeenCalledExactlyOnceWith({ startTime: 0, endTime: 1000 })
    expect(api.deleteAll).toHaveBeenCalledOnce()
  }))

  it.effect("types rejected calls", () => Effect.gen(function*() {
    const { api } = mockApi()
    const cause = new Error("Invalid url.")
    api.addUrl.mockRejectedValueOnce(cause)
    const error = yield* Effect.flip(make(api).addUrl("not a url"))
    expect(error).toBeInstanceOf(ChromeHistoryError)
    expect(error).toMatchObject({ operation: "addUrl", cause })
  }))

  it.effect("streams visits and removals while consumed", () => Effect.gen(function*() {
    const mock = mockApi()
    const history = make(mock.api)
    const visited = yield* Effect.forkScoped(Stream.runCollect(Stream.take(history.onVisited, 1)))
    const removed = yield* Effect.forkScoped(Stream.runCollect(Stream.take(history.onVisitRemoved, 2)))
    yield* Effect.promise(() => mock.onVisited.waitForListener())
    yield* Effect.promise(() => mock.onVisitRemoved.waitForListener())
    mock.onVisited.emit(page)
    mock.onVisitRemoved.emit({ allHistory: false, urls: ["https://app.example/"] })
    mock.onVisitRemoved.emit({ allHistory: true })
    expect(yield* Fiber.join(visited)).toEqual([page])
    expect(yield* Fiber.join(removed)).toEqual([{ allHistory: false, urls: ["https://app.example/"] }, { allHistory: true }])
    expect(mock.onVisited.listenerCount + mock.onVisitRemoved.listenerCount).toBe(0)
  }))

  it.effect("reports a failing registration with the event's operation", () => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("event unavailable")
    mock.onVisitRemoved.failNext("addListener", cause)
    expect(yield* Effect.flip(Stream.runDrain(make(mock.api).onVisitRemoved))).toMatchObject({ operation: "onVisitRemoved", cause })
  }))

  it.effect("provides an injected API and reads the global only when the live layer builds", () => Effect.gen(function*() {
    const { api } = mockApi()
    expect(yield* Effect.flatMap(ChromeHistory, (history) => history.getVisits("https://app.example/")).pipe(Effect.provide(layer(api)))).toEqual([visit])
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", {})), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeHistory.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
    vi.stubGlobal("chrome", { history: api })
    expect(yield* Effect.flatMap(ChromeHistory, (history) => history.search({ text: "" })).pipe(Effect.provide(layerLive))).toEqual([page])
  }))
})
