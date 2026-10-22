import * as ChromeWindows from "../ChromeWindows.js"
import * as TestEvent from "./Event.js"

/** Event listeners without a filter see these types (Chrome limits app and panel to the extension's own). */
const defaultEventTypes: ReadonlyArray<ChromeWindows.WindowType> = ["normal", "popup", "app", "panel"]

/** Queries without `windowTypes` see these types. */
const defaultQueryTypes: ReadonlyArray<ChromeWindows.WindowType> = ["normal", "popup"]

/** Every type, as Chrome resolves the window ids passed to `update` and `remove`. */
const allTypes: ReadonlyArray<ChromeWindows.WindowType> = ["normal", "popup", "app", "panel", "devtools"]

/** Chrome's `kInvalidWindowStateError`. */
const invalidState = "Invalid value for state"

/** Chrome's `kMissingLockWindowFullscreenPrivatePermission`. */
const lockedFullscreen = "Cannot lock window to fullscreen or close a locked fullscreen window without lockWindowFullscreenPrivate manifest permission"

const blankWindow = (id: number, properties: Partial<chrome.windows.Window>): chrome.windows.Window => ({
  id, focused: false, alwaysOnTop: false, incognito: false, state: "normal", type: "normal",
  left: 0, top: 0, width: 1280, height: 800,
  ...properties
})

/** What an emission concerns, for filtering; emissions about no known window reach every listener. */
interface Subject {
  readonly type: ChromeWindows.WindowType
  readonly incognito: boolean
}

/**
 * A simulated windows event honouring `windowTypes` filters and incognito access, built on
 * `makeEvent` so `controls` (emit, listenerCount, failNext, waitForListener) work as usual.
 * A listener that cannot see the window receives `hidden` instead when given (as
 * `onFocusChanged` reports -1), and nothing otherwise. Adding a listener twice keeps the
 * first registration, as Chrome does.
 */
const makeWindowEvent = <Args extends ReadonlyArray<unknown>>(
  subjectOf: (...args: Args) => Subject | undefined,
  incognitoVisible: () => boolean,
  hidden?: Args
) => {
  const event = TestEvent.makeEvent<Args>()
  const registered = new Map<(...args: Args) => void, (...args: Args) => void>()

  const api: ChromeWindows.FilteredWindowEvent<Args> = {
    addListener: (listener, filter) => {
      if (registered.has(listener)) return

      const types = filter?.windowTypes ?? defaultEventTypes

      const filtered = (...args: Args) => {
        const subject = subjectOf(...args)

        if (subject === undefined || ((!subject.incognito || incognitoVisible()) && types.includes(subject.type))) {
          listener(...args)
        } else if (hidden !== undefined) {
          listener(...hidden)
        }
      }

      event.api.addListener(filtered)
      registered.set(listener, filtered)
    },
    removeListener: (listener) => {
      const filtered = registered.get(listener)

      if (filtered === undefined) return

      event.api.removeListener(filtered)
      registered.delete(listener)
    }
  }

  return { api, controls: event.controls }
}

/**
 * An in-memory window list with focus tracking. `create` opens a focused window unless
 * `focused: false` or `state: "minimized"` (tabs and urls are not modelled; a `panel` opens as
 * a popup), `update` applies state, bounds and focus, and `remove` closes a window; each emits
 * Chrome's events, honouring `windowTypes` filters. `create` and `update` reject the state,
 * focus and bounds combinations Chrome rejects with "Invalid value for state", and any
 * `locked-fullscreen` request for lack of its permission. Removing, minimizing or unfocusing
 * the focused window refocuses the most recently focused other window that is not minimized,
 * or reports -1 when none is left; focusing a minimized window restores its previous state.
 * `onFocusChanged` reports -1 to a listener that cannot see the newly focused window, and
 * `onBoundsChanged` skips devtools windows. Window ids accept `WINDOW_ID_CURRENT` (-2).
 * `getCurrent` behaves as in a service worker, returning the last active window: windows
 * by recency of focus, then never-focused ones oldest first, which is also the
 * `getLastFocused` order. Queries without `windowTypes` see normal and popup windows. Setting
 * `controls.incognitoAccess` to false (it starts true) hides incognito windows from queries,
 * calls and events, as for an extension not allowed in incognito: `create` then resolves to
 * undefined for them. `populate` is ignored; pass `overrides` to replace any member.
 */
