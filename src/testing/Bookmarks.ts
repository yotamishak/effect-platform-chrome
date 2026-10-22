import { Predicate } from "effect"
import * as ChromeBookmarks from "../ChromeBookmarks.js"
import * as TestEvent from "./Event.js"

type BookmarkTreeNode = ChromeBookmarks.BookmarkTreeNode

interface Entry {
  readonly id: string
  parentId: string | undefined
  title: string
  url: string | undefined
  readonly dateAdded: number
  dateGroupModified: number | undefined
  readonly folderType: BookmarkTreeNode["folderType"]
  /** Child ids for a folder; a bookmark has none. */
  readonly children: Array<string> | undefined
  /** Creation order, breaking `dateAdded` ties in `getRecent`. */
  readonly sequence: number
}

/** The id of the root node, as `chrome.bookmarks.ROOT_NODE_ID`. */
export const rootId = "0"

/** The ids of the permanent folders under the root, as desktop Chrome assigns them. */
export const bookmarksBarId = "1"

export const otherBookmarksId = "2"

export const mobileBookmarksId = "3"

const permanentIds: ReadonlySet<string> = new Set([rootId, bookmarksBarId, otherBookmarksId, mobileBookmarksId])

const fail = (message: string): never => { throw new Error(message) }

const checkUrl = (url: string): string => URL.canParse(url) ? url : fail("Invalid URL.")

const words = (text: string): Array<string> => text.toLowerCase().split(/\s+/).filter((word) => word.length > 0)

/**
 * An in-memory bookmark tree holding the root ("0") and the permanent Bookmarks bar ("1"),
 * Other bookmarks ("2") and Mobile bookmarks ("3") folders. Mutations fail with Chrome's
 * messages where Chrome would (unknown ids, permanent folders, non-empty folders, out-of-range
 * indexes, invalid URLs, moving a folder into itself) and emit Chrome's events. `search`
 * matches bookmarks and folders but never the permanent folders; `update` emits one
 * `onChanged` when anything changed. `controls.reorder` simulates sorting a folder in the UI.
 * Pass `overrides` to replace any member.
 */
