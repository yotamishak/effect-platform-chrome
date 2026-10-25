import * as ChromeContextMenus from "../ChromeContextMenus.js"
import * as TestEvent from "./Event.js"

type MenuItemId = ChromeContextMenus.MenuItemId

type UpdateProperties = ChromeContextMenus.UpdateProperties

/**
 * An item as the fake stores it: its id, its parent, and its latest properties. For checkbox
 * and radio items `properties.checked` is Chrome's current state; absent means unchecked.
 */
export interface MenuItem {
  readonly id: MenuItemId
  readonly parentId: MenuItemId | undefined
  readonly properties: UpdateProperties
}

export interface ContextMenusOptions {
  /**
   * Behave like an extension whose background is a service worker (or an event page):
   * `create` without an `id` and `create` with an `onclick` fail through `lastError`, as
   * Chrome requires there. Defaults to `false`: an extension without a background context.
   */
  readonly serviceWorker?: boolean
}

/** Chrome's cap on one extension's top-level items (`MenuManager::kMaxItemsPerExtension`). */
const maxTopLevelItems = 1000

const contextTypes: ReadonlySet<string> = new Set<ChromeContextMenus.ContextType>([
  "all", "page", "frame", "selection", "link", "editable", "image", "video", "audio", "launcher",
  "browser_action", "page_action", "action", "tab"
])

const itemTypes: ReadonlySet<string> = new Set<ChromeContextMenus.ItemType>(["normal", "checkbox", "radio", "separator"])

/** Chrome's messages, from chrome/browser/extensions/context_menu_helpers.cc and context_menus_api.cc. */
const messages = {
  idRequired: "Extensions using event pages or Service Workers must pass an id parameter to chrome.contextMenus.create",
  tooManyItems: `An extension can create a maximum of ${maxTopLevelItems} menu items.`,
  onclickDisallowed: "Extensions using event pages or Service Workers cannot pass an onclick parameter to chrome.contextMenus.create. Instead, use the chrome.contextMenus.onClicked event.",
  launcher: "Only packaged apps are allowed to use 'launcher' context",
  titleNeeded: "All menu items except for separators must have a title",
  parentsMustBeNormal: "Parent items must have type \"normal\"",
  checked: "Only items with type \"radio\" or \"checkbox\" can be checked",
  cannotFind: (id: MenuItemId) => `Cannot find menu item with id ${id}`,
  duplicateId: (id: MenuItemId) => `Cannot create item with duplicate id ${id}`,
  invalidUrlPattern: (pattern: string) => `Invalid url pattern '${pattern}'`,
  cannotClick: (id: MenuItemId) =>
    `Chrome cannot click menu item ${id}: it is a separator, or it or an ancestor is disabled or hidden`
}

/** Chrome rejects malformed arguments synchronously, before any callback or Promise. */
const invalidArgument = (method: "create" | "update", property: string, detail: string) =>
  new Error(`Error in invocation of contextMenus.${method}: Error at property '${property}': ${detail}`)

const validateArguments = (method: "create" | "update", properties: UpdateProperties) => {
  const { contexts, type } = properties

  if (contexts !== undefined) {
    if (contexts.length === 0) throw invalidArgument(method, "contexts", "Array must have at least 1 items.")

    for (const context of contexts) {
      if (!contextTypes.has(context)) throw invalidArgument(method, "contexts", `Value must be one of ${Array.from(contextTypes).join(", ")}.`)
    }
  }

  if (type !== undefined && !itemTypes.has(type)) {
    throw invalidArgument(method, "type", `Value must be one of ${Array.from(itemTypes).join(", ")}.`)
  }
}

/** Schemes `url::IsStandard` reports in Chrome (`*` counts as one); they need `://` and a host. */
const standardSchemes: ReadonlySet<string> = new Set([
  "*", "http", "https", "ws", "wss", "ftp", "file", "chrome", "chrome-extension", "chrome-untrusted", "chrome-search",
  "devtools", "isolated-app"
])

/** Schemes with a default port; only these accept a numeric port. */
const schemesWithPorts: ReadonlySet<string> = new Set(["http", "https", "ws", "wss", "ftp"])

