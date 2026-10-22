import * as ChromeTabs from "../ChromeTabs.js"
import * as TestEvent from "./Event.js"
import * as TestPort from "./Port.js"

// These are deliberately raw Chrome I/O boundaries: messages, stored values and
// callback exceptions are unvalidated until a consumer applies its own schema.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns */

const blankTab = (id: number, properties: Partial<chrome.tabs.Tab>): chrome.tabs.Tab => ({
  id, index: 0, windowId: 1, highlighted: false, active: true, pinned: false, incognito: false,
  discarded: false, autoDiscardable: true, groupId: -1, frozen: false, selected: true, lastAccessed: 0,
  ...properties
})

const defaultZoomSettings: chrome.tabs.ZoomSettings = { mode: "automatic", scope: "per-origin", defaultZoomFactor: 1 }

/** A connection a test opened with the fake `connect`; serve or answer it through `pair`. */
export interface TabConnection {
  readonly tabId: number
  readonly connectInfo: chrome.tabs.ConnectInfo | undefined
  readonly pair: ReturnType<typeof TestPort.makePortPair>
}

/**
 * An in-memory tab strip. Each window keeps its tabs in order and `index` follows that order;
 * tabs keep the properties they were created or updated with. `query` matches `active`,
 * `windowId`, `index`, `groupId`, `pinned`, `discarded`, `status` and exact `url`s.
 * `duplicate`, `move`, `reload` (loading then complete), `discard`, `group`, `ungroup` and
 * the zoom calls update the strip and emit Chrome's events. Calls that default to the
 * current tab use the first active one. `goBack`/`goForward` reject (there is no history),
 * `detectLanguage` resolves `und`, `sendMessage` fails as Chrome does with no receiver,
 * `connect` returns one end of a port pair (the other end is in `controls.connections`), and
 * `captureVisibleTab` returns an empty JPEG data URL. Pass `overrides` to replace any member,
 * such as a `get` that models a slow navigation.
 */
