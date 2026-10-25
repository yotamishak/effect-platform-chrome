// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Cause, Effect, Exit, Fiber, Scope, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeTabCapture, ChromeTabCaptureError, layer, layerLive, make } from "../src/ChromeTabCapture.js"
import type { CaptureInfo, CaptureOptions, ChromeTabCaptureApi, MediaStreamOptions } from "../src/ChromeTabCapture.js"
import { makeEvent } from "../src/ChromeTesting.js"
import { asMediaStream, makeCaptureStream, makeTabCapture, tabCaptureErrors } from "../src/testing/TabCapture.js"

const active: CaptureInfo = { tabId: 7, status: "active", fullscreen: false }

type CaptureCallback = (stream: MediaStream | null) => void

const mockApi = () => {
  const onStatusChanged = makeEvent<[CaptureInfo]>()
  const callbacks: Array<CaptureCallback> = []
  const waiting: Array<() => void> = []
  let lastError: chrome.runtime.LastError | undefined

  const api = {
    getMediaStreamId: vi.fn(async (_options?: MediaStreamOptions) => "stream-id"),
    getCapturedTabs: vi.fn(async (): Promise<Array<CaptureInfo>> => [active]),
    onStatusChanged: onStatusChanged.api,
    capture: vi.fn((_options: CaptureOptions, callback: CaptureCallback) => {
      callbacks.push(callback)

      for (const wake of waiting.splice(0)) wake()
    }),
    get lastError() { return lastError }
  } satisfies ChromeTabCaptureApi

  return {
    api,
    onStatusChanged: onStatusChanged.controls,
    /** Resolves once Chrome's `capture` has been called `count` times in all. */
    captureCalled: (count = 1): Promise<void> => new Promise((resolve) => {
      const check = () => {
        if (callbacks.length >= count) resolve()
        else waiting.push(check)
      }

      check()
    }),
    /** Chrome calls back the `index`th capture, with `lastError` set only while it runs. */
    respond: (index: number, stream: MediaStream | null, error?: chrome.runtime.LastError) => {
      const callback = callbacks[index]

      if (callback === undefined) throw new Error(`capture ${index} was never called`)

      lastError = error

      try { callback(stream) } finally { lastError = undefined }
    }
  }
}

const streamOf = (id: string) => {
  const stream = makeCaptureStream(id, { audio: true, video: true })

  return { stream, media: asMediaStream(stream) }
}

interface ChromeGlobal {
  readonly tabCapture?: Partial<ChromeTabCaptureApi>
  readonly runtime?: { readonly lastError?: chrome.runtime.LastError | undefined }
}

const stubChrome = (value: ChromeGlobal) =>
  Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", value)), () => Effect.sync(() => vi.unstubAllGlobals()))

