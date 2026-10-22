import { Context, Effect, Layer, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeBookmarksError extends Schema.TaggedError<ChromeBookmarksError>()("ChromeBookmarksError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/**
 * A bookmark (with a `url`) or a folder (without one). `@types/chrome` marks `syncing` as
 * always present, but Chrome sets it, like `folderType`, only from Chrome 134; `dateLastUsed`
 * needs Chrome 114 and is never set for folders. The root has no `parentId` or `index`.
 */
export interface BookmarkTreeNode extends Omit<chrome.bookmarks.BookmarkTreeNode, "children" | "syncing"> {
  /** The ordered children; present only on folders returned by `getTree`, `getSubTree` and `onRemoved`. */
  children?: Array<BookmarkTreeNode>
  /** Whether the browser syncs this node to the user's account (Chrome 134+). */
  syncing?: boolean
}

export type CreateDetails = chrome.bookmarks.CreateDetails

export type MoveDestination = chrome.bookmarks.MoveDestination

export type UpdateChanges = chrome.bookmarks.UpdateChanges

export type SearchQuery = chrome.bookmarks.SearchQuery

export interface ChangeInfo {
  readonly title: string
  /** The bookmark's URL; absent for a folder. */
  readonly url?: string
}

export interface MoveInfo {
  readonly parentId: string
  readonly index: number
  readonly oldParentId: string
  readonly oldIndex: number
}

export interface RemoveInfo {
  /** The folder the node was removed from. */
  readonly parentId: string
  /** The node's former position in that folder. */
  readonly index: number
  /**
   * The removed node, with its descendants when a folder was removed. Chrome describes it
   * after detaching it, so the node itself carries no `parentId` or `index`.
   */
  readonly node: BookmarkTreeNode
}

export interface ReorderInfo {
  readonly childIds: Array<string>
}

export interface CreatedEvent {
  readonly id: string
  readonly bookmark: BookmarkTreeNode
}

export interface ChangedEvent extends ChangeInfo {
  readonly id: string
}

export interface MovedEvent extends MoveInfo {
  readonly id: string
}

export interface RemovedEvent extends RemoveInfo {
  readonly id: string
}

export interface ChildrenReorderedEvent extends ReorderInfo {
  readonly id: string
}

/** The Promise-based MV3 subset this module needs. */
export interface ChromeBookmarksApi {
  get(idOrIdList: string | [string, ...Array<string>]): Promise<Array<BookmarkTreeNode>>
  getChildren(id: string): Promise<Array<BookmarkTreeNode>>
  getRecent(numberOfItems: number): Promise<Array<BookmarkTreeNode>>
  getTree(): Promise<Array<BookmarkTreeNode>>
  getSubTree(id: string): Promise<Array<BookmarkTreeNode>>
  search(query: string | SearchQuery): Promise<Array<BookmarkTreeNode>>
  create(bookmark: CreateDetails): Promise<BookmarkTreeNode>
  move(id: string, destination: MoveDestination): Promise<BookmarkTreeNode>
  update(id: string, changes: UpdateChanges): Promise<BookmarkTreeNode>
  remove(id: string): Promise<void>
  removeTree(id: string): Promise<void>
  readonly onCreated: EventSource<[id: string, bookmark: BookmarkTreeNode]>
  readonly onRemoved: EventSource<[id: string, removeInfo: RemoveInfo]>
  readonly onChanged: EventSource<[id: string, changeInfo: ChangeInfo]>
  readonly onMoved: EventSource<[id: string, moveInfo: MoveInfo]>
  readonly onChildrenReordered: EventSource<[id: string, reorderInfo: ReorderInfo]>
  readonly onImportBegan: EventSource<[]>
  readonly onImportEnded: EventSource<[]>
}

/**
 * Every call needs the `bookmarks` permission. Chrome refuses to add nodes to the root, and
 * to rename, move or remove the root or its permanent folders; managed folders are read-only.
 */
export interface ChromeBookmarksService {
  /** The nodes with these ids, in order and without their children; fails if any id is unknown. */
  readonly get: (id: string, ...ids: Array<string>) => Effect.Effect<Array<BookmarkTreeNode>, ChromeBookmarksError>
  /** A folder's direct children, without their own children; a bookmark has none. */
  readonly getChildren: (id: string) => Effect.Effect<Array<BookmarkTreeNode>, ChromeBookmarksError>
  /** At most `numberOfItems` (at least 1) of the most recently added bookmarks, never folders, newest first. */
  readonly getRecent: (numberOfItems: number) => Effect.Effect<Array<BookmarkTreeNode>, ChromeBookmarksError>
  /** The whole tree: a single root node (id "0") whose children are the permanent folders. */
  readonly getTree: Effect.Effect<Array<BookmarkTreeNode>, ChromeBookmarksError>
  /** A one-element list holding the node with this id and all its descendants. */
  readonly getSubTree: (id: string) => Effect.Effect<Array<BookmarkTreeNode>, ChromeBookmarksError>
  /**
   * Matching bookmarks and folders, in tree order. A string, like an object's `query`, is a
   * list of words that must all appear, ignoring case, in a node's title or all in its URL;
   * an empty one matches nothing. An object's `url` and `title` match exactly, and a node
   * must match every property given.
   */
  readonly search: (query: string | SearchQuery) => Effect.Effect<Array<BookmarkTreeNode>, ChromeBookmarksError>
  /**
   * Creates a bookmark, or a folder when `url` is absent or empty, at `index` (default: last)
   * in `parentId` (default: Other bookmarks). Chrome stores the URL in canonical form.
   */
  readonly create: (bookmark: CreateDetails) => Effect.Effect<BookmarkTreeNode, ChromeBookmarksError>
  /**
   * Moves a node to `index` (default: last) in `parentId` (default: its current folder).
   * Within the same folder the index counts positions before the node is taken out, so
   * moving to its own index or the next one changes nothing and fires no `onMoved`.
   */
  readonly move: (id: string, destination: MoveDestination) => Effect.Effect<BookmarkTreeNode, ChromeBookmarksError>
  /**
   * Changes only the title and/or URL; a folder has no URL to set, and an empty `url` is
   * ignored. Chrome applies the title, then the URL, firing `onChanged` for each that changed.
   */
  readonly update: (id: string, changes: UpdateChanges) => Effect.Effect<BookmarkTreeNode, ChromeBookmarksError>
  /** Removes a bookmark or an empty folder; use `removeTree` for a non-empty folder. */
  readonly remove: (id: string) => Effect.Effect<void, ChromeBookmarksError>
  /** Removes a folder and everything in it, or a single bookmark. */
  readonly removeTree: (id: string) => Effect.Effect<void, ChromeBookmarksError>
  /**
   * Observational subscriptions that cannot wake an MV3 service worker; register wake
   * listeners through ChromeServiceWorker. Each buffers at most 64 events, dropping the oldest.
   * During an import Chrome fires `onCreated` for every imported node; expensive listeners may
   * wait for `onImportEnded` instead.
   */
  readonly onCreated: Stream.Stream<CreatedEvent, ChromeBookmarksError>
  /** Removing a folder fires once, for the folder; its descendants are in `node`. */
  readonly onRemoved: Stream.Stream<RemovedEvent, ChromeBookmarksError>
  /** A title or URL changed; the event carries the current values of both. */
  readonly onChanged: Stream.Stream<ChangedEvent, ChromeBookmarksError>
  /** A node moved, to another folder or to another position in the same one. */
  readonly onMoved: Stream.Stream<MovedEvent, ChromeBookmarksError>
  /** A folder's children were reordered in the UI, such as by sorting; `move` never fires it. */
  readonly onChildrenReordered: Stream.Stream<ChildrenReorderedEvent, ChromeBookmarksError>
  readonly onImportBegan: Stream.Stream<void, ChromeBookmarksError>
  readonly onImportEnded: Stream.Stream<void, ChromeBookmarksError>
}

export class ChromeBookmarks extends Context.Service<ChromeBookmarks, ChromeBookmarksService>()(
  "effect-platform-chrome/ChromeBookmarks"
) {}

const invoke = invoker((operation, cause) => new ChromeBookmarksError({ operation, cause }))

const eventError = (operation: string) => (cause: unknown) => new ChromeBookmarksError({ operation, cause })

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeBookmarksApi): ChromeBookmarksService => ChromeBookmarks.of({
  get: (id, ...ids) => invoke("get", () => api.get([id, ...ids])),
  getChildren: (id) => invoke("getChildren", () => api.getChildren(id)),
  getRecent: (numberOfItems) => invoke("getRecent", () => api.getRecent(numberOfItems)),
  getTree: invoke("getTree", () => api.getTree()),
  getSubTree: (id) => invoke("getSubTree", () => api.getSubTree(id)),
  search: (query) => invoke("search", () => api.search(query)),
  create: (bookmark) => invoke("create", () => api.create(bookmark)),
  move: (id, destination) => invoke("move", () => api.move(id, destination)),
  update: (id, changes) => invoke("update", () => api.update(id, changes)),
  remove: (id) => invoke("remove", () => api.remove(id)),
  removeTree: (id) => invoke("removeTree", () => api.removeTree(id)),
  onCreated: observe(() => api.onCreated, (id, bookmark) => ({ id, bookmark }), eventError("onCreated")),
  onRemoved: observe(() => api.onRemoved, (id, removeInfo) => ({ ...removeInfo, id }), eventError("onRemoved")),
  onChanged: observe(() => api.onChanged, (id, changeInfo) => ({ ...changeInfo, id }), eventError("onChanged")),
  onMoved: observe(() => api.onMoved, (id, moveInfo) => ({ ...moveInfo, id }), eventError("onMoved")),
  onChildrenReordered: observe(
    () => api.onChildrenReordered,
    (id, reorderInfo) => ({ ...reorderInfo, id }),
    eventError("onChildrenReordered")
  ),
  onImportBegan: observe(() => api.onImportBegan, () => undefined, eventError("onImportBegan")),
  onImportEnded: observe(() => api.onImportEnded, () => undefined, eventError("onImportEnded"))
})

export const layer = (api: ChromeBookmarksApi): Layer.Layer<ChromeBookmarks> => Layer.succeed(ChromeBookmarks, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeBookmarks, ChromeBookmarksError> = liveLayer(
  ChromeBookmarks, "bookmarks", (chrome) => chrome.bookmarks, make,
  (cause) => new ChromeBookmarksError({ operation: "initialize", cause })
)
