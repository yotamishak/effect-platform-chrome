import { Predicate } from "effect"
import * as ChromeTabs from "../ChromeTabs.js"
import * as TestEvent from "./Event.js"
import * as TestPort from "./Port.js"

// These are deliberately raw Chrome I/O boundaries: messages, stored values and
// callback exceptions are unvalidated until a consumer applies its own schema.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns */

const TAB_ID_NONE = -1

const GROUP_ID_NONE = -1

const SPLIT_VIEW_ID_NONE = -1

/** `chrome.windows.WINDOW_ID_CURRENT`, which `query` accepts for the current window. */
const WINDOW_ID_CURRENT = -2

const blankTab = (id: number, properties: Partial<chrome.tabs.Tab>): chrome.tabs.Tab => ({
  id, index: 0, windowId: 1, highlighted: false, active: true, pinned: false, incognito: false,
  discarded: false, autoDiscardable: true, groupId: GROUP_ID_NONE, frozen: false, selected: true, lastAccessed: 0,
  ...properties
})

const defaultZoomSettings: chrome.tabs.ZoomSettings = { mode: "automatic", scope: "per-origin", defaultZoomFactor: 1 }

const noHistory = "Cannot find a next page in history."

/** A connection a test opened with the fake `connect`; serve or answer it through `pair`. */
export interface TabConnection {
  readonly tabId: number
  readonly connectInfo: chrome.tabs.ConnectInfo | undefined
  readonly pair: ReturnType<typeof TestPort.makePortPair>
}

/** Matches `text` against a glob whose only wildcard is `*`. */
const glob = (pattern: string, text: string): boolean => {
  const parts = pattern.split("*")
  const source = parts.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")

  return new RegExp(`^${source}$`, "s").test(text)
}

const webSchemes = ["http:", "https:", "ws:", "wss:"]

/**
 * A Chrome match pattern (`<all_urls>`, or `scheme://host/path` with `*` wildcards) against a
 * URL; the fragment is ignored and an unparsable URL never matches.
 */
const matchesPattern = (pattern: string, url: string): boolean => {
  const parsed = URL.canParse(url) ? new URL(url) : undefined

  if (parsed === undefined) return false

  if (pattern === "<all_urls>") return [...webSchemes, "file:", "ftp:"].includes(parsed.protocol)

  const match = /^(\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)$/.exec(pattern)

  if (match === null) return false

  const [, scheme = "", host = "", path = ""] = match
  const schemeMatches = scheme === "*" ? webSchemes.includes(parsed.protocol) : parsed.protocol === `${scheme}:`
  const target = host.includes(":") ? parsed.host : parsed.hostname

  const hostMatches = host === "*"
    || (host.startsWith("*.") ? target === host.slice(2) || target.endsWith(host.slice(1)) : target === host)

  return schemeMatches && hostMatches && glob(path, `${parsed.pathname}${parsed.search}`)
}

/**
 * An in-memory tab strip. Each window keeps its tabs in order and `index` follows that order;
 * tabs keep the properties they were created, seeded or updated with. Each window has at most
 * one active tab: activating one (by `create`, `duplicate`, `update`, `highlight` or closing the
 * active tab) deactivates the others, makes it the window's only highlighted tab, wakes it if
 * discarded and emits `onActivated` and `onHighlighted`. The current tab is the first active
 * one, and the current window is its window (else window 1); calls that default to them use
 * these. `getCurrent` resolves to the tab set with `controls.setCurrentTab`, by default none,
 * as in a service worker.
 *
 * `query` matches `active`, `highlighted`, `pinned`, `audible`, `muted`, `discarded`,
 * `autoDiscardable`, `frozen`, `status`, `index`, `groupId`, `splitViewId`, `windowId`
 * (including `WINDOW_ID_CURRENT`), `currentWindow`, `lastFocusedWindow` (both meaning the
 * current window), `windowType` (every window is normal), `title` globs and `url` match
 * patterns, and returns tabs by window, then index.
 *
 * `update` applies `url` (one history entry), `active`, `highlighted`, `pinned`, `muted`,
 * `autoDiscardable` and `openerTabId`, emitting `onUpdated` with only the changed fields.
 * `goBack`/`goForward` walk the urls a tab was created with and navigated to, rejecting as
 * Chrome does at either end. `move` (onMoved, or onDetached then onAttached across windows,
 * where the moved tab arrives inactive), `reload` (loading, then complete), `remove`,
 * `discard` (an id must name an inactive tab; without one, the least recently accessed
 * inactive, auto-discardable tab; an already discarded tab is returned unchanged), `group`,
 * `ungroup`, `createSplit`, `unsplit` and the zoom calls update the strip and emit Chrome's
 * events synchronously. `move` resolves one tab when one moved and rejects an empty list, as
 * Chrome does. Unknown ids reject with Chrome's messages. `detectLanguage` resolves `und`,
 * `sendMessage` fails as Chrome does with no receiver, `connect` returns one end of a port pair
 * (the other end is in `controls.connections`), and `captureVisibleTab` returns an empty data
 * URL in the requested format (JPEG by default). Pass `overrides` to replace any member, such
 * as a `get` that models a slow navigation; leave `createSplit` and `unsplit` out of `api`
 * (by destructuring) to model a browser before Chrome 155.
 */
