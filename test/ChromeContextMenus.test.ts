// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Option, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeContextMenus, ChromeContextMenusError, layer, layerLive, make } from "../src/ChromeContextMenus.js"
import type { ChromeContextMenusApi } from "../src/ChromeContextMenus.js"
import { makeContextMenus } from "../src/testing/ContextMenus.js"

const tab: chrome.tabs.Tab = {
  id: 7, index: 0, windowId: 1, highlighted: false, active: true, pinned: false, incognito: false,
  discarded: false, autoDiscardable: true, groupId: -1, frozen: false, selected: true, lastAccessed: 0,
  url: "https://app.example/"
}

describe("ChromeContextMenus", () => {
  it.effect("resolves create to the caller's or Chrome's id once the callback confirms it", () => Effect.gen(function*() {
    const fake = makeContextMenus()
    const menus = make(fake.api)
    expect(yield* menus.create({ id: "root", title: "Save" })).toBe("root")
    expect(yield* menus.create({ parentId: "root", title: "Save link", contexts: ["link"] })).toBe(1)
    expect(fake.controls.items()).toEqual([
      { id: "root", parentId: undefined, properties: { title: "Save" } },
      { id: 1, parentId: "root", properties: { title: "Save link", contexts: ["link"] } }
    ])
  }))

  it.effect("fails create with the lastError Chrome reports in the callback", () => Effect.gen(function*() {
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

  it.effect("resolves a callback that runs before create returns, and types a synchronous throw", () => Effect.gen(function*() {
    const fake = makeContextMenus({
      create: (_properties, callback) => {
        callback()

        return 9
      }
    })

    expect(yield* make(fake.api).create({ title: "Early" })).toBe(9)
    const cause = new Error("Property 'title' is required")
    const throwing = makeContextMenus({ create: () => { throw cause } })
    expect(yield* Effect.flip(make(throwing.api).create({ title: "" }))).toMatchObject({ operation: "create", cause })
  }))

  it.effect("updates, removes subtrees and removes everything", () => Effect.gen(function*() {
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
    expect(yield* Effect.flip(menus.update("root", { title: "x" }))).toMatchObject({ operation: "update" })
    yield* menus.removeAll
    expect(fake.controls.items()).toEqual([])
  }))

  it.effect("scopes an item to its owner, tolerating one already removed", () => Effect.gen(function*() {
    const fake = makeContextMenus()
    const menus = make(fake.api)
    yield* Effect.scoped(Effect.gen(function*() {
      expect(yield* menus.item({ id: "session", title: "Send to session" })).toBe("session")
      expect(fake.controls.item("session")).toBeDefined()
    }))
    expect(fake.controls.items()).toEqual([])
    yield* Effect.scoped(Effect.gen(function*() {
      yield* menus.item({ id: "session", title: "Send to session" })
      yield* menus.removeAll
    }))
    expect(yield* Effect.flip(Effect.scoped(menus.item({ parentId: "missing", title: "Orphan" })))).toMatchObject({ operation: "create" })
  }))

  it.effect("streams clicks with an optional tab while consumed", () => Effect.gen(function*() {
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

  it.effect("types a failed listener registration as onClicked", () => Effect.gen(function*() {
    const fake = makeContextMenus()
    const cause = new Error("listener rejected")
    fake.controls.onClicked.failNext("addListener", cause)
    expect(yield* Effect.flip(Stream.runDrain(make(fake.api).onClicked))).toMatchObject({ operation: "onClicked", cause })
  }))

  it.effect("provides an injected API and reads the globals only when the live layer builds", () => Effect.gen(function*() {
    const fake = makeContextMenus()
    expect(yield* Effect.flatMap(ChromeContextMenus, (menus) => menus.create({ id: "a", title: "A" })).pipe(Effect.provide(layer(fake.api)))).toBe("a")
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", { runtime: {} })), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeContextMenus.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
  }))

  it.effect("reads chrome.runtime.lastError inside the live create callback", () => Effect.gen(function*() {
    let lastError: chrome.runtime.LastError | undefined
    const runtime = { get lastError() { return lastError } }

    const contextMenus: Omit<ChromeContextMenusApi, "lastError"> = {
      create: (properties, callback) => {
        queueMicrotask(() => {
          lastError = { message: "Cannot create item with duplicate id dup" }

          try { callback() } finally { lastError = undefined }
        })

        return properties.id ?? 0
      },
      update: async () => {},
      remove: async () => {},
      removeAll: async () => {},
      onClicked: makeContextMenus().api.onClicked
    }

    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", { contextMenus, runtime })), () => Effect.sync(() => vi.unstubAllGlobals()))
    const error = yield* Effect.flip(Effect.flatMap(ChromeContextMenus, (menus) => menus.create({ id: "dup", title: "Dup" })).pipe(Effect.provide(layerLive)))
    expect(error).toMatchObject({ operation: "create", cause: { message: "Cannot create item with duplicate id dup" } })
  }))
})