describe("ChromeTabCapture calls", () => {
  it.effect("creates stream ids, passing options to Chrome only when given", () => Effect.gen(function*() {
    const { api } = mockApi()
    const capture = make(api)
    const options: MediaStreamOptions = { targetTabId: 7, consumerTabId: 9 }
    expect(yield* capture.getMediaStreamId()).toBe("stream-id")
    expect(yield* capture.getMediaStreamId(options)).toBe("stream-id")
    expect(yield* capture.getMediaStreamId({})).toBe("stream-id")
    expect(api.getMediaStreamId.mock.calls).toEqual([[], [options], [{}]])
    expect(api.getMediaStreamId.mock.calls[1]?.[0]).toBe(options)
  }))

  it.effect("lists captured tabs, keeping an empty list a list, and calls Chrome on every run", () => Effect.gen(function*() {
    const { api } = mockApi()
    const capture = make(api)
    expect(yield* capture.getCapturedTabs).toEqual([active])
    api.getCapturedTabs.mockResolvedValueOnce([])
    expect(yield* capture.getCapturedTabs).toEqual([])
    expect(api.getCapturedTabs).toHaveBeenCalledTimes(2)
  }))

  it.effect("is lazy: building an operation calls nothing until it runs", () => Effect.gen(function*() {
    const { api } = mockApi()
    const capture = make(api)
    const id = capture.getMediaStreamId({ targetTabId: 7 })
    const stream = capture.capture({ video: true })
    expect(api.getMediaStreamId).not.toHaveBeenCalled()
    expect(api.getCapturedTabs).not.toHaveBeenCalled()
    expect(api.capture).not.toHaveBeenCalled()
    yield* id
    yield* id
    expect(api.getMediaStreamId).toHaveBeenCalledTimes(2)
    expect(stream).toBeDefined()
  }))

  it.effect.each([
    ["getMediaStreamId", "rejects"],
    ["getMediaStreamId", "throws"],
    ["getCapturedTabs", "rejects"],
    ["getCapturedTabs", "throws"]
  ] as const)("types %s when Chrome %s", ([operation, how]) => Effect.gen(function*() {
    const { api } = mockApi()
    const capture = make(api)
    const cause = new Error(`${operation} ${how}`)

    if (operation === "getMediaStreamId") {
      if (how === "rejects") api.getMediaStreamId.mockRejectedValueOnce(cause)
      else api.getMediaStreamId.mockImplementationOnce(() => { throw cause })
    } else if (how === "rejects") {
      api.getCapturedTabs.mockRejectedValueOnce(cause)
    } else {
      api.getCapturedTabs.mockImplementationOnce(() => { throw cause })
    }

    const error = yield* (operation === "getMediaStreamId"
      ? Effect.flip(capture.getMediaStreamId())
      : Effect.flip(capture.getCapturedTabs))

    expect(error).toBeInstanceOf(ChromeTabCaptureError)
    expect(error.operation).toBe(operation)
    expect(error.cause).toBe(cause)
  }))

  it.effect("keeps a non-Error rejection as the cause", () => Effect.gen(function*() {
    const { api } = mockApi()
    api.getMediaStreamId.mockRejectedValueOnce("busy")
    api.getCapturedTabs.mockRejectedValueOnce(undefined)
    expect(yield* Effect.flip(make(api).getMediaStreamId())).toMatchObject({ operation: "getMediaStreamId", cause: "busy" })
    const error = yield* Effect.flip(make(api).getCapturedTabs)
    expect(error.operation).toBe("getCapturedTabs")
    expect(error.cause).toBeUndefined()
  }))

  it.effect("calls Chrome members as methods of the namespace they belong to", () => Effect.gen(function*() {
    const events = makeEvent<[CaptureInfo]>()

    class Namespace implements ChromeTabCaptureApi {
      readonly prefix = "bound"
      readonly onStatusChanged = events.api
      readonly lastError = undefined
      readonly calls: Array<string> = []
      getMediaStreamId(options?: MediaStreamOptions) { return Promise.resolve(`${this.prefix}:${options?.targetTabId ?? "active"}`) }
      getCapturedTabs() { return Promise.resolve([{ ...active, tabId: this.prefix.length }]) }
      capture(_options: CaptureOptions, callback: CaptureCallback) {
        this.calls.push(this.prefix)
        callback(streamOf("bound").media)
      }
    }

    const namespace = new Namespace()
    const capture = make(namespace)
    expect(yield* capture.getMediaStreamId()).toBe("bound:active")
    expect(yield* capture.getMediaStreamId({ targetTabId: 3 })).toBe("bound:3")
    expect(yield* capture.getCapturedTabs).toEqual([{ ...active, tabId: 5 }])
    expect((yield* Effect.scoped(capture.capture({ video: true }))).id).toBe("bound")
    expect(namespace.calls).toEqual(["bound"])
  }))
})

