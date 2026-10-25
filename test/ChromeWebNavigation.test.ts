// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Exit, Fiber, Option, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeWebNavigation, ChromeWebNavigationError, layer, layerLive, make } from "../src/ChromeWebNavigation.js"
import type {
  ChromeWebNavigationApi, ChromeWebNavigationService, DocumentLoad, Frame, FrameDetails, FrameInfo, Navigation,
  NavigationFailure, NavigationFilter, NavigationStart, NavigationTarget, TabReplacement
} from "../src/ChromeWebNavigation.js"
import { makeEvent } from "../src/ChromeTesting.js"
import { makeWebNavigation, matchesNavigationFilter } from "../src/testing/WebNavigation.js"

const frame: Frame = {
  frameId: 0, parentFrameId: -1, processId: 1, url: "https://app.example/", documentId: "document-1",
  documentLifecycle: "active", errorOccurred: false, frameType: "outermost_frame"
}

const info: FrameInfo = {
  parentFrameId: -1, url: "https://app.example/", documentId: "document-1", documentLifecycle: "active",
  errorOccurred: false, frameType: "outermost_frame"
}

const start: NavigationStart = {
  tabId: 7, frameId: 0, url: "https://app.example/next", timeStamp: 0, processId: -1,
  documentLifecycle: "active", frameType: "outermost_frame", parentFrameId: -1
}

const navigation: Navigation = {
  ...start, processId: 1, transitionType: "link", transitionQualifiers: [], documentId: "document-1"
}

const load: DocumentLoad = { ...start, processId: 1, documentId: "document-1" }

const failure: NavigationFailure = { ...load, processId: -1, error: "net::ERR_ABORTED" }

const target: NavigationTarget = {
  sourceTabId: 7, sourceFrameId: 0, sourceProcessId: 1, tabId: 8, timeStamp: 0, url: "https://app.example/popup"
}

const replacement: TabReplacement = { replacedTabId: 7, tabId: 9, timeStamp: 0 }

const filter: NavigationFilter = { url: [{ hostSuffix: "app.example" }] }

/** A Chrome-shaped event whose addListener records every argument it was given. */
const recorded = <Args extends ReadonlyArray<unknown>>() => {
  const event = makeEvent<Args>()

  return {
    api: {
      addListener: vi.fn((listener: (...args: Args) => void, _filter?: NavigationFilter) => event.api.addListener(listener)),
      removeListener: vi.fn((listener: (...args: Args) => void) => event.api.removeListener(listener))
    },
    controls: event.controls
  }
}

type Recorded<A> = ReturnType<typeof recorded<[A]>>

const mockApi = () => {
  const events = {
    onBeforeNavigate: recorded<[NavigationStart]>(),
    onCommitted: recorded<[Navigation]>(),
    onDOMContentLoaded: recorded<[DocumentLoad]>(),
    onCompleted: recorded<[DocumentLoad]>(),
    onErrorOccurred: recorded<[NavigationFailure]>(),
    onCreatedNavigationTarget: recorded<[NavigationTarget]>(),
    onReferenceFragmentUpdated: recorded<[Navigation]>(),
    onHistoryStateUpdated: recorded<[Navigation]>(),
    onTabReplaced: recorded<[TabReplacement]>()
  }

  return {
    api: {
      getAllFrames: vi.fn(async (_details: chrome.webNavigation.GetAllFrameDetails): Promise<Array<Frame> | null | undefined> => [frame]),
      getFrame: vi.fn(async (_details: FrameDetails): Promise<FrameInfo | null | undefined> => info),
      onBeforeNavigate: events.onBeforeNavigate.api,
      onCommitted: events.onCommitted.api,
      onDOMContentLoaded: events.onDOMContentLoaded.api,
      onCompleted: events.onCompleted.api,
      onErrorOccurred: events.onErrorOccurred.api,
      onCreatedNavigationTarget: events.onCreatedNavigationTarget.api,
      onReferenceFragmentUpdated: events.onReferenceFragmentUpdated.api,
      onHistoryStateUpdated: events.onHistoryStateUpdated.api,
      onTabReplaced: events.onTabReplaced.api
    } satisfies ChromeWebNavigationApi,
    ...events
  }
}

type Mock = ReturnType<typeof mockApi>

