// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeWebRequest, ChromeWebRequestError, layer, layerLive, make } from "../src/ChromeWebRequest.js"
import type * as WebRequest from "../src/ChromeWebRequest.js"
import * as TestEvent from "../src/testing/Event.js"
import { blockingPermissionError, makeWebRequest, matchesRequestFilter, matchesUrlPattern, parseUrlPattern } from "../src/testing/WebRequest.js"

const filter: WebRequest.RequestFilter = { urls: ["https://api.example/*"], types: ["xmlhttprequest"] }

const base = {
  requestId: "1", url: "https://api.example/items", method: "GET", frameId: 0, parentFrameId: -1,
  tabId: 7, type: "xmlhttprequest", timeStamp: 1, frameType: "outermost_frame",
  documentLifecycle: "active", documentId: "doc", initiator: "https://app.example"
} as const

const response = { ...base, statusCode: 200, statusLine: "HTTP/1.1 200 OK", fromCache: false }

const challenge: WebRequest.AuthRequired = {
  ...base, statusCode: 401, statusLine: "HTTP/1.1 401 Unauthorized", isProxy: false, scheme: "basic",
  realm: "api", challenger: { host: "api.example", port: 443 }
}

/** One sample of each filterable event's details. */
const samples = {
  onBeforeRequest: { ...base, requestBody: { formData: { q: ["1"] } } },
  onBeforeSendHeaders: { ...base, requestHeaders: [{ name: "accept", value: "*/*" }] },
  onSendHeaders: { ...base, requestHeaders: [{ name: "accept", value: "*/*" }] },
  onHeadersReceived: { ...base, statusCode: 200, statusLine: "HTTP/1.1 200 OK" },
  onAuthRequired: challenge,
  onResponseStarted: response,
  onCompleted: { ...response, responseHeaders: [{ name: "content-type", value: "application/json" }] },
  onErrorOccurred: { ...base, error: "net::ERR_BLOCKED_BY_CLIENT", fromCache: false },
  onBeforeRedirect: { ...response, statusCode: 302, redirectUrl: "https://api.example/moved" }
} satisfies {
  onBeforeRequest: WebRequest.BeforeRequest
  onBeforeSendHeaders: WebRequest.BeforeSendHeaders
  onSendHeaders: WebRequest.SendHeaders
  onHeadersReceived: WebRequest.HeadersReceived
  onAuthRequired: WebRequest.AuthRequired
  onResponseStarted: WebRequest.ResponseStarted
  onCompleted: WebRequest.Completed
  onErrorOccurred: WebRequest.ErrorOccurred
  onBeforeRedirect: WebRequest.BeforeRedirect
}

type FilteredName = keyof typeof samples

const filteredNames = [
  "onBeforeRequest", "onBeforeSendHeaders", "onSendHeaders", "onHeadersReceived", "onAuthRequired",
  "onResponseStarted", "onCompleted", "onErrorOccurred", "onBeforeRedirect"
] as const satisfies ReadonlyArray<FilteredName>

/** Every extra-info flag each stream accepts. */
const flags = {
  onBeforeRequest: ["requestBody", "extraHeaders"],
  onBeforeSendHeaders: ["requestHeaders", "extraHeaders"],
  onSendHeaders: ["requestHeaders", "extraHeaders"],
  onHeadersReceived: ["responseHeaders", "extraHeaders", "securityInfo", "securityInfoRawDer"],
  onAuthRequired: ["responseHeaders", "extraHeaders"],
  onResponseStarted: ["responseHeaders", "extraHeaders"],
  onCompleted: ["responseHeaders", "extraHeaders"],
  onErrorOccurred: ["extraHeaders"],
  onBeforeRedirect: ["responseHeaders", "extraHeaders"]
} as const satisfies Record<FilteredName, ReadonlyArray<string>>

/** A webRequest event mock: `vi.fn` registration over `makeEvent` dispatch. */
const requestEvent = <Args extends ReadonlyArray<unknown>, Spec extends string>() => {
  const event = TestEvent.makeEvent<Args>()
  const waiting = new Set<{ readonly count: number, readonly resolve: () => void }>()
  let registered = 0

  return {
    addListener: vi.fn((listener: (...args: Args) => void, _filter: WebRequest.RequestFilter, _extraInfoSpec?: Array<Spec>) => {
      event.api.addListener(listener)
      registered++

      for (const waiter of waiting) {
        if (registered >= waiter.count) {
          waiting.delete(waiter)
          waiter.resolve()
        }
      }
    }),
    /** Resolves once `count` registrations have succeeded in total. */
    waitForRegistrations: (count: number): Promise<void> => registered >= count
      ? Promise.resolve()
      : new Promise((resolve) => { waiting.add({ count, resolve }) }),
    removeListener: vi.fn((listener: (...args: Args) => void) => { event.api.removeListener(listener) }),
    /** The underlying event, for registering without going through the mock. */
    source: event.api,
    controls: event.controls
  }
}

const actionEvent = () => {
  const event = TestEvent.makeEvent<[WebRequest.ActionIgnored]>()

  return {
    addListener: vi.fn((listener: (details: WebRequest.ActionIgnored) => void) => { event.api.addListener(listener) }),
    removeListener: vi.fn((listener: (details: WebRequest.ActionIgnored) => void) => { event.api.removeListener(listener) }),
    source: event.api,
    controls: event.controls
  }
}

const mockApi = () => ({
  handlerBehaviorChanged: vi.fn(async (): Promise<void> => {}),
  onBeforeRequest: requestEvent<[WebRequest.BeforeRequest], WebRequest.BeforeRequestSpec>(),
  onBeforeSendHeaders: requestEvent<[WebRequest.BeforeSendHeaders], WebRequest.BeforeSendHeadersSpec>(),
  onSendHeaders: requestEvent<[WebRequest.SendHeaders], WebRequest.SendHeadersSpec>(),
  onHeadersReceived: requestEvent<[WebRequest.HeadersReceived], WebRequest.HeadersReceivedSpec>(),
  onAuthRequired: requestEvent<[WebRequest.AuthRequired, WebRequest.AuthCallback?], WebRequest.AuthRequiredSpec | "asyncBlocking">(),
  onResponseStarted: requestEvent<[WebRequest.ResponseStarted], WebRequest.ResponseStartedSpec>(),
  onCompleted: requestEvent<[WebRequest.Completed], WebRequest.CompletedSpec>(),
  onErrorOccurred: requestEvent<[WebRequest.ErrorOccurred], WebRequest.ErrorOccurredSpec>(),
  onBeforeRedirect: requestEvent<[WebRequest.BeforeRedirect], WebRequest.BeforeRedirectSpec>(),
  onActionIgnored: actionEvent()
}) satisfies WebRequest.ChromeWebRequestApi

type MockApi = ReturnType<typeof mockApi>

type EventName = FilteredName | "onActionIgnored"

/** Emits a sample on any mocked event; the union of detail types defeats a direct call. */
const emitSample = (api: MockApi, name: FilteredName) => {
  // SAFETY: `samples[name]` is exactly the details type of `api[name]`.
  api[name].controls.emit(samples[name] as never)
}

/** Each event's stream over the service, filtered events with `filter` and optional flags. */
const streamOf = (
  webRequest: WebRequest.ChromeWebRequestService,
  name: EventName,
  extraInfoSpec?: ReadonlyArray<string>
): Stream.Stream<unknown, ChromeWebRequestError> => {
  if (name === "onActionIgnored") return webRequest.onActionIgnored

  // SAFETY: each name's flags come from `flags[name]`, the spec type of that stream.
  return extraInfoSpec === undefined ? webRequest[name](filter) : webRequest[name](filter, extraInfoSpec as never)
}

const eventNames: ReadonlyArray<EventName> = [...filteredNames, "onActionIgnored"]

const credentials: WebRequest.AuthCredentials = { username: "ada", password: "lovelace" }

/** Credentials carrying an extra field, as a value built elsewhere might. */
const extendedCredentials = { ...credentials, realm: "dropped" }

