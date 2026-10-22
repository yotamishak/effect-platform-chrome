// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Option, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeDownloads, ChromeDownloadsError, DownloadInterruptedError, layer, layerLive, make } from "../src/ChromeDownloads.js"
import type { ChromeDownloadsApi, DownloadDelta, DownloadItem, SuggestCallback } from "../src/ChromeDownloads.js"
import { makeEvent } from "../src/ChromeTesting.js"

const item: DownloadItem = {
  id: 7, url: "https://files.example/report.pdf", finalUrl: "https://files.example/report.pdf", referrer: "",
  filename: "/downloads/report.pdf", mime: "application/pdf", incognito: false, danger: "safe", state: "in_progress",
  paused: false, canResume: false, exists: true, bytesReceived: 0, totalBytes: 100, fileSize: 100,
  startTime: "2026-10-22T10:00:00.000Z"
}

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

describe("ChromeDownloads", () => {
  it.effect("passes calls through and resolves a download to its id", () => Effect.gen(function*() {
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

    for (const call of [api.pause, api.resume, api.cancel, api.removeFile, api.open, api.show, api.acceptDanger]) {
      expect(call).toHaveBeenCalledExactlyOnceWith(7)
    }

    expect(api.showDefaultFolder).toHaveBeenCalledOnce()
    expect(api.setUiOptions).toHaveBeenCalledExactlyOnceWith({ enabled: false })
  }))

  it.effect("reads a file icon as an option, passing options only when given", () => Effect.gen(function*() {
    const { api } = mockApi()
    const downloads = make(api)
    expect(yield* downloads.getFileIcon(7)).toEqual(Option.some("data:image/png;base64,"))
    api.getFileIcon.mockResolvedValueOnce(undefined)
    expect(Option.isNone(yield* downloads.getFileIcon(7, { size: 32 }))).toBe(true)
    expect(api.getFileIcon.mock.calls).toEqual([[7], [7, { size: 32 }]])
  }))

  it.effect("types rejected and throwing calls", () => Effect.gen(function*() {
    const { api } = mockApi()
    const rejected = new Error("Download must be in progress")
    const thrown = new Error("Invalid downloadId")
    api.cancel.mockRejectedValueOnce(rejected)
    api.show.mockImplementationOnce(() => { throw thrown })
    const downloads = make(api)
    const cancelError = yield* Effect.flip(downloads.cancel(9))
    expect(cancelError).toBeInstanceOf(ChromeDownloadsError)
    expect(cancelError).toMatchObject({ operation: "cancel", cause: rejected })
    expect(yield* Effect.flip(downloads.show(9))).toMatchObject({ operation: "show", cause: thrown })
  }))

  it.effect("streams created, changed and erased downloads while consumed", () => Effect.gen(function*() {
    const mock = mockApi()
    const downloads = make(mock.api)
    const created = yield* Effect.forkScoped(Stream.runCollect(Stream.take(downloads.onCreated, 1)))
    const changed = yield* Effect.forkScoped(Stream.runCollect(Stream.take(downloads.onChanged, 1)))
    const erased = yield* Effect.forkScoped(Stream.runCollect(Stream.take(downloads.onErased, 1)))
    yield* Effect.promise(() => mock.onCreated.waitForListener())
    yield* Effect.promise(() => mock.onChanged.waitForListener())
    yield* Effect.promise(() => mock.onErased.waitForListener())
    mock.onCreated.emit(item)
    mock.onChanged.emit({ id: 7, paused: { previous: false, current: true } })
    mock.onErased.emit(7)
    expect(yield* Fiber.join(created)).toEqual([item])
    expect(yield* Fiber.join(changed)).toEqual([{ id: 7, paused: { previous: false, current: true } }])
    expect(yield* Fiber.join(erased)).toEqual([7])
    expect(mock.onCreated.listenerCount + mock.onChanged.listenerCount + mock.onErased.listenerCount).toBe(0)
  }))

  it.effect("reports a failing registration with the event's operation", () => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("event unavailable")
    mock.onErased.failNext("addListener", cause)
    expect(yield* Effect.flip(Stream.runDrain(make(mock.api).onErased))).toMatchObject({ operation: "onErased", cause })
  }))

  describe("onDeterminingFilename", () => {
    it.effect("answers asynchronously, once, and defaults whatever is unanswered when the stream ends", () => Effect.gen(function*() {
      const mock = mockApi()
      const addListener = vi.spyOn(mock.api.onDeterminingFilename, "addListener")
      const answered = vi.fn<SuggestCallback>()
      const unanswered = vi.fn<SuggestCallback>()

      const fiber = yield* Effect.forkScoped(make(mock.api).onDeterminingFilename.pipe(
        Stream.take(1),
        Stream.mapEffect((event) => event.suggest({ filename: "reports/report.pdf", conflictAction: "uniquify" }).pipe(Effect.as(event))),
        Stream.runCollect
      ))

      yield* Effect.promise(() => mock.onDeterminingFilename.waitForListener())
      const listener = addListener.mock.calls[0]?.[0]
      // Returning true tells Chrome the suggestion comes later.
      expect(listener?.(item, answered)).toBe(true)
      expect(listener?.({ ...item, id: 8 }, unanswered)).toBe(true)
      const [event] = yield* Fiber.join(fiber)
      expect(event?.item).toEqual(item)
      expect(answered.mock.calls).toEqual([[{ filename: "reports/report.pdf", conflictAction: "uniquify" }]])
      expect(unanswered.mock.calls).toEqual([[]])
      yield* event?.suggest({ filename: "again.pdf" }) ?? Effect.void
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

    it.effect("types a suggestion Chrome rejects", () => Effect.gen(function*() {
      const mock = mockApi()
      const cause = new Error("Invalid filename")
      const suggest = vi.fn<SuggestCallback>(() => { throw cause })

      const fiber = yield* Effect.forkScoped(make(mock.api).onDeterminingFilename.pipe(
        Stream.take(1),
        Stream.mapEffect((event) => event.suggest({ filename: "../escape.pdf" })),
        Stream.runDrain,
        Effect.flip
      ))

      yield* Effect.promise(() => mock.onDeterminingFilename.waitForListener())
      mock.onDeterminingFilename.emit(item, suggest)
      expect(yield* Fiber.join(fiber)).toMatchObject({ operation: "suggest", cause })
    }))
  })

  describe("waitForComplete", () => {
    it.effect("resolves at once when the download is already complete", () => Effect.gen(function*() {
      const mock = mockApi()
      const complete: DownloadItem = { ...item, state: "complete" }
      mock.api.search.mockResolvedValueOnce([complete])
      expect(yield* make(mock.api).waitForComplete(7)).toEqual(complete)
      expect(mock.api.search).toHaveBeenCalledExactlyOnceWith({ id: 7 })
      expect(mock.onChanged.listenerCount).toBe(0)
    }))

    it.effect("listens before reading the state, so a completion in between is not missed", () => Effect.gen(function*() {
      const mock = mockApi()
      const complete: DownloadItem = { ...item, state: "complete", endTime: "2026-10-22T10:01:00.000Z" }

      mock.api.search.mockImplementationOnce(async () => {
        expect(mock.onChanged.listenerCount).toBe(1)
        mock.onChanged.emit({ id: 8, state: { previous: "in_progress", current: "interrupted" } })
        mock.onChanged.emit({ id: 7, state: { previous: "in_progress", current: "complete" } })

        return [item]
      })
      mock.api.search.mockResolvedValueOnce([complete])
      expect(yield* make(mock.api).waitForComplete(7)).toEqual(complete)
      expect(mock.onChanged.listenerCount).toBe(0)
    }))

    it.effect("waits for a later completion", () => Effect.gen(function*() {
      const mock = mockApi()
      const complete: DownloadItem = { ...item, state: "complete" }

      const searched = new Promise<void>((resolve) => {
        mock.api.search.mockImplementationOnce(async () => {
          resolve()

          return [item]
        })
      })

      mock.api.search.mockResolvedValueOnce([complete])
      const fiber = yield* Effect.forkScoped(make(mock.api).waitForComplete(7))
      yield* Effect.promise(() => searched)
      mock.onChanged.emit({ id: 7, paused: { previous: false, current: true } })
      mock.onChanged.emit({ id: 7, state: { previous: "in_progress", current: "complete" } })
      expect(yield* Fiber.join(fiber)).toEqual(complete)
      expect(mock.onChanged.listenerCount).toBe(0)
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

    it.effect("fails for an unknown download and removes its listener", () => Effect.gen(function*() {
      const mock = mockApi()
      mock.api.search.mockResolvedValueOnce([])
      const error = yield* Effect.flip(make(mock.api).waitForComplete(99))
      expect(error).toBeInstanceOf(ChromeDownloadsError)
      expect(error).toMatchObject({ operation: "waitForComplete" })
      expect(mock.onChanged.listenerCount).toBe(0)
    }))

    it.effect("removes its listener when interrupted", () => Effect.gen(function*() {
      const mock = mockApi()
      const fiber = yield* Effect.forkScoped(make(mock.api).waitForComplete(7))
      yield* Effect.promise(() => mock.onChanged.waitForListener())
      yield* Fiber.interrupt(fiber)
      expect(mock.onChanged.listenerCount).toBe(0)
    }))
  })

  it.effect("provides an injected API and reads the global only when the live layer builds", () => Effect.gen(function*() {
    const { api } = mockApi()
    expect(yield* Effect.flatMap(ChromeDownloads, (downloads) => downloads.download({ url: item.url })).pipe(Effect.provide(layer(api)))).toBe(7)
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", {})), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeDownloads.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
    vi.stubGlobal("chrome", { downloads: api })
    expect(yield* Effect.flatMap(ChromeDownloads, (downloads) => downloads.erase({})).pipe(Effect.provide(layerLive))).toEqual([7])
  }))
})