/** The forbidden host code points of the URL standard, which Chrome's host canonicalizer refuses. */
const forbiddenHostCharacter = /[\0-\x20#/:<>?@[\\\]^|\x7f]/

const isValidPort = (scheme: string, port: string) => {
  if (port === "*") return true

  return schemesWithPorts.has(scheme) && /^\d+$/.test(port) && Number(port) < 65536
}

/**
 * Chrome's `URLPattern::Parse` with every scheme allowed, as `MenuItem::PopulateURLPatterns`
 * uses it. Host canonicalization is approximated by refusing forbidden host code points.
 */
const isValidUrlPattern = (pattern: string): boolean => {
  if (pattern === "<all_urls>") return true

  const standardSeparator = pattern.indexOf("://")
  const separator = standardSeparator === -1 ? pattern.indexOf(":") : standardSeparator

  if (separator === -1) return false

  const scheme = pattern.slice(0, separator)
  const standard = standardSchemes.has(scheme)

  if (standard !== (standardSeparator !== -1)) return false

  const hostStart = separator + (standard ? 3 : 1)

  if (hostStart >= pattern.length) return false

  if (!standard || scheme === "file") return true

  const hostEnd = pattern.indexOf("/", hostStart)

  if (hostEnd === hostStart || hostEnd === -1) return false

  const hostAndPort = pattern.slice(hostStart, hostEnd)
  let host = hostAndPort
  let port: string | undefined

  if (hostAndPort.startsWith("[")) {
    const close = hostAndPort.indexOf("]")

    if (close === -1) return false

    if (close === 1) return false

    host = hostAndPort.slice(0, close + 1)

    if (close < hostAndPort.length - 1) {
      if (hostAndPort[close + 1] !== ":") return false

      port = hostAndPort.slice(close + 2)
    }

    if (!/^\[[0-9a-fA-F:.]+\]$/.test(host)) return false
  } else {
    const colon = hostAndPort.indexOf(":")

    if (colon !== -1) {
      host = hostAndPort.slice(0, colon)
      port = hostAndPort.slice(colon + 1)
    }
  }

  if (port !== undefined && !isValidPort(scheme, port)) return false

  if (host === "" || host === "*.") return false

  const named = host === "*" ? "" : host.startsWith("*.") ? host.slice(2) : host

  if (named.includes("*")) return false

  return named.startsWith("[") || !forbiddenHostCharacter.test(named)
}

/**
 * `URLPatternSet::Populate`: clears the set, then adds patterns until one fails to parse. Returns
 * the patterns kept and the error for the first invalid one.
 */
interface PopulatedPatterns {
  readonly kept: Array<string>
  readonly error: string | undefined
}

const populatePatterns = (patterns: ReadonlyArray<string>): PopulatedPatterns => {
  const invalid = patterns.findIndex((pattern) => !isValidUrlPattern(pattern))

  if (invalid === -1) return { kept: [...patterns], error: undefined }

  return { kept: patterns.slice(0, invalid), error: messages.invalidUrlPattern(patterns[invalid] ?? "") }
}

const typeOf = (item: MenuItem): ChromeContextMenus.ItemType => item.properties.type ?? "normal"

const isCheckable = (item: MenuItem) => typeOf(item) === "checkbox" || typeOf(item) === "radio"

/**
 * An in-memory context-menu tree that follows Chrome's `MenuManager`:
 *
 * - `create` returns the id at once (the given `id`, or the next of increasing generated
 *   numbers) and runs its callback in a microtask, with `lastError` set for what Chrome
 *   reports there: a duplicate id, an unknown or non-`"normal"` parent, a missing title on a
 *   non-separator, a `"launcher"` context, an invalid URL pattern, 1000 existing top-level
 *   items, and, with
 *   `options.serviceWorker`, a missing `id` or an `onclick`. An empty or unknown `contexts`
 *   entry or `type` throws synchronously, for `create` and `update` alike.
 * - `update` and `remove` reject an unknown id. `update` applies fields in Chrome's order and
 *   keeps the ones applied before a failure (an empty title on a non-separator, `checked: true`
 *   on an item that is not a checkbox or radio, a launcher context, an unknown or
 *   non-`"normal"` parent, an invalid URL pattern, which keeps the patterns before it); a
 *   `parentId` that is the item or its descendant resolves without
 *   moving it, as Chrome does. A moved item goes last among its new siblings.
 * - `remove` also removes descendants; `removeAll` removes everything.
 * - Radio items behave as in Chrome: each run of adjacent radio siblings keeps exactly one
 *   checked item, re-established after every create, move and removal.
 * - URL patterns follow Chrome's `URLPattern` parser: `<all_urls>`, or a scheme, `://` and a
 *   host (`*`, `*.` plus a domain, or a name, with an optional port) and a path for standard
 *   schemes; `file:` needs no host and non-standard schemes such as `data:` take `:` and a path.
 * - `controls.click` emits `onClicked` for an existing item, toggling a checkbox or selecting a
 *   radio as Chrome does. It throws for a click Chrome's menu cannot produce: a separator, or an
 *   item that is, or sits under, a disabled or hidden item. Stored `onclick` handlers are not
 *   called.
 *
 * Pass `overrides` to replace any member.
 */
export const makeContextMenus = (
  overrides: Partial<ChromeContextMenus.ChromeContextMenusApi> = {},
  options: ContextMenusOptions = {}
) => {
  const items = new Map<MenuItemId, MenuItem>()
  const topLevel: Array<MenuItemId> = []
  const childLists = new Map<MenuItemId, Array<MenuItemId>>()
  const clicked = TestEvent.makeEvent<[ChromeContextMenus.OnClickData, chrome.tabs.Tab?]>()
  const serviceWorker = options.serviceWorker ?? false
  let lastError: chrome.runtime.LastError | undefined
  let nextId = 1

  const find = (id: MenuItemId): MenuItem => {
    const item = items.get(id)

    if (item === undefined) throw new Error(messages.cannotFind(id))

    return item
  }

  /** The ordered list an item with this parent belongs to. */
  const siblings = (parentId: MenuItemId | undefined): Array<MenuItemId> => {
    if (parentId === undefined) return topLevel

    const existing = childLists.get(parentId)

    if (existing !== undefined) return existing

    const list: Array<MenuItemId> = []
    childLists.set(parentId, list)

    return list
  }

  const patch = (id: MenuItemId, properties: UpdateProperties) => {
    const item = find(id)
    items.set(id, { ...item, properties: { ...item.properties, ...properties } })
  }

  /** Chrome's `MenuItem::SetChecked`: only checkbox and radio items hold a state. */
  const setChecked = (id: MenuItemId, checked: boolean) => {
    const item = find(id)

    if (isCheckable(item) && (item.properties.checked === true) !== checked) patch(id, { checked })
  }

  const isRadio = (id: MenuItemId) => typeOf(find(id)) === "radio"

  /** Unchecks the radio items next to `index`, walking in `step` direction until a non-radio. */
  const uncheckAdjacent = (list: ReadonlyArray<MenuItemId>, index: number, step: -1 | 1) => {
    for (let at = index + step; ; at += step) {
      const sibling = list[at]

      if (sibling === undefined || !isRadio(sibling)) return

      setChecked(sibling, false)
    }
  }

  /** Chrome's `RadioItemSelected`: unchecks the radio items adjacent to a selected one. */
  const radioSelected = (id: MenuItemId) => {
    const list = siblings(find(id).parentId)
    const index = list.indexOf(id)
    uncheckAdjacent(list, index, -1)
    uncheckAdjacent(list, index, 1)
  }

  /** Chrome's `SanitizeRadioListsInMenu`: one checked item per run, the last checked or else the first. */
  const sanitize = (list: ReadonlyArray<MenuItemId>) => {
    let run: Array<MenuItemId> = []

    const settleRun = () => {
      const checked = run.filter((id) => find(id).properties.checked === true)

      for (const id of checked) setChecked(id, false)

      const chosen = checked.at(-1) ?? run[0]

      if (chosen !== undefined) setChecked(chosen, true)

      run = []
    }

    for (const id of list) {
      if (isRadio(id)) {
        run.push(id)
      } else {
        settleRun()
      }
    }

    settleRun()
  }

  const subtree = (id: MenuItemId): Array<MenuItemId> => {
    const ids: Array<MenuItemId> = []
    const pending = [id]

    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      ids.push(next)
      pending.push(...(childLists.get(next) ?? []))
    }

    return ids
  }

  const isDescendant = (id: MenuItemId, ancestor: MenuItemId) => {
    for (let parent = items.get(id)?.parentId; parent !== undefined; parent = items.get(parent)?.parentId) {
      if (parent === ancestor) return true
    }

    return false
  }

  /**
   * Chrome's menu never offers a separator as a command, greys out a disabled item, and shows
   * neither a hidden item nor anything under a hidden or disabled submenu.
   */
  const isClickable = (item: MenuItem) => {
    if (typeOf(item) === "separator") return false

    for (let at: MenuItem | undefined = item; at !== undefined; at = at.parentId === undefined ? undefined : items.get(at.parentId)) {
      if (at.properties.enabled === false || at.properties.visible === false) return false
    }

    return true
  }

  const detach = (id: MenuItemId) => {
    const list = siblings(find(id).parentId)
    list.splice(list.indexOf(id), 1)
    sanitize(list)
  }

  /** The parent's error, if any, in Chrome's `GetParent` order. */
  const parentError = (parentId: MenuItemId): string | undefined => {
    const parent = items.get(parentId)

    if (parent === undefined) return messages.cannotFind(parentId)

    return typeOf(parent) === "normal" ? undefined : messages.parentsMustBeNormal
  }

  const createError = (
    id: MenuItemId,
    generated: boolean,
    parentId: MenuItemId | undefined,
    properties: UpdateProperties
  ): string | undefined => {
    if (generated && serviceWorker) return messages.idRequired

    if (topLevel.length >= maxTopLevelItems) return messages.tooManyItems

    if (items.has(id)) return messages.duplicateId(id)

    if (serviceWorker && properties.onclick !== undefined) return messages.onclickDisallowed

    if (properties.contexts?.includes("launcher") === true) return messages.launcher

    if ((properties.title ?? "") === "" && properties.type !== "separator") return messages.titleNeeded

    const patternError = populatePatterns(properties.documentUrlPatterns ?? []).error ??
      populatePatterns(properties.targetUrlPatterns ?? []).error

    if (patternError !== undefined) return patternError

    return parentId === undefined ? undefined : parentError(parentId)
  }

  const insert = (item: MenuItem) => {
    items.set(item.id, item)
    const list = siblings(item.parentId)
    list.push(item.id)

    if (typeOf(item) !== "radio") return

    if (item.parentId === undefined && item.properties.checked === true) {
      radioSelected(item.id)
    } else {
      sanitize(list)
    }
  }

  /** Chrome sets lastError only while the callback runs. */
  const settle = (callback: () => void, error: string | undefined) => {
    queueMicrotask(() => {
      lastError = error === undefined ? undefined : { message: error }

      try { callback() } finally { lastError = undefined }
    })
  }

  /** Chrome's `UpdateMenuItem`, field by field; earlier fields stay applied when a later one fails. */
  const applyUpdate = async (id: MenuItemId, updateProperties: UpdateProperties) => {
    const item = find(id)
    const currentType = typeOf(item)
    const type = updateProperties.type ?? currentType
    let radioUpdated = false

    const finish = () => {
      if (updateProperties.onclick !== undefined) patch(id, { onclick: updateProperties.onclick })
    }

    if (updateProperties.type !== undefined) {
      radioUpdated = type !== currentType && (type === "radio" || currentType === "radio")
      patch(id, { type })
    }

    if (updateProperties.title !== undefined) {
      if (updateProperties.title === "" && type !== "separator") throw new Error(messages.titleNeeded)

      patch(id, { title: updateProperties.title })
    }

    if (updateProperties.checked !== undefined) {
      const checked = updateProperties.checked

      if (checked && type !== "checkbox" && type !== "radio") throw new Error(messages.checked)

      if ((type === "radio" && checked) || type === "checkbox") {
        patch(id, { checked })
        radioUpdated = true
      }
    }

    if (updateProperties.visible !== undefined) patch(id, { visible: updateProperties.visible })

    if (updateProperties.enabled !== undefined) patch(id, { enabled: updateProperties.enabled })

    if (updateProperties.contexts !== undefined) {
      if (updateProperties.contexts.includes("launcher")) throw new Error(messages.launcher)

      patch(id, { contexts: updateProperties.contexts })
    }

    if (updateProperties.parentId !== undefined) {
      const parentId = updateProperties.parentId
      const error = parentError(parentId)

      if (error !== undefined) throw new Error(error)

      // Chrome's ChangeParent refuses a cycle with an empty error, which resolves the call.
      if (parentId === id || isDescendant(parentId, id)) return finish()

      detach(id)
      items.set(id, { ...find(id), parentId })
      siblings(parentId).push(id)
      sanitize(siblings(parentId))
    }

    for (const field of ["documentUrlPatterns", "targetUrlPatterns"] as const) {
      const patterns = updateProperties[field]

      if (patterns === undefined) continue

      // Chrome clears the set, then keeps the patterns parsed before an invalid one.
      const { kept, error } = populatePatterns(patterns)
      patch(id, { [field]: kept })

      if (error !== undefined) throw new Error(error)
    }

    const updated = find(id)

    if (radioUpdated && typeOf(updated) === "radio" && updated.properties.checked === true) radioSelected(id)

    finish()
  }

  const api: ChromeContextMenus.ChromeContextMenusApi = {
    create: (createProperties, callback) => {
      validateArguments("create", createProperties)
      const { id: requestedId, parentId, ...properties } = createProperties
      const id = requestedId ?? nextId++
      const error = createError(id, requestedId === undefined, parentId, properties)

      if (error === undefined) insert({ id, parentId, properties })

      settle(callback, error)

      return id
    },
    update: (id, updateProperties) => {
      validateArguments("update", updateProperties)

      return applyUpdate(id, updateProperties)
    },
    remove: async (menuItemId) => {
      find(menuItemId)
      const removed = subtree(menuItemId)
      detach(menuItemId)

      for (const id of removed) {
        items.delete(id)
        childLists.delete(id)
      }
    },
    removeAll: async () => {
      items.clear()
      childLists.clear()
      topLevel.length = 0
    },
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
      /** The ids of a parent's children in menu order, or the top-level ids without a parent. */
      children: (parentId?: MenuItemId): Array<MenuItemId> => [...(parentId === undefined ? topLevel : childLists.get(parentId) ?? [])],
      /**
       * Emits `onClicked` for an existing item Chrome would show as a command (not a separator,
       * and neither it nor an ancestor disabled or hidden), filling `menuItemId`, `parentMenuItemId`,
       * `editable: false` and the tab's URL as `pageUrl`. A checkbox toggles and a radio is
       * selected (unchecking its adjacent radios), with `wasChecked` and `checked` filled as
       * Chrome does. `info` overrides any field. Returns the exceptions listeners threw.
       */
      click: (menuItemId: MenuItemId, info: Partial<ChromeContextMenus.OnClickData> = {}, tab?: chrome.tabs.Tab) => {
        const item = find(menuItemId)

        if (!isClickable(item)) throw new Error(messages.cannotClick(menuItemId))
        const data: ChromeContextMenus.OnClickData = { menuItemId, editable: false }

        if (item.parentId !== undefined) data.parentMenuItemId = item.parentId

        if (tab?.url !== undefined) data.pageUrl = tab.url

        if (isCheckable(item)) {
          const wasChecked = item.properties.checked === true
          const checked = typeOf(item) === "radio" || !wasChecked

          if (typeOf(item) === "radio") radioSelected(menuItemId)

          setChecked(menuItemId, checked)
          data.wasChecked = wasChecked
          data.checked = checked
        }

        return clicked.controls.emit({ ...data, ...info }, tab)
      },
      onClicked: clicked.controls
    }
  }
}
