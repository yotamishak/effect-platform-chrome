// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Option, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeWindows, ChromeWindowsError, layer, layerLive, make } from "../src/ChromeWindows.js"
import type { ChromeWindowsApi, WindowEventFilter } from "../src/ChromeWindows.js"

const window: chrome.windows.Window = {
  id: 3, focused: false, alwaysOnTop: false, incognito: false, state: "normal", type: "normal"
}

const event = <Args extends Array<unknown>>() => {
  const listeners = new Set<(...args: Args) => void>()
  let notify!: () => void
  const added = new Promise<void>((resolve) => { notify = resolve })

  return {
    listeners,
    added,
    addListener: vi.fn((listener: (...args: Args) => void, _filter?: WindowEventFilter) => {
      listeners.add(listener)
      notify()
    }),
    removeListener: vi.fn((listener: (...args: Args) => void) => { listeners.delete(listener) }),
    emit: (...args: Args) => { for (const listener of listeners) listener(...args) }
  }
}

const mockApi = () => ({
  get: vi.fn(async (windowId: number, _queryOptions?: chrome.windows.QueryOptions) => ({ ...window, id: windowId })),
  getCurrent: vi.fn(async (_queryOptions?: chrome.windows.QueryOptions) => window),
  getLastFocused: vi.fn(async (_queryOptions?: chrome.windows.QueryOptions) => ({ ...window, focused: true })),
  getAll: vi.fn(async (_queryOptions?: chrome.windows.QueryOptions) => [window, { ...window, id: 4 }]),
  create: vi.fn(async (_createData?: chrome.windows.CreateData): Promise<chrome.windows.Window | undefined> => ({ ...window, id: 5 })),
  update: vi.fn(async (windowId: number, updateInfo: chrome.windows.UpdateInfo) => ({ ...window, id: windowId, focused: updateInfo.focused ?? false })),
  remove: vi.fn(async (_windowId: number) => {}),
  onCreated: event<[chrome.windows.Window]>(),
  onRemoved: event<[number]>(),
  onFocusChanged: event<[number]>(),
  onBoundsChanged: event<[chrome.windows.Window]>()
}) satisfies ChromeWindowsApi

