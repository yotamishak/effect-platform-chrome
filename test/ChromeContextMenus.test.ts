// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Exit, Fiber, Option, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import {
  ACTION_MENU_TOP_LEVEL_LIMIT, ChromeContextMenus, ChromeContextMenusError, layer, layerLive, make
} from "../src/ChromeContextMenus.js"
import type {
  ChromeContextMenusApi, CreateProperties, MenuItemId, OnClickData, UpdateProperties
} from "../src/ChromeContextMenus.js"
import { makeContextMenus } from "../src/testing/ContextMenus.js"
import { makeEvent } from "../src/testing/Event.js"

const tab: chrome.tabs.Tab = {
  id: 7, index: 0, windowId: 1, highlighted: false, active: true, pinned: false, incognito: false,
  discarded: false, autoDiscardable: true, groupId: -1, frozen: false, selected: true, lastAccessed: 0,
  url: "https://app.example/"
}

/**
 * A gate the test fiber waits on. It is a native Promise, so the waiting fiber resumes in a later
 * microtask, never synchronously inside the Chrome call or callback that opens the gate.
 */
const gate = () => {
  let open!: () => void
  const opened = new Promise<void>((resolve) => { open = resolve })

  return { open: () => open(), opened: Effect.promise(() => opened) }
}

/** A spy API whose `create` confirms in a microtask and whose Promise calls resolve. */
const mockApi = () => {
  const onClicked = makeEvent<[OnClickData, chrome.tabs.Tab?]>()

  const api = {
    create: vi.fn((properties: CreateProperties, callback: () => void): MenuItemId => {
      queueMicrotask(callback)

      return properties.id ?? 1
    }),
    update: vi.fn(async (_id: MenuItemId, _updateProperties: UpdateProperties) => {}),
    remove: vi.fn(async (_menuItemId: MenuItemId) => {}),
    removeAll: vi.fn(async () => {}),
    onClicked: onClicked.api,
    lastError: undefined
  } satisfies ChromeContextMenusApi

  return { api, onClicked: onClicked.controls }
}

/**
 * A callback-form `chrome.contextMenus` with its `chrome.runtime`, as `layerLive` sees them.
 * Each call answers in a microtask; `failNext` sets `lastError` for the next answer of an
 * operation, and `failRead` makes the next `lastError` read throw.
 */
const liveGlobal = () => {
  let lastError: chrome.runtime.LastError | undefined
  let readFailure: unknown
  const failures = new Map<string, chrome.runtime.LastError>()
  const onClicked = makeEvent<[OnClickData, chrome.tabs.Tab?]>()

  const answer = (operation: string, callback: () => void) => {
    queueMicrotask(() => {
      lastError = failures.get(operation)
      failures.delete(operation)

      try { callback() } finally { lastError = undefined }
    })
  }

  const contextMenus = {
    create: vi.fn((properties: CreateProperties, callback: () => void): MenuItemId => {
      answer("create", callback)

      return properties.id ?? 1
    }),
    update: vi.fn((_id: MenuItemId, _updateProperties: UpdateProperties, callback: () => void) => answer("update", callback)),
    remove: vi.fn((_menuItemId: MenuItemId, callback: () => void) => answer("remove", callback)),
    removeAll: vi.fn((callback: () => void) => answer("removeAll", callback)),
    onClicked: onClicked.api
  }

  const runtime = {
    get lastError() {
      if (readFailure !== undefined) {
        const failure = readFailure
        readFailure = undefined
        throw failure
      }

      return lastError
    }
  }

  return {
    contextMenus,
    runtime,
    onClicked: onClicked.controls,
    failNext: (operation: string, error: chrome.runtime.LastError) => { failures.set(operation, error) },
    failRead: (cause: unknown) => { readFailure = cause }
  }
}

/** An API whose `create` holds its callback until the test runs it, with a settable `lastError`. */
const heldCreate = () => {
  const called = gate()
  const callbacks: Array<() => void> = []
  let lastError: chrome.runtime.LastError | undefined
  const base = mockApi()

  const api: ChromeContextMenusApi = {
    ...base.api,
    create: (properties, callback) => {
      callbacks.push(callback)
      called.open()

      return properties.id ?? 1
    },
    get lastError() { return lastError }
  }

  /** Runs the held callback the way Chrome does, with `lastError` set only while it runs. */
  const confirm = (error?: string) => {
    const callback = callbacks.shift()

    if (callback === undefined) throw new Error("no create callback is pending")

    lastError = error === undefined ? undefined : { message: error }

    try { callback() } finally { lastError = undefined }
  }

  return { api, remove: base.api.remove, called: called.opened, confirm, callbacks }
}