export const makeTabs = (overrides: Partial<ChromeTabs.ChromeTabsApi> = {}) => {
  const tabs = new Map<number, chrome.tabs.Tab>()
  const strips = new Map<number, Array<number>>()
  const histories = new Map<number, { readonly urls: Array<string>; position: number }>()
  const zoomFactors = new Map<number, number>()
  const zoomSettings = new Map<number, chrome.tabs.ZoomSettings>()
  const groupIds = new Set<number>()
  const splitViews = new Map<number, [number, number]>()
  const connections: Array<TabConnection> = []
  const created = TestEvent.makeEvent<[chrome.tabs.Tab]>()
  const updated = TestEvent.makeEvent<[number, chrome.tabs.OnUpdatedInfo, chrome.tabs.Tab]>()
  const removed = TestEvent.makeEvent<[number, chrome.tabs.OnRemovedInfo]>()
  const activated = TestEvent.makeEvent<[chrome.tabs.OnActivatedInfo]>()
  const moved = TestEvent.makeEvent<[number, chrome.tabs.OnMovedInfo]>()
  const replaced = TestEvent.makeEvent<[number, number]>()
  const attached = TestEvent.makeEvent<[number, chrome.tabs.OnAttachedInfo]>()
  const detached = TestEvent.makeEvent<[number, chrome.tabs.OnDetachedInfo]>()
  const highlighted = TestEvent.makeEvent<[chrome.tabs.OnHighlightedInfo]>()
  const zoomChanged = TestEvent.makeEvent<[chrome.tabs.OnZoomChangeInfo]>()
  let nextId = 1
  let nextGroupId = 1
  let nextSplitViewId = 1
  let accessClock = 0
  let currentTabId: number | undefined

  const idOf = (tab: chrome.tabs.Tab): number => tab.id ?? TAB_ID_NONE

  const find = (tabId: number): chrome.tabs.Tab => {
    const tab = tabs.get(tabId)

    if (tab === undefined) throw new Error(`No tab with id: ${tabId}.`)

    return tab
  }

  const currentTab = (): chrome.tabs.Tab | undefined => {
    for (const tab of tabs.values()) if (tab.active) return tab

    return undefined
  }

  const currentWindowId = (): number => currentTab()?.windowId ?? 1

  /** The given tab, or the current one where Chrome would use the selected tab. */
  const target = (tabId: number | undefined): chrome.tabs.Tab => {
    if (tabId !== undefined) return find(tabId)

    const tab = currentTab()

    if (tab === undefined) throw new Error("No current tab.")

    return tab
  }

  const strip = (windowId: number): Array<number> => {
    const existing = strips.get(windowId)

    if (existing !== undefined) return existing

    const fresh: Array<number> = []
    strips.set(windowId, fresh)

    return fresh
  }

  const windowTabs = (windowId: number): Array<chrome.tabs.Tab> => strip(windowId).map(find)

  const reindex = (windowId: number) => {
    strip(windowId).forEach((tabId, index) => { find(tabId).index = index })
  }

  /** Inserts at `index`, or at the end for -1 and out-of-range positions; returns the position. */
  const insert = (tab: chrome.tabs.Tab, index: number | undefined): number => {
    const ids = strip(tab.windowId)
    const position = index === undefined || index < 0 || index > ids.length ? ids.length : index
    ids.splice(position, 0, idOf(tab))
    reindex(tab.windowId)

    return position
  }

  const detach = (tab: chrome.tabs.Tab): number => {
    const ids = strip(tab.windowId)
    const position = ids.indexOf(idOf(tab))
    ids.splice(position, 1)
    reindex(tab.windowId)

    return position
  }

  const emitUpdated = (tab: chrome.tabs.Tab, changeInfo: chrome.tabs.OnUpdatedInfo) =>
    updated.controls.emit(idOf(tab), changeInfo, structuredClone(tab))

  const setHighlighted = (tab: chrome.tabs.Tab, value: boolean) => {
    tab.highlighted = value
    tab.selected = value
  }

  const highlightedIds = (windowId: number): Array<number> =>
    windowTabs(windowId).flatMap((tab) => tab.highlighted ? [idOf(tab)] : [])

  /**
   * Makes `tab` its window's active tab and, unless `highlight` is false, its only highlighted
   * one. A discarded tab is reloaded, as Chrome does on activation.
   */
  const activate = (tab: chrome.tabs.Tab, highlight = true) => {
    const tabId = idOf(tab)
    const wasActive = tab.active

    for (const other of windowTabs(tab.windowId)) {
      if (other !== tab) {
        other.active = false

        if (highlight) setHighlighted(other, false)
      }
    }

    tab.active = true
    tab.lastAccessed = ++accessClock

    if (highlight) setHighlighted(tab, true)

    if (tab.discarded) {
      tab.discarded = false
      emitUpdated(tab, { discarded: false })
    }

    if (!wasActive) activated.controls.emit({ tabId, windowId: tab.windowId })

    if (highlight) highlighted.controls.emit({ windowId: tab.windowId, tabIds: [tabId] })
  }

  /** After `tab` left its window, activates the tab that took its place, else the one before. */
  const activateNeighbour = (windowId: number, position: number) => {
    const ids = strip(windowId)
    const next = ids[Math.min(position, ids.length - 1)]

    if (next !== undefined) activate(find(next))
  }

  const pruneGroups = () => {
    const live = new Set(Array.from(tabs.values(), (tab) => tab.groupId))

    for (const id of groupIds) if (!live.has(id)) groupIds.delete(id)
  }

  /** Dissolves the split view `tab` belongs to, if any, emitting both tabs' updates. */
  const dissolveSplit = (splitViewId: number) => {
    const pair = splitViews.get(splitViewId)

    if (pair === undefined) return

    splitViews.delete(splitViewId)

    for (const tab of pair.flatMap((id) => tabs.get(id) ?? [])) {
      tab.splitViewId = SPLIT_VIEW_ID_NONE
      emitUpdated(tab, { splitViewId: SPLIT_VIEW_ID_NONE })
    }
  }

  const create = (properties: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab => {
    const tab = blankTab(nextId++, properties)
    const tabId = idOf(tab)
    const active = tab.active
    tab.active = false
    tabs.set(tabId, tab)
    insert(tab, properties.index)
    histories.set(tabId, { urls: tab.url === undefined ? [] : [tab.url], position: tab.url === undefined ? -1 : 0 })
    tab.selected = tab.highlighted

    if (tab.groupId !== GROUP_ID_NONE) groupIds.add(tab.groupId)

    created.controls.emit(structuredClone(tab))

    if (active) activate(tab)

    return structuredClone(tab)
  }

  const flag = (expected: boolean | undefined, actual: boolean): boolean => expected === undefined || expected === actual

  const matches = (tab: chrome.tabs.Tab, info: chrome.tabs.QueryInfo): boolean => {
    const windowId = info.windowId === WINDOW_ID_CURRENT ? currentWindowId() : info.windowId
    const inCurrent = tab.windowId === currentWindowId()

    return flag(info.active, tab.active)
      && flag(info.highlighted, tab.highlighted)
      && flag(info.pinned, tab.pinned)
      && flag(info.audible, tab.audible ?? false)
      && flag(info.muted, tab.mutedInfo?.muted ?? false)
      && flag(info.discarded, tab.discarded)
      && flag(info.autoDiscardable, tab.autoDiscardable)
      && flag(info.frozen, tab.frozen)
      && flag(info.currentWindow, inCurrent)
      && flag(info.lastFocusedWindow, inCurrent)
      && (windowId === undefined || tab.windowId === windowId)
      && (info.windowType === undefined || info.windowType === "normal")
      && (info.index === undefined || tab.index === info.index)
      && (info.groupId === undefined || tab.groupId === info.groupId)
      && (info.splitViewId === undefined || (tab.splitViewId ?? SPLIT_VIEW_ID_NONE) === info.splitViewId)
      && (info.status === undefined || tab.status === info.status)
      && (info.title === undefined || glob(info.title, tab.title ?? ""))
      && (info.url === undefined || [info.url].flat().some((pattern) => matchesPattern(pattern, tab.url ?? "")))
  }

  const moveTab = (tab: chrome.tabs.Tab, index: number, windowId: number) => {
    const tabId = idOf(tab)

    if (windowId !== tab.windowId) {
      const oldWindowId = tab.windowId
      const wasActive = tab.active
      const oldPosition = detach(tab)
      detached.controls.emit(tabId, { oldWindowId, oldPosition })

      if (wasActive) activateNeighbour(oldWindowId, oldPosition)

      tab.windowId = windowId
      const alone = strip(windowId).length === 0
      tab.active = false
      setHighlighted(tab, false)
      attached.controls.emit(tabId, { newWindowId: windowId, newPosition: insert(tab, index) })

      if (alone) activate(tab)

      return
    }

    const fromIndex = detach(tab)
    const toIndex = insert(tab, index)

    if (fromIndex !== toIndex) moved.controls.emit(tabId, { windowId, fromIndex, toIndex })
  }

  const setGroup = (tabIds: ReadonlyArray<number>, groupId: number) => {
    for (const tab of tabIds.map(find)) {
      if (tab.groupId === groupId) continue

      tab.groupId = groupId
      emitUpdated(tab, { groupId })
    }

    pruneGroups()
  }

  const navigate = (tab: chrome.tabs.Tab, url: string) => {
    tab.url = url
    emitUpdated(tab, { url })
  }

  const historyStep = (tabId: number | undefined, step: -1 | 1) => {
    const tab = target(tabId)
    const history = histories.get(idOf(tab))
    const position = (history?.position ?? 0) + step
    const url = history?.urls[position]

    if (history === undefined || url === undefined || position < 0) throw new Error(noHistory)

    history.position = position
    navigate(tab, url)
  }

  const reloadTab = (tabId: number | undefined) => {
    const tab = target(tabId)
    tab.status = "loading"
    emitUpdated(tab, { status: "loading" })
    tab.status = "complete"
    emitUpdated(tab, { status: "complete" })
  }

  const updateTab = (tabId: number | undefined, properties: chrome.tabs.UpdateProperties): chrome.tabs.Tab => {
    const tab = target(tabId)
    const changeInfo: chrome.tabs.OnUpdatedInfo = {}

    if (properties.openerTabId !== undefined) {
      if (find(properties.openerTabId).windowId !== tab.windowId) {
        throw new Error("Tab opener must be in the same window as the updated tab.")
      }

      tab.openerTabId = properties.openerTabId
    }

    if (properties.url !== undefined) {
      const history = histories.get(idOf(tab)) ?? { urls: [], position: -1 }
      history.urls.splice(history.position + 1, history.urls.length, properties.url)
      history.position = history.urls.length - 1
      histories.set(idOf(tab), history)
      tab.url = properties.url
      changeInfo.url = properties.url
    }

    if (properties.pinned !== undefined && properties.pinned !== tab.pinned) {
      tab.pinned = properties.pinned
      changeInfo.pinned = properties.pinned
    }

    if (properties.muted !== undefined && properties.muted !== (tab.mutedInfo?.muted ?? false)) {
      tab.mutedInfo = { muted: properties.muted, reason: "extension" }
      changeInfo.mutedInfo = { ...tab.mutedInfo }
    }

    if (properties.autoDiscardable !== undefined && properties.autoDiscardable !== tab.autoDiscardable) {
      tab.autoDiscardable = properties.autoDiscardable
      changeInfo.autoDiscardable = properties.autoDiscardable
    }

    if (Object.keys(changeInfo).length > 0) emitUpdated(tab, changeInfo)

    if (properties.active === true && !tab.active) activate(tab)

    if (properties.highlighted !== undefined && properties.highlighted !== tab.highlighted) {
      setHighlighted(tab, properties.highlighted)
      highlighted.controls.emit({ windowId: tab.windowId, tabIds: highlightedIds(tab.windowId) })
    }

    return structuredClone(tab)
  }

  const setZoomOf = (tabId: number | undefined, zoomFactor: number) => {
    if (zoomFactor < 0) throw new Error("Zoom value is out of range.")

    const id = idOf(target(tabId))
    const settings = { ...defaultZoomSettings, ...zoomSettings.get(id) }
    const oldZoomFactor = zoomFactors.get(id) ?? 1
    const newZoomFactor = zoomFactor === 0 ? settings.defaultZoomFactor ?? 1 : zoomFactor
    zoomFactors.set(id, newZoomFactor)

    if (oldZoomFactor !== newZoomFactor) {
      zoomChanged.controls.emit({ tabId: id, oldZoomFactor, newZoomFactor, zoomSettings: settings })
    }
  }

  const setZoomSettingsOf = (tabId: number | undefined, settings: chrome.tabs.ZoomSettings) => {
    const id = idOf(target(tabId))
    const next: chrome.tabs.ZoomSettings = { ...zoomSettings.get(id) }

    if (settings.mode !== undefined) next.mode = settings.mode

    if (settings.scope !== undefined) next.scope = settings.scope

    zoomSettings.set(id, next)
  }

  const removeTab = (tabId: number) => {
    const tab = find(tabId)
    const wasActive = tab.active
    const position = detach(tab)
    tabs.delete(tabId)
    histories.delete(tabId)
    zoomFactors.delete(tabId)
    zoomSettings.delete(tabId)

    if (tab.splitViewId !== undefined) dissolveSplit(tab.splitViewId)

    pruneGroups()
    removed.controls.emit(tabId, { windowId: tab.windowId, isWindowClosing: false })

    if (wasActive) activateNeighbour(tab.windowId, position)
  }

  const discardTab = (tab: chrome.tabs.Tab): chrome.tabs.Tab => {
    if (tab.active) throw new Error(`Cannot discard tab with id: ${idOf(tab)}.`)

    if (!tab.discarded) {
      tab.discarded = true
      emitUpdated(tab, { discarded: true })
    }

    return structuredClone(tab)
  }

  const windowOf = (windowId: number): chrome.windows.Window => ({
    id: windowId, focused: windowId === currentWindowId(), alwaysOnTop: false, incognito: false,
    state: "normal", type: "normal", tabs: windowTabs(windowId).map((tab) => structuredClone(tab))
  })

  const api: ChromeTabs.ChromeTabsApi = {
    get: async (tabId) => structuredClone(find(tabId)),
    getCurrent: async () => currentTabId === undefined ? undefined : structuredClone(find(currentTabId)),
    query: async (info) => Array.from(tabs.values(), (tab) => structuredClone(tab))
      .filter((tab) => matches(tab, info))
      .sort((left, right) => left.windowId - right.windowId || left.index - right.index),
    create: async (properties) => {
      const tab: Partial<chrome.tabs.Tab> = { active: properties.active ?? true, windowId: properties.windowId ?? currentWindowId() }

      if (properties.openerTabId !== undefined) {
        if (find(properties.openerTabId).windowId !== tab.windowId) {
          throw new Error("Tab opener must be in the same window as the newly created tab.")
        }

        tab.openerTabId = properties.openerTabId
      }

      if (properties.url !== undefined) tab.url = properties.url

      if (properties.index !== undefined) tab.index = properties.index

      if (properties.pinned !== undefined) tab.pinned = properties.pinned

      return create(tab)
    },
    duplicate: async (tabId) => {
      const { id: _id, active: _active, highlighted: _highlighted, splitViewId: _split, ...original } = structuredClone(find(tabId))
      const history = histories.get(tabId)
      const copy = create({ ...original, index: original.index + 1, active: true })

      if (history !== undefined) histories.set(idOf(copy), { urls: [...history.urls], position: history.position })

      return copy
    },
    update: async (...args: [chrome.tabs.UpdateProperties] | [number, chrome.tabs.UpdateProperties]) =>
      args.length === 1 ? updateTab(undefined, args[0]) : updateTab(args[0], args[1]),
    move: async (tabIds, { index, windowId }) => {
      const ids = [tabIds].flat()

      if (ids.length === 0) throw new Error("No tabs given.")

      const targets = ids.map(find)

      targets.forEach((tab, offset) => {
        moveTab(tab, index < 0 ? -1 : index + offset, windowId ?? tab.windowId)
      })

      const result = targets.map((tab) => structuredClone(tab))
      const [only] = result

      return result.length === 1 && only !== undefined ? only : result
    },
    reload: async (
      ...args: [] | [number] | [chrome.tabs.ReloadProperties] | [number, chrome.tabs.ReloadProperties]
    ) => { reloadTab(Predicate.isNumber(args[0]) ? args[0] : undefined) },
    remove: async (tabIds) => {
      for (const tabId of [tabIds].flat()) removeTab(tabId)
    },
    highlight: async ({ tabs: indices, windowId }) => {
      const window = windowId ?? currentWindowId()

      const selected = [indices].flat().map((index) => {
        const tabId = strip(window)[index]

        if (tabId === undefined) throw new Error(`No tab at index: ${index}.`)

        return find(tabId)
      })

      const [first] = selected

      if (first === undefined) throw new Error("No highlighted tab")

      for (const tab of windowTabs(window)) setHighlighted(tab, selected.includes(tab))

      activate(first, false)
      highlighted.controls.emit({ windowId: window, tabIds: highlightedIds(window) })

      return windowOf(window)
    },
    group: async ({ tabIds, groupId, createProperties }) => {
      if (tabIds === undefined) throw new Error("No tabs were given to group.")

      if (groupId !== undefined && createProperties !== undefined) {
        throw new Error("Cannot specify 'createProperties' along with a 'groupId'.")
      }

      if (groupId !== undefined && !groupIds.has(groupId)) throw new Error(`No group with id: ${groupId}.`)

      const ids = [tabIds].flat()
      ids.forEach(find)
      const id = groupId ?? nextGroupId++
      groupIds.add(id)
      setGroup(ids, id)

      return id
    },
    ungroup: async (tabIds) => { setGroup([tabIds].flat(), GROUP_ID_NONE) },
    createSplit: async (tabIds) => {
      const [left, right] = tabIds.map(find)

      if (left === undefined || right === undefined) throw new Error("Split view needs exactly two tabs.")

      const split = (tab: chrome.tabs.Tab) => (tab.splitViewId ?? SPLIT_VIEW_ID_NONE) !== SPLIT_VIEW_ID_NONE

      if (left === right || left.windowId !== right.windowId || Math.abs(left.index - right.index) !== 1
        || split(left) || split(right) || left.pinned !== right.pinned || left.groupId !== right.groupId) {
        throw new Error("Tabs must be adjacent, unsplit, and share a window, pinned state and group.")
      }

      const splitViewId = nextSplitViewId++
      splitViews.set(splitViewId, [idOf(left), idOf(right)])

      for (const tab of [left, right]) {
        tab.splitViewId = splitViewId
        emitUpdated(tab, { splitViewId })
      }

      return splitViewId
    },
    unsplit: async (splitViewId) => {
      if (!splitViews.has(splitViewId)) throw new Error(`No split view with id: ${splitViewId}.`)

      dissolveSplit(splitViewId)
    },
    discard: async (tabId) => {
      if (tabId !== undefined) return discardTab(find(tabId))

      const [least] = Array.from(tabs.values())
        .filter((tab) => !tab.active && !tab.discarded && tab.autoDiscardable)
        .sort((left, right) => left.lastAccessed - right.lastAccessed)

      if (least === undefined) throw new Error("Cannot find a tab to discard.")

      return discardTab(least)
    },
    goBack: async (tabId) => { historyStep(tabId, -1) },
    goForward: async (tabId) => { historyStep(tabId, 1) },
    getZoom: async (tabId) => zoomFactors.get(idOf(target(tabId))) ?? 1,
    setZoom: async (...args: [number] | [number, number]) => {
      if (args.length === 1) setZoomOf(undefined, args[0])
      else setZoomOf(args[0], args[1])
    },
    getZoomSettings: async (tabId) => ({ ...defaultZoomSettings, ...zoomSettings.get(idOf(target(tabId))) }),
    setZoomSettings: async (...args: [chrome.tabs.ZoomSettings] | [number, chrome.tabs.ZoomSettings]) => {
      if (args.length === 1) setZoomSettingsOf(undefined, args[0])
      else setZoomSettingsOf(args[0], args[1])
    },
    detectLanguage: async (tabId) => {
      target(tabId)

      return "und"
    },
    sendMessage: async () => { throw new Error("Could not establish connection. Receiving end does not exist.") },
    connect: (tabId, connectInfo) => {
      const pair = TestPort.makePortPair(connectInfo?.name)
      connections.push({ tabId, connectInfo, pair })

      return pair.left.port
    },
    captureVisibleTab: async (
      ...args: [] | [number] | [chrome.extensionTypes.ImageDetails] | [number, chrome.extensionTypes.ImageDetails]
    ) => {
      const options = args.length === 2 ? args[1] : Predicate.isNumber(args[0]) ? undefined : args[0]

      return `data:image/${options?.format ?? "jpeg"};base64,`
    },
    onCreated: created.api,
    onUpdated: updated.api,
    onRemoved: removed.api,
    onActivated: activated.api,
    onMoved: moved.api,
    onReplaced: replaced.api,
    onAttached: attached.api,
    onDetached: detached.api,
    onHighlighted: highlighted.api,
    onZoomChange: zoomChanged.api,
    ...overrides
  }

  return {
    api,
    layer: ChromeTabs.layer(api),
    controls: {
      /**
       * Adds a tab without going through `create`, by default active in window 1, with the
       * same events; returns it with its id.
       */
      seed: (properties: Partial<chrome.tabs.Tab> = {}) => create(properties),
      /** The live record of a tab, or undefined once it is removed. */
      tab: (tabId: number): chrome.tabs.Tab | undefined => tabs.get(tabId),
      /** The tab `getCurrent` reports, as when code runs in that tab; undefined for none. */
      setCurrentTab: (tabId: number | undefined) => { currentTabId = tabId },
      /**
       * Replaces a tab with a new one in the same place, as prerendering does, and emits
       * `onReplaced`; returns the new tab.
       */
      replace: (removedTabId: number, properties: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab => {
        const old = find(removedTabId)
        const tab = { ...structuredClone(old), ...properties, id: nextId++ }
        const tabId = idOf(tab)
        const ids = strip(old.windowId)
        ids.splice(ids.indexOf(removedTabId), 1, tabId)
        tabs.delete(removedTabId)
        tabs.set(tabId, tab)
        histories.set(tabId, histories.get(removedTabId) ?? { urls: [], position: -1 })
        histories.delete(removedTabId)

        for (const pair of splitViews.values()) pair.forEach((id, slot) => { if (id === removedTabId) pair[slot] = tabId })
        reindex(tab.windowId)
        replaced.controls.emit(tabId, removedTabId)

        return structuredClone(tab)
      },
      connections,
      onCreated: created.controls,
      onUpdated: updated.controls,
      onRemoved: removed.controls,
      onActivated: activated.controls,
      onMoved: moved.controls,
      onReplaced: replaced.controls,
      onAttached: attached.controls,
      onDetached: detached.controls,
      onHighlighted: highlighted.controls,
      onZoomChange: zoomChanged.controls
    }
  }
}
