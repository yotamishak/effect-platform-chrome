// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Deferred, Effect, Exit, Fiber, Layer, Option, Schedule, Stream } from "effect"
import { describe, expect, expectTypeOf, it, vi } from "@effect/vitest"
import { ChromeTabGroups, ChromeTabGroupsError, TAB_GROUP_ID_NONE, layer, layerLive, make } from "../src/ChromeTabGroups.js"
import type { ChromeTabGroupsApi, ChromeTabGroupsService, TabGroup } from "../src/ChromeTabGroups.js"
import { makeTabGroups, matchesGroupTitle } from "../src/testing/TabGroups.js"

const group: TabGroup = { id: 4, collapsed: false, color: "blue", shared: false, title: "Research", windowId: 3 }

const eventNames = ["onCreated", "onUpdated", "onRemoved", "onMoved"] as const

const callNames = ["get", "query", "update", "move"] as const

const event = () => {
  const listeners = new Set<(group: TabGroup) => void>()
  let notify!: () => void
  const added = new Promise<void>((resolve) => { notify = resolve })

  return {
    listeners,
    added,
    addListener: vi.fn((listener: (group: TabGroup) => void) => {
      listeners.add(listener)
      notify()
    }),
    removeListener: vi.fn((listener: (group: TabGroup) => void) => { listeners.delete(listener) }),
    emit: (value: TabGroup) => { for (const listener of Array.from(listeners)) listener(value) }
  }
}

const mockApi = () => ({
  get: vi.fn(async (groupId: number) => ({ ...group, id: groupId })),
  query: vi.fn(async (_queryInfo: chrome.tabGroups.QueryInfo) => [group]),
  update: vi.fn(async (groupId: number, properties: chrome.tabGroups.UpdateProperties): Promise<TabGroup | undefined> =>
    ({ ...group, ...properties, id: groupId })),
  move: vi.fn(async (groupId: number, properties: chrome.tabGroups.MoveProperties): Promise<TabGroup | undefined> =>
    ({ ...group, id: groupId, windowId: properties.windowId ?? group.windowId })),
  onCreated: event(),
  onUpdated: event(),
  onRemoved: event(),
  onMoved: event()
}) satisfies ChromeTabGroupsApi

/** Each call with arguments that make it reach Chrome. */
const calls = (groups: ChromeTabGroupsService) => ({
  get: Effect.asVoid(groups.get(9)),
  query: Effect.asVoid(groups.query({})),
  update: Effect.asVoid(groups.update(9, {})),
  move: Effect.asVoid(groups.move(9, { index: 0 }))
})

