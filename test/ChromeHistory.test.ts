// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Exit, Fiber, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeHistory, ChromeHistoryError, layer, layerLive, make } from "../src/ChromeHistory.js"
import type { ChromeHistoryApi, ChromeHistoryService, HistoryItem, HistoryQuery, Range, RemovedResult, VisitItem } from "../src/ChromeHistory.js"
import { makeEvent } from "../src/testing/Event.js"
import { makeHistory } from "../src/testing/History.js"
import type { HistoryOperation } from "../src/testing/History.js"
import type { EventSource } from "../src/internal/event.js"

const url = "https://app.example/"

const page: HistoryItem = { id: "1", url, title: "App", visitCount: 2, typedCount: 1, lastVisitTime: 1000 }

const visit: VisitItem = { id: "1", visitId: "10", referringVisitId: "0", transition: "typed", isLocal: true, visitTime: 1000 }

/** What a call succeeds with: a list of items or visits, or nothing. */
type Outcome = ReadonlyArray<HistoryItem | VisitItem> | void

type Mode = { readonly kind: "reject" | "throw"; readonly cause: Error }

/**
 * Explicit mocks whose next call per operation can resolve, reject or throw synchronously,
 * as Chrome's bindings throw for malformed arguments.
 */
const mockApi = () => {
  const onVisited = makeEvent<[HistoryItem]>()
  const onVisitRemoved = makeEvent<[chrome.history.RemovedResult]>()
  const modes = new Map<HistoryOperation, Mode>()

  const respond = <A>(operation: HistoryOperation, value: A): Promise<A> => {
    const mode = modes.get(operation)
    modes.delete(operation)

    if (mode?.kind === "throw") throw mode.cause

    return mode?.kind === "reject" ? Promise.reject(mode.cause) : Promise.resolve(value)
  }

  return {
    api: {
      search: vi.fn((_query: HistoryQuery) => respond("search", [page])),
      getVisits: vi.fn((_details: chrome.history.UrlDetails) => respond("getVisits", [visit])),
      addUrl: vi.fn((_details: chrome.history.UrlDetails) => respond("addUrl", undefined)),
      deleteUrl: vi.fn((_details: chrome.history.UrlDetails) => respond("deleteUrl", undefined)),
      deleteRange: vi.fn((_range: Range) => respond("deleteRange", undefined)),
      deleteAll: vi.fn(() => respond("deleteAll", undefined)),
      onVisited: onVisited.api,
      onVisitRemoved: onVisitRemoved.api
    } satisfies ChromeHistoryApi,
    onVisited: onVisited.controls,
    onVisitRemoved: onVisitRemoved.controls,
    failNext: (operation: HistoryOperation, mode: Mode) => { modes.set(operation, mode) }
  }
}

type Mock = ReturnType<typeof mockApi>

interface Call {
  readonly operation: HistoryOperation
  readonly run: (history: ChromeHistoryService) => Effect.Effect<Outcome, ChromeHistoryError>
  readonly calls: (mock: Mock) => ReadonlyArray<ReadonlyArray<HistoryQuery | chrome.history.UrlDetails | Range>>
  readonly args: ReadonlyArray<HistoryQuery | chrome.history.UrlDetails | Range>
  readonly result: ReadonlyArray<HistoryItem | VisitItem> | undefined
}

const calls: ReadonlyArray<Call> = [
  { operation: "search", run: (history) => history.search({ text: "app", maxResults: 5 }), calls: (mock) => mock.api.search.mock.calls, args: [{ text: "app", maxResults: 5 }], result: [page] },
  { operation: "getVisits", run: (history) => history.getVisits(url), calls: (mock) => mock.api.getVisits.mock.calls, args: [{ url }], result: [visit] },
  { operation: "addUrl", run: (history) => history.addUrl(url), calls: (mock) => mock.api.addUrl.mock.calls, args: [{ url }], result: undefined },
  { operation: "deleteUrl", run: (history) => history.deleteUrl(url), calls: (mock) => mock.api.deleteUrl.mock.calls, args: [{ url }], result: undefined },
  { operation: "deleteRange", run: (history) => history.deleteRange({ startTime: 0, endTime: 1000 }), calls: (mock) => mock.api.deleteRange.mock.calls, args: [{ startTime: 0, endTime: 1000 }], result: undefined },
  { operation: "deleteAll", run: (history) => history.deleteAll, calls: (mock) => mock.api.deleteAll.mock.calls, args: [], result: undefined }
]

