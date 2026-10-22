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

/** A connection a test opened with the fake `connect`; serve or answer it through `pair`. */
export interface TabConnection {
  readonly tabId: number
  readonly connectInfo: chrome.tabs.ConnectInfo | undefined
  readonly pair: ReturnType<typeof TestPort.makePortPair>
}

/**
 * An in-memory tab strip. Tabs keep the properties they were created or updated with;
 * `query` matches `active`, `windowId` and exact `url`s. `sendMessage` fails as Chrome does
 * with no receiver, `connect` returns one end of a port pair (the other end is in
 * `controls.connections`), and `captureVisibleTab` returns an empty JPEG data URL. Pass
 * `overrides` to replace any member, such as a `get` that models a slow navigation.
 */
export const makeTabs = (overrides: Partial<ChromeTabs.ChromeTabsApi> = {}) => {
  const tabs = new Map<number, chrome.tabs.Tab>()
  const connections: Array<TabConnection> = []
  const created = TestEvent.makeEvent<[chrome.tabs.Tab]>()
  const updated = TestEvent.makeEvent<[number, chrome.tabs.OnUpdatedInfo, chrome.tabs.Tab]>()
  const removed = TestEvent.makeEvent<[number, chrome.tabs.OnRemovedInfo]>()
  const activated = TestEvent.makeEvent<[chrome.tabs.OnActivatedInfo]>()
  let nextId = 1

  const find = (tabId: number): chrome.tabs.Tab => {
    const tab = tabs.get(tabId)

    if (tab === undefined) throw new Error(`No tab with id: ${tabId}.`)

    return tab
  }

  const create = (properties: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab => {
    const tab = blankTab(nextId++, properties)
    tabs.set(tab.id ?? 0, tab)
    created.controls.emit(structuredClone(tab))

    return structuredClone(tab)
  }

  const matches = (tab: chrome.tabs.Tab, info: chrome.tabs.QueryInfo): boolean =>
    (info.active === undefined || tab.active === info.active)
    && (info.windowId === undefined || tab.windowId === info.windowId)
    && (info.url === undefined || [info.url].flat().includes(tab.url ?? ""))

  const api: ChromeTabs.ChromeTabsApi = {
    query: async (info) => Array.from(tabs.values(), (tab) => structuredClone(tab)).filter((tab) => matches(tab, info)),
    get: async (tabId) => structuredClone(find(tabId)),
    create: async (properties) => {
      const tab: Partial<chrome.tabs.Tab> = { active: properties.active ?? true }

      if (properties.url !== undefined) tab.url = properties.url

      if (properties.windowId !== undefined) tab.windowId = properties.windowId

      return create(tab)
    },
    update: async (tabId, properties) => {
      const tab = find(tabId ?? -1)
      const changeInfo: chrome.tabs.OnUpdatedInfo = {}

      if (properties.url !== undefined) {
        tab.url = properties.url
        changeInfo.url = properties.url
      }

      if (properties.active !== undefined) tab.active = properties.active

      updated.controls.emit(tab.id ?? 0, changeInfo, structuredClone(tab))

      return structuredClone(tab)
    },
    remove: async (tabIds) => {
      for (const tabId of [tabIds].flat()) {
        const tab = find(tabId)
        tabs.delete(tabId)
        removed.controls.emit(tabId, { windowId: tab.windowId, isWindowClosing: false })
      }
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
      onActivated: activated.controls
    }
  }
}