const blockingResponse: chrome.webRequest.BlockingResponse = {
  cancel: true, redirectUrl: "https://elsewhere.example/", requestHeaders: [{ name: "x", value: "y" }]
}

/** Registers `answer` in a fresh scope, returning the scope and the registered listener. */
const register = <R>(
  api: MockApi,
  answer: (details: WebRequest.AuthRequired) => Effect.Effect<WebRequest.AuthAnswer, never, R>,
  extraInfoSpec?: ReadonlyArray<WebRequest.AuthRequiredSpec>
) => Effect.gen(function*() {
  const scope = yield* Scope.make()
  const webRequest = make(api)

  const registration = extraInfoSpec === undefined
    ? webRequest.answerAuthRequired(filter, answer)
    : webRequest.answerAuthRequired(filter, answer, extraInfoSpec)

  yield* Scope.provide(scope)(registration)
  const listener = api.onAuthRequired.addListener.mock.calls.at(-1)?.[0]

  if (listener === undefined) throw new Error("answerAuthRequired registered no listener")

  return { scope, listener }
})

/** A callback that resolves a Deferred with Chrome's answer. */
const answerCallback = Effect.gen(function*() {
  const answered = yield* Deferred.make<chrome.webRequest.BlockingResponse>()
  const callback = vi.fn((response: chrome.webRequest.BlockingResponse) => { Deferred.doneUnsafe(answered, Exit.succeed(response)) })

  return { answered, callback }
})

describe("ChromeWebRequest streams", () => {
  it.effect.each(filteredNames)("%s delivers details and passes the filter but no extraInfoSpec when none is given", (name) =>
    Effect.gen(function*() {
      const api = mockApi()
      const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(streamOf(make(api), name), 1)))
      yield* Effect.promise(() => api[name].controls.waitForListener())
      emitSample(api, name)
      expect(yield* Fiber.join(fiber)).toStrictEqual([samples[name]])
      const [registration] = api[name].addListener.mock.calls
      expect(registration).toHaveLength(2)
      expect(registration?.[1]).toBe(filter)
      expect(api[name].removeListener.mock.calls).toStrictEqual([[registration?.[0]]])
      expect(api[name].controls.listenerCount).toBe(0)
    }))

  it.effect.each(filteredNames)("%s passes a fresh copy of the given extraInfoSpec, an empty one included", (name) =>
    Effect.gen(function*() {
      const api = mockApi()
      const webRequest = make(api)
      const spec: ReadonlyArray<string> = flags[name]

      for (const given of [spec, []]) {
        const fiber = yield* Effect.forkScoped(Stream.runDrain(streamOf(webRequest, name, given)))
        yield* Effect.promise(() => api[name].controls.waitForListener())
        const passed = api[name].addListener.mock.calls.at(-1)?.[2]
        expect(passed).toStrictEqual(given)
        expect(passed).not.toBe(given)
        yield* Fiber.interrupt(fiber)
        expect(api[name].controls.listenerCount).toBe(0)
      }
    }))

  it.effect.each(eventNames)("%s types a registration throw and removes the listener", (name) => Effect.gen(function*() {
    const api = mockApi()
    const cause = new Error("'webRequest' requires host permissions")
    api[name].controls.failNext("addListener", cause)
    const error = yield* Effect.flip(Stream.runDrain(streamOf(make(api), name)))
    expect(error).toBeInstanceOf(ChromeWebRequestError)
    expect(error).toMatchObject({ operation: name, cause })
    expect(api[name].removeListener).toHaveBeenCalledTimes(1)
    expect(api[name].controls.listenerCount).toBe(0)
  }))

  it.effect.each(eventNames)("%s removes a listener Chrome added before throwing", (name) => Effect.gen(function*() {
    const api = mockApi()
    const cause = new TypeError("Error in invocation of webRequest.addListener")
    const event = api[name]
    const original = event.addListener.getMockImplementation()
    event.addListener.mockImplementationOnce((...args: Parameters<typeof event.addListener>) => {
      // SAFETY: forwards the stream's own arguments to the mock's default registration.
      original?.(...(args as [never, never]))
      throw cause
    })
    const error = yield* Effect.flip(Stream.runDrain(streamOf(make(api), name)))
    expect(error).toMatchObject({ operation: name, cause })
    expect(event.controls.listenerCount).toBe(0)
    expect(event.removeListener).toHaveBeenCalledExactlyOnceWith(event.addListener.mock.calls[0]?.[0])
  }))

  it.effect.each(eventNames)("%s types a missing event without a cleanup defect", (name) => Effect.gen(function*() {
    const api = mockApi()
    // Simulates a Chrome build or context that leaves this event out.
    Object.defineProperty(api, name, { value: undefined })
    const exit = yield* Effect.exit(Stream.runDrain(streamOf(make(api), name)))
    expect(Exit.isFailure(exit) && !Cause.hasDies(exit.cause) && !Cause.hasInterrupts(exit.cause)).toBe(true)
    const error = yield* Effect.flip(Stream.runDrain(streamOf(make(api), name)))
    expect(error).toBeInstanceOf(ChromeWebRequestError)
    expect(error).toMatchObject({ operation: name })
    expect(String(error.cause)).toContain(`chrome.webRequest.${name} is unavailable`)
  }))

  it.effect.each(eventNames)("%s types a throwing event getter", (name) => Effect.gen(function*() {
    const api = mockApi()
    const cause = new Error("Extension context invalidated.")
    Object.defineProperty(api, name, { get: () => { throw cause } })
    expect(yield* Effect.flip(Stream.runDrain(streamOf(make(api), name)))).toMatchObject({ operation: name, cause })
  }))

  it.effect.each(eventNames)("%s removes its listener when interrupted", (name) => Effect.gen(function*() {
    const api = mockApi()
    const fiber = yield* Effect.forkChild(Stream.runDrain(streamOf(make(api), name)))
    yield* Effect.promise(() => api[name].controls.waitForListener())
    expect(api[name].controls.listenerCount).toBe(1)
    yield* Fiber.interrupt(fiber)
    expect(api[name].controls.listenerCount).toBe(0)
    expect(api[name].removeListener).toHaveBeenCalledExactlyOnceWith(api[name].addListener.mock.calls[0]?.[0])
  }))

  it.effect("keeps one listener and filter per subscription", () => Effect.gen(function*() {
    const api = mockApi()
    const webRequest = make(api)
    const images: WebRequest.RequestFilter = { urls: ["<all_urls>"], types: ["image"], tabId: 3 }
    const first = yield* Effect.forkChild(Stream.runCollect(Stream.take(webRequest.onCompleted(filter), 2)))
    yield* Effect.promise(() => api.onCompleted.waitForRegistrations(1))
    const second = yield* Effect.forkChild(Stream.runCollect(Stream.take(webRequest.onCompleted(images, ["responseHeaders"]), 1)))
    yield* Effect.promise(() => api.onCompleted.waitForRegistrations(2))
    expect(api.onCompleted.addListener.mock.calls.map(([, given, spec]) => [given, spec])).toStrictEqual([
      [filter, undefined], [images, ["responseHeaders"]]
    ])
    api.onCompleted.controls.emit(samples.onCompleted)
    expect(yield* Fiber.join(second)).toStrictEqual([samples.onCompleted])
    expect(api.onCompleted.controls.listenerCount).toBe(1)
    api.onCompleted.controls.emit(response)
    expect(yield* Fiber.join(first)).toStrictEqual([samples.onCompleted, response])
    expect(api.onCompleted.controls.listenerCount).toBe(0)
  }))

  it.effect("projects onActionIgnored to its action and request id and registers without a filter", () => Effect.gen(function*() {
    const api = mockApi()
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(make(api).onActionIgnored, 2)))
    yield* Effect.promise(() => api.onActionIgnored.controls.waitForListener())
    expect(api.onActionIgnored.addListener.mock.calls[0]).toHaveLength(1)
    const extra = { action: "redirect", requestId: "9", extra: true } as const
    api.onActionIgnored.controls.emit(extra)
    api.onActionIgnored.controls.emit({ action: "auth_credentials", requestId: "10" })
    expect(yield* Fiber.join(fiber)).toStrictEqual([
      { action: "redirect", requestId: "9" }, { action: "auth_credentials", requestId: "10" }
    ])
    expect(api.onActionIgnored.controls.listenerCount).toBe(0)
  }))

  it("registers nothing until a stream runs", () => {
    const api = mockApi()
    const webRequest = make(api)
    const streams = eventNames.map((name) => streamOf(webRequest, name))
    expect(streams).toHaveLength(10)

    for (const name of eventNames) expect(api[name].addListener).not.toHaveBeenCalled()

    expect(api.handlerBehaviorChanged).not.toHaveBeenCalled()
  })
})

