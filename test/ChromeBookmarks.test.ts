// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Exit, Fiber, Schedule, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeBookmarks, ChromeBookmarksError, layer, layerLive, make } from "../src/ChromeBookmarks.js"
import type {
  BookmarkTreeNode, ChangedEvent, ChangeInfo, ChildrenReorderedEvent, ChromeBookmarksApi, ChromeBookmarksService, CreatedEvent,
  MovedEvent, RemovedEvent
} from "../src/ChromeBookmarks.js"
import type { EventSource } from "../src/internal/event.js"
import * as TestBookmarks from "../src/testing/Bookmarks.js"

type Fixture = ReturnType<typeof TestBookmarks.makeBookmarks>

const titles = (nodes: ReadonlyArray<BookmarkTreeNode>) => nodes.map((node) => node.title)

const raise = (cause: Error): never => { throw cause }

/** Every result a bookmarks call can produce. */
type CallResult = Array<BookmarkTreeNode> | BookmarkTreeNode | void

const operations: ReadonlyArray<{
  readonly operation: string
  readonly run: (bookmarks: ChromeBookmarksService) => Effect.Effect<CallResult, ChromeBookmarksError>
}> = [
  { operation: "get", run: (bookmarks) => bookmarks.get("1", "2") },
  { operation: "getChildren", run: (bookmarks) => bookmarks.getChildren("1") },
  { operation: "getRecent", run: (bookmarks) => bookmarks.getRecent(5) },
  { operation: "getTree", run: (bookmarks) => bookmarks.getTree },
  { operation: "getSubTree", run: (bookmarks) => bookmarks.getSubTree("1") },
  { operation: "search", run: (bookmarks) => bookmarks.search("query") },
  { operation: "create", run: (bookmarks) => bookmarks.create({ title: "New" }) },
  { operation: "move", run: (bookmarks) => bookmarks.move("4", { index: 0 }) },
  { operation: "update", run: (bookmarks) => bookmarks.update("4", { title: "Renamed" }) },
  { operation: "remove", run: (bookmarks) => bookmarks.remove("4") },
  { operation: "removeTree", run: (bookmarks) => bookmarks.removeTree("4") }
]

/** An API whose every call fails, by rejecting or by throwing before returning a Promise. */
const failingApi = (mode: "reject" | "throw", cause: Error): ChromeBookmarksApi => {
  const call = (): Promise<never> => mode === "reject" ? Promise.reject(cause) : raise(cause)

  return {
    ...TestBookmarks.makeBookmarks().api,
    get: call, getChildren: call, getRecent: call, getTree: call, getSubTree: call, search: call, create: call,
    move: call, update: call, remove: call, removeTree: call
  }
}

type EventName = "onCreated" | "onRemoved" | "onChanged" | "onMoved" | "onChildrenReordered" | "onImportBegan" | "onImportEnded"

type Emitted = CreatedEvent | RemovedEvent | ChangedEvent | MovedEvent | ChildrenReorderedEvent | void

/** Rewraps one event source of the API, keeping its arguments. */
type Rewrap = <Args extends ReadonlyArray<unknown>>(source: EventSource<Args>) => EventSource<Args>

const page: BookmarkTreeNode = { id: "7", parentId: "2", index: 0, title: "Seven", url: "https://seven.example/", syncing: false }

const events: ReadonlyArray<{
  readonly name: EventName
  readonly emit: (fixture: Fixture) => void
  readonly expected: Emitted
  readonly rewrap: (fixture: Fixture, rewrap: Rewrap) => ChromeBookmarksApi
}> = [
  {
    name: "onCreated",
    emit: (fixture) => { fixture.controls.onCreated.emit("7", page) },
    expected: { id: "7", bookmark: page },
    rewrap: (fixture, rewrap) => ({ ...fixture.api, onCreated: rewrap(fixture.api.onCreated) })
  },
  {
    name: "onRemoved",
    emit: (fixture) => { fixture.controls.onRemoved.emit("7", { parentId: "2", index: 3, node: { id: "7", title: "Seven", syncing: false } }) },
    expected: { id: "7", parentId: "2", index: 3, node: { id: "7", title: "Seven", syncing: false } },
    rewrap: (fixture, rewrap) => ({ ...fixture.api, onRemoved: rewrap(fixture.api.onRemoved) })
  },
  {
    name: "onChanged",
    emit: (fixture) => { fixture.controls.onChanged.emit("8", { title: "Folder" }) },
    expected: { id: "8", title: "Folder" },
    rewrap: (fixture, rewrap) => ({ ...fixture.api, onChanged: rewrap(fixture.api.onChanged) })
  },
  {
    name: "onMoved",
    emit: (fixture) => { fixture.controls.onMoved.emit("7", { parentId: "1", index: 2, oldParentId: "2", oldIndex: 0 }) },
    expected: { id: "7", parentId: "1", index: 2, oldParentId: "2", oldIndex: 0 },
    rewrap: (fixture, rewrap) => ({ ...fixture.api, onMoved: rewrap(fixture.api.onMoved) })
  },
  {
    name: "onChildrenReordered",
    emit: (fixture) => { fixture.controls.onChildrenReordered.emit("2", { childIds: ["9", "7"] }) },
    expected: { id: "2", childIds: ["9", "7"] },
    rewrap: (fixture, rewrap) => ({ ...fixture.api, onChildrenReordered: rewrap(fixture.api.onChildrenReordered) })
  },
  {
    name: "onImportBegan",
    emit: (fixture) => { fixture.controls.onImportBegan.emit() },
    expected: undefined,
    rewrap: (fixture, rewrap) => ({ ...fixture.api, onImportBegan: rewrap(fixture.api.onImportBegan) })
  },
  {
    name: "onImportEnded",
    emit: (fixture) => { fixture.controls.onImportEnded.emit() },
    expected: undefined,
    rewrap: (fixture, rewrap) => ({ ...fixture.api, onImportEnded: rewrap(fixture.api.onImportEnded) })
  }
]

