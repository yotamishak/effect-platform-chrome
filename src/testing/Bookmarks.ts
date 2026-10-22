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

/** Chrome parses ids as 64-bit integers before looking them up. */
const checkId = (id: string): string => /^-?\d+$/.test(id) ? id : fail("Bookmark id is invalid.")

/** The URL in canonical form, as Chrome stores it. */
const canonicalUrl = (url: string): string => URL.canParse(url) ? new URL(url).href : fail("Invalid URL.")

/** Case- and accent-insensitive text, as Chrome compares search words. */
const fold = (text: string): string => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()

/** The words of a query; quoted phrases still match word by word. */
const words = (text: string): Array<string> => fold(text).split(/[\s"]+/u).filter((word) => word.length > 0)

const containsAll = (text: string, terms: ReadonlyArray<string>): boolean => {
  const folded = fold(text)

  return terms.every((term) => folded.includes(term))
}

/**
 * An in-memory bookmark tree holding the root ("0") and the permanent Bookmarks bar ("1"),
 * Other bookmarks ("2") and Mobile bookmarks ("3") folders. Mutations fail with Chrome's
 * messages where Chrome would (malformed or unknown ids, permanent folders, non-empty folders,
 * out-of-range indexes, invalid URLs, moving a folder into itself) and emit Chrome's events.
 * URLs are stored in canonical form, and an empty `url` means none. `search` matches bookmarks
 * and folders but never the permanent folders, with every word in the title or every word in
 * the URL; `update` emits `onChanged` once for a title change and once more for a URL change;
 * a removed node is described detached, without `parentId` or `index`. `getRecent` breaks
 * equal `dateAdded` times by creation order. `controls.reorder` simulates sorting a folder in
 * the UI. Pass `overrides` to replace any member.
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

  const find = (id: string): Entry => entries.get(checkId(id)) ?? fail("Can't find bookmark for id.")

  const findParent = (id: string): Entry => entries.get(checkId(id)) ?? fail("Can't find parent bookmark for id.")

  const childrenOf = (entry: Entry): Array<string> => entry.children ?? fail("Parameter 'parentId' does not specify a folder.")

  const modifiable = (id: string): Entry => {
    const entry = find(id)

    return permanentIds.has(entry.id) ? fail("Can't modify the root bookmark folders.") : entry
  }

  const touch = (folder: Entry) => { folder.dateGroupModified = Date.now() }

  /** The node alone, placed at `index` in its parent, or detached when `index` is undefined. */
  const shallow = (entry: Entry, index: number | undefined): BookmarkTreeNode => {
    const result: BookmarkTreeNode = { id: entry.id, title: entry.title, syncing: false, dateAdded: entry.dateAdded }

    if (entry.parentId !== undefined && index !== undefined) {
      result.parentId = entry.parentId
      result.index = index
    }

    if (entry.url !== undefined) result.url = entry.url

    if (entry.dateGroupModified !== undefined) result.dateGroupModified = entry.dateGroupModified

    if (entry.folderType !== undefined) result.folderType = entry.folderType

    return result
  }

  /** Like `shallow`, with every descendant when `deep`; iterative, so any depth is safe. */
  const describe = (root: Entry, index: number | undefined, deep: boolean): BookmarkTreeNode => {
    const top = shallow(root, index)

    if (!deep) return top
    const pending: Array<readonly [Entry, BookmarkTreeNode]> = [[root, top]]

    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      const [entry, result] = next

      if (entry.children === undefined) continue
      result.children = entry.children.map((id, position) => {
        const child = find(id)
        const childNode = shallow(child, position)
        pending.push([child, childNode])

        return childNode
      })
    }

    return top
  }

  const positionOf = (entry: Entry): number | undefined =>
    entry.parentId === undefined ? undefined : childrenOf(find(entry.parentId)).indexOf(entry.id)

  const node = (entry: Entry, deep: boolean): BookmarkTreeNode => describe(entry, positionOf(entry), deep)

  /** The entry and its descendants in tree order; iterative, so any depth is safe. */
  const subtree = (root: Entry): Array<Entry> => {
    const result: Array<Entry> = []
    const pending = [root]

    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      result.push(next)

      for (const id of [...(next.children ?? [])].reverse()) pending.push(find(id))
    }

    return result
  }

  /** Whether `entry` is `ancestor` or lies inside it, walking up rather than down. */
  const within = (entry: Entry, ancestor: Entry): boolean => {
    for (let current: Entry | undefined = entry; current !== undefined;) {
      if (current === ancestor) return true
      current = current.parentId === undefined ? undefined : entries.get(current.parentId)
    }

    return false
  }

  const matches = (entry: Entry, query: string | ChromeBookmarks.SearchQuery): boolean => {
    const criteria: ChromeBookmarks.SearchQuery = Predicate.isString(query) ? { query } : query

    if (criteria.query !== undefined) {
      const terms = words(criteria.query)

      if (terms.length === 0) return false

      if (!containsAll(entry.title, terms) && (entry.url === undefined || !containsAll(entry.url, terms))) return false
    }

    if (criteria.url !== undefined && (entry.url === undefined || !URL.canParse(criteria.url) || entry.url !== new URL(criteria.url).href)) {
      return false
    }

    return criteria.title === undefined || entry.title === criteria.title
  }

  const removeEntry = (entry: Entry, recursive: boolean) => {
    if (!recursive && (entry.children ?? []).length > 0) fail("Can't remove non-empty folder (use recursive to force).")
    const parent = find(entry.parentId ?? rootId)
    const siblings = childrenOf(parent)
    const index = siblings.indexOf(entry.id)
    const removedNode = describe(entry, undefined, true)
    siblings.splice(index, 1)
    touch(parent)

    for (const descendant of subtree(entry)) entries.delete(descendant.id)
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
    getChildren: async (id) => (find(id).children ?? []).map((child, index) => describe(find(child), index, false)),
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
    search: async (query) => subtree(find(rootId))
      .filter((entry) => !permanentIds.has(entry.id) && matches(entry, query))
      .map((entry) => node(entry, false)),
    create: async (details) => {
      const parent = findParent(details.parentId ?? otherBookmarksId)

      if (parent.id === rootId) fail("Can't modify the root bookmark folders.")
      const siblings = childrenOf(parent)
      const index = details.index ?? siblings.length

      if (index < 0 || index > siblings.length) fail("Index out of bounds.")
      const url = details.url === undefined || details.url === "" ? undefined : canonicalUrl(details.url)
      const entry = insert(String(nextId++), parent.id, details.title ?? "", url)
      siblings.splice(index, 0, entry.id)
      touch(parent)
      created.controls.emit(entry.id, describe(entry, index, false))

      return describe(entry, index, false)
    },
    move: async (id, destination) => {
      const entry = modifiable(id)
      const oldParent = find(entry.parentId ?? rootId)
      const parent = destination.parentId === undefined ? oldParent : findParent(destination.parentId)

      if (parent.id === rootId) fail("Can't modify the root bookmark folders.")

      if (within(parent, entry)) fail("Can't move a folder to itself or its descendant.")
      const siblings = childrenOf(parent)
      const oldIndex = childrenOf(oldParent).indexOf(entry.id)
      const requested = destination.index ?? siblings.length

      if (requested < 0 || requested > siblings.length) fail("Index out of bounds.")

      // Like Chrome, an index in the same folder counts positions before the node is taken out.
      if (parent === oldParent && (requested === oldIndex || requested === oldIndex + 1)) return describe(entry, oldIndex, false)
      const index = parent === oldParent && requested > oldIndex ? requested - 1 : requested
      childrenOf(oldParent).splice(oldIndex, 1)
      siblings.splice(index, 0, entry.id)
      entry.parentId = parent.id
      touch(oldParent)
      touch(parent)
      moved.controls.emit(entry.id, { parentId: parent.id, index, oldParentId: oldParent.id, oldIndex })

      return describe(entry, index, false)
    },
    update: async (id, changes) => {
      // Chrome validates the URL before looking the node up.
      const url = changes.url === undefined || changes.url === "" ? undefined : canonicalUrl(changes.url)
      const entry = modifiable(id)

      if (url !== undefined && entry.url === undefined) fail("Can't set URL of a bookmark folder.")

      const report = () => {
        changed.controls.emit(entry.id, entry.url === undefined ? { title: entry.title } : { title: entry.title, url: entry.url })
      }

      // Chrome sets the title, then the URL, notifying for each that actually changed.
      if (changes.title !== undefined && changes.title !== entry.title) {
        entry.title = changes.title
        report()
      }

      if (url !== undefined && url !== entry.url) {
        entry.url = url
        report()
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
      /** How many nodes the tree holds, counting the root and the permanent folders. */
      get size() { return entries.size },
      /**
       * Reorders a folder's children, as sorting it in the UI does, and emits
       * `onChildrenReordered`. Throws unless `childIds` is a permutation of the children.
       */
      reorder: (folderId: string, childIds: ReadonlyArray<string>) => {
        const children = childrenOf(find(folderId))
        const proposed = new Set(childIds)

        if (childIds.length !== children.length || proposed.size !== children.length || !children.every((id) => proposed.has(id))) {
          fail("childIds must be a permutation of the folder's children.")
        }

        // Assigned in place rather than spread, so very large folders stay within argument limits.
        childIds.forEach((id, index) => { children[index] = id })
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