describe("ChromeTabCapture.capture", () => {
  it.effect("acquires the stream Chrome delivers and stops every track when the scope closes", () => Effect.gen(function*() {
    const mock = mockApi()
    const capture = make(mock.api)
    const options: CaptureOptions = { audio: true, video: true, videoConstraints: { mandatory: { maxWidth: 1920 } } }
    const { stream, media } = streamOf("one")
    const scope = yield* Scope.make()
    const fiber = yield* Effect.forkChild(Scope.provide(capture.capture(options), scope))
    yield* Effect.promise(() => mock.captureCalled())
    expect(mock.api.capture.mock.calls[0]?.[0]).toBe(options)
    mock.respond(0, media)
    expect(yield* Fiber.join(fiber)).toBe(media)
    expect(stream.getTracks().map((track) => track.readyState)).toEqual(["live", "live"])
    yield* Scope.close(scope, Exit.void)
    expect(stream.getTracks().map((track) => track.readyState)).toEqual(["ended", "ended"])
    expect(stream.active).toBe(false)
  }))

  it.effect("tolerates tracks the caller already stopped, and a stream without tracks", () => Effect.gen(function*() {
    const mock = mockApi()
    const capture = make(mock.api)
    const { stream, media } = streamOf("early")
    const empty = makeCaptureStream("empty", {})
    const scope = yield* Scope.make()
    const first = yield* Effect.forkChild(Scope.provide(capture.capture({ video: true }), scope))
    yield* Effect.promise(() => mock.captureCalled())
    mock.respond(0, media)
    yield* Fiber.join(first)
    stream.getAudioTracks()[0]?.stop()
    const second = yield* Effect.forkChild(Scope.provide(capture.capture({ video: true }), scope))
    yield* Effect.promise(() => mock.captureCalled(2))
    mock.respond(1, asMediaStream(empty))
    expect((yield* Fiber.join(second)).id).toBe("empty")
    yield* Scope.close(scope, Exit.void)
    expect(stream.active).toBe(false)
  }))

  it.effect("resolves a callback that runs before capture returns", () => Effect.gen(function*() {
    const { stream, media } = streamOf("sync")

    const api: ChromeTabCaptureApi = {
      ...mockApi().api,
      capture: (_options, callback) => callback(media)
    }

    yield* Effect.scoped(Effect.gen(function*() {
      expect(yield* make(api).capture({ audio: true })).toBe(media)
      expect(stream.active).toBe(true)
    }))
    expect(stream.active).toBe(false)
  }))

  it.effect("fails with the lastError Chrome sets while the callback runs", () => Effect.gen(function*() {
    const mock = mockApi()
    const fiber = yield* Effect.forkChild(Effect.scoped(make(mock.api).capture({ video: true })))
    yield* Effect.promise(() => mock.captureCalled())
    const lastError = { message: tabCaptureErrors.grant }
    mock.respond(0, null, lastError)
    const error = yield* Effect.flip(Fiber.join(fiber))
    expect(error).toBeInstanceOf(ChromeTabCaptureError)
    expect(error.operation).toBe("capture")
    expect(error.cause).toBe(lastError)
  }))

  it.effect("stops a stream delivered together with a lastError and fails", () => Effect.gen(function*() {
    const mock = mockApi()
    const { stream, media } = streamOf("errored")
    const scope = yield* Scope.make()
    const fiber = yield* Effect.forkChild(Scope.provide(make(mock.api).capture({ video: true }), scope))
    yield* Effect.promise(() => mock.captureCalled())
    mock.respond(0, media, { message: "Capture failed" })
    expect(yield* Effect.flip(Fiber.join(fiber))).toMatchObject({ operation: "capture", cause: { message: "Capture failed" } })
    expect(stream.active).toBe(false)
    yield* Scope.close(scope, Exit.void)
  }))

  it.effect("fails when Chrome delivers no stream without a lastError", () => Effect.gen(function*() {
    const mock = mockApi()
    const fiber = yield* Effect.forkChild(Effect.scoped(make(mock.api).capture({ video: true })))
    yield* Effect.promise(() => mock.captureCalled())
    mock.respond(0, null)
    expect(yield* Effect.flip(Fiber.join(fiber))).toMatchObject({
      operation: "capture", cause: new Error("chrome.tabCapture.capture delivered no stream")
    })
  }))

  it.effect("types a synchronous throw from capture", () => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new TypeError("Error in invocation of tabCapture.capture")
    mock.api.capture.mockImplementationOnce(() => { throw cause })
    expect(yield* Effect.flip(Effect.scoped(make(mock.api).capture({ video: true })))).toMatchObject({ operation: "capture", cause })
  }))

  it.effect.each([
    ["absent", {}],
    ["undefined", { capture: undefined }]
  ] as const)("fails with the typed error where capture is %s, as in a service worker", ([_label, patch]) => Effect.gen(function*() {
    const { capture: _capture, ...rest } = mockApi().api
    const api: ChromeTabCaptureApi = { ...rest, ...patch }
    const error = yield* Effect.flip(Effect.scoped(make(api).capture({ video: true })))
    expect(error).toBeInstanceOf(ChromeTabCaptureError)
    expect(error.operation).toBe("capture")
    expect(error.cause).toEqual(new Error("chrome.tabCapture.capture is unavailable in this context; it is foreground only"))
  }))

  it.effect("stops a stream that arrives after the wait was interrupted, without waiting for the scope", () => Effect.gen(function*() {
    const mock = mockApi()
    const { stream, media } = streamOf("late")
    const scope = yield* Scope.make()
    const fiber = yield* Effect.forkChild(Scope.provide(make(mock.api).capture({ video: true }), scope))
    yield* Effect.promise(() => mock.captureCalled())
    yield* Fiber.interrupt(fiber)
    expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
    mock.respond(0, media)
    expect(stream.active).toBe(false)
    yield* Scope.close(scope, Exit.void)
  }))

  it.effect("a late failure after interruption is ignored", () => Effect.gen(function*() {
    const mock = mockApi()
    const fiber = yield* Effect.forkChild(Effect.scoped(make(mock.api).capture({ video: true })))
    yield* Effect.promise(() => mock.captureCalled())
    yield* Fiber.interrupt(fiber)
    mock.respond(0, null, { message: "too late" })
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  }))

  it.effect("stops a stream that arrives after its scope closed, and fails the waiting fiber", () => Effect.gen(function*() {
    const mock = mockApi()
    const { stream, media } = streamOf("orphan")
    const scope = yield* Scope.make()
    const fiber = yield* Effect.forkChild(Scope.provide(make(mock.api).capture({ video: true }), scope))
    yield* Effect.promise(() => mock.captureCalled())
    yield* Scope.close(scope, Exit.void)
    mock.respond(0, media)
    expect(stream.active).toBe(false)
    expect(yield* Effect.flip(Fiber.join(fiber))).toMatchObject({
      operation: "capture", cause: new Error("The capture's scope closed before Chrome delivered the stream")
    })
  }))

  it.effect("never starts a Chrome capture in a scope that is already closed", () => Effect.gen(function*() {
    const mock = mockApi()
    const scope = yield* Scope.make()
    yield* Scope.close(scope, Exit.void)
    const error = yield* Effect.flip(Scope.provide(make(mock.api).capture({ video: true }), scope))
    expect(error).toMatchObject({
      operation: "capture", cause: new Error("The capture's scope closed before Chrome delivered the stream")
    })
    expect(mock.api.capture).not.toHaveBeenCalled()
  }))

  it.effect("a failed or interrupted capture leaves no finalizer behind in a long-lived scope", () => Effect.gen(function*() {
    const mock = mockApi()
    const capture = make(mock.api)
    const scope = yield* Scope.make()

    const attempt = (index: number, settle: () => void) => Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(Effect.exit(Scope.provide(capture.capture({ video: true }), scope)))
      yield* Effect.promise(() => mock.captureCalled(index + 1))
      settle()

      return yield* Fiber.join(fiber)
    })

    // A retry loop in one scope: lastError, a null stream, a stream with lastError, a throw
    // (which never reaches a callback), then an interruption.
    yield* attempt(0, () => mock.respond(0, null, { message: tabCaptureErrors.sameTab }))
    yield* attempt(1, () => mock.respond(1, null))
    const errored = streamOf("errored")
    yield* attempt(2, () => mock.respond(2, errored.media, { message: "Capture failed" }))
    expect(errored.stream.active).toBe(false)
    mock.api.capture.mockImplementationOnce(() => { throw new TypeError("invalid options") })
    expect(Exit.isFailure(yield* Effect.exit(Scope.provide(capture.capture({ video: true }), scope)))).toBe(true)
    const interrupted = yield* Effect.forkChild(Scope.provide(capture.capture({ video: true }), scope))
    yield* Effect.promise(() => mock.captureCalled(4))
    yield* Fiber.interrupt(interrupted)
    expect(scope.state._tag).toBe("Empty")

    // A successful capture still owns its stream until the scope closes.
    const kept = streamOf("kept")
    expect(Exit.isSuccess(yield* attempt(4, () => mock.respond(4, kept.media)))).toBe(true)
    expect(scope.state._tag).toBe("Open")
    const late = streamOf("late")
    mock.respond(3, late.media)
    expect(late.stream.active).toBe(false)
    yield* Scope.close(scope, Exit.void)
    expect(kept.stream.active).toBe(false)
  }))

  it.effect("ignores a repeated callback, stopping any second stream at once", () => Effect.gen(function*() {
    const mock = mockApi()
    const first = streamOf("first")
    const second = streamOf("second")
    const scope = yield* Scope.make()
    const fiber = yield* Effect.forkChild(Scope.provide(make(mock.api).capture({ video: true }), scope))
    yield* Effect.promise(() => mock.captureCalled())
    mock.respond(0, first.media)
    mock.respond(0, second.media)
    mock.respond(0, null, { message: "ignored" })
    expect(yield* Fiber.join(fiber)).toBe(first.media)
    expect(first.stream.active).toBe(true)
    expect(second.stream.active).toBe(false)
    yield* Scope.close(scope, Exit.void)
    expect(first.stream.active).toBe(false)
  }))

  it.effect("each run is an independent capture with its own stream", () => Effect.gen(function*() {
    const mock = mockApi()
    const effect = make(mock.api).capture({ video: true })
    const a = streamOf("a")
    const b = streamOf("b")
    const outer = yield* Scope.make()
    const inner = yield* Scope.make()
    const first = yield* Effect.forkChild(Scope.provide(effect, outer))
    const second = yield* Effect.forkChild(Scope.provide(effect, inner))
    yield* Effect.promise(() => mock.captureCalled(2))
    mock.respond(1, b.media)
    mock.respond(0, a.media)
    expect(yield* Fiber.join(first)).toBe(a.media)
    expect(yield* Fiber.join(second)).toBe(b.media)
    yield* Scope.close(inner, Exit.void)
    expect([a.stream.active, b.stream.active]).toEqual([true, false])
    yield* Scope.close(outer, Exit.void)
    expect(a.stream.active).toBe(false)
  }))
})

