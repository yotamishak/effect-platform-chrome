// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeWebRequest, ChromeWebRequestError, layer, layerLive, make } from "../src/ChromeWebRequest.js"
import type { ChromeWebRequestApi, ChromeWebRequestService, RequestFilter, WebRequestEvent } from "../src/ChromeWebRequest.js"
import * as TestEvent from "../src/testing/Event.js"

const filter: RequestFilter = { urls: ["https://api.example/*"], types: ["xmlhttprequest"] }

const base = {
  requestId: "1", url: "https://api.example/items", method: "GET", frameId: 0, parentFrameId: -1,
  tabId: 7, type: "xmlhttprequest", timeStamp: 1, frameType: "outermost_frame",
  documentLifecycle: "active", documentId: "doc", initiator: "https://app.example"
} as const

/** A webRequest event that records the extra arguments each `addListener` call received. */
const makeRequestEvent = <Details, Spec extends string>() => {
  const event = TestEvent.makeEvent<[Details]>()
  const registrations: Array<ReadonlyArray<RequestFilter | Array<Spec> | undefined>> = []

  const api: WebRequestEvent<Details, Spec> = {
    addListener: (...[listener, ...extra]) => {
      registrations.push(extra)
      event.api.addListener(listener)
    },
    removeListener: (listener) => event.api.removeListener(listener)
  }

  return { api, controls: event.controls, registrations }
}

const mockApi = () => {
  const events = {
    onBeforeRequest: makeRequestEvent<chrome.webRequest.OnBeforeRequestDetails, "requestBody" | "extraHeaders">(),
    onBeforeSendHeaders: makeRequestEvent<chrome.webRequest.OnBeforeSendHeadersDetails, "requestHeaders" | "extraHeaders">(),
    onSendHeaders: makeRequestEvent<chrome.webRequest.OnSendHeadersDetails, "requestHeaders" | "extraHeaders">(),
    onHeadersReceived: makeRequestEvent<chrome.webRequest.OnHeadersReceivedDetails, "responseHeaders" | "extraHeaders" | "securityInfo" | "securityInfoRawDer">(),
    onResponseStarted: makeRequestEvent<chrome.webRequest.OnResponseStartedDetails, "responseHeaders" | "extraHeaders">(),
    onCompleted: makeRequestEvent<chrome.webRequest.OnCompletedDetails, "responseHeaders" | "extraHeaders">(),
    onErrorOccurred: makeRequestEvent<chrome.webRequest.OnErrorOccurredDetails, "extraHeaders">(),
    onBeforeRedirect: makeRequestEvent<chrome.webRequest.OnBeforeRedirectDetails, "responseHeaders" | "extraHeaders">()
  }

  const api: ChromeWebRequestApi = {
    onBeforeRequest: events.onBeforeRequest.api,
    onBeforeSendHeaders: events.onBeforeSendHeaders.api,
    onSendHeaders: events.onSendHeaders.api,
    onHeadersReceived: events.onHeadersReceived.api,
    onResponseStarted: events.onResponseStarted.api,
    onCompleted: events.onCompleted.api,
    onErrorOccurred: events.onErrorOccurred.api,
    onBeforeRedirect: events.onBeforeRedirect.api
  }

  return { api, events }
}

const response = { ...base, statusCode: 200, statusLine: "HTTP/1.1 200 OK", fromCache: false }

describe("ChromeWebRequest", () => {
  it.effect("observes a request, passing the filter and extra-info flags only when given", () => Effect.gen(function*() {
    const mock = mockApi()
    const webRequest = make(mock.api)
    const spec: ReadonlyArray<"responseHeaders"> = ["responseHeaders"]
    const started = yield* Effect.forkScoped(Stream.runCollect(Stream.take(webRequest.onBeforeRequest(filter), 1)))
    const completed = yield* Effect.forkScoped(Stream.runCollect(Stream.take(webRequest.onCompleted(filter, spec), 1)))
    yield* Effect.promise(() => mock.events.onBeforeRequest.controls.waitForListener())
    yield* Effect.promise(() => mock.events.onCompleted.controls.waitForListener())
    const before: chrome.webRequest.OnBeforeRequestDetails = { ...base }
    const done: chrome.webRequest.OnCompletedDetails = { ...response, responseHeaders: [{ name: "content-type", value: "application/json" }] }
    mock.events.onBeforeRequest.controls.emit(before)
    mock.events.onCompleted.controls.emit(done)
    expect(yield* Fiber.join(started)).toEqual([before])
    expect(yield* Fiber.join(completed)).toEqual([done])
    expect(mock.events.onBeforeRequest.registrations).toStrictEqual([[filter]])
    expect(mock.events.onCompleted.registrations).toStrictEqual([[filter, ["responseHeaders"]]])
    expect(mock.events.onBeforeRequest.controls.listenerCount + mock.events.onCompleted.controls.listenerCount).toBe(0)
  }))

  it.effect("subscribes every lifecycle event to its own Chrome event and cleans up", () => Effect.gen(function*() {
    const mock = mockApi()
    const webRequest = make(mock.api)

    const names = [
      "onBeforeRequest", "onBeforeSendHeaders", "onSendHeaders", "onHeadersReceived",
      "onResponseStarted", "onCompleted", "onErrorOccurred", "onBeforeRedirect"
    ] as const satisfies ReadonlyArray<keyof ChromeWebRequestService>

    for (const name of names) {
      const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(webRequest[name](filter), 1)))
      const event = mock.events[name]
      yield* Effect.promise(() => event.controls.waitForListener())
      // SAFETY: every lifecycle detail type extends the shared request fields in `response`.
      event.controls.emit(response as never)
      expect(yield* Fiber.join(fiber)).toEqual([response])
      expect(event.controls.listenerCount).toBe(0)
      expect(event.registrations).toStrictEqual([[filter]])
    }
  }))

  it.effect("types a failed registration with the event name and leaves no listener", () => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("'webRequest' requires host permissions")
    mock.events.onHeadersReceived.controls.failNext("addListener", cause)
    const error = yield* Effect.flip(Stream.runDrain(make(mock.api).onHeadersReceived(filter, ["responseHeaders"])))
    expect(error).toBeInstanceOf(ChromeWebRequestError)
    expect(error).toMatchObject({ operation: "onHeadersReceived", cause })
    expect(mock.events.onHeadersReceived.controls.listenerCount).toBe(0)
  }))

  it.effect("provides an injected API and reads the global only when the live layer builds", () => Effect.gen(function*() {
    const mock = mockApi()

    const fiber = yield* Effect.forkScoped(Effect.flatMap(ChromeWebRequest, (webRequest) =>
      Stream.runCollect(Stream.take(webRequest.onErrorOccurred(filter), 1))).pipe(Effect.provide(layer(mock.api))))

    yield* Effect.promise(() => mock.events.onErrorOccurred.controls.waitForListener())
    const failed: chrome.webRequest.OnErrorOccurredDetails = { ...base, error: "net::ERR_BLOCKED_BY_CLIENT", fromCache: false }
    mock.events.onErrorOccurred.controls.emit(failed)
    expect(yield* Fiber.join(fiber)).toEqual([failed])
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", {})), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeWebRequest.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
  }))
})
