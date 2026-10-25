// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Deferred, Effect, Exit, Fiber, Result, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeDownloadsError, DownloadInterruptedError, make } from "../../src/ChromeDownloads.js"
import type {
  ChromeDownloadsApi, ChromeDownloadsService, DeterminingFilename, DownloadDelta, DownloadItem, SuggestCallback
} from "../../src/ChromeDownloads.js"
import type { EventSource } from "../../src/internal/event.js"
import { makeEvent } from "../../src/testing/Event.js"
import { burstKeepsNewest, churn, expectPlanned, plannedNative, retained, seeded, settle, shuffled } from "./gesture-trio.support.js"

const itemOf = (id: number, state: DownloadItem["state"] = "in_progress"): DownloadItem => ({
  id, url: `https://files.example/${id}.bin`, finalUrl: `https://files.example/${id}.bin`, referrer: "",
  filename: `/downloads/${id}.bin`, mime: "application/octet-stream", incognito: false, danger: "safe", state,
  paused: false, canResume: false, exists: true, bytesReceived: 0, totalBytes: 100, fileSize: 100,
  startTime: "2026-10-22T10:00:00.000Z"
})

const mockApi = () => ({
  download: vi.fn(async (_options: chrome.downloads.DownloadOptions) => 1),
  search: vi.fn(async (_query: chrome.downloads.DownloadQuery): Promise<Array<DownloadItem>> => []),
  pause: vi.fn(async (_downloadId: number) => {}),
  resume: vi.fn(async (_downloadId: number) => {}),
  cancel: vi.fn(async (_downloadId: number) => {}),
  erase: vi.fn(async (_query: chrome.downloads.DownloadQuery): Promise<Array<number>> => []),
  removeFile: vi.fn(async (_downloadId: number) => {}),
  open: vi.fn(async (_downloadId: number) => {}),
  show: vi.fn((_downloadId: number) => {}),
  showDefaultFolder: vi.fn(() => {}),
  getFileIcon: vi.fn(async (_downloadId: number, _options?: chrome.downloads.GetFileIconOptions): Promise<string | undefined> => undefined),
  setUiOptions: vi.fn(async (_options: chrome.downloads.UiOptions) => {}),
  acceptDanger: vi.fn(async (_downloadId: number) => {}),
  onCreated: makeEvent<[DownloadItem]>().api,
  onChanged: makeEvent<[DownloadDelta]>().api,
  onErased: makeEvent<[number]>().api,
  onDeterminingFilename: makeEvent<[DownloadItem, SuggestCallback]>().api
}) satisfies ChromeDownloadsApi

type Operation =
  | "download" | "search" | "pause" | "resume" | "cancel" | "erase" | "removeFile" | "open" | "openFromUserGesture"
  | "show" | "getFileIcon" | "acceptDanger" | "acceptDangerFromUserGesture"

const operations: ReadonlyArray<Operation> = [
  "download", "search", "pause", "resume", "cancel", "erase", "removeFile", "open", "openFromUserGesture", "show",
  "getFileIcon", "acceptDanger", "acceptDangerFromUserGesture"
]

/** Runs call `index` of one operation, encoding the index in the download id or URL. */
const run = (downloads: ChromeDownloadsService, operation: Operation, index: number): Effect.Effect<unknown, ChromeDownloadsError> => {
  switch (operation) {
    case "download": return downloads.download({ url: `https://files.example/${index}.bin` })
    case "search": return downloads.search({ id: index })
    case "pause": return downloads.pause(index)
    case "resume": return downloads.resume(index)
    case "cancel": return downloads.cancel(index)
    case "erase": return downloads.erase({ id: index })
    case "removeFile": return downloads.removeFile(index)
    case "open": return downloads.open(index)
    case "openFromUserGesture": return downloads.openFromUserGesture(index)
    case "show": return downloads.show(index)
    case "getFileIcon": return downloads.getFileIcon(index, { size: 16 })
    case "acceptDanger": return downloads.acceptDanger(index)
    case "acceptDangerFromUserGesture": return downloads.acceptDangerFromUserGesture(index)
  }
}