/** The registration controls every simulated event shares. */
interface ListenerControls {
  readonly listenerCount: number
  readonly waitForListener: () => Promise<void>
  readonly failNext: (operation: "addListener" | "removeListener", cause: Error) => void
}

interface EventCase {
  readonly operation: "onVisited" | "onVisitRemoved"
  readonly stream: (history: ChromeHistoryService) => Stream.Stream<HistoryItem | RemovedResult, ChromeHistoryError>
  readonly controls: (mock: Mock) => ListenerControls
  /** Emits one sample event, which the stream delivers as `expected`. */
  readonly emit: (mock: Mock) => void
  readonly expected: HistoryItem | RemovedResult
  /** The API with this event's source replaced by `wrap(source)`. */
  readonly replace: (api: ChromeHistoryApi, wrap: <Args extends ReadonlyArray<unknown>>(event: EventSource<Args>) => EventSource<Args>) => ChromeHistoryApi
}

const events: ReadonlyArray<EventCase> = [
  {
    operation: "onVisited",
    stream: (history) => history.onVisited,
    controls: (mock) => mock.onVisited,
    emit: (mock) => { mock.onVisited.emit(page) },
    expected: page,
    replace: (api, wrap) => ({ ...api, onVisited: wrap(api.onVisited) })
  },
  {
    operation: "onVisitRemoved",
    stream: (history) => history.onVisitRemoved,
    controls: (mock) => mock.onVisitRemoved,
    emit: (mock) => { mock.onVisitRemoved.emit({ allHistory: true }) },
    expected: { allHistory: true, urls: [] },
    replace: (api, wrap) => ({ ...api, onVisitRemoved: wrap(api.onVisitRemoved) })
  }
]

/** Wraps an event so `opened` resolves once `count` listeners have been added through it. */
const gateListeners = <Args extends ReadonlyArray<unknown>>(event: EventSource<Args>, count: number) => {
  let open!: () => void
  const opened = new Promise<void>((resolve) => { open = resolve })
  let added = 0

  const source: EventSource<Args> = {
    addListener: (listener) => {
      event.addListener(listener)
      added += 1

      if (added === count) open()
    },
    removeListener: (listener) => event.removeListener(listener)
  }

  return { source, opened }
}

/** Runs `stream` for `count` elements on a scoped fiber once its listener is registered. */
const consume = <A>(stream: Stream.Stream<A, ChromeHistoryError>, count: number, registered: () => Promise<void>) => Effect.gen(function*() {
  const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, count)))
  yield* Effect.promise(registered)

  return fiber
})