/**
 * Consumes one event, then checks the listener was registered with exactly the given
 * filter (or no second argument at all) and removed again once the stream finished.
 */
const expectDelivery = <A>(
  stream: Stream.Stream<A, ChromeWebNavigationError>,
  event: Recorded<A>,
  details: A,
  expectedFilter: NavigationFilter | undefined
) => Effect.gen(function*() {
  const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 1)))
  yield* Effect.promise(() => event.controls.waitForListener())
  event.controls.emit(details)
  expect(yield* Fiber.join(fiber)).toEqual([details])
  const [call] = event.api.addListener.mock.calls
  expect(call).toEqual(expectedFilter === undefined ? [expect.any(Function)] : [expect.any(Function), expectedFilter])
  expect(event.api.removeListener).toHaveBeenCalledExactlyOnceWith(call?.[0])
  expect(event.controls.listenerCount).toBe(0)
})

/** Interrupts a running subscription and checks its one listener was removed. */
const expectInterruptCleanup = <A>(stream: Stream.Stream<A, ChromeWebNavigationError>, event: Recorded<A>) => Effect.gen(function*() {
  const fiber = yield* Effect.forkScoped(Stream.runDrain(stream))
  yield* Effect.promise(() => event.controls.waitForListener())
  expect(event.controls.listenerCount).toBe(1)
  yield* Fiber.interrupt(fiber)
  expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
  expect(event.api.removeListener).toHaveBeenCalledExactlyOnceWith(event.api.addListener.mock.calls[0]?.[0])
  expect(event.controls.listenerCount).toBe(0)
})

/** Checks one filterable event end to end on fresh mocks. */
const filterableCase = <A>(
  select: (service: ChromeWebNavigationService) => (filter?: NavigationFilter) => Stream.Stream<A, ChromeWebNavigationError>,
  pick: (mock: Mock) => Recorded<A>,
  details: A
) => (operation: string) => Effect.gen(function*() {
  const unfiltered = mockApi()
  yield* expectDelivery(select(make(unfiltered.api))(), pick(unfiltered), details, undefined)

  const withFilter = mockApi()
  yield* expectDelivery(select(make(withFilter.api))(filter), pick(withFilter), details, filter)

  const interrupted = mockApi()
  yield* expectInterruptCleanup(select(make(interrupted.api))(filter), pick(interrupted))

  const failing = mockApi()
  const cause = new Error(`${operation} unavailable`)
  pick(failing).controls.failNext("addListener", cause)
  const error = yield* Effect.flip(Stream.runDrain(select(make(failing.api))(filter)))
  expect(error).toBeInstanceOf(ChromeWebNavigationError)
  expect(error).toMatchObject({ operation, cause })
  expect(pick(failing).controls.listenerCount).toBe(0)
})

const filterableCases = [
  ["onBeforeNavigate", filterableCase((service) => service.onBeforeNavigate, (mock) => mock.onBeforeNavigate, start)],
  ["onCommitted", filterableCase((service) => service.onCommitted, (mock) => mock.onCommitted, navigation)],
  ["onDOMContentLoaded", filterableCase((service) => service.onDOMContentLoaded, (mock) => mock.onDOMContentLoaded, load)],
  ["onCompleted", filterableCase((service) => service.onCompleted, (mock) => mock.onCompleted, load)],
  ["onErrorOccurred", filterableCase((service) => service.onErrorOccurred, (mock) => mock.onErrorOccurred, failure)],
  ["onCreatedNavigationTarget", filterableCase(
    (service) => service.onCreatedNavigationTarget, (mock) => mock.onCreatedNavigationTarget, target
  )],
  ["onReferenceFragmentUpdated", filterableCase(
    (service) => service.onReferenceFragmentUpdated, (mock) => mock.onReferenceFragmentUpdated, navigation
  )],
  ["onHistoryStateUpdated", filterableCase((service) => service.onHistoryStateUpdated, (mock) => mock.onHistoryStateUpdated, navigation)]
] as const

