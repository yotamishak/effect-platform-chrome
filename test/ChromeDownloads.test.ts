// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Deferred, Effect, Exit, Fiber, Option, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeDownloads, ChromeDownloadsError, DownloadInterruptedError, layer, layerLive, make } from "../src/ChromeDownloads.js"
import type {
  ChromeDownloadsApi, ChromeDownloadsService, DeterminingFilename, DownloadDelta, DownloadItem, SuggestCallback
} from "../src/ChromeDownloads.js"
import { makeEvent } from "../src/testing/Event.js"

const item: DownloadItem = {
  id: 7, url: "https://files.example/report.pdf", finalUrl: "https://files.example/report.pdf", referrer: "",
  filename: "/downloads/report.pdf", mime: "application/pdf", incognito: false, danger: "safe", state: "in_progress",
  paused: false, canResume: false, exists: true, bytesReceived: 0, totalBytes: 100, fileSize: 100,
  startTime: "2026-10-22T10:00:00.000Z"
}

const changed: DownloadDelta = { id: 7, paused: { previous: false, current: true } }

const mockApi = () => {
  const onCreated = makeEvent<[DownloadItem]>()
  const onChanged = makeEvent<[DownloadDelta]>()
  const onErased = makeEvent<[number]>()
  const onDeterminingFilename = makeEvent<[DownloadItem, SuggestCallback]>()

  const api = {
    download: vi.fn(async (_options: chrome.downloads.DownloadOptions) => 7),
    search: vi.fn(async (_query: chrome.downloads.DownloadQuery): Promise<Array<DownloadItem>> => [item]),
    pause: vi.fn(async (_downloadId: number) => {}),
    resume: vi.fn(async (_downloadId: number) => {}),
    cancel: vi.fn(async (_downloadId: number) => {}),
    erase: vi.fn(async (_query: chrome.downloads.DownloadQuery) => [7]),
    removeFile: vi.fn(async (_downloadId: number) => {}),
    open: vi.fn(async (_downloadId: number) => {}),
    show: vi.fn((_downloadId: number) => {}),
    showDefaultFolder: vi.fn(() => {}),
    getFileIcon: vi.fn(async (_downloadId: number, _options?: chrome.downloads.GetFileIconOptions): Promise<string | undefined> =>
      "data:image/png;base64,"),
    setUiOptions: vi.fn(async (_options: chrome.downloads.UiOptions) => {}),
    acceptDanger: vi.fn(async (_downloadId: number) => {}),
    onCreated: onCreated.api,
    onChanged: onChanged.api,
    onErased: onErased.api,
    onDeterminingFilename: onDeterminingFilename.api
  } satisfies ChromeDownloadsApi

  return {
    api,
    onCreated: onCreated.controls,
    onChanged: onChanged.controls,
    onErased: onErased.controls,
    onDeterminingFilename: onDeterminingFilename.controls
  }
}

type AsyncMethod =
  | "download" | "search" | "pause" | "resume" | "cancel" | "erase" | "removeFile" | "open" | "getFileIcon"
  | "setUiOptions" | "acceptDanger"

const asyncMethods: ReadonlyArray<AsyncMethod> = [
  "download", "search", "pause", "resume", "cancel", "erase", "removeFile", "open", "getFileIcon", "setUiOptions", "acceptDanger"
]

/** Runs one Promise-based service operation as Effect<void>, keyed by its Chrome member. */
const call = (downloads: ChromeDownloadsService, method: AsyncMethod): Effect.Effect<void, ChromeDownloadsError> => {
  switch (method) {
    case "download": return Effect.asVoid(downloads.download({ url: item.url }))
    case "search": return Effect.asVoid(downloads.search({}))
    case "pause": return downloads.pause(7)
    case "resume": return downloads.resume(7)
    case "cancel": return downloads.cancel(7)
    case "erase": return Effect.asVoid(downloads.erase({ id: 7 }))
    case "removeFile": return downloads.removeFile(7)
    case "open": return downloads.open(7)
    case "getFileIcon": return Effect.asVoid(downloads.getFileIcon(7))
    case "setUiOptions": return downloads.setUiOptions({ enabled: false })
    case "acceptDanger": return downloads.acceptDanger(7)
  }
}