describe("ChromeWebRequest.handlerBehaviorChanged", () => {
  it.effect("is a lazy Effect value calling Chrome once per run with no arguments", () => Effect.gen(function*() {
    const api = mockApi()
    const webRequest = make(api)
    expect(api.handlerBehaviorChanged).not.toHaveBeenCalled()
    yield* webRequest.handlerBehaviorChanged
    yield* webRequest.handlerBehaviorChanged
    expect(api.handlerBehaviorChanged.mock.calls).toStrictEqual([[], []])
  }))

  it.effect.each([true, false])("types a failure (synchronous throw: %s)", (synchronous) => Effect.gen(function*() {
    const api = mockApi()
    const cause = new Error("This request exceeds the MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES quota.")
    api.handlerBehaviorChanged.mockImplementationOnce(() => {
      if (synchronous) throw cause

      return Promise.reject(cause)
    })
    const error = yield* Effect.flip(make(api).handlerBehaviorChanged)
    expect(error).toBeInstanceOf(ChromeWebRequestError)
    expect(error).toMatchObject({ operation: "handlerBehaviorChanged", cause })
  }))

  it.effect("types a Chrome without the Promise form (before 116) instead of hanging", () => Effect.gen(function*() {
    const api = mockApi()
    // SAFETY: Chrome before 116 returns undefined when the callback is left out.
    api.handlerBehaviorChanged.mockImplementationOnce(() => undefined as never)
    const error = yield* Effect.flip(make(api).handlerBehaviorChanged)
    expect(error).toMatchObject({ operation: "handlerBehaviorChanged" })
    expect(error.cause).toBeInstanceOf(TypeError)
  }))
})