describe("ChromeTabGroups", () => {
  it("accepts Chrome's own namespace as its API and mirrors TAB_GROUP_ID_NONE", () => {
    expectTypeOf<typeof chrome.tabGroups>().toExtend<ChromeTabGroupsApi>()
    expectTypeOf<chrome.tabGroups.TabGroup>().toExtend<TabGroup>()
    expectTypeOf<TabGroup["shared"]>().toEqualTypeOf<boolean | undefined>()
    expect(TAB_GROUP_ID_NONE).toBe(-1)
  })

  it.effect("reads, queries, updates and moves groups, preserving arguments", () => Effect.gen(function*() {
    const api = mockApi()
    const groups = make(api)
    const queryInfo: chrome.tabGroups.QueryInfo = { windowId: 3, collapsed: false, title: "" }
    expect(yield* groups.get(0)).toEqual({ ...group, id: 0 })
    expect(yield* groups.query(queryInfo)).toEqual([group])
    expect(yield* groups.query({})).toEqual([group])
    expect(yield* groups.update(4, { title: "Done", color: "green" })).toEqual(Option.some({ ...group, title: "Done", color: "green" }))
    expect(yield* groups.move(4, { index: -1, windowId: 5 })).toEqual(Option.some({ ...group, windowId: 5 }))
    expect(yield* groups.move(4, { index: 2 })).toEqual(Option.some(group))
    expect(api.get.mock.calls).toEqual([[0]])
    expect(api.query.mock.calls).toEqual([[queryInfo], [{}]])
    expect(api.query.mock.calls[0]?.[0]).toBe(queryInfo)
    expect(api.update.mock.calls).toEqual([[4, { title: "Done", color: "green" }]])
    expect(api.move.mock.calls).toEqual([[4, { index: -1, windowId: 5 }], [4, { index: 2 }]])
    expect(Object.keys(api.move.mock.calls[1]?.[1] ?? {})).toEqual(["index"])
  }))

  it.effect("passes a group without `shared` through unchanged, as Chrome before 137 reports it", () => Effect.gen(function*() {
    const api = mockApi()
    const legacy: TabGroup = { id: 7, collapsed: true, color: "grey", title: "", windowId: 1 }
    api.get.mockResolvedValueOnce(legacy)
    const result = yield* make(api).get(7)
    expect(result).toBe(legacy)
    expect("shared" in result).toBe(false)
  }))

  it.effect("runs nothing until executed and calls Chrome again on every execution", () => Effect.gen(function*() {
    const api = mockApi()
    const groups = make(api)
    const effects = calls(groups)
    expect(api.get).not.toHaveBeenCalled()
    expect(api.query).not.toHaveBeenCalled()
    expect(api.update).not.toHaveBeenCalled()
    expect(api.move).not.toHaveBeenCalled()

    for (const name of callNames) {
      yield* effects[name]
      yield* effects[name]
    }

    expect([api.get, api.query, api.update, api.move].map((call) => call.mock.calls.length)).toEqual([2, 2, 2, 2])
  }))

  it.effect("maps a missing update or move result to None", () => Effect.gen(function*() {
    const api = mockApi()
    const groups = make(api)
    api.update.mockResolvedValueOnce(undefined)
    api.move.mockResolvedValueOnce(undefined)
    expect(yield* groups.update(4, {})).toEqual(Option.none())
    expect(yield* groups.move(4, { index: 0 })).toEqual(Option.none())
  }))

  it.effect.each(callNames)("types synchronous throws and rejections from %s", (operation) => Effect.gen(function*() {
    for (const synchronous of [true, false]) {
      const cause = new Error(`No group with id: 9.`)

      const fail = () => {
        if (synchronous) throw cause

        return Promise.reject(cause)
      }

      const api: ChromeTabGroupsApi = { ...mockApi(), [operation]: fail }
      const error = yield* Effect.flip(calls(make(api))[operation])
      expect(error).toBeInstanceOf(ChromeTabGroupsError)
      expect(error._tag).toBe("ChromeTabGroupsError")
      expect(error.operation).toBe(operation)
      expect(error.cause).toBe(cause)
    }
  }))

  it.effect.each(callNames)("keeps a non-Error cause from %s unchanged", (operation) => Effect.gen(function*() {
    const thrown = { reason: "not an Error" }
    const rejected = "plain string"
    const api: ChromeTabGroupsApi = { ...mockApi(), [operation]: () => { throw thrown } }
    expect((yield* Effect.flip(calls(make(api))[operation])).cause).toBe(thrown)
    const rejecting: ChromeTabGroupsApi = { ...mockApi(), [operation]: () => Promise.reject(rejected) }
    expect((yield* Effect.flip(calls(make(rejecting))[operation])).cause).toBe(rejected)
  }))

  it.effect.each(callNames)("types a %s that returns no Promise, as Chrome without Promise support does", (operation) =>
    Effect.gen(function*() {
      const api: ChromeTabGroupsApi = mockApi()
      // Chrome before Promise support returns undefined from a call without a callback.
      Reflect.set(api, operation, () => undefined)
      const error = yield* Effect.flip(calls(make(api))[operation])
      expect(error).toMatchObject({ operation })
      expect(error.cause).toBeInstanceOf(TypeError)
    }))

  it.effect.each(callNames)("interrupts a pending %s without waiting for Chrome", (operation) => Effect.gen(function*() {
    let started!: () => void
    const arrived = new Promise<void>((resolve) => { started = resolve })

    const pending = () => {
      started()

      return new Promise<never>(() => {})
    }

    const api: ChromeTabGroupsApi = { ...mockApi(), [operation]: pending }
    const fiber = yield* Effect.forkChild(calls(make(api))[operation])
    yield* Effect.promise(() => arrived)
    yield* Fiber.interrupt(fiber)
    expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
  }))

  it.effect("streams each group event in order and removes its listener afterwards", () => Effect.gen(function*() {
    const api = mockApi()
    const groups = make(api)
    const sources = eventNames.map((name) => api[name])
    const fibers = yield* Effect.forEach(eventNames, (name) => Effect.forkScoped(Stream.runCollect(Stream.take(groups[name], 3))))
    yield* Effect.promise(() => Promise.all(sources.map((source) => source.added)))

    for (const [index, source] of sources.entries()) {
      for (const offset of [0, 1, 2]) source.emit({ ...group, id: index * 10 + offset })
    }

    expect(yield* Effect.forEach(fibers, Fiber.join)).toEqual(
      sources.map((_, index) => [0, 1, 2].map((offset) => ({ ...group, id: index * 10 + offset })))
    )

    for (const source of sources) {
      expect(source.listeners.size).toBe(0)
      expect(source.addListener).toHaveBeenCalledTimes(1)
      expect(source.removeListener).toHaveBeenCalledExactlyOnceWith(source.addListener.mock.calls[0]?.[0])
    }
  }))

  it.effect("emits the very object Chrome passes", () => Effect.gen(function*() {
    const api = mockApi()
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(make(api).onUpdated, 1)))
    yield* Effect.promise(() => api.onUpdated.added)
    api.onUpdated.emit(group)
    const [received] = yield* Fiber.join(fiber)
    expect(received).toBe(group)
  }))

  it.effect("gives every consumption its own listener", () => Effect.gen(function*() {
    const api = mockApi()
    const stream = make(api).onCreated
    let registered = 0
    const both = Deferred.makeUnsafe<void>()

    api.onCreated.addListener.mockImplementation((listener) => {
      api.onCreated.listeners.add(listener)
      registered++

      if (registered === 2) Deferred.doneUnsafe(both, Effect.void)
    })

    const first = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 2)))
    const second = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 1)))
    yield* Deferred.await(both)
    expect(api.onCreated.listeners.size).toBe(2)
    api.onCreated.emit({ ...group, id: 1 })
    expect(yield* Fiber.join(second)).toEqual([{ ...group, id: 1 }])
    expect(api.onCreated.listeners.size).toBe(1)
    api.onCreated.emit({ ...group, id: 2 })
    expect(yield* Fiber.join(first)).toEqual([{ ...group, id: 1 }, { ...group, id: 2 }])
    expect(api.onCreated.listeners.size).toBe(0)
  }))

  it.effect.each(eventNames)("removes an interrupted %s subscription's listener and ignores later calls to it", (name) =>
    Effect.gen(function*() {
      const api = mockApi()
      const fiber = yield* Effect.forkScoped(Stream.runDrain(make(api)[name]))
      yield* Effect.promise(() => api[name].added)
      const listener = api[name].addListener.mock.calls[0]?.[0]
      api[name].emit(group)
      yield* Fiber.interrupt(fiber)
      expect(api[name].listeners.size).toBe(0)
      expect(api[name].removeListener).toHaveBeenCalledExactlyOnceWith(listener)
      expect(() => listener?.(group)).not.toThrow()
    }))

  it.effect.each(eventNames)("removes the %s listener when the consumer fails", (name) => Effect.gen(function*() {
    const api = mockApi()
    const failure = new Error("consumer failed")

    const fiber = yield* Effect.forkScoped(
      Stream.runDrain(Stream.mapEffect(make(api)[name], () => Effect.fail(failure)))
    )

    yield* Effect.promise(() => api[name].added)
    api[name].emit(group)
    expect(yield* Effect.flip(Fiber.join(fiber))).toBe(failure)
    expect(api[name].listeners.size).toBe(0)
    expect(api[name].removeListener).toHaveBeenCalledTimes(1)
  }))

  it.effect.each(eventNames)("types listener registration failures from %s", (operation) => Effect.gen(function*() {
    const api = mockApi()
    const cause = new Error("listener unavailable")
    api[operation].addListener.mockImplementationOnce(() => { throw cause })
    const error = yield* Effect.flip(Stream.runDrain(make(api)[operation]))
    expect(error).toBeInstanceOf(ChromeTabGroupsError)
    expect(error).toMatchObject({ operation, cause })
    expect(api[operation].removeListener).toHaveBeenCalledTimes(1)
  }))

  it.effect.each(eventNames)("removes a %s listener added before registration threw", (operation) => Effect.gen(function*() {
    const api = mockApi()
    const cause = new Error("registered, then threw")

    api[operation].addListener.mockImplementationOnce((listener) => {
      api[operation].listeners.add(listener)

      throw cause
    })

    expect(yield* Effect.flip(Stream.runDrain(make(api)[operation]))).toMatchObject({ operation, cause })
    expect(api[operation].listeners.size).toBe(0)
  }))

  it.effect.each(eventNames)("reads %s only when the stream starts, typing a failing lookup", (operation) => Effect.gen(function*() {
    const cause = new Error("event lookup failed")
    const reads = { count: 0 }
    const api: ChromeTabGroupsApi = mockApi()

    Object.defineProperty(api, operation, {
      get: () => {
        reads.count++

        throw cause
      }
    })

    const stream = make(api)[operation]
    expect(reads.count).toBe(0)
    const error = yield* Effect.flip(Stream.runDrain(stream))
    expect(error).toBeInstanceOf(ChromeTabGroupsError)
    expect(error).toMatchObject({ operation, cause })
    expect(reads.count).toBe(1)
  }))

  it.effect("provides an injected API through layer", () => Effect.gen(function*() {
    const api = mockApi()
    expect(yield* Effect.flatMap(ChromeTabGroups, (groups) => groups.get(4)).pipe(Effect.provide(layer(api)))).toEqual(group)
    expect(api.get).toHaveBeenCalledExactlyOnceWith(4)
  }))

  it.effect("fails layerLive with initialize when chrome or chrome.tabGroups is missing", () => Effect.gen(function*() {
    vi.stubGlobal("chrome", undefined)
    const missing = yield* Effect.flip(Layer.build(layerLive))
    expect(missing).toBeInstanceOf(ChromeTabGroupsError)
    expect(missing).toMatchObject({ operation: "initialize" })
    expect(String(missing.cause)).toContain("chrome.tabGroups is unavailable")
    vi.stubGlobal("chrome", {})
    expect(yield* Effect.flip(ChromeTabGroups.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
    const cause = new Error("tabGroups permission missing")
    vi.stubGlobal("chrome", Object.defineProperty({}, "tabGroups", { get: () => { throw cause } }))
    expect(yield* Effect.flip(Layer.build(layerLive))).toMatchObject({ operation: "initialize", cause })
  }))

  it.effect("reads the global each time layerLive builds", () => Effect.gen(function*() {
    const first = mockApi()
    const second = mockApi()
    vi.stubGlobal("chrome", { tabGroups: first })
    expect(yield* Effect.flatMap(ChromeTabGroups, (groups) => groups.get(5)).pipe(Effect.provide(layerLive))).toEqual({ ...group, id: 5 })
    vi.stubGlobal("chrome", { tabGroups: second })
    yield* Effect.flatMap(ChromeTabGroups, (groups) => groups.get(6)).pipe(Effect.provide(layerLive))
    expect(first.get.mock.calls).toEqual([[5]])
    expect(second.get.mock.calls).toEqual([[6]])
  }))
})