/** Collects the listener a stream added, so a test can call it like Chrome would. */
const capture = <Args extends ReadonlyArray<unknown>>(source: { addListener: (listener: (...args: Args) => void) => void }) =>
  vi.spyOn(source, "addListener")

describe("ChromeDownloads", () => {
  it.effect("passes each call through unchanged and returns Chrome's result", () => Effect.gen(function*() {
    const { api } = mockApi()
    const downloads = make(api)
    expect(yield* downloads.download({ url: item.url, filename: "report.pdf" })).toBe(7)
    expect(yield* downloads.search({ state: "complete" })).toEqual([item])
    expect(yield* downloads.erase({ id: 7 })).toEqual([7])
    yield* downloads.pause(7)
    yield* downloads.resume(7)
    yield* downloads.cancel(7)
    yield* downloads.removeFile(7)
    yield* downloads.open(7)
    yield* downloads.show(7)
    yield* downloads.showDefaultFolder
    yield* downloads.setUiOptions({ enabled: false })
    yield* downloads.acceptDanger(7)
    expect(api.download).toHaveBeenCalledExactlyOnceWith({ url: item.url, filename: "report.pdf" })
    expect(api.search).toHaveBeenCalledExactlyOnceWith({ state: "complete" })
    expect(api.erase).toHaveBeenCalledExactlyOnceWith({ id: 7 })

    for (const method of [api.pause, api.resume, api.cancel, api.removeFile, api.open, api.show, api.acceptDanger]) {
      expect(method).toHaveBeenCalledExactlyOnceWith(7)
    }

    expect(api.showDefaultFolder).toHaveBeenCalledExactlyOnceWith()
    expect(api.setUiOptions).toHaveBeenCalledExactlyOnceWith({ enabled: false })
  }))

  it.effect("keeps every operation lazy and re-runs Chrome on each execution", () => Effect.gen(function*() {
    const { api } = mockApi()
    const downloads = make(api)
    const effects = asyncMethods.map((method) => call(downloads, method))
    const synchronous = [downloads.show(7), downloads.showDefaultFolder]

    for (const method of [...asyncMethods, "show", "showDefaultFolder"] as const) expect(api[method]).not.toHaveBeenCalled()

    for (const effect of [...effects, ...synchronous]) {
      yield* effect
      yield* effect
    }

    for (const method of [...asyncMethods, "show", "showDefaultFolder"] as const) expect(api[method]).toHaveBeenCalledTimes(2)
  }))

  it.effect("reads a file icon as an Option, passing options only when given", () => Effect.gen(function*() {
    const { api } = mockApi()
    const downloads = make(api)
    expect(yield* downloads.getFileIcon(7)).toEqual(Option.some("data:image/png;base64,"))
    api.getFileIcon.mockResolvedValueOnce(undefined)
    expect(Option.isNone(yield* downloads.getFileIcon(7, { size: 16 }))).toBe(true)
    expect(api.getFileIcon.mock.calls).toEqual([[7], [7, { size: 16 }]])
  }))

  it.effect.each(asyncMethods)("maps a rejection and a synchronous throw from %s to the typed error", (method) => Effect.gen(function*() {
    for (const synchronous of [false, true]) {
      const cause = new Error(`${method} failed`)

      const fail = (): Promise<never> => {
        if (synchronous) throw cause

        return Promise.reject(cause)
      }

      const api: ChromeDownloadsApi = { ...mockApi().api, [method]: fail }
      const error = yield* Effect.flip(call(make(api), method))
      expect(error).toBeInstanceOf(ChromeDownloadsError)
      expect(error.operation).toBe(method)
      expect(error.cause).toBe(cause)
    }
  }))

  it.effect.each(["show", "showDefaultFolder"] as const)("maps a synchronous throw from %s to the typed error", (method) => Effect.gen(function*() {
    const { api } = mockApi()
    const cause = new Error("Invalid downloadId")
    api[method].mockImplementation(() => { throw cause })
    const downloads = make(api)
    const error = yield* Effect.flip(method === "show" ? downloads.show(9) : downloads.showDefaultFolder)
    expect(error).toBeInstanceOf(ChromeDownloadsError)
    expect(error).toMatchObject({ operation: method, cause })
  }))

  it.effect("fails setUiOptions with a typed error on a browser before Chrome 105", () => Effect.gen(function*() {
    const { api } = mockApi()
    const { setUiOptions: _absent, ...older } = api
    const error = yield* Effect.flip(make(older).setUiOptions({ enabled: false }))
    expect(error).toBeInstanceOf(ChromeDownloadsError)
    expect(error.operation).toBe("setUiOptions")
    expect(String(error.cause)).toContain("downloads.setUiOptions is unavailable")
  }))

  describe.each([["openFromUserGesture", "open"], ["acceptDangerFromUserGesture", "acceptDanger"]] as const)("%s", (bridge, method) => {
    it.effect("calls Chrome before the Effect runs and replays one outcome", () => Effect.gen(function*() {
      const { api } = mockApi()
      const downloads = make(api)
      const outcome = downloads[bridge](7)
      expect(api[method]).toHaveBeenCalledExactlyOnceWith(7)
      yield* outcome
      yield* outcome
      expect(api[method]).toHaveBeenCalledOnce()
      const lazy = downloads[method](7)
      expect(api[method]).toHaveBeenCalledOnce()
      yield* lazy
      expect(api[method]).toHaveBeenCalledTimes(2)
    }))

    // A synchronous click handler is an intentional native boundary.
    it("starts the call on the handler's synchronous stack", async () => {
      const { api } = mockApi()
      let inHandler = false
      api[method].mockImplementation(async () => { expect(inHandler).toBe(true) })
      const downloads = make(api)

      const onClick = () => {
        inHandler = true
        const outcome = downloads[bridge](7)
        inHandler = false

        return outcome
      }

      await Effect.runPromise(onClick())
      expect(api[method]).toHaveBeenCalledOnce()
    })

    it.effect("types a rejection and a synchronous throw with the Chrome member, without calling again", () => Effect.gen(function*() {
      for (const synchronous of [false, true]) {
        const { api } = mockApi()
        const cause = new Error("User gesture required")
        api[method].mockImplementation(() => {
          if (synchronous) throw cause

          return Promise.reject(cause)
        })
        const outcome = make(api)[bridge](7)

        for (let round = 0; round < 2; round++) {
          const error = yield* Effect.flip(outcome)
          expect(error).toBeInstanceOf(ChromeDownloadsError)
          expect(error).toMatchObject({ operation: method, cause })
        }

        expect(api[method]).toHaveBeenCalledOnce()
      }
    }))

    it.effect("stops waiting when interrupted and still reports the late outcome", () => Effect.gen(function*() {
      const { api } = mockApi()
      let finish!: (cause: Error) => void
      api[method].mockImplementation(() => new Promise<void>((_resolve, reject) => { finish = reject }))
      const outcome = make(api)[bridge](7)
      const waiting = yield* Effect.forkChild(outcome)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(waiting)
      expect(Exit.hasInterrupts(yield* Fiber.await(waiting))).toBe(true)
      const cause = new Error("Download must be complete")
      finish(cause)
      expect(yield* Effect.flip(outcome)).toMatchObject({ operation: method, cause })
    }))
  })

  describe.each([["onCreated", item], ["onChanged", changed], ["onErased", 7]] as const)("%s", (event, value) => {
    const streamOf = (api: ChromeDownloadsApi): Stream.Stream<DownloadItem | DownloadDelta | number, ChromeDownloadsError> => make(api)[event]

    const emit = (mock: ReturnType<typeof mockApi>) => {
      if (event === "onCreated") mock.onCreated.emit(item)
      else if (event === "onChanged") mock.onChanged.emit(changed)
      else mock.onErased.emit(7)
    }

    it.effect("delivers events and removes its listener when the stream ends", () => Effect.gen(function*() {
      const mock = mockApi()
      const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(streamOf(mock.api), 1)))
      yield* Effect.promise(() => mock[event].waitForListener())
      emit(mock)
      expect(yield* Fiber.join(fiber)).toEqual([value])
      expect(mock[event].listenerCount).toBe(0)
    }))

    it.effect("removes its listener when interrupted", () => Effect.gen(function*() {
      const mock = mockApi()
      const fiber = yield* Effect.forkScoped(Stream.runDrain(streamOf(mock.api)))
      yield* Effect.promise(() => mock[event].waitForListener())
      yield* Fiber.interrupt(fiber)
      expect(mock[event].listenerCount).toBe(0)
    }))

    it.effect("types a registration failure and a throwing accessor with the event name", () => Effect.gen(function*() {
      const mock = mockApi()
      const cause = new Error("event unavailable")
      mock[event].failNext("addListener", cause)
      expect(yield* Effect.flip(Stream.runDrain(streamOf(mock.api)))).toMatchObject({ operation: event, cause })
      expect(mock[event].listenerCount).toBe(0)
      Object.defineProperty(mock.api, event, { get: () => { throw cause } })
      const error = yield* Effect.flip(Stream.runDrain(streamOf(mock.api)))
      expect(error).toBeInstanceOf(ChromeDownloadsError)
      expect(error).toMatchObject({ operation: event, cause })
    }))
  })

  describe("onDeterminingFilename", () => {
    const suggestion = { filename: "reports/report.pdf", conflictAction: "uniquify" } as const

    it.effect("returns true to Chrome, answers once, and defaults whatever is unanswered when the stream ends", () => Effect.gen(function*() {
      const mock = mockApi()
      const addListener = capture(mock.api.onDeterminingFilename)
      const answered = vi.fn<SuggestCallback>()
      const unanswered = vi.fn<SuggestCallback>()

      const fiber = yield* Effect.forkScoped(make(mock.api).onDeterminingFilename.pipe(
        Stream.take(1),
        Stream.mapEffect((event) => event.suggest(suggestion).pipe(Effect.as(event))),
        Stream.runCollect
      ))

      yield* Effect.promise(() => mock.onDeterminingFilename.waitForListener())
      const listener = addListener.mock.calls[0]?.[0]
      expect(listener?.(item, answered)).toBe(true)
      expect(listener?.({ ...item, id: 8 }, unanswered)).toBe(true)
      const [event] = yield* Fiber.join(fiber)
      expect(event?.item).toEqual(item)
      expect(answered.mock.calls).toEqual([[suggestion]])
      expect(unanswered.mock.calls).toEqual([[]])
      yield* event?.suggest({ filename: "again.pdf" }) ?? Effect.void
      yield* event?.suggest() ?? Effect.void
      expect(answered).toHaveBeenCalledOnce()
      expect(mock.onDeterminingFilename.listenerCount).toBe(0)
    }))

    it.effect("keeps Chrome's default name when suggesting without a suggestion", () => Effect.gen(function*() {
      const mock = mockApi()
      const suggest = vi.fn<SuggestCallback>()

      const fiber = yield* Effect.forkScoped(make(mock.api).onDeterminingFilename.pipe(
        Stream.take(1),
        Stream.mapEffect((event) => event.suggest()),
        Stream.runDrain
      ))

      yield* Effect.promise(() => mock.onDeterminingFilename.waitForListener())
      mock.onDeterminingFilename.emit(item, suggest)
      yield* Fiber.join(fiber)
      expect(suggest.mock.calls).toEqual([[]])
    }))

    it.effect("types a suggestion Chrome throws on and lets it be answered again", () => Effect.gen(function*() {
      const mock = mockApi()
      const cause = new Error("Invalid filename")
      const suggest = vi.fn<SuggestCallback>((value) => { if (value?.filename.startsWith("..") === true) throw cause })

      const fiber = yield* Effect.forkScoped(make(mock.api).onDeterminingFilename.pipe(
        Stream.take(1),
        Stream.mapEffect((event) => Effect.flip(event.suggest({ filename: "../escape.pdf" })).pipe(
          Effect.tap(() => event.suggest(suggestion))
        )),
        Stream.runCollect
      ))

      yield* Effect.promise(() => mock.onDeterminingFilename.waitForListener())
      mock.onDeterminingFilename.emit(item, suggest)
      const [error] = yield* Fiber.join(fiber)
      expect(error).toBeInstanceOf(ChromeDownloadsError)
      expect(error).toMatchObject({ operation: "suggest", cause })
      expect(suggest.mock.calls).toEqual([[{ filename: "../escape.pdf" }], [suggestion]])
    }))

    it.effect("defaults a rejected, never-retried suggestion when the stream ends, swallowing a throwing default", () => Effect.gen(function*() {
      const mock = mockApi()
      const suggest = vi.fn<SuggestCallback>(() => { throw new Error("download already gone") })

      const fiber = yield* Effect.forkScoped(make(mock.api).onDeterminingFilename.pipe(
        Stream.take(1),
        Stream.mapEffect((event) => Effect.flip(event.suggest(suggestion))),
        Stream.runCollect
      ))

      yield* Effect.promise(() => mock.onDeterminingFilename.waitForListener())
      mock.onDeterminingFilename.emit(item, suggest)
      expect(yield* Fiber.join(fiber)).toHaveLength(1)
      expect(suggest.mock.calls).toEqual([[suggestion], []])
    }))

    it.effect("answers an event the buffer drops at once, with the default name", () => Effect.gen(function*() {
      const mock = mockApi()
      const suggests = Array.from({ length: 66 }, () => vi.fn<SuggestCallback>())
      const gate = yield* Deferred.make<void>()
      const received: Array<DeterminingFilename> = []

      const fiber = yield* Effect.forkScoped(make(mock.api).onDeterminingFilename.pipe(
        Stream.mapEffect((event) => Effect.sync(() => { received.push(event) }).pipe(Effect.andThen(Deferred.await(gate)))),
        Stream.runDrain
      ))

      yield* Effect.promise(() => mock.onDeterminingFilename.waitForListener())
      suggests.forEach((suggest, index) => mock.onDeterminingFilename.emit({ ...item, id: index }, suggest))
      // 66 events into a 64-event buffer: the two oldest are dropped and answered immediately.
      expect(suggests[0]?.mock.calls).toEqual([[]])
      expect(suggests[1]?.mock.calls).toEqual([[]])
      expect(suggests.slice(2).every((suggest) => suggest.mock.calls.length === 0)).toBe(true)
      yield* Deferred.succeed(gate, undefined)
      yield* Effect.yieldNow
      expect(received.map((event) => event.item.id)).toEqual(Array.from({ length: 64 }, (_, index) => index + 2))
      yield* Effect.forEach(received, (event) => event.suggest({ filename: `file-${event.item.id}.pdf` }), { discard: true })

      suggests.slice(2).forEach((suggest, offset) => {
        expect(suggest.mock.calls).toEqual([[{ filename: `file-${offset + 2}.pdf` }]])
      })

      yield* Fiber.interrupt(fiber)
      expect(suggests.every((suggest) => suggest.mock.calls.length === 1)).toBe(true)
      expect(mock.onDeterminingFilename.listenerCount).toBe(0)
    }))

    it.effect("answers a late callback after removal with the default name", () => Effect.gen(function*() {
      const mock = mockApi()
      const addListener = capture(mock.api.onDeterminingFilename)
      const fiber = yield* Effect.forkScoped(Stream.runDrain(make(mock.api).onDeterminingFilename))
      yield* Effect.promise(() => mock.onDeterminingFilename.waitForListener())
      yield* Fiber.interrupt(fiber)
      expect(mock.onDeterminingFilename.listenerCount).toBe(0)
      const late = vi.fn<SuggestCallback>()
      expect(addListener.mock.calls[0]?.[0](item, late)).toBe(true)
      expect(late.mock.calls).toEqual([[]])
    }))

    it.effect("defaults events answered nowhere when interrupted, and removes its listener", () => Effect.gen(function*() {
      const mock = mockApi()
      const suggests = Array.from({ length: 3 }, () => vi.fn<SuggestCallback>())
      const entered = yield* Deferred.make<void>()

      const fiber = yield* Effect.forkScoped(make(mock.api).onDeterminingFilename.pipe(
        Stream.mapEffect(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))),
        Stream.runDrain
      ))

      yield* Effect.promise(() => mock.onDeterminingFilename.waitForListener())
      suggests.forEach((suggest) => mock.onDeterminingFilename.emit(item, suggest))
      yield* Deferred.await(entered)
      expect(suggests.every((suggest) => suggest.mock.calls.length === 0)).toBe(true)
      yield* Fiber.interrupt(fiber)
      expect(suggests.map((suggest) => suggest.mock.calls)).toEqual([[[]], [[]], [[]]])
      expect(mock.onDeterminingFilename.listenerCount).toBe(0)
    }))

    it.effect("types a registration failure, answering events from a partial registration", () => Effect.gen(function*() {
      const mock = mockApi()
      const cause = new Error("Each extension may have at most one onDeterminingFilename listener")
      const early = vi.fn<SuggestCallback>()
      const source = mock.api.onDeterminingFilename
      const add = source.addListener
      vi.spyOn(source, "addListener").mockImplementationOnce((listener) => {
        add(listener)
        listener(item, early)
        throw cause
      })
      const error = yield* Effect.flip(Stream.runDrain(make(mock.api).onDeterminingFilename))
      expect(error).toBeInstanceOf(ChromeDownloadsError)
      expect(error).toMatchObject({ operation: "onDeterminingFilename", cause })
      expect(early.mock.calls).toEqual([[]])
      expect(mock.onDeterminingFilename.listenerCount).toBe(0)
      Object.defineProperty(mock.api, "onDeterminingFilename", { get: () => { throw cause } })
      expect(yield* Effect.flip(Stream.runDrain(make(mock.api).onDeterminingFilename))).toMatchObject({ operation: "onDeterminingFilename", cause })
    }))

    it.effect("gives each consumption its own listener and bookkeeping", () => Effect.gen(function*() {
      const mock = mockApi()
      const stream = make(mock.api).onDeterminingFilename
      const first = vi.fn<SuggestCallback>()
      const second = vi.fn<SuggestCallback>()
      const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 1)))
      yield* Effect.promise(() => mock.onDeterminingFilename.waitForListener())
      mock.onDeterminingFilename.emit(item, first)
      const [event] = yield* Fiber.join(fiber)
      expect(first.mock.calls).toEqual([[]])
      const next = yield* Effect.forkScoped(Stream.runCollect(Stream.take(Stream.mapEffect(stream, (value) => value.suggest(suggestion)), 1)))
      yield* Effect.promise(() => mock.onDeterminingFilename.waitForListener())
      mock.onDeterminingFilename.emit({ ...item, id: 8 }, second)
      yield* Fiber.join(next)
      expect(second.mock.calls).toEqual([[suggestion]])
      yield* event?.suggest(suggestion) ?? Effect.void
      expect(first).toHaveBeenCalledOnce()
    }))
  })

  describe("waitForComplete", () => {
    const complete: DownloadItem = { ...item, state: "complete", endTime: "2026-10-22T10:01:00.000Z" }

    it.effect("resolves at once when the download is already complete", () => Effect.gen(function*() {
      const mock = mockApi()
      mock.api.search.mockResolvedValueOnce([complete])
      expect(yield* make(mock.api).waitForComplete(7)).toEqual(complete)
      expect(mock.api.search).toHaveBeenCalledExactlyOnceWith({ id: 7 })
      expect(mock.onChanged.listenerCount).toBe(0)
    }))

    it.effect("listens before reading the state, so a completion in between is not missed", () => Effect.gen(function*() {
      const mock = mockApi()

      mock.api.search.mockImplementationOnce(async () => {
        expect(mock.onChanged.listenerCount).toBe(1)
        mock.onChanged.emit({ id: 8, state: { previous: "in_progress", current: "interrupted" } })
        mock.onChanged.emit({ id: 7, state: { previous: "in_progress", current: "complete" } })

        return [item]
      })
      mock.api.search.mockResolvedValueOnce([complete])
      expect(yield* make(mock.api).waitForComplete(7)).toEqual(complete)
      expect(mock.api.search).toHaveBeenCalledTimes(2)
      expect(mock.onChanged.listenerCount).toBe(0)
    }))

    it.effect("waits for a later completion, ignoring other ids and non-terminal changes", () => Effect.gen(function*() {
      const mock = mockApi()
      const searched = yield* Deferred.make<void>()

      mock.api.search.mockImplementationOnce(async () => {
        Deferred.doneUnsafe(searched, Exit.void)

        return [item]
      })
      mock.api.search.mockResolvedValueOnce([complete])
      const fiber = yield* Effect.forkScoped(make(mock.api).waitForComplete(7))
      yield* Deferred.await(searched)
      yield* Effect.yieldNow
      mock.onChanged.emit({ id: 7, paused: { previous: false, current: true } })
      mock.onChanged.emit({ id: 7, state: { previous: "interrupted", current: "in_progress" } })
      mock.onChanged.emit({ id: 9, state: { previous: "in_progress", current: "interrupted" } })
      expect(mock.api.search).toHaveBeenCalledOnce()
      mock.onChanged.emit({ id: 7, state: { previous: "in_progress", current: "complete" } })
      expect(yield* Fiber.join(fiber)).toEqual(complete)
      expect(mock.onChanged.listenerCount).toBe(0)
    }))

    it.effect("finds the download by id even when search returns other items first", () => Effect.gen(function*() {
      const mock = mockApi()
      mock.api.search.mockResolvedValueOnce([{ ...item, id: 1 }, { ...complete, id: 7 }])
      expect((yield* make(mock.api).waitForComplete(7)).id).toBe(7)
    }))

    it.effect("fails with the interrupt reason, whether already or later interrupted", () => Effect.gen(function*() {
      const mock = mockApi()
      const downloads = make(mock.api)
      mock.api.search.mockResolvedValueOnce([{ ...item, state: "interrupted", error: "NETWORK_FAILED" }])
      const already = yield* Effect.flip(downloads.waitForComplete(7))
      expect(already).toBeInstanceOf(DownloadInterruptedError)
      expect(already).toMatchObject({ downloadId: 7, reason: "NETWORK_FAILED" })

      mock.api.search.mockImplementationOnce(async () => {
        mock.onChanged.emit({ id: 7, state: { previous: "in_progress", current: "interrupted" }, error: { current: "USER_CANCELED" } })

        return [item]
      })
      const later = yield* Effect.flip(downloads.waitForComplete(7))
      expect(later).toBeInstanceOf(DownloadInterruptedError)
      expect(later).toMatchObject({ downloadId: 7, reason: "USER_CANCELED" })
      expect(mock.onChanged.listenerCount).toBe(0)
    }))

    it.effect("reads the reason from the item when the delta leaves it out, or reports none", () => Effect.gen(function*() {
      const mock = mockApi()
      const downloads = make(mock.api)

      const interruptDuringSearch = async () => {
        mock.onChanged.emit({ id: 7, state: { previous: "in_progress", current: "interrupted" } })

        return [item]
      }

      mock.api.search.mockImplementationOnce(interruptDuringSearch)
      mock.api.search.mockResolvedValueOnce([{ ...item, state: "interrupted", error: "FILE_NO_SPACE" }])
      expect(yield* Effect.flip(downloads.waitForComplete(7))).toMatchObject({ downloadId: 7, reason: "FILE_NO_SPACE" })
      mock.api.search.mockImplementationOnce(interruptDuringSearch)
      mock.api.search.mockRejectedValueOnce(new Error("search failed"))
      const unknown = yield* Effect.flip(downloads.waitForComplete(7))
      expect(unknown).toBeInstanceOf(DownloadInterruptedError)
      expect(unknown).toMatchObject({ downloadId: 7, reason: undefined })
    }))

    it.effect("fails an unknown or erased download as search, and types search failures", () => Effect.gen(function*() {
      const mock = mockApi()
      mock.api.search.mockResolvedValueOnce([])
      const unknown = yield* Effect.flip(make(mock.api).waitForComplete(99))
      expect(unknown).toBeInstanceOf(ChromeDownloadsError)
      expect(unknown).toMatchObject({ operation: "search" })
      expect(String(unknown.cause)).toContain("No download with id: 99")
      const cause = new Error("downloads permission missing")
      mock.api.search.mockRejectedValueOnce(cause)
      expect(yield* Effect.flip(make(mock.api).waitForComplete(7))).toMatchObject({ operation: "search", cause })

      mock.api.search.mockImplementationOnce(async () => {
        mock.onChanged.emit({ id: 7, state: { previous: "in_progress", current: "complete" } })

        return [item]
      })
      mock.api.search.mockResolvedValueOnce([])
      expect(yield* Effect.flip(make(mock.api).waitForComplete(7))).toMatchObject({ operation: "search" })
      expect(mock.onChanged.listenerCount).toBe(0)
    }))

    it.effect("types a failing onChanged registration or accessor as onChanged", () => Effect.gen(function*() {
      const mock = mockApi()
      const cause = new Error("listener refused")
      mock.onChanged.failNext("addListener", cause)
      const error = yield* Effect.flip(make(mock.api).waitForComplete(7))
      expect(error).toBeInstanceOf(ChromeDownloadsError)
      expect(error).toMatchObject({ operation: "onChanged", cause })
      expect(mock.api.search).not.toHaveBeenCalled()
      Object.defineProperty(mock.api, "onChanged", { get: () => { throw cause } })
      expect(yield* Effect.flip(make(mock.api).waitForComplete(7))).toMatchObject({ operation: "onChanged", cause })
    }))

    it.effect("removes its listener when interrupted while searching or waiting", () => Effect.gen(function*() {
      const mock = mockApi()
      const searching = yield* Deferred.make<void>()

      mock.api.search.mockImplementationOnce(() => {
        Deferred.doneUnsafe(searching, Exit.void)

        return new Promise<Array<DownloadItem>>(() => {})
      })
      const duringSearch = yield* Effect.forkScoped(make(mock.api).waitForComplete(7))
      yield* Deferred.await(searching)
      yield* Fiber.interrupt(duringSearch)
      expect(mock.onChanged.listenerCount).toBe(0)
      const waiting = yield* Effect.forkScoped(make(mock.api).waitForComplete(7))
      yield* Effect.promise(() => mock.onChanged.waitForListener())
      yield* Effect.yieldNow
      yield* Fiber.interrupt(waiting)
      expect(mock.onChanged.listenerCount).toBe(0)
    }))
  })

  it.effect("provides an injected API through layer", () => Effect.gen(function*() {
    const { api } = mockApi()
    expect(yield* Effect.flatMap(ChromeDownloads, (downloads) => downloads.download({ url: item.url })).pipe(Effect.provide(layer(api)))).toBe(7)
  }))

  it.effect("fails layerLive with initialize without chrome, and builds from a fake global", () => Effect.gen(function*() {
    yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => vi.unstubAllGlobals()))
    vi.stubGlobal("chrome", undefined)
    expect(yield* Effect.flip(ChromeDownloads.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
    vi.stubGlobal("chrome", {})
    const missing = yield* Effect.flip(ChromeDownloads.pipe(Effect.provide(layerLive)))
    expect(missing).toBeInstanceOf(ChromeDownloadsError)
    expect(String(missing.cause)).toContain("chrome.downloads is unavailable")
    const { api } = mockApi()
    vi.stubGlobal("chrome", { downloads: api })
    expect(yield* Effect.flatMap(ChromeDownloads, (downloads) => downloads.erase({})).pipe(Effect.provide(layerLive))).toEqual([7])
  }))
})