describe("ChromeWebNavigation", () => {
  it.effect("lists a tab's frames, passing only the tab id", () => Effect.gen(function*() {
    const { api } = mockApi()
    const service = make(api)
    expect(yield* service.getAllFrames(7)).toEqual(Option.some([frame]))
    expect(api.getAllFrames).toHaveBeenCalledExactlyOnceWith({ tabId: 7 })
    api.getAllFrames.mockResolvedValueOnce([])
    expect(yield* service.getAllFrames(7)).toEqual(Option.some([]))
  }))

  it.effect.each([["null", null], ["undefined", undefined]] as const)(
    "reads an unknown tab reported as %s as None",
    ([_name, absent]) => Effect.gen(function*() {
      const { api } = mockApi()
      api.getAllFrames.mockResolvedValueOnce(absent)
      api.getFrame.mockResolvedValueOnce(absent)
      expect(Option.isNone(yield* make(api).getAllFrames(8))).toBe(true)
      expect(Option.isNone(yield* make(api).getFrame({ tabId: 8, frameId: 0 }))).toBe(true)
    })
  )

  it.effect("reads one frame as an option, passing the details unchanged", () => Effect.gen(function*() {
    const { api } = mockApi()
    const service = make(api)
    expect(yield* service.getFrame({ tabId: 7, frameId: 0 })).toEqual(Option.some(info))
    expect(api.getFrame).toHaveBeenLastCalledWith({ tabId: 7, frameId: 0 })
    yield* service.getFrame({ documentId: "document-1" })
    expect(api.getFrame).toHaveBeenLastCalledWith({ documentId: "document-1" })
    expect(api.getFrame.mock.lastCall?.[0]).not.toHaveProperty("tabId")
  }))

  it.effect.each([
    ["getAllFrames", (api: Mock["api"]) => api.getAllFrames, (service: ChromeWebNavigationService) => Effect.asVoid(service.getAllFrames(9))],
    ["getFrame", (api: Mock["api"]) => api.getFrame, (service: ChromeWebNavigationService) => Effect.asVoid(service.getFrame({ tabId: 9, frameId: 0 }))]
  ] as const)("maps a rejection and a synchronous throw from %s to the typed error", ([operation, member, call]) => Effect.gen(function*() {
    const { api } = mockApi()
    const service = make(api)
    const rejected = new Error("No tab with id: 9.")
    member(api).mockRejectedValueOnce(rejected)
    const rejection = yield* Effect.flip(call(service))
    expect(rejection).toBeInstanceOf(ChromeWebNavigationError)
    expect(rejection).toMatchObject({ operation, cause: rejected })

    const thrown = new TypeError("Error in invocation of webNavigation")
    member(api).mockImplementationOnce(() => { throw thrown })
    const throw_ = yield* Effect.flip(call(service))
    expect(throw_).toBeInstanceOf(ChromeWebNavigationError)
    expect(throw_).toMatchObject({ operation, cause: thrown })
  }))

  it.effect("does not call Chrome until an operation runs", () => Effect.sync(() => {
    const { api } = mockApi()
    const service = make(api)
    void service.getAllFrames(7)
    void service.onCommitted(filter)
    expect(api.getAllFrames).not.toHaveBeenCalled()
    expect(api.onCommitted.addListener).not.toHaveBeenCalled()
  }))

  it.effect.each(filterableCases)(
    "streams %s, registering the filter only when given and removing the listener on end, interruption and failure",
    ([operation, run]) => run(operation)
  )

  it.effect("streams onTabReplaced without a filter and removes the listener on end and interruption", () => Effect.gen(function*() {
    const delivered = mockApi()
    yield* expectDelivery(make(delivered.api).onTabReplaced, delivered.onTabReplaced, replacement, undefined)
    const interrupted = mockApi()
    yield* expectInterruptCleanup(make(interrupted.api).onTabReplaced, interrupted.onTabReplaced)
    const failing = mockApi()
    const cause = new Error("event unavailable")
    failing.onTabReplaced.controls.failNext("addListener", cause)
    expect(yield* Effect.flip(Stream.runDrain(make(failing.api).onTabReplaced))).toMatchObject({ operation: "onTabReplaced", cause })
  }))

  it.effect("types an event that cannot even be looked up", () => Effect.gen(function*() {
    const { api } = mockApi()
    const cause = new Error("webNavigation permission missing")

    const missing: ChromeWebNavigationApi = {
      ...api,
      get onCommitted(): ChromeWebNavigationApi["onCommitted"] { throw cause },
      get onTabReplaced(): ChromeWebNavigationApi["onTabReplaced"] { throw cause }
    }

    const service = make(missing)
    expect(yield* Effect.flip(Stream.runDrain(service.onCommitted()))).toMatchObject({ operation: "onCommitted", cause })
    expect(yield* Effect.flip(Stream.runDrain(service.onTabReplaced))).toMatchObject({ operation: "onTabReplaced", cause })
  }))

  it.effect("runs one listener per consumption of the same stream value", () => Effect.gen(function*() {
    const mock = mockApi()
    const stream = make(mock.api).onCommitted(filter)
    const first = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 1)))
    const second = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 1)))
    yield* Effect.promise(() => mock.onCommitted.controls.waitForListener())
    yield* Effect.yieldNow
    expect(mock.onCommitted.api.addListener).toHaveBeenCalledTimes(2)
    mock.onCommitted.controls.emit(navigation)
    expect(yield* Fiber.join(first)).toEqual([navigation])
    expect(yield* Fiber.join(second)).toEqual([navigation])
    expect(mock.onCommitted.controls.listenerCount).toBe(0)
  }))

  it.effect("provides an injected API", () => Effect.gen(function*() {
    const { api } = mockApi()
    const frames = yield* Effect.flatMap(ChromeWebNavigation, (service) => service.getAllFrames(7)).pipe(Effect.provide(layer(api)))
    expect(frames).toEqual(Option.some([frame]))
  }))

  it.effect("fails the live layer with initialize when there is no chrome global", () => Effect.gen(function*() {
    expect("chrome" in globalThis).toBe(false)
    const error = yield* Effect.flip(ChromeWebNavigation.pipe(Effect.provide(layerLive)))
    expect(error).toBeInstanceOf(ChromeWebNavigationError)
    expect(error.operation).toBe("initialize")
    expect(error.cause).toBeInstanceOf(Error)
  }))

  it.effect("fails the live layer with initialize when chrome has no webNavigation", () => Effect.gen(function*() {
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", {})), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeWebNavigation.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
  }))

  it.effect("reads the global only when the live layer builds", () => Effect.gen(function*() {
    const { api } = mockApi()
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", { webNavigation: api })), () => Effect.sync(() => vi.unstubAllGlobals()))
    const frames = yield* Effect.flatMap(ChromeWebNavigation, (service) => service.getAllFrames(7)).pipe(Effect.provide(layerLive))
    expect(frames).toEqual(Option.some([frame]))
    expect(api.getAllFrames).toHaveBeenCalledExactlyOnceWith({ tabId: 7 })
  }))
})

