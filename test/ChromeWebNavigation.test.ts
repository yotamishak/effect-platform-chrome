// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Option, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeWebNavigation, ChromeWebNavigationError, layer, layerLive, make } from "../src/ChromeWebNavigation.js"
import type {
  ChromeWebNavigationApi, DocumentLoad, Frame, FrameInfo, Navigation, NavigationFailure, NavigationFilter,
  NavigationStart, NavigationTarget, TabReplacement
} from "../src/ChromeWebNavigation.js"
import { makeEvent } from "../src/ChromeTesting.js"
import { makeWebNavigation, matchesNavigationFilter } from "../src/testing/WebNavigation.js"

const frame: Frame = {
  frameId: 0, parentFrameId: -1, processId: 1, url: "https://app.example/", documentId: "document-1",
  documentLifecycle: "active", errorOccurred: false, frameType: "outermost_frame"
}

const start: NavigationStart = {
  tabId: 7, frameId: 0, url: "https://app.example/next", timeStamp: 0, processId: -1,
  documentLifecycle: "active", frameType: "outermost_frame", parentFrameId: -1
}

const navigation: Navigation = {
  ...start, processId: 1, transitionType: "link", transitionQualifiers: [], documentId: "document-1"
}

const load: DocumentLoad = { ...start, processId: 1, documentId: "document-1" }

const failure: NavigationFailure = { ...load, error: "net::ERR_ABORTED" }

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
      getAllFrames: vi.fn(async (_details: chrome.webNavigation.GetAllFrameDetails): Promise<Array<Frame> | null> => [frame]),
      getFrame: vi.fn(async (_details: chrome.webNavigation.GetFrameDetails): Promise<FrameInfo | null> => frame),
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

