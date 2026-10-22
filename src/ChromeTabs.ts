import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeTabsError extends Schema.TaggedError<ChromeTabsError>()("ChromeTabsError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** The promise-based MV3 API surface required by this module. */
export interface ChromeTabsApi {
  query(queryInfo: chrome.tabs.QueryInfo): Promise<Array<chrome.tabs.Tab>>
  get(tabId: number): Promise<chrome.tabs.Tab>
  create(properties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab>
  duplicate(tabId: number): Promise<chrome.tabs.Tab | undefined>
  update(tabId: number | undefined, properties: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab | undefined>
  /** Chrome resolves one tab for a single id and an array for an array of ids. */
  move(tabIds: number | Array<number>, moveProperties: chrome.tabs.MoveProperties): Promise<chrome.tabs.Tab | Array<chrome.tabs.Tab>>
  reload(tabId?: number, reloadProperties?: chrome.tabs.ReloadProperties): Promise<void>
  remove(tabIds: number | Array<number>): Promise<void>
  group(options: chrome.tabs.GroupOptions): Promise<number>
  ungroup(tabIds: number | [number, ...Array<number>]): Promise<void>
  discard(tabId?: number): Promise<chrome.tabs.Tab | undefined>
  goBack(tabId?: number): Promise<void>
  goForward(tabId?: number): Promise<void>
  getZoom(tabId?: number): Promise<number>
  setZoom(tabId: number | undefined, zoomFactor: number): Promise<void>
  getZoomSettings(tabId?: number): Promise<chrome.tabs.ZoomSettings>
  setZoomSettings(tabId: number | undefined, zoomSettings: chrome.tabs.ZoomSettings): Promise<void>
  detectLanguage(tabId?: number): Promise<string>
  sendMessage(tabId: number, message: unknown, options?: chrome.tabs.MessageSendOptions): Promise<unknown>
  connect(tabId: number, connectInfo?: chrome.tabs.ConnectInfo): chrome.runtime.Port
  captureVisibleTab(windowId: number, options: chrome.extensionTypes.ImageDetails): Promise<string>
  readonly onCreated: Pick<typeof chrome.tabs.onCreated, "addListener" | "removeListener">
  readonly onUpdated: Pick<typeof chrome.tabs.onUpdated, "addListener" | "removeListener">
  readonly onRemoved: Pick<typeof chrome.tabs.onRemoved, "addListener" | "removeListener">
  readonly onActivated: Pick<typeof chrome.tabs.onActivated, "addListener" | "removeListener">
  readonly onMoved: Pick<typeof chrome.tabs.onMoved, "addListener" | "removeListener">
  readonly onReplaced: Pick<typeof chrome.tabs.onReplaced, "addListener" | "removeListener">
  readonly onAttached: Pick<typeof chrome.tabs.onAttached, "addListener" | "removeListener">
  readonly onDetached: Pick<typeof chrome.tabs.onDetached, "addListener" | "removeListener">
  readonly onHighlighted: Pick<typeof chrome.tabs.onHighlighted, "addListener" | "removeListener">
  readonly onZoomChange: Pick<typeof chrome.tabs.onZoomChange, "addListener" | "removeListener">
}

export interface UpdatedEvent {
  readonly tabId: number
  readonly changeInfo: chrome.tabs.OnUpdatedInfo
  readonly tab: chrome.tabs.Tab
}

export interface RemovedEvent {
  readonly tabId: number
  readonly removeInfo: chrome.tabs.OnRemovedInfo
}

/** A tab moved within its window. */
export interface MovedEvent {
  readonly tabId: number
  readonly moveInfo: chrome.tabs.OnMovedInfo
}

/** A tab was replaced by another, as by prerendering or instant navigation. */
export interface ReplacedEvent {
  readonly addedTabId: number
  readonly removedTabId: number
}

/** A tab joined a window, after being detached from another. */
export interface AttachedEvent {
  readonly tabId: number
  readonly attachInfo: chrome.tabs.OnAttachedInfo
}

/** A tab left a window, before being attached to another. */
export interface DetachedEvent {
  readonly tabId: number
  readonly detachInfo: chrome.tabs.OnDetachedInfo
}

export interface ChromeTabsService {
  readonly query: (queryInfo: chrome.tabs.QueryInfo) => Effect.Effect<Array<chrome.tabs.Tab>, ChromeTabsError>
  readonly get: (tabId: number) => Effect.Effect<chrome.tabs.Tab, ChromeTabsError>
  readonly create: (properties: chrome.tabs.CreateProperties) => Effect.Effect<chrome.tabs.Tab, ChromeTabsError>
  /** The copy, when Chrome reports one; without the `tabs` permission it lacks url and title. */
  readonly duplicate: (tabId: number) => Effect.Effect<Option.Option<chrome.tabs.Tab>, ChromeTabsError>
  /** Pass undefined to update the selected tab in the current window. */
  readonly update: (tabId: number | undefined, properties: chrome.tabs.UpdateProperties) => Effect.Effect<chrome.tabs.Tab | undefined, ChromeTabsError>
  /**
   * Moves tabs to `index` (-1 for the end), optionally into another window. Always yields
   * the moved tabs as an array, even for a single id. Only normal windows accept tabs.
   */
  readonly move: (tabIds: number | Array<number>, moveProperties: chrome.tabs.MoveProperties) => Effect.Effect<Array<chrome.tabs.Tab>, ChromeTabsError>
  /** Reloads a tab, by default the selected tab of the current window. */
  readonly reload: (tabId?: number, reloadProperties?: chrome.tabs.ReloadProperties) => Effect.Effect<void, ChromeTabsError>
  readonly remove: (tabIds: number | Array<number>) => Effect.Effect<void, ChromeTabsError>
  /**
   * Adds tabs to a group (`groupId`) or to a new group, created in `createProperties.windowId`
   * or the first tab's window, and yields the group's id.
   */
  readonly group: (options: chrome.tabs.GroupOptions) => Effect.Effect<number, ChromeTabsError>
  /** Removes tabs from their groups; emptied groups are deleted. */
  readonly ungroup: (tabIds: number | [number, ...Array<number>]) => Effect.Effect<void, ChromeTabsError>
  /**
   * Unloads a tab from memory while keeping it in the strip; without an id Chrome picks the
   * least important tab. None when Chrome declined to discard.
   */
  readonly discard: (tabId?: number) => Effect.Effect<Option.Option<chrome.tabs.Tab>, ChromeTabsError>
  /** Fails when the tab has no previous page. Defaults to the selected tab of the current window. */
  readonly goBack: (tabId?: number) => Effect.Effect<void, ChromeTabsError>
  /** Fails when the tab has no next page. Defaults to the selected tab of the current window. */
  readonly goForward: (tabId?: number) => Effect.Effect<void, ChromeTabsError>
  /** The current zoom factor; defaults to the active tab of the current window. */
  readonly getZoom: (tabId?: number) => Effect.Effect<number, ChromeTabsError>
  /** Pass undefined for the active tab of the current window; 0 resets to the default factor. */
  readonly setZoom: (tabId: number | undefined, zoomFactor: number) => Effect.Effect<void, ChromeTabsError>
  readonly getZoomSettings: (tabId?: number) => Effect.Effect<chrome.tabs.ZoomSettings, ChromeTabsError>
  /** Pass undefined for the active tab of the current window. */
  readonly setZoomSettings: (tabId: number | undefined, zoomSettings: chrome.tabs.ZoomSettings) => Effect.Effect<void, ChromeTabsError>
  /** An ISO language code such as `en` or `fr`, or `und` when unknown. */
  readonly detectLanguage: (tabId?: number) => Effect.Effect<string, ChromeTabsError>
  readonly sendMessage: (tabId: number, message: unknown, options?: chrome.tabs.MessageSendOptions) => Effect.Effect<unknown, ChromeTabsError>
  /**
   * Opens a port to the content scripts of a tab (one frame with `frameId`). The native port
   * is returned unwrapped, for ChromeRpc.makeClientProtocol or ChromePort.adopt; the caller
   * owns it. A tab with no listener disconnects the port at once, with `lastError` set.
   */
  readonly connect: (tabId: number, connectInfo?: chrome.tabs.ConnectInfo) => Effect.Effect<chrome.runtime.Port, ChromeTabsError>
  /** A data URL of the visible area of the window's active tab (needs `<all_urls>` or activeTab). */
  readonly captureVisibleTab: (windowId: number, options?: chrome.extensionTypes.ImageDetails) => Effect.Effect<string, ChromeTabsError>
  readonly onCreated: Stream.Stream<chrome.tabs.Tab, ChromeTabsError>
  readonly onUpdated: Stream.Stream<UpdatedEvent, ChromeTabsError>
  readonly onRemoved: Stream.Stream<RemovedEvent, ChromeTabsError>
  readonly onActivated: Stream.Stream<chrome.tabs.OnActivatedInfo, ChromeTabsError>
  /** Moves within a window; moves between windows are onDetached then onAttached. */
  readonly onMoved: Stream.Stream<MovedEvent, ChromeTabsError>
  readonly onReplaced: Stream.Stream<ReplacedEvent, ChromeTabsError>
  readonly onAttached: Stream.Stream<AttachedEvent, ChromeTabsError>
  readonly onDetached: Stream.Stream<DetachedEvent, ChromeTabsError>
  /** The highlighted (selected) tabs of a window changed. */
  readonly onHighlighted: Stream.Stream<chrome.tabs.OnHighlightedInfo, ChromeTabsError>
  readonly onZoomChange: Stream.Stream<chrome.tabs.OnZoomChangeInfo, ChromeTabsError>
}

export class ChromeTabs extends Context.Service<ChromeTabs, ChromeTabsService>()("effect-platform-chrome/ChromeTabs") {}

const invoke = invoker((operation, cause) => new ChromeTabsError({ operation, cause }))

const tabEvents = <Args extends Array<unknown>, A>(
  operation: string,
  getSource: () => EventSource<Args>,
  project: (...args: Args) => A
): Stream.Stream<A, ChromeTabsError> => observe(getSource, project, (cause) => new ChromeTabsError({ operation, cause }))

/** Calls a Chrome method whose only argument is an optional tab id, omitting it when absent. */
const withOptionalTab = <A>(operation: string, call: (...tabId: [] | [number]) => Promise<A>) =>
  (tabId?: number): Effect.Effect<A, ChromeTabsError> =>
    invoke(operation, () => tabId === undefined ? call() : call(tabId))

/**
 * Each stream consumption owns a listener, removed when its scope closes (including
 * interruption). Buffers hold at most 64 pending events and discard the oldest on
 * overflow: Chrome callbacks cannot be backpressured. These are observational
 * subscriptions, not synchronous top-level MV3 service-worker wake registrations.
 */
export const make = (api: ChromeTabsApi): ChromeTabsService => ChromeTabs.of({
  query: (queryInfo) => invoke("query", () => api.query(queryInfo)),
  get: (tabId) => invoke("get", () => api.get(tabId)),
  create: (properties) => invoke("create", () => api.create(properties)),
  duplicate: (tabId) => invoke("duplicate", () => api.duplicate(tabId)).pipe(Effect.map(Option.fromNullishOr)),
  update: (tabId, properties) => invoke("update", () => api.update(tabId, properties)),
  move: (tabIds, moveProperties) => invoke("move", () => api.move(tabIds, moveProperties)).pipe(
    Effect.map((moved) => Array.isArray(moved) ? moved : [moved])
  ),
  reload: (tabId, reloadProperties) => invoke("reload", () => {
    if (reloadProperties !== undefined) return api.reload(tabId, reloadProperties)

    return tabId === undefined ? api.reload() : api.reload(tabId)
  }),
  remove: (tabIds) => invoke("remove", () => api.remove(tabIds)),
  group: (options) => invoke("group", () => api.group(options)),
  ungroup: (tabIds) => invoke("ungroup", () => api.ungroup(tabIds)),
  discard: (tabId) => withOptionalTab("discard", (...args) => api.discard(...args))(tabId).pipe(
    Effect.map(Option.fromNullishOr)
  ),
  goBack: withOptionalTab("goBack", (...args) => api.goBack(...args)),
  goForward: withOptionalTab("goForward", (...args) => api.goForward(...args)),
  getZoom: withOptionalTab("getZoom", (...args) => api.getZoom(...args)),
  setZoom: (tabId, zoomFactor) => invoke("setZoom", () => api.setZoom(tabId, zoomFactor)),
  getZoomSettings: withOptionalTab("getZoomSettings", (...args) => api.getZoomSettings(...args)),
  setZoomSettings: (tabId, zoomSettings) => invoke("setZoomSettings", () => api.setZoomSettings(tabId, zoomSettings)),
  detectLanguage: withOptionalTab("detectLanguage", (...args) => api.detectLanguage(...args)),
  sendMessage: (tabId, message, options) => invoke("sendMessage", () => options === undefined
    ? api.sendMessage(tabId, message)
    : api.sendMessage(tabId, message, options)),
  connect: (tabId, connectInfo) => Effect.try({
    try: () => connectInfo === undefined ? api.connect(tabId) : api.connect(tabId, connectInfo),
    catch: (cause) => new ChromeTabsError({ operation: "connect", cause })
  }),
  captureVisibleTab: (windowId, options = {}) => invoke("captureVisibleTab", () => api.captureVisibleTab(windowId, options)),
  onCreated: tabEvents("onCreated", () => api.onCreated, (tab) => tab),
  onUpdated: tabEvents("onUpdated", () => api.onUpdated, (tabId, changeInfo, tab) => ({ tabId, changeInfo, tab })),
  onRemoved: tabEvents("onRemoved", () => api.onRemoved, (tabId, removeInfo) => ({ tabId, removeInfo })),
  onActivated: tabEvents("onActivated", () => api.onActivated, (info) => info),
  onMoved: tabEvents("onMoved", () => api.onMoved, (tabId, moveInfo) => ({ tabId, moveInfo })),
  onReplaced: tabEvents("onReplaced", () => api.onReplaced, (addedTabId, removedTabId) => ({ addedTabId, removedTabId })),
  onAttached: tabEvents("onAttached", () => api.onAttached, (tabId, attachInfo) => ({ tabId, attachInfo })),
  onDetached: tabEvents("onDetached", () => api.onDetached, (tabId, detachInfo) => ({ tabId, detachInfo })),
  onHighlighted: tabEvents("onHighlighted", () => api.onHighlighted, (info) => info),
  onZoomChange: tabEvents("onZoomChange", () => api.onZoomChange, (info) => info)
})

export const layer = (api: ChromeTabsApi): Layer.Layer<ChromeTabs> => Layer.succeed(ChromeTabs, make(api))

/** Chrome is accessed only when the layer is built, never when this module is imported. */
export const layerLive: Layer.Layer<ChromeTabs, ChromeTabsError> = liveLayer(
  ChromeTabs, "tabs", (chrome) => chrome.tabs, make,
  (cause) => new ChromeTabsError({ operation: "initialize", cause })
)