export const makeBookmarks = (overrides: Partial<ChromeBookmarks.ChromeBookmarksApi> = {}) => {
  const entries = new Map<string, Entry>()
  const created = TestEvent.makeEvent<[string, BookmarkTreeNode]>()
  const removed = TestEvent.makeEvent<[string, ChromeBookmarks.RemoveInfo]>()
  const changed = TestEvent.makeEvent<[string, ChromeBookmarks.ChangeInfo]>()
  const moved = TestEvent.makeEvent<[string, ChromeBookmarks.MoveInfo]>()
  const childrenReordered = TestEvent.makeEvent<[string, ChromeBookmarks.ReorderInfo]>()
  const importBegan = TestEvent.makeEvent<[]>()
  const importEnded = TestEvent.makeEvent<[]>()
  let nextId = 4
  let sequence = 0

  const insert = (
    id: string,
    parentId: string | undefined,
    title: string,
    url: string | undefined,
    folderType?: BookmarkTreeNode["folderType"]
  ): Entry => {
    const now = Date.now()

    const entry: Entry = {
      id, parentId, title, url, dateAdded: now, dateGroupModified: url === undefined ? now : undefined,
      folderType, children: url === undefined ? [] : undefined, sequence: sequence++
    }

    entries.set(id, entry)

    return entry
  }

  const find = (id: string): Entry => entries.get(id) ?? fail("Can't find bookmark for id.")

  const childrenOf = (entry: Entry): Array<string> => entry.children ?? fail("Parameter 'parentId' does not specify a folder.")

  const modifiable = (id: string): Entry => permanentIds.has(id) ? fail("Can't modify the root bookmark folders.") : find(id)

  const touch = (folder: Entry) => { folder.dateGroupModified = Date.now() }

  const node = (entry: Entry, deep: boolean): BookmarkTreeNode => {
    const result: BookmarkTreeNode = { id: entry.id, title: entry.title, syncing: false, dateAdded: entry.dateAdded }

    if (entry.parentId !== undefined) {
      result.parentId = entry.parentId
      result.index = childrenOf(find(entry.parentId)).indexOf(entry.id)
    }

    if (entry.url !== undefined) result.url = entry.url

    if (entry.dateGroupModified !== undefined) result.dateGroupModified = entry.dateGroupModified

    if (entry.folderType !== undefined) result.folderType = entry.folderType

    if (deep && entry.children !== undefined) result.children = entry.children.map((id) => node(find(id), true))

    return result
  }

  const descendants = (entry: Entry): Array<Entry> =>
    [entry, ...(entry.children ?? []).flatMap((id) => descendants(find(id)))]

  const preorder = (): Array<Entry> => descendants(find(rootId))

  const matches = (entry: Entry, query: string | ChromeBookmarks.SearchQuery): boolean => {
    const criteria: ChromeBookmarks.SearchQuery = Predicate.isString(query) ? { query } : query
    const haystack = `${entry.title} ${entry.url ?? ""}`.toLowerCase()

    return words(criteria.query ?? "").every((word) => haystack.includes(word))
      && (criteria.url === undefined || entry.url === criteria.url)
      && (criteria.title === undefined || entry.title === criteria.title)
  }

  const removeEntry = (entry: Entry, recursive: boolean) => {
    const children = entry.children ?? []

    if (!recursive && children.length > 0) fail("Can't remove non-empty folder (use recursive to force).")
    const parent = find(entry.parentId ?? rootId)
    const siblings = childrenOf(parent)
    const index = siblings.indexOf(entry.id)
    const removedNode = node(entry, true)
    siblings.splice(index, 1)
    touch(parent)

    for (const descendant of descendants(entry)) entries.delete(descendant.id)
    removed.controls.emit(entry.id, { parentId: parent.id, index, node: removedNode })
  }

  insert(rootId, undefined, "", undefined)

  for (const [id, title, folderType] of [
    [bookmarksBarId, "Bookmarks bar", "bookmarks-bar"],
    [otherBookmarksId, "Other bookmarks", "other"],
    [mobileBookmarksId, "Mobile bookmarks", "mobile"]
  ] as const) {
    insert(id, rootId, title, undefined, folderType)
    childrenOf(find(rootId)).push(id)
  }

  const api: ChromeBookmarks.ChromeBookmarksApi = {
    get: async (idOrIdList) => [idOrIdList].flat().map((id) => node(find(id), false)),
    getChildren: async (id) => (find(id).children ?? []).map((child) => node(find(child), false)),
    getRecent: async (numberOfItems) => {
      if (numberOfItems < 1) fail("numberOfItems cannot be less than 1.")

      return Array.from(entries.values())
        .filter((entry) => entry.url !== undefined)
        .sort((left, right) => right.dateAdded - left.dateAdded || right.sequence - left.sequence)
        .slice(0, numberOfItems)
        .map((entry) => node(entry, false))
    },
    getTree: async () => [node(find(rootId), true)],
    getSubTree: async (id) => [node(find(id), true)],
    search: async (query) => preorder()
      .filter((entry) => !permanentIds.has(entry.id) && matches(entry, query))
      .map((entry) => node(entry, false)),
    create: async (details) => {
      const parentId = details.parentId ?? otherBookmarksId

      if (parentId === rootId) fail("Can't modify the root bookmark folders.")
      const parent = entries.get(parentId) ?? fail("Can't find parent bookmark for id.")
      const siblings = childrenOf(parent)
      const index = details.index ?? siblings.length

      if (index < 0 || index > siblings.length) fail("Index out of bounds.")
      const entry = insert(String(nextId++), parentId, details.title ?? "", details.url === undefined ? undefined : checkUrl(details.url))
      siblings.splice(index, 0, entry.id)
      touch(parent)
      created.controls.emit(entry.id, node(entry, false))

      return node(entry, false)
    },
    move: async (id, destination) => {
      const entry = modifiable(id)
      const oldParent = find(entry.parentId ?? rootId)
      const parentId = destination.parentId ?? oldParent.id

      if (parentId === rootId) fail("Can't modify the root bookmark folders.")
      const parent = entries.get(parentId) ?? fail("Can't find parent bookmark for id.")

      if (descendants(entry).includes(parent)) fail("Can't move a folder to itself or its descendant.")
      const siblings = childrenOf(parent)
      const oldIndex = childrenOf(oldParent).indexOf(id)
      const requested = destination.index ?? siblings.length

      if (requested < 0 || requested > siblings.length) fail("Index out of bounds.")

      // Like Chrome, an index in the same folder counts positions before the node is taken out.
      if (parent === oldParent && (requested === oldIndex || requested === oldIndex + 1)) return node(entry, false)
      const index = parent === oldParent && requested > oldIndex ? requested - 1 : requested
      childrenOf(oldParent).splice(oldIndex, 1)
      siblings.splice(index, 0, id)
      entry.parentId = parent.id
      touch(oldParent)
      touch(parent)
      moved.controls.emit(id, { parentId: parent.id, index, oldParentId: oldParent.id, oldIndex })

      return node(entry, false)
    },
    update: async (id, changes) => {
      const entry = modifiable(id)

      if (changes.url !== undefined && entry.url === undefined) fail("Can't set URL of a bookmark folder.")
      const url = changes.url === undefined ? entry.url : checkUrl(changes.url)
      const title = changes.title ?? entry.title

      if (url !== entry.url || title !== entry.title) {
        entry.url = url
        entry.title = title
        changed.controls.emit(id, url === undefined ? { title } : { title, url })
      }

      return node(entry, false)
    },
    remove: async (id) => removeEntry(modifiable(id), false),
    removeTree: async (id) => removeEntry(modifiable(id), true),
    onCreated: created.api,
    onRemoved: removed.api,
    onChanged: changed.api,
    onMoved: moved.api,
    onChildrenReordered: childrenReordered.api,
    onImportBegan: importBegan.api,
    onImportEnded: importEnded.api,
    ...overrides
  }

  return {
    api,
    layer: ChromeBookmarks.layer(api),
    controls: {
      /** The node with its descendants, if it exists. */
      node: (id: string): BookmarkTreeNode | undefined => {
        const entry = entries.get(id)

        return entry === undefined ? undefined : node(entry, true)
      },
      /** Reorders a folder's children, as sorting it in the UI does, and emits `onChildrenReordered`. */
      reorder: (folderId: string, childIds: ReadonlyArray<string>) => {
        const children = childrenOf(find(folderId))

        if (childIds.length !== children.length || !childIds.every((id) => children.includes(id))) {
          fail("childIds must be a permutation of the folder's children.")
        }

        children.splice(0, children.length, ...childIds)
        childrenReordered.controls.emit(folderId, { childIds: [...childIds] })
      },
      onCreated: created.controls,
      onRemoved: removed.controls,
      onChanged: changed.controls,
      onMoved: moved.controls,
      onChildrenReordered: childrenReordered.controls,
      onImportBegan: importBegan.controls,
      onImportEnded: importEnded.controls
    }
  }
}