describe("ChromeTabCapture.onStatusChanged", () => {
  it.effect("streams status changes in order while consumed and removes its listener", () => Effect.gen(function*() {
    const mock = mockApi()
    mock.onStatusChanged.emit({ ...active, status: "pending" })
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(make(mock.api).onStatusChanged, 3)))
    yield* Effect.promise(() => mock.onStatusChanged.waitForListener())
    const infos: Array<CaptureInfo> = [active, { ...active, fullscreen: true }, { ...active, status: "stopped" }]

    for (const info of infos) mock.onStatusChanged.emit(info)

    const delivered = yield* Fiber.join(fiber)
    expect(delivered).toEqual(infos)
    expect(delivered[0]).toBe(infos[0])
    expect(mock.onStatusChanged.listenerCount).toBe(0)
  }))

  it.effect("gives each consumption its own listener, removed on interruption", () => Effect.gen(function*() {
    const mock = mockApi()
    const added: Array<() => void> = []

    const api: ChromeTabCaptureApi = {
      ...mock.api,
      onStatusChanged: {
        addListener: (listener) => {
          mock.api.onStatusChanged.addListener(listener)

          for (const wake of added.splice(0)) wake()
        },
        removeListener: (listener) => mock.api.onStatusChanged.removeListener(listener)
      }
    }

    const listeners = (count: number) => Effect.promise(() => new Promise<void>((resolve) => {
      const check = () => {
        if (mock.onStatusChanged.listenerCount >= count) resolve()
        else added.push(check)
      }

      check()
    }))

    const changes = make(api).onStatusChanged
    const first = yield* Effect.forkChild(Stream.runCollect(Stream.take(changes, 1)))
    yield* listeners(1)
    const second = yield* Effect.forkChild(Stream.runDrain(changes))
    yield* listeners(2)
    expect(mock.onStatusChanged.listenerCount).toBe(2)
    mock.onStatusChanged.emit(active)
    expect(yield* Fiber.join(first)).toEqual([active])
    expect(mock.onStatusChanged.listenerCount).toBe(1)
    yield* Fiber.interrupt(second)
    expect(mock.onStatusChanged.listenerCount).toBe(0)
  }))

  it.effect("types a failed registration and a failed event lookup as onStatusChanged", () => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("event unavailable")
    mock.onStatusChanged.failNext("addListener", cause)
    const error = yield* Effect.flip(Stream.runDrain(make(mock.api).onStatusChanged))
    expect(error).toBeInstanceOf(ChromeTabCaptureError)
    expect(error).toMatchObject({ operation: "onStatusChanged", cause })
    expect(mock.onStatusChanged.listenerCount).toBe(0)
    const lookup = new Error("no tabCapture events here")

    const api: ChromeTabCaptureApi = {
      ...mock.api,
      get onStatusChanged(): ChromeTabCaptureApi["onStatusChanged"] { throw lookup }
    }

    expect(yield* Effect.flip(Stream.runDrain(make(api).onStatusChanged))).toMatchObject({ operation: "onStatusChanged", cause: lookup })
  }))

  it.effect("reads the event only when a consumption starts", () => Effect.gen(function*() {
    const mock = mockApi()
    const read = vi.fn(() => mock.api.onStatusChanged)
    const api: ChromeTabCaptureApi = { ...mock.api, get onStatusChanged() { return read() } }
    const changes = make(api).onStatusChanged
    expect(read).not.toHaveBeenCalled()
    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(changes, 1)))
    yield* Effect.promise(() => mock.onStatusChanged.waitForListener())
    expect(read).toHaveBeenCalledTimes(1)
    mock.onStatusChanged.emit(active)
    yield* Fiber.join(fiber)
  }))
})