describe("ChromeHistory", () => {
  it.effect.each(calls)("$operation passes exactly its arguments and returns Chrome's result", ({ run, calls: callsOf, args, result }) => Effect.gen(function*() {
    const mock = mockApi()
    expect(yield* run(make(mock.api))).toStrictEqual(result)
    expect(callsOf(mock)).toStrictEqual([args])
  }))

  it.effect.each(calls)("$operation maps a rejection to the typed error", ({ operation, run }) => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error(`${operation} rejected`)
    mock.failNext(operation, { kind: "reject", cause })
    const error = yield* Effect.flip(run(make(mock.api)))
    expect(error).toBeInstanceOf(ChromeHistoryError)
    expect(error._tag).toBe("ChromeHistoryError")
    expect(error.operation).toBe(operation)
    expect(error.cause).toBe(cause)
  }))

  it.effect.each(calls)("$operation maps a synchronous throw to the typed error", ({ operation, run }) => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new TypeError(`Error in invocation of history.${operation}`)
    mock.failNext(operation, { kind: "throw", cause })
    const error = yield* Effect.flip(run(make(mock.api)))
    expect(error).toBeInstanceOf(ChromeHistoryError)
    expect(error).toMatchObject({ operation, cause })
  }))

  it.effect.each(calls)("$operation calls Chrome only when run, and again on every run", ({ run, calls: callsOf, args }) => Effect.gen(function*() {
    const mock = mockApi()
    const effect = run(make(mock.api))
    expect(callsOf(mock)).toHaveLength(0)
    yield* effect
    yield* effect
    expect(callsOf(mock)).toStrictEqual([args, args])
  }))

  it.effect("passes a query unchanged, never adding fields Chrome would default", () => Effect.gen(function*() {
    const mock = mockApi()
    const history = make(mock.api)
    yield* history.search({ text: "" })
    yield* history.search({ text: "docs", startTime: 0, endTime: 5000, maxResults: 0 })
    expect(mock.api.search.mock.calls).toStrictEqual([[{ text: "" }], [{ text: "docs", startTime: 0, endTime: 5000, maxResults: 0 }]])
    expect(Object.keys(mock.api.search.mock.calls[0]?.[0] ?? {})).toEqual(["text"])
  }))

  it.effect("returns empty results as empty lists", () => Effect.gen(function*() {
    const mock = mockApi()
    mock.api.search.mockResolvedValueOnce([])
    mock.api.getVisits.mockResolvedValueOnce([])
    const history = make(mock.api)
    expect(yield* history.search({ text: "nothing" })).toEqual([])
    expect(yield* history.getVisits("https://never.example/")).toEqual([])
  }))

  it.effect("creating the service reads no event and registers no listener", () => Effect.gen(function*() {
    const mock = mockApi()
    const readVisited = vi.fn(() => mock.api.onVisited)
    const readVisitRemoved = vi.fn(() => mock.api.onVisitRemoved)

    const api: ChromeHistoryApi = {
      ...mock.api,
      get onVisited() { return readVisited() },
      get onVisitRemoved() { return readVisitRemoved() }
    }

    const history = make(api)
    expect(readVisited).not.toHaveBeenCalled()
    expect(readVisitRemoved).not.toHaveBeenCalled()
    const fiber = yield* consume(history.onVisited, 1, mock.onVisited.waitForListener)
    expect(readVisited).toHaveBeenCalledOnce()
    expect(readVisitRemoved).not.toHaveBeenCalled()
    mock.onVisited.emit(page)
    yield* Fiber.join(fiber)
    expect(mock.onVisitRemoved.listenerCount).toBe(0)
  }))

  it.effect("streams visits in order and removes the listener when the stream ends", () => Effect.gen(function*() {
    const mock = mockApi()
    const second: HistoryItem = { ...page, id: "2", url: "https://app.example/2" }
    const fiber = yield* consume(make(mock.api).onVisited, 2, mock.onVisited.waitForListener)
    expect(mock.onVisited.listenerCount).toBe(1)
    mock.onVisited.emit(page)
    mock.onVisited.emit(second)
    expect(yield* Fiber.join(fiber)).toEqual([page, second])
    expect(mock.onVisited.listenerCount).toBe(0)
  }))

  it.effect("streams removals with urls always present", () => Effect.gen(function*() {
    const mock = mockApi()
    const fiber = yield* consume(make(mock.api).onVisitRemoved, 4, mock.onVisitRemoved.waitForListener)
    mock.onVisitRemoved.emit({ allHistory: false, urls: [url, "https://app.example/2"] })
    mock.onVisitRemoved.emit({ allHistory: true })
    mock.onVisitRemoved.emit({ allHistory: true, urls: [] })
    mock.onVisitRemoved.emit({ allHistory: false })
    const removed: Array<RemovedResult> = yield* Fiber.join(fiber)
    expect(removed).toStrictEqual([
      { allHistory: false, urls: [url, "https://app.example/2"] },
      { allHistory: true, urls: [] },
      { allHistory: true, urls: [] },
      { allHistory: false, urls: [] }
    ])
    expect(mock.onVisitRemoved.listenerCount).toBe(0)
  }))

  it.effect.each(events)("$operation removes its listener when interrupted", ({ stream, controls }) => Effect.gen(function*() {
    const mock = mockApi()
    const fiber = yield* Effect.forkScoped(Stream.runDrain(stream(make(mock.api))))
    yield* Effect.promise(controls(mock).waitForListener)
    expect(controls(mock).listenerCount).toBe(1)
    yield* Fiber.interrupt(fiber)
    expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
    expect(controls(mock).listenerCount).toBe(0)
  }))

  it.effect.each(events)("$operation removes its listener when the consumer fails", ({ stream, controls, emit }) => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new ChromeHistoryError({ operation: "consumer", cause: new Error("downstream") })
    const fiber = yield* Effect.forkScoped(Stream.runDrain(Stream.mapEffect(stream(make(mock.api)), () => Effect.fail(cause))))
    yield* Effect.promise(controls(mock).waitForListener)
    emit(mock)
    expect(yield* Effect.flip(Fiber.join(fiber))).toBe(cause)
    expect(controls(mock).listenerCount).toBe(0)
  }))

  it.effect.each(events)("$operation gives each consumption its own listener", ({ stream, controls, emit, expected, replace }) => Effect.gen(function*() {
    const mock = mockApi()
    let opened: Promise<void> = Promise.resolve()

    const service = make(replace(mock.api, (event) => {
      const gate = gateListeners(event, 2)
      opened = gate.opened

      return gate.source
    }))

    const left = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream(service), 1)))
    const right = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream(service), 1)))
    yield* Effect.promise(() => opened)
    expect(controls(mock).listenerCount).toBe(2)
    emit(mock)
    expect(yield* Fiber.join(left)).toStrictEqual([expected])
    expect(yield* Fiber.join(right)).toStrictEqual([expected])
    expect(controls(mock).listenerCount).toBe(0)
  }))

  it.effect.each(events)("$operation registers nothing until run", ({ stream, controls }) => Effect.gen(function*() {
    const mock = mockApi()
    const unused = stream(make(mock.api))
    expect(controls(mock).listenerCount).toBe(0)
    const fiber = yield* Effect.forkScoped(Stream.runDrain(unused))
    yield* Effect.promise(controls(mock).waitForListener)
    yield* Fiber.interrupt(fiber)
    expect(controls(mock).listenerCount).toBe(0)
  }))

  it.effect.each(events)("$operation types a registration failure and can be run again", ({ operation, stream, controls }) => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("event unavailable")
    const subscription = stream(make(mock.api))
    controls(mock).failNext("addListener", cause)
    const error = yield* Effect.flip(Stream.runDrain(subscription))
    expect(error).toBeInstanceOf(ChromeHistoryError)
    expect(error).toMatchObject({ operation, cause })
    expect(controls(mock).listenerCount).toBe(0)
    const fiber = yield* Effect.forkScoped(Stream.runDrain(subscription))
    yield* Effect.promise(controls(mock).waitForListener)
    yield* Fiber.interrupt(fiber)
    expect(controls(mock).listenerCount).toBe(0)
  }))

  it.effect.each(events)("$operation types a failing event lookup", ({ operation, stream }) => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("history events unavailable")
    const api: ChromeHistoryApi = { ...mock.api }
    Object.defineProperty(api, operation, { get: () => { throw cause } })
    expect(yield* Effect.flip(Stream.runDrain(stream(make(api))))).toMatchObject({ operation, cause })
  }))

  it.effect.each(events)("$operation removes a listener whose registration added it and then threw", ({ operation, stream, controls, replace }) => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("registered, then threw")

    const api = replace(mock.api, (event) => ({
      addListener: (listener) => {
        event.addListener(listener)
        throw cause
      },
      removeListener: (listener) => event.removeListener(listener)
    }))

    expect(yield* Effect.flip(Stream.runDrain(stream(make(api))))).toMatchObject({ operation, cause })
    expect(controls(mock).listenerCount).toBe(0)
  }))

  it.effect("provides an injected API through layer", () => Effect.gen(function*() {
    const mock = mockApi()
    expect(yield* Effect.flatMap(ChromeHistory, (history) => history.getVisits(url)).pipe(Effect.provide(layer(mock.api)))).toEqual([visit])
  }))

  it.effect("layerLive fails with initialize without a chrome global", () => Effect.gen(function*() {
    expect("chrome" in globalThis).toBe(false)
    const error = yield* Effect.flip(ChromeHistory.pipe(Effect.provide(layerLive)))
    expect(error).toBeInstanceOf(ChromeHistoryError)
    expect(error.operation).toBe("initialize")
    expect(error.cause).toBeInstanceOf(Error)
    expect(error.cause).toHaveProperty("message", "chrome.history is unavailable in this context")
  }))

  it.effect("layerLive fails with initialize when chrome has no history namespace", () => Effect.gen(function*() {
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", {})), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeHistory.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
  }))

  it.effect("layerLive reads the global each time it builds", () => Effect.gen(function*() {
    const first = mockApi()
    const second = mockApi()
    second.api.search.mockResolvedValue([])
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", { history: first.api })), () => Effect.sync(() => vi.unstubAllGlobals()))
    const search = Effect.flatMap(ChromeHistory, (history) => history.search({ text: "" }))
    expect(yield* search.pipe(Effect.provide(layerLive))).toEqual([page])
    vi.stubGlobal("chrome", { history: second.api })
    expect(yield* search.pipe(Effect.provide(layerLive))).toEqual([])
    expect(first.api.search).toHaveBeenCalledOnce()
    expect(second.api.search).toHaveBeenCalledOnce()
  }))
})

