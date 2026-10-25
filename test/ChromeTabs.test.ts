// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Cause, Effect, Exit, Fiber, Option, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeTabs, ChromeTabsError, layer, layerLive, make } from "../src/ChromeTabs.js"
import type { ChromeTabsApi } from "../src/ChromeTabs.js"
import { makeTabs } from "../src/testing/Tabs.js"
import { eventCases, mockApi, promiseOperations, runOperation, service, tab, window } from "./ChromeTabs.mock.js"

describe("ChromeTabs calls", () => {
  it.effect.each(promiseOperations)("maps a rejection and a synchronous throw from %s to the typed error", (operation) =>
    Effect.gen(function*() {
      for (const synchronous of [true, false]) {
        const cause = new Error(`${operation} failed`)

        const fail = () => {
          if (synchronous) throw cause

          return Promise.reject(cause)
        }

        const api: ChromeTabsApi = { ...mockApi(), [operation]: fail }
        const error = yield* Effect.flip(runOperation(make(api), operation, 7))

        expect(error).toBeInstanceOf(ChromeTabsError)
        expect(error._tag).toBe("ChromeTabsError")
        expect(error.operation).toBe(operation)
        expect(error.cause).toBe(cause)
      }
    }))

  it.effect.each(promiseOperations)("does not call Chrome until %s runs, and calls it again on every run", (operation) =>
    Effect.gen(function*() {
      const { api, tabs } = service()
      const effect = runOperation(tabs, operation, 7)

      expect(api[operation]).not.toHaveBeenCalled()
      yield* effect
      yield* effect
      expect(api[operation]).toHaveBeenCalledTimes(2)
    }))

  it.effect("maps a synchronous connect throw, and never wraps the native port", () => Effect.gen(function*() {
    const { api, tabs } = service()
    const port = yield* tabs.connect(7, { name: "example-frame", frameId: 2 })

    expect(port).toBe(api.connect.mock.results[0]?.value)
    expect(port.name).toBe("example-frame")
    const cause = new Error("No tab with id: 9.")
    api.connect.mockImplementationOnce(() => { throw cause })
    const error = yield* Effect.flip(tabs.connect(9))
    expect(error).toBeInstanceOf(ChromeTabsError)
    expect(error).toMatchObject({ operation: "connect", cause })
  }))

  it.effect("forwards required arguments unchanged and returns Chrome's results", () => Effect.gen(function*() {
    const { api, tabs } = service()
    const queryInfo: chrome.tabs.QueryInfo = { active: true, url: ["https://example.com/*"], windowId: 0, title: "" }
    const createProperties: chrome.tabs.CreateProperties = { url: "", active: false, index: 0 }
    const groupOptions: chrome.tabs.GroupOptions = { tabIds: [7, 8], createProperties: { windowId: 3 } }
    const highlightInfo: chrome.tabs.HighlightInfo = { tabs: [0, 2], windowId: 3 }

    expect(yield* tabs.get(0)).toBe(tab)
    expect(yield* tabs.query(queryInfo)).toEqual([tab])
    expect(yield* tabs.create(createProperties)).toBe(tab)
    expect(yield* tabs.remove([])).toBeUndefined()
    yield* tabs.remove(0)
    expect(yield* tabs.highlight(highlightInfo)).toBe(window)
    expect(yield* tabs.group(groupOptions)).toBe(4)
    yield* tabs.ungroup([7, 8])
    yield* tabs.ungroup(7)
    expect(yield* tabs.createSplit([7, 8])).toBe(5)
    yield* tabs.unsplit(5)

    expect(api.get.mock.calls).toEqual([[0]])
    expect(api.query.mock.calls[0]?.[0]).toBe(queryInfo)
    expect(api.create.mock.calls[0]?.[0]).toBe(createProperties)
    expect(api.remove.mock.calls).toEqual([[[]], [0]])
    expect(api.highlight.mock.calls[0]?.[0]).toBe(highlightInfo)
    expect(api.group.mock.calls[0]?.[0]).toBe(groupOptions)
    expect(api.ungroup.mock.calls).toEqual([[[7, 8]], [7]])
    expect(api.createSplit.mock.calls).toEqual([[[7, 8]]])
    expect(api.unsplit.mock.calls).toEqual([[5]])
  }))

  it.effect("omits every absent optional argument instead of sending undefined", () => Effect.gen(function*() {
    const { api, tabs } = service()

    for (const tabId of [undefined, 0]) {
      yield* tabs.goBack(tabId)
      yield* tabs.goForward(tabId)
      expect(yield* tabs.getZoom(tabId)).toBe(1.5)
      expect(yield* tabs.getZoomSettings(tabId)).toEqual({ mode: "automatic", scope: "per-tab" })
      expect(yield* tabs.detectLanguage(tabId)).toBe("fr")
      yield* tabs.discard(tabId)
    }

    for (const method of [api.goBack, api.goForward, api.getZoom, api.getZoomSettings, api.detectLanguage, api.discard]) {
      expect(method.mock.calls).toEqual([[], [0]])
    }

    yield* tabs.reload()
    yield* tabs.reload(undefined, { bypassCache: true })
    yield* tabs.reload(0)
    yield* tabs.reload(0, { bypassCache: false })
    expect(api.reload.mock.calls).toEqual([[], [{ bypassCache: true }], [0], [0, { bypassCache: false }]])

    yield* tabs.update(undefined, { muted: true })
    yield* tabs.update(0, {})
    expect(api.update.mock.calls).toEqual([[{ muted: true }], [0, {}]])

    yield* tabs.setZoom(undefined, 0)
    yield* tabs.setZoom(0, 2)
    expect(api.setZoom.mock.calls).toEqual([[0], [0, 2]])

    yield* tabs.setZoomSettings(undefined, { mode: "manual" })
    yield* tabs.setZoomSettings(0, {})
    expect(api.setZoomSettings.mock.calls).toEqual([[{ mode: "manual" }], [0, {}]])

    yield* tabs.captureVisibleTab()
    yield* tabs.captureVisibleTab(undefined, { format: "png" })
    yield* tabs.captureVisibleTab(0)
    yield* tabs.captureVisibleTab(0, { format: "jpeg", quality: 0 })
    expect(api.captureVisibleTab.mock.calls).toEqual([[], [{ format: "png" }], [0], [0, { format: "jpeg", quality: 0 }]])

    yield* tabs.sendMessage(0, "")
    yield* tabs.sendMessage(0, undefined, undefined)
    yield* tabs.sendMessage(0, null, { frameId: 0, documentId: "" })
    expect(api.sendMessage.mock.calls).toEqual([[0, ""], [0, undefined], [0, null, { frameId: 0, documentId: "" }]])

    yield* tabs.connect(0)
    yield* tabs.connect(0, undefined)
    yield* tabs.connect(0, { documentId: "document" })
    expect(api.connect.mock.calls).toEqual([[0], [0], [0, { documentId: "document" }]])
  }))

  it.effect("wraps results Chrome may leave out in Option", () => Effect.gen(function*() {
    const { api, tabs } = service()

    expect(yield* tabs.getCurrent).toEqual(Option.some(tab))
    expect(yield* tabs.update(7, {})).toEqual(Option.some(tab))
    expect(yield* tabs.duplicate(7)).toEqual(Option.some({ ...tab, id: 8 }))
    expect(yield* tabs.discard(7)).toEqual(Option.some({ ...tab, discarded: true }))

    for (const absent of [undefined, null]) {
      // SAFETY: Chrome's bindings may report a missing tab as null; the wrapper must treat it as absent.
      const missing = absent as chrome.tabs.Tab | undefined
      api.getCurrent.mockResolvedValueOnce(missing)
      api.update.mockResolvedValueOnce(missing)
      api.duplicate.mockResolvedValueOnce(missing)
      api.discard.mockResolvedValueOnce(missing)
      expect(yield* tabs.getCurrent).toEqual(Option.none())
      expect(yield* tabs.update(undefined, {})).toEqual(Option.none())
      expect(yield* tabs.duplicate(7)).toEqual(Option.none())
      expect(yield* tabs.discard()).toEqual(Option.none())
    }
  }))

  it.effect("always yields moved tabs as an array, including Chrome's single-tab result for one id in an array", () =>
    Effect.gen(function*() {
      const { api, tabs } = service()

      expect((yield* tabs.move(7, { index: 0 })).map((moved) => moved.id)).toEqual([7])
      expect((yield* tabs.move([7, 9], { index: -1, windowId: 4 })).map((moved) => moved.id)).toEqual([7, 9])
      api.move.mockResolvedValueOnce({ ...tab, id: 9 })
      expect((yield* tabs.move([9], { index: 1 })).map((moved) => moved.id)).toEqual([9])
      api.move.mockResolvedValueOnce([])
      expect(yield* tabs.move([], { index: 0 })).toEqual([])
      expect(api.move.mock.calls).toEqual([
        [7, { index: 0 }], [[7, 9], { index: -1, windowId: 4 }], [[9], { index: 1 }], [[], { index: 0 }]
      ])
    }))

  it.effect("fails Split View calls with the typed error where Chrome lacks them (before Chrome 155)", () =>
    Effect.gen(function*() {
      const { createSplit: _createSplit, unsplit: _unsplit, ...older } = mockApi()
      const tabs = make(older)
      const split = yield* Effect.flip(tabs.createSplit([1, 2]))
      const unsplit = yield* Effect.flip(tabs.unsplit(3))

      expect(split).toBeInstanceOf(ChromeTabsError)
      expect(split.operation).toBe("createSplit")
      expect(String(split.cause)).toContain("tabs.createSplit is unavailable")
      expect(unsplit.operation).toBe("unsplit")
      expect(String(unsplit.cause)).toContain("tabs.unsplit is unavailable")
    }))

  it.effect("reads optional members when the call runs, so a member added later is used", () => Effect.gen(function*() {
    const { createSplit, unsplit: _unsplit, ...rest } = mockApi()
    const api: ChromeTabsApi = rest
    const tabs = make(api)
    const effect = tabs.createSplit([1, 2])

    expect((yield* Effect.flip(effect)).operation).toBe("createSplit")
    Object.assign(api, { createSplit })
    expect(yield* effect).toBe(5)
  }))

  it.effect("returns the raw message response without decoding it", () => Effect.gen(function*() {
    const { api, tabs } = service()
    const response = { arbitrary: [1, "two"] }
    api.sendMessage.mockResolvedValueOnce({ ok: false })
    expect(yield* tabs.sendMessage(7, "hello")).toEqual({ ok: false })
    api.sendMessage.mockImplementationOnce(async () => response)
    expect(yield* tabs.sendMessage(7, "hello")).toBe(response)
  }))

  it.effect("keeps a missing receiver and a permission failure distinct, then succeeds on a fresh run", () =>
    Effect.gen(function*() {
      const { api, tabs } = service()
      const pending = tabs.sendMessage(0, null)

      for (const message of ["Receiving end does not exist", "Missing host permission"]) {
        const cause = new Error(message)
        api.sendMessage.mockRejectedValueOnce(cause)
        expect(yield* Effect.flip(Effect.asVoid(pending))).toMatchObject({ operation: "sendMessage", cause })
      }

      expect(yield* pending).toEqual({ ok: true })
    }))

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
    const exit = await result
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    reject(new Error("tab closed after cancellation"))
    expect(await Effect.runPromise(effect)).toBe(tab)
    expect(api.get).toHaveBeenCalledTimes(2)
  })
})