describe("ChromeTabCapture layers", () => {
  it.effect("provides an injected API", () => Effect.gen(function*() {
    const { api } = mockApi()
    expect(yield* Effect.flatMap(ChromeTabCapture, (service) => service.getCapturedTabs).pipe(Effect.provide(layer(api)))).toEqual([active])
  }))

  it.effect.each([
    ["without chrome", undefined],
    ["without chrome.tabCapture", { runtime: {} }]
  ] as const)("layerLive fails with initialize %s", ([_label, global]) => Effect.gen(function*() {
    yield* stubChrome(global ?? {})

    if (global === undefined) vi.stubGlobal("chrome", undefined)

    const error = yield* Effect.flip(ChromeTabCapture.pipe(Effect.provide(layerLive)))
    expect(error).toBeInstanceOf(ChromeTabCaptureError)
    expect(error.operation).toBe("initialize")
    expect(error.cause).toEqual(new Error("chrome.tabCapture is unavailable in this context"))
  }))

  it.effect("layerLive reads the global only when it builds and binds the namespace's members", () => Effect.gen(function*() {
    const mock = mockApi()
    const { capture: _capture, ...promised } = mock.api
    // The service-worker shape: no foreground-only capture.
    yield* stubChrome({ tabCapture: promised, runtime: {} })
    const service = yield* ChromeTabCapture.pipe(Effect.provide(layerLive))
    expect(yield* service.getMediaStreamId()).toBe("stream-id")
    expect(yield* service.getMediaStreamId({ targetTabId: 7 })).toBe("stream-id")
    expect(mock.api.getMediaStreamId.mock.calls).toEqual([[], [{ targetTabId: 7 }]])
    expect(mock.api.getMediaStreamId.mock.contexts[0]).toBe(promised)
    expect(yield* service.getCapturedTabs).toEqual([active])
    expect(mock.api.getCapturedTabs.mock.contexts[0]).toBe(promised)
    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(service.onStatusChanged, 1)))
    yield* Effect.promise(() => mock.onStatusChanged.waitForListener())
    mock.onStatusChanged.emit(active)
    expect(yield* Fiber.join(fiber)).toEqual([active])
    expect(yield* Effect.flip(Effect.scoped(service.capture({ video: true })))).toMatchObject({ operation: "capture" })
  }))

  it.effect("layerLive's capture reads chrome.runtime.lastError inside the callback", () => Effect.gen(function*() {
    let lastError: chrome.runtime.LastError | undefined
    const runtime = { get lastError() { return lastError } }

    const tabCapture = {
      ...mockApi().api,
      capture: vi.fn((_options: CaptureOptions, callback: CaptureCallback) => {
        queueMicrotask(() => {
          lastError = { message: tabCaptureErrors.noAudioOrVideo }

          try { callback(null) } finally { lastError = undefined }
        })
      })
    }

    yield* stubChrome({ tabCapture, runtime })
    const error = yield* Effect.flip(Effect.scoped(Effect.flatMap(ChromeTabCapture, (service) => service.capture({})).pipe(Effect.provide(layerLive))))
    expect(error).toMatchObject({ operation: "capture", cause: { message: tabCaptureErrors.noAudioOrVideo } })
    expect(tabCapture.capture.mock.contexts[0]).toBe(tabCapture)
    expect(tabCapture.capture.mock.calls[0]?.[0]).toEqual({})
  }))

  it.effect("layerLive's capture works without chrome.runtime, with a generic cause", () => Effect.gen(function*() {
    const tabCapture = { ...mockApi().api, capture: (_options: CaptureOptions, callback: CaptureCallback) => callback(null) }
    yield* stubChrome({ tabCapture })
    const error = yield* Effect.flip(Effect.scoped(Effect.flatMap(ChromeTabCapture, (service) => service.capture({ video: true })).pipe(Effect.provide(layerLive))))
    expect(error).toMatchObject({ operation: "capture", cause: new Error("chrome.tabCapture.capture delivered no stream") })
  }))

  it.effect("layerLive acquires and releases a live capture stream", () => Effect.gen(function*() {
    const { stream, media } = streamOf("live")
    const tabCapture = { ...mockApi().api, capture: (_options: CaptureOptions, callback: CaptureCallback) => queueMicrotask(() => callback(media)) }
    yield* stubChrome({ tabCapture, runtime: {} })
    const service = yield* ChromeTabCapture.pipe(Effect.provide(layerLive))
    yield* Effect.scoped(Effect.gen(function*() {
      expect(yield* service.capture({ video: true })).toBe(media)
      expect(stream.active).toBe(true)
    }))
    expect(stream.active).toBe(false)
  }))
})

