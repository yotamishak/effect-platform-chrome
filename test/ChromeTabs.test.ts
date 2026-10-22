// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Option, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeTabs, ChromeTabsError, layer, layerLive, make } from "../src/ChromeTabs.js"
import type { ChromeTabsApi } from "../src/ChromeTabs.js"
import { makePortPair } from "../src/ChromeTesting.js"

const tab: chrome.tabs.Tab = {
  id: 7, index: 0, windowId: 3, highlighted: false, active: true,
  pinned: false, incognito: false, discarded: false, autoDiscardable: true,
  groupId: -1, frozen: false, selected: true, lastAccessed: 0
}

const event = <Args extends Array<unknown>>() => {
  const listeners = new Set<(...args: Args) => void>()
  let notify!: () => void
  const added = new Promise<void>((resolve) => { notify = resolve })

  return {
    listeners,
    added,
    addListener: vi.fn((listener: (...args: Args) => void) => {
      listeners.add(listener)
      notify()
    }),
    removeListener: vi.fn((listener: (...args: Args) => void) => { listeners.delete(listener) }),
    emit: (...args: Args) => { for (const listener of listeners) listener(...args) }
  }
}

const mockApi = () => ({
  query: vi.fn(async (_queryInfo: chrome.tabs.QueryInfo) => [tab]),
  get: vi.fn(async (_tabId: number) => tab),
  create: vi.fn(async (_properties: chrome.tabs.CreateProperties) => tab),
  update: vi.fn(async (_tabId: number | undefined, _properties: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab | undefined> => tab),
  remove: vi.fn(async (_tabIds: number | Array<number>) => {}),
  sendMessage: vi.fn(async (_tabId: number, _message: unknown, _options?: chrome.tabs.MessageSendOptions): Promise<unknown> => ({ ok: true })),
  connect: vi.fn((_tabId: number, connectInfo?: chrome.tabs.ConnectInfo): chrome.runtime.Port => makePortPair(connectInfo?.name).left.port),
  captureVisibleTab: vi.fn(async (_windowId: number, _options: chrome.extensionTypes.ImageDetails) => "data:image/jpeg;base64,AA=="),
  duplicate: vi.fn(async (_tabId: number): Promise<chrome.tabs.Tab | undefined> => ({ ...tab, id: 8 })),
  move: vi.fn(async (tabIds: number | Array<number>, _moveProperties: chrome.tabs.MoveProperties): Promise<chrome.tabs.Tab | Array<chrome.tabs.Tab>> =>
    Array.isArray(tabIds) ? tabIds.map((id) => ({ ...tab, id })) : { ...tab, id: tabIds }),
  reload: vi.fn(async (_tabId?: number, _reloadProperties?: chrome.tabs.ReloadProperties) => {}),
  group: vi.fn(async (_options: chrome.tabs.GroupOptions) => 4),
  ungroup: vi.fn(async (_tabIds: number | [number, ...Array<number>]) => {}),
  discard: vi.fn(async (_tabId?: number): Promise<chrome.tabs.Tab | undefined> => ({ ...tab, discarded: true })),
  goBack: vi.fn(async (_tabId?: number) => {}),
  goForward: vi.fn(async (_tabId?: number) => {}),
  getZoom: vi.fn(async (_tabId?: number) => 1.5),
  setZoom: vi.fn(async (_tabId: number | undefined, _zoomFactor: number) => {}),
  getZoomSettings: vi.fn(async (_tabId?: number): Promise<chrome.tabs.ZoomSettings> => ({ mode: "automatic", scope: "per-tab" })),
  setZoomSettings: vi.fn(async (_tabId: number | undefined, _zoomSettings: chrome.tabs.ZoomSettings) => {}),
  detectLanguage: vi.fn(async (_tabId?: number) => "fr"),
  onCreated: event<[chrome.tabs.Tab]>(),
  onUpdated: event<[number, chrome.tabs.OnUpdatedInfo, chrome.tabs.Tab]>(),
  onRemoved: event<[number, chrome.tabs.OnRemovedInfo]>(),
  onActivated: event<[chrome.tabs.OnActivatedInfo]>(),
  onMoved: event<[number, chrome.tabs.OnMovedInfo]>(),
  onReplaced: event<[number, number]>(),
  onAttached: event<[number, chrome.tabs.OnAttachedInfo]>(),
  onDetached: event<[number, chrome.tabs.OnDetachedInfo]>(),
  onHighlighted: event<[chrome.tabs.OnHighlightedInfo]>(),
  onZoomChange: event<[chrome.tabs.OnZoomChangeInfo]>()
}) satisfies ChromeTabsApi

describe("ChromeTabs", () => {
  // This async case explicitly verifies the public AbortSignal runner boundary.
  it("interrupts an in-flight call and tolerates its late rejection before a fresh run", async () => {
    const api = mockApi()
    let notify!: () => void
    let reject!: (cause: Error) => void
    const ready = new Promise<void>((resolve) => { notify = resolve })
    const pending = new Promise<chrome.tabs.Tab>((_resolve, fail) => { reject = fail })

    api.get.mockImplementationOnce(() => {
      notify()

      return pending
    })
    const effect = make(api).get(0)
    const controller = new AbortController()
    const result = Effect.runPromiseExit(effect, { signal: controller.signal })

    await ready
    controller.abort()
    expect((await result)._tag).toBe("Failure")
    reject(new Error("tab closed after cancellation"))
    expect(await Effect.runPromise(effect)).toBe(tab)
    expect(api.get).toHaveBeenCalledTimes(2)
  })

  it.effect("retains exactly the newest 64 of 4096 startup events for every event shape", () => Effect.gen(function*() {
    const api = mockApi()
    api.onCreated.addListener.mockImplementation((listener) => {
      api.onCreated.listeners.add(listener)

      for (let id = 0; id < 4096; id++) listener({ ...tab, id })
    })
    api.onUpdated.addListener.mockImplementation((listener) => {
      api.onUpdated.listeners.add(listener)

      for (let id = 0; id < 4096; id++) listener(id, { title: `${id}` }, { ...tab, id })
    })
    api.onRemoved.addListener.mockImplementation((listener) => {
      api.onRemoved.listeners.add(listener)

      for (let id = 0; id < 4096; id++) listener(id, { windowId: id, isWindowClosing: false })
    })
    api.onActivated.addListener.mockImplementation((listener) => {
      api.onActivated.listeners.add(listener)

      for (let id = 0; id < 4096; id++) listener({ tabId: id, windowId: id })
    })
    const tabs = make(api)

    const values = yield* Effect.all([
      Stream.runCollect(Stream.take(Stream.map(tabs.onCreated, (value) => value.id), 64)),
      Stream.runCollect(Stream.take(Stream.map(tabs.onUpdated, (value) => value.tabId), 64)),
      Stream.runCollect(Stream.take(Stream.map(tabs.onRemoved, (value) => value.tabId), 64)),
      Stream.runCollect(Stream.take(Stream.map(tabs.onActivated, (value) => value.tabId), 64))
    ], { concurrency: "unbounded" })

    for (const result of values) expect(result).toEqual(Array.from({ length: 64 }, (_, id) => id + 4032))

    for (const source of [api.onCreated, api.onUpdated, api.onRemoved, api.onActivated]) {
      expect(source.listeners.size).toBe(0)
      expect(source.removeListener).toHaveBeenCalledTimes(1)
    }
  }))

  it.effect("cleans up 256 interrupted subscriptions despite events during and after removal", () => Effect.gen(function*() {
    const api = mockApi()
    const tabs = make(api)
    api.onCreated.removeListener.mockImplementation((listener) => {
      listener(tab)
      api.onCreated.listeners.delete(listener)
      listener(tab)
    })

    for (let index = 0; index < 256; index++) {
      let notify!: () => void
      const ready = new Promise<void>((resolve) => { notify = resolve })

      api.onCreated.addListener.mockImplementation((listener) => {
        api.onCreated.listeners.add(listener)
        notify()
      })
      const fiber = yield* Effect.forkScoped(Stream.runDrain(tabs.onCreated))

      yield* Effect.promise(() => ready)
      expect(api.onCreated.listeners.size).toBe(1)

      for (let id = 0; id < 128; id++) api.onCreated.emit({ ...tab, id })

      yield* Fiber.interrupt(fiber)
      expect(api.onCreated.listeners.size).toBe(0)
    }

    expect(api.onCreated.addListener).toHaveBeenCalledTimes(256)
    expect(api.onCreated.removeListener).toHaveBeenCalledTimes(256)
    expect(new Set(api.onCreated.addListener.mock.calls.map(([listener]) => listener)).size).toBe(256)
    expect(api.onCreated.removeListener.mock.calls).toEqual(api.onCreated.addListener.mock.calls)
  }))

  it.effect("removes a partially registered listener and permits a fresh subscription", () => Effect.gen(function*() {
    const api = mockApi()
    const cause = new Error("registration failed after insertion")
    api.onCreated.addListener.mockImplementationOnce((listener) => {
      api.onCreated.listeners.add(listener)
      listener(tab)
      throw cause
    })
    const stream = make(api).onCreated
    const error = yield* Effect.flip(Stream.runDrain(stream))
    expect(error.cause).toBe(cause)
    expect(api.onCreated.listeners.size).toBe(0)
    api.onCreated.addListener.mockImplementationOnce((listener) => {
      api.onCreated.listeners.add(listener)
      listener(tab)
    })
    expect(yield* Stream.runCollect(Stream.take(stream, 1))).toEqual([tab])
    expect(api.onCreated.listeners.size).toBe(0)
    expect(api.onCreated.removeListener.mock.calls).toEqual(api.onCreated.addListener.mock.calls)
  }))

  it.effect("reexecutes the same effects 256 times and preserves zero and empty arguments", () => Effect.gen(function*() {
    const api = mockApi()
    const tabs = make(api)

    const effects = [
      Effect.asVoid(tabs.query({ windowId: 0, title: "" })), Effect.asVoid(tabs.get(0)),
      Effect.asVoid(tabs.create({ url: "" })), Effect.asVoid(tabs.update(0, { url: "" })),
      tabs.remove(0), Effect.asVoid(tabs.sendMessage(0, "", { frameId: 0, documentId: "" }))
    ]

    expect(api.get).not.toHaveBeenCalled()

    for (let index = 0; index < 256; index++) {
      for (const effect of effects) yield* effect
    }

    for (const method of [api.query, api.get, api.create, api.update, api.remove, api.sendMessage]) {
      expect(method).toHaveBeenCalledTimes(256)
    }

    expect(api.query).toHaveBeenLastCalledWith({ windowId: 0, title: "" })
    expect(api.update).toHaveBeenLastCalledWith(0, { url: "" })
    expect(api.sendMessage).toHaveBeenLastCalledWith(0, "", { frameId: 0, documentId: "" })
    yield* tabs.sendMessage(0, "", undefined)
    expect(api.sendMessage).toHaveBeenLastCalledWith(0, "")
    yield* tabs.remove([])

    expect(api.remove).toHaveBeenLastCalledWith([])
  }))

  it.effect("preserves missing receiver and permission failures then reexecutes successfully", () => Effect.gen(function*() {
    const api = mockApi()
    const tabs = make(api)
    const pending = tabs.sendMessage(0, null)

    for (const message of ["Receiving end does not exist", "Missing host permission"]) {
      const cause = new Error(message)
      api.sendMessage.mockRejectedValueOnce(cause)
      const error = yield* Effect.flip(Effect.asVoid(pending))

      expect(error.operation).toBe("sendMessage")
      expect(error.cause).toBe(cause)
    }

    expect(yield* pending).toEqual({ ok: true })
  }))

  it.effect("provides an injectable service and preserves API arguments and results", () => Effect.gen(function*() {
    const api = mockApi()
    const queryInfo: chrome.tabs.QueryInfo = { active: true, url: ["https://example.com/*"] }
    const createProperties: chrome.tabs.CreateProperties = { url: "https://example.com", active: false }
    const updateProperties: chrome.tabs.UpdateProperties = { muted: true }
    const ids = [7, 8]
    yield* Effect.gen(function*() {
      const tabs = yield* ChromeTabs
      expect(yield* tabs.query(queryInfo)).toEqual([tab])
      expect(yield* tabs.get(7)).toBe(tab)
      expect(yield* tabs.create(createProperties)).toBe(tab)
      expect(yield* tabs.update(undefined, updateProperties)).toBe(tab)
      expect(yield* tabs.remove(ids)).toBeUndefined()
    }).pipe(Effect.provide(layer(api)))
    expect(api.query).toHaveBeenCalledWith(queryInfo)
    expect(api.get).toHaveBeenCalledWith(7)
    expect(api.create).toHaveBeenCalledWith(createProperties)
    expect(api.update).toHaveBeenCalledWith(undefined, updateProperties)
    expect(api.remove).toHaveBeenCalledWith(ids)
    api.update.mockResolvedValueOnce(undefined)
    expect(yield* make(api).update(7, {})).toBeUndefined()
  }))

  it.effect("forwards message options and returns an unknown response without decoding", () => Effect.gen(function*() {
    const api = mockApi()
    const tabs = make(api)
    const message = { kind: "hello" }
    const options: chrome.tabs.MessageSendOptions = { frameId: 0, documentId: "document" }
    const response = { arbitrary: [1, "two"] }
    api.sendMessage.mockResolvedValueOnce(response)
    expect(yield* tabs.sendMessage(7, message, options)).toBe(response)
    expect(api.sendMessage).toHaveBeenNthCalledWith(1, 7, message, options)
    yield* tabs.sendMessage(7, message)
    expect(api.sendMessage).toHaveBeenNthCalledWith(2, 7, message)
  }))

  it.effect.each(["query", "get", "create", "update", "remove", "sendMessage"] as const)(
    "captures synchronous throws and promise rejections from %s", (operation) => Effect.gen(function*() {
      for (const synchronous of [true, false]) {
        const cause = new Error(`${operation} failed`)

        const fail = () => {
          if (synchronous) throw cause

          return Promise.reject(cause)
        }

        const api: ChromeTabsApi = { ...mockApi(), [operation]: fail }
        const tabs = make(api)

        const effects = {
          query: tabs.query({}), get: tabs.get(7), create: tabs.create({}),
          update: tabs.update(7, {}), remove: tabs.remove(7), sendMessage: tabs.sendMessage(7, null)
        }

        const error = yield* Effect.flip(Effect.asVoid(effects[operation]))
        expect(error).toBeInstanceOf(ChromeTabsError)
        expect(error._tag).toBe("ChromeTabsError")
        expect(error.operation).toBe(operation)
        expect(error.cause).toBe(cause)
      }
    })
  )

  it.effect("does not need Chrome until the live layer is built", () => Effect.gen(function*() {
    vi.stubGlobal("chrome", undefined)

    const error = yield* Effect.flip(ChromeTabs.pipe(Effect.provide(layerLive)))

    expect(error.operation).toBe("initialize")
    const api = mockApi()
    vi.stubGlobal("chrome", { tabs: api })
    expect(yield* Effect.gen(function*() {
      const tabs = yield* ChromeTabs

      return yield* tabs.get(7)
    }).pipe(Effect.provide(layerLive))).toBe(tab)
  }))

  it.effect("preserves all event shapes and removes listeners after consumption", () => Effect.gen(function*() {
    const api = mockApi()
    const tabs = make(api)
    expect(api.onCreated.listeners.size).toBe(0)
    const changeInfo: chrome.tabs.OnUpdatedInfo = { status: "complete", title: "title" }
    const removeInfo: chrome.tabs.OnRemovedInfo = { windowId: 3, isWindowClosing: true }
    const activeInfo: chrome.tabs.OnActivatedInfo = { tabId: 7, windowId: 3 }

    const created = yield* Effect.forkScoped(Stream.runCollect(Stream.take(tabs.onCreated, 1)))
    const updated = yield* Effect.forkScoped(Stream.runCollect(Stream.take(tabs.onUpdated, 1)))
    const removed = yield* Effect.forkScoped(Stream.runCollect(Stream.take(tabs.onRemoved, 1)))
    const activated = yield* Effect.forkScoped(Stream.runCollect(Stream.take(tabs.onActivated, 1)))

    yield* Effect.promise(() => Promise.all([api.onCreated.added, api.onUpdated.added, api.onRemoved.added, api.onActivated.added]))
    api.onCreated.emit(tab)
    api.onUpdated.emit(7, changeInfo, tab)
    api.onRemoved.emit(7, removeInfo)
    api.onActivated.emit(activeInfo)
    expect(yield* Effect.all([Fiber.join(created), Fiber.join(updated), Fiber.join(removed), Fiber.join(activated)])).toEqual([
      [tab], [{ tabId: 7, changeInfo, tab }], [{ tabId: 7, removeInfo }], [activeInfo]
    ])

    for (const source of [api.onCreated, api.onUpdated, api.onRemoved, api.onActivated]) {
      expect(source.listeners.size).toBe(0)
      expect(source.removeListener).toHaveBeenCalledExactlyOnceWith(source.addListener.mock.calls[0]?.[0])
    }
  }))

  it.effect("removes exactly each subscription's own listener on interruption", () => Effect.gen(function*() {
    const api = mockApi()
    const tabs = make(api)
    const first = yield* Effect.forkScoped(Stream.runDrain(tabs.onCreated))
    yield* Effect.promise(() => api.onCreated.added)
    let registered!: () => void
    const ready = new Promise<void>((resolve) => { registered = resolve })
    api.onCreated.addListener.mockImplementationOnce((listener) => {
      api.onCreated.listeners.add(listener)
      registered()
    })
    const second = yield* Effect.forkScoped(Stream.runDrain(tabs.onCreated))
    yield* Effect.promise(() => ready)
    expect(api.onCreated.listeners.size).toBe(2)
    yield* Fiber.interrupt(first)
    expect(api.onCreated.listeners.size).toBe(1)
    api.onCreated.emit(tab)
    yield* Fiber.interrupt(second)
    expect(api.onCreated.listeners.size).toBe(0)
    expect(api.onCreated.removeListener).toHaveBeenCalledTimes(2)
  }))

  it.effect("bounds event buffering to the newest 64 events", () => Effect.gen(function*() {
    const api = mockApi()
    api.onCreated.addListener.mockImplementation((listener) => {
      api.onCreated.listeners.add(listener)

      for (let id = 0; id < 70; id++) listener({ ...tab, id })
    })
    const values = yield* Stream.runCollect(Stream.take(make(api).onCreated, 64))
    expect(values.map((value) => value.id)).toEqual(Array.from({ length: 64 }, (_, index) => index + 6))
    expect(api.onCreated.listeners.size).toBe(0)
  }))

  it.effect("reports listener registration failures in the typed error channel", () => Effect.gen(function*() {
    const api = mockApi()
    const cause = new Error("listener unavailable")
    api.onUpdated.addListener.mockImplementation(() => { throw cause })
    const error = yield* Effect.flip(Stream.runDrain(make(api).onUpdated))
    expect(error.operation).toBe("onUpdated")
    expect(error.cause).toBe(cause)
    expect(api.onUpdated.removeListener).toHaveBeenCalledExactlyOnceWith(api.onUpdated.addListener.mock.calls[0]?.[0])
  }))

  it.effect("opens a frame port and returns the native port unwrapped", () => Effect.gen(function*() {
    const api = mockApi()
    const port = yield* make(api).connect(7, { name: "example-frame", frameId: 2 })
    expect(port.name).toBe("example-frame")
    expect(api.connect).toHaveBeenCalledExactlyOnceWith(7, { name: "example-frame", frameId: 2 })
    yield* make(api).connect(8)
    expect(api.connect.mock.calls[1]).toEqual([8])
    const cause = new Error("No tab with id: 9.")
    api.connect.mockImplementationOnce(() => { throw cause })
    expect(yield* Effect.flip(make(api).connect(9))).toMatchObject({ operation: "connect", cause })
  }))

  it.effect("captures the visible tab with default image options", () => Effect.gen(function*() {
    const api = mockApi()
    expect(yield* make(api).captureVisibleTab(3)).toBe("data:image/jpeg;base64,AA==")
    yield* make(api).captureVisibleTab(3, { format: "jpeg", quality: 60 })
    expect(api.captureVisibleTab.mock.calls).toEqual([[3, {}], [3, { format: "jpeg", quality: 60 }]])
  }))

  it.effect("omits absent optional tab ids and reload properties", () => Effect.gen(function*() {
    const api = mockApi()
    const tabs = make(api)

    for (const tabId of [undefined, 0]) {
      yield* tabs.goBack(tabId)
      yield* tabs.goForward(tabId)
      expect(yield* tabs.getZoom(tabId)).toBe(1.5)
      expect(yield* tabs.getZoomSettings(tabId)).toEqual({ mode: "automatic", scope: "per-tab" })
      expect(yield* tabs.detectLanguage(tabId)).toBe("fr")
      yield* tabs.discard(tabId)
      yield* tabs.reload(tabId)
      yield* tabs.reload(tabId, { bypassCache: true })
    }

    for (const method of [api.goBack, api.goForward, api.getZoom, api.getZoomSettings, api.detectLanguage, api.discard]) {
      expect(method.mock.calls).toEqual([[], [0]])
    }

    expect(api.reload.mock.calls).toEqual([[], [undefined, { bypassCache: true }], [0], [0, { bypassCache: true }]])
  }))

  it.effect("forwards grouping and zoom arguments unchanged", () => Effect.gen(function*() {
    const api = mockApi()
    const tabs = make(api)
    const options: chrome.tabs.GroupOptions = { tabIds: [7, 8], createProperties: { windowId: 3 } }
    expect(yield* tabs.group(options)).toBe(4)
    yield* tabs.ungroup([7, 8])
    yield* tabs.ungroup(7)
    yield* tabs.setZoom(undefined, 0)
    yield* tabs.setZoom(7, 2)
    yield* tabs.setZoomSettings(undefined, { mode: "manual" })
    yield* tabs.setZoomSettings(7, { scope: "per-tab" })
    expect(api.group).toHaveBeenCalledExactlyOnceWith(options)
    expect(api.ungroup.mock.calls).toEqual([[[7, 8]], [7]])
    expect(api.setZoom.mock.calls).toEqual([[undefined, 0], [7, 2]])
    expect(api.setZoomSettings.mock.calls).toEqual([[undefined, { mode: "manual" }], [7, { scope: "per-tab" }]])
  }))

  it.effect("wraps optional tabs in Option and always yields moved tabs as an array", () => Effect.gen(function*() {
    const api = mockApi()
    const tabs = make(api)
    expect(yield* tabs.duplicate(7)).toEqual(Option.some({ ...tab, id: 8 }))
    expect(yield* tabs.discard(7)).toEqual(Option.some({ ...tab, discarded: true }))
    api.duplicate.mockResolvedValueOnce(undefined)
    api.discard.mockResolvedValueOnce(undefined)
    expect(yield* tabs.duplicate(7)).toEqual(Option.none())
    expect(yield* tabs.discard(7)).toEqual(Option.none())
    expect((yield* tabs.move(7, { index: 0 })).map((moved) => moved.id)).toEqual([7])
    expect((yield* tabs.move([7, 9], { index: -1, windowId: 4 })).map((moved) => moved.id)).toEqual([7, 9])
    expect(yield* tabs.move([], { index: 0 })).toEqual([])
    expect(api.move.mock.calls).toEqual([[7, { index: 0 }], [[7, 9], { index: -1, windowId: 4 }], [[], { index: 0 }]])
  }))

  it.effect.each([
    "duplicate", "move", "reload", "group", "ungroup", "discard", "goBack", "goForward",
    "getZoom", "setZoom", "getZoomSettings", "setZoomSettings", "detectLanguage"
  ] as const)("types synchronous throws and rejections from %s", (operation) => Effect.gen(function*() {
    for (const synchronous of [true, false]) {
      const cause = new Error(`${operation} failed`)

      const fail = () => {
        if (synchronous) throw cause

        return Promise.reject(cause)
      }

      const api: ChromeTabsApi = { ...mockApi(), [operation]: fail }
      const tabs = make(api)

      const effects = {
        duplicate: tabs.duplicate(7), move: tabs.move(7, { index: 0 }), reload: tabs.reload(7),
        group: tabs.group({ tabIds: 7 }), ungroup: tabs.ungroup(7), discard: tabs.discard(7),
        goBack: tabs.goBack(7), goForward: tabs.goForward(7), getZoom: tabs.getZoom(7),
        setZoom: tabs.setZoom(7, 1), getZoomSettings: tabs.getZoomSettings(7),
        setZoomSettings: tabs.setZoomSettings(7, {}), detectLanguage: tabs.detectLanguage(7)
      }

      const error = yield* Effect.flip(Effect.asVoid(effects[operation]))
      expect(error).toBeInstanceOf(ChromeTabsError)
      expect(error).toMatchObject({ operation, cause })
    }
  }))

  it.effect("preserves the move, replace, attach, detach, highlight and zoom event shapes", () => Effect.gen(function*() {
    const api = mockApi()
    const tabs = make(api)
    const moveInfo: chrome.tabs.OnMovedInfo = { windowId: 3, fromIndex: 0, toIndex: 2 }
    const attachInfo: chrome.tabs.OnAttachedInfo = { newWindowId: 4, newPosition: 1 }
    const detachInfo: chrome.tabs.OnDetachedInfo = { oldWindowId: 3, oldPosition: 0 }
    const highlightInfo: chrome.tabs.OnHighlightedInfo = { windowId: 3, tabIds: [7, 8] }
    const zoomInfo: chrome.tabs.OnZoomChangeInfo = { tabId: 7, oldZoomFactor: 1, newZoomFactor: 2, zoomSettings: { mode: "automatic" } }
    const sources = [api.onMoved, api.onReplaced, api.onAttached, api.onDetached, api.onHighlighted, api.onZoomChange]

    const moved = yield* Effect.forkScoped(Stream.runCollect(Stream.take(tabs.onMoved, 1)))
    const replaced = yield* Effect.forkScoped(Stream.runCollect(Stream.take(tabs.onReplaced, 1)))
    const attached = yield* Effect.forkScoped(Stream.runCollect(Stream.take(tabs.onAttached, 1)))
    const detached = yield* Effect.forkScoped(Stream.runCollect(Stream.take(tabs.onDetached, 1)))
    const highlighted = yield* Effect.forkScoped(Stream.runCollect(Stream.take(tabs.onHighlighted, 1)))
    const zoomed = yield* Effect.forkScoped(Stream.runCollect(Stream.take(tabs.onZoomChange, 1)))

    yield* Effect.promise(() => Promise.all(sources.map((source) => source.added)))
    api.onMoved.emit(7, moveInfo)
    api.onReplaced.emit(9, 7)
    api.onAttached.emit(7, attachInfo)
    api.onDetached.emit(7, detachInfo)
    api.onHighlighted.emit(highlightInfo)
    api.onZoomChange.emit(zoomInfo)
    expect(yield* Effect.all([
      Fiber.join(moved), Fiber.join(replaced), Fiber.join(attached),
      Fiber.join(detached), Fiber.join(highlighted), Fiber.join(zoomed)
    ])).toEqual([
      [{ tabId: 7, moveInfo }], [{ addedTabId: 9, removedTabId: 7 }], [{ tabId: 7, attachInfo }],
      [{ tabId: 7, detachInfo }], [highlightInfo], [zoomInfo]
    ])

    for (const source of sources) {
      expect(source.listeners.size).toBe(0)
      expect(source.removeListener).toHaveBeenCalledExactlyOnceWith(source.addListener.mock.calls[0]?.[0])
    }
  }))

  it.effect.each(["onMoved", "onReplaced", "onAttached", "onDetached", "onHighlighted", "onZoomChange"] as const)(
    "types listener registration failures from %s", (operation) => Effect.gen(function*() {
      const api = mockApi()
      const cause = new Error("listener unavailable")
      api[operation].addListener.mockImplementationOnce(() => { throw cause })
      const tabs = make(api)

      const drains = {
        onMoved: Stream.runDrain(tabs.onMoved), onReplaced: Stream.runDrain(tabs.onReplaced),
        onAttached: Stream.runDrain(tabs.onAttached), onDetached: Stream.runDrain(tabs.onDetached),
        onHighlighted: Stream.runDrain(tabs.onHighlighted), onZoomChange: Stream.runDrain(tabs.onZoomChange)
      }

      const error = yield* Effect.flip(drains[operation])
      expect(error).toMatchObject({ operation, cause })
      expect(api[operation].removeListener).toHaveBeenCalledTimes(1)
    })
  )
})
