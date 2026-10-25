// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Exit, Fiber, Option, Schedule, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import {
  ChromeWindows, ChromeWindowsError, layer, layerLive, make, WINDOW_ID_CURRENT, WINDOW_ID_NONE
} from "../src/ChromeWindows.js"
import type { ChromeWindowsApi, ChromeWindowsService, WindowEventFilter } from "../src/ChromeWindows.js"
import { makeWindows } from "../src/testing/Windows.js"

const window: chrome.windows.Window = {
  id: 3, focused: false, alwaysOnTop: false, incognito: false, state: "normal", type: "normal"
}

/** A mock Chrome event with explicit registration gates and a stale-snapshot dispatcher. */
const event = <Args extends Array<unknown>>() => {
  const listeners = new Set<(...args: Args) => void>()
  const waiting: Array<{ readonly count: number, readonly resolve: () => void }> = []
  let adds = 0
  let frozen: Array<(...args: Args) => void> = []
  let failure: { readonly cause: Error, readonly afterAdding: boolean } | undefined

  /** Resolves once `count` listeners have been added in total. */
  const addedTimes = (count: number) => new Promise<void>((resolve) => {
    if (adds >= count) resolve()
    else waiting.push({ count, resolve })
  })

  return {
    listeners,
    addedTimes,
    get added() { return addedTimes(1) },
    /** Makes the next `addListener` throw `cause`, optionally after registering the listener. */
    failNext: (cause: Error, afterAdding = false) => { failure = { cause, afterAdding } },
    addListener: vi.fn((listener: (...args: Args) => void, _filter?: WindowEventFilter) => {
      const failing = failure
      failure = undefined

      if (failing !== undefined && !failing.afterAdding) throw failing.cause

      listeners.add(listener)

      if (failing !== undefined) throw failing.cause

      adds++

      for (const waiter of waiting.filter((each) => each.count <= adds)) {
        waiting.splice(waiting.indexOf(waiter), 1)
        waiter.resolve()
      }
    }),
    removeListener: vi.fn((listener: (...args: Args) => void) => { listeners.delete(listener) }),
    emit: (...args: Args) => { for (const listener of Array.from(listeners)) listener(...args) },
    /** Captures the current listeners, as Chrome snapshots them before dispatching. */
    freeze: () => { frozen = Array.from(listeners) },
    /** Dispatches to the captured listeners even if they have since been removed. */
    emitFrozen: (...args: Args) => { for (const listener of frozen) listener(...args) }
  }
}