describe("ChromeWebRequest.answerAuthRequired", () => {
  it.effect("registers an asyncBlocking listener, adding extraInfoSpec only when given", () => Effect.gen(function*() {
    const api = mockApi()
    const first = yield* register(api, () => Effect.succeed({}))
    const second = yield* register(api, () => Effect.succeed({}), ["responseHeaders", "extraHeaders"])
    expect(api.onAuthRequired.addListener.mock.calls.map(([, given, spec]) => [given, spec])).toStrictEqual([
      [filter, ["asyncBlocking"]], [filter, ["asyncBlocking", "responseHeaders", "extraHeaders"]]
    ])
    expect(api.onAuthRequired.controls.listenerCount).toBe(2)
    yield* Scope.close(first.scope, Exit.void)
    yield* Scope.close(second.scope, Exit.void)
    expect(api.onAuthRequired.controls.listenerCount).toBe(0)
    expect(api.onAuthRequired.removeListener.mock.calls).toStrictEqual([[first.listener], [second.listener]])
  }))

  it.effect("answers with credentials, passing only the fields the answer sets", () => Effect.gen(function*() {
    const api = mockApi()
    const answer = vi.fn((_details: WebRequest.AuthRequired) => Effect.succeed({ authCredentials: credentials }))
    const { scope } = yield* register(api, answer)
    const { answered, callback } = yield* answerCallback
    api.onAuthRequired.controls.emit(challenge, callback)
    const sent = yield* Deferred.await(answered)
    expect(sent).toStrictEqual({ authCredentials: credentials })
    expect(Object.keys(sent)).toStrictEqual(["authCredentials"])
    expect(sent.authCredentials).not.toBe(credentials)
    expect(answer).toHaveBeenCalledExactlyOnceWith(challenge)
    yield* Scope.close(scope, Exit.void)
    expect(callback).toHaveBeenCalledTimes(1)
  }))

  it.effect.each<{ readonly given: WebRequest.AuthAnswer, readonly expected: WebRequest.AuthAnswer }>([
    { given: { cancel: true }, expected: { cancel: true } },
    { given: { cancel: false }, expected: { cancel: false } },
    { given: {}, expected: {} },
    { given: { authCredentials: credentials, cancel: true }, expected: { cancel: true, authCredentials: credentials } },
    // A full BlockingResponse fits AuthAnswer structurally; only the auth fields reach Chrome.
    { given: blockingResponse, expected: { cancel: true } },
    { given: { authCredentials: extendedCredentials }, expected: { authCredentials: credentials } }
  ])("answers $given as $expected", ({ given, expected }) => Effect.gen(function*() {
    const api = mockApi()
    const { scope } = yield* register(api, () => Effect.succeed(given))
    const { answered, callback } = yield* answerCallback
    api.onAuthRequired.controls.emit(challenge, callback)
    expect(yield* Deferred.await(answered)).toStrictEqual(expected)
    yield* Scope.close(scope, Exit.void)
    expect(callback).toHaveBeenCalledTimes(1)
  }))

  it.effect.each(["dies", "throws while building", "interrupts itself"] as const)(
    "takes no action when the answer %s", (failure) => Effect.gen(function*() {
      const api = mockApi()

      const answer = (_details: WebRequest.AuthRequired): Effect.Effect<WebRequest.AuthAnswer> => {
        if (failure === "throws while building") throw new Error("answer threw")

        return failure === "dies" ? Effect.die(new Error("answer died")) : Effect.interrupt
      }

      const { scope } = yield* register(api, answer)
      const { answered, callback } = yield* answerCallback
      api.onAuthRequired.controls.emit(challenge, callback)
      expect(yield* Deferred.await(answered)).toStrictEqual({})
      yield* Scope.close(scope, Exit.void)
      expect(callback).toHaveBeenCalledTimes(1)
    })
  )

  it.effect("answers each concurrent challenge independently, in completion order", () => Effect.gen(function*() {
    const api = mockApi()
    const ids = ["1", "2", "3"] as const

    const challenges = new Map<string, {
      readonly started: Deferred.Deferred<void>
      readonly gate: Deferred.Deferred<WebRequest.AuthAnswer>
      readonly done: Deferred.Deferred<void>
    }>(ids.map((id) => [id, {
      started: Deferred.makeUnsafe<void>(),
      gate: Deferred.makeUnsafe<WebRequest.AuthAnswer>(),
      done: Deferred.makeUnsafe<void>()
    }]))

    const of = (id: string) => {
      const found = challenges.get(id)

      if (found === undefined) throw new Error(`unknown challenge ${id}`)

      return found
    }

    const { scope } = yield* register(api, (details) => Deferred.succeed(of(details.requestId).started, undefined).pipe(
      Effect.andThen(Deferred.await(of(details.requestId).gate))
    ))

    const order: Array<string> = []

    const callbacks = ids.map((id) => vi.fn((_response: chrome.webRequest.BlockingResponse) => {
      order.push(id)
      Deferred.doneUnsafe(of(id).done, Exit.void)
    }))

    for (const [index, callback] of callbacks.entries()) {
      api.onAuthRequired.controls.emit({ ...challenge, requestId: ids[index] ?? "" }, callback)
    }

    yield* Effect.forEach(ids, (id) => Deferred.await(of(id).started))
    expect(order).toStrictEqual([])

    for (const [id, answer] of [["2", { cancel: true }], ["3", { authCredentials: credentials }], ["1", {}]] as const) {
      yield* Deferred.succeed(of(id).gate, answer)
      yield* Deferred.await(of(id).done)
    }

    expect(order).toStrictEqual(["2", "3", "1"])
    expect(callbacks.map((callback) => callback.mock.calls)).toStrictEqual([[[{}]], [[{ cancel: true }]], [[{ authCredentials: credentials }]]])
    yield* Scope.close(scope, Exit.void)
  }))

  it.effect("answers pending challenges with no action and removes the listener when the scope closes", () => Effect.gen(function*() {
    const api = mockApi()
    const started = yield* Deferred.make<void>()
    const interrupted = vi.fn()

    const { scope, listener } = yield* register(api, () => Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Effect.sync(interrupted))
    ))

    const { callback } = yield* answerCallback
    api.onAuthRequired.controls.emit(challenge, callback)
    yield* Deferred.await(started)
    expect(callback).not.toHaveBeenCalled()
    yield* Scope.close(scope, Exit.void)
    expect(interrupted).toHaveBeenCalledTimes(1)
    expect(callback.mock.calls).toStrictEqual([[{}]])
    expect(api.onAuthRequired.removeListener).toHaveBeenCalledExactlyOnceWith(listener)
    expect(api.onAuthRequired.controls.listenerCount).toBe(0)
  }))

  it.effect("answers a challenge Chrome delivers after removal began, without running the answer", () => Effect.gen(function*() {
    const api = mockApi()
    const answer = vi.fn((_details: WebRequest.AuthRequired) => Effect.succeed({ cancel: true }))
    const late = vi.fn((_response: chrome.webRequest.BlockingResponse) => {})
    api.onAuthRequired.removeListener.mockImplementationOnce((listener) => {
      // Chrome may still be dispatching to the listener while it is being removed.
      listener(challenge, late)
    })
    const { scope, listener } = yield* register(api, answer)
    yield* Scope.close(scope, Exit.void)
    expect(late.mock.calls).toStrictEqual([[{}]])
    expect(answer).not.toHaveBeenCalled()
    const after = vi.fn((_response: chrome.webRequest.BlockingResponse) => {})
    listener(challenge, after)
    expect(after.mock.calls).toStrictEqual([[{}]])
  }))

  it.effect("ignores a challenge without an answer callback", () => Effect.gen(function*() {
    const api = mockApi()
    const answer = vi.fn((_details: WebRequest.AuthRequired) => Effect.succeed({ cancel: true }))
    const { scope } = yield* register(api, answer)
    api.onAuthRequired.controls.emit(challenge)
    const { answered, callback } = yield* answerCallback
    api.onAuthRequired.controls.emit({ ...challenge, requestId: "2" }, callback)
    expect(yield* Deferred.await(answered)).toStrictEqual({ cancel: true })
    expect(answer.mock.calls).toStrictEqual([[{ ...challenge, requestId: "2" }]])
    yield* Scope.close(scope, Exit.void)
  }))

  it.effect("survives a throwing answer callback and still answers the other challenges at close", () => Effect.gen(function*() {
    const api = mockApi()
    const { scope } = yield* register(api, (details) => details.requestId === "1" ? Effect.succeed({ cancel: true }) : Effect.never)
    const thrown = yield* Deferred.make<void>()

    const throwing = vi.fn((_response: chrome.webRequest.BlockingResponse) => {
      Deferred.doneUnsafe(thrown, Exit.void)
      throw new Error("request already gone")
    })

    const pending = vi.fn((_response: chrome.webRequest.BlockingResponse) => { throw new Error("also gone") })
    const last = vi.fn((_response: chrome.webRequest.BlockingResponse) => {})
    api.onAuthRequired.controls.emit(challenge, throwing)
    api.onAuthRequired.controls.emit({ ...challenge, requestId: "2" }, pending)
    api.onAuthRequired.controls.emit({ ...challenge, requestId: "3" }, last)

    yield* Deferred.await(thrown)
    expect(yield* Effect.exit(Scope.close(scope, Exit.void))).toStrictEqual(Exit.void)
    expect([throwing.mock.calls, pending.mock.calls, last.mock.calls]).toStrictEqual([[[{ cancel: true }]], [[{}]], [[{}]]])
  }))

  it.effect("types a registration throw, removing the listener at once without running answers", () => Effect.gen(function*() {
    const api = mockApi()
    const cause = new TypeError("Invalid value for argument 3. Value must be one of: [responseHeaders, blocking, asyncBlocking, extraHeaders].")
    const answer = vi.fn((_details: WebRequest.AuthRequired) => Effect.succeed({}))
    api.onAuthRequired.addListener.mockImplementationOnce((listener) => {
      // A partial registration: the listener is in place when Chrome throws.
      api.onAuthRequired.source.addListener(listener)
      throw cause
    })
    const scope = yield* Scope.make()
    const error = yield* Effect.flip(make(api).answerAuthRequired(filter, answer).pipe(Scope.provide(scope)))
    expect(error).toBeInstanceOf(ChromeWebRequestError)
    expect(error).toMatchObject({ operation: "onAuthRequired", cause })
    expect(api.onAuthRequired.removeListener).toHaveBeenCalledExactlyOnceWith(api.onAuthRequired.addListener.mock.calls[0]?.[0])
    expect(api.onAuthRequired.controls.listenerCount).toBe(0)
    yield* Scope.close(scope, Exit.void)
    // Closing the scope later neither runs answers nor removes the listener a second time.
    expect(answer).not.toHaveBeenCalled()
    expect(api.onAuthRequired.removeListener).toHaveBeenCalledTimes(1)
  }))

  it.effect("types a missing onAuthRequired without registering", () => Effect.gen(function*() {
    const api = mockApi()
    // Simulates a context whose webRequest namespace leaves the event out.
    Object.defineProperty(api, "onAuthRequired", { value: undefined })
    const registration = Effect.scoped(make(api).answerAuthRequired(filter, () => Effect.succeed({})))
    const exit = yield* Effect.exit(registration)
    expect(Exit.isFailure(exit) && !Cause.hasDies(exit.cause) && !Cause.hasInterrupts(exit.cause)).toBe(true)
    const error = yield* Effect.flip(registration)
    expect(error).toBeInstanceOf(ChromeWebRequestError)
    expect(error).toMatchObject({ operation: "onAuthRequired" })
    expect(String(error.cause)).toContain("chrome.webRequest.onAuthRequired is unavailable")
  }))

  it.effect("runs answers with the caller's services and its clock", () => Effect.gen(function*() {
    class Vault extends Context.Service<Vault, { readonly lookup: (realm: string) => WebRequest.AuthCredentials }>()("test/Vault") {}

    const api = mockApi()
    const vault = Layer.succeed(Vault, Vault.of({ lookup: (realm) => ({ username: realm, password: "secret" }) }))

    const answer = (details: WebRequest.AuthRequired) => Effect.gen(function*() {
      yield* Effect.sleep("2 seconds")
      const { lookup } = yield* Vault

      return { authCredentials: lookup(details.realm ?? "none") }
    })

    const scope = yield* Scope.make()
    yield* make(api).answerAuthRequired(filter, answer).pipe(Scope.provide(scope), Effect.provide(vault))
    const { answered, callback } = yield* answerCallback
    api.onAuthRequired.controls.emit(challenge, callback)
    yield* TestClock.adjust("1 second")
    expect(callback).not.toHaveBeenCalled()
    yield* TestClock.adjust("1 second")
    expect(yield* Deferred.await(answered)).toStrictEqual({ authCredentials: { username: "api", password: "secret" } })
    yield* Scope.close(scope, Exit.void)
  }))
})