describe("matchesGroupTitle", () => {
  it.each([
    ["", "", true],
    ["a", "", false],
    ["", "a", false],
    ["Research", "Research", true],
    ["Research", "research", false],
    ["Research", "Re*ch", true],
    ["Research", "*", true],
    ["", "*", true],
    ["", "?", true],
    ["abc", "a*", true],
    ["abc", "*c", true],
    ["abc", "*b*", true],
    ["abc", "*d*", false],
    ["ab", "ab?", true],
    ["abc", "ab?", true],
    ["abcd", "ab?", false],
    ["ac", "a?c", true],
    ["abc", "a?c", true],
    ["abbc", "a?c", false],
    ["abbc", "a??c", true],
    ["ab", "??", true],
    ["abc", "??", false],
    ["abc", "*?", true],
    ["abc", "?*", true],
    ["a*c", "a\\*c", true],
    ["abc", "a\\*c", false],
    ["a?", "a\\?", true],
    ["ab", "a\\?", false],
    ["a\\b", "a\\\\b", true],
    ["ab", "a\\b", true],
    ["a", "a\\", true],
    ["a\\", "a\\", false],
    ["aXbXc", "*b*c", true],
    ["abcabd", "*abd", true],
    ["\u{1F600}x", "?x", true],
    ["\u{1F600}x", "*x", true],
    ["x", "\u{1F600}", false],
    ["\uD800", "�", true],
    ["�", "\uDC00", true]
  ])("matches %j against %j: %s", (title, pattern, expected) => {
    expect(matchesGroupTitle(title, pattern)).toBe(expected)
  })
})