describe("makeHistory", () => {
  const hour = 60 * 60 * 1000
  const now = 1_700_000_000_000

  const fixture = () => {
    const history = makeHistory()
    history.controls.setNow(now)

    return { ...history, service: make(history.api) }
  }

  it.effect("searches the past 24 hours by default, one item per page, most recently visited first", () => Effect.gen(function*() {
    const { controls, service } = fixture()
    controls.seed({ url: "https://old.example/", visitTime: now - 25 * hour })
    controls.seed({ url: "https://a.example/", title: "A", visitTime: now - 3 * hour })
    controls.seed({ url: "https://b.example/", title: "B", visitTime: now - 2 * hour })
    controls.seed({ url: "https://a.example/", visitTime: now - hour, transition: "typed" })
    controls.seed({ url: "https://future.example/", visitTime: now + hour })
    expect(yield* service.search({ text: "" })).toStrictEqual([
      { id: "2", url: "https://a.example/", title: "A", lastVisitTime: now - hour, visitCount: 2, typedCount: 1 },
      { id: "3", url: "https://b.example/", title: "B", lastVisitTime: now - 2 * hour, visitCount: 1, typedCount: 0 }
    ])
  }))

  it.effect("includes both ends of the default range: 24 hours ago and the clock itself", () => Effect.gen(function*() {
    const { controls, service } = fixture()
    controls.seed({ url: "https://too-old.example/", visitTime: now - 24 * hour - 1 })
    controls.seed({ url: "https://oldest.example/", visitTime: now - 24 * hour })
    controls.seed({ url: "https://now.example/", visitTime: now })
    controls.seed({ url: "https://next.example/", visitTime: now + 1 })
    expect((yield* service.search({ text: "" })).map((item) => item.url)).toEqual(["https://now.example/", "https://oldest.example/"])
    expect((yield* service.search({ text: "", endTime: now })).map((item) => item.url)).toEqual(["https://oldest.example/"])
    expect((yield* service.search({ text: "", startTime: now - 24 * hour - 1 })).map((item) => item.url)).toEqual([
      "https://now.example/", "https://oldest.example/", "https://too-old.example/"
    ])
  }))

  it.effect("bounds a search from startTime inclusive to endTime exclusive, reporting the overall last visit", () => Effect.gen(function*() {
    const { controls, service } = fixture()
    controls.seed({ url: "https://edge.example/", visitTime: 1000 })
    controls.seed({ url: "https://edge.example/", visitTime: 5000 })
    controls.seed({ url: "https://end.example/", visitTime: 2000 })
    const items = yield* service.search({ text: "", startTime: 1000, endTime: 2000 })
    expect(items.map((item) => [item.url, item.lastVisitTime])).toEqual([["https://edge.example/", 5000]])
    expect((yield* service.search({ text: "", startTime: 2000 })).map((item) => item.url)).toEqual(["https://edge.example/", "https://end.example/"])
    expect(yield* service.search({ text: "", startTime: 2000, endTime: 2000 })).toEqual([])
    expect(yield* service.search({ text: "", startTime: 3000, endTime: 1000 })).toEqual([])
  }))

  it.effect("ranks pages by their latest visit inside the range", () => Effect.gen(function*() {
    const { controls, service } = fixture()
    controls.seed({ url: "https://a.example/", visitTime: 100 })
    controls.seed({ url: "https://a.example/", visitTime: 900 })
    controls.seed({ url: "https://b.example/", visitTime: 500 })
    expect((yield* service.search({ text: "", startTime: 0, endTime: 600 })).map((item) => item.url)).toEqual(["https://b.example/", "https://a.example/"])
    expect((yield* service.search({ text: "", startTime: 0 })).map((item) => item.url)).toEqual(["https://a.example/", "https://b.example/"])
  }))

  it.effect("breaks equal visit times by the later-recorded visit", () => Effect.gen(function*() {
    const { controls, service } = fixture()
    controls.seed({ url: "https://first.example/", visitTime: 100 })
    controls.seed({ url: "https://second.example/", visitTime: 100 })
    expect((yield* service.search({ text: "", startTime: 0 })).map((item) => item.url)).toEqual(["https://second.example/", "https://first.example/"])
  }))

  it.effect("matches every word of the text in the URL or title, ignoring case", () => Effect.gen(function*() {
    const { controls, service } = fixture()
    controls.seed({ url: "https://docs.example/effect", title: "Effect Guide", visitTime: now - 1 })
    controls.seed({ url: "https://blog.example/", title: "Effect release notes", visitTime: now - 2 })
    controls.seed({ url: "https://other.example/", title: "Other", visitTime: now - 3 })
    const urls = (text: string) => service.search({ text }).pipe(Effect.map((items) => items.map((item) => item.url)))
    expect(yield* urls("EFFECT")).toEqual(["https://docs.example/effect", "https://blog.example/"])
    expect(yield* urls("  effect   guide ")).toEqual(["https://docs.example/effect"])
    expect(yield* urls("docs guide")).toEqual(["https://docs.example/effect"])
    expect(yield* urls("missing")).toEqual([])
    expect(yield* urls("   ")).toHaveLength(3)
  }))

  it.effect("caps results at 100 by default, at maxResults when given, and not at all for 0", () => Effect.gen(function*() {
    const { controls, service } = fixture()

    for (let index = 0; index < 150; index++) controls.seed({ url: `https://page-${index}.example/`, visitTime: now - 150 + index })

    const all = yield* service.search({ text: "", maxResults: 0 })
    expect(all).toHaveLength(150)
    expect(all[0]?.url).toBe("https://page-149.example/")
    expect(all[149]?.url).toBe("https://page-0.example/")
    expect(yield* service.search({ text: "" })).toStrictEqual(all.slice(0, 100))
    expect(yield* service.search({ text: "", maxResults: 7 })).toStrictEqual(all.slice(0, 7))
    expect(yield* service.search({ text: "", maxResults: 1000 })).toStrictEqual(all)
  }))

  it.effect("never matches subframe or keyword-generated visits, though they still count", () => Effect.gen(function*() {
    const { controls, service } = fixture()
    controls.seed({ url: "https://frame.example/", visitTime: now - 3, transition: "auto_subframe" })
    controls.seed({ url: "https://manual.example/", visitTime: now - 2, transition: "manual_subframe" })
    controls.seed({ url: "https://keyword.example/", visitTime: now - 1, transition: "keyword_generated" })
    controls.seed({ url: "https://mixed.example/", visitTime: now - 10, transition: "link" })
    controls.seed({ url: "https://mixed.example/", visitTime: now - 1, transition: "auto_subframe" })
    expect(yield* service.search({ text: "" })).toStrictEqual([
      { id: "4", url: "https://mixed.example/", title: "", lastVisitTime: now - 1, visitCount: 2, typedCount: 0 }
    ])
    expect(controls.pages().map((item) => item.url)).toEqual([
      "https://frame.example/", "https://manual.example/", "https://keyword.example/", "https://mixed.example/"
    ])
  }))

  it.effect("lists a page's visits oldest first and none for an unknown page", () => Effect.gen(function*() {
    const { controls, service } = fixture()
    controls.seed({ url: url, visitTime: 300, transition: "typed" })
    controls.seed({ url: "https://other.example/", visitTime: 100 })
    controls.seed({ url: url, visitTime: 100, referringVisitId: "2", isLocal: false })
    controls.seed({ url: url, visitTime: 100, transition: "reload" })
    expect(yield* service.getVisits(url)).toStrictEqual([
      { id: "1", visitId: "3", visitTime: 100, referringVisitId: "2", transition: "link", isLocal: false },
      { id: "1", visitId: "4", visitTime: 100, referringVisitId: "0", transition: "reload", isLocal: true },
      { id: "1", visitId: "1", visitTime: 300, referringVisitId: "0", transition: "typed", isLocal: true }
    ])
    expect(yield* service.getVisits("https://unknown.example/")).toEqual([])
  }))

  it.effect("addresses pages by canonical URL", () => Effect.gen(function*() {
    const { controls, service } = fixture()
    controls.seed({ url: "HTTPS://App.Example", visitTime: 100 })
    expect(controls.pages().map((item) => item.url)).toEqual([url])
    expect(yield* service.getVisits("https://app.example:443/")).toHaveLength(1)
    yield* service.deleteUrl("https://APP.example")
    expect(controls.pages()).toEqual([])
  }))

  it.effect.each<{ readonly operation: HistoryOperation; readonly run: (history: ChromeHistoryService) => Effect.Effect<Outcome, ChromeHistoryError> }>([
    { operation: "getVisits", run: (history) => history.getVisits("not a url") },
    { operation: "addUrl", run: (history) => history.addUrl("isolated-app://app/") },
    { operation: "deleteUrl", run: (history) => history.deleteUrl("") }
  ])("$operation rejects an invalid URL as Chrome does", ({ operation, run }) => Effect.gen(function*() {
    const { controls, service } = fixture()
    const error = yield* Effect.flip(run(service))
    expect(error).toMatchObject({ operation })
    expect(error.cause).toHaveProperty("message", "Url is invalid.")
    expect(controls.pages()).toEqual([])
  }))

  it.effect("addUrl records a link visit now and reports it on onVisited", () => Effect.gen(function*() {
    const { controls, service } = fixture()
    controls.seed({ url, title: "App", visitTime: now - hour, transition: "typed" })
    const fiber = yield* consume(service.onVisited, 2, controls.onVisited.waitForListener)
    yield* service.addUrl(url)
    controls.setNow(now + 5)
    yield* service.addUrl("https://new.example")
    expect(yield* Fiber.join(fiber)).toStrictEqual([
      { id: "1", url, title: "App", lastVisitTime: now, visitCount: 2, typedCount: 1 },
      { id: "2", url: "https://new.example/", title: "", lastVisitTime: now + 5, visitCount: 1, typedCount: 0 }
    ])
    expect((yield* service.getVisits(url)).map((item) => [item.transition, item.visitTime])).toEqual([["typed", now - hour], ["link", now]])
  }))

  it.effect("visit emits onVisited while seed does not", () => Effect.gen(function*() {
    const { controls, service } = fixture()
    const fiber = yield* consume(service.onVisited, 1, controls.onVisited.waitForListener)
    controls.seed({ url: "https://quiet.example/" })
    const loud = controls.visit({ url: "https://loud.example/", title: "Loud" })
    expect(loud).toStrictEqual({ id: "2", url: "https://loud.example/", title: "Loud", lastVisitTime: now, visitCount: 1, typedCount: 0 })
    expect(yield* Fiber.join(fiber)).toStrictEqual([loud])
  }))

  it.effect("deleteUrl removes the page and reports it, and an unknown page silently", () => Effect.gen(function*() {
    const { controls, service } = fixture()
    controls.seed({ url, visitTime: 100 })
    controls.seed({ url, visitTime: 200 })
    const fiber = yield* consume(service.onVisitRemoved, 2, controls.onVisitRemoved.waitForListener)
    yield* service.deleteUrl(url)
    yield* service.deleteUrl("https://unknown.example/")
    yield* service.deleteAll
    expect(yield* Fiber.join(fiber)).toStrictEqual([{ allHistory: false, urls: [url] }, { allHistory: true, urls: [] }])
    expect(yield* service.getVisits(url)).toEqual([])
  }))

  it.effect("deleteRange keeps pages with visits outside the range and reports only purged ones", () => Effect.gen(function*() {
    const { controls, service } = fixture()
    controls.seed({ url: "https://kept.example/", visitTime: 100, transition: "typed" })
    controls.seed({ url: "https://kept.example/", visitTime: 1000, transition: "typed" })
    controls.seed({ url: "https://purged.example/", visitTime: 500 })
    controls.seed({ url: "https://boundary.example/", visitTime: 1000 })
    const fiber = yield* consume(service.onVisitRemoved, 3, controls.onVisitRemoved.waitForListener)
    yield* service.deleteRange({ startTime: 100, endTime: 1000 })
    expect(controls.pages()).toStrictEqual([
      { id: "1", url: "https://kept.example/", title: "", lastVisitTime: 1000, visitCount: 1, typedCount: 1 },
      { id: "3", url: "https://boundary.example/", title: "", lastVisitTime: 1000, visitCount: 1, typedCount: 0 }
    ])
    yield* service.deleteRange({ startTime: 0, endTime: 1000 })
    yield* service.deleteRange({ startTime: 2000, endTime: 1000 })
    yield* service.deleteRange({ startTime: 1000, endTime: 1001 })
    yield* service.deleteRange({ startTime: 0, endTime: 1001 })
    yield* service.deleteAll
    expect(yield* Fiber.join(fiber)).toStrictEqual([
      { allHistory: false, urls: ["https://purged.example/"] },
      { allHistory: false, urls: ["https://kept.example/", "https://boundary.example/"] },
      { allHistory: true, urls: [] }
    ])
  }))

  it.effect("deleteRange reports a partial removal with no urls", () => Effect.gen(function*() {
    const { controls, service } = fixture()
    controls.seed({ url, visitTime: 100 })
    controls.seed({ url, visitTime: 200 })
    const fiber = yield* consume(service.onVisitRemoved, 1, controls.onVisitRemoved.waitForListener)
    yield* service.deleteRange({ startTime: 0, endTime: 150 })
    expect(yield* Fiber.join(fiber)).toStrictEqual([{ allHistory: false, urls: [] }])
    expect(controls.pages()).toStrictEqual([{ id: "1", url, title: "", lastVisitTime: 200, visitCount: 1, typedCount: 0 }])
  }))

  it.effect("deleteAll clears everything and always reports allHistory", () => Effect.gen(function*() {
    const { controls, service } = fixture()
    controls.seed({ url, visitTime: 100 })
    const fiber = yield* consume(service.onVisitRemoved, 2, controls.onVisitRemoved.waitForListener)
    yield* service.deleteAll
    yield* service.deleteAll
    expect(yield* Fiber.join(fiber)).toStrictEqual([{ allHistory: true, urls: [] }, { allHistory: true, urls: [] }])
    expect(controls.pages()).toEqual([])
    expect(yield* service.search({ text: "", startTime: 0 })).toEqual([])
  }))

  it.effect("rejects every delete while deletion is prohibited, before checking the URL", () => Effect.gen(function*() {
    const { controls, service } = fixture()
    controls.seed({ url, visitTime: 100 })
    controls.setDeletionAllowed(false)
    const message = "Browsing history is not allowed to be deleted."

    for (const [operation, effect] of [
      ["deleteUrl", service.deleteUrl("not a url")],
      ["deleteRange", service.deleteRange({ startTime: 0, endTime: 1000 })],
      ["deleteAll", service.deleteAll]
    ] as const) {
      const error = yield* Effect.flip(effect)
      expect(error).toMatchObject({ operation })
      expect(error.cause).toHaveProperty("message", message)
    }

    expect(controls.pages()).toHaveLength(1)
    yield* service.addUrl("https://still-allowed.example/")
    controls.setDeletionAllowed(true)
    yield* service.deleteAll
    expect(controls.pages()).toEqual([])
  }))

  it.effect.each(["search", "getVisits", "addUrl", "deleteUrl", "deleteRange", "deleteAll"] as const)("failNext rejects the next %s once with the given cause", (operation) => Effect.gen(function*() {
    const { controls, service } = fixture()
    const cause = new Error(`${operation} failed`)

    const run: Record<HistoryOperation, Effect.Effect<Outcome, ChromeHistoryError>> = {
      search: service.search({ text: "" }),
      getVisits: service.getVisits(url),
      addUrl: service.addUrl(url),
      deleteUrl: service.deleteUrl(url),
      deleteRange: service.deleteRange({ startTime: 0, endTime: 1 }),
      deleteAll: service.deleteAll
    }

    controls.failNext(operation, cause)
    expect(yield* Effect.flip(run[operation])).toMatchObject({ operation, cause })
    yield* run[operation]
  }))

  it.effect("shares state between api and layer, and keeps separate fixtures independent", () => Effect.gen(function*() {
    const first = fixture()
    const second = fixture()
    yield* first.service.addUrl(url)
    const viaLayer = yield* Effect.flatMap(ChromeHistory, (history) => history.search({ text: "" })).pipe(Effect.provide(first.layer))
    expect(viaLayer.map((item) => item.url)).toEqual([url])
    expect(second.controls.pages()).toEqual([])
  }))

  it.effect("returns fresh copies that callers can mutate safely", () => Effect.gen(function*() {
    const { controls, service } = fixture()
    controls.seed({ url, title: "App", visitTime: now - 1 })
    const [found] = yield* service.search({ text: "" })

    if (found !== undefined) found.title = "mutated"

    const [visitItem] = yield* service.getVisits(url)

    if (visitItem !== undefined) visitItem.transition = "reload"

    expect(controls.pages()[0]?.title).toBe("App")
    expect((yield* service.getVisits(url))[0]?.transition).toBe("link")
  }))

  it.effect("uses overrides in place of the simulated members", () => Effect.gen(function*() {
    const search = vi.fn(async (_query: HistoryQuery): Promise<Array<HistoryItem>> => [page])
    const history = makeHistory({ search })
    expect(yield* make(history.api).search({ text: "x" })).toEqual([page])
    expect(search).toHaveBeenCalledExactlyOnceWith({ text: "x" })
  }))

  it.effect("follows the wall clock until setNow pins it", () => Effect.gen(function*() {
    const history = makeHistory()
    const before = Date.now()
    const item = history.controls.seed({ url })
    expect(item.lastVisitTime).toBeGreaterThanOrEqual(before)
    expect(item.lastVisitTime).toBeLessThanOrEqual(Date.now())
    history.controls.setNow(42)
    expect(history.controls.seed({ url }).lastVisitTime).toBe(Math.max(42, item.lastVisitTime ?? 0))
    expect((yield* make(history.api).getVisits(url)).map((visit) => visit.visitTime)).toEqual([42, item.lastVisitTime])
    history.controls.setNow(undefined)
    expect(history.controls.seed({ url: "https://later.example/" }).lastVisitTime).toBeGreaterThanOrEqual(before)
  }))
})
