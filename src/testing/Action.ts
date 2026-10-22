import * as ChromeAction from "../ChromeAction.js"
import * as TestEvent from "./Event.js"

/** The action's visible state for one tab, after falling back to the defaults. */
export interface ActionState {
  readonly badgeText: string
  readonly badgeBackgroundColor: ChromeAction.ColorArray
  readonly badgeTextColor: ChromeAction.ColorArray
  readonly title: string
  /** The popup as an absolute `chrome-extension://` URL, or an empty string without one. */
  readonly popup: string
  readonly enabled: boolean
  /** The last `setIcon` details that apply, if any; Chrome cannot report icons back. */
  readonly icon: chrome.action.TabIconDetails | undefined
}

/** What the manifest's `action` key would declare: `default_title` and `default_popup`. */
export interface ActionManifest {
  readonly title?: string
  /** Relative to the extension root, as in the manifest. */
  readonly popup?: string
}

/** The manifest's action defaults plus the extension id that popup URLs resolve against. */
export interface ActionOptions extends ActionManifest {
  /** Defaults to `test-extension`, giving popups such as `chrome-extension://test-extension/popup.html`. */
  readonly extensionId?: string
}

/** The result of a simulated toolbar click. */
export type ClickOutcome = "clicked" | "popup" | "disabled"

type Overrides = { -readonly [Key in keyof ActionState]?: ActionState[Key] }

/** Chrome's badge text limit, in UTF-8 bytes. */
export const maxBadgeTextBytes = 100

const transparent: ChromeAction.ColorArray = [0, 0, 0, 0]

const invalidColor = "The color specification could not be parsed."

const imageDataError = "The imageData property must contain an ImageData object or dictionary of ImageData objects."

/**
 * Chrome's own ImageData sniff: an object with `width`, `height` and `data`. Untyped callers
 * may pass anything, so a primitive is refused before `in` could throw on it.
 */
const looksLikeImageData = (value: chrome.action.TabIconDetails["imageData"]): boolean =>
  value instanceof Object && "width" in value && "height" in value && "data" in value

/**
 * Chrome's setIcon bindings run before the request reaches the browser: `imageData` wins over
 * `path`, a dictionary needs at least one entry, and every `imageData` entry must look like
 * ImageData. Loading a `path` is not modelled.
 */
const checkIcon = (details: chrome.action.TabIconDetails) => {
  if ("imageData" in details) {
    const { imageData } = details

    if (looksLikeImageData(imageData)) return

    const entries: ReadonlyArray<ImageData> = imageData instanceof Object ? Object.values(imageData) : []

    if (entries.length === 0 || !entries.every(looksLikeImageData)) throw new Error(imageDataError)

    return
  }

  if ("path" in details) {
    if (details.path instanceof Object && Object.keys(details.path).length === 0) {
      throw new Error("The path property must not be empty.")
    }

    return
  }

  throw new Error("Either the path or imageData property must be specified.")
}

const isChannel = (value: number) => Number.isInteger(value) && value >= 0 && value <= 255

const hexColor = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

const rgbColor = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$|^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/

const channels = (values: ReadonlyArray<number>): ChromeAction.ColorArray | undefined => {
  const [red, green, blue, alpha] = values

  return red === undefined || green === undefined || blue === undefined || alpha === undefined
    ? undefined
    : [red, green, blue, alpha]
}

/** `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`; short forms double each digit, alpha defaults to opaque. */
const parseHex = (color: string): ChromeAction.ColorArray | undefined => {
  const digits = color.slice(1)
  const full = digits.length <= 4 ? Array.from(digits, (digit) => digit + digit).join("") : digits
  const pairs = (full.length === 6 ? `${full}ff` : full).match(/../g) ?? []

  return channels(pairs.map((pair) => Number.parseInt(pair, 16)))
}

/** `rgb(r, g, b)` or `rgba(r, g, b, a)`: integer channels up to 255, `a` from 0 to 1, spaces only after commas. */
const parseRgb = (color: string): ChromeAction.ColorArray | undefined => {
  const match = rgbColor.exec(color)

  if (match === null) return undefined

  const parts = match.slice(1).filter((part) => part !== undefined)
  const [red = Number.NaN, green = Number.NaN, blue = Number.NaN] = parts.slice(0, 3).map(Number)
  const alpha = parts.length === 4 ? Number(parts[3]) : 1

  if (![red, green, blue].every(isChannel) || Number.isNaN(alpha) || alpha < 0 || alpha > 1) return undefined

  // Chrome converts the alpha fraction by truncation, as a C++ float-to-byte conversion does.
  return [red, green, blue, Math.trunc(alpha * 255)]
}