describe("ChromeTabs layers", () => {
  it.effect("provides the injected service", () => Effect.gen(function*() {
    const api = mockApi()
    const tabs = yield* ChromeTabs.pipe(Effect.provide(layer(api)))

    expect(yield* tabs.get(7)).toBe(tab)
    expect(api.get).toHaveBeenCalledExactlyOnceWith(7)
  }))

  it.effect("fails layerLive with initialize without chrome, or without chrome.tabs", () => Effect.gen(function*() {
    vi.stubGlobal("chrome", undefined)
    const missing = yield* Effect.flip(ChromeTabs.pipe(Effect.provide(layerLive)))

    expect(missing).toBeInstanceOf(ChromeTabsError)
    expect(missing.operation).toBe("initialize")
    expect(String(missing.cause)).toContain("chrome.tabs is unavailable")
    vi.stubGlobal("chrome", { runtime: {} })
    expect((yield* Effect.flip(ChromeTabs.pipe(Effect.provide(layerLive)))).operation).toBe("initialize")
  }))

  it.effect("builds layerLive from a fake global read only when the layer is built", () => Effect.gen(function*() {
    const api = mockApi()
    const reads = vi.fn(() => api)
    vi.stubGlobal("chrome", { get tabs() { return reads() } })
    expect(reads).not.toHaveBeenCalled()

    const tabs = yield* ChromeTabs.pipe(Effect.provide(layerLive))
    expect(reads).toHaveBeenCalledTimes(1)
    expect(yield* tabs.get(7)).toBe(tab)
    expect(reads).toHaveBeenCalledTimes(1)
  }))

  it.effect("make neither reads globals nor touches events until a stream runs", () => Effect.gen(function*() {
    vi.stubGlobal("chrome", new Proxy({}, { get: () => { throw new Error("chrome read") } }))
    const api = mockApi()
    let eventReads = 0

    const counted: ChromeTabsApi = {
      ...api,
      get onCreated() {
        eventReads++

        return api.onCreated
      }
    }

    const tabs = make(counted)
    const stream = tabs.onCreated

    expect(eventReads).toBe(0)
    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(stream, 1)))
    yield* Effect.promise(() => api.onCreated.probe.waitForListeners(1))
    expect(eventReads).toBe(1)
    api.onCreated.probe.emitNth(3)
    expect(yield* Fiber.join(fiber)).toEqual([{ ...tab, id: 3 }])
    expect(yield* tabs.get(7)).toBe(tab)
  }))
})

