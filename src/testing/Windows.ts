import * as ChromeWindows from "../ChromeWindows.js"
import * as TestEvent from "./Event.js"

/** Event listeners without a filter see these types (Chrome limits app and panel to the extension's own). */
const defaultEventTypes: ReadonlyArray<ChromeWindows.WindowType> = ["normal", "popup", "app", "panel"]

/** Queries without `windowTypes` see these types. */
const defaultQueryTypes: ReadonlyArray<ChromeWindows.WindowType> = ["normal", "popup"]

const WINDOW_ID_NONE = -1

const blankWindow = (id: number, properties: Partial<chrome.windows.Window>): chrome.windows.Window => ({
  id, focused: false, alwaysOnTop: false, incognito: false, state: "normal", type: "normal",
  left: 0, top: 0, width: 1280, height: 800,
  ...properties
})

/**
 * A simulated windows event honouring `windowTypes` filters, built on `makeEvent` so
 * `controls` (emit, listenerCount, failNext, waitForListener) work as usual. `typeOf` names
 * the window an emission concerns; emissions about no known window reach every listener.
 */
const makeWindowEvent = <Args extends ReadonlyArray<unknown>>(
  typeOf: (...args: Args) => ChromeWindows.WindowType | undefined
) => {
  const event = TestEvent.makeEvent<Args>()
  const registered = new Map<(...args: Args) => void, (...args: Args) => void>()

  const api: ChromeWindows.FilteredWindowEvent<Args> = {
    addListener: (listener, filter) => {
      const types = filter?.windowTypes ?? defaultEventTypes

      const filtered = (...args: Args) => {
        const type = typeOf(...args)

        if (type === undefined || types.includes(type)) listener(...args)
      }

      event.api.addListener(filtered)
      const previous = registered.get(listener)

      if (previous !== undefined) event.api.removeListener(previous)

      registered.set(listener, filtered)
    },
    removeListener: (listener) => {
      event.api.removeListener(registered.get(listener) ?? listener)
      registered.delete(listener)
    }
  }

  return { api, controls: event.controls }
}

/**
 * An in-memory window list with focus tracking. `create` opens a focused window unless
 * `focused: false` (tabs and urls are not modelled), `update` applies bounds, state and
 * focus, and `remove` closes a window; each emits Chrome's events, honouring `windowTypes`
 * filters. Removing or unfocusing the focused window refocuses the previously focused one,
 * or reports -1 when none is left. `getCurrent` behaves as in a service worker, returning the
 * last focused window. Queries without `windowTypes` see normal and popup windows. `populate`
 * is ignored; pass `overrides` to replace any member.
 */
export const makeWindows = (overrides: Partial<ChromeWindows.ChromeWindowsApi> = {}) => {
  const windows = new Map<number, chrome.windows.Window>()
  const types = new Map<number, ChromeWindows.WindowType>()
  const history: Array<number> = []
  const typeOf = (windowId: number) => types.get(windowId)
  const created = makeWindowEvent<[chrome.windows.Window]>((window) => window.type)
  const removed = makeWindowEvent<[number]>(typeOf)
  const focusChanged = makeWindowEvent<[number]>(typeOf)
  const boundsChanged = TestEvent.makeEvent<[chrome.windows.Window]>()
  let focusedId = WINDOW_ID_NONE
  let nextId = 1

  const find = (windowId: number): chrome.windows.Window => {
    const window = windows.get(windowId)

    if (window === undefined) throw new Error(`No window with id: ${windowId}.`)

    return window
  }

  const visible = (window: chrome.windows.Window, queryOptions: chrome.windows.QueryOptions | undefined) =>
    (queryOptions?.windowTypes ?? defaultQueryTypes).includes(window.type ?? "normal")

  const setFocus = (windowId: number) => {
    if (windowId === focusedId) return

    const previous = windows.get(focusedId)

    if (previous !== undefined) previous.focused = false

    focusedId = windowId
    const next = windows.get(windowId)

    if (next !== undefined) {
      next.focused = true
      const position = history.indexOf(windowId)

      if (position !== -1) history.splice(position, 1)

      history.push(windowId)
    }

    focusChanged.controls.emit(windowId)
  }

  /** Focuses the most recently focused other window, or none. */
  const refocus = (leaving: number) => {
    const candidates = history.filter((id) => id !== leaving && windows.has(id))
    setFocus(candidates.at(-1) ?? WINDOW_ID_NONE)
  }

  const open = (properties: Partial<chrome.windows.Window>): chrome.windows.Window => {
    const window = blankWindow(nextId++, { ...properties, focused: false })
    const id = window.id ?? 0
    windows.set(id, window)
    types.set(id, window.type ?? "normal")
    created.controls.emit(structuredClone(window))

    if (properties.focused === true) setFocus(id)

    return structuredClone(window)
  }

  const lastFocused = async (queryOptions?: chrome.windows.QueryOptions) => {
    for (const id of history.slice().reverse()) {
      const window = windows.get(id)

      if (window !== undefined && visible(window, queryOptions)) return structuredClone(window)
    }

    throw new Error("No last-focused window")
  }

  const api: ChromeWindows.ChromeWindowsApi = {
    get: async (windowId, queryOptions) => {
      const window = find(windowId)

      if (!visible(window, queryOptions)) throw new Error(`No window with id: ${windowId}.`)

      return structuredClone(window)
    },
    getCurrent: lastFocused,
    getLastFocused: lastFocused,
    getAll: async (queryOptions) => Array.from(windows.values(), (window) => structuredClone(window))
      .filter((window) => visible(window, queryOptions)),
    create: async (createData = {}) => {
      const properties: Partial<chrome.windows.Window> = { focused: createData.focused ?? true }

      if (createData.type !== undefined) properties.type = createData.type

      if (createData.state !== undefined) properties.state = createData.state

      if (createData.incognito !== undefined) properties.incognito = createData.incognito

      if (createData.left !== undefined) properties.left = createData.left

      if (createData.top !== undefined) properties.top = createData.top

      if (createData.width !== undefined) properties.width = createData.width

      if (createData.height !== undefined) properties.height = createData.height

      return open(properties)
    },
    update: async (windowId, updateInfo) => {
      const window = find(windowId)
      let moved = false

      for (const key of ["left", "top", "width", "height"] as const) {
        const value = updateInfo[key]

        if (value !== undefined && value !== window[key]) {
          window[key] = value
          moved = true
        }
      }

      if (updateInfo.state !== undefined) window.state = updateInfo.state

      if (moved) boundsChanged.controls.emit(structuredClone(window))

      if (updateInfo.focused === true) setFocus(windowId)

      if (updateInfo.focused === false && focusedId === windowId) refocus(windowId)

      return structuredClone(window)
    },
    remove: async (windowId) => {
      find(windowId)
      windows.delete(windowId)
      removed.controls.emit(windowId)

      if (focusedId === windowId) refocus(windowId)
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
      /** Adds a window without going through `create`, focused only when `focused` is true. */
      seed: (properties: Partial<chrome.windows.Window> = {}) => open(properties),
      window: (windowId: number): chrome.windows.Window | undefined => windows.get(windowId),
      /** The focused window's id, or -1 when none is. */
      get focused() { return focusedId },
      onCreated: created.controls,
      onRemoved: removed.controls,
      onFocusChanged: focusChanged.controls,
      onBoundsChanged: boundsChanged.controls
    }
  }
}