describe("ChromeContextMenus", () => {
  it("mirrors chrome.contextMenus.ACTION_MENU_TOP_LEVEL_LIMIT", () => {
    expect(ACTION_MENU_TOP_LEVEL_LIMIT).toBe(6)
  })

  describe("create", () => {
    it.effect("resolves to the caller's or Chrome's id once the callback confirms it", () => Effect.gen(function*() {
      const fake = makeContextMenus()
      const menus = make(fake.api)
      expect(yield* menus.create({ id: "root", title: "Save" })).toBe("root")
      expect(yield* menus.create({ parentId: "root", title: "Save link", contexts: ["link"] })).toBe(1)
      expect(yield* menus.create({ title: "Next" })).toBe(2)
      expect(fake.controls.items()).toEqual([
        { id: "root", parentId: undefined, properties: { title: "Save" } },
        { id: 1, parentId: "root", properties: { title: "Save link", contexts: ["link"] } },
        { id: 2, parentId: undefined, properties: { title: "Next" } }
      ])
    }))

    it.effect("passes the caller's properties unchanged with a callback, lazily and on every run", () => Effect.gen(function*() {
      const { api } = mockApi()
      const properties: CreateProperties = { id: "save", title: "Save", contexts: ["selection"] }
      const create = make(api).create(properties)
      expect(api.create).not.toHaveBeenCalled()
      expect(yield* create).toBe("save")
      expect(yield* create).toBe("save")
      expect(api.create).toHaveBeenCalledTimes(2)
      expect(api.create.mock.calls[0]?.[0]).toBe(properties)
      expect(api.create.mock.calls[0]).toHaveLength(2)
      expect(api.create.mock.calls[0]?.[1]).toBeTypeOf("function")
    }))

    it.effect("fails with the lastError object Chrome reports in the callback, leaving the menu usable", () => Effect.gen(function*() {
      const fake = makeContextMenus()
      const menus = make(fake.api)
      yield* menus.create({ id: "root", title: "Save" })
      const duplicate = yield* Effect.flip(menus.create({ id: "root", title: "Again" }))
      expect(duplicate).toBeInstanceOf(ChromeContextMenusError)
      expect(duplicate).toMatchObject({ operation: "create", cause: { message: "Cannot create item with duplicate id root" } })
      expect(yield* Effect.flip(menus.create({ parentId: "missing", title: "Orphan" }))).toMatchObject({
        operation: "create", cause: { message: "Cannot find menu item with id missing" }
      })
      expect(fake.controls.item("root")?.properties).toEqual({ title: "Save" })
      expect(yield* menus.create({ id: "next", title: "Next" })).toBe("next")
    }))

    it.effect("keeps the exact lastError value as the cause", () => Effect.gen(function*() {
      const held = heldCreate()
      const menus = make(held.api)
      const fiber = yield* Effect.forkChild(Effect.flip(menus.create({ id: "a", title: "A" })))
      yield* held.called
      held.confirm("Cannot create item with duplicate id a")
      const error = yield* Fiber.join(fiber)
      expect(error.cause).toEqual({ message: "Cannot create item with duplicate id a" })
    }))

    it.effect("resolves when the callback runs before create returns", () => Effect.gen(function*() {
      const early = makeContextMenus({
        create: (_properties, callback) => {
          callback()

          return 9
        }
      })

      expect(yield* make(early.api).create({ title: "Early" })).toBe(9)
    }))

    it.effect("fails when an early callback reports lastError, ignoring the returned id", () => Effect.gen(function*() {
      let lastError: chrome.runtime.LastError | undefined

      const api: ChromeContextMenusApi = {
        ...mockApi().api,
        create: (_properties, callback) => {
          lastError = { message: "Cannot find menu item with id gone" }

          try { callback() } finally { lastError = undefined }

          return 9
        },
        get lastError() { return lastError }
      }

      expect(yield* Effect.flip(make(api).create({ parentId: "gone", title: "Early" }))).toMatchObject({
        operation: "create", cause: { message: "Cannot find menu item with id gone" }
      })
    }))

    it.effect("types a synchronous throw, even one after an early confirming callback", () => Effect.gen(function*() {
      const cause = new Error("Error in invocation of contextMenus.create")
      const throwing = makeContextMenus({ create: () => { throw cause } })
      const error = yield* Effect.flip(make(throwing.api).create({ title: "" }))
      expect(error).toBeInstanceOf(ChromeContextMenusError)
      expect(error).toMatchObject({ operation: "create", cause })

      const late = makeContextMenus({
        create: (_properties, callback) => {
          callback()
          throw cause
        }
      })

      expect(yield* Effect.flip(make(late.api).create({ title: "Late" }))).toMatchObject({ operation: "create", cause })
    }))

    it.effect("types a lastError read that throws instead of hanging", () => Effect.gen(function*() {
      const cause = new Error("runtime unavailable")

      const api: ChromeContextMenusApi = {
        ...mockApi().api,
        get lastError(): chrome.runtime.LastError | undefined { throw cause }
      }

      expect(yield* Effect.flip(make(api).create({ id: "a", title: "A" }))).toMatchObject({ operation: "create", cause })
    }))

    it.effect("settles once when the callback runs twice", () => Effect.gen(function*() {
      const held = heldCreate()
      const fiber = yield* Effect.forkChild(make(held.api).create({ id: "a", title: "A" }))
      yield* held.called
      const callback = held.callbacks[0]
      held.confirm()
      expect(() => callback?.()).not.toThrow()
      expect(yield* Fiber.join(fiber)).toBe("a")
    }))

    it.effect("stops waiting when interrupted and ignores Chrome's later confirmation", () => Effect.gen(function*() {
      const held = heldCreate()
      const fiber = yield* Effect.forkChild(make(held.api).create({ id: "a", title: "A" }))
      yield* held.called
      yield* Fiber.interrupt(fiber)
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
      expect(() => held.confirm()).not.toThrow()
      expect(held.remove).not.toHaveBeenCalled()
    }))

    it.effect("still reads lastError in a callback that arrives after interruption, so Chrome logs no unchecked error", () =>
      Effect.gen(function*() {
        const callbacks: Array<() => void> = []
        const called = gate()
        let lastError: chrome.runtime.LastError | undefined
        let reads = 0

        const api: ChromeContextMenusApi = {
          ...mockApi().api,
          create: (_properties, callback) => {
            callbacks.push(callback)
            called.open()

            return "a"
          },
          get lastError() {
            reads++

            return lastError
          }
        }

        const fiber = yield* Effect.forkChild(make(api).create({ id: "a", title: "A" }))
        yield* called.opened
        yield* Fiber.interrupt(fiber)
        lastError = { message: "Cannot create item with duplicate id a" }
        callbacks[0]?.()
        lastError = undefined
        expect(reads).toBe(1)
      }))
  })

  describe("update, remove and removeAll", () => {
    it.effect("forward exactly their arguments", () => Effect.gen(function*() {
      const { api } = mockApi()
      const menus = make(api)
      const properties: UpdateProperties = { title: "Share page", enabled: false }
      yield* menus.update("share", properties)
      yield* menus.update(3, {})
      yield* menus.remove("share")
      yield* menus.remove(3)
      expect(api.update.mock.calls).toEqual([["share", properties], [3, {}]])
      expect(api.update.mock.calls[0]?.[1]).toBe(properties)
      expect(api.remove.mock.calls).toEqual([["share"], [3]])
    }))

    it.effect("runs removeAll as a lazy Effect value, once per run", () => Effect.gen(function*() {
      const { api } = mockApi()
      const { removeAll } = make(api)
      expect(api.removeAll).not.toHaveBeenCalled()
      yield* removeAll
      yield* removeAll
      expect(api.removeAll.mock.calls).toEqual([[], []])
    }))

    it.effect("update, remove and removeAll a real tree", () => Effect.gen(function*() {
      const fake = makeContextMenus()
      const menus = make(fake.api)
      yield* menus.create({ id: "root", title: "Save" })
      yield* menus.create({ id: "child", parentId: "root", title: "Save link" })
      yield* menus.create({ id: "other", title: "Share" })
      yield* menus.update("other", { title: "Share page", enabled: false })
      expect(fake.controls.item("other")?.properties).toEqual({ title: "Share page", enabled: false })
      yield* menus.remove("root")
      expect(fake.controls.items().map((item) => item.id)).toEqual(["other"])
      const error = yield* Effect.flip(menus.remove("root"))
      expect(error).toMatchObject({ operation: "remove", cause: new Error("Cannot find menu item with id root") })
      expect(yield* Effect.flip(menus.update("root", { title: "x" }))).toMatchObject({
        operation: "update", cause: new Error("Cannot find menu item with id root")
      })
      yield* menus.removeAll
      expect(fake.controls.items()).toEqual([])
      yield* menus.removeAll
    }))

    it.effect.each(["update", "remove", "removeAll"] as const)("types rejections and synchronous throws from %s", (operation) =>
      Effect.gen(function*() {
        for (const synchronous of [true, false]) {
          const cause = new Error(`${operation} failed`)

          const failing = () => {
            if (synchronous) throw cause

            return Promise.reject(cause)
          }

          const api: ChromeContextMenusApi = { ...mockApi().api, [operation]: failing }
          const menus = make(api)
          const effects = { update: menus.update("a", { title: "A" }), remove: menus.remove("a"), removeAll: menus.removeAll }
          const error = yield* Effect.flip(effects[operation])
          expect(error).toBeInstanceOf(ChromeContextMenusError)
          expect(error).toMatchObject({ operation, cause })
          expect(error.cause).toBe(cause)
        }
      }))

    it.effect("keeps a non-Error rejection as the cause", () => Effect.gen(function*() {
      const api: ChromeContextMenusApi = { ...mockApi().api, remove: () => Promise.reject("gone") }
      expect(yield* Effect.flip(make(api).remove(1))).toMatchObject({ operation: "remove", cause: "gone" })
    }))
  })

  describe("item", () => {
    it.effect("creates on acquire and removes the same id when the scope closes", () => Effect.gen(function*() {
      const fake = makeContextMenus()
      const menus = make(fake.api)
      yield* Effect.scoped(Effect.gen(function*() {
        expect(yield* menus.item({ id: "session", title: "Send to session" })).toBe("session")
        expect(yield* menus.item({ title: "Generated" })).toBe(1)
        expect(fake.controls.children()).toEqual(["session", 1])
      }))
      expect(fake.controls.items()).toEqual([])
    }))

    it.effect("ignores a release that fails because the item is already gone, or because remove throws", () => Effect.gen(function*() {
      const fake = makeContextMenus()
      const menus = make(fake.api)
      yield* Effect.scoped(Effect.gen(function*() {
        yield* menus.item({ id: "session", title: "Send to session" })
        yield* menus.removeAll
      }))
      const throwing = makeContextMenus({ remove: () => { throw new Error("remove unavailable") } })
      expect(yield* Effect.scoped(make(throwing.api).item({ id: "kept", title: "Kept" }))).toBe("kept")
      expect(throwing.controls.item("kept")).toBeDefined()
    }))

    it.effect("fails with the typed create error and never removes when creation fails", () => Effect.gen(function*() {
      const { api } = mockApi()
      const cause = new Error("bad properties")
      api.create.mockImplementationOnce(() => { throw cause })
      expect(yield* Effect.flip(Effect.scoped(make(api).item({ title: "Bad" })))).toMatchObject({ operation: "create", cause })
      const fake = makeContextMenus()
      expect(yield* Effect.flip(Effect.scoped(make(fake.api).item({ parentId: "missing", title: "Orphan" })))).toMatchObject({
        operation: "create", cause: { message: "Cannot find menu item with id missing" }
      })
      expect(api.remove).not.toHaveBeenCalled()
    }))

    it.effect("defers interruption until Chrome confirms, then removes the created item", () => Effect.gen(function*() {
      const held = heldCreate()
      const menus = make(held.api)
      const fiber = yield* Effect.forkChild(Effect.scoped(Effect.andThen(menus.item({ id: "a", title: "A" }), Effect.never)))
      yield* held.called
      fiber.interruptUnsafe()
      expect(fiber.pollUnsafe()).toBeUndefined()
      held.confirm()
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
      expect(held.remove.mock.calls).toEqual([["a"]])
    }))

    it.effect("removes nothing when an interrupted creation then fails", () => Effect.gen(function*() {
      const held = heldCreate()
      const fiber = yield* Effect.forkChild(Effect.scoped(make(held.api).item({ id: "a", title: "A" })))
      yield* held.called
      fiber.interruptUnsafe()
      held.confirm("Cannot create item with duplicate id a")
      const exit = yield* Fiber.await(fiber)
      expect(Option.getOrUndefined(Exit.findErrorOption(exit))).toMatchObject({
        operation: "create", cause: { message: "Cannot create item with duplicate id a" }
      })
      expect(held.remove).not.toHaveBeenCalled()
    }))
  })

  describe("onClicked", () => {
    it.effect("emits each click with an optional tab and removes its listener when it ends", () => Effect.gen(function*() {
      const fake = makeContextMenus()
      const menus = make(fake.api)
      yield* menus.create({ id: "root", title: "Save" })
      yield* menus.create({ id: "child", parentId: "root", title: "Save link", contexts: ["link"] })
      const clicks = yield* Effect.forkScoped(Stream.runCollect(Stream.take(menus.onClicked, 2)))
      yield* Effect.promise(() => fake.controls.onClicked.waitForListener())
      fake.controls.click("child", { linkUrl: "https://app.example/doc" }, tab)
      fake.controls.click("root")
      expect(yield* Fiber.join(clicks)).toEqual([
        {
          info: { menuItemId: "child", parentMenuItemId: "root", editable: false, pageUrl: tab.url, linkUrl: "https://app.example/doc" },
          tab: Option.some(tab)
        },
        { info: { menuItemId: "root", editable: false }, tab: Option.none() }
      ])
      expect(fake.controls.onClicked.listenerCount).toBe(0)
    }))

    it.effect("maps an absent tab to none and removes exactly the listener it added", () => Effect.gen(function*() {
      const added: Array<(info: OnClickData, tab?: chrome.tabs.Tab) => void> = []
      const removed: Array<unknown> = []
      const ready = gate()

      const api: ChromeContextMenusApi = {
        ...mockApi().api,
        onClicked: {
          addListener: (listener) => {
            added.push(listener)
            ready.open()
          },
          removeListener: (listener) => { removed.push(listener) }
        }
      }

      const clicks = yield* Effect.forkChild(Stream.runCollect(Stream.take(make(api).onClicked, 1)))
      yield* ready.opened
      added[0]?.({ menuItemId: 1, editable: true }, undefined)
      expect(yield* Fiber.join(clicks)).toEqual([{ info: { menuItemId: 1, editable: true }, tab: Option.none() }])
      expect(removed).toEqual(added)
    }))

    it.effect("removes its listener when interrupted and when downstream fails", () => Effect.gen(function*() {
      const fake = makeContextMenus()
      const menus = make(fake.api)
      yield* menus.create({ id: "a", title: "A" })
      const drain = yield* Effect.forkChild(Stream.runDrain(menus.onClicked))
      yield* Effect.promise(() => fake.controls.onClicked.waitForListener())
      yield* Fiber.interrupt(drain)
      expect(fake.controls.onClicked.listenerCount).toBe(0)

      const failure = new Error("handler failed")
      const failing = yield* Effect.forkChild(Effect.flip(Stream.runForEach(menus.onClicked, () => Effect.fail(failure))))
      yield* Effect.promise(() => fake.controls.onClicked.waitForListener())
      fake.controls.click("a")
      expect(yield* Fiber.join(failing)).toBe(failure)
      expect(fake.controls.onClicked.listenerCount).toBe(0)
    }))

    it.effect("gives concurrent subscribers their own listener and every click", () => Effect.gen(function*() {
      const fake = makeContextMenus()
      const menus = make(fake.api)
      yield* menus.create({ id: "a", title: "A" })
      const listening = gate()
      const base = fake.api.onClicked

      const api: ChromeContextMenusApi = {
        ...fake.api,
        onClicked: {
          addListener: (listener) => {
            base.addListener(listener)

            if (fake.controls.onClicked.listenerCount === 3) listening.open()
          },
          removeListener: (listener) => base.removeListener(listener)
        }
      }

      const ids = Stream.map(make(api).onClicked, (click) => click.info.menuItemId)
      const fibers = yield* Effect.forEach([1, 2, 3], () => Effect.forkChild(Stream.runCollect(Stream.take(ids, 2))))
      yield* listening.opened
      fake.controls.click("a")
      fake.controls.click("a")
      expect(yield* Fiber.joinAll(fibers)).toEqual([["a", "a"], ["a", "a"], ["a", "a"]])
      expect(fake.controls.onClicked.listenerCount).toBe(0)
    }))

    it.effect("types a failed listener registration as onClicked and cleans it up", () => Effect.gen(function*() {
      const fake = makeContextMenus()
      const cause = new Error("listener rejected")
      fake.controls.onClicked.failNext("addListener", cause)
      const error = yield* Effect.flip(Stream.runDrain(make(fake.api).onClicked))
      expect(error).toBeInstanceOf(ChromeContextMenusError)
      expect(error).toMatchObject({ operation: "onClicked", cause })
      expect(fake.controls.onClicked.listenerCount).toBe(0)
    }))

    it.effect("subscribes afresh when the same stream runs again after a failed registration", () => Effect.gen(function*() {
      const fake = makeContextMenus()
      const menus = make(fake.api)
      yield* menus.create({ id: "a", title: "A" })
      fake.controls.onClicked.failNext("addListener", new Error("listener rejected"))
      expect(yield* Effect.flip(Stream.runDrain(menus.onClicked))).toMatchObject({ operation: "onClicked" })
      const click = yield* Effect.forkChild(Stream.runHead(menus.onClicked))
      yield* Effect.promise(() => fake.controls.onClicked.waitForListener())
      fake.controls.click("a")
      expect(yield* Fiber.join(click)).toEqual(Option.some({ info: { menuItemId: "a", editable: false }, tab: Option.none() }))
      expect(fake.controls.onClicked.listenerCount).toBe(0)
    }))

    it.effect("types a throwing onClicked lookup when the stream starts, not when the service is made", () => Effect.gen(function*() {
      const cause = new Error("event unavailable")

      const api: ChromeContextMenusApi = {
        ...mockApi().api,
        get onClicked(): ChromeContextMenusApi["onClicked"] { throw cause }
      }

      const menus = make(api)
      expect(yield* Effect.flip(Stream.runDrain(menus.onClicked))).toMatchObject({ operation: "onClicked", cause })
    }))
  })

  describe("layers", () => {
    it.effect("provides an injected API", () => Effect.gen(function*() {
      const fake = makeContextMenus()
      expect(yield* Effect.flatMap(ChromeContextMenus, (menus) => menus.create({ id: "a", title: "A" })).pipe(Effect.provide(layer(fake.api)))).toBe("a")
      expect(yield* Effect.flatMap(ChromeContextMenus, (menus) => menus.remove("a")).pipe(Effect.provide(fake.layer), Effect.as(true))).toBe(true)
      expect(fake.controls.items()).toEqual([])
    }))

    it.effect("fails layerLive with initialize when chrome, contextMenus or runtime is missing", () => Effect.gen(function*() {
      yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => vi.unstubAllGlobals()))
      const { api } = mockApi()

      for (const global of [undefined, {}, { runtime: {} }, { contextMenus: api }]) {
        vi.stubGlobal("chrome", global)
        const error = yield* Effect.flip(ChromeContextMenus.pipe(Effect.provide(layerLive)))
        expect(error).toBeInstanceOf(ChromeContextMenusError)
        expect(error).toMatchObject({ operation: "initialize" })
      }

      const cause = new Error("contextMenus is not allowed")
      vi.stubGlobal("chrome", { runtime: {}, get contextMenus() { throw cause } })
      expect(yield* Effect.flip(ChromeContextMenus.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize", cause })
    }))

    it.effect("builds layerLive from the globals and delegates every member through Chrome's callback forms", () => Effect.gen(function*() {
      yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => vi.unstubAllGlobals()))
      const live = liveGlobal()
      vi.stubGlobal("chrome", { contextMenus: live.contextMenus, runtime: live.runtime })
      const menus = yield* ChromeContextMenus.pipe(Effect.provide(layerLive))
      const properties: CreateProperties = { id: "a", title: "A" }
      const updateProperties: UpdateProperties = { enabled: false }
      expect(yield* menus.create(properties)).toBe("a")
      yield* menus.update("a", updateProperties)
      yield* menus.remove("a")
      yield* menus.removeAll
      expect(live.contextMenus.create.mock.calls[0]?.[0]).toBe(properties)
      expect(live.contextMenus.update.mock.calls[0]?.slice(0, 2)).toEqual(["a", updateProperties])
      expect(live.contextMenus.update.mock.calls[0]?.[1]).toBe(updateProperties)
      expect(live.contextMenus.remove.mock.calls[0]?.[0]).toBe("a")

      for (const calls of [
        live.contextMenus.create.mock.calls, live.contextMenus.update.mock.calls,
        live.contextMenus.remove.mock.calls, live.contextMenus.removeAll.mock.calls
      ]) {
        expect(calls).toHaveLength(1)
        expect(calls[0]?.at(-1)).toBeTypeOf("function")
      }

      expect(live.contextMenus.update.mock.calls[0]).toHaveLength(3)
      expect(live.contextMenus.remove.mock.calls[0]).toHaveLength(2)
      expect(live.contextMenus.removeAll.mock.calls[0]).toHaveLength(1)
      const click = yield* Effect.forkChild(Stream.runHead(menus.onClicked))
      yield* Effect.promise(() => live.onClicked.waitForListener())
      live.onClicked.emit({ menuItemId: "a", editable: false }, tab)
      expect(yield* Fiber.join(click)).toEqual(Option.some({ info: { menuItemId: "a", editable: false }, tab: Option.some(tab) }))
      expect(live.onClicked.listenerCount).toBe(0)
    }))

    it.effect.each(["create", "update", "remove", "removeAll"] as const)(
      "fails live %s with the chrome.runtime.lastError its callback sees", (operation) => Effect.gen(function*() {
        yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => vi.unstubAllGlobals()))
        const live = liveGlobal()
        vi.stubGlobal("chrome", { contextMenus: live.contextMenus, runtime: live.runtime })
        const menus = yield* ChromeContextMenus.pipe(Effect.provide(layerLive))

        const effects = {
          create: menus.create({ id: "a", title: "A" }), update: menus.update("a", { title: "B" }),
          remove: menus.remove("a"), removeAll: menus.removeAll
        }

        const lastError = { message: `${operation} refused` }
        live.failNext(operation, lastError)
        const error = yield* Effect.flip(Effect.asVoid(effects[operation]))
        expect(error).toBeInstanceOf(ChromeContextMenusError)
        expect(error).toMatchObject({ operation })
        expect(error.cause).toBe(lastError)
        expect(yield* Effect.exit(Effect.asVoid(effects[operation]))).toEqual(Exit.void)
      })
    )

    it.effect.each(["update", "remove", "removeAll"] as const)(
      "types a synchronous throw and a throwing lastError read from live %s", (operation) => Effect.gen(function*() {
        yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => vi.unstubAllGlobals()))
        const live = liveGlobal()
        const cause = new Error("Error in invocation of contextMenus")
        live.contextMenus[operation].mockImplementationOnce(() => { throw cause })
        vi.stubGlobal("chrome", { contextMenus: live.contextMenus, runtime: live.runtime })
        const menus = yield* ChromeContextMenus.pipe(Effect.provide(layerLive))
        const effects = { update: menus.update("a", { title: "B" }), remove: menus.remove("a"), removeAll: menus.removeAll }
        expect(yield* Effect.flip(effects[operation])).toMatchObject({ operation, cause })
        const readFailure = new Error("runtime torn down")
        live.failRead(readFailure)
        expect(yield* Effect.flip(effects[operation])).toMatchObject({ operation, cause: readFailure })
      })
    )

    it.effect("does not touch chrome when the module is imported", () => Effect.gen(function*() {
      yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => vi.unstubAllGlobals()))
      const read = vi.fn()
      vi.stubGlobal("chrome", new Proxy({}, { get: (_target, property) => read(property) }))
      vi.resetModules()
      const module = yield* Effect.promise(() => import("../src/ChromeContextMenus.js"))
      expect(module.ACTION_MENU_TOP_LEVEL_LIMIT).toBe(6)
      expect(read).not.toHaveBeenCalled()
    }))
  })
})