describe("matchesNavigationFilter", () => {
  it.effect.each([
    ["no filter", undefined, "https://example.com/", true],
    ["an empty condition list", { url: [] }, "https://example.com/", true],
    ["an empty condition", { url: [{}] }, "https://example.com/", true],
    ["hostEquals", { url: [{ hostEquals: "example.com" }] }, "https://example.com/a", true],
    ["hostEquals on a subdomain", { url: [{ hostEquals: "example.com" }] }, "https://www.example.com/", false],
    ["hostSuffix as a plain suffix", { url: [{ hostSuffix: "example.com" }] }, "https://badexample.com/", true],
    ["hostSuffix with a dot on the bare host", { url: [{ hostSuffix: ".example.com" }] }, "https://example.com/", true],
    ["hostSuffix with a dot on another host", { url: [{ hostSuffix: ".example.com" }] }, "https://badexample.com/", false],
    ["hostPrefix", { url: [{ hostPrefix: "www" }] }, "https://www.example.com/", true],
    ["hostContains with the implicit leading dot", { url: [{ hostContains: ".example." }] }, "https://example.com/", true],
    ["urlPrefix without the default port", { url: [{ urlPrefix: "https://example.com/app" }] }, "https://example.com:443/app/x", true],
    ["urlPrefix on another port", { url: [{ urlPrefix: "https://example.com/app" }] }, "https://example.com:8443/app/x", false],
    ["urlEquals without the fragment", { url: [{ urlEquals: "https://example.com/a?b=1" }] }, "https://example.com/a?b=1#top", true],
    ["urlSuffix", { url: [{ urlSuffix: "?b=1" }] }, "https://example.com/a?b=1", true],
    ["urlContains", { url: [{ urlContains: "/checkout" }] }, "https://shop.example/checkout/1", true],
    ["pathEquals", { url: [{ pathEquals: "/a" }] }, "https://example.com/a?b=1", true],
    ["pathSuffix", { url: [{ pathSuffix: ".html" }] }, "https://example.com/index.html", true],
    ["pathContains", { url: [{ pathContains: "admin" }] }, "https://example.com/app", false],
    ["pathPrefix and queryContains together", { url: [{ pathPrefix: "/app", queryContains: "id=" }] }, "https://example.com/app?id=1", true],
    ["queryEquals", { url: [{ queryEquals: "a=1&b=2" }] }, "https://example.com/?a=1&b=2", true],
    ["queryPrefix", { url: [{ queryPrefix: "a=1" }] }, "https://example.com/?b=1", false],
    ["querySuffix", { url: [{ querySuffix: "b=2" }] }, "https://example.com/?a=1&b=2", true],
    ["every key of one condition", { url: [{ hostEquals: "example.com", pathPrefix: "/admin" }] }, "https://example.com/app", false],
    ["any of several conditions", { url: [{ hostEquals: "a.test" }, { hostEquals: "b.test" }] }, "https://b.test/", true],
    ["schemes, which webNavigation ignores", { url: [{ schemes: ["ftp"], hostEquals: "example.com" }] }, "https://example.com/", true],
    ["ports, which webNavigation ignores", { url: [{ ports: [8080], hostEquals: "example.com" }] }, "https://example.com/", true],
    ["an unparseable URL", { url: [{ urlContains: "a" }] }, "not a url", false]
  ] satisfies ReadonlyArray<readonly [string, NavigationFilter | undefined, string, boolean]>)(
    "honours %s",
    ([_name, given, url, expected]) => Effect.sync(() => {
      expect(matchesNavigationFilter(given, url)).toBe(expected)
    })
  )
})