/**
 * Consumes one event, then checks the listener was registered with exactly the given
 * filter (or none) and removed again once the stream finished.
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

  it.effect("streams every event while consumed, registering without a filter", () => Effect.gen(function*() {
    const mock = mockApi()
    const service = make(mock.api)
    yield* expectDelivery(service.onBeforeNavigate, mock.onBeforeNavigate, start, undefined)
    yield* expectDelivery(service.onCommitted, mock.onCommitted, navigation, undefined)
    yield* expectDelivery(service.onDOMContentLoaded, mock.onDOMContentLoaded, load, undefined)
    yield* expectDelivery(service.onCompleted, mock.onCompleted, load, undefined)
    yield* expectDelivery(service.onErrorOccurred, mock.onErrorOccurred, failure, undefined)
    yield* expectDelivery(service.onCreatedNavigationTarget, mock.onCreatedNavigationTarget, target, undefined)
    yield* expectDelivery(service.onReferenceFragmentUpdated, mock.onReferenceFragmentUpdated, navigation, undefined)
    yield* expectDelivery(service.onHistoryStateUpdated, mock.onHistoryStateUpdated, navigation, undefined)
    yield* expectDelivery(service.onTabReplaced, mock.onTabReplaced, replacement, undefined)
  }))

  it.effect("passes a URL filter to addListener only through filtered streams", () => Effect.gen(function*() {
    const mock = mockApi()
    const filtered = make(mock.api).filtered(filter)
    yield* expectDelivery(filtered.onBeforeNavigate, mock.onBeforeNavigate, start, filter)
    yield* expectDelivery(filtered.onCommitted, mock.onCommitted, navigation, filter)
    yield* expectDelivery(filtered.onDOMContentLoaded, mock.onDOMContentLoaded, load, filter)
    yield* expectDelivery(filtered.onCompleted, mock.onCompleted, load, filter)
    yield* expectDelivery(filtered.onErrorOccurred, mock.onErrorOccurred, failure, filter)
    yield* expectDelivery(filtered.onCreatedNavigationTarget, mock.onCreatedNavigationTarget, target, filter)
    yield* expectDelivery(filtered.onReferenceFragmentUpdated, mock.onReferenceFragmentUpdated, navigation, filter)
    yield* expectDelivery(filtered.onHistoryStateUpdated, mock.onHistoryStateUpdated, navigation, filter)
  }))

  it.effect("omits the filter argument when filtered is given none", () => Effect.gen(function*() {
    const mock = mockApi()
    yield* expectDelivery(make(mock.api).filtered().onCommitted, mock.onCommitted, navigation, undefined)
  }))

  it.effect("reports failing registrations under the event's name", () => Effect.gen(function*() {
    const mock = mockApi()
    const service = make(mock.api)
    const cause = new Error("event unavailable")
    mock.onCommitted.controls.failNext("addListener", cause)
    expect(yield* Effect.flip(Stream.runDrain(service.onCommitted))).toMatchObject({ operation: "onCommitted", cause })
    mock.onCompleted.controls.failNext("addListener", cause)
    expect(yield* Effect.flip(Stream.runDrain(service.filtered(filter).onCompleted))).toMatchObject({ operation: "onCompleted", cause })
    mock.onTabReplaced.controls.failNext("addListener", cause)
    expect(yield* Effect.flip(Stream.runDrain(service.onTabReplaced))).toMatchObject({ operation: "onTabReplaced", cause })
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

describe("matchesNavigationFilter", () => {
  it.effect.each([
    ["no filter", undefined, "https://example.com/", true],
    ["an empty condition list", { url: [] }, "https://example.com/", true],
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
    ["urlContains", { url: [{ urlContains: "/checkout" }] }, "https://shop.example/checkout/1", true],
    ["pathPrefix and queryContains together", { url: [{ pathPrefix: "/app", queryContains: "id=" }] }, "https://example.com/app?id=1", true],
    ["every key of one condition", { url: [{ hostEquals: "example.com", pathPrefix: "/admin" }] }, "https://example.com/app", false],
    ["any of several conditions", { url: [{ hostEquals: "a.test" }, { hostEquals: "b.test" }] }, "https://b.test/", true],
    ["schemes, which webNavigation ignores", { url: [{ schemes: ["ftp"], hostEquals: "example.com" }] }, "https://example.com/", true],
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
    const committed = fixture.controls.navigate(7, "https://app.example/next", { transitionType: "typed" })
    expect(seen).toEqual([
      "before https://app.example/next -1", "committed document-2 typed", "dom document-2", "completed document-2"
    ])
    expect(committed).toMatchObject({ tabId: 7, frameId: 0, url: "https://app.example/next", documentId: "document-2" })
    expect(fixture.controls.frame(7)).toMatchObject({ url: "https://app.example/next", documentId: "document-2" })
  }))

  it.effect("delivers only matching URLs to filtered streams", () => Effect.gen(function*() {
    const fixture = makeWebNavigation()
    const service = yield* ChromeWebNavigation.pipe(Effect.provide(fixture.layer))
    const completed = yield* Effect.forkScoped(Stream.runCollect(Stream.take(service.filtered(filter).onCompleted, 1)))
    const everything = yield* Effect.forkScoped(Stream.runCollect(Stream.take(service.onCommitted, 2)))
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
    expect((yield* service.getAllFrames(7)).map((each) => [each.frameId, each.url])).toEqual([
      [0, "https://app.example/"], [3, "https://widget.example/next"]
    ])
    const byDocument = yield* service.getFrame({ documentId: fixture.controls.frame(7, 3)?.documentId ?? "" })
    expect(byDocument).toEqual(Option.some(expect.objectContaining({ url: "https://widget.example/next", parentFrameId: 0 })))
    expect(Option.getOrUndefined(byDocument)).not.toHaveProperty("frameId")
    expect(Option.isNone(yield* service.getFrame({ tabId: 8, frameId: 0 }))).toBe(true)
    expect(Option.isNone(yield* service.getFrame({ tabId: 8, documentId: "document-1" }))).toBe(true)
    fixture.controls.removeTab(7)
    expect(yield* service.getAllFrames(7)).toEqual([])
  }))

  it.effect("fails a navigation and replaces a tab", () => Effect.gen(function*() {
    const fixture = makeWebNavigation()
    const service = yield* ChromeWebNavigation.pipe(Effect.provide(fixture.layer))
    const errors = yield* Effect.forkScoped(Stream.runCollect(Stream.take(service.onErrorOccurred, 1)))
    const replaced = yield* Effect.forkScoped(Stream.runCollect(Stream.take(service.onTabReplaced, 1)))
    yield* Effect.promise(() => fixture.controls.onErrorOccurred.waitForListener())
    yield* Effect.promise(() => fixture.controls.onTabReplaced.waitForListener())
    fixture.controls.addFrame(7, { url: "https://app.example/" })
    fixture.controls.failNavigation(7, "https://down.example/", "net::ERR_NAME_NOT_RESOLVED")
    fixture.controls.replaceTab(7, 9)
    expect(yield* Fiber.join(errors)).toEqual([expect.objectContaining({ url: "https://down.example/", error: "net::ERR_NAME_NOT_RESOLVED" })])
    expect(yield* Fiber.join(replaced)).toEqual([expect.objectContaining({ replacedTabId: 7, tabId: 9 })])
    expect(yield* service.getAllFrames(7)).toEqual([])
    expect(yield* service.getAllFrames(9)).toEqual([expect.objectContaining({ url: "https://app.example/", errorOccurred: true })])
  }))

  it.effect("rejects filters it cannot evaluate in the stream's error channel", () => Effect.gen(function*() {
    const fixture = makeWebNavigation()
    const service = yield* ChromeWebNavigation.pipe(Effect.provide(fixture.layer))
    const error = yield* Effect.flip(Stream.runDrain(service.filtered({ url: [{ urlMatches: "^https://" }] }).onCommitted))
    expect(error).toMatchObject({ operation: "onCommitted" })
    expect(error.cause).toBeInstanceOf(Error)
    expect(fixture.controls.onCommitted.listenerCount).toBe(0)
  }))

  it.effect("requires subframes to exist before navigating them", () => Effect.sync(() => {
    const fixture = makeWebNavigation()
    expect(() => fixture.controls.navigate(7, "https://app.example/", { frameId: 2 })).toThrow("No frame 2 in tab 7")
  }))
})