export const makeWindows = (overrides: Partial<ChromeWindows.ChromeWindowsApi> = {}) => {
  const windows = new Map<number, chrome.windows.Window>()
  const subjects = new Map<number, Subject>()
  /** Windows ever focused, least recently focused first. */
  const history = new Set<number>()
  /** Windows never focused, oldest first. */
  const inactive = new Set<number>()
  /** The state a minimized window returns to when focused. */
  const restoreStates = new Map<number, ChromeWindows.WindowState>()
  let incognitoAccess = true
  const incognitoVisible = () => incognitoAccess
  const subjectOf = (windowId: number) => subjects.get(windowId)
  const created = makeWindowEvent<[chrome.windows.Window]>((window) => subjectOf(window.id ?? ChromeWindows.WINDOW_ID_NONE), incognitoVisible)
  const removed = makeWindowEvent<[number]>(subjectOf, incognitoVisible)
  const focusChanged = makeWindowEvent<[number]>(subjectOf, incognitoVisible, [ChromeWindows.WINDOW_ID_NONE])
  const boundsChanged = makeWindowEvent<[chrome.windows.Window]>((window) => subjectOf(window.id ?? ChromeWindows.WINDOW_ID_NONE), incognitoVisible)
  let focusedId: number = ChromeWindows.WINDOW_ID_NONE
  let nextId = 1

  const visible = (window: chrome.windows.Window, types: ReadonlyArray<ChromeWindows.WindowType>) =>
    types.includes(window.type ?? "normal") && (!window.incognito || incognitoAccess)

  /** Open windows by recency of activation, as Chrome orders them for the last active window. */
  const byActivation = function*() {
    yield* Array.from(history).reverse()
    yield* inactive
  }

  const lastActive = (queryOptions: chrome.windows.QueryOptions | undefined): chrome.windows.Window | undefined => {
    for (const id of byActivation()) {
      const window = windows.get(id)

      if (window !== undefined && visible(window, queryOptions?.windowTypes ?? defaultQueryTypes)) return window
    }

    return undefined
  }

  const find = (windowId: number, types: ReadonlyArray<ChromeWindows.WindowType>): chrome.windows.Window => {
    if (windowId === ChromeWindows.WINDOW_ID_CURRENT) {
      const current = lastActive({ windowTypes: Array.from(types) })

      if (current === undefined) throw new Error("No current window")

      return current
    }

    const window = windows.get(windowId)

    if (window === undefined || !visible(window, types)) throw new Error(`No window with id: ${windowId}.`)

    return window
  }

  const setFocus = (windowId: number) => {
    if (windowId === focusedId) return

    const previous = windows.get(focusedId)

    if (previous !== undefined) previous.focused = false

    focusedId = windowId
    const next = windows.get(windowId)

    if (next !== undefined) {
      next.focused = true
      inactive.delete(windowId)
      history.delete(windowId)
      history.add(windowId)

      if (next.state === "minimized") next.state = restoreStates.get(windowId) ?? "normal"

      restoreStates.delete(windowId)
    }

    focusChanged.controls.emit(windowId)
  }

  /** Focuses the most recently focused other window that is not minimized, or none. */
  const refocus = (leaving: number) => {
    const next = Array.from(history).reverse().find((id) => {
      const window = windows.get(id)

      return id !== leaving && window !== undefined && window.state !== "minimized"
    })

    setFocus(next ?? ChromeWindows.WINDOW_ID_NONE)
  }

  const open = (properties: Partial<chrome.windows.Window>): chrome.windows.Window => {
    const window = blankWindow(nextId++, { ...properties, focused: false })
    const id = window.id ?? 0
    windows.set(id, window)
    subjects.set(id, { type: window.type ?? "normal", incognito: window.incognito })
    inactive.add(id)
    created.controls.emit(structuredClone(window))

    if (properties.focused === true && window.state !== "minimized") setFocus(id)

    return structuredClone(window)
  }

  const hasBounds = (data: chrome.windows.CreateData | chrome.windows.UpdateInfo) =>
    data.left !== undefined || data.top !== undefined || data.width !== undefined || data.height !== undefined

  const isFullscreenLike = (state: ChromeWindows.WindowState | undefined) =>
    state === "maximized" || state === "fullscreen" || state === "locked-fullscreen"

  const api: ChromeWindows.ChromeWindowsApi = {
    get: async (windowId, queryOptions) => structuredClone(find(windowId, queryOptions?.windowTypes ?? defaultQueryTypes)),
    getCurrent: async (queryOptions) => {
      const window = lastActive(queryOptions)

      if (window === undefined) throw new Error("No current window")

      return structuredClone(window)
    },
    getLastFocused: async (queryOptions) => {
      const window = lastActive(queryOptions)

      if (window === undefined) throw new Error("No last-focused window")

      return structuredClone(window)
    },
    getAll: async (queryOptions) => Array.from(windows.values())
      .filter((window) => visible(window, queryOptions?.windowTypes ?? defaultQueryTypes))
      .map((window) => structuredClone(window)),
    create: async (createData = {}) => {
      const { state } = createData

      if (state === "minimized" && (createData.focused === true || hasBounds(createData))) throw new Error(invalidState)

      if (isFullscreenLike(state) && (createData.focused === false || hasBounds(createData))) throw new Error(invalidState)

      if (state === "locked-fullscreen") throw new Error(lockedFullscreen)

      const properties: Partial<chrome.windows.Window> = { focused: createData.focused ?? true }

      if (createData.type !== undefined) properties.type = createData.type === "panel" ? "popup" : createData.type

      if (state !== undefined) properties.state = state

      if (createData.incognito !== undefined) properties.incognito = createData.incognito

      if (createData.left !== undefined) properties.left = createData.left

      if (createData.top !== undefined) properties.top = createData.top

      if (createData.width !== undefined) properties.width = createData.width

      if (createData.height !== undefined) properties.height = createData.height

      const window = open(properties)

      return window.incognito && !incognitoAccess ? undefined : window
    },
    update: async (windowId, updateInfo) => {
      const window = find(windowId, allTypes)
      const id = window.id ?? ChromeWindows.WINDOW_ID_NONE
      const { state, focused } = updateInfo

      if (state !== undefined && state !== "normal" && hasBounds(updateInfo)) throw new Error(invalidState)

      if (focused === true && state === "minimized") throw new Error(invalidState)

      if (focused === false && isFullscreenLike(state)) throw new Error(invalidState)

      if (state === "locked-fullscreen") throw new Error(lockedFullscreen)

      if (state !== undefined && state !== window.state) {
        if (state === "minimized") {
          restoreStates.set(id, window.state ?? "normal")
          window.state = state

          if (focusedId === id) refocus(id)
        } else {
          restoreStates.delete(id)
          window.state = state
        }
      }

      let moved = false

      for (const key of ["left", "top", "width", "height"] as const) {
        const value = updateInfo[key]

        if (value !== undefined && value !== window[key]) {
          window[key] = value
          moved = true
        }
      }

      if (moved) boundsChanged.controls.emit(structuredClone(window))

      if (focused === true) setFocus(id)

      if (focused === false && focusedId === id) refocus(id)

      return structuredClone(window)
    },
    remove: async (windowId) => {
      const window = find(windowId, allTypes)
      const id = window.id ?? ChromeWindows.WINDOW_ID_NONE

      if (window.state === "locked-fullscreen") throw new Error(lockedFullscreen)

      windows.delete(id)
      history.delete(id)
      inactive.delete(id)
      restoreStates.delete(id)
      removed.controls.emit(id)

      if (focusedId === id) refocus(id)
    },
    onCreated: created.api,
    onRemoved: removed.api,
    onFocusChanged: focusChanged.api,
    onBoundsChanged: boundsChanged.api,
    ...overrides
  }

  return {
    api,
    layer: ChromeWindows.layer(api),
    controls: {
      /**
       * Adds a window without going through `create` or its validation, emitting `onCreated`;
       * focused only when `focused` is true and it is not minimized.
       */
      seed: (properties: Partial<chrome.windows.Window> = {}) => open(properties),
      /** The live window record, or undefined once removed; mutations bypass events. */
      window: (windowId: number): chrome.windows.Window | undefined => windows.get(windowId),
      /** The focused window's id, or -1 when none is. */
      get focused() { return focusedId },
      /** Whether the extension may see incognito windows; starts true. */
      get incognitoAccess() { return incognitoAccess },
      set incognitoAccess(allowed: boolean) { incognitoAccess = allowed },
      onCreated: created.controls,
      onRemoved: removed.controls,
      onFocusChanged: focusChanged.controls,
      onBoundsChanged: boundsChanged.controls
    }
  }
}