describe("ChromeTabs events", () => {
  it.effect.each(eventCases.map((event) => [event.name, event] as const))(
    "%s delivers its projection and removes exactly its own listener", ([, event]) => Effect.gen(function*() {
      const { api, tabs } = service()
      const probe = event.probe(api)

      yield* event.delivers(api, tabs, 11)
      expect(probe.listenerCount()).toBe(0)
      expect(probe.addCount()).toBe(1)
      expect(probe.balanced()).toBe(true)
    }))

  it.effect.each(eventCases.map((event) => [event.name, event] as const))(
    "%s types a registration failure and removes a listener added before the throw", ([name, event]) => Effect.gen(function*() {
      const { api, tabs } = service()
      const probe = event.probe(api)
      const cause = new Error("listener unavailable")
      probe.afterNextAdd((emitNth) => {
        emitNth(1)
        throw cause
      })
      const error = yield* Effect.flip(Stream.runDrain(event.keys(tabs)))

      expect(error).toBeInstanceOf(ChromeTabsError)
      expect(error).toMatchObject({ operation: name, cause })
      expect(probe.listenerCount()).toBe(0)
      expect(probe.balanced()).toBe(true)
      yield* event.delivers(api, tabs, 2)
      expect(probe.listenerCount()).toBe(0)
    }))

  it.effect.each(eventCases.map((event) => [event.name, event] as const))(
    "%s types a failure to look the event up", ([name, event]) => Effect.gen(function*() {
      const cause = new Error("event missing")
      const counted: ChromeTabsApi = Object.defineProperty({ ...mockApi() }, name, { get: () => { throw cause } })
      const error = yield* Effect.flip(Stream.runDrain(event.keys(make(counted))))

      expect(error).toMatchObject({ operation: name, cause })
    }))

  it.effect.each(eventCases.map((event) => [event.name, event] as const))(
    "%s removes its listener when interrupted, and only its own", ([, event]) => Effect.gen(function*() {
      const { api, tabs } = service()
      const probe = event.probe(api)
      const first = yield* Effect.forkChild(Stream.runDrain(event.keys(tabs)))
      yield* Effect.promise(() => probe.waitForListeners(1))
      const second = yield* Effect.forkChild(Stream.runCollect(Stream.take(event.keys(tabs), 2)))
      yield* Effect.promise(() => probe.waitForListeners(2))

      yield* Fiber.interrupt(first)
      expect(probe.listenerCount()).toBe(1)
      probe.emitNth(5)
      probe.emitNth(6)
      expect(yield* Fiber.join(second)).toEqual([5, 6])
      expect(probe.listenerCount()).toBe(0)
      expect(probe.removeCount()).toBe(2)
      expect(probe.balanced()).toBe(true)
    }))

  it.effect.each(eventCases.map((event) => [event.name, event] as const))(
    "%s gives each concurrent consumer every event in order", ([, event]) => Effect.gen(function*() {
      const { api, tabs } = service()
      const probe = event.probe(api)
      const consumers = yield* Effect.forEach([0, 1, 2], () => Effect.forkChild(Stream.runCollect(Stream.take(event.keys(tabs), 3))))
      yield* Effect.promise(() => probe.waitForListeners(3))

      for (const n of [1, 2, 3]) probe.emitNth(n)

      expect(yield* Fiber.joinAll(consumers)).toEqual([[1, 2, 3], [1, 2, 3], [1, 2, 3]])
      expect(probe.listenerCount()).toBe(0)
    }))

  it.effect("ignores events Chrome delivers to a listener during and after its removal", () => Effect.gen(function*() {
    const { api, tabs } = service()
    api.onCreated.removeListener.mockImplementation((listener) => {
      listener(tab)
      api.onCreated.listeners.delete(listener)
      listener(tab)
    })
    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(tabs.onCreated, 1)))
    yield* Effect.promise(() => api.onCreated.probe.waitForListeners(1))
    const [listener] = api.onCreated.listeners
    api.onCreated.probe.emitNth(1)
    expect(yield* Fiber.join(fiber)).toEqual([{ ...tab, id: 1 }])
    listener?.({ ...tab, id: 2 })
    expect(api.onCreated.listeners.size).toBe(0)
  }))

  it.effect("surfaces a throwing removeListener as a defect after deactivating the listener", () => Effect.gen(function*() {
    const { api, tabs } = service()
    const cause = new Error("remove failed")
    api.onCreated.removeListener.mockImplementationOnce(() => { throw cause })
    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(tabs.onCreated, 1)))
    yield* Effect.promise(() => api.onCreated.probe.waitForListeners(1))
    const [listener] = api.onCreated.listeners
    api.onCreated.probe.emitNth(1)
    const exit = yield* Effect.exit(Fiber.join(fiber))

    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toBe(cause)
    expect(() => listener?.({ ...tab, id: 2 })).not.toThrow()
  }))
})