const mockApi = () => ({
  get: vi.fn(async (windowId: number, _queryOptions?: chrome.windows.QueryOptions): Promise<chrome.windows.Window> => ({ ...window, id: windowId })),
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

type Operation = "get" | "getCurrent" | "getLastFocused" | "getAll" | "create" | "update" | "focus" | "remove"

/** Runs one service call with representative arguments. */
const call = (windows: ChromeWindowsService, operation: Operation): Effect.Effect<void, ChromeWindowsError> => {
  const effects: Record<Operation, Effect.Effect<unknown, ChromeWindowsError>> = {
    get: windows.get(3), getCurrent: windows.getCurrent(), getLastFocused: windows.getLastFocused(),
    getAll: windows.getAll(), create: windows.create(), update: windows.update(3, {}), focus: windows.focus(3),
    remove: windows.remove(3)
  }

  return Effect.asVoid(effects[operation])
}

/** The Chrome member each service call reaches. */
const memberOf = (operation: Operation): Exclude<Operation, "focus"> => operation === "focus" ? "update" : operation

const events = ["onCreated", "onRemoved", "onFocusChanged", "onBoundsChanged"] as const

/** Drains one service stream; filtered streams get `filter` when given. */
const drain = (windows: ChromeWindowsService, operation: typeof events[number], filter?: WindowEventFilter) => {
  const streams = {
    onCreated: Stream.map(windows.onCreated(filter), (value) => value.id),
    onRemoved: windows.onRemoved(filter),
    onFocusChanged: windows.onFocusChanged(filter),
    onBoundsChanged: Stream.map(windows.onBoundsChanged, (value) => value.id)
  }

  return streams[operation]
}

/** Emits one value on a mock event, shaped as that event's argument; `stale` uses the frozen snapshot. */
const emitOn = (api: ReturnType<typeof mockApi>, operation: typeof events[number], id: number, stale = false) => {
  if (operation === "onCreated") (stale ? api.onCreated.emitFrozen : api.onCreated.emit)({ ...window, id })
  else if (operation === "onBoundsChanged") (stale ? api.onBoundsChanged.emitFrozen : api.onBoundsChanged.emit)({ ...window, id })
  else (stale ? api[operation].emitFrozen : api[operation].emit)(id)
}

describe("ChromeWindows", () => {
  it("exposes Chrome's window id constants", () => {
    expect(WINDOW_ID_NONE).toBe(-1)
    expect(WINDOW_ID_CURRENT).toBe(-2)
  })

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
    yield* windows.get(WINDOW_ID_CURRENT, options)
    expect(api.getAll.mock.calls).toEqual([[], [options]])
    expect(api.getLastFocused.mock.calls).toEqual([[], [options]])
    expect(api.getCurrent.mock.calls[1]).toEqual([])
    expect(api.get.mock.calls[1]).toEqual([-2, options])
    expect(api.get.mock.calls[1]?.[1]).toBe(options)
  }))

  it.effect("omits explicitly undefined optional arguments", () => Effect.gen(function*() {
    const api = mockApi()
    const windows = make(api)
    yield* windows.get(7, undefined)
    yield* windows.getCurrent(undefined)
    yield* windows.getLastFocused(undefined)
    yield* windows.getAll(undefined)
    yield* windows.create(undefined)

    for (const member of [api.getCurrent, api.getLastFocused, api.getAll, api.create]) {
      expect(member.mock.calls).toEqual([[]])
    }

    expect(api.get.mock.calls).toEqual([[7]])
  }))

  it.effect("passes empty objects through instead of dropping them", () => Effect.gen(function*() {
    const api = mockApi()
    const windows = make(api)
    const empty: chrome.windows.QueryOptions = {}
    const createData: chrome.windows.CreateData = {}
    yield* windows.getAll(empty)
    yield* windows.create(createData)
    yield* windows.update(3, {})
    expect(api.getAll.mock.calls[0]?.[0]).toBe(empty)
    expect(api.create.mock.calls[0]?.[0]).toBe(createData)
    expect(api.update.mock.calls).toEqual([[3, {}]])
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
    expect(yield* windows.remove(0)).toBeUndefined()
    expect(api.remove).toHaveBeenCalledExactlyOnceWith(0)
  }))

  it.effect("returns lists unchanged, including empty ones", () => Effect.gen(function*() {
    const api = mockApi()
    api.getAll.mockResolvedValueOnce([])
    expect(yield* make(api).getAll()).toEqual([])
  }))

  it.effect("focuses a window through update", () => Effect.gen(function*() {
    const api = mockApi()
    expect((yield* make(api).focus(3)).focused).toBe(true)
    expect(api.update).toHaveBeenCalledExactlyOnceWith(3, { focused: true })
  }))

  it.effect("calls Chrome lazily, once per run", () => Effect.gen(function*() {
    const api = mockApi()
    const windows = make(api)
    const effects = [windows.getAll(), windows.getCurrent(), windows.create(), windows.focus(3), windows.remove(3)]
    const members = [api.getAll, api.getCurrent, api.create, api.update, api.remove]

    for (const member of members) expect(member).not.toHaveBeenCalled()

    yield* Effect.all(effects)
    yield* Effect.all(effects)

    for (const member of members) expect(member).toHaveBeenCalledTimes(2)
  }))

  it.effect("types rejected calls", () => Effect.gen(function*() {
    const api = mockApi()
    const cause = new Error("No window with id: 9.")
    api.update.mockRejectedValueOnce(cause)
    const error = yield* Effect.flip(make(api).focus(9))
    expect(error).toBeInstanceOf(ChromeWindowsError)
    expect(error.operation).toBe("update")
    expect(error.cause).toBe(cause)
  }))

  it.effect.each(["get", "getCurrent", "getLastFocused", "getAll", "create", "update", "focus", "remove"] as const)(
    "types synchronous throws and rejections from %s", (operation) => Effect.gen(function*() {
      for (const synchronous of [true, false]) {
        const cause = new Error(`${operation} failed`)

        const fail = () => {
          if (synchronous) throw cause

          return Promise.reject(cause)
        }

        const api: ChromeWindowsApi = { ...mockApi(), [memberOf(operation)]: fail }
        const error = yield* Effect.flip(call(make(api), operation))
        expect(error).toBeInstanceOf(ChromeWindowsError)
        expect(error.operation).toBe(memberOf(operation))
        expect(error.cause).toBe(cause)
      }
    })
  )

  it.effect("keeps non-Error causes unchanged", () => Effect.gen(function*() {
    const api = mockApi()
    const cause = { message: "plain object" }
    api.getAll.mockRejectedValueOnce("a string")
    api.get.mockRejectedValueOnce(cause)
    api.remove.mockRejectedValueOnce(undefined)
    const windows = make(api)
    expect((yield* Effect.flip(windows.getAll())).cause).toBe("a string")
    expect((yield* Effect.flip(windows.get(1))).cause).toBe(cause)
    expect(yield* Effect.flip(windows.remove(1))).toMatchObject({ operation: "remove", cause: undefined })
  }))

  it.effect("interrupts an in-flight call without waiting for Chrome", () => Effect.gen(function*() {
    const api = mockApi()
    let settle!: (window: chrome.windows.Window) => void
    let started!: () => void
    const called = new Promise<void>((resolve) => { started = resolve })
    api.get.mockImplementationOnce(() => new Promise<chrome.windows.Window>((resolve) => {
      settle = resolve
      started()
    }))
    const fiber = yield* Effect.forkChild(make(api).get(1))
    yield* Effect.promise(() => called)
    yield* Fiber.interrupt(fiber)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.hasInterrupts(exit)).toBe(true)
    settle(window)
    expect(api.get).toHaveBeenCalledTimes(1)
  }))

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
    api.onFocusChanged.emit(WINDOW_ID_NONE)
    api.onBoundsChanged.emit({ ...window, width: 640 })
    expect(yield* Effect.all([Fiber.join(created), Fiber.join(removed), Fiber.join(focused), Fiber.join(bounds)])).toEqual([
      [window], [3], [4, -1], [{ ...window, width: 640 }]
    ])

    for (const source of sources) {
      expect(source.listeners.size).toBe(0)
      expect(source.removeListener).toHaveBeenCalledExactlyOnceWith(source.addListener.mock.calls[0]?.[0])
    }
  }))

  it.effect.each(["onCreated", "onRemoved", "onFocusChanged"] as const)(
    "passes %s filters (including an empty one) unchanged and omits an absent one", (operation) => Effect.gen(function*() {
      const api = mockApi()
      const windows = make(api)
      const empty: WindowEventFilter = { windowTypes: [] }
      const devtools: WindowEventFilter = { windowTypes: ["devtools"] }

      for (const [index, filter] of [undefined, empty, devtools].entries()) {
        const fiber = yield* Effect.forkChild(Stream.runDrain(drain(windows, operation, filter)))
        yield* Effect.promise(() => api[operation].addedTimes(index + 1))
        expect(api[operation].listeners.size).toBe(1)
        yield* Fiber.interrupt(fiber)
        expect(api[operation].listeners.size).toBe(0)
      }

      const calls = api[operation].addListener.mock.calls
      expect(calls.map((args) => args.length)).toEqual([1, 2, 2])
      expect(calls[1]?.[1]).toBe(empty)
      expect(calls[2]?.[1]).toBe(devtools)
      expect(api[operation].removeListener.mock.calls.map(([listener]) => listener)).toEqual(calls.map(([listener]) => listener))
    })
  )

  it.effect.each(events)("removes the %s listener when the consuming fiber is interrupted", (operation) => Effect.gen(function*() {
    const api = mockApi()
    const windows = make(api)
    const received: Array<number | undefined> = []
    const fiber = yield* Effect.forkChild(Stream.runForEach(drain(windows, operation), (id) => Effect.sync(() => { received.push(id) })))
    yield* Effect.promise(() => api[operation].added)
    const listener = api[operation].addListener.mock.calls[0]?.[0]
    api[operation].freeze()
    yield* Fiber.interrupt(fiber)
    expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
    expect(api[operation].listeners.size).toBe(0)
    expect(api[operation].removeListener).toHaveBeenCalledExactlyOnceWith(listener)
    // A late dispatch through a stale listener snapshot is ignored rather than buffered or thrown.
    expect(() => emitOn(api, operation, 9, true)).not.toThrow()
    expect(received).toEqual([])
  }))

  it.effect.each(events)("gives each %s consumption its own listener and stream", (operation) => Effect.gen(function*() {
    const api = mockApi()
    const windows = make(api)
    const first = yield* Effect.forkChild(Stream.runCollect(Stream.take(drain(windows, operation), 2)))
    yield* Effect.promise(() => api[operation].added)
    const second = yield* Effect.forkChild(Stream.runCollect(Stream.take(drain(windows, operation), 1)))
    yield* Effect.promise(() => api[operation].addedTimes(2))
    const registered = api[operation].addListener.mock.calls.map(([listener]) => listener)
    expect(new Set(registered).size).toBe(2)
    emitOn(api, operation, 7)
    emitOn(api, operation, 8)
    expect(yield* Fiber.join(first)).toEqual([7, 8])
    expect(yield* Fiber.join(second)).toEqual([7])
    expect(api[operation].listeners.size).toBe(0)
    expect(api[operation].removeListener).toHaveBeenCalledTimes(2)
  }))

  it.effect.each(events)("retains the newest 64 %s events when the consumer falls behind", (operation) => Effect.gen(function*() {
    const api = mockApi()
    const windows = make(api)
    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(drain(windows, operation), 64)))
    yield* Effect.promise(() => api[operation].added)

    for (let id = 0; id < 65; id++) emitOn(api, operation, id)

    expect(yield* Fiber.join(fiber)).toEqual(Array.from({ length: 64 }, (_, index) => index + 1))
    expect(api[operation].listeners.size).toBe(0)
  }))

  it.effect.each(events)("types listener registration failures from %s", (operation) => Effect.gen(function*() {
    const api = mockApi()
    const cause = new Error("listener unavailable")
    api[operation].failNext(cause)
    const windows = make(api)
    const error = yield* Effect.flip(Stream.runDrain(drain(windows, operation, { windowTypes: ["normal"] })))
    expect(error).toBeInstanceOf(ChromeWindowsError)
    expect(error.operation).toBe(operation)
    expect(error.cause).toBe(cause)
    expect(api[operation].removeListener).toHaveBeenCalledTimes(1)
  }))

  it.effect.each(events)("removes a %s listener that was added before registration threw", (operation) => Effect.gen(function*() {
    const api = mockApi()
    const cause = new Error("added, then failed")
    api[operation].failNext(cause, true)
    const error = yield* Effect.flip(Stream.runDrain(drain(make(api), operation)))
    expect(error).toMatchObject({ operation })
    expect(error.cause).toBe(cause)
    expect(api[operation].listeners.size).toBe(0)
  }))

  it.effect.each(events)("types a failure reading the %s event", (operation) => Effect.gen(function*() {
    const cause = new Error("event getter failed")
    const api = mockApi()

    const broken: ChromeWindowsApi = {
      ...api,
      get [operation](): never { throw cause }
    }

    const error = yield* Effect.flip(Stream.runDrain(drain(make(broken), operation, { windowTypes: ["popup"] })))
    expect(error).toBeInstanceOf(ChromeWindowsError)
    expect(error.operation).toBe(operation)
    expect(error.cause).toBe(cause)
    expect(api[operation].addListener).not.toHaveBeenCalled()
  }))

  it.effect("re-subscribes once after a failed registration, leaving a single listener", () => Effect.gen(function*() {
    const api = mockApi()
    api.onFocusChanged.failNext(new Error("added, then failed"), true)

    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(
      Stream.retry(make(api).onFocusChanged({ windowTypes: ["normal"] }), Schedule.recurs(1)), 2
    )))

    yield* Effect.promise(() => api.onFocusChanged.added)
    expect(api.onFocusChanged.addListener).toHaveBeenCalledTimes(2)
    expect(api.onFocusChanged.listeners.size).toBe(1)
    api.onFocusChanged.emit(4)
    api.onFocusChanged.emit(WINDOW_ID_NONE)
    expect(yield* Fiber.join(fiber)).toEqual([4, WINDOW_ID_NONE])
    expect(api.onFocusChanged.listeners.size).toBe(0)
    expect(api.onFocusChanged.removeListener).toHaveBeenCalledTimes(2)
  }))

  it.effect("reads no events and registers nothing until a stream runs", () => Effect.gen(function*() {
    let reads = 0
    const api = mockApi()

    const counted: ChromeWindowsApi = {
      ...api,
      get onCreated() {
        reads++

        return api.onCreated
      }
    }

    const windows = make(counted)
    const stream = windows.onCreated()
    expect(reads).toBe(0)
    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(stream, 1)))
    yield* Effect.promise(() => api.onCreated.added)
    expect(reads).toBe(1)
    api.onCreated.emit(window)
    expect(yield* Fiber.join(fiber)).toEqual([window])
  }))

  it.effect("provides an injected API and reads the global only when the live layer builds", () => Effect.gen(function*() {
    const api = mockApi()
    expect((yield* Effect.flatMap(ChromeWindows, (windows) => windows.get(4)).pipe(Effect.provide(layer(api)))).id).toBe(4)
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", {})), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeWindows.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
    vi.stubGlobal("chrome", { windows: api })
    expect((yield* Effect.flatMap(ChromeWindows, (windows) => windows.remove(4)).pipe(Effect.provide(layerLive), Effect.as(true)))).toBe(true)
    expect(api.remove).toHaveBeenCalledExactlyOnceWith(4)
    const replacement = mockApi()
    vi.stubGlobal("chrome", { windows: replacement })
    yield* Effect.flatMap(ChromeWindows, (windows) => windows.remove(5)).pipe(Effect.provide(layerLive))
    expect(replacement.remove).toHaveBeenCalledExactlyOnceWith(5)
    expect(api.remove).toHaveBeenCalledTimes(1)
  }))

  it.effect("fails the live layer with initialize when there is no chrome global", () => Effect.gen(function*() {
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", undefined)), () => Effect.sync(() => vi.unstubAllGlobals()))
    const error = yield* Effect.flip(ChromeWindows.pipe(Effect.provide(layerLive)))
    expect(error).toBeInstanceOf(ChromeWindowsError)
    expect(error.operation).toBe("initialize")
    expect(error.cause).toEqual(new Error("chrome.windows is unavailable in this context"))
  }))

  it.effect("never touches globals from make or the service", () => Effect.gen(function*() {
    const trap = new Proxy({}, { get: () => { throw new Error("global chrome was read") } })
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", trap)), () => Effect.sync(() => vi.unstubAllGlobals()))
    const api = mockApi()
    const windows = make(api)
    yield* Effect.all([windows.get(1), windows.getAll(), windows.create(), windows.focus(1), windows.remove(1)])
    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(windows.onRemoved(), 1)))
    yield* Effect.promise(() => api.onRemoved.added)
    api.onRemoved.emit(1)
    expect(yield* Fiber.join(fiber)).toEqual([1])
  }))
})

