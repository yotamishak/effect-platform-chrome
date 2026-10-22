import * as ChromeContextMenus from "../ChromeContextMenus.js"
import * as TestEvent from "./Event.js"

type MenuItemId = ChromeContextMenus.MenuItemId

/** An item as the fake stores it: its id, its parent, and its latest properties. */
export interface MenuItem {
  readonly id: MenuItemId
  readonly parentId: MenuItemId | undefined
  readonly properties: ChromeContextMenus.UpdateProperties
}

/**
 * An in-memory context-menu tree. `create` returns the id at once and runs its callback in a
 * microtask, with `lastError` set for a duplicate id or an unknown parent, as Chrome does.
 * Generated ids are increasing numbers. `remove` also removes descendants and rejects an unknown
 * id, like `update`. `controls.click` simulates a click on an existing item. Pass `overrides` to
 * replace any member.
 */
export const makeContextMenus = (overrides: Partial<ChromeContextMenus.ChromeContextMenusApi> = {}) => {
  const items = new Map<MenuItemId, MenuItem>()
  const clicked = TestEvent.makeEvent<[ChromeContextMenus.OnClickData, chrome.tabs.Tab?]>()
  let lastError: chrome.runtime.LastError | undefined
  let nextId = 1

  const notFound = (id: MenuItemId) => new Error(`Cannot find menu item with id ${id}`)

  const find = (id: MenuItemId): MenuItem => {
    const item = items.get(id)

    if (item === undefined) throw notFound(id)

    return item
  }

  /** Chrome sets lastError only while the callback runs. */
  const settle = (callback: () => void, error: string | undefined) => {
    queueMicrotask(() => {
      lastError = error === undefined ? undefined : { message: error }

      try { callback() } finally { lastError = undefined }
    })
  }

  const createError = (id: MenuItemId, parentId: MenuItemId | undefined): string | undefined => {
    if (items.has(id)) return `Cannot create item with duplicate id ${id}`

    if (parentId !== undefined && !items.has(parentId)) return `Cannot find menu item with id ${parentId}`

    return undefined
  }

  const descendants = (id: MenuItemId): Array<MenuItemId> => Array.from(items.values())
    .filter((item) => item.parentId === id)
    .flatMap((item) => [item.id, ...descendants(item.id)])

  const api: ChromeContextMenus.ChromeContextMenusApi = {
    create: (createProperties, callback) => {
      const { id: requestedId, parentId, ...properties } = createProperties
      const id = requestedId ?? nextId++
      const error = createError(id, parentId)

      if (error === undefined) items.set(id, { id, parentId, properties })

      settle(callback, error)

      return id
    },
    update: async (id, updateProperties) => {
      const item = find(id)
      const { parentId = item.parentId, ...properties } = updateProperties

      if (parentId !== undefined && !items.has(parentId)) throw notFound(parentId)

      items.set(id, { id, parentId, properties: { ...item.properties, ...properties } })
    },
    remove: async (menuItemId) => {
      find(menuItemId)

      for (const id of [menuItemId, ...descendants(menuItemId)]) items.delete(id)
    },
    removeAll: async () => { items.clear() },
    onClicked: clicked.api,
    get lastError() { return lastError },
    ...overrides
  }

  return {
    api,
    layer: ChromeContextMenus.layer(api),
    controls: {
      item: (id: MenuItemId): MenuItem | undefined => items.get(id),
      /** Every item in creation order. */
      items: (): Array<MenuItem> => Array.from(items.values()),
      /**
       * Emits `onClicked` for an existing item, filling `menuItemId`, `parentMenuItemId`,
       * `editable: false` and the tab's URL as `pageUrl`; `info` overrides any of them.
       * Returns the exceptions listeners threw.
       */
      click: (menuItemId: MenuItemId, info: Partial<ChromeContextMenus.OnClickData> = {}, tab?: chrome.tabs.Tab) => {
        const item = find(menuItemId)
        const data: ChromeContextMenus.OnClickData = { menuItemId, editable: false }

        if (item.parentId !== undefined) data.parentMenuItemId = item.parentId

        if (tab?.url !== undefined) data.pageUrl = tab.url

        return clicked.controls.emit({ ...data, ...info }, tab)
      },
      onClicked: clicked.controls
    }
  }
}