describe("ChromeWindows", () => {
  it.effect("reads windows, passing query options only when given", () => Effect.gen(function*() {
    const api = mockApi()
    const windows = make(api)
    expect((yield* windows.get(5)).id).toBe(5)
    expect((yield* windows.getCurrent({ populate: true })).id).toBe(3)
    expect(api.get.mock.calls).toEqual([[5]])
    expect(api.getCurrent.mock.calls).toEqual([[{ populate: true }]])
    const options: chrome.windows.QueryOptions = { windowTypes: ["popup"] }
    expect((yield* windows.getAll()).map((each) => each.id)).toEqual([3, 4])
    yield* windows.getAll(options)
    expect((yield* windows.getLastFocused()).focused).toBe(true)
    yield* windows.getLastFocused(options)
    yield* windows.getCurrent()
    expect(api.getAll.mock.calls).toEqual([[], [options]])
    expect(api.getLastFocused.mock.calls).toEqual([[], [options]])
    expect(api.getCurrent.mock.calls[1]).toEqual([])
  }))

  it.effect("creates windows as an Option and removes them by id", () => Effect.gen(function*() {
    const api = mockApi()
    const windows = make(api)
    const createData: chrome.windows.CreateData = { type: "popup", focused: false, width: 0 }
    expect(yield* windows.create()).toEqual(Option.some({ ...window, id: 5 }))
    expect(Option.isSome(yield* windows.create(createData))).toBe(true)
    api.create.mockResolvedValueOnce(undefined)
    expect(yield* windows.create({ incognito: true })).toEqual(Option.none())
    expect(api.create.mock.calls).toEqual([[], [createData], [{ incognito: true }]])
    yield* windows.remove(0)
    expect(api.remove).toHaveBeenCalledExactlyOnceWith(0)
  }))

  it.effect("focuses a window through update", () => Effect.gen(function*() {
    const api = mockApi()
    expect((yield* make(api).focus(3)).focused).toBe(true)
    expect(api.update).toHaveBeenCalledExactlyOnceWith(3, { focused: true })
  }))

  it.effect("types rejected calls", () => Effect.gen(function*() {
    const api = mockApi()
    const cause = new Error("No window with id: 9.")
    api.update.mockRejectedValueOnce(cause)
    const error = yield* Effect.flip(make(api).focus(9))
    expect(error).toBeInstanceOf(ChromeWindowsError)
    expect(error).toMatchObject({ operation: "update", cause })
  }))

  it.effect.each(["get", "getCurrent", "getLastFocused", "getAll", "create", "update", "remove"] as const)(
    "types synchronous throws and rejections from %s", (operation) => Effect.gen(function*() {
      for (const synchronous of [true, false]) {
        const cause = new Error(`${operation} failed`)

        const fail = () => {
          if (synchronous) throw cause

          return Promise.reject(cause)
        }

        const api: ChromeWindowsApi = { ...mockApi(), [operation]: fail }
        const windows = make(api)

        const effects = {
          get: windows.get(3), getCurrent: windows.getCurrent(), getLastFocused: windows.getLastFocused(),
          getAll: windows.getAll(), create: windows.create(), update: windows.update(3, {}), remove: windows.remove(3)
        }

        const error = yield* Effect.flip(Effect.asVoid(effects[operation]))
        expect(error).toBeInstanceOf(ChromeWindowsError)
        expect(error).toMatchObject({ operation, cause })
      }
    })
  )

  it.effect("passes a window-type filter only when given and removes every listener", () => Effect.gen(function*() {
    const api = mockApi()
    const windows = make(api)
    const filter: WindowEventFilter = { windowTypes: ["normal", "popup"] }
    const created = yield* Effect.forkScoped(Stream.runCollect(Stream.take(windows.onCreated(), 1)))
    const removed = yield* Effect.forkScoped(Stream.runCollect(Stream.take(windows.onRemoved(filter), 1)))
    const focused = yield* Effect.forkScoped(Stream.runCollect(Stream.take(windows.onFocusChanged(filter), 2)))
    const bounds = yield* Effect.forkScoped(Stream.runCollect(Stream.take(windows.onBoundsChanged, 1)))
    const sources = [api.onCreated, api.onRemoved, api.onFocusChanged, api.onBoundsChanged]
    yield* Effect.promise(() => Promise.all(sources.map((source) => source.added)))
    expect(api.onCreated.addListener.mock.calls[0]).toHaveLength(1)
    expect(api.onRemoved.addListener.mock.calls[0]?.[1]).toBe(filter)
    expect(api.onFocusChanged.addListener.mock.calls[0]?.[1]).toBe(filter)
    expect(api.onBoundsChanged.addListener.mock.calls[0]).toHaveLength(1)
    api.onCreated.emit(window)
    api.onRemoved.emit(3)
    api.onFocusChanged.emit(4)
    api.onFocusChanged.emit(-1)
    api.onBoundsChanged.emit({ ...window, width: 640 })
    expect(yield* Effect.all([Fiber.join(created), Fiber.join(removed), Fiber.join(focused), Fiber.join(bounds)])).toEqual([
      [window], [3], [4, -1], [{ ...window, width: 640 }]
    ])

    for (const source of sources) {
      expect(source.listeners.size).toBe(0)
      expect(source.removeListener).toHaveBeenCalledExactlyOnceWith(source.addListener.mock.calls[0]?.[0])
    }
  }))

  it.effect.each(["onCreated", "onRemoved", "onFocusChanged", "onBoundsChanged"] as const)(
    "types listener registration failures from %s", (operation) => Effect.gen(function*() {
      const api = mockApi()
      const cause = new Error("listener unavailable")
      api[operation].addListener.mockImplementationOnce(() => { throw cause })
      const windows = make(api)

      const drains = {
        onCreated: Stream.runDrain(windows.onCreated({ windowTypes: ["normal"] })),
        onRemoved: Stream.runDrain(windows.onRemoved()),
        onFocusChanged: Stream.runDrain(windows.onFocusChanged({ windowTypes: ["devtools"] })),
        onBoundsChanged: Stream.runDrain(windows.onBoundsChanged)
      }

      const error = yield* Effect.flip(drains[operation])
      expect(error).toBeInstanceOf(ChromeWindowsError)
      expect(error).toMatchObject({ operation, cause })
      expect(api[operation].removeListener).toHaveBeenCalledTimes(1)
    })
  )

  it.effect("provides an injected API and reads the global only when the live layer builds", () => Effect.gen(function*() {
    const api = mockApi()
    expect((yield* Effect.flatMap(ChromeWindows, (windows) => windows.get(4)).pipe(Effect.provide(layer(api)))).id).toBe(4)
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", {})), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeWindows.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
    vi.stubGlobal("chrome", { windows: api })
    expect((yield* Effect.flatMap(ChromeWindows, (windows) => windows.remove(4)).pipe(Effect.provide(layerLive), Effect.as(true)))).toBe(true)
    expect(api.remove).toHaveBeenCalledExactlyOnceWith(4)
  }))
})
