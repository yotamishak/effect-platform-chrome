// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Stream } from "effect"
import { expect, vi } from "@effect/vitest"
import { make } from "../src/ChromeTabs.js"
import type { ChromeTabsApi, ChromeTabsError, ChromeTabsService } from "../src/ChromeTabs.js"
import * as TestPort from "../src/testing/Port.js"

/** A complete tab as Chrome reports it. */
export const tab: chrome.tabs.Tab = {
  id: 7, index: 0, windowId: 3, highlighted: false, active: true,
  pinned: false, incognito: false, discarded: false, autoDiscardable: true,
  groupId: -1, frozen: false, selected: true, lastAccessed: 0
}

export const window: chrome.windows.Window = { id: 3, focused: true, alwaysOnTop: false, incognito: false }

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32), for reproducible stress plans. */
export const seeded = (seed: number) => {
  let state = seed >>> 0

  return (): number => {
    state = (state + 0x6D2B79F5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

/** Shuffles a copy of `items` with `random`. */
export const shuffle = <A>(items: ReadonlyArray<A>, random: () => number): Array<A> => {
  const copy = [...items]

  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    const current = copy[index]
    const swapped = copy[other]

    if (current !== undefined && swapped !== undefined) {
      copy[index] = swapped
      copy[other] = current
    }
  }

  return copy
}

/** The listener-count view of a mock event, independent of its argument types. */
export interface EventProbe {
  readonly listenerCount: () => number
  /** Resolves once exactly `count` listeners are registered (an explicit registration gate). */
  readonly waitForListeners: (count: number) => Promise<void>
  /** Emits the `n`th synthetic event to every registered listener. */
  readonly emitNth: (n: number) => void
  /** Runs `hook` with the next listener right after it is registered (bursts, throws). */
  readonly afterNextAdd: (hook: (emitNth: (n: number) => void) => void) => void
  readonly addCount: () => number
  readonly removeCount: () => number
  /** Every removal targeted a listener that was added, and each added listener was removed once. */
  readonly balanced: () => boolean
}

/**
 * A Chrome event double: listeners in a set, `vi.fn` registration, a registration gate and
 * `nth`, which builds the arguments of the `n`th synthetic event.
 */
export const mockEvent = <Args extends ReadonlyArray<unknown>>(nth: (n: number) => Args) => {
  const listeners = new Set<(...args: Args) => void>()
  const waiting: Array<{ readonly count: number; readonly resolve: () => void }> = []
  const hooks: Array<(emitNth: (n: number) => void) => void> = []

  const settle = () => {
    for (const waiter of waiting.splice(0)) {
      if (listeners.size === waiter.count) waiter.resolve()
      else waiting.push(waiter)
    }
  }

  const emit = (...args: Args) => {
    for (const listener of Array.from(listeners)) listener(...args)
  }

  const emitNth = (n: number) => emit(...nth(n))

  const addListener = vi.fn((listener: (...args: Args) => void) => {
    listeners.add(listener)
    settle()
    const hook = hooks.shift()

    if (hook !== undefined) hook((n) => listener(...nth(n)))
  })

  const removeListener = vi.fn((listener: (...args: Args) => void) => {
    listeners.delete(listener)
    settle()
  })

  const probe: EventProbe = {
    listenerCount: () => listeners.size,
    waitForListeners: (count) => listeners.size === count
      ? Promise.resolve()
      : new Promise((resolve) => { waiting.push({ count, resolve }) }),
    emitNth,
    afterNextAdd: (hook) => { hooks.push(hook) },
    addCount: () => addListener.mock.calls.length,
    removeCount: () => removeListener.mock.calls.length,
    balanced: () => {
      const added = addListener.mock.calls.map(([listener]) => listener)
      const removed = removeListener.mock.calls.map(([listener]) => listener)

      return added.length === removed.length
        && new Set(added).size === added.length
        && removed.every((listener) => added.includes(listener))
        && new Set(removed).size === removed.length
    }
  }

  return { listeners, addListener, removeListener, emit, nth, probe }
}

/** Fresh mocks for every member of the Api, resolving canned values. */
export const mockApi = () => ({
  get: vi.fn(async (_tabId: number) => tab),
  getCurrent: vi.fn(async (): Promise<chrome.tabs.Tab | undefined> => tab),
  query: vi.fn(async (_queryInfo: chrome.tabs.QueryInfo) => [tab]),
  create: vi.fn(async (_createProperties: chrome.tabs.CreateProperties) => tab),
  duplicate: vi.fn(async (_tabId: number): Promise<chrome.tabs.Tab | undefined> => ({ ...tab, id: 8 })),
  update: vi.fn(async (..._args: [chrome.tabs.UpdateProperties] | [number, chrome.tabs.UpdateProperties]): Promise<chrome.tabs.Tab | undefined> => tab),
  move: vi.fn(async (tabIds: number | Array<number>, _moveProperties: chrome.tabs.MoveProperties): Promise<chrome.tabs.Tab | Array<chrome.tabs.Tab>> =>
    Array.isArray(tabIds) ? tabIds.map((id) => ({ ...tab, id })) : { ...tab, id: tabIds }),
  reload: vi.fn(async (..._args: [] | [number] | [chrome.tabs.ReloadProperties] | [number, chrome.tabs.ReloadProperties]) => {}),
  remove: vi.fn(async (_tabIds: number | Array<number>) => {}),
  highlight: vi.fn(async (_highlightInfo: chrome.tabs.HighlightInfo) => window),
  group: vi.fn(async (_options: chrome.tabs.GroupOptions) => 4),
  ungroup: vi.fn(async (_tabIds: number | [number, ...Array<number>]) => {}),
  createSplit: vi.fn(async (_tabIds: [number, number]) => 5),
  unsplit: vi.fn(async (_splitViewId: number) => {}),
  discard: vi.fn(async (_tabId?: number): Promise<chrome.tabs.Tab | undefined> => ({ ...tab, discarded: true })),
  goBack: vi.fn(async (_tabId?: number) => {}),
  goForward: vi.fn(async (_tabId?: number) => {}),
  getZoom: vi.fn(async (_tabId?: number) => 1.5),
  setZoom: vi.fn(async (..._args: [number] | [number, number]) => {}),
  getZoomSettings: vi.fn(async (_tabId?: number): Promise<chrome.tabs.ZoomSettings> => ({ mode: "automatic", scope: "per-tab" })),
  setZoomSettings: vi.fn(async (..._args: [chrome.tabs.ZoomSettings] | [number, chrome.tabs.ZoomSettings]) => {}),
  detectLanguage: vi.fn(async (_tabId?: number) => "fr"),
  // Messages and responses are the raw, undecoded Chrome boundary.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns
  sendMessage: vi.fn(async (_tabId: number, _message: unknown, _options?: chrome.tabs.MessageSendOptions): Promise<unknown> => ({ ok: true })),
  connect: vi.fn((_tabId: number, connectInfo?: chrome.tabs.ConnectInfo): chrome.runtime.Port => TestPort.makePortPair(connectInfo?.name).left.port),
  captureVisibleTab: vi.fn(async (..._args: [] | [number] | [chrome.extensionTypes.ImageDetails] | [number, chrome.extensionTypes.ImageDetails]) =>
    "data:image/jpeg;base64,AA=="),
  onCreated: mockEvent<[chrome.tabs.Tab]>((n) => [{ ...tab, id: n }]),
  onUpdated: mockEvent<[number, chrome.tabs.OnUpdatedInfo, chrome.tabs.Tab]>((n) => [n, { title: `${n}` }, { ...tab, id: n, title: `${n}` }]),
  onRemoved: mockEvent<[number, chrome.tabs.OnRemovedInfo]>((n) => [n, { windowId: 3, isWindowClosing: n % 2 === 0 }]),
  onActivated: mockEvent<[chrome.tabs.OnActivatedInfo]>((n) => [{ tabId: n, windowId: 3 }]),
  onMoved: mockEvent<[number, chrome.tabs.OnMovedInfo]>((n) => [n, { windowId: 3, fromIndex: n, toIndex: n + 1 }]),
  onReplaced: mockEvent<[number, number]>((n) => [n, n + 1]),
  onAttached: mockEvent<[number, chrome.tabs.OnAttachedInfo]>((n) => [n, { newWindowId: 4, newPosition: n }]),
  onDetached: mockEvent<[number, chrome.tabs.OnDetachedInfo]>((n) => [n, { oldWindowId: 3, oldPosition: n }]),
  onHighlighted: mockEvent<[chrome.tabs.OnHighlightedInfo]>((n) => [{ windowId: n, tabIds: [n, n + 1] }]),
  onZoomChange: mockEvent<[chrome.tabs.OnZoomChangeInfo]>((n) => [{ tabId: n, oldZoomFactor: 1, newZoomFactor: n, zoomSettings: { mode: "automatic" } }])
}) satisfies ChromeTabsApi

export type MockApi = ReturnType<typeof mockApi>

export type EventName =
  | "onCreated" | "onUpdated" | "onRemoved" | "onActivated" | "onMoved"
  | "onReplaced" | "onAttached" | "onDetached" | "onHighlighted" | "onZoomChange"

/** One event of the service, erased to what generic stream tests need. */
export interface EventCase {
  readonly name: EventName
  readonly probe: (api: MockApi) => EventProbe
  /** The stream, each value reduced to the `n` of the synthetic event it came from. */
  readonly keys: (tabs: ChromeTabsService) => Stream.Stream<number, ChromeTabsError>
  /** Subscribes, emits the `n`th event, and checks the stream emitted exactly its projection. */
  readonly delivers: (api: MockApi, tabs: ChromeTabsService, n: number) => Effect.Effect<void, ChromeTabsError>
}

const eventCase = <Args extends ReadonlyArray<unknown>, A>(
  name: EventName,
  select: (api: MockApi) => ReturnType<typeof mockEvent<Args>>,
  stream: (tabs: ChromeTabsService) => Stream.Stream<A, ChromeTabsError>,
  expected: (...args: Args) => A,
  key: (value: A) => number
): EventCase => ({
  name,
  probe: (api) => select(api).probe,
  keys: (tabs) => Stream.map(stream(tabs), key),
  delivers: (api, tabs, n) => Effect.gen(function*() {
    const event = select(api)
    const before = event.listeners.size
    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(stream(tabs), 1)))
    yield* Effect.promise(() => event.probe.waitForListeners(before + 1))
    event.probe.emitNth(n)
    expect(yield* Fiber.join(fiber)).toEqual([expected(...event.nth(n))])
  })
})