describe("makeContextMenus", () => {
  const run = (fake: ReturnType<typeof makeContextMenus>) => make(fake.api)

  it.effect("generates increasing numeric ids, kept apart from equal-looking string ids", () => Effect.gen(function*() {
    const fake = makeContextMenus()
    const menus = run(fake)
    expect(yield* menus.create({ title: "One" })).toBe(1)
    expect(yield* menus.create({ id: "1", title: "String one" })).toBe("1")
    expect(yield* menus.create({ title: "Two" })).toBe(2)
    expect(fake.controls.children()).toEqual([1, "1", 2])
    yield* menus.remove(1)
    expect(fake.controls.children()).toEqual(["1", 2])
  }))

  it.effect("exposes lastError only while the create callback runs", () => Effect.gen(function*() {
    const fake = makeContextMenus()
    const seen: Array<chrome.runtime.LastError | undefined> = []
    const settled = gate()
    fake.api.create({ id: "a", title: "A" }, () => { seen.push(fake.api.lastError) })

    fake.api.create({ id: "a", title: "A" }, () => {
      seen.push(fake.api.lastError)
      settled.open()
    })

    expect(fake.api.lastError).toBeUndefined()
    expect(seen).toEqual([])
    yield* settled.opened
    expect(seen).toEqual([undefined, { message: "Cannot create item with duplicate id a" }])
    expect(fake.api.lastError).toBeUndefined()
  }))

  it.effect.each([
    [{ title: "" }, "All menu items except for separators must have a title"],
    [{ type: "checkbox", title: "" }, "All menu items except for separators must have a title"],
    [{ title: "Launch", contexts: ["page", "launcher"] }, "Only packaged apps are allowed to use 'launcher' context"],
    [{ title: "Child", parentId: "separator" }, "Parent items must have type \"normal\""],
    [{ title: "Child", parentId: "checkbox" }, "Parent items must have type \"normal\""],
    [{ title: "Child", parentId: 99 }, "Cannot find menu item with id 99"],
    [{ id: "checkbox", title: "Again" }, "Cannot create item with duplicate id checkbox"]
  ] satisfies Array<[CreateProperties, string]>)("reports %o through lastError as %s", ([properties, message]) => Effect.gen(function*() {
    const fake = makeContextMenus()
    const menus = run(fake)
    yield* menus.create({ id: "separator", type: "separator" })
    yield* menus.create({ id: "checkbox", type: "checkbox", title: "Check" })
    const before = fake.controls.items()
    expect(yield* Effect.flip(menus.create(properties))).toMatchObject({ operation: "create", cause: { message } })
    expect(fake.controls.items()).toEqual(before)
  }))

  it.effect("throws synchronously for malformed contexts or types, like Chrome's argument validation", () => Effect.gen(function*() {
    const fake = makeContextMenus()
    const menus = run(fake)
    yield* menus.create({ id: "a", title: "A" })
    // Untyped callers can pass what the typings forbid; build such values at runtime.
    const empty: CreateProperties = { title: "Empty", contexts: ["page"] }
    empty.contexts?.pop()
    const unknownContext: CreateProperties = { title: "Odd", contexts: ["page"] }
    Reflect.set(unknownContext.contexts ?? [], 0, "toolbar")
    const unknownType: CreateProperties = { title: "Odd" }
    Reflect.set(unknownType, "type", "toggle")

    for (const properties of [empty, unknownContext, unknownType]) {
      expect(() => fake.api.create(properties, () => {})).toThrow(/^Error in invocation of contextMenus\.create/)
      expect(yield* Effect.flip(menus.create(properties))).toMatchObject({ operation: "create" })
      expect(() => fake.api.update("a", properties)).toThrow(/^Error in invocation of contextMenus\.update/)
      expect(yield* Effect.flip(menus.update("a", properties))).toMatchObject({ operation: "update" })
    }

    expect(fake.controls.items().map((item) => item.id)).toEqual(["a"])
    expect(yield* menus.create({ title: "Fine" })).toBe(1)
  }))

  it.effect("caps top-level items at 1000, blocking children too, until one is removed", () => Effect.gen(function*() {
    const fake = makeContextMenus()
    const menus = run(fake)

    for (let index = 0; index < 1000; index++) yield* menus.create({ id: `item-${index}`, title: `Item ${index}` })

    const message = "An extension can create a maximum of 1000 menu items."
    expect(yield* Effect.flip(menus.create({ id: "extra", title: "Extra" }))).toMatchObject({ cause: { message } })
    expect(yield* Effect.flip(menus.create({ id: "child", parentId: "item-0", title: "Child" }))).toMatchObject({ cause: { message } })
    yield* menus.remove("item-999")
    yield* menus.create({ id: "child", parentId: "item-0", title: "Child" })
    yield* menus.create({ id: "extra", title: "Extra" })
    expect(fake.controls.children()).toHaveLength(1000)
    expect(fake.controls.items()).toHaveLength(1001)
  }))

  it.effect("requires an id and refuses onclick when configured as a service-worker extension", () => Effect.gen(function*() {
    const onclick = () => {}

    const worker = makeContextMenus({}, { serviceWorker: true })
    const menus = run(worker)
    expect(worker.api.create({ title: "No id" }, () => {})).toBe(1)
    expect(yield* Effect.flip(menus.create({ title: "No id" }))).toMatchObject({
      cause: { message: "Extensions using event pages or Service Workers must pass an id parameter to chrome.contextMenus.create" }
    })
    expect(yield* Effect.flip(menus.create({ id: "click", title: "Click", onclick }))).toMatchObject({
      cause: { message: expect.stringContaining("cannot pass an onclick parameter") }
    })
    expect(worker.controls.items()).toEqual([])
    expect(yield* menus.create({ id: "ok", title: "OK" })).toBe("ok")

    const page = makeContextMenus()
    expect(yield* run(page).create({ title: "Page", onclick })).toBe(1)
    expect(page.controls.item(1)?.properties.onclick).toBe(onclick)
  }))

  it.effect("updates field by field, keeping fields applied before a failure", () => Effect.gen(function*() {
    const fake = makeContextMenus()
    const menus = run(fake)
    yield* menus.create({ id: "box", type: "checkbox", title: "Box", checked: true })
    yield* menus.create({ id: "plain", title: "Plain" })
    yield* menus.create({ id: "line", type: "separator" })
    expect(yield* Effect.flip(menus.update("box", { type: "normal", checked: true }))).toMatchObject({
      operation: "update", cause: new Error("Only items with type \"radio\" or \"checkbox\" can be checked")
    })
    expect(fake.controls.item("box")?.properties.type).toBe("normal")
    expect(yield* Effect.flip(menus.update("plain", { enabled: false, title: "" }))).toMatchObject({
      cause: new Error("All menu items except for separators must have a title")
    })
    expect(yield* Effect.flip(menus.update("plain", { visible: false, contexts: ["launcher"] }))).toMatchObject({
      cause: new Error("Only packaged apps are allowed to use 'launcher' context")
    })
    expect(fake.controls.item("plain")?.properties).toEqual({ title: "Plain", visible: false })
    yield* menus.update("plain", { checked: false })
    expect(fake.controls.item("plain")?.properties).toEqual({ title: "Plain", visible: false })
    yield* menus.update("line", { title: "" })
    expect(fake.controls.item("line")?.properties).toEqual({ type: "separator", title: "" })
    yield* menus.update("plain", { documentUrlPatterns: ["https://*/*"], targetUrlPatterns: ["*://*/*.png"], contexts: ["image"] })
    expect(fake.controls.item("plain")?.properties).toEqual({
      title: "Plain", visible: false, documentUrlPatterns: ["https://*/*"], targetUrlPatterns: ["*://*/*.png"], contexts: ["image"]
    })
  }))

  it.effect("moves an item last among its new siblings and validates the new parent", () => Effect.gen(function*() {
    const fake = makeContextMenus()
    const menus = run(fake)
    yield* menus.create({ id: "a", title: "A" })
    yield* menus.create({ id: "b", title: "B" })
    yield* menus.create({ id: "a1", parentId: "a", title: "A1" })
    yield* menus.create({ id: "box", type: "checkbox", title: "Box" })
    yield* menus.update("b", { parentId: "a" })
    expect(fake.controls.children()).toEqual(["a", "box"])
    expect(fake.controls.children("a")).toEqual(["a1", "b"])
    expect(fake.controls.item("b")?.parentId).toBe("a")
    yield* menus.update("a1", { parentId: "a" })
    expect(fake.controls.children("a")).toEqual(["b", "a1"])
    expect(yield* Effect.flip(menus.update("b", { parentId: "missing" }))).toMatchObject({ cause: new Error("Cannot find menu item with id missing") })
    expect(yield* Effect.flip(menus.update("b", { parentId: "box" }))).toMatchObject({ cause: new Error("Parent items must have type \"normal\"") })
    expect(fake.controls.item("b")?.parentId).toBe("a")
  }))

  it.effect("resolves a parent cycle without moving the item, as Chrome's empty error does", () => Effect.gen(function*() {
    const fake = makeContextMenus()
    const menus = run(fake)
    const onclick = () => {}

    yield* menus.create({ id: "a", title: "A" })
    yield* menus.create({ id: "b", parentId: "a", title: "B" })
    yield* menus.create({ id: "c", parentId: "b", title: "C" })
    yield* menus.update("a", { parentId: "c", title: "A2", documentUrlPatterns: ["https://*/*"], onclick })
    yield* menus.update("a", { parentId: "a" })
    expect(fake.controls.item("a")).toEqual({ id: "a", parentId: undefined, properties: { title: "A2", onclick } })
    expect(fake.controls.children()).toEqual(["a"])
  }))

  it.effect("keeps one checked radio per run of adjacent radio siblings", () => Effect.gen(function*() {
    const fake = makeContextMenus()
    const menus = run(fake)
    const checked = (parentId?: MenuItemId) => fake.controls.children(parentId).map((id) => fake.controls.item(id)?.properties.checked === true)
    yield* menus.create({ id: "r1", type: "radio", title: "R1" })
    yield* menus.create({ id: "r2", type: "radio", title: "R2" })
    expect(checked()).toEqual([true, false])
    yield* menus.create({ id: "r3", type: "radio", title: "R3", checked: true })
    expect(checked()).toEqual([false, false, true])
    yield* menus.create({ id: "line", type: "separator" })
    yield* menus.create({ id: "s1", type: "radio", title: "S1" })
    expect(checked()).toEqual([false, false, true, false, true])
    yield* menus.update("r1", { checked: true })
    expect(checked()).toEqual([true, false, false, false, true])
    yield* menus.update("r1", { checked: false })
    expect(checked()).toEqual([true, false, false, false, true])
    yield* menus.remove("r1")
    expect(checked()).toEqual([true, false, false, true])
    yield* menus.remove("line")
    expect(checked()).toEqual([false, false, true])

    yield* menus.create({ id: "parent", title: "Parent" })
    yield* menus.create({ id: "c1", parentId: "parent", type: "radio", title: "C1", checked: true })
    yield* menus.create({ id: "c2", parentId: "parent", type: "radio", title: "C2", checked: true })
    expect(checked("parent")).toEqual([false, true])
    yield* menus.update("s1", { parentId: "parent" })
    expect(checked("parent")).toEqual([false, false, true])
    expect(checked()).toEqual([true, false, false])
    yield* menus.update("r3", { checked: true })
    expect(checked()).toEqual([false, true, false])
  }))

  it.effect("clicks toggle checkboxes, select radios and fill Chrome's click data", () => Effect.gen(function*() {
    const fake = makeContextMenus()
    const menus = run(fake)
    yield* menus.create({ id: "box", type: "checkbox", title: "Box" })
    yield* menus.create({ id: "r1", type: "radio", title: "R1" })
    yield* menus.create({ id: "r2", type: "radio", title: "R2" })
    yield* menus.create({ id: "plain", title: "Plain" })
    const clicks = yield* Effect.forkChild(Stream.runCollect(Stream.take(Stream.map(menus.onClicked, (click) => click.info), 5)))
    yield* Effect.promise(() => fake.controls.onClicked.waitForListener())
    fake.controls.click("box")
    fake.controls.click("box", {}, tab)
    fake.controls.click("r2")
    fake.controls.click("r2")
    fake.controls.click("plain", { selectionText: "hi", editable: true, pageUrl: "https://override.example/" }, tab)
    expect(yield* Fiber.join(clicks)).toEqual([
      { menuItemId: "box", editable: false, wasChecked: false, checked: true },
      { menuItemId: "box", editable: false, pageUrl: tab.url, wasChecked: true, checked: false },
      { menuItemId: "r2", editable: false, wasChecked: false, checked: true },
      { menuItemId: "r2", editable: false, wasChecked: true, checked: true },
      { menuItemId: "plain", editable: true, pageUrl: "https://override.example/", selectionText: "hi" }
    ])
    expect(fake.controls.item("r1")?.properties.checked).toBe(false)
    expect(fake.controls.item("r2")?.properties.checked).toBe(true)
    expect(fake.controls.item("box")?.properties.checked).toBe(false)
  }))

  it.effect("returns listener exceptions from click and rejects an unknown item", () => Effect.gen(function*() {
    const fake = makeContextMenus()
    yield* run(fake).create({ id: "a", title: "A" })
    const failure = new Error("listener failed")
    fake.api.onClicked.addListener(() => { throw failure })
    expect(fake.controls.click("a")).toEqual([failure])
    expect(() => fake.controls.click("missing")).toThrow("Cannot find menu item with id missing")
  }))

  it.effect("removes deep and wide subtrees and everything at once", () => Effect.gen(function*() {
    const fake = makeContextMenus()
    const menus = run(fake)
    expect(yield* menus.create({ title: "Root" })).toBe(1)

    for (let depth = 1; depth <= 300; depth++) yield* menus.create({ id: `deep-${depth}`, parentId: depth === 1 ? 1 : `deep-${depth - 1}`, title: "Deep" })

    for (let index = 0; index < 300; index++) yield* menus.create({ id: `wide-${index}`, parentId: "deep-1", title: "Wide" })

    yield* menus.create({ id: "other", title: "Other" })
    yield* menus.remove("deep-1")
    expect(fake.controls.items().map((item) => item.id)).toEqual([1, "other"])
    expect(fake.controls.children(1)).toEqual([])
    expect(fake.controls.children("deep-1")).toEqual([])
    yield* menus.create({ id: "deep-1", parentId: 1, title: "Again" })
    yield* menus.removeAll
    expect(fake.controls.items()).toEqual([])
    expect(fake.controls.children()).toEqual([])
    expect(yield* menus.create({ title: "After" })).toBe(2)
  }))

  it.effect("accepts the URL patterns Chrome's URLPattern parser accepts", () => Effect.gen(function*() {
    const fake = makeContextMenus()
    const menus = run(fake)

    const patterns = [
      "<all_urls>", "*://*/*", "https://*.example.com/docs/*", "http://127.0.0.1:8080/*", "https://example.com:*/*",
      "http://[::1]:3000/*", "file:///*", "file://*", "chrome-extension://abc/*", "data:text/*", "urn:*", "ftp://host/"
    ]

    for (const [index, pattern] of patterns.entries()) {
      expect(yield* menus.create({ id: `ok-${index}`, title: pattern, documentUrlPatterns: [pattern], targetUrlPatterns: [pattern] })).toBe(`ok-${index}`)
    }
  }))

  it.effect.each([
    "example.com/*", "https://example.com", "https:///*", "https://*./*", "https://exa*mple.com/*", "https://www.*.com/*",
    "https://example.com:port/*", "http://[::1/*", "https:example.com/*", "data:", "https://:80/*", "chrome://settings:80/*"
  ])("reports the invalid URL pattern %s through lastError, after the title and before the parent", (pattern) => Effect.gen(function*() {
    const fake = makeContextMenus()
    const menus = run(fake)
    const message = `Invalid url pattern '${pattern}'`

    for (const field of ["documentUrlPatterns", "targetUrlPatterns"] as const) {
      expect(yield* Effect.flip(menus.create({ id: "a", title: "A", parentId: "missing", [field]: ["https://fine.example/*", pattern] }))).toMatchObject({
        operation: "create", cause: { message }
      })
      expect(yield* Effect.flip(menus.create({ id: "a", title: "", [field]: [pattern] }))).toMatchObject({
        cause: { message: "All menu items except for separators must have a title" }
      })
    }

    expect(fake.controls.items()).toEqual([])
  }))

  it.effect("fails an update with an invalid URL pattern after moving the item, keeping the valid patterns before it", () => Effect.gen(function*() {
    const fake = makeContextMenus()
    const menus = run(fake)
    yield* menus.create({ id: "parent", title: "Parent" })
    yield* menus.create({ id: "a", title: "A", documentUrlPatterns: ["https://old.example/*"], targetUrlPatterns: ["https://old.example/*"] })
    expect(yield* Effect.flip(menus.update("a", {
      title: "A2", parentId: "parent", documentUrlPatterns: ["https://new.example/*"], targetUrlPatterns: ["https://ok.example/*", "bad"]
    }))).toMatchObject({ operation: "update", cause: new Error("Invalid url pattern 'bad'") })
    expect(fake.controls.item("a")).toEqual({
      id: "a", parentId: "parent",
      properties: { title: "A2", documentUrlPatterns: ["https://new.example/*"], targetUrlPatterns: ["https://ok.example/*"] }
    })
    expect(yield* Effect.flip(menus.update("a", { documentUrlPatterns: ["https://x.example"], targetUrlPatterns: ["<all_urls>"] }))).toMatchObject({
      cause: new Error("Invalid url pattern 'https://x.example'")
    })
    expect(fake.controls.item("a")?.properties).toEqual({ title: "A2", documentUrlPatterns: [], targetUrlPatterns: ["https://ok.example/*"] })
  }))

  it.effect("refuses to click what Chrome never offers as a command: separators and disabled or hidden items or ancestors", () =>
    Effect.gen(function*() {
      const fake = makeContextMenus()
      const menus = run(fake)
      yield* menus.create({ id: "line", type: "separator" })
      yield* menus.create({ id: "parent", title: "Parent" })
      yield* menus.create({ id: "child", parentId: "parent", title: "Child", visible: false })
      yield* menus.create({ id: "off", title: "Off", enabled: false })
      yield* menus.create({ id: "closed", title: "Closed", enabled: false })
      yield* menus.create({ id: "inside", parentId: "closed", title: "Inside" })
      yield* menus.create({ id: "veiled", title: "Veiled", visible: false })
      yield* menus.create({ id: "middle", parentId: "veiled", title: "Middle" })
      yield* menus.create({ id: "deep", parentId: "middle", type: "checkbox", title: "Deep" })
      const events = fake.controls.onClicked
      const clicks = yield* Effect.forkChild(Stream.runCollect(Stream.take(Stream.map(menus.onClicked, (click) => click.info), 3)))
      yield* Effect.promise(() => events.waitForListener())

      for (const id of ["line", "child", "off", "inside", "deep"]) {
        expect(() => fake.controls.click(id)).toThrow(`Chrome cannot click menu item ${id}`)
      }

      expect(fake.controls.item("deep")?.properties.checked).toBeUndefined()
      yield* menus.update("off", { enabled: true })
      yield* menus.update("veiled", { visible: true })
      fake.controls.click("parent")
      fake.controls.click("off")
      fake.controls.click("deep")
      expect(yield* Fiber.join(clicks)).toEqual([
        { menuItemId: "parent", editable: false },
        { menuItemId: "off", editable: false },
        { menuItemId: "deep", parentMenuItemId: "middle", editable: false, wasChecked: false, checked: true }
      ])
    }))

  it.effect("lets overrides replace any member", () => Effect.gen(function*() {
    const removeAll = vi.fn(async () => {})
    const fake = makeContextMenus({ removeAll, lastError: { message: "always" } })
    expect(fake.api).toHaveProperty("removeAll", removeAll)
    expect(yield* Effect.flip(run(fake).create({ id: "a", title: "A" }))).toMatchObject({ cause: { message: "always" } })
    yield* run(fake).removeAll
    expect(removeAll).toHaveBeenCalledOnce()
  }))
})
