import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeWindowsError extends Schema.TaggedError<ChromeWindowsError>()("ChromeWindowsError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

export type WindowType = `${chrome.windows.WindowType}`

export type WindowState = `${chrome.windows.WindowState}`

/** `chrome.windows.WINDOW_ID_NONE`: no Chrome window, as reported when Chrome loses focus. */
export const WINDOW_ID_NONE = -1

/** `chrome.windows.WINDOW_ID_CURRENT`: addresses the current window wherever a window id is taken. */
export const WINDOW_ID_CURRENT = -2

/**
 * Restricts window events to these window types; an empty list matches no window. Without a
 * filter Chrome reports normal and popup windows, plus app and panel windows the extension
 * owns, but never devtools windows.
 */
export interface WindowEventFilter {
  readonly windowTypes: ReadonlyArray<WindowType>
}

/** A windows event whose `addListener` accepts an optional window-type filter. */
export interface FilteredWindowEvent<Args extends ReadonlyArray<unknown>> {
  addListener(listener: (...args: Args) => void, filter?: WindowEventFilter): void
  removeListener(listener: (...args: Args) => void): void
}

/** The Promise-based MV3 subset this module needs: every `chrome.windows` method and event. */
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

/**
 * The Effect API over `chrome.windows`. Every window id accepts `WINDOW_ID_CURRENT`. Queries
 * without `windowTypes` see normal and popup windows only, and windows of incognito profiles
 * only when the extension may run in incognito.
 */
export interface ChromeWindowsService {
  /** The window with this id; fails when it does not exist or `windowTypes` excludes it. */
  readonly get: (windowId: number, queryOptions?: chrome.windows.QueryOptions) => Effect.Effect<chrome.windows.Window, ChromeWindowsError>
  /**
   * The window containing the calling code, which need not be the focused one; a service
   * worker has none and gets the last active window instead.
   */
  readonly getCurrent: (queryOptions?: chrome.windows.QueryOptions) => Effect.Effect<chrome.windows.Window, ChromeWindowsError>
  /** The most recently focused window; fails when no window matches. */
  readonly getLastFocused: (queryOptions?: chrome.windows.QueryOptions) => Effect.Effect<chrome.windows.Window, ChromeWindowsError>
  /** Every matching window; an empty list when none does. */
  readonly getAll: (queryOptions?: chrome.windows.QueryOptions) => Effect.Effect<Array<chrome.windows.Window>, ChromeWindowsError>
  /**
   * Opens a window, focused unless `focused: false`. None when Chrome hides the result: an
   * incognito window opened by an extension not allowed in incognito. The `minimized`,
   * `maximized` and `fullscreen` states cannot be combined with bounds, `minimized` not with
   * `focused: true`, and the other two not with `focused: false`; `setSelfAsOpener` fails in
   * a service worker.
   */
  readonly create: (createData?: chrome.windows.CreateData) => Effect.Effect<Option.Option<chrome.windows.Window>, ChromeWindowsError>
  /**
   * Changes only the given properties. A non-normal `state` cannot be combined with bounds,
   * `focused: true` not with `minimized`, and `focused: false` not with `maximized` or
   * `fullscreen`. `focused: false` brings the next window to the front; `drawAttention`
   * flashes the window without focusing it.
   */
  readonly update: (windowId: number, updateInfo: chrome.windows.UpdateInfo) => Effect.Effect<chrome.windows.Window, ChromeWindowsError>
  /** Brings a window to the front: `update(windowId, { focused: true })`, failing as `"update"`. */
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
  /**
   * Ids of newly focused windows. Every focus change is reported: `WINDOW_ID_NONE` (-1) when
   * Chrome loses focus, and also when the focused window is one this subscription cannot see
   * (excluded by `filter` or the default types, or an inaccessible incognito window). On some
   * Linux window managers -1 precedes every switch between Chrome windows.
   */
  readonly onFocusChanged: (filter?: WindowEventFilter) => Stream.Stream<number, ChromeWindowsError>
  /**
   * Windows whose new bounds were committed, not in-progress drags. Not filterable: it covers
   * the windows an unfiltered listener sees, never devtools windows.
   */
  readonly onBoundsChanged: Stream.Stream<chrome.windows.Window, ChromeWindowsError>
}

export class ChromeWindows extends Context.Service<ChromeWindows, ChromeWindowsService>()("effect-platform-chrome/ChromeWindows") {}

const invoke = invoker((operation, cause) => new ChromeWindowsError({ operation, cause }))

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
    getCurrent: (queryOptions) => invoke("getCurrent", () => queryOptions === undefined
      ? api.getCurrent()
      : api.getCurrent(queryOptions)),
    getLastFocused: (queryOptions) => invoke("getLastFocused", () => queryOptions === undefined
      ? api.getLastFocused()
      : api.getLastFocused(queryOptions)),
    getAll: (queryOptions) => invoke("getAll", () => queryOptions === undefined
      ? api.getAll()
      : api.getAll(queryOptions)),
    create: (createData) => invoke("create", () => createData === undefined
      ? api.create()
      : api.create(createData)).pipe(Effect.map(Option.fromNullishOr)),
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