const streamOf = (bookmarks: ChromeBookmarksService, name: EventName): Stream.Stream<Emitted, ChromeBookmarksError> => bookmarks[name]

/** A resolvable promise used as an explicit gate. */
const gate = <A = void>() => {
  let open: (value: A) => void = () => {}

  const promise = new Promise<A>((resolve) => { open = resolve })

  return { promise, open: (value: A) => open(value) }
}

/** Counts registrations, so a test can wait until exactly `count` listeners were added. */
const counting = () => {
  let adds = 0
  const waiters: Array<{ readonly count: number, readonly open: () => void }> = []

  const rewrap: Rewrap = (source) => ({
    addListener: (listener) => {
      source.addListener(listener)
      adds++

      for (const waiter of waiters) if (adds >= waiter.count) waiter.open()
    },
    removeListener: (listener) => source.removeListener(listener)
  })

  const reached = (count: number): Promise<void> => {
    if (adds >= count) return Promise.resolve()
    const reachedGate = gate()
    waiters.push({ count, open: () => reachedGate.open() })

    return reachedGate.promise
  }

  return { rewrap, reached }
}

/** Adds the listener, then throws, as a partially successful registration does. */
const addThenThrow = (cause: Error): Rewrap => (source) => ({
  addListener: (listener) => {
    source.addListener(listener)
    throw cause
  },
  removeListener: (listener) => source.removeListener(listener)
})

