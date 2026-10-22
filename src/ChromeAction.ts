import { Context, Effect, Layer, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeActionError extends Schema.TaggedError<ChromeActionError>()("ChromeActionError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** RGBA, each channel 0 to 255, as Chrome reports badge colors. */
export type ColorArray = chrome.extensionTypes.ColorArray

/** The Promise-based MV3 subset this module needs. */
export interface ChromeActionApi {
  setBadgeText(details: chrome.action.BadgeTextDetails): Promise<void>
  getBadgeText(details: chrome.action.TabDetails): Promise<string>
  setBadgeBackgroundColor(details: chrome.action.BadgeColorDetails): Promise<void>
  getBadgeBackgroundColor(details: chrome.action.TabDetails): Promise<ColorArray>
  setBadgeTextColor(details: chrome.action.BadgeColorDetails): Promise<void>
  getBadgeTextColor(details: chrome.action.TabDetails): Promise<ColorArray>
  setIcon(details: chrome.action.TabIconDetails): Promise<void>
  setTitle(details: chrome.action.TitleDetails): Promise<void>
  getTitle(details: chrome.action.TabDetails): Promise<string>
  setPopup(details: chrome.action.PopupDetails): Promise<void>
  getPopup(details: chrome.action.TabDetails): Promise<string>
  enable(tabId?: number): Promise<void>
  disable(tabId?: number): Promise<void>
  isEnabled(tabId?: number): Promise<boolean>
  openPopup(options?: chrome.action.OpenPopupOptions): Promise<void>
  getUserSettings(): Promise<chrome.action.UserSettings>
  readonly onClicked: EventSource<[tab: chrome.tabs.Tab]>
  readonly onUserSettingsChanged: EventSource<[change: chrome.action.UserSettingsChange]>
}

/**
 * Setters take Chrome's details objects: with a `tabId` they override the action for that tab
 * only (Chrome drops the override when the tab closes), without one they change the default.
 * Getters take an optional `{ tabId }` and fall back to the default when the tab has no override.
 */
export interface ChromeActionService {
  /** An empty string clears the badge; omitting `text` for a tab reverts it to the default text. */
  readonly setBadgeText: (details: chrome.action.BadgeTextDetails) => Effect.Effect<void, ChromeActionError>
  readonly getBadgeText: (details?: chrome.action.TabDetails) => Effect.Effect<string, ChromeActionError>
  /** Accepts a CSS color string or RGBA array; the getter always reports an RGBA array. */
  readonly setBadgeBackgroundColor: (details: chrome.action.BadgeColorDetails) => Effect.Effect<void, ChromeActionError>
  readonly getBadgeBackgroundColor: (details?: chrome.action.TabDetails) => Effect.Effect<ColorArray, ChromeActionError>
  readonly setBadgeTextColor: (details: chrome.action.BadgeColorDetails) => Effect.Effect<void, ChromeActionError>
  readonly getBadgeTextColor: (details?: chrome.action.TabDetails) => Effect.Effect<ColorArray, ChromeActionError>
  /** Takes extension-relative image paths or `ImageData`, keyed by pixel size when several are given. */
  readonly setIcon: (details: chrome.action.TabIconDetails) => Effect.Effect<void, ChromeActionError>
  readonly setTitle: (details: chrome.action.TitleDetails) => Effect.Effect<void, ChromeActionError>
  readonly getTitle: (details?: chrome.action.TabDetails) => Effect.Effect<string, ChromeActionError>
  /** An empty `popup` removes the popup, so clicks reach `onClicked` instead. */
  readonly setPopup: (details: chrome.action.PopupDetails) => Effect.Effect<void, ChromeActionError>
  readonly getPopup: (details?: chrome.action.TabDetails) => Effect.Effect<string, ChromeActionError>
  /** Enables the action for one tab, or by default when no tab is given. */
  readonly enable: (tabId?: number) => Effect.Effect<void, ChromeActionError>
  readonly disable: (tabId?: number) => Effect.Effect<void, ChromeActionError>
  readonly isEnabled: (tabId?: number) => Effect.Effect<boolean, ChromeActionError>
  /**
   * Opens the popup in the given window, or the active one (Chrome 127+). Fails when the
   * action has no popup for the active tab or Chrome finds no window to open it in.
   */
  readonly openPopup: (options?: chrome.action.OpenPopupOptions) => Effect.Effect<void, ChromeActionError>
  /** Whether the user pinned the action to the toolbar; each run queries afresh. */
  readonly getUserSettings: Effect.Effect<chrome.action.UserSettings, ChromeActionError>
  /**
   * Observational subscriptions that cannot wake an MV3 service worker; register wake
   * listeners through `ChromeServiceWorker.listen`. Each buffers at most 64 events,
   * dropping the oldest. `onClicked` never fires while the action has a popup.
   */
  readonly onClicked: Stream.Stream<chrome.tabs.Tab, ChromeActionError>
  /** Changes to the user's action settings (Chrome 130+); only changed fields are present. */
  readonly onUserSettingsChanged: Stream.Stream<chrome.action.UserSettingsChange, ChromeActionError>
}

export class ChromeAction extends Context.Service<ChromeAction, ChromeActionService>()("effect-platform-chrome/ChromeAction") {}

const invoke = invoker((operation, cause) => new ChromeActionError({ operation, cause }))

const eventError = (operation: string) => (cause: unknown) => new ChromeActionError({ operation, cause })

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeActionApi): ChromeActionService => ChromeAction.of({
  setBadgeText: (details) => invoke("setBadgeText", () => api.setBadgeText(details)),
  getBadgeText: (details = {}) => invoke("getBadgeText", () => api.getBadgeText(details)),
  setBadgeBackgroundColor: (details) => invoke("setBadgeBackgroundColor", () => api.setBadgeBackgroundColor(details)),
  getBadgeBackgroundColor: (details = {}) => invoke("getBadgeBackgroundColor", () => api.getBadgeBackgroundColor(details)),
  setBadgeTextColor: (details) => invoke("setBadgeTextColor", () => api.setBadgeTextColor(details)),
  getBadgeTextColor: (details = {}) => invoke("getBadgeTextColor", () => api.getBadgeTextColor(details)),
  setIcon: (details) => invoke("setIcon", () => api.setIcon(details)),
  setTitle: (details) => invoke("setTitle", () => api.setTitle(details)),
  getTitle: (details = {}) => invoke("getTitle", () => api.getTitle(details)),
  setPopup: (details) => invoke("setPopup", () => api.setPopup(details)),
  getPopup: (details = {}) => invoke("getPopup", () => api.getPopup(details)),
  // Chrome validates arguments, so an absent tab id is not passed as undefined.
  enable: (tabId) => invoke("enable", () => tabId === undefined ? api.enable() : api.enable(tabId)),
  disable: (tabId) => invoke("disable", () => tabId === undefined ? api.disable() : api.disable(tabId)),
  isEnabled: (tabId) => invoke("isEnabled", () => tabId === undefined ? api.isEnabled() : api.isEnabled(tabId)),
  openPopup: (options) => invoke("openPopup", () => options === undefined ? api.openPopup() : api.openPopup(options)),
  getUserSettings: invoke("getUserSettings", () => api.getUserSettings()),
  onClicked: observe(() => api.onClicked, (tab) => tab, eventError("onClicked")),
  onUserSettingsChanged: observe(() => api.onUserSettingsChanged, (change) => change, eventError("onUserSettingsChanged"))
})

export const layer = (api: ChromeActionApi): Layer.Layer<ChromeAction> => Layer.succeed(ChromeAction, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeAction, ChromeActionError> = liveLayer(
  ChromeAction, "action", (chrome) => chrome.action, make,
  (cause) => new ChromeActionError({ operation: "initialize", cause })
)
