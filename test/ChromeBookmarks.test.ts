// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeBookmarks, ChromeBookmarksError, layerLive, make } from "../src/ChromeBookmarks.js"
import * as TestBookmarks from "../src/testing/Bookmarks.js"

const titles = (nodes: ReadonlyArray<chrome.bookmarks.BookmarkTreeNode>) => nodes.map((node) => node.title)

describe("ChromeBookmarks", () => {
  it.effect("starts from the root and the permanent folders", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const [root] = yield* make(fixture.api).getTree
    expect(root).toMatchObject({ id: TestBookmarks.rootId, title: "" })
    expect(root?.children?.map(({ id, title, folderType, parentId, index }) => ({ id, title, folderType, parentId, index }))).toEqual([
      { id: "1", title: "Bookmarks bar", folderType: "bookmarks-bar", parentId: "0", index: 0 },
      { id: "2", title: "Other bookmarks", folderType: "other", parentId: "0", index: 1 },
      { id: "3", title: "Mobile bookmarks", folderType: "mobile", parentId: "0", index: 2 }
    ])
  }))

  it.effect("creates, reads, searches and updates bookmarks and folders", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const get = vi.spyOn(fixture.api, "get")
    const bookmarks = make(fixture.api)
    const folder = yield* bookmarks.create({ parentId: TestBookmarks.bookmarksBarId, title: "Work" })
    const docs = yield* bookmarks.create({ parentId: folder.id, title: "Docs", url: "https://docs.example/" })
    const other = yield* bookmarks.create({ title: "Effect website", url: "https://effect.website/" })
    expect(folder).toMatchObject({ parentId: "1", index: 0 })
    expect(folder.url).toBeUndefined()
    expect(other).toMatchObject({ parentId: TestBookmarks.otherBookmarksId, index: 0 })
    expect(titles(yield* bookmarks.get(docs.id, other.id))).toEqual(["Docs", "Effect website"])
    expect(get.mock.calls).toEqual([[[docs.id, other.id]]])
    expect((yield* bookmarks.get(folder.id))[0]?.children).toBeUndefined()
    expect(titles(yield* bookmarks.getChildren(folder.id))).toEqual(["Docs"])
    expect(titles((yield* bookmarks.getSubTree(folder.id))[0]?.children ?? [])).toEqual(["Docs"])
    expect(titles(yield* bookmarks.search("effect WEB"))).toEqual(["Effect website"])
    expect(titles(yield* bookmarks.search("work"))).toEqual(["Work"])
    expect(titles(yield* bookmarks.search({ url: "https://docs.example/" }))).toEqual(["Docs"])
    expect(titles(yield* bookmarks.search({ query: "bookmarks" }))).toEqual([])
    expect(yield* bookmarks.update(docs.id, { title: "Reference", url: "https://docs.example/ref" })).toMatchObject({
      title: "Reference", url: "https://docs.example/ref"
    })
  }))

  it.effect("lists recent bookmarks newest first, never folders", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)
    yield* bookmarks.create({ title: "First", url: "https://one.example/" })
    yield* bookmarks.create({ title: "Folder" })
    yield* bookmarks.create({ title: "Second", url: "https://two.example/" })
    expect(titles(yield* bookmarks.getRecent(5))).toEqual(["Second", "First"])
    expect(titles(yield* bookmarks.getRecent(1))).toEqual(["Second"])
    expect(yield* Effect.flip(bookmarks.getRecent(0))).toMatchObject({ operation: "getRecent" })
  }))

  it.effect("moves like Chrome, counting a same-folder index before removal", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)

    const [a, b, c] = [
      yield* bookmarks.create({ title: "A", url: "https://a.example/" }),
      yield* bookmarks.create({ title: "B", url: "https://b.example/" }),
      yield* bookmarks.create({ title: "C", url: "https://c.example/" })
    ]

    expect(yield* bookmarks.move(a.id, { index: 3 })).toMatchObject({ index: 2 })
    expect(titles(yield* bookmarks.getChildren("2"))).toEqual(["B", "C", "A"])
    expect(yield* bookmarks.move(b.id, { index: 1 })).toMatchObject({ index: 0 })
    expect(yield* bookmarks.move(c.id, { parentId: TestBookmarks.bookmarksBarId })).toMatchObject({ parentId: "1", index: 0 })
    expect(titles(yield* bookmarks.getChildren("2"))).toEqual(["B", "A"])
  }))

  it.effect("fails where Chrome would, with the operation name", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)
    const folder = yield* bookmarks.create({ title: "Folder" })
    const child = yield* bookmarks.create({ parentId: folder.id, title: "Child" })
    const nonEmpty = yield* Effect.flip(bookmarks.remove(folder.id))
    expect(nonEmpty).toBeInstanceOf(ChromeBookmarksError)
    expect(nonEmpty).toMatchObject({ operation: "remove", cause: new Error("Can't remove non-empty folder (use recursive to force).") })
    expect(yield* Effect.flip(bookmarks.update("1", { title: "Mine" }))).toMatchObject({
      operation: "update", cause: new Error("Can't modify the root bookmark folders.")
    })
    expect(yield* Effect.flip(bookmarks.get("404"))).toMatchObject({ operation: "get", cause: new Error("Can't find bookmark for id.") })
    expect(yield* Effect.flip(bookmarks.move(folder.id, { parentId: child.id }))).toMatchObject({ operation: "move" })
    expect(yield* Effect.flip(bookmarks.update(folder.id, { url: "https://x.example/" }))).toMatchObject({ operation: "update" })
    expect(yield* Effect.flip(bookmarks.create({ title: "Bad", url: "not a url" }))).toMatchObject({
      operation: "create", cause: new Error("Invalid URL.")
    })
    expect(yield* Effect.flip(bookmarks.create({ title: "Late", index: 5 }))).toMatchObject({ operation: "create" })
    yield* bookmarks.removeTree(folder.id)
    expect(fixture.controls.node(folder.id)).toBeUndefined()
    expect(fixture.controls.node(child.id)).toBeUndefined()
  }))

  it.effect("streams creation, change, move and removal events while consumed", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)
    const created = yield* Effect.forkScoped(Stream.runCollect(Stream.take(bookmarks.onCreated, 2)))
    const changed = yield* Effect.forkScoped(Stream.runCollect(Stream.take(bookmarks.onChanged, 1)))
    const moved = yield* Effect.forkScoped(Stream.runCollect(Stream.take(bookmarks.onMoved, 1)))
    const removed = yield* Effect.forkScoped(Stream.runCollect(Stream.take(bookmarks.onRemoved, 1)))
    yield* Effect.promise(() => fixture.controls.onCreated.waitForListener())
    yield* Effect.promise(() => fixture.controls.onChanged.waitForListener())
    yield* Effect.promise(() => fixture.controls.onMoved.waitForListener())
    yield* Effect.promise(() => fixture.controls.onRemoved.waitForListener())
    const folder = yield* bookmarks.create({ title: "Folder" })
    const page = yield* bookmarks.create({ parentId: folder.id, title: "Page", url: "https://page.example/" })
    yield* bookmarks.update(page.id, { title: "Page" })
    yield* bookmarks.update(page.id, { title: "Renamed" })
    yield* bookmarks.move(folder.id, { parentId: TestBookmarks.bookmarksBarId })
    yield* bookmarks.removeTree(folder.id)
    expect((yield* Fiber.join(created)).map(({ id, bookmark }) => [id, bookmark.title])).toEqual([[folder.id, "Folder"], [page.id, "Page"]])
    expect(yield* Fiber.join(changed)).toEqual([{ id: page.id, title: "Renamed", url: "https://page.example/" }])
    expect(yield* Fiber.join(moved)).toEqual([{ id: folder.id, parentId: "1", index: 0, oldParentId: "2", oldIndex: 0 }])
    const [removal] = yield* Fiber.join(removed)
    expect(removal).toMatchObject({ id: folder.id, parentId: "1", index: 0 })
    expect(titles(removal?.node.children ?? [])).toEqual(["Renamed"])
    expect(fixture.controls.onCreated.listenerCount + fixture.controls.onChanged.listenerCount
      + fixture.controls.onMoved.listenerCount + fixture.controls.onRemoved.listenerCount).toBe(0)
  }))

  it.effect("streams reordering and import events", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)
    const a = yield* bookmarks.create({ title: "A", url: "https://a.example/" })
    const b = yield* bookmarks.create({ title: "B", url: "https://b.example/" })
    const reordered = yield* Effect.forkScoped(Stream.runCollect(Stream.take(bookmarks.onChildrenReordered, 1)))
    const began = yield* Effect.forkScoped(Stream.runCollect(Stream.take(bookmarks.onImportBegan, 1)))
    const ended = yield* Effect.forkScoped(Stream.runCollect(Stream.take(bookmarks.onImportEnded, 1)))
    yield* Effect.promise(() => fixture.controls.onChildrenReordered.waitForListener())
    yield* Effect.promise(() => fixture.controls.onImportBegan.waitForListener())
    yield* Effect.promise(() => fixture.controls.onImportEnded.waitForListener())
    fixture.controls.reorder("2", [b.id, a.id])
    fixture.controls.onImportBegan.emit()
    fixture.controls.onImportEnded.emit()
    expect(yield* Fiber.join(reordered)).toEqual([{ id: "2", childIds: [b.id, a.id] }])
    expect(yield* Fiber.join(began)).toEqual([undefined])
    expect(yield* Fiber.join(ended)).toEqual([undefined])
    expect(titles(yield* bookmarks.getChildren("2"))).toEqual(["B", "A"])
    expect(() => fixture.controls.reorder("2", [a.id])).toThrow()
  }))

  it.effect("reports a failing registration with the event's operation", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const cause = new Error("event unavailable")
    fixture.controls.onMoved.failNext("addListener", cause)
    expect(yield* Effect.flip(Stream.runDrain(make(fixture.api).onMoved))).toMatchObject({ operation: "onMoved", cause })
  }))

  it.effect("provides the fixture layer and reads the global only when the live layer builds", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    expect(titles(yield* Effect.flatMap(ChromeBookmarks, (bookmarks) => bookmarks.getChildren("0")).pipe(Effect.provide(fixture.layer)))).toEqual([
      "Bookmarks bar", "Other bookmarks", "Mobile bookmarks"
    ])
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", {})), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeBookmarks.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
    vi.stubGlobal("chrome", { bookmarks: fixture.api })
    expect((yield* Effect.flatMap(ChromeBookmarks, (bookmarks) => bookmarks.getTree).pipe(Effect.provide(layerLive)))[0]?.id).toBe("0")
  }))
})