describe("TabCapture fixture", () => {
  it.effect("needs the activeTab grant, then registers a pending capture per stream id", () => Effect.gen(function*() {
    const fake = makeTabCapture()
    const capture = make(fake.api)
    const changes = yield* Effect.forkScoped(Stream.runCollect(Stream.take(capture.onStatusChanged, 4)))
    yield* Effect.promise(() => fake.controls.onStatusChanged.waitForListener())
    expect(yield* Effect.flip(capture.getMediaStreamId())).toMatchObject({ operation: "getMediaStreamId", cause: new Error(tabCaptureErrors.grant) })
    fake.controls.invoke()
    const id = yield* capture.getMediaStreamId()
    expect(id).toBe("tab-capture-stream-1")
    expect(yield* capture.getCapturedTabs).toEqual([{ tabId: 1, status: "pending", fullscreen: false }])
    expect(yield* Effect.flip(capture.getMediaStreamId({ targetTabId: 1 }))).toMatchObject({ cause: new Error(tabCaptureErrors.sameTab) })
    const stream = fake.controls.redeem(id, true)
    expect(stream.getTracks().map((track) => track.kind)).toEqual(["audio", "video"])
    expect(() => fake.controls.redeem(id)).toThrow("unknown, used or expired")
    expect(fake.controls.setFullscreen(1, true)).toEqual([])
    expect(fake.controls.setFullscreen(1, true)).toEqual([])

    for (const track of stream.getTracks()) track.stop()
    expect(yield* capture.getCapturedTabs).toEqual([])
    expect((yield* Fiber.join(changes)).map((info) => [info.status, info.fullscreen])).toEqual([
      ["pending", false], ["active", false], ["active", true], ["stopped", true]
    ])
  }))

  it.effect("checks targets and consumers in Chrome's order", () => Effect.gen(function*() {
    const fake = makeTabCapture()
    const capture = make(fake.api)
    const cause = (options?: MediaStreamOptions) => Effect.map(Effect.flip(capture.getMediaStreamId(options)), (error) => error.cause)
    expect(yield* cause({ targetTabId: 2 })).toEqual(new Error(tabCaptureErrors.invalidTab))
    fake.controls.openTab(2)
    fake.controls.openTab(3, false)
    expect(yield* cause({ targetTabId: 2 })).toEqual(new Error(tabCaptureErrors.grant))
    fake.controls.invoke(2)
    expect(yield* cause({ targetTabId: 2, consumerTabId: 4 })).toEqual(new Error(tabCaptureErrors.invalidTab))
    expect(yield* cause({ targetTabId: 2, consumerTabId: 3 })).toEqual(new Error(tabCaptureErrors.insecureConsumer))
    expect(yield* capture.getMediaStreamId({ targetTabId: 2, consumerTabId: 1 })).toBe("tab-capture-stream-1")
    fake.controls.setActiveTab(undefined)
    expect(yield* cause()).toEqual(new Error(tabCaptureErrors.findingTab))
    expect(() => fake.controls.setActiveTab(9)).toThrow("Tab 9 is not open")
    expect(() => fake.controls.invoke()).toThrow("No open tab")
    expect(fake.controls.captures()).toEqual([{ tabId: 2, status: "pending", fullscreen: false }])
  }))

  it.effect("expires unused ids, ends captures from outside and drops grants on navigation", () => Effect.gen(function*() {
    const fake = makeTabCapture()
    const capture = make(fake.api)
    fake.controls.openTab(2)
    fake.controls.invoke(1)
    fake.controls.invoke(2)
    const id = yield* capture.getMediaStreamId()
    fake.controls.expire(id)
    expect(() => fake.controls.expire(id)).toThrow("unknown, used or expired")
    expect(yield* capture.getCapturedTabs).toEqual([])
    const second = yield* capture.getMediaStreamId({ targetTabId: 2 })
    const stream = fake.controls.redeem(second)
    fake.controls.navigate(2)
    expect(fake.controls.isGranted(2)).toBe(false)
    expect(fake.controls.captures()).toEqual([{ tabId: 2, status: "active", fullscreen: false }])
    expect(yield* Effect.flip(capture.getMediaStreamId({ targetTabId: 2 }))).toMatchObject({ cause: new Error(tabCaptureErrors.grant) })
    fake.controls.fail(2)
    expect(stream.active).toBe(false)
    expect(fake.controls.captures()).toEqual([])
    expect(() => fake.controls.stop(2)).toThrow("Tab 2 is not being captured")
    expect(() => fake.controls.setFullscreen(2, true)).toThrow("Tab 2 is not being captured")
    yield* capture.getMediaStreamId()
    expect(fake.controls.closeTab(1)).toEqual([])
    expect(fake.controls.captures()).toEqual([])
    expect(fake.controls.closeTab(1)).toEqual([])
  }))

  it.effect("captures the active tab through the service and ends it when the scope closes", () => Effect.gen(function*() {
    const fake = makeTabCapture()
    const capture = make(fake.api)
    expect(yield* Effect.flip(Effect.scoped(capture.capture({ video: true })))).toMatchObject({
      operation: "capture", cause: { message: tabCaptureErrors.grant }
    })
    fake.controls.invoke()
    expect(yield* Effect.flip(Effect.scoped(capture.capture({})))).toMatchObject({ cause: { message: tabCaptureErrors.noAudioOrVideo } })

    const seen = yield* Effect.promise(() => new Promise<chrome.runtime.LastError | undefined>((resolve) => {
      fake.api.capture?.({}, () => resolve(fake.api.lastError))
    }))

    expect(seen).toEqual({ message: tabCaptureErrors.noAudioOrVideo })
    expect(fake.api.lastError).toBeUndefined()
    yield* Effect.scoped(Effect.gen(function*() {
      const stream = yield* capture.capture({ audio: true })
      expect(stream.getAudioTracks()).toHaveLength(1)
      expect(stream.getVideoTracks()).toHaveLength(0)
      expect(fake.controls.captures()).toEqual([{ tabId: 1, status: "active", fullscreen: false }])
      expect(fake.controls.stream(1)?.id).toBe(stream.id)
      expect(yield* Effect.flip(Effect.scoped(capture.capture({ video: true })))).toMatchObject({ cause: { message: tabCaptureErrors.sameTab } })
      expect(yield* Effect.flip(capture.getMediaStreamId())).toMatchObject({ cause: new Error(tabCaptureErrors.sameTab) })
    }))
    expect(fake.controls.captures()).toEqual([])
    const again = yield* Effect.scoped(capture.capture({ video: true }))
    expect(again.active).toBe(false)
  }))

  it.effect("ends a captured tab's stream when the tab closes", () => Effect.gen(function*() {
    const fake = makeTabCapture()
    const capture = make(fake.api)
    fake.controls.invoke()
    yield* Effect.scoped(Effect.gen(function*() {
      const stream = yield* capture.capture({ video: true })
      const changes = yield* Effect.forkChild(Stream.runCollect(Stream.take(capture.onStatusChanged, 1)))
      yield* Effect.promise(() => fake.controls.onStatusChanged.waitForListener())
      fake.controls.closeTab(1)
      expect(stream.active).toBe(false)
      expect(yield* Fiber.join(changes)).toEqual([{ tabId: 1, status: "stopped", fullscreen: false }])
      expect(fake.controls.isGranted(1)).toBe(false)
    }))
    expect(yield* Effect.flip(Effect.scoped(capture.capture({ video: true })))).toMatchObject({ cause: { message: tabCaptureErrors.findingTab } })
  }))

  it.effect("returns listener exceptions from controls and applies overrides", () => Effect.gen(function*() {
    const cause = new Error("listener failed")
    const fake = makeTabCapture({ getCapturedTabs: async () => [active] })
    fake.controls.invoke()
    yield* make(fake.api).getMediaStreamId()
    fake.api.onStatusChanged.addListener(() => { throw cause })
    expect(fake.controls.stop(1)).toEqual([cause])
    expect(yield* Effect.flatMap(ChromeTabCapture, (service) => service.getCapturedTabs).pipe(Effect.provide(fake.layer))).toEqual([active])
  }))

  it("simulated streams end their tracks once and report the end once", () => {
    const ended = vi.fn()
    const stream = makeCaptureStream("s", { audio: true, video: true }, ended)
    expect(stream.getTracks().map((track) => track.id)).toEqual(["s-audio", "s-video"])
    stream.getVideoTracks()[0]?.stop()
    expect(stream.active).toBe(true)
    expect(ended).not.toHaveBeenCalled()
    stream.getAudioTracks()[0]?.stop()
    stream.getAudioTracks()[0]?.stop()
    expect(stream.active).toBe(false)
    expect(ended).toHaveBeenCalledTimes(1)
    expect(asMediaStream(stream)).toBe(stream)
  })
})