describe("ChromeWebRequest layers", () => {
  it.effect("provides an injected API", () => Effect.gen(function*() {
    const api = mockApi()

    const fiber = yield* Effect.forkScoped(Effect.flatMap(ChromeWebRequest, (webRequest) =>
      Stream.runCollect(Stream.take(webRequest.onErrorOccurred(filter), 1))).pipe(Effect.provide(layer(api))))

    yield* Effect.promise(() => api.onErrorOccurred.controls.waitForListener())
    api.onErrorOccurred.controls.emit(samples.onErrorOccurred)
    expect(yield* Fiber.join(fiber)).toStrictEqual([samples.onErrorOccurred])
  }))

  it.effect.each([
    { label: "no chrome global", global: undefined },
    { label: "chrome without webRequest", global: {} }
  ])("fails layerLive with initialize given $label", ({ global }) => Effect.gen(function*() {
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", global)), () => Effect.sync(() => vi.unstubAllGlobals()))
    const error = yield* Effect.flip(ChromeWebRequest.pipe(Effect.provide(layerLive)))
    expect(error).toBeInstanceOf(ChromeWebRequestError)
    expect(error).toMatchObject({ operation: "initialize" })
    expect(String(error.cause)).toContain("chrome.webRequest is unavailable")
  }))

  it.effect("reads the global only when layerLive builds", () => Effect.gen(function*() {
    const fixture = makeWebRequest()
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", undefined)), () => Effect.sync(() => vi.unstubAllGlobals()))
    const live = layerLive
    vi.stubGlobal("chrome", { webRequest: fixture.api })

    const fiber = yield* Effect.forkScoped(Effect.flatMap(ChromeWebRequest, (webRequest) =>
      Stream.runCollect(Stream.take(webRequest.onCompleted({ urls: ["<all_urls>"] }), 1))).pipe(Effect.provide(live)))

    yield* Effect.promise(() => fixture.controls.onCompleted.waitForListener())
    fixture.controls.request({ url: "https://example.com/" })
    const [completed] = yield* Fiber.join(fiber)
    expect(completed).toMatchObject({ url: "https://example.com/", statusCode: 200 })
    yield* Effect.flatMap(ChromeWebRequest, (webRequest) => webRequest.handlerBehaviorChanged).pipe(Effect.provide(live))
    expect(fixture.controls.handlerBehaviorChangedCalls).toBe(1)
  }))
})