/** Every event, with the projection the service promises for it. */
export const eventCases: ReadonlyArray<EventCase> = [
  eventCase("onCreated", (api) => api.onCreated, (tabs) => tabs.onCreated, (created) => created, (value) => value.id ?? -1),
  eventCase("onUpdated", (api) => api.onUpdated, (tabs) => tabs.onUpdated,
    (tabId, changeInfo, updated) => ({ tabId, changeInfo, tab: updated }), (value) => value.tabId),
  eventCase("onRemoved", (api) => api.onRemoved, (tabs) => tabs.onRemoved, (tabId, removeInfo) => ({ tabId, removeInfo }), (value) => value.tabId),
  eventCase("onActivated", (api) => api.onActivated, (tabs) => tabs.onActivated, (activeInfo) => activeInfo, (value) => value.tabId),
  eventCase("onMoved", (api) => api.onMoved, (tabs) => tabs.onMoved, (tabId, moveInfo) => ({ tabId, moveInfo }), (value) => value.tabId),
  eventCase("onReplaced", (api) => api.onReplaced, (tabs) => tabs.onReplaced,
    (addedTabId, removedTabId) => ({ addedTabId, removedTabId }), (value) => value.addedTabId),
  eventCase("onAttached", (api) => api.onAttached, (tabs) => tabs.onAttached, (tabId, attachInfo) => ({ tabId, attachInfo }), (value) => value.tabId),
  eventCase("onDetached", (api) => api.onDetached, (tabs) => tabs.onDetached, (tabId, detachInfo) => ({ tabId, detachInfo }), (value) => value.tabId),
  eventCase("onHighlighted", (api) => api.onHighlighted, (tabs) => tabs.onHighlighted, (highlightInfo) => highlightInfo, (value) => value.windowId),
  eventCase("onZoomChange", (api) => api.onZoomChange, (tabs) => tabs.onZoomChange, (zoomInfo) => zoomInfo, (value) => value.tabId)
]