describe("makeTabGroups", () => {
  it.effect("starts with one empty, focused normal window and creates groups as tabs.group would", () => Effect.gen(function*() {
    const fixture = makeTabGroups()
    const groups = make(fixture.api)
    expect(fixture.controls.currentWindowId).toBe(1)
    expect(fixture.controls.strip(1)).toEqual([])
    expect(yield* groups.query({})).toEqual([])
    const created = fixture.controls.create({ title: "Work", color: "red", tabCount: 2 })
    expect(created).toEqual({ id: 1, collapsed: false, color: "red", shared: false, title: "Work", windowId: 1 })
    expect(fixture.controls.create()).toEqual({ id: 2, collapsed: false, color: "grey", shared: false, title: "", windowId: 1 })
    expect(fixture.controls.strip(1)).toEqual([1, 1, 2])
    expect(yield* groups.get(1)).toEqual(created)
    expect(fixture.controls.group(1)).toEqual(created)
    expect(fixture.controls.group(3)).toBeUndefined()
  }))

  it.effect("never aliases its state through results, events or controls", () => Effect.gen(function*() {
    const fixture = makeTabGroups()
    const seen: Array<TabGroup> = []
    fixture.api.onUpdated.addListener((value) => { seen.push(value) })
    const created = fixture.controls.create({ title: "Kept" })
    created.title = "changed"
    const read = yield* make(fixture.api).get(created.id)
    read.title = "changed"
    yield* make(fixture.api).update(created.id, {})
    const event = seen[0]
    expect(event).toBeDefined()

    if (event !== undefined) event.title = "changed"

    expect(fixture.controls.strip(1)).not.toBe(fixture.controls.strip(1))
    expect(fixture.controls.group(created.id)?.title).toBe("Kept")
  }))

  it.effect("fails get for a missing group and throws synchronously for invalid ids", () => Effect.gen(function*() {
    const fixture = makeTabGroups()
    const error = yield* Effect.flip(make(fixture.api).get(9))
    expect(error).toMatchObject({ operation: "get" })
    expect(error.cause).toEqual(new Error("No group with id: 9."))
    expect(() => fixture.api.get(-1)).toThrow("Value must be at least 0.")
    expect(() => fixture.api.get(1.5)).toThrow("expected integer")
    expect(yield* Effect.flip(make(fixture.api).get(-1))).toMatchObject({ operation: "get" })
  }))

  it.effect("queries every field, walking windows from the most recently focused", () => Effect.gen(function*() {
    const fixture = makeTabGroups()
    const groups = make(fixture.api)
    const second = fixture.controls.openWindow({ ungroupedTabs: 1 })
    const popup = fixture.controls.openWindow({ type: "popup" })
    const a = fixture.controls.create({ title: "Alpha", color: "blue" })
    const b = fixture.controls.create({ title: "Beta", color: "red", collapsed: true, shared: true })
    const c = fixture.controls.create({ windowId: second, title: "Gamma", color: "blue", index: 0 })
    const ids = (values: ReadonlyArray<TabGroup>) => values.map((value) => value.id)
    expect(ids(yield* groups.query({}))).toEqual([a.id, b.id, c.id])
    fixture.controls.focusWindow(second)
    expect(fixture.controls.currentWindowId).toBe(second)
    expect(ids(yield* groups.query({}))).toEqual([c.id, a.id, b.id])
    expect(ids(yield* groups.query({ windowId: -2 }))).toEqual([c.id])
    expect(ids(yield* groups.query({ windowId: 1 }))).toEqual([a.id, b.id])
    expect(ids(yield* groups.query({ windowId: -1 }))).toEqual([c.id, a.id, b.id])
    expect(ids(yield* groups.query({ windowId: popup }))).toEqual([])
    expect(ids(yield* groups.query({ windowId: 99 }))).toEqual([])
    expect(ids(yield* groups.query({ color: "blue" }))).toEqual([c.id, a.id])
    expect(ids(yield* groups.query({ collapsed: true }))).toEqual([b.id])
    expect(ids(yield* groups.query({ collapsed: false }))).toEqual([c.id, a.id])
    expect(ids(yield* groups.query({ shared: true }))).toEqual([b.id])
    expect(ids(yield* groups.query({ shared: false }))).toEqual([c.id, a.id])
    expect(ids(yield* groups.query({ title: "*a" }))).toEqual([c.id, a.id, b.id])
    expect(ids(yield* groups.query({ title: "?eta" }))).toEqual([b.id])
    expect(ids(yield* groups.query({ title: "" }))).toEqual([])
    expect(ids(yield* groups.query({ title: "Alpha", color: "blue", windowId: 1, collapsed: false }))).toEqual([a.id])
    expect(ids(yield* groups.query({ title: "Alpha", color: "red" }))).toEqual([])
    expect(() => fixture.api.query({ windowId: -3 })).toThrow("Value must be at least -2.")
    // SAFETY: deliberately passes a color outside Chrome's enum to exercise its validation.
    expect(() => fixture.api.query({ color: "black" as "blue" })).toThrow("Value must be one of")
  }))

  it.effect("fails query once every window is closed", () => Effect.gen(function*() {
    const fixture = makeTabGroups()
    fixture.controls.closeWindow(1)
    expect((yield* Effect.flip(make(fixture.api).query({}))).cause).toEqual(new Error("No current window"))
    expect(() => fixture.controls.currentWindowId).toThrow("No current window")
    expect(() => fixture.controls.create()).toThrow("No current window")
  }))

  it.effect("updates only the given properties and reports every update", () => Effect.gen(function*() {
    const fixture = makeTabGroups()
    const groups = make(fixture.api)
    const updates: Array<TabGroup> = []
    fixture.api.onUpdated.addListener((value) => { updates.push(value) })
    const created = fixture.controls.create({ title: "Old", color: "pink" })
    expect(yield* groups.update(created.id, { collapsed: true })).toEqual(Option.some({ ...created, collapsed: true }))
    expect(yield* groups.update(created.id, { title: "New" })).toEqual(Option.some({ ...created, collapsed: true, title: "New" }))
    expect(yield* groups.update(created.id, { color: "cyan" })).toEqual(Option.some({ ...created, collapsed: true, title: "New", color: "cyan" }))
    expect(yield* groups.update(created.id, {})).toEqual(Option.some({ ...created, collapsed: true, title: "New", color: "cyan" }))
    expect(yield* groups.update(created.id, { title: "\uD800" })).toEqual(Option.some({ ...created, collapsed: true, title: "�", color: "cyan" }))
    expect(updates.map((value) => [value.collapsed, value.title, value.color])).toEqual([
      [true, "Old", "pink"], [true, "New", "pink"], [true, "New", "cyan"], [true, "New", "cyan"], [true, "�", "cyan"]
    ])
    expect((yield* Effect.flip(groups.update(99, {}))).cause).toEqual(new Error("No group with id: 99."))
    // SAFETY: deliberately passes a color outside Chrome's enum to exercise its validation.
    expect(() => fixture.api.update(created.id, { color: "black" as "blue" })).toThrow("Value must be one of")
    expect(updates).toHaveLength(5)
  }))

  it.effect("moves a group within its window by Chrome's index rules", () => Effect.gen(function*() {
    const fixture = makeTabGroups()
    const groups = make(fixture.api)
    const moves: Array<TabGroup> = []
    fixture.api.onMoved.addListener((value) => { moves.push(value) })
    const a = fixture.controls.create({ tabCount: 2 })
    const b = fixture.controls.create()
    const c = fixture.controls.create({ tabCount: 2 })
    expect(fixture.controls.strip(1)).toEqual([a.id, a.id, b.id, c.id, c.id])
    expect(yield* groups.move(a.id, { index: 1 })).toEqual(Option.some(a))
    expect(fixture.controls.strip(1)).toEqual([b.id, a.id, a.id, c.id, c.id])
    yield* groups.move(a.id, { index: -1 })
    expect(fixture.controls.strip(1)).toEqual([b.id, c.id, c.id, a.id, a.id])
    yield* groups.move(b.id, { index: 99 })
    expect(fixture.controls.strip(1)).toEqual([c.id, c.id, a.id, a.id, b.id])
    yield* groups.move(b.id, { index: 0 })
    expect(fixture.controls.strip(1)).toEqual([b.id, c.id, c.id, a.id, a.id])
    yield* groups.move(b.id, { index: 0 })
    yield* groups.move(a.id, { index: 3 })
    yield* groups.move(a.id, { index: 1, windowId: 1 })
    expect(fixture.controls.strip(1)).toEqual([b.id, a.id, a.id, c.id, c.id])
    expect(moves.map((value) => value.id)).toEqual([a.id, a.id, b.id, b.id, a.id])
    const inside = yield* Effect.flip(groups.move(b.id, { index: 1 }))
    expect(inside).toMatchObject({ operation: "move" })
    expect(inside.cause).toEqual(new Error("Cannot move the group to an index that is in the middle of another group."))
    expect(fixture.controls.strip(1)).toEqual([b.id, a.id, a.id, c.id, c.id])
    expect(moves).toHaveLength(5)
  }))

  it.effect("keeps groups out of pinned tabs and leaves ungrouped tabs in place", () => Effect.gen(function*() {
    const fixture = makeTabGroups()
    const groups = make(fixture.api)
    const windowId = fixture.controls.openWindow({ pinnedTabs: 2, ungroupedTabs: 1 })
    const g = fixture.controls.create({ windowId })
    expect(fixture.controls.strip(windowId)).toEqual([-1, -1, -1, g.id])

    for (const index of [0, 1]) {
      expect((yield* Effect.flip(groups.move(g.id, { index }))).cause)
        .toEqual(new Error("Cannot move the group to an index that is in the middle of pinned tabs."))
    }

    yield* groups.move(g.id, { index: 2 })
    expect(fixture.controls.strip(windowId)).toEqual([-1, -1, g.id, -1])
    expect(() => fixture.controls.create({ windowId, index: 1 })).toThrow("middle of pinned tabs")
  }))

  it.effect("moves a group into another window as removal, creation and update", () => Effect.gen(function*() {
    const fixture = makeTabGroups()
    const groups = make(fixture.api)
    const log: Array<[string, TabGroup]> = []

    for (const name of eventNames) fixture.api[name].addListener((value) => { log.push([name, value]) })

    const target = fixture.controls.openWindow({ ungroupedTabs: 2 })
    const g = fixture.controls.create({ tabCount: 2, title: "Travel" })
    const other = fixture.controls.create({ windowId: target, index: 1, tabCount: 2 })
    log.length = 0
    expect(fixture.controls.strip(target)).toEqual([-1, other.id, other.id, -1])
    const inside = yield* Effect.flip(groups.move(g.id, { index: 2, windowId: target }))
    expect(inside.cause).toEqual(new Error("Cannot move the group to an index that is in the middle of another group."))
    expect(yield* groups.move(g.id, { index: 1, windowId: target })).toEqual(Option.some({ ...g, windowId: target }))
    expect(fixture.controls.strip(1)).toEqual([])
    expect(fixture.controls.strip(target)).toEqual([-1, g.id, g.id, other.id, other.id, -1])
    expect(log).toEqual([["onRemoved", g], ["onCreated", { ...g, windowId: target }], ["onUpdated", { ...g, windowId: target }]])
    log.length = 0
    yield* groups.move(g.id, { index: -1, windowId: 1 })
    expect(fixture.controls.strip(1)).toEqual([g.id, g.id])
    expect(log.map(([name]) => name)).toEqual(["onRemoved", "onCreated", "onUpdated"])
    fixture.controls.focusWindow(target)
    yield* groups.move(g.id, { index: 99, windowId: -2 })
    expect(fixture.controls.strip(target)).toEqual([-1, other.id, other.id, -1, g.id, g.id])
    expect(fixture.controls.group(g.id)?.windowId).toBe(target)
  }))

  it.effect("refuses moves to unknown or non-normal windows and invalid arguments", () => Effect.gen(function*() {
    const fixture = makeTabGroups()
    const groups = make(fixture.api)
    const popup = fixture.controls.openWindow({ type: "popup" })
    const g = fixture.controls.create()
    expect((yield* Effect.flip(groups.move(g.id, { index: 0, windowId: popup }))).cause)
      .toEqual(new Error("Tabs can only be moved to and from normal windows."))
    expect((yield* Effect.flip(groups.move(g.id, { index: 0, windowId: 42 }))).cause).toEqual(new Error("No window with id: 42."))
    expect((yield* Effect.flip(groups.move(g.id, { index: 0, windowId: -1 }))).cause).toEqual(new Error("No window with id: -1."))
    expect((yield* Effect.flip(groups.move(77, { index: 0 }))).cause).toEqual(new Error("No group with id: 77."))
    expect(() => fixture.api.move(g.id, { index: -2 })).toThrow("Value must be at least -1.")
    expect(() => fixture.api.move(-1, { index: 0 })).toThrow("Value must be at least 0.")
    expect(() => fixture.api.move(g.id, { index: 0, windowId: -3 })).toThrow("Value must be at least -2.")
    expect(() => fixture.api.move(g.id, { index: 0.5 })).toThrow("expected integer")
    expect(() => fixture.api.update(g.id, {})).not.toThrow()
    expect(fixture.controls.strip(1)).toEqual([g.id])
  }))

  it.effect("closes groups through remove, ungroup and closeWindow", () => Effect.gen(function*() {
    const fixture = makeTabGroups()
    const removed: Array<number> = []
    fixture.api.onRemoved.addListener((value) => { removed.push(value.id) })
    const second = fixture.controls.openWindow()
    const a = fixture.controls.create({ tabCount: 2 })
    const b = fixture.controls.create()
    const c = fixture.controls.create({ windowId: second })
    const d = fixture.controls.create({ windowId: second, index: 0 })
    fixture.controls.remove(a.id)
    expect(fixture.controls.strip(1)).toEqual([b.id])
    fixture.controls.ungroup(b.id)
    expect(fixture.controls.strip(1)).toEqual([-1])
    fixture.controls.focusWindow(second)
    fixture.controls.closeWindow(second)
    expect(removed).toEqual([a.id, b.id, d.id, c.id])
    expect(fixture.controls.currentWindowId).toBe(1)
    expect(() => fixture.controls.strip(second)).toThrow(`No window with id: ${second}.`)
    expect(() => fixture.controls.remove(a.id)).toThrow(`No group with id: ${a.id}.`)
    expect(() => fixture.controls.focusWindow(second)).toThrow(`No window with id: ${second}.`)
    expect(yield* make(fixture.api).query({})).toEqual([])
  }))

  it("refuses groups it cannot place", () => {
    const fixture = makeTabGroups()
    const popup = fixture.controls.openWindow({ type: "popup" })
    const g = fixture.controls.create({ tabCount: 3 })
    expect(() => fixture.controls.create({ windowId: popup })).toThrow("Grouping is not supported by tabs in this window.")
    expect(() => fixture.controls.create({ windowId: 9 })).toThrow("No window with id: 9.")
    expect(() => fixture.controls.create({ tabCount: 0 })).toThrow(RangeError)
    expect(() => fixture.controls.create({ tabCount: 1.5 })).toThrow(RangeError)
    expect(() => fixture.controls.create({ index: 1 })).toThrow("middle of another group")
    // SAFETY: deliberately passes a color outside Chrome's enum to exercise its validation.
    expect(() => fixture.controls.create({ color: "black" as "blue" })).toThrow("Value must be one of")
    expect(() => fixture.controls.openWindow({ pinnedTabs: -1 })).toThrow(RangeError)
    expect(() => fixture.controls.openWindow({ ungroupedTabs: 0.5 })).toThrow(RangeError)
    expect(fixture.controls.create({ index: 0 }).id).toBe(g.id + 1)
    expect(fixture.controls.strip(1)).toEqual([g.id + 1, g.id, g.id, g.id])
  })

  it.effect("drives the service streams and leaves no listener behind", () => Effect.gen(function*() {
    const fixture = makeTabGroups()
    const groups = make(fixture.api)
    const created = yield* Effect.forkScoped(Stream.runCollect(Stream.take(groups.onCreated, 2)))
    const updated = yield* Effect.forkScoped(Stream.runCollect(Stream.take(groups.onUpdated, 1)))
    yield* Effect.promise(() => fixture.controls.onCreated.waitForListener())
    yield* Effect.promise(() => fixture.controls.onUpdated.waitForListener())
    const first = fixture.controls.create({ title: "One" })
    const second = fixture.controls.create({ title: "Two" })
    yield* groups.update(first.id, { color: "orange" })
    expect(yield* Fiber.join(created)).toEqual([first, second])
    expect(yield* Fiber.join(updated)).toEqual([{ ...first, color: "orange" }])
    expect(fixture.controls.onCreated.listenerCount).toBe(0)
    expect(fixture.controls.onUpdated.listenerCount).toBe(0)
    fixture.controls.onMoved.failNext("addListener", new Error("busy"))
    expect(yield* Effect.flip(Stream.runDrain(groups.onMoved))).toMatchObject({ operation: "onMoved" })
    expect(fixture.controls.onMoved.listenerCount).toBe(0)
  }))

  it.effect("provides its layer over the same state and accepts overrides", () => Effect.gen(function*() {
    const cause = new Error("tab strip not editable")
    const fixture = makeTabGroups({ update: () => Promise.reject(cause) })
    const g = fixture.controls.create()
    const service = yield* ChromeTabGroups.pipe(Effect.provide(fixture.layer))
    expect(yield* service.get(g.id)).toEqual(g)
    expect(yield* Effect.flip(service.update(g.id, { title: "x" }))).toMatchObject({ operation: "update", cause })
    expect(fixture.controls.group(g.id)?.title).toBe("")
  }))

  it.effect("queries each window's groups in the order they joined it, not tab-strip order, as Chrome does", () =>
    Effect.gen(function*() {
      const fixture = makeTabGroups()
      const groups = make(fixture.api)
      const other = fixture.controls.openWindow()
      const ids = (values: ReadonlyArray<TabGroup>) => values.map((value) => value.id)
      const a = fixture.controls.create({ tabCount: 2 })
      const b = fixture.controls.create({ index: 0 })
      const c = fixture.controls.create({ windowId: other })
      expect(fixture.controls.strip(1)).toEqual([b.id, a.id, a.id])
      // Chrome's TabGroupModel lists groups in the order they were added to the window.
      expect(ids(yield* groups.query({ windowId: 1 }))).toEqual([a.id, b.id])
      yield* groups.move(b.id, { index: -1 })
      expect(fixture.controls.strip(1)).toEqual([a.id, a.id, b.id])
      expect(ids(yield* groups.query({ windowId: 1 }))).toEqual([a.id, b.id])
      yield* groups.move(a.id, { index: -1 })
      expect(ids(yield* groups.query({ windowId: 1 }))).toEqual([a.id, b.id])
      // A group moved in from another window is added last there, whatever its index.
      yield* groups.move(c.id, { index: 0, windowId: 1 })
      expect(fixture.controls.strip(1)).toEqual([c.id, b.id, a.id, a.id])
      expect(ids(yield* groups.query({ windowId: 1 }))).toEqual([a.id, b.id, c.id])
      yield* groups.move(a.id, { index: 0, windowId: other })
      expect(ids(yield* groups.query({}))).toEqual([b.id, c.id, a.id])
      fixture.controls.ungroup(b.id)
      expect(ids(yield* groups.query({ windowId: 1 }))).toEqual([c.id])
    }))

  it.effect("returns each call's own result and event payloads whatever a listener changes meanwhile", () =>
    Effect.gen(function*() {
      const fixture = makeTabGroups()
      const groups = make(fixture.api)
      const target = fixture.controls.openWindow()
      const g = fixture.controls.create({ title: "Before" })
      const h = fixture.controls.create()
      const log: Array<[string, string | undefined, number]> = []
      let reacting = true

      // Each listener changes the group again from inside the event, as a re-entrant handler would.
      fixture.api.onUpdated.addListener((value) => {
        log.push(["onUpdated", value.title, value.windowId])

        if (reacting && value.title === "Called") void fixture.api.update(value.id, { title: "Listener" })
      })
      fixture.api.onMoved.addListener((value) => {
        log.push(["onMoved", value.title, value.windowId])

        if (reacting) void fixture.api.update(value.id, { title: "Moved by listener" })
      })
      fixture.api.onRemoved.addListener((value) => {
        log.push(["onRemoved", value.title, value.windowId])

        if (reacting) {
          reacting = false
          void fixture.api.update(value.id, { title: "Renamed while crossing" })
        }
      })
      fixture.api.onCreated.addListener((value) => { log.push(["onCreated", value.title, value.windowId]) })

      const updated = yield* groups.update(g.id, { title: "Called" })
      expect(Option.map(updated, (value) => value.title)).toEqual(Option.some("Called"))
      expect(fixture.controls.group(g.id)?.title).toBe("Listener")

      const moved = yield* groups.move(g.id, { index: -1 })
      expect(Option.map(moved, (value) => value.title)).toEqual(Option.some("Listener"))
      expect(fixture.controls.group(g.id)?.title).toBe("Moved by listener")

      log.length = 0
      const crossed = yield* groups.move(h.id, { index: -1, windowId: target })
      expect(Option.map(crossed, (value) => [value.title, value.windowId])).toEqual(Option.some(["", target]))
      expect(log).toEqual([
        ["onRemoved", "", 1],
        ["onUpdated", "Renamed while crossing", target],
        ["onCreated", "", target],
        ["onUpdated", "", target]
      ])
      expect(fixture.controls.group(h.id)?.title).toBe("Renamed while crossing")
    }))

  it.effect("closes a window by its groups at each step, whatever its onRemoved listeners do", () => Effect.gen(function*() {
    const fixture = makeTabGroups()
    const doomed = fixture.controls.openWindow()
    const keep = fixture.controls.openWindow()
    const a = fixture.controls.create({ windowId: doomed })
    const b = fixture.controls.create({ windowId: doomed })
    const c = fixture.controls.create({ windowId: doomed })
    const removed: Array<number> = []

    fixture.api.onRemoved.addListener((value) => {
      removed.push(value.id)

      // Closing the first group also closes the second and adds a fourth to the closing window.
      if (value.id === a.id) {
        fixture.controls.remove(b.id)
        fixture.controls.create({ windowId: doomed })
      }
    })

    expect(() => fixture.controls.closeWindow(doomed)).not.toThrow()
    expect(removed).toEqual([a.id, b.id, c.id, c.id + 1])
    expect(() => fixture.controls.strip(doomed)).toThrow(`No window with id: ${doomed}.`)
    expect(yield* make(fixture.api).query({})).toEqual([])
    expect(fixture.controls.strip(keep)).toEqual([])
  }))

  it.effect("leaves other windows open and focused when an onRemoved listener closes the closing window again", () =>
    Effect.gen(function*() {
      const fixture = makeTabGroups()
      const doomed = fixture.controls.openWindow()
      const last = fixture.controls.openWindow()
      const kept = fixture.controls.create({ windowId: last, title: "Kept" })
      const a = fixture.controls.create({ windowId: doomed })
      fixture.controls.create({ windowId: doomed })
      let nested = 0

      fixture.api.onRemoved.addListener((value) => {
        if (value.id === a.id) {
          nested++
          fixture.controls.closeWindow(doomed)
        }
      })

      expect(() => fixture.controls.closeWindow(doomed)).not.toThrow()
      expect(nested).toBe(1)
      expect(fixture.controls.currentWindowId).toBe(1)
      fixture.controls.focusWindow(last)
      expect(yield* make(fixture.api).query({ windowId: -2 })).toEqual([kept])
      expect(() => fixture.controls.closeWindow(doomed)).toThrow(`No window with id: ${doomed}.`)
    }))

  it.effect("re-subscribes after a failed registration with exactly one live listener", () => Effect.gen(function*() {
    const fixture = makeTabGroups()
    fixture.controls.onUpdated.failNext("addListener", new Error("busy"))
    fixture.controls.onUpdated.failNext("addListener", new Error("still busy"))
    const stream = make(fixture.api).onUpdated.pipe(Stream.retry(Schedule.recurs(2)), Stream.take(1))
    const fiber = yield* Effect.forkScoped(Stream.runCollect(stream))
    yield* Effect.promise(() => fixture.controls.onUpdated.waitForListener())
    expect(fixture.controls.onUpdated.listenerCount).toBe(1)
    const g = fixture.controls.create()
    yield* make(fixture.api).update(g.id, { title: "Once" })
    expect((yield* Fiber.join(fiber)).map((value) => value.title)).toEqual(["Once"])
    expect(fixture.controls.onUpdated.listenerCount).toBe(0)
  }))
})
