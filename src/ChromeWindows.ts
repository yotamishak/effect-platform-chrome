import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeWindowsError extends Schema.TaggedError<ChromeWindowsError>()("ChromeWindowsError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

export type WindowType = `${chrome.windows.WindowType}`

/**
 * Restricts window events to these window types. Without one, Chrome reports normal, popup,
 * app and panel windows, the last two only when the extension owns them.
 */
export interface WindowEventFilter {
  windowTypes: Array<WindowType>
}

/** A windows event whose `addListener` accepts an optional window-type filter. */
export interface FilteredWindowEvent<Args extends ReadonlyArray<unknown>> {
  addListener(listener: (...args: Args) => void, filter?: WindowEventFilter): void
  removeListener(listener: (...args: Args) => void): void
}

/** The Promise-based MV3 subset this module needs. */
export interface ChromeWindowsApi {
  get(windowId: number, queryOptions?: chrome.windows.QueryOptions): Promise<chrome.windows.Window>
  getCurrent(queryOptions?: chrome.windows.QueryOptions): Promise<chrome.windows.Window>
  getLastFocused(queryOptions?: chrome.windows.QueryOptions): Promise<chrome.windows.Window>
  getAll(queryOptions?: chrome.windows.QueryOptions): Promise<Array<chrome.windows.Window>>
  create(createData?: chrome.windows.CreateData): Promise<chrome.windows.Window | undefined>
  update(windowId: number, updateInfo: chrome.windows.UpdateInfo): Promise<chrome.windows.Window>
  remove(windowId: number): Promise<void>
  readonly onCreated: FilteredWindowEvent<[window: chrome.windows.Window]>
  readonly onRemoved: FilteredWindowEvent<[windowId: number]>
  readonly onFocusChanged: FilteredWindowEvent<[windowId: number]>
  readonly onBoundsChanged: EventSource<[window: chrome.windows.Window]>
}

export interface ChromeWindowsService {
  readonly get: (windowId: number, queryOptions?: chrome.windows.QueryOptions) => Effect.Effect<chrome.windows.Window, ChromeWindowsError>
  /** The window of the calling context; in a service worker, the last focused window. */
  readonly getCurrent: (queryOptions?: chrome.windows.QueryOptions) => Effect.Effect<chrome.windows.Window, ChromeWindowsError>
  /** The most recently focused window, normal or popup unless `windowTypes` says otherwise. */
  readonly getLastFocused: (queryOptions?: chrome.windows.QueryOptions) => Effect.Effect<chrome.windows.Window, ChromeWindowsError>
  /** Every window, normal or popup unless `windowTypes` says otherwise. */
  readonly getAll: (queryOptions?: chrome.windows.QueryOptions) => Effect.Effect<Array<chrome.windows.Window>, ChromeWindowsError>
  /** Opens a window; None when Chrome reports no window, as when incognito is not allowed. */
  readonly create: (createData?: chrome.windows.CreateData) => Effect.Effect<Option.Option<chrome.windows.Window>, ChromeWindowsError>
  readonly update: (windowId: number, updateInfo: chrome.windows.UpdateInfo) => Effect.Effect<chrome.windows.Window, ChromeWindowsError>
  /** Brings a window to the front. */
  readonly focus: (windowId: number) => Effect.Effect<chrome.windows.Window, ChromeWindowsError>
  /** Closes a window and its tabs. */
  readonly remove: (windowId: number) => Effect.Effect<void, ChromeWindowsError>
  /**
   * Observational subscriptions that cannot wake an MV3 service worker; register wake
   * listeners through ChromeServiceWorker. Each buffers at most 64 events, dropping the
   * oldest. The filtered streams pass `filter` to Chrome only when one is given.
   */
  readonly onCreated: (filter?: WindowEventFilter) => Stream.Stream<chrome.windows.Window, ChromeWindowsError>
  /** Ids of closed windows. */
  readonly onRemoved: (filter?: WindowEventFilter) => Stream.Stream<number, ChromeWindowsError>
  /** Ids of newly focused windows; -1 (`WINDOW_ID_NONE`) when Chrome loses focus. */
  readonly onFocusChanged: (filter?: WindowEventFilter) => Stream.Stream<number, ChromeWindowsError>
  /** Windows whose position or size finished changing. */
  readonly onBoundsChanged: Stream.Stream<chrome.windows.Window, ChromeWindowsError>
}

export class ChromeWindows extends Context.Service<ChromeWindows, ChromeWindowsService>()("effect-platform-chrome/ChromeWindows") {}

const invoke = invoker((operation, cause) => new ChromeWindowsError({ operation, cause }))

/** Calls a Chrome method whose only argument is optional, omitting it when absent. */
const withOptional = <I, A>(operation: string, call: (...input: [] | [I]) => Promise<A>) =>
  (input?: I): Effect.Effect<A, ChromeWindowsError> =>
    invoke(operation, () => input === undefined ? call() : call(input))

/** Binds an optional filter, so Chrome never receives an explicit undefined. */
const filtered = <Args extends ReadonlyArray<unknown>>(
  event: FilteredWindowEvent<Args>,
  filter: WindowEventFilter | undefined
): EventSource<Args> => filter === undefined ? event : {
  addListener: (listener) => event.addListener(listener, filter),
  removeListener: (listener) => event.removeListener(listener)
}

const windowEvents = <Args extends ReadonlyArray<unknown>, A>(
  operation: string,
  getSource: () => EventSource<Args>,
  project: (...args: Args) => A
): Stream.Stream<A, ChromeWindowsError> => observe(getSource, project, (cause) => new ChromeWindowsError({ operation, cause }))

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeWindowsApi): ChromeWindowsService => {
  const update = (windowId: number, updateInfo: chrome.windows.UpdateInfo) =>
    invoke("update", () => api.update(windowId, updateInfo))

  return ChromeWindows.of({
    get: (windowId, queryOptions) => invoke("get", () => queryOptions === undefined
      ? api.get(windowId)
      : api.get(windowId, queryOptions)),
    getCurrent: withOptional("getCurrent", (...args) => api.getCurrent(...args)),
    getLastFocused: withOptional("getLastFocused", (...args) => api.getLastFocused(...args)),
    getAll: withOptional("getAll", (...args) => api.getAll(...args)),
    create: (createData) => withOptional("create", (...args: [] | [chrome.windows.CreateData]) => api.create(...args))(createData).pipe(
      Effect.map(Option.fromNullishOr)
    ),
    update,
    focus: (windowId) => update(windowId, { focused: true }),
    remove: (windowId) => invoke("remove", () => api.remove(windowId)),
    onCreated: (filter) => windowEvents("onCreated", () => filtered(api.onCreated, filter), (window) => window),
    onRemoved: (filter) => windowEvents("onRemoved", () => filtered(api.onRemoved, filter), (windowId) => windowId),
    onFocusChanged: (filter) => windowEvents("onFocusChanged", () => filtered(api.onFocusChanged, filter), (windowId) => windowId),
    onBoundsChanged: windowEvents("onBoundsChanged", () => api.onBoundsChanged, (window) => window)
  })
}

export const layer = (api: ChromeWindowsApi): Layer.Layer<ChromeWindows> => Layer.succeed(ChromeWindows, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeWindows, ChromeWindowsError> = liveLayer(
  ChromeWindows, "windows", (chrome) => chrome.windows, make,
  (cause) => new ChromeWindowsError({ operation: "initialize", cause })
)