describe("ChromeWebRequest.answerAuthRequired cleanup", () => {
  it.effect("answers a challenge whose answer never started when the scope closes at once", () => Effect.gen(function*() {
    const api = mockApi()
    const answer = vi.fn((_details: WebRequest.AuthRequired) => Effect.never)
    const { scope } = yield* register(api, answer)
    const callbacks = Array.from({ length: 8 }, () => vi.fn((_response: chrome.webRequest.BlockingResponse) => {}))

    // Close in the same synchronous step that delivers the challenges, before any answer fiber runs.
    yield* Effect.suspend(() => {
      for (const [index, callback] of callbacks.entries()) api.onAuthRequired.controls.emit({ ...challenge, requestId: String(index) }, callback)

      return Scope.close(scope, Exit.void)
    })

    expect(callbacks.map((callback) => callback.mock.calls)).toStrictEqual(callbacks.map(() => [[{}]]))
    expect(api.onAuthRequired.controls.listenerCount).toBe(0)
  }))

  it.effect("still answers pending challenges when removing the listener throws", () => Effect.gen(function*() {
    const api = mockApi()
    const cause = new Error("Extension context invalidated.")
    const started = yield* Deferred.make<void>()
    const { scope, listener } = yield* register(api, () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
    const { callback } = yield* answerCallback
    api.onAuthRequired.controls.emit(challenge, callback)
    yield* Deferred.await(started)
    api.onAuthRequired.controls.failNext("removeListener", cause)
    const exit = yield* Effect.exit(Scope.close(scope, Exit.void))
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(cause)
    expect(callback.mock.calls).toStrictEqual([[{}]])
    // The listener stayed registered, but it answers anything Chrome still delivers.
    const late = vi.fn((_response: chrome.webRequest.BlockingResponse) => {})
    listener(challenge, late)
    expect(late.mock.calls).toStrictEqual([[{}]])
  }))
})

describe("makeWebRequest fixture: URL patterns", () => {
  it.each([
    { pattern: "<all_urls>", url: "https://a.example/x", expected: true },
    { pattern: "<all_urls>", url: "ws://a.example/socket", expected: true },
    { pattern: "<all_urls>", url: "file:///tmp/a.txt", expected: true },
    { pattern: "<all_urls>", url: "chrome://settings/", expected: false },
    { pattern: "<all_urls>", url: "data:text/plain,hi", expected: false },
    { pattern: "<all_urls>", url: "not a url", expected: false },
    { pattern: "*://*/*", url: "http://a.example/", expected: true },
    { pattern: "*://*/*", url: "https://a.example/", expected: true },
    { pattern: "*://*/*", url: "wss://a.example/", expected: false },
    { pattern: "*://*/*", url: "ftp://a.example/", expected: false },
    { pattern: "wss://*/*", url: "wss://a.example/socket", expected: true },
    { pattern: "https://*.example.com/*", url: "https://example.com/", expected: true },
    { pattern: "https://*.example.com/*", url: "https://a.b.example.com/x", expected: true },
    { pattern: "https://*.example.com/*", url: "https://badexample.com/", expected: false },
    { pattern: "https://example.com/*", url: "https://EXAMPLE.com./a", expected: true },
    { pattern: "https://example.com/*", url: "http://example.com/", expected: false },
    { pattern: "https://example.com/*", url: "https://a.example.com/", expected: false },
    { pattern: "https://example.com:8443/*", url: "https://example.com:8443/a", expected: true },
    { pattern: "https://example.com:8443/*", url: "https://example.com/a", expected: false },
    { pattern: "https://example.com:443/*", url: "https://example.com/a", expected: true },
    { pattern: "https://example.com/*", url: "https://example.com:9000/a", expected: true },
    { pattern: "https://example.com:*/*", url: "https://example.com:9000/a", expected: true },
    { pattern: "https://example.com/api/*", url: "https://example.com/api", expected: true },
    { pattern: "https://example.com/api/*", url: "https://example.com/apix", expected: false },
    { pattern: "https://example.com/*.js", url: "https://example.com/a/b.js", expected: true },
    { pattern: "https://example.com/*.js", url: "https://example.com/a/b.js?x=1", expected: false },
    { pattern: "https://example.com/*?x=*", url: "https://example.com/a?x=1", expected: true },
    { pattern: "https://example.com/a*b*c", url: "https://example.com/abc", expected: true },
    { pattern: "https://example.com/a*b*c", url: "https://example.com/acb", expected: false },
    { pattern: "https://example.com/a*a", url: "https://example.com/a", expected: false },
    { pattern: "https://example.com/A*", url: "https://example.com/abc", expected: true },
    { pattern: "https://example.com/", url: "https://example.com/#top", expected: true },
    { pattern: "file:///*", url: "file:///tmp/a.txt", expected: true },
    { pattern: "file://host/*", url: "file:///tmp/a.txt", expected: true },
    { pattern: "https://[::1]/*", url: "https://[::1]/x", expected: true },
    { pattern: "https://[::1]:8080/*", url: "https://[::1]:8080/x", expected: true },
    { pattern: "https://[::1]:8080/*", url: "https://[::1]/x", expected: false },
    { pattern: "https://example.com", url: "https://example.com/", expected: false }
  ])("matchesUrlPattern($pattern, $url) is $expected", ({ pattern, url, expected }) => {
    expect(matchesUrlPattern(pattern, url)).toBe(expected)
  })

  it.each([
    { pattern: "example.com/*", error: "Missing scheme separator." },
    { pattern: "gopher://a.example/*", error: "Invalid scheme." },
    { pattern: "https://a.example", error: "Empty path." },
    { pattern: "https:///*", error: "Host can not be empty." },
    { pattern: "https://a.*.example/*", error: "Invalid host wildcard." },
    { pattern: "https://*foo.example/*", error: "Invalid host wildcard." },
    { pattern: "https://a.example:99999/*", error: "Invalid port." },
    { pattern: "https://a.example:x/*", error: "Invalid port." }
  ])("rejects $pattern: $error", ({ pattern, error }) => {
    expect(parseUrlPattern(pattern)).toStrictEqual({ valid: false, error })
  })

  it("parses hosts, subdomain wildcards and ports", () => {
    expect(parseUrlPattern("https://*.Example.COM.:8080/p/*")).toStrictEqual({
      valid: true,
      pattern: { all: false, scheme: "https", host: "example.com", subdomains: true, port: "8080", path: "/p/*" }
    })
    expect(parseUrlPattern("*://*/*")).toMatchObject({ valid: true, pattern: { scheme: "*", host: "", subdomains: true, port: "*" } })
  })

  it("matches request filters on URLs, types, tab and window", () => {
    const target = { url: "https://a.example/x", type: "image", tabId: 4 } as const
    expect(matchesRequestFilter({ urls: [] }, target)).toBe(true)
    expect(matchesRequestFilter({ urls: ["https://b.example/*", "https://a.example/*"] }, target)).toBe(true)
    expect(matchesRequestFilter({ urls: ["https://b.example/*"] }, target)).toBe(false)
    expect(matchesRequestFilter({ urls: [], types: [] }, target)).toBe(true)
    expect(matchesRequestFilter({ urls: [], types: ["script", "image"] }, target)).toBe(true)
    expect(matchesRequestFilter({ urls: [], types: ["script"] }, target)).toBe(false)
    expect(matchesRequestFilter({ urls: [], tabId: -1 }, target)).toBe(true)
    expect(matchesRequestFilter({ urls: [], tabId: 4 }, target)).toBe(true)
    expect(matchesRequestFilter({ urls: [], tabId: 5 }, target)).toBe(false)
    expect(matchesRequestFilter({ urls: [], windowId: 2 }, target, 2)).toBe(true)
    expect(matchesRequestFilter({ urls: [], windowId: 2 }, target, 3)).toBe(false)
    expect(matchesRequestFilter({ urls: [], windowId: 2 }, target)).toBe(false)
    expect(matchesRequestFilter({ urls: [], windowId: -1 }, target)).toBe(true)
  })
})

describe("makeWebRequest fixture: listeners", () => {
  const all: WebRequest.RequestFilter = { urls: ["<all_urls>"] }

  it("gives each listener its own copy without the fields its extraInfoSpec left out", () => {
    const { api, controls } = makeWebRequest()
    const received = new Map<string, WebRequest.HeadersReceived>()

    for (const spec of [[], ["responseHeaders"], ["securityInfo"], ["securityInfoRawDer"]] as const) {
      api.onHeadersReceived.addListener((details) => { received.set(spec.join() || "none", details) }, all, [...spec])
    }

    const security: chrome.webRequest.SecurityInfo = {
      state: "secure", certificates: [{ fingerprint: { sha256: "ab" }, rawDER: new Uint8Array([1, 2]).buffer }]
    }

    const details: WebRequest.HeadersReceived = {
      ...samples.onHeadersReceived, responseHeaders: [{ name: "server", value: "x" }], securityInfo: security
    }

    expect(controls.onHeadersReceived.emit(details)).toBe(4)
    expect(received.get("none")).toStrictEqual(samples.onHeadersReceived)
    expect(received.get("responseHeaders")).toStrictEqual({ ...samples.onHeadersReceived, responseHeaders: [{ name: "server", value: "x" }] })
    expect(received.get("securityInfo")).toStrictEqual({
      ...samples.onHeadersReceived, securityInfo: { state: "secure", certificates: [{ fingerprint: { sha256: "ab" } }] }
    })
    expect(received.get("securityInfoRawDer")?.securityInfo?.certificates[0]?.rawDER?.byteLength).toBe(2)
    received.get("responseHeaders")?.responseHeaders?.push({ name: "mutated" })
    expect(details.responseHeaders).toHaveLength(1)
    expect(details.securityInfo?.certificates[0]?.rawDER?.byteLength).toBe(2)
  })

  it("strips request bodies and request headers unless asked for", () => {
    const { api, controls } = makeWebRequest()
    const bodies: Array<WebRequest.BeforeRequest> = []
    const headers: Array<WebRequest.SendHeaders> = []
    api.onBeforeRequest.addListener((details) => { bodies.push(details) }, all)
    api.onBeforeRequest.addListener((details) => { bodies.push(details) }, all, ["requestBody"])
    api.onSendHeaders.addListener((details) => { headers.push(details) }, all, ["extraHeaders"])
    api.onSendHeaders.addListener((details) => { headers.push(details) }, all, ["requestHeaders"])
    controls.onBeforeRequest.emit(samples.onBeforeRequest)
    controls.onSendHeaders.emit(samples.onSendHeaders)
    expect(bodies.map((details) => details.requestBody)).toStrictEqual([undefined, samples.onBeforeRequest.requestBody])
    expect(headers.map((details) => details.requestHeaders)).toStrictEqual([undefined, samples.onSendHeaders.requestHeaders])
    expect("requestBody" in (bodies[0] ?? {})).toBe(false)
  })

  it("throws like Chrome's schema validation for a malformed filter or flag, recording the call", () => {
    const { api, controls } = makeWebRequest()
    const listener = () => {}

    // SAFETY: deliberately passes a flag Chrome's schema rejects for this event.
    expect(() => api.onCompleted.addListener(listener, all, ["requestBody" as never])).toThrow(TypeError)
    // SAFETY: deliberately passes a resource type Chrome's schema rejects.
    expect(() => api.onCompleted.addListener(listener, { urls: [], types: ["sound" as never] })).toThrow("Invalid resource type 'sound'.")
    expect(() => api.onCompleted.addListener(listener, { urls: [], tabId: 1.5 })).toThrow("filter.tabId must be an integer.")
    // SAFETY: deliberately passes a URL list Chrome's schema rejects.
    expect(() => api.onCompleted.addListener(listener, { urls: "https://a/*" as never })).toThrow(TypeError)
    // SAFETY: deliberately passes a flag Chrome's schema rejects for this event.
    expect(() => api.onErrorOccurred.addListener(listener, all, ["responseHeaders" as never])).toThrow(
      "Error in invocation of webRequest.onErrorOccurred.addListener: Value 'responseHeaders' is not a valid extraInfoSpec for onErrorOccurred."
    )
    expect(controls.onCompleted.listenerCount + controls.onErrorOccurred.listenerCount).toBe(0)
    expect(controls.onCompleted.calls).toHaveLength(4)
    expect(controls.consoleErrors).toStrictEqual([])
  })

  it("logs instead of registering for an invalid URL pattern or a forbidden blocking mode", () => {
    const denied = makeWebRequest({ authProvider: false })
    const listener = () => {}

    denied.api.onCompleted.addListener(listener, { urls: ["https://a.example"] })
    // SAFETY: "blocking" is a valid Chrome flag the module's narrowed types leave out.
    denied.api.onBeforeRequest.addListener(listener, all, ["blocking" as never])
    denied.api.onAuthRequired.addListener(listener, all, ["asyncBlocking"])
    expect(denied.controls.consoleErrors).toStrictEqual([
      "webRequest.onCompleted: 'https://a.example' is not a valid URL pattern.",
      `webRequest.onBeforeRequest: ${blockingPermissionError}`,
      `webRequest.onAuthRequired: ${blockingPermissionError}`
    ])
    const granted = makeWebRequest()
    // SAFETY: "blocking" is a valid Chrome flag the module's narrowed types leave out.
    granted.api.onAuthRequired.addListener(listener, all, ["asyncBlocking", "blocking" as never])
    granted.api.onAuthRequired.addListener(listener, all, ["asyncBlocking"])
    expect(granted.controls.consoleErrors).toStrictEqual(["webRequest.onAuthRequired: Only one of 'blocking' or 'asyncBlocking' may be given."])
    expect(granted.controls.onAuthRequired.registrations).toStrictEqual([{ filter: all, extraInfoSpec: ["asyncBlocking"] }])
    expect(denied.controls.onCompleted.listenerCount + denied.controls.onBeforeRequest.listenerCount).toBe(0)
  })

  it("registers a function once per call and removes all of its registrations together", () => {
    const { api, controls } = makeWebRequest()
    const received: Array<string> = []
    const listener = (details: WebRequest.Completed) => { received.push(details.url) }

    api.onCompleted.addListener(listener, { urls: ["https://a.example/*"] })
    api.onCompleted.addListener(listener, { urls: ["*://*/*"] })
    expect(controls.onCompleted.listenerCount).toBe(2)
    expect(controls.onCompleted.emit({ ...response, url: "https://a.example/1" })).toBe(2)
    expect(controls.onCompleted.emit({ ...response, url: "https://b.example/2" })).toBe(1)
    expect(received).toStrictEqual(["https://a.example/1", "https://a.example/1", "https://b.example/2"])
    api.onCompleted.removeListener(listener)
    api.onCompleted.removeListener(listener)
    expect(controls.onCompleted.listenerCount).toBe(0)
    expect(controls.onCompleted.calls).toStrictEqual([[{ urls: ["https://a.example/*"] }], [{ urls: ["*://*/*"] }]])
  })

  it("matches windows through setTabWindow", () => {
    const { api, controls } = makeWebRequest()
    const received: Array<number> = []
    api.onCompleted.addListener((details) => { received.push(details.tabId) }, { urls: [], windowId: 9 })
    controls.setTabWindow(4, 9)
    controls.onCompleted.emit({ ...response, tabId: 4 })
    controls.onCompleted.emit({ ...response, tabId: 5 })
    controls.onCompleted.emit({ ...response, tabId: -1 })
    expect(received).toStrictEqual([4])
  })

  it("collects listener exceptions and keeps dispatching", () => {
    const { api, controls } = makeWebRequest()
    const cause = new Error("listener bug")
    const received: Array<string> = []
    api.onErrorOccurred.addListener(() => { throw cause }, all)
    api.onErrorOccurred.addListener((details) => { received.push(details.error) }, all)
    expect(controls.onErrorOccurred.emit(samples.onErrorOccurred)).toBe(2)
    expect(received).toStrictEqual([samples.onErrorOccurred.error])
    expect(controls.listenerErrors).toStrictEqual([cause])
  })

  it("fails registration and removal on demand, and waits for a number of listeners", async () => {
    const { api, controls } = makeWebRequest()
    const listener = () => {}

    const cause = new Error("boom")
    controls.onSendHeaders.failNext("addListener", cause)
    expect(() => api.onSendHeaders.addListener(listener, all)).toThrow(cause)
    const two = controls.onSendHeaders.waitForListener(2)
    api.onSendHeaders.addListener(listener, all)
    controls.onSendHeaders.failNext("removeListener", cause)
    expect(() => api.onSendHeaders.removeListener(listener)).toThrow(cause)
    expect(controls.onSendHeaders.listenerCount).toBe(1)
    api.onSendHeaders.addListener(() => {}, all)
    await two
    api.onSendHeaders.removeListener(listener)
    expect(controls.onSendHeaders.listenerCount).toBe(1)
  })

  it("counts handlerBehaviorChanged, emits onActionIgnored and honours overrides", async () => {
    const handlerBehaviorChanged = vi.fn(async () => {})
    const { api, controls, layer: fixtureLayer } = makeWebRequest({}, { handlerBehaviorChanged })
    await api.handlerBehaviorChanged()
    expect(handlerBehaviorChanged).toHaveBeenCalledTimes(1)
    expect(controls.handlerBehaviorChangedCalls).toBe(0)
    const own = makeWebRequest()
    await own.api.handlerBehaviorChanged()
    await own.api.handlerBehaviorChanged()
    expect(own.controls.handlerBehaviorChangedCalls).toBe(2)
    const ignored: Array<WebRequest.ActionIgnored> = []
    api.onActionIgnored.addListener((details) => { ignored.push(details) })
    controls.onActionIgnored.emit({ action: "redirect", requestId: "1" })
    expect(ignored).toStrictEqual([{ action: "redirect", requestId: "1" }])
    await Effect.runPromise(Effect.flatMap(ChromeWebRequest, (webRequest) => webRequest.handlerBehaviorChanged).pipe(Effect.provide(fixtureLayer)))
    expect(handlerBehaviorChanged).toHaveBeenCalledTimes(2)
  })
})

describe("makeWebRequest fixture: lifecycles", () => {
  interface Seen {
    readonly requestId: string
    readonly url: string
    readonly timeStamp: number
  }

  const record = (fixture: ReturnType<typeof makeWebRequest>) => {
    const seen: Array<readonly [string, Seen]> = []
    const all: WebRequest.RequestFilter = { urls: ["<all_urls>"] }
    const { api } = fixture
    const listen = (name: string) => (details: Seen) => { seen.push([name, details]) }

    api.onBeforeRequest.addListener(listen("onBeforeRequest"), all)
    api.onBeforeSendHeaders.addListener(listen("onBeforeSendHeaders"), all)
    api.onSendHeaders.addListener(listen("onSendHeaders"), all)
    api.onHeadersReceived.addListener(listen("onHeadersReceived"), all)
    api.onResponseStarted.addListener(listen("onResponseStarted"), all)
    api.onCompleted.addListener(listen("onCompleted"), all)
    api.onErrorOccurred.addListener(listen("onErrorOccurred"), all)
    api.onBeforeRedirect.addListener(listen("onBeforeRedirect"), all)

    return seen
  }

  it("emits a successful request's events in Chrome's order with one request id", () => {
    const fixture = makeWebRequest()
    const seen = record(fixture)
    const result = fixture.controls.request({ url: "https://a.example/", tabId: 3, initiator: "https://app.example" })
    const order = ["onBeforeRequest", "onBeforeSendHeaders", "onSendHeaders", "onHeadersReceived", "onResponseStarted", "onCompleted"]
    expect(result).toStrictEqual({ requestId: "1", events: order })
    expect(seen.map(([name]) => name)).toStrictEqual(order)
    expect(new Set(seen.map(([, details]) => details.requestId))).toStrictEqual(new Set(["1"]))
    const stamps = seen.map(([, details]) => details.timeStamp)
    expect(stamps).toStrictEqual([...stamps].sort((left, right) => left - right))
    expect(new Set(stamps).size).toBe(stamps.length)
    expect(seen.at(-1)?.[1]).toMatchObject({ statusCode: 200, statusLine: "HTTP/1.1 200 OK", fromCache: false, tabId: 3, initiator: "https://app.example" })
    expect(fixture.controls.request({ url: "https://a.example/" }).requestId).toBe("2")
  })

  it("loops through redirects and fails or completes the final hop", () => {
    const fixture = makeWebRequest()
    const seen = record(fixture)

    const redirected = fixture.controls.request({
      url: "https://c.example/", redirects: [{ url: "http://a.example/" }, { url: "https://b.example/", statusCode: 301 }],
      response: { statusCode: 204, responseHeaders: [{ name: "x", value: "1" }], ip: "192.0.2.1", fromCache: true }
    })

    const hop = ["onBeforeRequest", "onBeforeSendHeaders", "onSendHeaders", "onHeadersReceived"]
    expect(redirected.events).toStrictEqual([
      ...hop, "onBeforeRedirect", ...hop, "onBeforeRedirect", ...hop, "onResponseStarted", "onCompleted"
    ])
    const redirects = seen.flatMap(([name, details]) => name === "onBeforeRedirect" ? [details] : [])
    expect(redirects).toMatchObject([
      { url: "http://a.example/", redirectUrl: "https://b.example/", statusCode: 302 },
      { url: "https://b.example/", redirectUrl: "https://c.example/", statusCode: 301 }
    ])
    expect(redirects.map((details) => "responseHeaders" in details)).toStrictEqual([false, false])
    expect(seen.at(-1)?.[1]).toMatchObject({ url: "https://c.example/", statusCode: 204, statusLine: "HTTP/1.1 204 No Content", ip: "192.0.2.1", fromCache: true })
    const failed = fixture.controls.request({ url: "https://d.example/", redirects: [{ url: "https://e.example/" }], error: "net::ERR_FAILED" })
    expect(failed.events).toStrictEqual([...hop, "onBeforeRedirect", "onBeforeRequest", "onErrorOccurred"])
    expect(seen.at(-1)?.[1]).toMatchObject({ url: "https://d.example/", error: "net::ERR_FAILED", fromCache: false })
  })

  it("reports only Chrome's file: events and includes headers only for listeners that asked", () => {
    const fixture = makeWebRequest()
    expect(fixture.controls.request({ url: "file:///tmp/a.txt" }).events).toStrictEqual(["onBeforeRequest", "onResponseStarted", "onCompleted"])
    expect(fixture.controls.request({ url: "file:///tmp/b.txt", error: "net::ERR_FILE_NOT_FOUND" }).events).toStrictEqual(["onBeforeRequest", "onErrorOccurred"])
    const headers: Array<WebRequest.BeforeSendHeaders> = []
    const bodies: Array<WebRequest.BeforeRequest> = []
    const locations: Array<WebRequest.BeforeRedirect> = []
    fixture.api.onBeforeSendHeaders.addListener((details) => { headers.push(details) }, { urls: [] }, ["requestHeaders"])
    fixture.api.onBeforeRequest.addListener((details) => { bodies.push(details) }, { urls: [] }, ["requestBody"])
    fixture.api.onBeforeRedirect.addListener((details) => { locations.push(details) }, { urls: [] }, ["responseHeaders"])
    fixture.controls.request({
      url: "https://b.example/", method: "POST", requestHeaders: [{ name: "a", value: "b" }], requestBody: { raw: [] },
      redirects: [{ url: "https://a.example/", statusCode: 307 }]
    })
    expect(headers.map((details) => details.requestHeaders)).toStrictEqual([[{ name: "a", value: "b" }], [{ name: "a", value: "b" }]])
    expect(bodies.map((details) => [details.method, details.requestBody])).toStrictEqual([["POST", { raw: [] }], ["POST", { raw: [] }]])
    expect(locations.map((details) => [details.statusLine, details.responseHeaders])).toStrictEqual([
      ["HTTP/1.1 307 Temporary Redirect", [{ name: "location", value: "https://b.example/" }]]
    ])
  })

  it.each([
    { method: "POST", statusCode: 302, after: ["GET", false] },
    { method: "POST", statusCode: 301, after: ["GET", false] },
    { method: "PUT", statusCode: 302, after: ["PUT", true] },
    { method: "PUT", statusCode: 303, after: ["GET", false] },
    { method: "HEAD", statusCode: 303, after: ["HEAD", true] },
    { method: "POST", statusCode: 308, after: ["POST", true] }
  ] as const)("follows a $statusCode redirect of $method as Fetch does", ({ method, statusCode, after }) => {
    const fixture = makeWebRequest()
    const seen: Array<readonly [string, boolean]> = []
    fixture.api.onBeforeRequest.addListener((details) => { seen.push([details.method, details.requestBody !== undefined]) }, { urls: [] }, ["requestBody"])
    fixture.controls.request({ url: "https://b.example/", method, requestBody: { raw: [] }, redirects: [{ url: "https://a.example/", statusCode }] })
    expect(seen).toStrictEqual([[method, true], after])
  })
})

describe("makeWebRequest fixture: authentication", () => {
  const all: WebRequest.RequestFilter = { urls: ["<all_urls>"] }

  it("resolves asyncBlocking answers in registration order and only notifies observers", async () => {
    const { api, controls } = makeWebRequest()
    const observed: Array<boolean> = []
    const callbacks: Array<WebRequest.AuthCallback> = []

    api.onAuthRequired.addListener((_details, asyncCallback) => {
      if (asyncCallback !== undefined) callbacks.push(asyncCallback)
    }, all, ["asyncBlocking"])

    api.onAuthRequired.addListener((_details, asyncCallback) => { observed.push(asyncCallback === undefined) }, all)
    api.onAuthRequired.addListener((_details, asyncCallback) => { asyncCallback?.({ cancel: true }) }, all, ["asyncBlocking"])
    const answers = controls.onAuthRequired.challenge(challenge)
    expect(observed).toStrictEqual([true])
    expect(controls.onAuthRequired.pendingChallenges).toBe(1)
    callbacks[0]?.({ authCredentials: credentials })
    callbacks[0]?.({ cancel: true })
    expect(await answers).toStrictEqual([{ authCredentials: credentials }, { cancel: true }])
    expect(controls.onAuthRequired.pendingChallenges).toBe(0)
  })

  it("settles a removed listener's pending challenges and a throwing listener's with no action", async () => {
    const { api, controls } = makeWebRequest()
    const cause = new Error("auth bug")
    const parked = () => {}

    api.onAuthRequired.addListener(parked, all, ["asyncBlocking"])
    api.onAuthRequired.addListener(() => { throw cause }, all, ["asyncBlocking"])
    const answers = controls.onAuthRequired.challenge(challenge)
    expect(controls.onAuthRequired.pendingChallenges).toBe(1)
    api.onAuthRequired.removeListener(parked)
    expect(await answers).toStrictEqual([{}, {}])
    expect(controls.listenerErrors).toStrictEqual([cause])
    expect(await makeWebRequest().controls.onAuthRequired.challenge(challenge)).toStrictEqual([])
  })

  it.effect("answers through the service and never calls answers without webRequestAuthProvider", () => Effect.gen(function*() {
    const granted = makeWebRequest()
    const answer = vi.fn((_details: WebRequest.AuthRequired) => Effect.succeed({ authCredentials: credentials }))

    yield* Effect.scoped(Effect.gen(function*() {
      yield* make(granted.api).answerAuthRequired({ urls: ["https://api.example/*"] }, answer, ["responseHeaders"])
      expect(granted.controls.onAuthRequired.registrations).toStrictEqual([
        { filter: { urls: ["https://api.example/*"] }, extraInfoSpec: ["asyncBlocking", "responseHeaders"] }
      ])
      expect(yield* Effect.promise(() => granted.controls.onAuthRequired.challenge(challenge))).toStrictEqual([{ authCredentials: credentials }])
      const elsewhere = { ...challenge, url: "https://other.example/" }
      expect(yield* Effect.promise(() => granted.controls.onAuthRequired.challenge(elsewhere))).toStrictEqual([])
    }))

    expect(granted.controls.onAuthRequired.listenerCount).toBe(0)
    const denied = makeWebRequest({ authProvider: false })

    yield* Effect.scoped(Effect.gen(function*() {
      yield* make(denied.api).answerAuthRequired(all, answer)
      expect(yield* Effect.promise(() => denied.controls.onAuthRequired.challenge(challenge))).toStrictEqual([])
    }))

    expect(denied.controls.consoleErrors).toStrictEqual([`webRequest.onAuthRequired: ${blockingPermissionError}`])
    expect(answer).toHaveBeenCalledTimes(1)
  }))

  it.effect("delivers fixture lifecycles to service streams, filtered and stripped per subscription", () => Effect.gen(function*() {
    const fixture = makeWebRequest()
    const webRequest = make(fixture.api)
    const tab: WebRequest.RequestFilter = { urls: ["https://*.example/*"], tabId: 2 }
    const withHeaders = yield* Effect.forkScoped(Stream.runCollect(Stream.take(webRequest.onCompleted(tab, ["responseHeaders"]), 1)))
    const plain = yield* Effect.forkScoped(Stream.runCollect(Stream.take(webRequest.onCompleted({ urls: [] }), 2)))
    yield* Effect.promise(() => fixture.controls.onCompleted.waitForListener(2))
    const headers = [{ name: "content-type", value: "text/html" }]
    fixture.controls.request({ url: "https://a.example/", tabId: 1, response: { responseHeaders: headers } })
    fixture.controls.request({ url: "https://b.example/", tabId: 2, response: { responseHeaders: headers } })
    const [first] = yield* Fiber.join(withHeaders)
    expect(first).toMatchObject({ url: "https://b.example/", responseHeaders: headers })
    const both = yield* Fiber.join(plain)
    expect(both.map((details) => [details.url, "responseHeaders" in details])).toStrictEqual([
      ["https://a.example/", false], ["https://b.example/", false]
    ])
    expect(fixture.controls.onCompleted.listenerCount).toBe(0)
  }))
})
