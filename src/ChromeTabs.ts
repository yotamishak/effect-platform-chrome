import { Context, Effect, Layer, Queue, Schema, Stream } from "effect"

export class ChromeTabsError extends Schema.TaggedError<ChromeTabsError>()("ChromeTabsError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** The promise-based MV3 API surface required by this module. */
export interface ChromeTabsApi {
  query(queryInfo: chrome.tabs.QueryInfo): Promise<Array<chrome.tabs.Tab>>
  get(tabId: number): Promise<chrome.tabs.Tab>
  create(properties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab>
  update(tabId: number | undefined, properties: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab | undefined>
  remove(tabIds: number | Array<number>): Promise<void>
  sendMessage(tabId: number, message: unknown, options?: chrome.tabs.MessageSendOptions): Promise<unknown>
  connect(tabId: number, connectInfo?: chrome.tabs.ConnectInfo): chrome.runtime.Port
  captureVisibleTab(windowId: number, options: chrome.extensionTypes.ImageDetails): Promise<string>
  readonly onCreated: Pick<typeof chrome.tabs.onCreated, "addListener" | "removeListener">
  readonly onUpdated: Pick<typeof chrome.tabs.onUpdated, "addListener" | "removeListener">
  readonly onRemoved: Pick<typeof chrome.tabs.onRemoved, "addListener" | "removeListener">
  readonly onActivated: Pick<typeof chrome.tabs.onActivated, "addListener" | "removeListener">
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

export interface ChromeTabsService {
  readonly query: (queryInfo: chrome.tabs.QueryInfo) => Effect.Effect<Array<chrome.tabs.Tab>, ChromeTabsError>
  readonly get: (tabId: number) => Effect.Effect<chrome.tabs.Tab, ChromeTabsError>
  readonly create: (properties: chrome.tabs.CreateProperties) => Effect.Effect<chrome.tabs.Tab, ChromeTabsError>
  /** Pass undefined to update the selected tab in the current window. */
  readonly update: (tabId: number | undefined, properties: chrome.tabs.UpdateProperties) => Effect.Effect<chrome.tabs.Tab | undefined, ChromeTabsError>
  readonly remove: (tabIds: number | Array<number>) => Effect.Effect<void, ChromeTabsError>
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
}

export class ChromeTabs extends Context.Service<ChromeTabs, ChromeTabsService>()("effect-platform-chrome/ChromeTabs") {}

const invoke = <A>(operation: string, run: () => Promise<A>): Effect.Effect<A, ChromeTabsError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ChromeTabsError({ operation, cause })
  })

interface EventSource<Args extends Array<unknown>> {
  addListener(listener: (...args: Args) => void): void
  removeListener(listener: (...args: Args) => void): void
}

const observe = <Args extends Array<unknown>, A>(
  operation: string,
  source: EventSource<Args>,
  project: (...args: Args) => A
): Stream.Stream<A, ChromeTabsError> => Stream.callback<A, ChromeTabsError>((queue) => {
  const listener = (...args: Args) => { Queue.offerUnsafe(queue, project(...args)) }

  return Effect.gen(function*() {
    // Install cleanup before registration, which may partially succeed then throw.
    yield* Effect.acquireRelease(
      Effect.succeed(listener),
      () => Effect.sync(() => source.removeListener(listener))
    )
    yield* Effect.try({
      try: () => source.addListener(listener),
      catch: (cause) => new ChromeTabsError({ operation, cause })
    })
  })
}, { bufferSize: 64, strategy: "sliding" })

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
  update: (tabId, properties) => invoke("update", () => api.update(tabId, properties)),
  remove: (tabIds) => invoke("remove", () => api.remove(tabIds)),
  sendMessage: (tabId, message, options) => invoke("sendMessage", () => options === undefined
    ? api.sendMessage(tabId, message)
    : api.sendMessage(tabId, message, options)),
  connect: (tabId, connectInfo) => Effect.try({
    try: () => connectInfo === undefined ? api.connect(tabId) : api.connect(tabId, connectInfo),
    catch: (cause) => new ChromeTabsError({ operation: "connect", cause })
  }),
  captureVisibleTab: (windowId, options = {}) => invoke("captureVisibleTab", () => api.captureVisibleTab(windowId, options)),
  onCreated: observe("onCreated", api.onCreated, (tab) => tab),
  onUpdated: observe("onUpdated", api.onUpdated, (tabId, changeInfo, tab) => ({ tabId, changeInfo, tab })),
  onRemoved: observe("onRemoved", api.onRemoved, (tabId, removeInfo) => ({ tabId, removeInfo })),
  onActivated: observe("onActivated", api.onActivated, (info) => info)
})

export const layer = (api: ChromeTabsApi): Layer.Layer<ChromeTabs> => Layer.succeed(ChromeTabs, make(api))

/** Chrome is accessed only when the layer is built, never when this module is imported. */
export const layerLive: Layer.Layer<ChromeTabs, ChromeTabsError> = Layer.effect(ChromeTabs, Effect.try({
  try: () => {
    if (typeof chrome === "undefined" || chrome.tabs === undefined) {
      throw new Error("chrome.tabs is unavailable in this context")
    }

    return make(chrome.tabs)
  },
  catch: (cause) => new ChromeTabsError({ operation: "initialize", cause })
}))