/**
 * Parses colors as Chrome does: an array must hold four integers from 0 to 255; strings may
 * be `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(r, g, b)` or `rgba(r, g, b, a)`. Chrome also
 * accepts `hsl()`, `hsla()` and color names, which the fixture refuses with its own error.
 */
const parseColor = (color: string | ChromeAction.ColorArray): ChromeAction.ColorArray => {
  if (Array.isArray(color)) {
    const parsed = color.length === 4 && color.every(isChannel) ? channels(color) : undefined

    if (parsed === undefined) throw new TypeError("Error at property 'color': expected four integers from 0 to 255.")

    return parsed
  }

  if (color.startsWith("hsl") || /^[a-z]+$/i.test(color)) {
    throw new Error(`The action fixture parses hex, rgb() and rgba() colors only, not ${color}; override the setter to accept it.`)
  }

  const parsed = hexColor.test(color) ? parseHex(color) : parseRgb(color)

  if (parsed === undefined) throw new Error(invalidColor)

  return parsed
}

/**
 * An in-memory toolbar action. Setters with a `tabId` override that tab, without one they
 * change the default; getters fall back from a tab to the default, as Chrome does. Badge
 * colors start transparent; title and popup start from the manifest, and popups are reported
 * as absolute `chrome-extension://<extensionId>/…` URLs. Chrome's checks are modelled: a
 * negative or fractional tab id, a tab closed with `controls.closeTab`, an unparseable or (for
 * the text color) fully transparent color, badge text over 100 bytes, a popup outside the
 * extension and setIcon details without an image all reject. Icons are copied when set, and
 * `controls.state` returns fresh copies. `controls.click` models a toolbar click: it opens the
 * popup when one is set, otherwise fires `onClicked`. `openPopup` fails unless the action is
 * enabled and has a popup on the active tab (`controls.activateTab`, the defaults until one is
 * set); windows are not modelled. Pass `overrides` to replace any member.
 */