describe("ChromeTesting windows fixture", () => {
  const service = (fixture: ReturnType<typeof makeWindows>) => make(fixture.api)

  it.effect("creates focused windows by default and unfocused ones on request", () => Effect.gen(function*() {
    const fixture = makeWindows()
    const windows = service(fixture)
    const first = Option.getOrThrow(yield* windows.create({ left: 5, top: 6, width: 300, height: 200, state: "normal" }))
    expect(first).toMatchObject({ id: 1, focused: true, left: 5, top: 6, width: 300, height: 200, state: "normal", type: "normal" })
    const background = Option.getOrThrow(yield* windows.create({ focused: false }))
    expect(background.focused).toBe(false)
    expect(fixture.controls.focused).toBe(1)
    const minimized = Option.getOrThrow(yield* windows.create({ state: "minimized" }))
    expect(minimized).toMatchObject({ focused: false, state: "minimized" })
    expect(fixture.controls.focused).toBe(1)
    const maximized = Option.getOrThrow(yield* windows.create({ state: "maximized" }))
    expect(maximized).toMatchObject({ focused: true, state: "maximized" })
    expect((yield* windows.create({ type: "panel" })).pipe(Option.map((each) => each.type))).toEqual(Option.some("popup"))
  }))

  it.effect.each([
    { state: "minimized", focused: true },
    { state: "minimized", width: 10 },
    { state: "maximized", focused: false },
    { state: "maximized", left: 0 },
    { state: "fullscreen", top: 0 },
    { state: "fullscreen", focused: false },
    { state: "locked-fullscreen", height: 1 }
  ] satisfies Array<chrome.windows.CreateData>)("rejects create(%o) as Chrome does", (createData) => Effect.gen(function*() {
    const fixture = makeWindows()
    const error = yield* Effect.flip(service(fixture).create(createData))
    expect(error).toMatchObject({ operation: "create", cause: new Error("Invalid value for state") })
    expect(yield* service(fixture).getAll()).toEqual([])
    expect(fixture.controls.window(1)).toBeUndefined()
  }))

  it.effect("rejects locked fullscreen for lack of its permission", () => Effect.gen(function*() {
    const fixture = makeWindows()
    const windows = service(fixture)
    const permission = /lockWindowFullscreenPrivate/
    expect((yield* Effect.flip(windows.create({ state: "locked-fullscreen" }))).cause).toMatchObject({ message: expect.stringMatching(permission) })
    const id = Option.getOrThrow(yield* windows.create()).id ?? -1
    expect((yield* Effect.flip(windows.update(id, { state: "locked-fullscreen" }))).cause).toMatchObject({ message: expect.stringMatching(permission) })
    const locked = fixture.controls.seed({ state: "locked-fullscreen" }).id ?? -1
    expect(yield* Effect.flip(windows.remove(locked))).toMatchObject({ operation: "remove" })
    expect(fixture.controls.window(locked)).toBeDefined()
  }))

  it.effect.each([
    { state: "minimized", width: 10 },
    { state: "maximized", top: 1 },
    { state: "fullscreen", left: 1 },
    { state: "minimized", focused: true },
    { state: "maximized", focused: false },
    { state: "fullscreen", focused: false }
  ] satisfies Array<chrome.windows.UpdateInfo>)("rejects update(%o) and leaves the window unchanged", (updateInfo) => Effect.gen(function*() {
    const fixture = makeWindows()
    const windows = service(fixture)
    const before = Option.getOrThrow(yield* windows.create())
    const error = yield* Effect.flip(windows.update(before.id ?? -1, updateInfo))
    expect(error).toMatchObject({ operation: "update", cause: new Error("Invalid value for state") })
    expect(yield* windows.get(before.id ?? -1)).toEqual(before)
  }))

  it.effect("applies a normal state with bounds and bounds on a maximized window", () => Effect.gen(function*() {
    const fixture = makeWindows()
    const windows = service(fixture)
    const bounds = yield* Effect.forkChild(Stream.runCollect(Stream.take(windows.onBoundsChanged, 2)))
    yield* Effect.promise(() => fixture.controls.onBoundsChanged.waitForListener())
    const id = Option.getOrThrow(yield* windows.create()).id ?? -1
    yield* windows.update(id, { state: "maximized" })
    expect(yield* windows.update(id, { width: 640 })).toMatchObject({ state: "maximized", width: 640 })
    yield* windows.update(id, { width: 640 })
    expect(yield* windows.update(id, { state: "normal", left: 9 })).toMatchObject({ state: "normal", left: 9 })
    expect((yield* Fiber.join(bounds)).map((window) => [window.width, window.left])).toEqual([[640, 0], [640, 9]])
  }))

  it.effect("minimizing the focused window refocuses the previous one; focusing restores it", () => Effect.gen(function*() {
    const fixture = makeWindows()
    const windows = service(fixture)
    const focusChanges = yield* Effect.forkChild(Stream.runCollect(Stream.take(windows.onFocusChanged(), 6)))
    yield* Effect.promise(() => fixture.controls.onFocusChanged.waitForListener())
    const first = Option.getOrThrow(yield* windows.create({ state: "maximized" })).id ?? -1
    const second = Option.getOrThrow(yield* windows.create()).id ?? -1
    expect(yield* windows.update(second, { state: "minimized" })).toMatchObject({ state: "minimized", focused: false })
    expect(fixture.controls.focused).toBe(first)
    yield* windows.update(first, { state: "minimized" })
    expect(fixture.controls.focused).toBe(WINDOW_ID_NONE)
    expect(yield* windows.focus(first)).toMatchObject({ state: "maximized", focused: true })
    yield* windows.remove(first)
    expect(fixture.controls.focused).toBe(WINDOW_ID_NONE)
    expect(yield* windows.focus(second)).toMatchObject({ state: "normal", focused: true })
    expect(yield* Fiber.join(focusChanges)).toEqual([first, second, first, WINDOW_ID_NONE, first, WINDOW_ID_NONE])
  }))

  it.effect("resolves WINDOW_ID_CURRENT to the last active window", () => Effect.gen(function*() {
    const fixture = makeWindows()
    const windows = service(fixture)
    expect(yield* Effect.flip(windows.get(WINDOW_ID_CURRENT))).toMatchObject({ operation: "get", cause: new Error("No current window") })
    expect(yield* Effect.flip(windows.getCurrent())).toMatchObject({ cause: new Error("No current window") })
    expect(yield* Effect.flip(windows.getLastFocused())).toMatchObject({ cause: new Error("No last-focused window") })
    const first = Option.getOrThrow(yield* windows.create()).id ?? -1
    const second = Option.getOrThrow(yield* windows.create()).id ?? -1
    expect((yield* windows.get(WINDOW_ID_CURRENT)).id).toBe(second)
    expect((yield* windows.update(WINDOW_ID_CURRENT, { width: 10 })).id).toBe(second)
    yield* windows.remove(WINDOW_ID_CURRENT)
    expect(fixture.controls.window(second)).toBeUndefined()
    expect((yield* windows.getCurrent()).id).toBe(first)
  }))

  it.effect("orders never-focused windows after focused ones, oldest first", () => Effect.gen(function*() {
    const fixture = makeWindows()
    const windows = service(fixture)
    const ids = [fixture.controls.seed(), fixture.controls.seed(), fixture.controls.seed()].map((window) => window.id)
    expect((yield* windows.getLastFocused()).id).toBe(ids[0])
    yield* windows.focus(ids[2] ?? -1)
    expect((yield* windows.getLastFocused()).id).toBe(ids[2])
    yield* windows.update(ids[2] ?? -1, { focused: false })
    expect(fixture.controls.focused).toBe(WINDOW_ID_NONE)
    expect((yield* windows.getCurrent()).id).toBe(ids[2])
    yield* windows.remove(ids[2] ?? -1)
    expect((yield* windows.getLastFocused()).id).toBe(ids[0])
  }))

  it.effect("reports -1 to focus listeners that cannot see the focused window", () => Effect.gen(function*() {
    const fixture = makeWindows()
    const unfiltered: Array<number> = []
    const tools: Array<number> = []
    const none: Array<number> = []
    fixture.api.onFocusChanged.addListener((windowId) => { unfiltered.push(windowId) })
    fixture.api.onFocusChanged.addListener((windowId) => { tools.push(windowId) }, { windowTypes: ["devtools"] })
    fixture.api.onFocusChanged.addListener((windowId) => { none.push(windowId) }, { windowTypes: [] })
    const normal = fixture.controls.seed({ focused: true }).id ?? -1
    const devtools = fixture.controls.seed({ type: "devtools", focused: true }).id ?? -1
    yield* Effect.promise(() => fixture.api.update(normal, { focused: false }))
    expect(unfiltered).toEqual([normal, WINDOW_ID_NONE])
    expect(tools).toEqual([WINDOW_ID_NONE, devtools])
    expect(none).toEqual([WINDOW_ID_NONE, WINDOW_ID_NONE])
    yield* Effect.promise(() => fixture.api.remove(devtools))
    expect(unfiltered).toEqual([normal, WINDOW_ID_NONE, normal])
    expect(tools).toEqual([WINDOW_ID_NONE, devtools, WINDOW_ID_NONE])
    expect(fixture.controls.onFocusChanged.emit(42)).toEqual([])
    expect(none.at(-1)).toBe(42)
  }))

  it.effect("keeps devtools windows out of bounds events and unfiltered queries", () => Effect.gen(function*() {
    const fixture = makeWindows()
    const windows = service(fixture)
    const bounds = yield* Effect.forkChild(Stream.runCollect(Stream.take(windows.onBoundsChanged, 1)))
    yield* Effect.promise(() => fixture.controls.onBoundsChanged.waitForListener())
    const devtools = fixture.controls.seed({ type: "devtools" }).id ?? -1
    const app = fixture.controls.seed({ type: "app" }).id ?? -1
    expect((yield* windows.update(devtools, { width: 1 })).width).toBe(1)
    yield* windows.update(app, { width: 2 })
    expect((yield* Fiber.join(bounds)).map((window) => window.id)).toEqual([app])
    expect(yield* windows.getAll()).toEqual([])
    expect((yield* windows.getAll({ windowTypes: ["devtools", "app"] })).map((window) => window.id)).toEqual([devtools, app])
    expect(yield* Effect.flip(windows.get(app))).toMatchObject({ cause: new Error(`No window with id: ${app}.`) })
  }))

  it.effect("hides incognito windows without incognito access", () => Effect.gen(function*() {
    const fixture = makeWindows()
    const windows = service(fixture)
    const createdIds: Array<number> = []
    const focused: Array<number> = []
    fixture.api.onCreated.addListener((window) => { createdIds.push(window.id ?? -1) })
    fixture.api.onFocusChanged.addListener((windowId) => { focused.push(windowId) })
    expect(fixture.controls.incognitoAccess).toBe(true)
    const visible = Option.getOrThrow(yield* windows.create({ incognito: true })).id ?? -1
    fixture.controls.incognitoAccess = false
    expect(yield* windows.create({ incognito: true })).toEqual(Option.none())
    const hidden = fixture.controls.focused
    expect(fixture.controls.window(hidden)?.incognito).toBe(true)
    expect(yield* windows.getAll()).toEqual([])
    expect(yield* Effect.flip(windows.get(visible))).toMatchObject({ operation: "get" })
    expect(yield* Effect.flip(windows.remove(hidden))).toMatchObject({ operation: "remove" })
    expect(yield* Effect.flip(windows.getLastFocused())).toMatchObject({ operation: "getLastFocused" })
    expect(createdIds).toEqual([visible])
    expect(focused).toEqual([visible, WINDOW_ID_NONE])
    fixture.controls.incognitoAccess = true
    expect((yield* windows.getAll()).map((window) => window.id)).toEqual([visible, hidden])
  }))

  it.effect("ignores a duplicate listener, keeping its first filter", () => Effect.gen(function*() {
    const fixture = makeWindows()
    const seen: Array<number> = []
    const listener = (windowId: number) => { seen.push(windowId) }

    fixture.api.onRemoved.addListener(listener, { windowTypes: ["popup"] })
    fixture.api.onRemoved.addListener(listener)
    expect(fixture.controls.onRemoved.listenerCount).toBe(1)
    const normal = fixture.controls.seed().id ?? -1
    const popup = fixture.controls.seed({ type: "popup" }).id ?? -1
    yield* Effect.promise(() => fixture.api.remove(normal))
    yield* Effect.promise(() => fixture.api.remove(popup))
    expect(seen).toEqual([popup])
    fixture.api.onRemoved.removeListener(() => {})
    fixture.api.onRemoved.removeListener(listener)
    fixture.api.onRemoved.removeListener(listener)
    expect(fixture.controls.onRemoved.listenerCount).toBe(0)
  }))

  it.effect("types simulated registration failures through the service", () => Effect.gen(function*() {
    const fixture = makeWindows()
    const cause = new Error("registration refused")
    fixture.controls.onFocusChanged.failNext("addListener", cause)
    const error = yield* Effect.flip(Stream.runDrain(service(fixture).onFocusChanged({ windowTypes: ["normal"] })))
    expect(error).toMatchObject({ operation: "onFocusChanged" })
    expect(error.cause).toBe(cause)
    expect(fixture.controls.onFocusChanged.listenerCount).toBe(0)
  }))

  it.effect("returns copies that callers cannot mutate", () => Effect.gen(function*() {
    const fixture = makeWindows()
    const windows = service(fixture)
    const created = Option.getOrThrow(yield* windows.create())
    created.width = 1
    const listed = yield* windows.getAll()
    listed.splice(0)
    const fetched = yield* windows.get(created.id ?? -1)
    expect(fetched.width).toBe(1280)
    expect(yield* windows.getAll()).toHaveLength(1)
  }))

  it.effect("focuses an already focused window without another event", () => Effect.gen(function*() {
    const fixture = makeWindows()
    const focused: Array<number> = []
    fixture.api.onFocusChanged.addListener((windowId) => { focused.push(windowId) })
    const windows = service(fixture)
    const id = Option.getOrThrow(yield* windows.create()).id ?? -1
    yield* windows.focus(id)
    yield* windows.update(id, { drawAttention: true })
    expect(focused).toEqual([id])
  }))

  it.effect("never hands out an id that seed was given explicitly", () => Effect.gen(function*() {
    const fixture = makeWindows()
    const windows = service(fixture)
    expect(fixture.controls.seed({ id: 2, type: "popup" }).id).toBe(2)
    const created = [yield* windows.create(), yield* windows.create()].map((window) => Option.getOrThrow(window).id)
    expect(created).toEqual([3, 4])
    expect((yield* windows.get(2)).type).toBe("popup")
    expect(yield* windows.getAll()).toHaveLength(3)
    expect(() => fixture.controls.seed({ id: 3, type: "popup" })).toThrow("Window 3 is already open")
    expect(fixture.controls.window(3)?.type).toBe("normal")
    expect(fixture.controls.seed({ id: undefined }).id).toBe(5)
    yield* windows.remove(2)
    expect(fixture.controls.seed({ id: 2 }).id).toBe(2)
  }))

  it.effect("reports a window a listener closes as focused, then refocuses, as Chrome does", () => Effect.gen(function*() {
    const fixture = makeWindows()
    const windows = service(fixture)
    const focused: Array<number> = []
    const closing: Array<Promise<void>> = []
    fixture.api.onFocusChanged.addListener((windowId) => { focused.push(windowId) })
    const closeOnCreate = (window: chrome.windows.Window) => { closing.push(fixture.api.remove(window.id ?? WINDOW_ID_NONE)) }

    fixture.api.onCreated.addListener(closeOnCreate)
    const created = Option.getOrThrow(yield* windows.create()).id ?? WINDOW_ID_NONE
    expect(fixture.controls.window(created)).toBeUndefined()
    expect(fixture.controls.focused).toBe(WINDOW_ID_NONE)
    expect(focused).toEqual([created, WINDOW_ID_NONE])
    fixture.api.onCreated.removeListener(closeOnCreate)
    const kept = Option.getOrThrow(yield* windows.create()).id ?? WINDOW_ID_NONE
    const moved = fixture.controls.seed().id ?? WINDOW_ID_NONE
    fixture.api.onBoundsChanged.addListener((window) => { closing.push(fixture.api.remove(window.id ?? WINDOW_ID_NONE)) })
    expect(yield* windows.update(moved, { width: 10, focused: true })).toMatchObject({ id: moved, width: 10, focused: true })
    yield* Effect.promise(() => Promise.all(closing))
    expect(fixture.controls.window(moved)).toBeUndefined()
    expect(fixture.controls.focused).toBe(kept)
    expect(focused).toEqual([created, WINDOW_ID_NONE, kept, moved, kept])
  }))

  it.effect("lets a listener's own calls land after the call that fired it, as Chrome dispatches", () => Effect.gen(function*() {
    const fixture = makeWindows()
    const windows = service(fixture)
    const focused: Array<number> = []
    const opening: Array<Promise<chrome.windows.Window | undefined>> = []
    fixture.api.onFocusChanged.addListener((windowId) => { focused.push(windowId) })

    const openCompanion = (window: chrome.windows.Window) => {
      if (window.type === "normal") opening.push(fixture.api.create({ type: "popup" }))
    }

    fixture.api.onCreated.addListener(openCompanion)
    const main = Option.getOrThrow(yield* windows.create()).id ?? WINDOW_ID_NONE
    const companion = (yield* Effect.promise(() => Promise.all(opening)))[0]?.id ?? WINDOW_ID_NONE
    expect([main, companion]).toEqual([1, 2])
    expect(fixture.controls.focused).toBe(companion)
    expect(focused).toEqual([main, companion])
    expect((yield* windows.getLastFocused()).id).toBe(companion)
  }))

  it.effect("rejects updating a locked fullscreen window, after Chrome's argument checks", () => Effect.gen(function*() {
    const fixture = makeWindows()
    const windows = service(fixture)
    const locked = fixture.controls.seed({ state: "locked-fullscreen", focused: true }).id ?? WINDOW_ID_NONE

    for (const updateInfo of [{ state: "normal" }, { focused: false }, { width: 10 }, {}] satisfies Array<chrome.windows.UpdateInfo>) {
      const error = yield* Effect.flip(windows.update(locked, updateInfo))
      expect(error).toMatchObject({ operation: "update", cause: { message: expect.stringMatching(/lockWindowFullscreenPrivate/) } })
    }

    expect(yield* Effect.flip(windows.update(locked, { state: "minimized", width: 1 }))).toMatchObject({ cause: new Error("Invalid value for state") })
    expect(fixture.controls.window(locked)).toMatchObject({ state: "locked-fullscreen", focused: true, width: 1280 })
    expect(fixture.controls.focused).toBe(locked)
  }))
})
