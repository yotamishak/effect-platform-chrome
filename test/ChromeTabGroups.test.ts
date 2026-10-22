// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Option, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeTabGroups, ChromeTabGroupsError, layer, layerLive, make } from "../src/ChromeTabGroups.js"
import type { ChromeTabGroupsApi, TabGroup } from "../src/ChromeTabGroups.js"

const group: TabGroup = { id: 4, collapsed: false, color: "blue", shared: false, title: "Research", windowId: 3 }

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
    emit: (value: TabGroup) => { for (const listener of listeners) listener(value) }
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

describe("ChromeTabGroups", () => {
  it.effect("reads, queries, updates and moves groups, preserving arguments", () => Effect.gen(function*() {
    const api = mockApi()
    const groups = make(api)
    const queryInfo: chrome.tabGroups.QueryInfo = { windowId: 3, collapsed: false, title: "" }
    expect(yield* groups.get(0)).toEqual({ ...group, id: 0 })
    expect(yield* groups.query(queryInfo)).toEqual([group])
    expect(yield* groups.update(4, { title: "Done", color: "green" })).toEqual(Option.some({ ...group, title: "Done", color: "green" }))
    expect(yield* groups.move(4, { index: -1, windowId: 5 })).toEqual(Option.some({ ...group, windowId: 5 }))
    expect(api.get).toHaveBeenCalledExactlyOnceWith(0)
    expect(api.query).toHaveBeenCalledExactlyOnceWith(queryInfo)
    expect(api.update).toHaveBeenCalledExactlyOnceWith(4, { title: "Done", color: "green" })
    expect(api.move).toHaveBeenCalledExactlyOnceWith(4, { index: -1, windowId: 5 })
  }))

  it.effect("maps a missing update or move result to None", () => Effect.gen(function*() {
    const api = mockApi()
    const groups = make(api)
    api.update.mockResolvedValueOnce(undefined)
    api.move.mockResolvedValueOnce(undefined)
    expect(yield* groups.update(4, {})).toEqual(Option.none())
    expect(yield* groups.move(4, { index: 0 })).toEqual(Option.none())
  }))

  it.effect.each(["get", "query", "update", "move"] as const)(
    "types synchronous throws and rejections from %s", (operation) => Effect.gen(function*() {
      for (const synchronous of [true, false]) {
        const cause = new Error(`No group with id: 9.`)

        const fail = () => {
          if (synchronous) throw cause

          return Promise.reject(cause)
        }

        const api: ChromeTabGroupsApi = { ...mockApi(), [operation]: fail }
        const groups = make(api)

        const effects = {
          get: Effect.asVoid(groups.get(9)), query: Effect.asVoid(groups.query({})),
          update: Effect.asVoid(groups.update(9, {})), move: Effect.asVoid(groups.move(9, { index: 0 }))
        }

        const error = yield* Effect.flip(effects[operation])
        expect(error).toBeInstanceOf(ChromeTabGroupsError)
        expect(error).toMatchObject({ operation, cause })
      }
    })
  )

  it.effect("streams each group event and removes its listener afterwards", () => Effect.gen(function*() {
    const api = mockApi()
    const groups = make(api)
    const sources = [api.onCreated, api.onUpdated, api.onRemoved, api.onMoved]
    const created = yield* Effect.forkScoped(Stream.runCollect(Stream.take(groups.onCreated, 1)))
    const updated = yield* Effect.forkScoped(Stream.runCollect(Stream.take(groups.onUpdated, 1)))
    const removed = yield* Effect.forkScoped(Stream.runCollect(Stream.take(groups.onRemoved, 1)))
    const moved = yield* Effect.forkScoped(Stream.runCollect(Stream.take(groups.onMoved, 1)))
    yield* Effect.promise(() => Promise.all(sources.map((source) => source.added)))
    sources.forEach((source, index) => source.emit({ ...group, id: index }))
    expect(yield* Effect.all([Fiber.join(created), Fiber.join(updated), Fiber.join(removed), Fiber.join(moved)])).toEqual(
      sources.map((_, index) => [{ ...group, id: index }])
    )

    for (const source of sources) {
      expect(source.listeners.size).toBe(0)
      expect(source.removeListener).toHaveBeenCalledExactlyOnceWith(source.addListener.mock.calls[0]?.[0])
    }
  }))

  it.effect("removes an interrupted subscription's listener", () => Effect.gen(function*() {
    const api = mockApi()
    const fiber = yield* Effect.forkScoped(Stream.runDrain(make(api).onUpdated))
    yield* Effect.promise(() => api.onUpdated.added)
    api.onUpdated.emit(group)
    yield* Fiber.interrupt(fiber)
    expect(api.onUpdated.listeners.size).toBe(0)
    expect(api.onUpdated.removeListener).toHaveBeenCalledTimes(1)
  }))

  it.effect.each(["onCreated", "onUpdated", "onRemoved", "onMoved"] as const)(
    "types listener registration failures from %s", (operation) => Effect.gen(function*() {
      const api = mockApi()
      const cause = new Error("listener unavailable")
      api[operation].addListener.mockImplementationOnce(() => { throw cause })
      const error = yield* Effect.flip(Stream.runDrain(make(api)[operation]))
      expect(error).toMatchObject({ operation, cause })
      expect(api[operation].removeListener).toHaveBeenCalledTimes(1)
    })
  )

  it.effect("provides an injected API and reads the global only when the live layer builds", () => Effect.gen(function*() {
    const api = mockApi()
    expect(yield* Effect.flatMap(ChromeTabGroups, (groups) => groups.get(4)).pipe(Effect.provide(layer(api)))).toEqual(group)
    vi.stubGlobal("chrome", {})
    expect(yield* Effect.flip(ChromeTabGroups.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
    vi.stubGlobal("chrome", { tabGroups: api })
    expect(yield* Effect.flatMap(ChromeTabGroups, (groups) => groups.get(5)).pipe(Effect.provide(layerLive))).toEqual({ ...group, id: 5 })
  }))
})