describe("makeWebNavigation", () => {
  it.effect("emits a navigation's events in Chrome's order and updates the frame", () => Effect.sync(() => {
    const fixture = makeWebNavigation()
    const seen: Array<string> = []
    fixture.api.onBeforeNavigate.addListener((details) => { seen.push(`before ${details.url} ${details.processId}`) })
    fixture.api.onCommitted.addListener((details) => { seen.push(`committed ${details.documentId} ${details.transitionType}`) })
    fixture.api.onDOMContentLoaded.addListener((details) => { seen.push(`dom ${details.documentId}`) })
    fixture.api.onCompleted.addListener((details) => { seen.push(`completed ${details.documentId}`) })
    fixture.controls.addFrame(7, { url: "https://app.example/" })
    const committed = fixture.controls.navigate(7, "https://app.example/next", { transitionType: "typed", transitionQualifiers: ["from_address_bar"] })
    expect(seen).toEqual([
      "before https://app.example/next -1", "committed document-2 typed", "dom document-2", "completed document-2"
    ])
    expect(committed).toMatchObject({
      tabId: 7, frameId: 0, url: "https://app.example/next", documentId: "document-2", transitionQualifiers: ["from_address_bar"]
    })
    expect(fixture.controls.frame(7)).toMatchObject({ url: "https://app.example/next", documentId: "document-2" })
  }))

  it.effect("creates a missing top frame and timestamps events from a counter", () => Effect.sync(() => {
    const fixture = makeWebNavigation()
    const first = fixture.controls.navigate(3, "https://a.test/")
    const second = fixture.controls.navigate(3, "https://b.test/")
    expect(first).toMatchObject({ frameId: 0, parentFrameId: -1, frameType: "outermost_frame", transitionType: "link" })
    expect(second.timeStamp).toBeGreaterThan(first.timeStamp)
    expect(second.documentId).not.toBe(first.documentId)
  }))

  it.effect("delivers only matching URLs to filtered streams", () => Effect.gen(function*() {
    const fixture = makeWebNavigation()
    const service = yield* ChromeWebNavigation.pipe(Effect.provide(fixture.layer))
    const completed = yield* Effect.forkScoped(Stream.runCollect(Stream.take(service.onCompleted(filter), 1)))
    const everything = yield* Effect.forkScoped(Stream.runCollect(Stream.take(service.onCommitted(), 2)))
    yield* Effect.promise(() => fixture.controls.onCompleted.waitForListener())
    yield* Effect.promise(() => fixture.controls.onCommitted.waitForListener())
    expect(fixture.controls.onCompleted.filters).toEqual([filter])
    expect(fixture.controls.onCommitted.filters).toEqual([undefined])
    fixture.controls.navigate(7, "https://other.test/")
    fixture.controls.navigate(7, "https://app.example/settings")
    expect((yield* Fiber.join(completed)).map((details) => details.url)).toEqual(["https://app.example/settings"])
    expect((yield* Fiber.join(everything)).map((details) => details.url)).toEqual(["https://other.test/", "https://app.example/settings"])
    expect(fixture.controls.onCompleted.listenerCount + fixture.controls.onCommitted.listenerCount).toBe(0)
  }))

  it.effect("serves frames per tab through the service", () => Effect.gen(function*() {
    const fixture = makeWebNavigation()
    const service = yield* ChromeWebNavigation.pipe(Effect.provide(fixture.layer))
    fixture.controls.addFrame(7, { url: "https://app.example/" })
    const child = fixture.controls.addFrame(7, { frameId: 3, url: "https://widget.example/" })
    expect(child).toMatchObject({ parentFrameId: 0, frameType: "sub_frame" })
    fixture.controls.navigate(7, "https://widget.example/next", { frameId: 3 })
    const frames = Option.getOrThrow(yield* service.getAllFrames(7))
    expect(frames.map((each) => [each.frameId, each.url])).toEqual([[0, "https://app.example/"], [3, "https://widget.example/next"]])
    const byDocument = yield* service.getFrame({ documentId: fixture.controls.frame(7, 3)?.documentId ?? "" })
    expect(byDocument).toEqual(Option.some(expect.objectContaining({ url: "https://widget.example/next", parentFrameId: 0 })))
    expect(Option.getOrUndefined(byDocument)).not.toHaveProperty("frameId")
    expect(Option.getOrUndefined(byDocument)).not.toHaveProperty("processId")
    expect(Option.isNone(yield* service.getFrame({ tabId: 8, frameId: 0 }))).toBe(true)
    expect(Option.isNone(yield* service.getFrame({ tabId: 8, documentId: "document-1" }))).toBe(true)
    fixture.controls.removeTab(7)
    expect(Option.isNone(yield* service.getAllFrames(7))).toBe(true)
  }))

  it.effect("hands out copies, so callers cannot mutate its frames", () => Effect.gen(function*() {
    const fixture = makeWebNavigation()
    const service = yield* ChromeWebNavigation.pipe(Effect.provide(fixture.layer))
    fixture.controls.addFrame(7, { url: "https://app.example/" }).url = "mutated"
    const copy = fixture.controls.frame(7)

    if (copy !== undefined) copy.url = "mutated"

    for (const listed of Option.getOrElse(yield* service.getAllFrames(7), () => [])) listed.url = "mutated"
    expect(fixture.controls.frame(7)?.url).toBe("https://app.example/")
    expect(fixture.controls.frame(7, 5)).toBeUndefined()
  }))

  it.effect("fails a navigation with Chrome's -1 process id and replaces a tab", () => Effect.gen(function*() {
    const fixture = makeWebNavigation()
    const service = yield* ChromeWebNavigation.pipe(Effect.provide(fixture.layer))
    const errors = yield* Effect.forkScoped(Stream.runCollect(Stream.take(service.onErrorOccurred(), 1)))
    const replaced = yield* Effect.forkScoped(Stream.runCollect(Stream.take(service.onTabReplaced, 1)))
    yield* Effect.promise(() => fixture.controls.onErrorOccurred.waitForListener())
    yield* Effect.promise(() => fixture.controls.onTabReplaced.waitForListener())
    fixture.controls.addFrame(7, { url: "https://app.example/" })
    fixture.controls.failNavigation(7, "https://down.example/", "net::ERR_NAME_NOT_RESOLVED")
    fixture.controls.replaceTab(7, 9)
    expect(yield* Fiber.join(errors)).toEqual([
      expect.objectContaining({ url: "https://down.example/", error: "net::ERR_NAME_NOT_RESOLVED", processId: -1 })
    ])
    expect(yield* Fiber.join(replaced)).toEqual([expect.objectContaining({ replacedTabId: 7, tabId: 9 })])
    expect(Option.isNone(yield* service.getAllFrames(7))).toBe(true)
    expect(yield* service.getAllFrames(9)).toEqual(Option.some([expect.objectContaining({ url: "https://app.example/", errorOccurred: true })]))
  }))

  it.effect("updates history state and fragments without a new document", () => Effect.gen(function*() {
    const fixture = makeWebNavigation()
    const service = yield* ChromeWebNavigation.pipe(Effect.provide(fixture.layer))
    const history = yield* Effect.forkScoped(Stream.runCollect(Stream.take(service.onHistoryStateUpdated(filter), 1)))
    const fragments = yield* Effect.forkScoped(Stream.runCollect(Stream.take(service.onReferenceFragmentUpdated(), 1)))
    yield* Effect.promise(() => fixture.controls.onHistoryStateUpdated.waitForListener())
    yield* Effect.promise(() => fixture.controls.onReferenceFragmentUpdated.waitForListener())
    const { documentId } = fixture.controls.addFrame(7, { url: "https://app.example/" })
    fixture.controls.updateHistoryState(7, "https://elsewhere.test/")
    fixture.controls.updateHistoryState(7, "https://app.example/list", { transitionQualifiers: ["client_redirect"] })
    fixture.controls.updateReferenceFragment(7, "https://app.example/list#item")
    expect(yield* Fiber.join(history)).toEqual([
      expect.objectContaining({ url: "https://app.example/list", documentId, transitionQualifiers: ["client_redirect"] })
    ])
    expect(yield* Fiber.join(fragments)).toEqual([expect.objectContaining({ url: "https://app.example/list#item", documentId })])
    expect(fixture.controls.frame(7)).toMatchObject({ url: "https://app.example/list#item", documentId })
  }))

  it.effect("opens a navigation target from a source frame", () => Effect.gen(function*() {
    const fixture = makeWebNavigation()
    const service = yield* ChromeWebNavigation.pipe(Effect.provide(fixture.layer))
    const targets = yield* Effect.forkScoped(Stream.runCollect(Stream.take(service.onCreatedNavigationTarget(filter), 1)))
    yield* Effect.promise(() => fixture.controls.onCreatedNavigationTarget.waitForListener())
    fixture.controls.addFrame(7, { processId: 42 })
    fixture.controls.openNavigationTarget(7, 8, "https://other.test/")
    fixture.controls.openNavigationTarget(7, 9, "https://app.example/popup")
    expect(yield* Fiber.join(targets)).toEqual([
      expect.objectContaining({ sourceTabId: 7, sourceFrameId: 0, sourceProcessId: 42, tabId: 9, url: "https://app.example/popup" })
    ])
    expect(() => fixture.controls.openNavigationTarget(7, 10, "https://app.example/", 4)).toThrow("No frame 4 in tab 7")
  }))

  it.effect("rejects filters it cannot evaluate in the stream's error channel", () => Effect.gen(function*() {
    const fixture = makeWebNavigation()
    const service = yield* ChromeWebNavigation.pipe(Effect.provide(fixture.layer))
    const error = yield* Effect.flip(Stream.runDrain(service.onCommitted({ url: [{ urlMatches: "^https://" }] })))
    expect(error).toMatchObject({ operation: "onCommitted" })
    expect(error.cause).toBeInstanceOf(Error)
    expect(fixture.controls.onCommitted.listenerCount).toBe(0)
  }))

  it.effect("requires subframes to exist before navigating or updating them", () => Effect.sync(() => {
    const fixture = makeWebNavigation()
    expect(() => fixture.controls.navigate(7, "https://app.example/", { frameId: 2 })).toThrow("No frame 2 in tab 7")
    expect(() => fixture.controls.failNavigation(7, "https://app.example/")).toThrow("No frame 0 in tab 7")
    expect(() => fixture.controls.updateHistoryState(7, "https://app.example/")).toThrow("No frame 0 in tab 7")
  }))

  it.effect("lets overrides replace API members", () => Effect.gen(function*() {
    const cause = new Error("No tab with id: 7.")
    const fixture = makeWebNavigation({ getAllFrames: () => Promise.reject(cause) })
    const service = yield* ChromeWebNavigation.pipe(Effect.provide(fixture.layer))
    expect(yield* Effect.flip(service.getAllFrames(7))).toMatchObject({ operation: "getAllFrames", cause })
  }))
})