const ids = (list: ReadonlyArray<chrome.tabs.Tab>) => list.map((each) => each.id)

const idOf = (each: chrome.tabs.Tab): number => each.id ?? -1

const fixtureService = (overrides: Partial<ChromeTabsApi> = {}) => {
  const fixture = makeTabs(overrides)

  return { fixture, tabs: make(fixture.api) }
}

describe("makeTabs fixture", () => {
  it.effect("creates tabs in the current window and keeps one active, highlighted tab per window", () => Effect.gen(function*() {
    const { fixture, tabs } = fixtureService()
    const activations = yield* Effect.forkChild(Stream.runCollect(Stream.take(tabs.onActivated, 3)))
    yield* Effect.promise(() => fixture.controls.onActivated.waitForListener())
    const first = idOf(fixture.controls.seed())
    const second = idOf(yield* tabs.create({ url: "https://app.example/" }))
    const background = yield* tabs.create({ active: false })
    const other = idOf(yield* tabs.create({ windowId: 2 }))

    expect(background).toMatchObject({ windowId: 1, index: 2, active: false, highlighted: false, selected: false })
    expect(ids(yield* tabs.query({ active: true }))).toEqual([second, other])
    expect(ids(yield* tabs.query({ highlighted: true }))).toEqual([second, other])
    expect(fixture.controls.tab(first)).toMatchObject({ active: false, highlighted: false, selected: false })
    expect(yield* Fiber.join(activations)).toEqual([
      { tabId: first, windowId: 1 }, { tabId: second, windowId: 1 }, { tabId: other, windowId: 2 }
    ])
  }))

  it.effect("updates the current tab when no id is given, reporting only changed fields", () => Effect.gen(function*() {
    const { fixture, tabs } = fixtureService()
    const current = idOf(fixture.controls.seed({ url: "https://a.example/" }))
    const sibling = idOf(fixture.controls.seed({ active: false }))
    const elsewhere = idOf(fixture.controls.seed({ windowId: 2 }))
    const updates = yield* Effect.forkChild(Stream.runCollect(Stream.take(tabs.onUpdated, 3)))
    const highlights = yield* Effect.forkChild(Stream.runCollect(Stream.take(tabs.onHighlighted, 2)))
    yield* Effect.promise(() => Promise.all([fixture.controls.onUpdated.waitForListener(), fixture.controls.onHighlighted.waitForListener()]))

    expect(Option.map(yield* tabs.update(undefined, { pinned: true }), idOf)).toEqual(Option.some(current))
    yield* tabs.update(current, { pinned: true })
    yield* tabs.update(current, { muted: true })
    yield* tabs.update(current, { autoDiscardable: false, url: "https://a.example/next" })
    yield* tabs.update(sibling, { active: false })
    expect(fixture.controls.tab(sibling)?.active).toBe(false)
    yield* tabs.update(sibling, { active: true })
    yield* tabs.update(current, { highlighted: true })

    expect((yield* Fiber.join(updates)).map((update) => [update.tabId, update.changeInfo])).toEqual([
      [current, { pinned: true }],
      [current, { mutedInfo: { muted: true, reason: "extension" } }],
      [current, { url: "https://a.example/next", autoDiscardable: false }]
    ])
    expect(yield* Fiber.join(highlights)).toEqual([
      { windowId: 1, tabIds: [sibling] }, { windowId: 1, tabIds: [current, sibling] }
    ])
    expect(ids(yield* tabs.query({ muted: true }))).toEqual([current])
    expect(fixture.controls.tab(current)).toMatchObject({ active: false, highlighted: true, pinned: true, autoDiscardable: false })
    yield* tabs.update(current, { openerTabId: sibling })
    expect(fixture.controls.tab(current)?.openerTabId).toBe(sibling)
    expect(yield* Effect.flip(tabs.update(current, { openerTabId: elsewhere }))).toMatchObject({ operation: "update" })
    const missing = yield* Effect.flip(tabs.update(99, {}))
    expect(missing.operation).toBe("update")
    expect(String(missing.cause)).toContain("No tab with id: 99.")
    expect((yield* Effect.flip(make(makeTabs().api).update(undefined, {}))).operation).toBe("update")
  }))

  it.effect("matches query fields, url match patterns and title globs", () => Effect.gen(function*() {
    const { fixture, tabs } = fixtureService()
    const a = idOf(fixture.controls.seed({ url: "https://www.example.com/a?x=1#frag", title: "Example A" }))
    const b = idOf(fixture.controls.seed({ url: "http://example.com/b", title: "Other", active: false, audible: true, frozen: true }))
    const c = idOf(fixture.controls.seed({ url: "file:///tmp/x.html", windowId: 2, pinned: true, autoDiscardable: false }))
    const d = idOf(fixture.controls.seed({ url: "chrome://settings/", windowId: 2, active: false, mutedInfo: { muted: true } }))
    const e = idOf(fixture.controls.seed({ url: "not a url", windowId: 3, status: "loading" }))
    const query = (queryInfo: chrome.tabs.QueryInfo) => Effect.map(tabs.query(queryInfo), ids)

    expect(yield* query({})).toEqual([a, b, c, d, e])
    expect(yield* query({ url: "https://*.example.com/*" })).toEqual([a])
    expect(yield* query({ url: "*://example.com/*" })).toEqual([b])
    expect(yield* query({ url: "*://*.example.com/*" })).toEqual([a, b])
    expect(yield* query({ url: "<all_urls>" })).toEqual([a, b, c])
    expect(yield* query({ url: "https://www.example.com/a?x=1" })).toEqual([a])
    expect(yield* query({ url: "https://www.example.com/a" })).toEqual([])
    expect(yield* query({ url: ["file:///*", "chrome://*/*"] })).toEqual([c, d])
    expect(yield* query({ url: "*" })).toEqual([])
    expect(yield* query({ title: "Example*" })).toEqual([a])
    expect(yield* query({ title: "Oth?r" })).toEqual([])
    expect(yield* query({ currentWindow: true })).toEqual([a, b])
    expect(yield* query({ currentWindow: false })).toEqual([c, d, e])
    expect(yield* query({ lastFocusedWindow: true })).toEqual([a, b])
    expect(yield* query({ windowId: -2 })).toEqual([a, b])
    expect(yield* query({ windowType: "popup" })).toEqual([])
    expect(yield* query({ windowType: "normal" })).toEqual([a, b, c, d, e])
    expect(yield* query({ audible: true })).toEqual([b])
    expect(yield* query({ muted: true })).toEqual([d])
    expect(yield* query({ frozen: true })).toEqual([b])
    expect(yield* query({ autoDiscardable: false })).toEqual([c])
    expect(yield* query({ pinned: true })).toEqual([c])
    expect(yield* query({ active: true })).toEqual([a, c, e])
    expect(yield* query({ highlighted: true })).toEqual([a, c, e])
    expect(yield* query({ status: "loading" })).toEqual([e])
    expect(yield* query({ splitViewId: -1 })).toEqual([a, b, c, d, e])
    expect(yield* query({ index: 1, windowId: 2 })).toEqual([d])
  }))

  it.effect("walks navigation history, truncating forward entries on a new navigation", () => Effect.gen(function*() {
    const { fixture, tabs } = fixtureService()
    const page = idOf(fixture.controls.seed({ url: "https://a.example/1" }))
    const url = Effect.map(tabs.get(page), (each) => each.url)
    yield* tabs.update(page, { url: "https://a.example/2" })
    yield* tabs.update(page, { url: "https://a.example/3" })
    yield* tabs.goBack(page)
    expect(yield* url).toBe("https://a.example/2")
    yield* tabs.goBack()
    expect(yield* url).toBe("https://a.example/1")
    const back = yield* Effect.flip(tabs.goBack(page))
    expect(back.operation).toBe("goBack")
    expect(String(back.cause)).toContain("Cannot find a next page in history.")
    yield* tabs.goForward(page)
    yield* tabs.update(page, { url: "https://a.example/4" })
    expect((yield* Effect.flip(tabs.goForward(page))).operation).toBe("goForward")
    yield* tabs.goBack(page)
    expect(yield* url).toBe("https://a.example/2")
    const copy = idOf(Option.getOrThrow(yield* tabs.duplicate(page)))
    yield* tabs.goForward(copy)
    expect((yield* tabs.get(copy)).url).toBe("https://a.example/4")
    expect(yield* url).toBe("https://a.example/2")
    const blank = idOf(fixture.controls.seed())
    expect((yield* Effect.flip(tabs.goBack(blank))).operation).toBe("goBack")
    expect((yield* Effect.flip(tabs.goForward(99))).operation).toBe("goForward")
  }))

  it.effect("moves tabs as Chrome does, handing activation over across windows", () => Effect.gen(function*() {
    const { fixture, tabs } = fixtureService()
    const a = idOf(fixture.controls.seed())
    const b = idOf(fixture.controls.seed({ active: false }))
    const c = idOf(fixture.controls.seed({ active: false }))
    const activations = yield* Effect.forkChild(Stream.runCollect(Stream.take(tabs.onActivated, 2)))
    yield* Effect.promise(() => fixture.controls.onActivated.waitForListener())

    const empty = yield* Effect.flip(tabs.move([], { index: 0 }))
    expect(empty.operation).toBe("move")
    expect(String(empty.cause)).toContain("No tabs given.")
    const single = yield* Effect.promise(() => fixture.api.move([b], { index: 0 }))
    expect(Array.isArray(single)).toBe(false)
    expect(ids(yield* tabs.query({ windowId: 1 }))).toEqual([b, a, c])
    expect(ids(yield* tabs.move(a, { index: -1, windowId: 2 }))).toEqual([a])
    yield* tabs.move(b, { index: 0, windowId: 2 })
    expect(yield* Fiber.join(activations)).toEqual([{ tabId: c, windowId: 1 }, { tabId: a, windowId: 2 }])
    expect((yield* tabs.query({ windowId: 2 })).map((each) => [each.id, each.index, each.active])).toEqual([[b, 0, false], [a, 1, true]])
    expect((yield* tabs.query({ windowId: 1 })).map((each) => [each.id, each.index, each.active])).toEqual([[c, 0, true]])
    expect(ids(yield* tabs.move([b, a], { index: 0, windowId: 1 }))).toEqual([b, a])
    expect(ids(yield* tabs.query({ windowId: 1 }))).toEqual([b, a, c])
    expect((yield* Effect.flip(tabs.move(99, { index: 0 }))).operation).toBe("move")
  }))

  it.effect("activates a neighbour when the active tab closes and dissolves splits and empty groups", () => Effect.gen(function*() {
    const { fixture, tabs } = fixtureService()
    const a = idOf(fixture.controls.seed())
    const b = idOf(fixture.controls.seed({ active: false }))
    const c = idOf(fixture.controls.seed({ active: false }))
    const groupId = yield* tabs.group({ tabIds: [b, c] })
    const splitViewId = yield* tabs.createSplit([b, c])
    const updates = yield* Effect.forkChild(Stream.runCollect(Stream.take(tabs.onUpdated, 1)))
    yield* Effect.promise(() => fixture.controls.onUpdated.waitForListener())

    yield* tabs.remove(b)
    expect(yield* Fiber.join(updates)).toEqual([{ tabId: c, changeInfo: { splitViewId: -1 }, tab: expect.objectContaining({ id: c, splitViewId: -1 }) }])
    expect((yield* Effect.flip(tabs.unsplit(splitViewId))).operation).toBe("unsplit")
    yield* tabs.remove(a)
    expect(fixture.controls.tab(c)).toMatchObject({ active: true, index: 0, groupId })
    yield* tabs.remove(c)
    const d = idOf(fixture.controls.seed())
    expect((yield* Effect.flip(tabs.group({ tabIds: d, groupId }))).operation).toBe("group")
    const partial = yield* Effect.flip(tabs.remove([d, 99]))
    expect(partial.operation).toBe("remove")
    expect(fixture.controls.tab(d)).toBeUndefined()
    expect(yield* tabs.query({})).toEqual([])
  }))

  it.effect("highlights tabs by index and focuses the first", () => Effect.gen(function*() {
    const { fixture, tabs } = fixtureService()
    const a = idOf(fixture.controls.seed())
    const b = idOf(fixture.controls.seed({ active: false }))
    const c = idOf(fixture.controls.seed({ active: false }))
    const highlights = yield* Effect.forkChild(Stream.runCollect(Stream.take(tabs.onHighlighted, 1)))
    const activations = yield* Effect.forkChild(Stream.runCollect(Stream.take(tabs.onActivated, 1)))
    yield* Effect.promise(() => Promise.all([fixture.controls.onHighlighted.waitForListener(), fixture.controls.onActivated.waitForListener()]))

    const highlighted = yield* tabs.highlight({ tabs: [2, 0] })
    expect(highlighted).toMatchObject({ id: 1, focused: true, type: "normal" })
    expect(highlighted.tabs?.map((each) => [each.id, each.active, each.highlighted])).toEqual([[a, false, true], [b, false, false], [c, true, true]])
    expect(yield* Fiber.join(highlights)).toEqual([{ windowId: 1, tabIds: [a, c] }])
    expect(yield* Fiber.join(activations)).toEqual([{ tabId: c, windowId: 1 }])

    for (const highlightInfo of [{ tabs: 5 }, { tabs: [] }, { tabs: 0, windowId: 9 }]) {
      expect((yield* Effect.flip(tabs.highlight(highlightInfo))).operation).toBe("highlight")
    }
  }))

  it.effect("validates group options without leaking a group id", () => Effect.gen(function*() {
    const { fixture, tabs } = fixtureService()
    const a = idOf(fixture.controls.seed())
    const invalid: ReadonlyArray<chrome.tabs.GroupOptions> = [{}, { tabIds: a, groupId: 1, createProperties: {} }, { tabIds: [a, 99] }, { tabIds: a, groupId: 7 }]

    for (const options of invalid) {
      expect((yield* Effect.flip(tabs.group(options))).operation).toBe("group")
    }

    expect(yield* tabs.group({ tabIds: a })).toBe(1)
    expect(fixture.controls.tab(a)?.groupId).toBe(1)
  }))

  it.effect("creates and dissolves Split Views under Chrome's pairing rules", () => Effect.gen(function*() {
    const { fixture, tabs } = fixtureService()
    const a = idOf(fixture.controls.seed())
    const b = idOf(fixture.controls.seed({ active: false }))
    const c = idOf(fixture.controls.seed({ active: false }))
    const updates = yield* Effect.forkChild(Stream.runCollect(Stream.take(tabs.onUpdated, 4)))
    yield* Effect.promise(() => fixture.controls.onUpdated.waitForListener())
    const invalid: ReadonlyArray<[number, number]> = [[a, c], [a, a], [a, 99]]

    for (const pair of invalid) {
      expect((yield* Effect.flip(tabs.createSplit(pair))).operation).toBe("createSplit")
    }

    const splitViewId = yield* tabs.createSplit([a, b])
    expect(ids(yield* tabs.query({ splitViewId }))).toEqual([a, b])
    expect((yield* Effect.flip(tabs.createSplit([b, c]))).operation).toBe("createSplit")
    yield* tabs.unsplit(splitViewId)
    expect((yield* Effect.flip(tabs.unsplit(splitViewId))).operation).toBe("unsplit")
    expect((yield* Fiber.join(updates)).map((update) => [update.tabId, update.changeInfo])).toEqual([
      [a, { splitViewId }], [b, { splitViewId }], [a, { splitViewId: -1 }], [b, { splitViewId: -1 }]
    ])
    yield* tabs.update(b, { pinned: true })
    expect((yield* Effect.flip(tabs.createSplit([a, b]))).operation).toBe("createSplit")

    const { createSplit: _createSplit, unsplit: _unsplit, ...older } = fixture.api
    expect(String((yield* Effect.flip(make(older).createSplit([a, b]))).cause)).toContain("tabs.createSplit is unavailable")
  }))

  it.effect("discards inactive tabs, the least recently used first, and wakes them on activation", () => Effect.gen(function*() {
    const { fixture, tabs } = fixtureService()
    const a = idOf(fixture.controls.seed())
    const b = idOf(fixture.controls.seed({ active: false, lastAccessed: 5 }))
    const c = idOf(fixture.controls.seed({ active: false, lastAccessed: 2 }))
    fixture.controls.seed({ active: false, lastAccessed: 1, autoDiscardable: false })
    const updates = yield* Effect.forkChild(Stream.runCollect(Stream.take(tabs.onUpdated, 3)))
    yield* Effect.promise(() => fixture.controls.onUpdated.waitForListener())

    const active = yield* Effect.flip(tabs.discard(a))
    expect(String(active.cause)).toContain(`Cannot discard tab with id: ${a}.`)
    expect(Option.map(yield* tabs.discard(), idOf)).toEqual(Option.some(c))
    expect(Option.map(yield* tabs.discard(), idOf)).toEqual(Option.some(b))
    expect((yield* Effect.flip(tabs.discard())).operation).toBe("discard")
    expect(yield* tabs.discard(b)).toEqual(Option.some(expect.objectContaining({ id: b, discarded: true })))
    yield* tabs.update(b, { active: true })
    expect((yield* Fiber.join(updates)).map((update) => [update.tabId, update.changeInfo])).toEqual([
      [c, { discarded: true }], [b, { discarded: true }], [b, { discarded: false }]
    ])
    expect(ids(yield* tabs.query({ discarded: true }))).toEqual([c])
  }))

  it.effect("targets the current tab for zoom and reload overloads and rejects negative zoom", () => Effect.gen(function*() {
    const { fixture, tabs } = fixtureService()
    const a = idOf(fixture.controls.seed())
    const updates = yield* Effect.forkChild(Stream.runCollect(Stream.take(tabs.onUpdated, 2)))
    yield* Effect.promise(() => fixture.controls.onUpdated.waitForListener())

    yield* tabs.setZoom(undefined, 3)
    expect(yield* tabs.getZoom(a)).toBe(3)
    yield* tabs.setZoomSettings(undefined, { scope: "per-tab" })
    expect(yield* tabs.getZoomSettings(a)).toEqual({ mode: "automatic", scope: "per-tab", defaultZoomFactor: 1 })
    expect((yield* Effect.flip(tabs.setZoom(a, -1))).operation).toBe("setZoom")
    yield* tabs.reload(undefined, { bypassCache: true })
    expect((yield* Fiber.join(updates)).map((update) => [update.tabId, update.changeInfo])).toEqual([
      [a, { status: "loading" }], [a, { status: "complete" }]
    ])
    expect((yield* Effect.flip(make(makeTabs().api).reload())).operation).toBe("reload")
  }))

  it.effect("captures in the requested format and reports the current tab only when one is set", () => Effect.gen(function*() {
    const { fixture, tabs } = fixtureService()
    const a = idOf(fixture.controls.seed())

    expect(yield* tabs.captureVisibleTab()).toBe("data:image/jpeg;base64,")
    expect(yield* tabs.captureVisibleTab(1)).toBe("data:image/jpeg;base64,")
    expect(yield* tabs.captureVisibleTab(undefined, { format: "png" })).toBe("data:image/png;base64,")
    expect(yield* tabs.captureVisibleTab(1, { format: "png" })).toBe("data:image/png;base64,")
    expect(yield* tabs.getCurrent).toEqual(Option.none())
    fixture.controls.setCurrentTab(a)
    expect(Option.map(yield* tabs.getCurrent, idOf)).toEqual(Option.some(a))
    fixture.controls.setCurrentTab(99)
    expect((yield* Effect.flip(tabs.getCurrent)).operation).toBe("getCurrent")
    fixture.controls.setCurrentTab(undefined)
    expect(yield* tabs.getCurrent).toEqual(Option.none())
    const error = yield* Effect.flip(Effect.asVoid(tabs.sendMessage(a, "hello")))
    expect(String(error.cause)).toContain("Receiving end does not exist.")
    expect(yield* tabs.detectLanguage()).toBe("und")
  }))

  it.effect("replaces a tab in place and emits onReplaced", () => Effect.gen(function*() {
    const { fixture, tabs } = fixtureService()
    const a = idOf(fixture.controls.seed({ url: "https://a.example/" }))
    const b = idOf(fixture.controls.seed({ active: false }))
    const replacements = yield* Effect.forkChild(Stream.runCollect(Stream.take(tabs.onReplaced, 1)))
    yield* Effect.promise(() => fixture.controls.onReplaced.waitForListener())

    const replacement = fixture.controls.replace(a, { url: "https://prerendered.example/" })
    const added = idOf(replacement)
    expect(replacement).toMatchObject({ index: 0, active: true, url: "https://prerendered.example/" })
    expect(yield* Fiber.join(replacements)).toEqual([{ addedTabId: added, removedTabId: a }])
    expect(ids(yield* tabs.query({ windowId: 1 }))).toEqual([added, b])
    expect((yield* Effect.flip(tabs.get(a))).operation).toBe("get")
    expect(fixture.controls.tab(a)).toBeUndefined()
  }))

  it.effect("lets overrides replace members while the rest keep the strip", () => Effect.gen(function*() {
    const { fixture, tabs } = fixtureService({ getCurrent: async () => tab, detectLanguage: async () => "he" })
    fixture.controls.seed()

    expect(yield* tabs.getCurrent).toEqual(Option.some(tab))
    expect(yield* tabs.detectLanguage()).toBe("he")
    expect(yield* tabs.query({})).toHaveLength(1)
  }))
})