export const makeTabs = (overrides: Partial<ChromeTabs.ChromeTabsApi> = {}) => {
  const tabs = new Map<number, chrome.tabs.Tab>()
  const strips = new Map<number, Array<number>>()
  const zoomFactors = new Map<number, number>()
  const zoomSettings = new Map<number, chrome.tabs.ZoomSettings>()
  const groupIds = new Set<number>()
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

  const find = (tabId: number): chrome.tabs.Tab => {
    const tab = tabs.get(tabId)

    if (tab === undefined) throw new Error(`No tab with id: ${tabId}.`)

    return tab
  }

  /** The given tab, or the first active one where Chrome would use the current tab. */
  const target = (tabId: number | undefined): chrome.tabs.Tab => {
    if (tabId !== undefined) return find(tabId)

    for (const tab of tabs.values()) if (tab.active) return tab

    throw new Error("No current tab.")
  }

  const strip = (windowId: number): Array<number> => {
    const existing = strips.get(windowId)

    if (existing !== undefined) return existing

    const fresh: Array<number> = []
    strips.set(windowId, fresh)

    return fresh
  }

  const reindex = (windowId: number) => {
    strip(windowId).forEach((tabId, index) => { find(tabId).index = index })
  }

  /** Inserts at `index`, or at the end for -1 and out-of-range positions; returns the position. */
  const insert = (tab: chrome.tabs.Tab, index: number | undefined): number => {
    const ids = strip(tab.windowId)
    const position = index === undefined || index < 0 || index > ids.length ? ids.length : index
    ids.splice(position, 0, tab.id ?? 0)
    reindex(tab.windowId)

    return position
  }

  const detach = (tab: chrome.tabs.Tab): number => {
    const ids = strip(tab.windowId)
    const position = ids.indexOf(tab.id ?? 0)
    ids.splice(position, 1)
    reindex(tab.windowId)

    return position
  }

  const emitUpdated = (tab: chrome.tabs.Tab, changeInfo: chrome.tabs.OnUpdatedInfo) =>
    updated.controls.emit(tab.id ?? 0, changeInfo, structuredClone(tab))

  const create = (properties: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab => {
    const tab = blankTab(nextId++, properties)
    tabs.set(tab.id ?? 0, tab)
    insert(tab, properties.index)

    if (tab.groupId !== -1) groupIds.add(tab.groupId)

    created.controls.emit(structuredClone(tab))

    return structuredClone(tab)
  }

  const matches = (tab: chrome.tabs.Tab, info: chrome.tabs.QueryInfo): boolean =>
    (info.active === undefined || tab.active === info.active)
    && (info.windowId === undefined || tab.windowId === info.windowId)
    && (info.index === undefined || tab.index === info.index)
    && (info.groupId === undefined || tab.groupId === info.groupId)
    && (info.pinned === undefined || tab.pinned === info.pinned)
    && (info.discarded === undefined || tab.discarded === info.discarded)
    && (info.status === undefined || tab.status === info.status)
    && (info.url === undefined || [info.url].flat().includes(tab.url ?? ""))

  const moveTab = (tab: chrome.tabs.Tab, index: number, windowId: number) => {
    const tabId = tab.id ?? 0

    if (windowId !== tab.windowId) {
      const oldWindowId = tab.windowId
      const oldPosition = detach(tab)
      detached.controls.emit(tabId, { oldWindowId, oldPosition })
      tab.windowId = windowId
      attached.controls.emit(tabId, { newWindowId: windowId, newPosition: insert(tab, index) })

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

    const live = new Set(Array.from(tabs.values(), (tab) => tab.groupId))

    for (const id of groupIds) if (!live.has(id)) groupIds.delete(id)
  }

  const api: ChromeTabs.ChromeTabsApi = {
    query: async (info) => Array.from(tabs.values(), (tab) => structuredClone(tab))
      .filter((tab) => matches(tab, info))
      .sort((left, right) => left.windowId - right.windowId || left.index - right.index),
    get: async (tabId) => structuredClone(find(tabId)),
    create: async (properties) => {
      const tab: Partial<chrome.tabs.Tab> = { active: properties.active ?? true }

      if (properties.url !== undefined) tab.url = properties.url

      if (properties.windowId !== undefined) tab.windowId = properties.windowId

      if (properties.index !== undefined) tab.index = properties.index

      if (properties.pinned !== undefined) tab.pinned = properties.pinned

      return create(tab)
    },
    duplicate: async (tabId) => {
      const { id: _id, ...original } = structuredClone(find(tabId))

      return create({ ...original, index: original.index + 1, active: true })
    },
    update: async (tabId, properties) => {
      const tab = find(tabId ?? -1)
      const changeInfo: chrome.tabs.OnUpdatedInfo = {}

      if (properties.url !== undefined) {
        tab.url = properties.url
        changeInfo.url = properties.url
      }

      if (properties.pinned !== undefined && properties.pinned !== tab.pinned) {
        tab.pinned = properties.pinned
        changeInfo.pinned = properties.pinned
      }

      if (properties.active !== undefined) tab.active = properties.active

      emitUpdated(tab, changeInfo)

      return structuredClone(tab)
    },
    move: async (tabIds, { index, windowId }) => {
      const ids = [tabIds].flat()
      const targets = ids.map(find)

      targets.forEach((tab, offset) => {
        moveTab(tab, index < 0 ? -1 : index + offset, windowId ?? tab.windowId)
      })

      return Array.isArray(tabIds) ? targets.map((tab) => structuredClone(tab)) : structuredClone(find(tabIds))
    },
    reload: async (tabId) => {
      const tab = target(tabId)
      tab.status = "loading"
      emitUpdated(tab, { status: "loading" })
      tab.status = "complete"
      emitUpdated(tab, { status: "complete" })
    },
    remove: async (tabIds) => {
      for (const tabId of [tabIds].flat()) {
        const tab = find(tabId)
        detach(tab)
        tabs.delete(tabId)
        zoomFactors.delete(tabId)
        zoomSettings.delete(tabId)
        removed.controls.emit(tabId, { windowId: tab.windowId, isWindowClosing: false })
      }
    },
    group: async ({ tabIds, groupId }) => {
      if (tabIds === undefined) throw new Error("No tabs were given to group.")

      if (groupId !== undefined && !groupIds.has(groupId)) throw new Error(`No group with id: ${groupId}.`)

      const id = groupId ?? nextGroupId++
      groupIds.add(id)
      setGroup([tabIds].flat(), id)

      return id
    },
    ungroup: async (tabIds) => { setGroup([tabIds].flat(), -1) },
    discard: async (tabId) => {
      if (tabId === undefined) throw new Error("Discarding the least important tab is not simulated; pass a tab id.")

      const tab = find(tabId)

      if (!tab.discarded) {
        tab.discarded = true
        emitUpdated(tab, { discarded: true })
      }

      return structuredClone(tab)
    },
    goBack: async (tabId) => {
      target(tabId)

      throw new Error("Cannot find a previous page in history.")
    },
    goForward: async (tabId) => {
      target(tabId)

      throw new Error("Cannot find a next page in history.")
    },
    getZoom: async (tabId) => zoomFactors.get(target(tabId).id ?? 0) ?? 1,
    setZoom: async (tabId, zoomFactor) => {
      const id = target(tabId).id ?? 0
      const oldZoomFactor = zoomFactors.get(id) ?? 1
      const newZoomFactor = zoomFactor === 0 ? 1 : zoomFactor
      zoomFactors.set(id, newZoomFactor)

      if (oldZoomFactor !== newZoomFactor) {
        const settings = { ...defaultZoomSettings, ...zoomSettings.get(id) }
        zoomChanged.controls.emit({ tabId: id, oldZoomFactor, newZoomFactor, zoomSettings: settings })
      }
    },
    getZoomSettings: async (tabId) => ({ ...defaultZoomSettings, ...zoomSettings.get(target(tabId).id ?? 0) }),
    setZoomSettings: async (tabId, settings) => {
      const id = target(tabId).id ?? 0
      const next: chrome.tabs.ZoomSettings = { ...zoomSettings.get(id) }

      if (settings.mode !== undefined) next.mode = settings.mode

      if (settings.scope !== undefined) next.scope = settings.scope

      zoomSettings.set(id, next)
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
    captureVisibleTab: async () => "data:image/jpeg;base64,",
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
      /** Adds a tab without going through `create`; returns it with its id. */
      seed: (properties: Partial<chrome.tabs.Tab> = {}) => create(properties),
      tab: (tabId: number): chrome.tabs.Tab | undefined => tabs.get(tabId),
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