describe("ChromeBookmarks", () => {
  it.effect("starts from the root and the permanent folders", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const [root, ...rest] = yield* make(fixture.api).getTree
    expect(rest).toEqual([])
    expect(root).toMatchObject({ id: TestBookmarks.rootId, title: "" })
    expect(root?.parentId).toBeUndefined()
    expect(root?.index).toBeUndefined()
    expect(root?.children?.map(({ id, title, folderType, parentId, index, children }) => ({ id, title, folderType, parentId, index, children }))).toEqual([
      { id: "1", title: "Bookmarks bar", folderType: "bookmarks-bar", parentId: "0", index: 0, children: [] },
      { id: "2", title: "Other bookmarks", folderType: "other", parentId: "0", index: 1, children: [] },
      { id: "3", title: "Mobile bookmarks", folderType: "mobile", parentId: "0", index: 2, children: [] }
    ])
    expect(fixture.controls.size).toBe(4)
  }))

  it.effect("creates, reads, searches and updates bookmarks and folders", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const get = vi.spyOn(fixture.api, "get")
    const bookmarks = make(fixture.api)
    const folder = yield* bookmarks.create({ parentId: TestBookmarks.bookmarksBarId, title: "Work" })
    const docs = yield* bookmarks.create({ parentId: folder.id, title: "Docs", url: "https://docs.example/" })
    const other = yield* bookmarks.create({ title: "Effect website", url: "https://effect.website/" })
    expect(folder).toMatchObject({ parentId: "1", index: 0, title: "Work", syncing: false })
    expect(folder.url).toBeUndefined()
    expect(folder.children).toBeUndefined()
    expect(other).toMatchObject({ parentId: TestBookmarks.otherBookmarksId, index: 0 })
    expect(titles(yield* bookmarks.get(docs.id, other.id))).toEqual(["Docs", "Effect website"])
    expect(titles(yield* bookmarks.get(other.id, docs.id))).toEqual(["Effect website", "Docs"])
    expect(get.mock.calls).toEqual([[[docs.id, other.id]], [[other.id, docs.id]]])
    expect((yield* bookmarks.get(folder.id))[0]?.children).toBeUndefined()
    expect(titles(yield* bookmarks.getChildren(folder.id))).toEqual(["Docs"])
    expect(yield* bookmarks.getChildren(docs.id)).toEqual([])
    const [subTree, ...extra] = yield* bookmarks.getSubTree(folder.id)
    expect(extra).toEqual([])
    expect(subTree).toMatchObject({ id: folder.id, parentId: "1", index: 0 })
    expect(titles(subTree?.children ?? [])).toEqual(["Docs"])
    expect(titles(yield* bookmarks.search("effect WEB"))).toEqual(["Effect website"])
    expect(titles(yield* bookmarks.search("work"))).toEqual(["Work"])
    expect(titles(yield* bookmarks.search({ url: "https://docs.example/" }))).toEqual(["Docs"])
    expect(titles(yield* bookmarks.search({ query: "bookmarks" }))).toEqual([])
    expect(yield* bookmarks.update(docs.id, { title: "Reference", url: "https://docs.example/ref" })).toMatchObject({
      id: docs.id, parentId: folder.id, index: 0, title: "Reference", url: "https://docs.example/ref"
    })
  }))

  it.effect("passes every argument to Chrome unchanged and calls nothing until run", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()

    const spies = {
      get: vi.spyOn(fixture.api, "get"), getChildren: vi.spyOn(fixture.api, "getChildren"),
      getRecent: vi.spyOn(fixture.api, "getRecent"), getTree: vi.spyOn(fixture.api, "getTree"),
      getSubTree: vi.spyOn(fixture.api, "getSubTree"), search: vi.spyOn(fixture.api, "search"),
      create: vi.spyOn(fixture.api, "create"), move: vi.spyOn(fixture.api, "move"),
      update: vi.spyOn(fixture.api, "update"), remove: vi.spyOn(fixture.api, "remove"),
      removeTree: vi.spyOn(fixture.api, "removeTree")
    }

    const bookmarks = make(fixture.api)
    const lazy = [bookmarks.getTree, bookmarks.get("1"), bookmarks.create({ title: "Lazy" })]
    expect(lazy).toHaveLength(3)
    expect(Object.values(spies).every((spy) => spy.mock.calls.length === 0)).toBe(true)
    expect(events.every(({ name }) => fixture.controls[name].listenerCount === 0)).toBe(true)
    const details = { parentId: "1", title: "Folder" }
    const folder = yield* bookmarks.create(details)
    const destination = { parentId: "2" }
    const changes = { title: "Moved" }
    const query = { title: "Moved" }
    yield* bookmarks.get("1")
    yield* bookmarks.getChildren("1")
    yield* bookmarks.getRecent(3)
    yield* bookmarks.getTree
    yield* bookmarks.getTree
    yield* bookmarks.getSubTree("1")
    yield* bookmarks.search("words")
    yield* bookmarks.search(query)
    yield* bookmarks.move(folder.id, destination)
    yield* bookmarks.update(folder.id, changes)
    yield* bookmarks.remove(folder.id)
    const leaf = yield* bookmarks.create({ title: "Leaf", url: "https://leaf.example/" })
    yield* bookmarks.removeTree(leaf.id)
    expect(spies.create.mock.calls[0]?.[0]).toBe(details)
    expect(details).toEqual({ parentId: "1", title: "Folder" })
    expect(spies.get.mock.calls).toEqual([[["1"]]])
    expect(spies.getChildren.mock.calls).toEqual([["1"]])
    expect(spies.getRecent.mock.calls).toEqual([[3]])
    expect(spies.getTree.mock.calls).toEqual([[], []])
    expect(spies.getSubTree.mock.calls).toEqual([["1"]])
    expect(spies.search.mock.calls).toEqual([["words"], [query]])
    expect(spies.search.mock.calls[1]?.[0]).toBe(query)
    expect(spies.move.mock.calls).toEqual([[folder.id, destination]])
    expect(spies.move.mock.calls[0]?.[1]).toBe(destination)
    expect(spies.update.mock.calls).toEqual([[folder.id, changes]])
    expect(spies.update.mock.calls[0]?.[1]).toBe(changes)
    expect(spies.remove.mock.calls).toEqual([[folder.id]])
    expect(spies.removeTree.mock.calls).toEqual([[leaf.id]])
  }))

  it.effect.each(operations.flatMap(({ operation, run }) => (["reject", "throw"] as const).map((mode) => ({ operation, run, mode }))))(
    "maps a $mode from $operation to the typed error",
    ({ operation, run, mode }) => Effect.gen(function*() {
      const cause = new Error(`${operation} ${mode}`)
      const error = yield* Effect.flip(run(make(failingApi(mode, cause))))
      expect(error).toBeInstanceOf(ChromeBookmarksError)
      expect(error.operation).toBe(operation)
      expect(error.cause).toBe(cause)
    })
  )

  it.effect("keeps a non-Error rejection as the cause unchanged", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks({ getTree: () => Promise.reject("plain string") })
    expect(yield* Effect.flip(make(fixture.api).getTree)).toMatchObject({ operation: "getTree", cause: "plain string" })
  }))

  it.effect("lists recent bookmarks newest first, never folders", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)
    yield* bookmarks.create({ title: "First", url: "https://one.example/" })
    yield* bookmarks.create({ title: "Folder" })
    yield* bookmarks.create({ title: "Second", url: "https://two.example/" })
    expect(titles(yield* bookmarks.getRecent(5))).toEqual(["Second", "First"])
    expect(titles(yield* bookmarks.getRecent(1))).toEqual(["Second"])
    expect(yield* Effect.flip(bookmarks.getRecent(0))).toMatchObject({
      operation: "getRecent",
      cause: new TypeError(
        "Error in invocation of bookmarks.getRecent(integer numberOfItems, optional function callback): " +
          "Error at parameter 'numberOfItems': Value must be at least 1."
      )
    })
    expect(yield* Effect.flip(bookmarks.getRecent(-3))).toMatchObject({ operation: "getRecent" })
  }))

  it.effect("orders recent bookmarks by date, breaking ties by creation order", () => Effect.gen(function*() {
    const now = vi.spyOn(Date, "now").mockReturnValue(5_000)
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)
    const tied = yield* Effect.forEach(["A", "B", "C"], (title) => bookmarks.create({ title, url: `https://${title}.example/` }))
    now.mockReturnValue(1_000)
    yield* bookmarks.create({ title: "Older", url: "https://older.example/" })
    expect(titles(yield* bookmarks.getRecent(10))).toEqual(["C", "B", "A", "Older"])
    expect(tied.every((node) => node.dateAdded === 5_000)).toBe(true)
    yield* bookmarks.remove(tied[2]?.id ?? "")
    expect(titles(yield* bookmarks.getRecent(2))).toEqual(["B", "A"])
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
    expect(yield* bookmarks.move(a.id, { index: 0 })).toMatchObject({ parentId: "2", index: 0 })
    expect(yield* bookmarks.move(a.id, {})).toMatchObject({ parentId: "2", index: 1 })
    expect(titles(yield* bookmarks.getChildren("2"))).toEqual(["B", "A"])
    expect((yield* bookmarks.getChildren("2")).map((node) => node.index)).toEqual([0, 1])
  }))

  it.effect("fires onMoved for real moves only, with the old and new places", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)
    const a = yield* bookmarks.create({ title: "A", url: "https://a.example/" })
    const b = yield* bookmarks.create({ title: "B", url: "https://b.example/" })
    const moved = yield* Effect.forkScoped(Stream.runCollect(Stream.take(bookmarks.onMoved, 2)))
    yield* Effect.promise(() => fixture.controls.onMoved.waitForListener())
    expect(yield* bookmarks.move(a.id, { index: 0 })).toMatchObject({ index: 0 })
    expect(yield* bookmarks.move(a.id, { index: 1 })).toMatchObject({ index: 0 })
    expect(yield* bookmarks.move(b.id, {})).toMatchObject({ index: 1 })
    yield* bookmarks.move(b.id, { index: 0 })
    yield* bookmarks.move(b.id, { parentId: "3", index: 0 })
    expect(yield* Fiber.join(moved)).toEqual([
      { id: b.id, parentId: "2", index: 0, oldParentId: "2", oldIndex: 1 },
      { id: b.id, parentId: "3", index: 0, oldParentId: "2", oldIndex: 0 }
    ])
    expect(fixture.controls.onMoved.listenerCount).toBe(0)
  }))

  it.effect("refuses moves Chrome refuses", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)
    const outer = yield* bookmarks.create({ title: "Outer" })
    const inner = yield* bookmarks.create({ parentId: outer.id, title: "Inner" })
    const leaf = yield* bookmarks.create({ parentId: inner.id, title: "Leaf", url: "https://leaf.example/" })
    const failure = (id: string, destination: chrome.bookmarks.MoveDestination) => Effect.flip(bookmarks.move(id, destination))
    expect(yield* failure(outer.id, { parentId: outer.id })).toMatchObject({
      operation: "move", cause: new Error("Can't move a folder to itself or its descendant.")
    })
    expect(yield* failure(outer.id, { parentId: inner.id })).toMatchObject({
      cause: new Error("Can't move a folder to itself or its descendant.")
    })
    expect(yield* failure(outer.id, { parentId: TestBookmarks.rootId })).toMatchObject({
      cause: new Error("Can't modify the root bookmark folders.")
    })
    expect(yield* failure(TestBookmarks.bookmarksBarId, { parentId: "2" })).toMatchObject({
      cause: new Error("Can't modify the root bookmark folders.")
    })
    // Chrome checks that the destination is a folder before checking that it lies outside the node.
    expect(yield* failure(inner.id, { parentId: leaf.id })).toMatchObject({ cause: new Error("Parameter 'parentId' does not specify a folder.") })
    const other = yield* bookmarks.create({ title: "Other", url: "https://other.example/" })
    expect(yield* failure(leaf.id, { parentId: other.id })).toMatchObject({
      cause: new Error("Parameter 'parentId' does not specify a folder.")
    })
    expect(yield* failure(leaf.id, { parentId: "404" })).toMatchObject({ cause: new Error("Can't find parent bookmark for id.") })
    expect(yield* failure("404", { parentId: "1" })).toMatchObject({ cause: new Error("Can't find bookmark for id.") })
    expect(yield* failure(leaf.id, { index: 2 })).toMatchObject({ cause: new Error("Index out of bounds.") })
    expect((yield* failure(leaf.id, { index: -1 })).cause).toBeInstanceOf(TypeError)
    expect(yield* failure(leaf.id, { parentId: "1", index: 1 })).toMatchObject({ cause: new Error("Index out of bounds.") })
    expect(titles(yield* bookmarks.getChildren(inner.id))).toEqual(["Leaf"])
    expect(titles(yield* bookmarks.getChildren(outer.id))).toEqual(["Inner"])
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
    expect(yield* Effect.flip(bookmarks.get("1", "404"))).toMatchObject({ operation: "get", cause: new Error("Can't find bookmark for id.") })
    expect(yield* Effect.flip(bookmarks.get("one"))).toMatchObject({ operation: "get", cause: new Error("Bookmark id is invalid.") })
    expect(yield* Effect.flip(bookmarks.getChildren("404"))).toMatchObject({ operation: "getChildren" })
    expect(yield* Effect.flip(bookmarks.getSubTree("404"))).toMatchObject({ operation: "getSubTree" })
    expect(yield* Effect.flip(bookmarks.update(folder.id, { url: "https://x.example/" }))).toMatchObject({
      operation: "update", cause: new Error("Can't set URL of a bookmark folder.")
    })
    expect(yield* Effect.flip(bookmarks.update("404", { url: "not a url" }))).toMatchObject({
      operation: "update", cause: new Error("Invalid URL.")
    })
    expect(yield* Effect.flip(bookmarks.update("404", { title: "Ghost" }))).toMatchObject({
      operation: "update", cause: new Error("Can't find bookmark for id.")
    })
    expect(yield* Effect.flip(bookmarks.create({ title: "Bad", url: "not a url" }))).toMatchObject({
      operation: "create", cause: new Error("Invalid URL.")
    })
    expect(yield* Effect.flip(bookmarks.create({ title: "Late", index: 5 }))).toMatchObject({
      operation: "create", cause: new Error("Index out of bounds.")
    })
    expect((yield* Effect.flip(bookmarks.create({ title: "Early", index: -1 }))).cause).toBeInstanceOf(TypeError)
    expect(yield* Effect.flip(bookmarks.create({ parentId: TestBookmarks.rootId, title: "Top" }))).toMatchObject({
      operation: "create", cause: new Error("Can't modify the root bookmark folders.")
    })
    expect(yield* Effect.flip(bookmarks.create({ parentId: "404", title: "Orphan" }))).toMatchObject({
      operation: "create", cause: new Error("Can't find parent bookmark for id.")
    })
    expect(yield* Effect.flip(bookmarks.create({ parentId: "nope", title: "Orphan" }))).toMatchObject({
      cause: new Error("Bookmark id is invalid.")
    })
    const page = yield* bookmarks.create({ title: "Page", url: "https://page.example/" })
    expect(yield* Effect.flip(bookmarks.create({ parentId: page.id, title: "Inside" }))).toMatchObject({
      cause: new Error("Parameter 'parentId' does not specify a folder.")
    })

    for (const id of [TestBookmarks.rootId, TestBookmarks.bookmarksBarId, TestBookmarks.otherBookmarksId, TestBookmarks.mobileBookmarksId]) {
      expect(yield* Effect.flip(bookmarks.remove(id))).toMatchObject({ operation: "remove", cause: new Error("Can't modify the root bookmark folders.") })
      expect(yield* Effect.flip(bookmarks.removeTree(id))).toMatchObject({ operation: "removeTree" })
    }

    expect(yield* Effect.flip(bookmarks.remove("404"))).toMatchObject({ operation: "remove", cause: new Error("Can't find bookmark for id.") })
    yield* bookmarks.removeTree(folder.id)
    expect(fixture.controls.node(folder.id)).toBeUndefined()
    expect(fixture.controls.node(child.id)).toBeUndefined()
    expect(fixture.controls.size).toBe(5)
  }))

  it.effect("validates integer arguments synchronously like Chrome's schema, changing nothing", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)
    const page = yield* bookmarks.create({ title: "Page", url: "https://page.example/" })
    yield* bookmarks.create({ title: "Second", url: "https://second.example/" })
    const createdEvents = yield* Effect.forkScoped(Stream.runCollect(Stream.take(bookmarks.onCreated, 1)))
    const movedEvents = yield* Effect.forkScoped(Stream.runCollect(Stream.take(bookmarks.onMoved, 1)))
    yield* Effect.promise(() => fixture.controls.onCreated.waitForListener())
    yield* Effect.promise(() => fixture.controls.onMoved.waitForListener())

    const createPrefix = "Error in invocation of bookmarks.create(bookmarks.CreateDetails bookmark, optional function callback): " +
      "Error at parameter 'bookmark': Error at property 'index': "

    const movePrefix = "Error in invocation of bookmarks.move(string id, object destination, optional function callback): " +
      "Error at parameter 'destination': Error at property 'index': "

    for (const index of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
      expect(() => fixture.api.create({ title: "Bad", index })).toThrow(new TypeError(`${createPrefix}Invalid type: expected integer, found number.`))
      expect(() => fixture.api.move(page.id, { index })).toThrow(new TypeError(`${movePrefix}Invalid type: expected integer, found number.`))
      expect(() => fixture.api.getRecent(index)).toThrow(TypeError)
      expect(yield* Effect.flip(bookmarks.create({ title: "Bad", index }))).toMatchObject({ operation: "create" })
      expect(yield* Effect.flip(bookmarks.move(page.id, { index }))).toMatchObject({ operation: "move" })
      expect(yield* Effect.flip(bookmarks.getRecent(index))).toMatchObject({ operation: "getRecent" })
    }

    expect(() => fixture.api.create({ title: "Bad", index: -1 })).toThrow(new TypeError(`${createPrefix}Value must be at least 0.`))
    expect(() => fixture.api.move(page.id, { index: -1 })).toThrow(new TypeError(`${movePrefix}Value must be at least 0.`))
    expect((yield* bookmarks.getChildren("2")).map(({ title, index }) => [title, index])).toEqual([["Page", 0], ["Second", 1]])
    expect(fixture.controls.size).toBe(6)
    const valid = yield* bookmarks.create({ title: "Valid", index: 1 })
    yield* bookmarks.move(valid.id, { index: 0 })
    expect((yield* Fiber.join(createdEvents)).map(({ id }) => id)).toEqual([valid.id])
    expect(yield* Fiber.join(movedEvents)).toEqual([{ id: valid.id, parentId: "2", index: 0, oldParentId: "2", oldIndex: 1 }])
  }))

  it.effect("refuses to move a bookmark into itself because it is not a folder", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)
    const page = yield* bookmarks.create({ title: "Page", url: "https://page.example/" })
    const folder = yield* bookmarks.create({ title: "Folder" })
    expect(yield* Effect.flip(bookmarks.move(page.id, { parentId: page.id }))).toMatchObject({
      operation: "move", cause: new Error("Parameter 'parentId' does not specify a folder.")
    })
    expect(yield* Effect.flip(bookmarks.move(folder.id, { parentId: folder.id }))).toMatchObject({
      operation: "move", cause: new Error("Can't move a folder to itself or its descendant.")
    })
  }))

  it.effect("parses ids as 64-bit integers, as Chrome does before looking them up", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)
    expect((yield* bookmarks.get("01", "+2", "-0")).map(({ id }) => id)).toEqual(["1", "2", "0"])
    expect((yield* bookmarks.getChildren("000")).map(({ id }) => id)).toEqual(["1", "2", "3"])
    const folder = yield* bookmarks.create({ parentId: "01", title: "Padded" })
    expect(folder).toMatchObject({ parentId: "1", index: 0 })
    expect(yield* bookmarks.update(`0${folder.id}`, { title: "Renamed" })).toMatchObject({ id: folder.id, title: "Renamed" })
    expect(yield* Effect.flip(bookmarks.remove("+1"))).toMatchObject({ cause: new Error("Can't modify the root bookmark folders.") })
    expect(yield* Effect.flip(bookmarks.get("9223372036854775807"))).toMatchObject({ cause: new Error("Can't find bookmark for id.") })

    for (const id of ["9223372036854775808", "-9223372036854775809", "", " 1", "1 ", "1.0", "0x1", "-", "+"]) {
      expect(yield* Effect.flip(bookmarks.get(id))).toMatchObject({ operation: "get", cause: new Error("Bookmark id is invalid.") })
    }
  }))

  it.effect("refuses isolated web app URLs, as Chrome does", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)
    const page = yield* bookmarks.create({ title: "Page", url: "https://page.example/" })
    expect(yield* Effect.flip(bookmarks.create({ title: "App", url: "isolated-app://app/" }))).toMatchObject({
      operation: "create", cause: new Error("Invalid URL.")
    })
    expect(yield* Effect.flip(bookmarks.update(page.id, { url: "isolated-app://app/" }))).toMatchObject({
      operation: "update", cause: new Error("Invalid URL.")
    })
    expect(fixture.controls.node(page.id)?.url).toBe("https://page.example/")
  }))

  it.effect("applies a whole operation before delivering its events to listeners that call back synchronously", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)
    const page = yield* bookmarks.create({ title: "Page", url: "https://page.example/" })
    const observed = yield* Effect.forkScoped(Stream.runCollect(Stream.take(Stream.merge(bookmarks.onChanged, bookmarks.onRemoved), 3)))
    yield* Effect.promise(() => fixture.controls.onChanged.waitForListener())
    yield* Effect.promise(() => fixture.controls.onRemoved.waitForListener())
    const seen: Array<string> = []
    const removals: Array<Promise<void>> = []

    // A raw listener that removes the node the moment it hears of the first change.
    const removeOnChange = (id: string, info: ChangeInfo) => {
      seen.push(`changed ${info.title} ${info.url ?? ""}`)
      fixture.api.onChanged.removeListener(removeOnChange)
      removals.push(fixture.api.remove(id))
    }

    fixture.api.onChanged.addListener(removeOnChange)
    fixture.api.onRemoved.addListener((_id, info) => { seen.push(`removed at ${info.index}`) })
    const result = yield* bookmarks.update(page.id, { title: "Renamed", url: "https://renamed.example/" })
    expect(result).toMatchObject({ id: page.id, parentId: "2", index: 0, title: "Renamed", url: "https://renamed.example/" })
    expect(seen).toEqual(["changed Renamed https://page.example/", "removed at 0"])
    yield* Effect.promise(() => Promise.all(removals))
    const events = yield* Fiber.join(observed)
    expect(events.map((event) => "node" in event ? `removed at ${event.index}` : `changed ${event.url ?? ""}`)).toEqual([
      "changed https://page.example/", "changed https://renamed.example/", "removed at 0"
    ])
    expect(fixture.controls.node(page.id)).toBeUndefined()

    // A listener that moves each created node leaves the result and the event at the creation place.
    const createdEvents: Array<BookmarkTreeNode> = []
    const moves: Array<Promise<BookmarkTreeNode>> = []
    fixture.api.onCreated.addListener((id) => { moves.push(fixture.api.move(id, { parentId: TestBookmarks.bookmarksBarId })) })
    fixture.api.onCreated.addListener((_id, node) => { createdEvents.push(node) })
    const moved = yield* Effect.forkScoped(Stream.runCollect(Stream.take(bookmarks.onMoved, 1)))
    yield* Effect.promise(() => fixture.controls.onMoved.waitForListener())
    const created = yield* bookmarks.create({ title: "Created", url: "https://created.example/" })
    expect(created).toMatchObject({ parentId: "2", index: 0 })
    expect(createdEvents).toEqual([created])
    expect(yield* Effect.promise(() => Promise.all(moves))).toEqual([expect.objectContaining({ id: created.id, parentId: "1", index: 0 })])
    expect(yield* Fiber.join(moved)).toEqual([{ id: created.id, parentId: "1", index: 0, oldParentId: "2", oldIndex: 0 }])
  }))

  it.effect("hands out copies, so mutating a result or an event never changes the tree", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)
    const folder = yield* bookmarks.create({ title: "Folder" })
    yield* bookmarks.create({ parentId: folder.id, title: "Child", url: "https://child.example/" })
    const events: Array<string> = []

    fixture.api.onCreated.addListener((_id, node) => {
      node.title = "Mutated by a listener"
      events.push(node.title)
    })

    const created = yield* bookmarks.create({ title: "Fresh" })
    expect(created.title).toBe("Fresh")
    created.title = "Mutated result"
    const [tree] = yield* bookmarks.getSubTree(folder.id)
    tree?.children?.splice(0)
    expect(events).toEqual(["Mutated by a listener"])
    expect(fixture.controls.node(created.id)?.title).toBe("Fresh")
    expect(fixture.controls.node(folder.id)?.children).toEqual([expect.objectContaining({ title: "Child" })])
  }))

  it.effect("re-registers a stream value after its registration failed, as Stream.retry does", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)
    fixture.controls.onCreated.failNext("addListener", new Error("refused once"))
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(Stream.retry(bookmarks.onCreated, Schedule.recurs(1)), 1)))
    yield* Effect.promise(() => fixture.controls.onCreated.waitForListener())
    expect(fixture.controls.onCreated.listenerCount).toBe(1)
    const node = yield* bookmarks.create({ title: "After retry" })
    expect((yield* Fiber.join(fiber)).map(({ id }) => id)).toEqual([node.id])
    expect(fixture.controls.onCreated.listenerCount).toBe(0)
  }))

  it.effect("stores canonical URLs and treats an empty url as none", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)
    const page = yield* bookmarks.create({ title: "Page", url: "HTTPS://Page.Example" })
    expect(page.url).toBe("https://page.example/")
    const folder = yield* bookmarks.create({ title: "Folder", url: "" })
    expect(folder.url).toBeUndefined()
    expect(yield* bookmarks.getChildren(folder.id)).toEqual([])
    expect(yield* bookmarks.update(folder.id, { url: "" })).toMatchObject({ title: "Folder" })
    expect(yield* bookmarks.update(page.id, { url: "" })).toMatchObject({ url: "https://page.example/" })
    expect(yield* bookmarks.update(page.id, { url: "https://page.example/a b" })).toMatchObject({ url: "https://page.example/a%20b" })
    expect(yield* bookmarks.update(page.id, { title: "" })).toMatchObject({ title: "" })
    expect(titles(yield* bookmarks.search({ url: "https://PAGE.example/a%20b" }))).toEqual([""])
  }))

  it.effect("fires onChanged once per property Chrome sets, title first", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)
    const page = yield* bookmarks.create({ title: "Page", url: "https://page.example/" })
    const folder = yield* bookmarks.create({ title: "Folder" })
    const changed = yield* Effect.forkScoped(Stream.runCollect(Stream.take(bookmarks.onChanged, 5)))
    yield* Effect.promise(() => fixture.controls.onChanged.waitForListener())
    yield* bookmarks.update(page.id, {})
    yield* bookmarks.update(page.id, { title: "Page", url: "https://page.example" })
    yield* bookmarks.update(page.id, { title: "New", url: "https://new.example/" })
    yield* bookmarks.update(page.id, { url: "https://newer.example/" })
    yield* bookmarks.update(folder.id, { title: "Renamed" })
    yield* bookmarks.update(page.id, { title: "Newest" })
    expect(yield* Fiber.join(changed)).toEqual([
      { id: page.id, title: "New", url: "https://page.example/" },
      { id: page.id, title: "New", url: "https://new.example/" },
      { id: page.id, title: "New", url: "https://newer.example/" },
      { id: folder.id, title: "Renamed" },
      { id: page.id, title: "Newest", url: "https://newer.example/" }
    ])
    expect(fixture.controls.onChanged.listenerCount).toBe(0)
  }))

  it.effect("searches by words in the title or the URL, exact title and canonical URL", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)
    const cafe = yield* bookmarks.create({ title: "Café Reviews", url: "https://food.example/coffee" })
    const folder = yield* bookmarks.create({ parentId: "1", title: "Coffee" })
    yield* bookmarks.create({ parentId: folder.id, title: "Beans", url: "https://beans.example/" })
    expect(titles(yield* bookmarks.search("cafe"))).toEqual(["Café Reviews"])
    expect(titles(yield* bookmarks.search("CAFÉ reviews"))).toEqual(["Café Reviews"])
    expect(titles(yield* bookmarks.search("\"café reviews\""))).toEqual(["Café Reviews"])
    expect(titles(yield* bookmarks.search("food coffee"))).toEqual(["Café Reviews"])
    expect(titles(yield* bookmarks.search("café food"))).toEqual([])
    expect(titles(yield* bookmarks.search("coffee"))).toEqual(["Coffee", "Café Reviews"])
    expect(yield* bookmarks.search("")).toEqual([])
    expect(yield* bookmarks.search("   ")).toEqual([])
    expect(yield* bookmarks.search({ query: "" })).toEqual([])
    expect(titles(yield* bookmarks.search({}))).toEqual(["Coffee", "Beans", "Café Reviews"])
    expect(titles(yield* bookmarks.search({ title: "Coffee" }))).toEqual(["Coffee"])
    expect(titles(yield* bookmarks.search({ title: "coffee" }))).toEqual([])
    expect(titles(yield* bookmarks.search({ url: "https://beans.example" }))).toEqual(["Beans"])
    expect(yield* bookmarks.search({ url: "not a url" })).toEqual([])
    expect(titles(yield* bookmarks.search({ query: "coffee", url: "https://food.example/coffee" }))).toEqual(["Café Reviews"])
    expect(titles(yield* bookmarks.search({ query: "coffee", title: "Coffee" }))).toEqual(["Coffee"])
    expect(yield* bookmarks.search({ query: "beans", title: "Coffee" })).toEqual([])
    expect((yield* bookmarks.search("reviews"))[0]).toMatchObject({ id: cafe.id, parentId: "2", index: 0 })
    expect((yield* bookmarks.search("reviews"))[0]?.children).toBeUndefined()
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
    const creations = yield* Fiber.join(created)
    expect(creations.map(({ id, bookmark }) => [id, bookmark.title, bookmark.parentId, bookmark.index])).toEqual([
      [folder.id, "Folder", "2", 0], [page.id, "Page", folder.id, 0]
    ])
    expect(creations[0]?.bookmark.children).toBeUndefined()
    expect(yield* Fiber.join(changed)).toEqual([{ id: page.id, title: "Renamed", url: "https://page.example/" }])
    expect(yield* Fiber.join(moved)).toEqual([{ id: folder.id, parentId: "1", index: 0, oldParentId: "2", oldIndex: 0 }])
    const [removal] = yield* Fiber.join(removed)
    expect(removal).toMatchObject({ id: folder.id, parentId: "1", index: 0 })
    expect(removal?.node).toMatchObject({ id: folder.id, title: "Folder" })
    expect(removal?.node.parentId).toBeUndefined()
    expect(removal?.node.index).toBeUndefined()
    expect(removal?.node.children).toEqual([expect.objectContaining({ id: page.id, title: "Renamed", parentId: folder.id, index: 0 })])
    expect(events.every(({ name }) => fixture.controls[name].listenerCount === 0)).toBe(true)
  }))

  it.effect("fires one onRemoved for a whole folder and none for its contents", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)
    const folder = yield* bookmarks.create({ title: "Folder" })
    const sub = yield* bookmarks.create({ parentId: folder.id, title: "Sub" })
    yield* bookmarks.create({ parentId: sub.id, title: "Deep", url: "https://deep.example/" })
    const lone = yield* bookmarks.create({ title: "Lone", url: "https://lone.example/" })
    const removed = yield* Effect.forkScoped(Stream.runCollect(Stream.take(bookmarks.onRemoved, 2)))
    yield* Effect.promise(() => fixture.controls.onRemoved.waitForListener())
    yield* bookmarks.removeTree(folder.id)
    yield* bookmarks.remove(lone.id)
    const removals = yield* Fiber.join(removed)
    expect(removals.map(({ id, parentId, index }) => ({ id, parentId, index }))).toEqual([
      { id: folder.id, parentId: "2", index: 0 },
      { id: lone.id, parentId: "2", index: 0 }
    ])
    expect(titles(removals[0]?.node.children?.[0]?.children ?? [])).toEqual(["Deep"])
    expect(fixture.controls.size).toBe(4)
    expect(yield* bookmarks.search({})).toEqual([])
  }))

  it.effect("reorders a folder through the fixture control, refusing anything but a permutation", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)
    const a = yield* bookmarks.create({ title: "A", url: "https://a.example/" })
    const b = yield* bookmarks.create({ title: "B", url: "https://b.example/" })
    const reordered = yield* Effect.forkScoped(Stream.runCollect(Stream.take(bookmarks.onChildrenReordered, 1)))
    yield* Effect.promise(() => fixture.controls.onChildrenReordered.waitForListener())
    expect(() => fixture.controls.reorder("2", [a.id])).toThrow("childIds must be a permutation of the folder's children.")
    expect(() => fixture.controls.reorder("2", [a.id, a.id])).toThrow("childIds must be a permutation of the folder's children.")
    expect(() => fixture.controls.reorder("2", [a.id, "1"])).toThrow("childIds must be a permutation of the folder's children.")
    expect(() => fixture.controls.reorder(a.id, [])).toThrow("Parameter 'parentId' does not specify a folder.")
    expect(titles(yield* bookmarks.getChildren("2"))).toEqual(["A", "B"])
    fixture.controls.reorder("2", [b.id, a.id])
    expect(yield* Fiber.join(reordered)).toEqual([{ id: "2", childIds: [b.id, a.id] }])
    expect((yield* bookmarks.getChildren("2")).map(({ title, index }) => [title, index])).toEqual([["B", 0], ["A", 1]])
  }))

  it.effect.each(events)("delivers $name as named fields and removes its listener when the stream ends", (spec) => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const collected = yield* Effect.forkScoped(Stream.runCollect(Stream.take(streamOf(make(fixture.api), spec.name), 2)))
    yield* Effect.promise(() => fixture.controls[spec.name].waitForListener())
    expect(fixture.controls[spec.name].listenerCount).toBe(1)
    spec.emit(fixture)
    spec.emit(fixture)
    expect(yield* Fiber.join(collected)).toEqual([spec.expected, spec.expected])
    expect(fixture.controls[spec.name].listenerCount).toBe(0)
  }))

  it.effect.each(events)("gives each $name consumption its own listener and removes it on interruption", (spec) => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const registrations = counting()
    const stream = streamOf(make(spec.rewrap(fixture, registrations.rewrap)), spec.name)
    const first = yield* Effect.forkChild(Stream.runCollect(stream))
    yield* Effect.promise(() => registrations.reached(1))
    const second = yield* Effect.forkChild(Stream.runCollect(Stream.take(stream, 1)))
    yield* Effect.promise(() => registrations.reached(2))
    expect(fixture.controls[spec.name].listenerCount).toBe(2)
    spec.emit(fixture)
    expect(yield* Fiber.join(second)).toEqual([spec.expected])
    expect(fixture.controls[spec.name].listenerCount).toBe(1)
    yield* Fiber.interrupt(first)
    expect(Exit.hasInterrupts(yield* Fiber.await(first))).toBe(true)
    expect(fixture.controls[spec.name].listenerCount).toBe(0)
  }))

  it.effect.each(events)("types a failing $name registration and leaves no listener", (spec) => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const cause = new Error("event unavailable")
    fixture.controls[spec.name].failNext("addListener", cause)
    const error = yield* Effect.flip(Stream.runDrain(streamOf(make(fixture.api), spec.name)))
    expect(error).toBeInstanceOf(ChromeBookmarksError)
    expect(error).toMatchObject({ operation: spec.name, cause })
    expect(fixture.controls[spec.name].listenerCount).toBe(0)
  }))

  it.effect.each(events)("removes a $name listener whose registration added it and then threw", (spec) => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const cause = new Error("added, then failed")
    const error = yield* Effect.flip(Stream.runDrain(streamOf(make(spec.rewrap(fixture, addThenThrow(cause))), spec.name)))
    expect(error).toMatchObject({ operation: spec.name, cause })
    expect(fixture.controls[spec.name].listenerCount).toBe(0)
  }))

  it.effect.each(events)("types a $name event that cannot be read", (spec) => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const cause = new Error("no such event")
    const api = Object.defineProperty({ ...fixture.api }, spec.name, { get: () => raise(cause) })
    const bookmarks = make(api)
    expect(yield* Effect.flip(Stream.runDrain(streamOf(bookmarks, spec.name)))).toMatchObject({ operation: spec.name, cause })
  }))

  it.effect("drops emissions after its listener is removed", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)
    expect(yield* Stream.runCollect(Stream.take(bookmarks.onCreated, 0))).toEqual([])
    expect(fixture.controls.onCreated.listenerCount).toBe(0)
    yield* bookmarks.create({ title: "Unobserved" })
    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(bookmarks.onCreated, 1)))
    yield* Effect.promise(() => fixture.controls.onCreated.waitForListener())
    const seen = yield* bookmarks.create({ title: "Observed" })
    expect((yield* Fiber.join(fiber)).map(({ id }) => id)).toEqual([seen.id])
  }))

  it.effect("interrupts a pending call without waiting for Chrome", () => Effect.gen(function*() {
    let settle: (nodes: Array<BookmarkTreeNode>) => void = () => {}

    const started = gate()

    const fixture = TestBookmarks.makeBookmarks({
      getTree: () => new Promise((resolve) => {
        settle = resolve
        started.open()
      })
    })

    const fiber = yield* Effect.forkChild(make(fixture.api).getTree)
    yield* Effect.promise(() => started.promise)
    yield* Fiber.interrupt(fiber)
    expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
    settle([])
  }))

  it.effect("provides the fixture layer and reads the global only when the live layer builds", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    expect(titles(yield* Effect.flatMap(ChromeBookmarks, (bookmarks) => bookmarks.getChildren("0")).pipe(Effect.provide(fixture.layer)))).toEqual([
      "Bookmarks bar", "Other bookmarks", "Mobile bookmarks"
    ])
    expect(titles(yield* Effect.flatMap(ChromeBookmarks, (bookmarks) => bookmarks.getChildren("0")).pipe(Effect.provide(layer(fixture.api))))).toHaveLength(3)
    expect("chrome" in globalThis).toBe(false)
    const missing = yield* Effect.flip(ChromeBookmarks.pipe(Effect.provide(layerLive)))
    expect(missing).toBeInstanceOf(ChromeBookmarksError)
    expect(missing).toMatchObject({ operation: "initialize", cause: new Error("chrome.bookmarks is unavailable in this context") })
    vi.stubGlobal("chrome", {})
    expect(yield* Effect.flip(ChromeBookmarks.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
    vi.stubGlobal("chrome", { bookmarks: fixture.api })
    expect((yield* Effect.flatMap(ChromeBookmarks, (bookmarks) => bookmarks.getTree).pipe(Effect.provide(layerLive)))[0]?.id).toBe("0")
  }))
})