const chromeMember = (operation: Operation): string => operation.replace("FromUserGesture", "")

describe("ChromeDownloads stress", () => {
  /** The burst and churn cases for one plain event, typed by its own arguments and values. */
  const eventSuite = <Args extends ReadonlyArray<unknown>, A>(
    event: "onCreated" | "onChanged" | "onErased",
    stream: (source: EventSource<Args>) => Stream.Stream<A, ChromeDownloadsError>,
    args: (index: number) => Args,
    idOf: (value: A) => number
  ) => describe(event, () => {
    it.effect("keeps exactly the newest 64 of a 4096-event burst", () =>
      burstKeepsNewest({ count: 4096, stream, args, project: idOf, expected: (index) => index }))

    it.effect("churns 512 subscriptions through every stage to zero listeners", () =>
      churn({ subscriptions: 512, seed: event.length, operation: event, stream, args, check: (value, index) => expect(idOf(value)).toBe(index) }))
  })

  eventSuite(
    "onCreated",
    (source: EventSource<[DownloadItem]>) => make({ ...mockApi(), onCreated: source }).onCreated,
    (index): [DownloadItem] => [itemOf(index)],
    (value) => value.id
  )

  eventSuite(
    "onChanged",
    (source: EventSource<[DownloadDelta]>) => make({ ...mockApi(), onChanged: source }).onChanged,
    (index): [DownloadDelta] => [{ id: index }],
    (value) => value.id
  )

  eventSuite(
    "onErased",
    (source: EventSource<[number]>) => make({ ...mockApi(), onErased: source }).onErased,
    (index): [number] => [index],
    (value) => value
  )

  describe("onDeterminingFilename", () => {
    it.effect("delivers the newest 64 of a 4096-event burst and answers every download exactly once", () => Effect.gen(function*() {
      const suggests = Array.from({ length: 4096 }, () => vi.fn<SuggestCallback>())
      let dropped = 0

      const delivered = yield* burstKeepsNewest<[DownloadItem, SuggestCallback], DeterminingFilename, number, ChromeDownloadsError>({
        count: 4096,
        stream: (source) => make({ ...mockApi(), onDeterminingFilename: source }).onDeterminingFilename.pipe(
          Stream.tap(() => Effect.sync(() => {
            dropped = suggests.filter((suggest) => suggest.mock.calls.length === 1).length
          }))
        ),
        args: (index): [DownloadItem, SuggestCallback] => [itemOf(index), suggests[index] ?? vi.fn<SuggestCallback>()],
        project: (event: DeterminingFilename) => event.item.id,
        expected: (index) => index
      })

      // Every dropped event was answered with the default name before the first delivery.
      expect(dropped).toBe(4096 - retained)
      expect(delivered).toHaveLength(retained)
      expect(suggests.every((suggest) => suggest.mock.calls.length === 1)).toBe(true)
      expect(suggests.every((suggest) => suggest.mock.calls[0]?.length === 0)).toBe(true)
    }))

    it.effect("churns 512 subscriptions to zero listeners, answering every download exactly once", () => Effect.gen(function*() {
      const suggests: Array<ReturnType<typeof vi.fn<SuggestCallback>>> = []

      yield* churn({
        subscriptions: 512,
        seed: 51,
        operation: "onDeterminingFilename",
        stream: (source: EventSource<[DownloadItem, SuggestCallback]>) => make({ ...mockApi(), onDeterminingFilename: source }).onDeterminingFilename,
        args: (index): [DownloadItem, SuggestCallback] => {
          const suggest = vi.fn<SuggestCallback>()
          suggests.push(suggest)

          return [itemOf(index), suggest]
        },
        check: (event, index) => expect(event.item.id).toBe(index)
      })

      expect(suggests.length).toBeGreaterThan(512)
      expect(suggests.every((suggest) => suggest.mock.calls.length === 1)).toBe(true)
    }))

    it.effect("routes 1024 answers, raced in concurrent pairs, to the right downloads exactly once", () => Effect.gen(function*() {
      const random = seeded(52)
      const event = makeEvent<[DownloadItem, SuggestCallback]>()
      const suggests = Array.from({ length: 1024 }, () => vi.fn<SuggestCallback>())
      const flow = { received: 0, target: 0, batch: Deferred.makeUnsafe<void>() }

      const consumer = yield* Effect.forkChild(make({ ...mockApi(), onDeterminingFilename: event.api }).onDeterminingFilename.pipe(
        Stream.take(1024),
        Stream.tap(() => Effect.sync(() => {
          flow.received++

          if (flow.received === flow.target) Deferred.doneUnsafe(flow.batch, Exit.void)
        })),
        Stream.mapEffect((value) => Effect.all([
          settle(value.suggest({ filename: `first-${value.item.id}.bin` })),
          settle(value.suggest({ filename: `second-${value.item.id}.bin` }))
        ], { concurrency: "unbounded" }), { concurrency: "unbounded" }),
        Stream.runCollect
      ))

      yield* Effect.promise(() => event.controls.waitForListener())
      const order = shuffled(random, Array.from({ length: 1024 }, (_, value) => value))

      // Batches of 32 stay under the buffer, and each is consumed before the next is emitted.
      for (let start = 0; start < order.length; start += 32) {
        flow.batch = Deferred.makeUnsafe<void>()
        flow.target = start + 32

        for (const index of order.slice(start, start + 32)) event.controls.emit(itemOf(index), suggests[index] ?? vi.fn<SuggestCallback>())

        yield* Deferred.await(flow.batch)
      }

      const pairs = yield* Fiber.join(consumer)
      expect(pairs).toHaveLength(1024)

      // Exactly one answer of each pair reaches Chrome; the loser fails typed instead of vanishing.
      for (const pair of pairs) {
        expect(pair.filter(Result.isSuccess)).toHaveLength(1)
        const [lost] = pair.filter(Result.isFailure)
        expect(lost?.failure).toBeInstanceOf(ChromeDownloadsError)
        expect(lost?.failure.operation).toBe("suggest")
      }

      suggests.forEach((suggest, index) => {
        expect(suggest).toHaveBeenCalledOnce()
        expect(suggest.mock.calls[0]?.[0]?.filename).toMatch(new RegExp(`^(first|second)-${index}\\.bin$`))
      })
      expect(event.controls.listenerCount).toBe(0)
    }))
  })

  it.effect("settles 1560 concurrent calls with interleaved rejections and throws, each typed", () => Effect.gen(function*() {
    const count = 1560
    const native = plannedNative(count, 61)
    const api = mockApi()
    const indexOfUrl = (url: string) => Number(/\/(\d+)\.bin$/.exec(url)?.[1])
    api.download.mockImplementation((options) => native.native(indexOfUrl(options.url), indexOfUrl(options.url)))
    api.search.mockImplementation((query) => native.native(query.id ?? -1, [itemOf(query.id ?? -1)]))
    api.erase.mockImplementation((query) => native.native(query.id ?? -1, [query.id ?? -1]))
    api.getFileIcon.mockImplementation((downloadId) => native.native(downloadId, downloadId % 2 === 0 ? `data:${downloadId}` : undefined))
    api.show.mockImplementation((downloadId) => native.nativeSync(downloadId))

    for (const method of ["pause", "resume", "cancel", "removeFile", "open", "acceptDanger"] as const) {
      api[method].mockImplementation((downloadId) => native.native(downloadId, undefined))
    }

    const downloads = make(api)
    const operationOf = (index: number): Operation => operations[index % operations.length] ?? "pause"

    const fiber = yield* Effect.forkChild(Effect.forEach(
      Array.from({ length: count }, (_, index) => index),
      (index) => settle(run(downloads, operationOf(index), index)),
      { concurrency: "unbounded" }
    ))

    yield* native.started
    native.release()
    const results = yield* Fiber.join(fiber)
    expect(native.calls).toBe(count)

    results.forEach((settled, index) => {
      const operation = operationOf(index)
      expectPlanned(settled, native.plan[index], { operation: chromeMember(operation), cause: native.causes[index], errorClass: ChromeDownloadsError })

      if (Result.isSuccess(settled) && operation === "download") expect(settled.success).toBe(index)

      if (Result.isSuccess(settled) && operation === "erase") expect(settled.success).toEqual([index])
    })
  }))

  it.effect("settles 1024 concurrent showDefaultFolder runs, matching every planned outcome once", () => Effect.gen(function*() {
    const count = 1024
    const native = plannedNative(count, 62)
    const api = mockApi()
    let next = 0
    api.showDefaultFolder.mockImplementation(() => native.nativeSync(next++))
    const downloads = make(api)
    const results = yield* Effect.forEach(Array.from({ length: count }), () => settle(downloads.showDefaultFolder), { concurrency: "unbounded" })
    const failures = results.flatMap((settled) => Result.isFailure(settled) ? [settled.failure] : [])
    const expected = native.causes.filter((_, index) => native.plan[index] !== "resolve")
    expect(failures.every((error) => error instanceof ChromeDownloadsError && error.operation === "showDefaultFolder")).toBe(true)
    expect(failures.map((error) => error.cause)).toEqual(expected)
  }))

  describe("waitForComplete", () => {
    type Fate = "complete" | "interrupted" | "interruptedWithoutReason" | "alreadyComplete" | "alreadyInterrupted" | "unknown" | "cancelled"

    const fates: ReadonlyArray<Fate> = [
      "complete", "interrupted", "interruptedWithoutReason", "alreadyComplete", "alreadyInterrupted", "unknown", "cancelled"
    ]

    const reasons: Record<Fate, string> = {
      complete: "", alreadyComplete: "", unknown: "", cancelled: "",
      interrupted: "SERVER_FAILED", interruptedWithoutReason: "CRASH", alreadyInterrupted: "NETWORK_FAILED"
    }

    it.effect("settles 1024 concurrent waiters in shuffled order, each with its own outcome, to zero listeners", () => Effect.gen(function*() {
      const count = 1024
      const random = seeded(71)
      const changed = makeEvent<[DownloadDelta]>()
      const state = new Map<number, DownloadItem>()
      const plan = Array.from({ length: count }, () => fates[Math.floor(random() * fates.length)] ?? "complete")
      const searched = yield* Deferred.make<void>()
      let searches = 0

      plan.forEach((fate, id) => {
        if (fate === "alreadyComplete") state.set(id, itemOf(id, "complete"))
        else if (fate === "alreadyInterrupted") state.set(id, { ...itemOf(id, "interrupted"), error: "NETWORK_FAILED" })
        else if (fate !== "unknown") state.set(id, itemOf(id))
      })

      const api = mockApi()

      api.search.mockImplementation(async (query) => {
        searches++

        if (searches === count) Deferred.doneUnsafe(searched, Exit.void)

        const found = state.get(query.id ?? -1)

        return found === undefined ? [] : [found]
      })

      const downloads = make({ ...api, onChanged: changed.api })
      const waiters = yield* Effect.forEach(plan, (_, id) => Effect.forkChild(Effect.result(downloads.waitForComplete(id))))
      yield* Deferred.await(searched)
      yield* Effect.yieldNow

      for (const id of shuffled(random, Array.from({ length: count }, (_, value) => value))) {
        const fate = plan[id]

        if (fate === "complete") {
          state.set(id, itemOf(id, "complete"))
          changed.controls.emit({ id, state: { previous: "in_progress", current: "complete" } })
        } else if (fate === "interrupted") {
          state.set(id, { ...itemOf(id, "interrupted"), error: "SERVER_FAILED" })
          changed.controls.emit({ id, state: { previous: "in_progress", current: "interrupted" }, error: { current: "SERVER_FAILED" } })
        } else if (fate === "interruptedWithoutReason") {
          state.set(id, { ...itemOf(id, "interrupted"), error: "CRASH" })
          changed.controls.emit({ id, state: { previous: "in_progress", current: "interrupted" } })
        } else if (fate === "cancelled") {
          const waiter = waiters[id]

          if (waiter !== undefined) yield* Fiber.interrupt(waiter)
        }
      }

      const exits = yield* Effect.forEach(waiters, Fiber.await)

      exits.forEach((exit, id) => {
        const fate = plan[id]

        if (fate === "cancelled") {
          expect(Exit.hasInterrupts(exit)).toBe(true)

          return
        }

        expect(Exit.isSuccess(exit)).toBe(true)

        if (!Exit.isSuccess(exit)) return

        const result = exit.value

        if (fate === "complete" || fate === "alreadyComplete") {
          expect(Result.isSuccess(result) && result.success.id === id && result.success.state === "complete").toBe(true)
        } else if (fate === "unknown") {
          expect(Result.isFailure(result) && result.failure instanceof ChromeDownloadsError && result.failure.operation === "search").toBe(true)
        } else {
          const reason = fate === undefined ? undefined : reasons[fate]
          expect(Result.isFailure(result) && result.failure instanceof DownloadInterruptedError && result.failure.downloadId === id && result.failure.reason === reason).toBe(true)
        }
      })

      for (const fate of fates) expect(plan).toContain(fate)
      expect(changed.controls.listenerCount).toBe(0)
    }))

    it.effect("interrupts 512 waiters at every stage of their scope and leaves no listener", () => Effect.gen(function*() {
      const random = seeded(72)
      const changed = makeEvent<[DownloadDelta]>()
      const stages = ["beforeStart", "duringSearch", "whileWaiting"] as const
      const plan = Array.from({ length: 512 }, () => stages[Math.floor(random() * stages.length)] ?? "whileWaiting")
      const api = mockApi()
      const searching = new Map<number, Deferred.Deferred<void>>()
      const answers = new Map<number, () => void>()

      api.search.mockImplementation((query) => {
        const id = query.id ?? -1
        const gate = searching.get(id)

        if (gate !== undefined) Deferred.doneUnsafe(gate, Exit.void)

        return new Promise<Array<DownloadItem>>((resolve) => {
          answers.set(id, () => resolve([itemOf(id)]))
        })
      })

      const downloads = make({ ...api, onChanged: changed.api })

      yield* Effect.forEach(plan, (stage, id) => Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        searching.set(id, gate)
        const fiber = yield* Effect.forkChild(downloads.waitForComplete(id))

        if (stage !== "beforeStart") yield* Deferred.await(gate)

        if (stage === "whileWaiting") {
          answers.get(id)?.()
          yield* Effect.yieldNow
          yield* Effect.yieldNow
        }

        yield* Fiber.interrupt(fiber)
        expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
      }), { concurrency: "unbounded", discard: true })

      for (const stage of stages) expect(plan).toContain(stage)
      expect(changed.controls.listenerCount).toBe(0)
    }))

    it.effect("picks the right item out of a 10,000-download search result", () => Effect.gen(function*() {
      const population = Array.from({ length: 10_000 }, (_, id) => itemOf(id, id === 9_999 ? "complete" : "in_progress"))
      const api = mockApi()
      api.search.mockResolvedValue(population)
      api.erase.mockResolvedValue(population.map((download) => download.id))
      const downloads = make(api)
      expect((yield* downloads.waitForComplete(9_999)).id).toBe(9_999)
      expect(yield* downloads.search({})).toHaveLength(10_000)
      expect(yield* downloads.erase({})).toHaveLength(10_000)
    }))
  })
})