/** The members that return a Promise, each with a representative service call. */
export type PromiseOperation = Exclude<keyof MockApi, EventName | "connect">

/** Runs `operation` through the service with arguments keyed by `n`, discarding the result. */
export const runOperation = (tabs: ChromeTabsService, operation: PromiseOperation, n: number): Effect.Effect<void, ChromeTabsError> => {
  switch (operation) {
    case "get": return Effect.asVoid(tabs.get(n))
    case "getCurrent": return Effect.asVoid(tabs.getCurrent)
    case "query": return Effect.asVoid(tabs.query({ index: n }))
    case "create": return Effect.asVoid(tabs.create({ index: n }))
    case "duplicate": return Effect.asVoid(tabs.duplicate(n))
    case "update": return Effect.asVoid(tabs.update(n, { pinned: true }))
    case "move": return Effect.asVoid(tabs.move(n, { index: 0 }))
    case "reload": return tabs.reload(n)
    case "remove": return tabs.remove(n)
    case "highlight": return Effect.asVoid(tabs.highlight({ tabs: n }))
    case "group": return Effect.asVoid(tabs.group({ tabIds: n }))
    case "ungroup": return tabs.ungroup(n)
    case "createSplit": return Effect.asVoid(tabs.createSplit([n, n + 1]))
    case "unsplit": return tabs.unsplit(n)
    case "discard": return Effect.asVoid(tabs.discard(n))
    case "goBack": return tabs.goBack(n)
    case "goForward": return tabs.goForward(n)
    case "getZoom": return Effect.asVoid(tabs.getZoom(n))
    case "setZoom": return tabs.setZoom(n, 2)
    case "getZoomSettings": return Effect.asVoid(tabs.getZoomSettings(n))
    case "setZoomSettings": return tabs.setZoomSettings(n, { mode: "manual" })
    case "detectLanguage": return Effect.asVoid(tabs.detectLanguage(n))
    case "sendMessage": return Effect.asVoid(tabs.sendMessage(n, { n }))
    case "captureVisibleTab": return Effect.asVoid(tabs.captureVisibleTab(n))
  }
}

export const promiseOperations: ReadonlyArray<PromiseOperation> = [
  "get", "getCurrent", "query", "create", "duplicate", "update", "move", "reload", "remove", "highlight",
  "group", "ungroup", "createSplit", "unsplit", "discard", "goBack", "goForward", "getZoom", "setZoom",
  "getZoomSettings", "setZoomSettings", "detectLanguage", "sendMessage", "captureVisibleTab"
]

/** A service over fresh mocks; the mocks are returned for assertions. */
export const service = () => {
  const api = mockApi()

  return { api, tabs: make(api) }
}
