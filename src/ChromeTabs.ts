import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { attempter, invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeTabsError extends Schema.TaggedError<ChromeTabsError>()("ChromeTabsError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/**
 * The Promise-based MV3 subset this module needs. Members whose leading tab or window id
 * Chrome lets callers leave out are overloaded as Chrome declares them, so an absent id is
 * omitted rather than sent as an explicit `undefined`. `createSplit` and `unsplit` are
 * Chrome 155+; they are optional so older browsers and injected APIs without them still fit,
 * and calling one that is absent fails with the typed error.
 */
export interface ChromeTabsApi {
  get(tabId: number): Promise<chrome.tabs.Tab>
  getCurrent(): Promise<chrome.tabs.Tab | undefined>
  query(queryInfo: chrome.tabs.QueryInfo): Promise<Array<chrome.tabs.Tab>>
  create(createProperties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab>
  duplicate(tabId: number): Promise<chrome.tabs.Tab | undefined>
  update(updateProperties: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab | undefined>
  update(tabId: number, updateProperties: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab | undefined>
  /** Chrome resolves one tab when exactly one tab moved, even for a one-element array. */
  move(tabIds: number | Array<number>, moveProperties: chrome.tabs.MoveProperties): Promise<chrome.tabs.Tab | Array<chrome.tabs.Tab>>
  reload(): Promise<void>
  reload(tabId: number): Promise<void>
  reload(reloadProperties: chrome.tabs.ReloadProperties): Promise<void>
  reload(tabId: number, reloadProperties: chrome.tabs.ReloadProperties): Promise<void>
  remove(tabIds: number | Array<number>): Promise<void>
  highlight(highlightInfo: chrome.tabs.HighlightInfo): Promise<chrome.windows.Window>
  group(options: chrome.tabs.GroupOptions): Promise<number>
  ungroup(tabIds: number | [number, ...Array<number>]): Promise<void>
  readonly createSplit?: (tabIds: [number, number]) => Promise<number>
  readonly unsplit?: (splitViewId: number) => Promise<void>
  discard(tabId?: number): Promise<chrome.tabs.Tab | undefined>
  goBack(tabId?: number): Promise<void>
  goForward(tabId?: number): Promise<void>
  getZoom(tabId?: number): Promise<number>
  setZoom(zoomFactor: number): Promise<void>
  setZoom(tabId: number, zoomFactor: number): Promise<void>
  getZoomSettings(tabId?: number): Promise<chrome.tabs.ZoomSettings>
  setZoomSettings(zoomSettings: chrome.tabs.ZoomSettings): Promise<void>
  setZoomSettings(tabId: number, zoomSettings: chrome.tabs.ZoomSettings): Promise<void>
  detectLanguage(tabId?: number): Promise<string>
  sendMessage(tabId: number, message: unknown, options?: chrome.tabs.MessageSendOptions): Promise<unknown>
  connect(tabId: number, connectInfo?: chrome.tabs.ConnectInfo): chrome.runtime.Port
  captureVisibleTab(): Promise<string>
  captureVisibleTab(windowId: number): Promise<string>
  captureVisibleTab(options: chrome.extensionTypes.ImageDetails): Promise<string>
  captureVisibleTab(windowId: number, options: chrome.extensionTypes.ImageDetails): Promise<string>
  readonly onCreated: EventSource<[tab: chrome.tabs.Tab]>
  readonly onUpdated: EventSource<[tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab]>
  readonly onRemoved: EventSource<[tabId: number, removeInfo: chrome.tabs.OnRemovedInfo]>
  readonly onActivated: EventSource<[activeInfo: chrome.tabs.OnActivatedInfo]>
  readonly onMoved: EventSource<[tabId: number, moveInfo: chrome.tabs.OnMovedInfo]>
  readonly onReplaced: EventSource<[addedTabId: number, removedTabId: number]>
  readonly onAttached: EventSource<[tabId: number, attachInfo: chrome.tabs.OnAttachedInfo]>
  readonly onDetached: EventSource<[tabId: number, detachInfo: chrome.tabs.OnDetachedInfo]>
  readonly onHighlighted: EventSource<[highlightInfo: chrome.tabs.OnHighlightedInfo]>
  readonly onZoomChange: EventSource<[zoomChangeInfo: chrome.tabs.OnZoomChangeInfo]>
}

/** A tab changed; `changeInfo` holds only the fields that changed. */
export interface UpdatedEvent {
  readonly tabId: number
  readonly changeInfo: chrome.tabs.OnUpdatedInfo
  readonly tab: chrome.tabs.Tab
}

/** A tab closed; `isWindowClosing` when its whole window closed. */
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
  /** Fails when no tab has this id. */
  readonly get: (tabId: number) => Effect.Effect<chrome.tabs.Tab, ChromeTabsError>
  /**
   * The tab this code runs in. None outside a tab, as in a service worker, a popup or
   * another extension view that is not a tab.
   */
  readonly getCurrent: Effect.Effect<Option.Option<chrome.tabs.Tab>, ChromeTabsError>
  /**
   * Tabs matching every given property, or all tabs for `{}`. `url` and `title` take match
   * patterns and are ignored without the `tabs` permission or host access to the page.
   */
  readonly query: (queryInfo: chrome.tabs.QueryInfo) => Effect.Effect<Array<chrome.tabs.Tab>, ChromeTabsError>
  /** Opens a tab, by default active, at the end of the current window. */
  readonly create: (createProperties: chrome.tabs.CreateProperties) => Effect.Effect<chrome.tabs.Tab, ChromeTabsError>
  /** The copy, when Chrome reports one; without the `tabs` permission it lacks url and title. */
  readonly duplicate: (tabId: number) => Effect.Effect<Option.Option<chrome.tabs.Tab>, ChromeTabsError>
  /**
   * Changes only the given properties. Pass undefined for the selected tab of the current
   * window, which is then omitted from the native call. None when Chrome reports no tab;
   * without the `tabs` permission or host access the tab lacks url and title.
   */
  readonly update: (
    tabId: number | undefined,
    updateProperties: chrome.tabs.UpdateProperties
  ) => Effect.Effect<Option.Option<chrome.tabs.Tab>, ChromeTabsError>
  /**
   * Moves tabs to `index` (-1 for the end), optionally into another window. Always yields
   * the moved tabs as an array, even for a single id. Only normal windows accept tabs, and
   * Chrome rejects an empty list.
   */
  readonly move: (tabIds: number | Array<number>, moveProperties: chrome.tabs.MoveProperties) => Effect.Effect<Array<chrome.tabs.Tab>, ChromeTabsError>
  /** Reloads a tab, by default the selected tab of the current window. */
  readonly reload: (tabId?: number, reloadProperties?: chrome.tabs.ReloadProperties) => Effect.Effect<void, ChromeTabsError>
  /** Closes one or more tabs. */
  readonly remove: (tabIds: number | Array<number>) => Effect.Effect<void, ChromeTabsError>
  /**
   * Highlights the tabs at the given indices (not ids) of a window, by default the current
   * one, focusing the first; yields that window. Fails when an index has no tab.
   */
  readonly highlight: (highlightInfo: chrome.tabs.HighlightInfo) => Effect.Effect<chrome.windows.Window, ChromeTabsError>
  /**
   * Adds tabs to a group (`groupId`) or to a new group, created in `createProperties.windowId`
   * or the current window, and yields the group's id. `tabIds` is required by Chrome.
   */
  readonly group: (options: chrome.tabs.GroupOptions) => Effect.Effect<number, ChromeTabsError>
  /** Removes tabs from their groups; emptied groups are deleted. */
  readonly ungroup: (tabIds: number | [number, ...Array<number>]) => Effect.Effect<void, ChromeTabsError>
  /**
   * Chrome 155+: pairs two adjacent tabs of one window, with matching pinned and group
   * states, into a Split View and yields its id. Fails with the typed error where Chrome
   * lacks it.
   */
  readonly createSplit: (tabIds: [number, number]) => Effect.Effect<number, ChromeTabsError>
  /** Chrome 155+: separates a Split View back into independent tabs. */
  readonly unsplit: (splitViewId: number) => Effect.Effect<void, ChromeTabsError>
  /**
   * Unloads a tab from memory while keeping it in the strip; without an id Chrome picks the
   * least important tab. Fails when the tab is active or nothing could be discarded; None
   * when Chrome reports no tab.
   */
  readonly discard: (tabId?: number) => Effect.Effect<Option.Option<chrome.tabs.Tab>, ChromeTabsError>
  /** Fails when the tab has no previous page. Defaults to the selected tab of the current window. */
  readonly goBack: (tabId?: number) => Effect.Effect<void, ChromeTabsError>
  /** Fails when the tab has no next page. Defaults to the selected tab of the current window. */
  readonly goForward: (tabId?: number) => Effect.Effect<void, ChromeTabsError>
  /** The current zoom factor; defaults to the active tab of the current window. */
  readonly getZoom: (tabId?: number) => Effect.Effect<number, ChromeTabsError>
  /**
   * Pass undefined for the active tab of the current window (omitted from the native call);
   * a factor of 0 resets the tab to its default factor.
   */
  readonly setZoom: (tabId: number | undefined, zoomFactor: number) => Effect.Effect<void, ChromeTabsError>
  /** How zoom is handled in a tab, including its `defaultZoomFactor`. */
  readonly getZoomSettings: (tabId?: number) => Effect.Effect<chrome.tabs.ZoomSettings, ChromeTabsError>
  /**
   * Pass undefined for the active tab of the current window (omitted from the native call).
   * The settings reset when the tab navigates.
   */
  readonly setZoomSettings: (tabId: number | undefined, zoomSettings: chrome.tabs.ZoomSettings) => Effect.Effect<void, ChromeTabsError>
  /** An ISO language code such as `en` or `fr`, or `und` when unknown. */
  readonly detectLanguage: (tabId?: number) => Effect.Effect<string, ChromeTabsError>
  /**
   * Sends one message to the tab's content scripts (one frame or document with `options`)
   * and yields the raw, undecoded response. Fails when no receiver exists.
   */
  readonly sendMessage: (tabId: number, message: unknown, options?: chrome.tabs.MessageSendOptions) => Effect.Effect<unknown, ChromeTabsError>
  /**
   * Opens a port to the content scripts of a tab (one frame with `frameId`, or one document
   * with `documentId`). The native port is returned unwrapped, for
   * ChromeRpc.makeClientProtocol or ChromePort.adopt; the caller owns it. A tab with no
   * listener disconnects the port at once, with `lastError` set.
   */
  readonly connect: (tabId: number, connectInfo?: chrome.tabs.ConnectInfo) => Effect.Effect<chrome.runtime.Port, ChromeTabsError>
  /**
   * A data URL of the visible area of a window's active tab, by default the current window's,
   * JPEG unless `options` says otherwise. Needs `<all_urls>` or an activeTab grant; Chrome
   * allows `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` (2) calls per second.
   */
  readonly captureVisibleTab: (windowId?: number, options?: chrome.extensionTypes.ImageDetails) => Effect.Effect<string, ChromeTabsError>
  /**
   * Observational subscriptions that cannot wake an MV3 service worker; register wake
   * listeners through ChromeServiceWorker. Each consumption owns one listener, removed when
   * its scope closes, and buffers at most 64 events, dropping the oldest. A created tab may
   * not have its url or group yet; onUpdated reports them.
   */
  readonly onCreated: Stream.Stream<chrome.tabs.Tab, ChromeTabsError>
  readonly onUpdated: Stream.Stream<UpdatedEvent, ChromeTabsError>
  readonly onRemoved: Stream.Stream<RemovedEvent, ChromeTabsError>
  /** The active tab of a window changed; its url may not be set yet. */
  readonly onActivated: Stream.Stream<chrome.tabs.OnActivatedInfo, ChromeTabsError>
  /** Only the directly moved tab, within a window; moves between windows are onDetached then onAttached. */
  readonly onMoved: Stream.Stream<MovedEvent, ChromeTabsError>
  readonly onReplaced: Stream.Stream<ReplacedEvent, ChromeTabsError>
  readonly onAttached: Stream.Stream<AttachedEvent, ChromeTabsError>
  readonly onDetached: Stream.Stream<DetachedEvent, ChromeTabsError>
  /** The highlighted (selected) tabs of a window changed. */
  readonly onHighlighted: Stream.Stream<chrome.tabs.OnHighlightedInfo, ChromeTabsError>
  readonly onZoomChange: Stream.Stream<chrome.tabs.OnZoomChangeInfo, ChromeTabsError>
}

export class ChromeTabs extends Context.Service<ChromeTabs, ChromeTabsService>()("effect-platform-chrome/ChromeTabs") {}

const toError = (operation: string, cause: unknown) => new ChromeTabsError({ operation, cause })

const invoke = invoker(toError)

const attempt = attempter(toError)

const unavailable = (operation: string) => new Error(`tabs.${operation} is unavailable`)

const tabEvents = <Args extends ReadonlyArray<unknown>, A>(
  operation: string,
  getSource: () => EventSource<Args>,
  project: (...args: Args) => A
): Stream.Stream<A, ChromeTabsError> => observe(getSource, project, (cause) => toError(operation, cause))

/** Calls a Chrome method whose only argument is an optional tab id, omitting it when absent. */
const withOptionalTab = <A>(operation: string, call: (...tabId: [] | [number]) => Promise<A>) =>
  (tabId?: number): Effect.Effect<A, ChromeTabsError> =>
    invoke(operation, () => tabId === undefined ? call() : call(tabId))

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeTabsApi): ChromeTabsService => ChromeTabs.of({
  get: (tabId) => invoke("get", () => api.get(tabId)),
  getCurrent: invoke("getCurrent", () => api.getCurrent()).pipe(Effect.map(Option.fromNullishOr)),
  query: (queryInfo) => invoke("query", () => api.query(queryInfo)),
  create: (createProperties) => invoke("create", () => api.create(createProperties)),
  duplicate: (tabId) => invoke("duplicate", () => api.duplicate(tabId)).pipe(Effect.map(Option.fromNullishOr)),
  update: (tabId, updateProperties) => invoke("update", () => tabId === undefined
    ? api.update(updateProperties)
    : api.update(tabId, updateProperties)).pipe(Effect.map(Option.fromNullishOr)),
  move: (tabIds, moveProperties) => invoke("move", () => api.move(tabIds, moveProperties)).pipe(
    Effect.map((moved) => Array.isArray(moved) ? moved : [moved])
  ),
  reload: (tabId, reloadProperties) => invoke("reload", () => {
    if (tabId === undefined) return reloadProperties === undefined ? api.reload() : api.reload(reloadProperties)

    return reloadProperties === undefined ? api.reload(tabId) : api.reload(tabId, reloadProperties)
  }),
  remove: (tabIds) => invoke("remove", () => api.remove(tabIds)),
  highlight: (highlightInfo) => invoke("highlight", () => api.highlight(highlightInfo)),
  group: (options) => invoke("group", () => api.group(options)),
  ungroup: (tabIds) => invoke("ungroup", () => api.ungroup(tabIds)),
  createSplit: (tabIds) => invoke("createSplit", () => api.createSplit === undefined
    ? Promise.reject(unavailable("createSplit"))
    : api.createSplit(tabIds)),
  unsplit: (splitViewId) => invoke("unsplit", () => api.unsplit === undefined
    ? Promise.reject(unavailable("unsplit"))
    : api.unsplit(splitViewId)),
  discard: (tabId) => withOptionalTab("discard", (...args) => api.discard(...args))(tabId).pipe(
    Effect.map(Option.fromNullishOr)
  ),
  goBack: withOptionalTab("goBack", (...args) => api.goBack(...args)),
  goForward: withOptionalTab("goForward", (...args) => api.goForward(...args)),
  getZoom: withOptionalTab("getZoom", (...args) => api.getZoom(...args)),
  setZoom: (tabId, zoomFactor) => invoke("setZoom", () => tabId === undefined
    ? api.setZoom(zoomFactor)
    : api.setZoom(tabId, zoomFactor)),
  getZoomSettings: withOptionalTab("getZoomSettings", (...args) => api.getZoomSettings(...args)),
  setZoomSettings: (tabId, zoomSettings) => invoke("setZoomSettings", () => tabId === undefined
    ? api.setZoomSettings(zoomSettings)
    : api.setZoomSettings(tabId, zoomSettings)),
  detectLanguage: withOptionalTab("detectLanguage", (...args) => api.detectLanguage(...args)),
  sendMessage: (tabId, message, options) => invoke("sendMessage", () => options === undefined
    ? api.sendMessage(tabId, message)
    : api.sendMessage(tabId, message, options)),
  connect: (tabId, connectInfo) => attempt("connect", () => connectInfo === undefined
    ? api.connect(tabId)
    : api.connect(tabId, connectInfo)),
  captureVisibleTab: (windowId, options) => invoke("captureVisibleTab", () => {
    if (windowId === undefined) return options === undefined ? api.captureVisibleTab() : api.captureVisibleTab(options)

    return options === undefined ? api.captureVisibleTab(windowId) : api.captureVisibleTab(windowId, options)
  }),
  onCreated: tabEvents("onCreated", () => api.onCreated, (tab) => tab),
  onUpdated: tabEvents("onUpdated", () => api.onUpdated, (tabId, changeInfo, tab) => ({ tabId, changeInfo, tab })),
  onRemoved: tabEvents("onRemoved", () => api.onRemoved, (tabId, removeInfo) => ({ tabId, removeInfo })),
  onActivated: tabEvents("onActivated", () => api.onActivated, (activeInfo) => activeInfo),
  onMoved: tabEvents("onMoved", () => api.onMoved, (tabId, moveInfo) => ({ tabId, moveInfo })),
  onReplaced: tabEvents("onReplaced", () => api.onReplaced, (addedTabId, removedTabId) => ({ addedTabId, removedTabId })),
  onAttached: tabEvents("onAttached", () => api.onAttached, (tabId, attachInfo) => ({ tabId, attachInfo })),
  onDetached: tabEvents("onDetached", () => api.onDetached, (tabId, detachInfo) => ({ tabId, detachInfo })),
  onHighlighted: tabEvents("onHighlighted", () => api.onHighlighted, (highlightInfo) => highlightInfo),
  onZoomChange: tabEvents("onZoomChange", () => api.onZoomChange, (zoomChangeInfo) => zoomChangeInfo)
})

export const layer = (api: ChromeTabsApi): Layer.Layer<ChromeTabs> => Layer.succeed(ChromeTabs, make(api))

/** Chrome is accessed only when the layer is built, never when this module is imported. */
export const layerLive: Layer.Layer<ChromeTabs, ChromeTabsError> = liveLayer(
  ChromeTabs, "tabs", (chrome) => chrome.tabs, make,
  (cause) => new ChromeTabsError({ operation: "initialize", cause })
)