export const makeAction = (options: ActionOptions = {}, overrides: Partial<ChromeAction.ChromeActionApi> = {}) => {
  const origin = `chrome-extension://${options.extensionId ?? "test-extension"}/`
  const tabs = new Map<number, Overrides>()
  const closed = new Set<number>()
  const clicked = TestEvent.makeEvent<[chrome.tabs.Tab]>()
  const settingsChanged = TestEvent.makeEvent<[chrome.action.UserSettingsChange]>()
  const openedPopups: Array<chrome.action.OpenPopupOptions | undefined> = []
  let userSettings: chrome.action.UserSettings = { isOnToolbar: false }
  let activeTabId: number | undefined

  /** Resolves a popup path against the extension, as Chrome does; empty means no popup. */
  const resolvePopup = (popup: string): string => {
    if (popup === "") return ""

    const url = new URL(popup, origin)

    if (url.protocol !== "chrome-extension:") throw new Error(`Invalid value for 'popup': ${popup}`)

    return url.href
  }

  const defaults: Overrides = { title: options.title ?? "", popup: resolvePopup(options.popup ?? "") }

  /** Chrome's schema requires a non-negative integer tab id. */
  const checkTabSchema = (tabId: number | null | undefined) => {
    if (tabId === undefined || tabId === null) return

    if (!Number.isInteger(tabId) || tabId < 0) throw new TypeError(`Error at property 'tabId': ${tabId} is not an integer of at least 0.`)
  }

  /** The schema check, then the browser's lookup: the tab must be open. */
  const checkTab = (tabId: number | null | undefined) => {
    checkTabSchema(tabId)

    if (tabId !== undefined && tabId !== null && closed.has(tabId)) throw new Error(`No tab with id: ${tabId}.`)
  }

  const scope = (tabId: number | null | undefined): Overrides => {
    checkTab(tabId)

    if (tabId === undefined || tabId === null) return defaults

    const existing = tabs.get(tabId)

    if (existing !== undefined) return existing

    const created: Overrides = {}
    tabs.set(tabId, created)

    return created
  }

  const state = (tabId?: number): ActionState => {
    const tab = tabId === undefined ? {} : tabs.get(tabId) ?? {}
    const icon = tab.icon ?? defaults.icon

    // Fresh copies, so a caller mutating a snapshot changes neither this fixture nor another.
    return {
      badgeText: tab.badgeText ?? defaults.badgeText ?? "",
      badgeBackgroundColor: [...tab.badgeBackgroundColor ?? defaults.badgeBackgroundColor ?? transparent],
      badgeTextColor: [...tab.badgeTextColor ?? defaults.badgeTextColor ?? transparent],
      title: tab.title ?? defaults.title ?? "",
      popup: tab.popup ?? defaults.popup ?? "",
      enabled: tab.enabled ?? defaults.enabled ?? true,
      icon: icon === undefined ? undefined : structuredClone(icon)
    }
  }

  const read = (tabId: number | undefined): ActionState => {
    checkTab(tabId)

    return state(tabId)
  }

  /**
   * Checks in Chrome's order: the schema (a color array, the tab id) before looking the tab
   * up, and a color string only after that.
   */
  const colorTarget = (tabId: number | undefined, color: string | ChromeAction.ColorArray) => {
    const checked = Array.isArray(color) ? parseColor(color) : undefined
    const target = scope(tabId)

    return [target, checked ?? parseColor(color)] as const
  }

  const api: ChromeAction.ChromeActionApi = {
    setBadgeText: async ({ tabId, text }) => {
      const target = scope(tabId)

      if (text === undefined) {
        // Omitting the text reverts a tab to the default and clears the default.
        delete target.badgeText

        return
      }

      const bytes = new TextEncoder().encode(text).length

      if (bytes > maxBadgeTextBytes) {
        throw new Error(`Badge text size is ${bytes} bytes which exceeds the limit of ${maxBadgeTextBytes} bytes.`)
      }

      target.badgeText = text
    },
    getBadgeText: async ({ tabId }) => read(tabId).badgeText,
    setBadgeBackgroundColor: async ({ tabId, color }) => {
      const [target, parsed] = colorTarget(tabId, color)
      target.badgeBackgroundColor = parsed
    },
    getBadgeBackgroundColor: async ({ tabId }) => [...read(tabId).badgeBackgroundColor],
    setBadgeTextColor: async ({ tabId, color }) => {
      const [target, parsed] = colorTarget(tabId, color)

      if (parsed[3] === 0) throw new Error(invalidColor)

      target.badgeTextColor = parsed
    },
    getBadgeTextColor: async ({ tabId }) => [...read(tabId).badgeTextColor],
    setIcon: async (details) => {
      checkTabSchema(details.tabId)
      checkIcon(details)
      // Chrome converts the icon when called, so later changes to the caller's details are not seen.
      scope(details.tabId).icon = structuredClone(details)
    },
    setTitle: async ({ tabId, title }) => { scope(tabId).title = title },
    getTitle: async ({ tabId }) => read(tabId).title,
    setPopup: async ({ tabId, popup }) => {
      const target = scope(tabId)
      target.popup = resolvePopup(popup)
    },
    getPopup: async ({ tabId }) => read(tabId).popup,
    enable: async (tabId) => { scope(tabId).enabled = true },
    disable: async (tabId) => { scope(tabId).enabled = false },
    isEnabled: async (tabId) => read(tabId).enabled,
    openPopup: async (popupOptions) => {
      const active = state(activeTabId)

      // Chrome also refuses when the action is disabled on the active tab.
      if (active.popup === "" || !active.enabled) throw new Error("Extension does not have a popup on the active tab.")

      openedPopups.push(popupOptions === undefined ? undefined : { ...popupOptions })
    },
    getUserSettings: async () => ({ ...userSettings }),
    onClicked: clicked.api,
    onUserSettingsChanged: settingsChanged.api,
    ...overrides
  }

  return {
    api,
    layer: ChromeAction.layer(api),
    controls: {
      /** The state a tab sees, or the defaults without a tab id. */
      state,
      /**
       * Drops a tab's overrides, as Chrome does when the tab closes. Chrome never reuses tab
       * ids, so later calls naming the tab reject with `No tab with id: …`.
       */
      closeTab: (tabId: number) => {
        tabs.delete(tabId)
        closed.add(tabId)

        if (activeTabId === tabId) activeTabId = undefined
      },
      /** Sets the tab whose popup `openPopup` opens; `undefined` falls back to the defaults. */
      activateTab: (tabId: number | undefined) => { activeTabId = tabId },
      /** Simulates a toolbar click in `tab`, firing `onClicked` only when no popup is set. */
      click: (tab: chrome.tabs.Tab): ClickOutcome => {
        const current = state(tab.id)

        if (!current.enabled) return "disabled"

        if (current.popup !== "") return "popup"

        clicked.controls.emit(tab)

        return "clicked"
      },
      /** Applies a settings change and fires `onUserSettingsChanged` with it. */
      changeUserSettings: (change: chrome.action.UserSettingsChange) => {
        userSettings = { isOnToolbar: change.isOnToolbar ?? userSettings.isOnToolbar }
        settingsChanged.controls.emit(change)
      },
      /** The options of every successful `openPopup` call, in order. */
      openedPopups,
      onClicked: clicked.controls,
      onUserSettingsChanged: settingsChanged.controls
    }
  }
}
