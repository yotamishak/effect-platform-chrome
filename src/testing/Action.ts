import * as ChromeAction from "../ChromeAction.js"
import * as TestEvent from "./Event.js"

/** The action's visible state for one tab, after falling back to the defaults. */
export interface ActionState {
  readonly badgeText: string
  readonly badgeBackgroundColor: ChromeAction.ColorArray
  readonly badgeTextColor: ChromeAction.ColorArray
  readonly title: string
  readonly popup: string
  readonly enabled: boolean
  /** The last `setIcon` details that apply, if any; Chrome cannot report icons back. */
  readonly icon: chrome.action.TabIconDetails | undefined
}

/** What the manifest's `action` key would declare: `default_title` and `default_popup`. */
export interface ActionManifest {
  readonly title?: string
  readonly popup?: string
}

/** The result of a simulated toolbar click. */
export type ClickOutcome = "clicked" | "popup" | "disabled"

type Overrides = { -readonly [Key in keyof ActionState]?: ActionState[Key] }

const transparent: ChromeAction.ColorArray = [0, 0, 0, 0]

const channel = (hex: string): number => Number.parseInt(hex.length === 1 ? hex + hex : hex, 16)

/** Chrome accepts any CSS color; the fixture parses `#rgb` and `#rrggbb` only. */
const parseColor = (color: string | ChromeAction.ColorArray): ChromeAction.ColorArray => {
  if (Array.isArray(color)) return [color[0], color[1], color[2], color[3]]

  const digits = /^#(?:([0-9a-f]{3})|([0-9a-f]{6}))$/i.exec(color)
  const hex = digits?.[1] ?? digits?.[2]

  if (hex === undefined) throw new Error(`The action fixture parses only #rgb and #rrggbb colors, not ${color}`)

  const size = hex.length / 3

  return [channel(hex.slice(0, size)), channel(hex.slice(size, 2 * size)), channel(hex.slice(2 * size)), 255]
}

/**
 * An in-memory toolbar action. Setters with a `tabId` override that tab, without one they
 * change the default; getters fall back from a tab to the default, as Chrome does. Badge
 * colors start transparent; title and popup start from `manifest`. `controls.click` models a
 * toolbar click: it opens the popup when one is set, otherwise fires `onClicked`. `openPopup`
 * fails without a default popup. Pass `overrides` to replace any member.
 */
export const makeAction = (manifest: ActionManifest = {}, overrides: Partial<ChromeAction.ChromeActionApi> = {}) => {
  const defaults: Overrides = { title: manifest.title ?? "", popup: manifest.popup ?? "" }
  const tabs = new Map<number, Overrides>()
  const clicked = TestEvent.makeEvent<[chrome.tabs.Tab]>()
  const settingsChanged = TestEvent.makeEvent<[chrome.action.UserSettingsChange]>()
  const openedPopups: Array<chrome.action.OpenPopupOptions | undefined> = []
  let userSettings: chrome.action.UserSettings = { isOnToolbar: false }

  const scope = (tabId: number | null | undefined): Overrides => {
    if (tabId === undefined || tabId === null) return defaults

    const existing = tabs.get(tabId)

    if (existing !== undefined) return existing

    const created: Overrides = {}
    tabs.set(tabId, created)

    return created
  }

  const state = (tabId?: number): ActionState => {
    const tab = tabId === undefined ? {} : tabs.get(tabId) ?? {}

    return {
      badgeText: tab.badgeText ?? defaults.badgeText ?? "",
      badgeBackgroundColor: tab.badgeBackgroundColor ?? defaults.badgeBackgroundColor ?? transparent,
      badgeTextColor: tab.badgeTextColor ?? defaults.badgeTextColor ?? transparent,
      title: tab.title ?? defaults.title ?? "",
      popup: tab.popup ?? defaults.popup ?? "",
      enabled: tab.enabled ?? defaults.enabled ?? true,
      icon: tab.icon ?? defaults.icon
    }
  }

  const api: ChromeAction.ChromeActionApi = {
    setBadgeText: async ({ tabId, text }) => {
      const target = scope(tabId)

      // Omitting the text reverts a tab to the default and clears the default.
      if (text === undefined) delete target.badgeText
      else target.badgeText = text
    },
    getBadgeText: async ({ tabId }) => state(tabId).badgeText,
    setBadgeBackgroundColor: async ({ tabId, color }) => { scope(tabId).badgeBackgroundColor = parseColor(color) },
    getBadgeBackgroundColor: async ({ tabId }) => [...state(tabId).badgeBackgroundColor],
    setBadgeTextColor: async ({ tabId, color }) => { scope(tabId).badgeTextColor = parseColor(color) },
    getBadgeTextColor: async ({ tabId }) => [...state(tabId).badgeTextColor],
    setIcon: async (details) => { scope(details.tabId).icon = details },
    setTitle: async ({ tabId, title }) => { scope(tabId).title = title },
    getTitle: async ({ tabId }) => state(tabId).title,
    setPopup: async ({ tabId, popup }) => { scope(tabId).popup = popup },
    getPopup: async ({ tabId }) => state(tabId).popup,
    enable: async (tabId) => { scope(tabId).enabled = true },
    disable: async (tabId) => { scope(tabId).enabled = false },
    isEnabled: async (tabId) => state(tabId).enabled,
    openPopup: async (options) => {
      if (state().popup === "") throw new Error("Extension does not have a popup on the active tab.")

      openedPopups.push(options)
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
      /** Drops a tab's overrides, as Chrome does when the tab closes. */
      closeTab: (tabId: number) => { tabs.delete(tabId) },
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
