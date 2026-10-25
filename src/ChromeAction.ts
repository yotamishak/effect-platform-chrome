import { Context, Effect, Layer, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeActionError extends Schema.TaggedError<ChromeActionError>()("ChromeActionError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** RGBA, each channel an integer from 0 to 255, as Chrome reports badge colors. */
export type ColorArray = chrome.extensionTypes.ColorArray

/**
 * The Promise-based MV3 subset this module needs. `chrome.action` itself exists from Chrome
 * 88; the members added later are optional so that an injected API without them still fits
 * and so that an older browser fails with the typed error rather than a defect:
 * `getUserSettings` (Chrome 91), `openPopup` (Chrome 99, usable by every extension from
 * Chrome 127), the badge text color and `isEnabled` (Chrome 110) and `onUserSettingsChanged`
 * (Chrome 130). `setIcon` returns a Promise from Chrome 96.
 */
export interface ChromeActionApi {
  setBadgeText(details: chrome.action.BadgeTextDetails): Promise<void>
  getBadgeText(details: chrome.action.TabDetails): Promise<string>
  setBadgeBackgroundColor(details: chrome.action.BadgeColorDetails): Promise<void>
  getBadgeBackgroundColor(details: chrome.action.TabDetails): Promise<ColorArray>
  readonly setBadgeTextColor?: (details: chrome.action.BadgeColorDetails) => Promise<void>
  readonly getBadgeTextColor?: (details: chrome.action.TabDetails) => Promise<ColorArray>
  setIcon(details: chrome.action.TabIconDetails): Promise<void>
  setTitle(details: chrome.action.TitleDetails): Promise<void>
  getTitle(details: chrome.action.TabDetails): Promise<string>
  setPopup(details: chrome.action.PopupDetails): Promise<void>
  getPopup(details: chrome.action.TabDetails): Promise<string>
  enable(tabId?: number): Promise<void>
  disable(tabId?: number): Promise<void>
  readonly isEnabled?: (tabId?: number) => Promise<boolean>
  readonly openPopup?: (options?: chrome.action.OpenPopupOptions) => Promise<void>
  readonly getUserSettings?: () => Promise<chrome.action.UserSettings>
  readonly onClicked: EventSource<[tab: chrome.tabs.Tab]>
  readonly onUserSettingsChanged?: EventSource<[change: chrome.action.UserSettingsChange]>
}

/**
 * Setters take Chrome's details objects: with a `tabId` they override the action for that tab
 * only (Chrome drops the override when the tab closes), without one they change the default.
 * Getters take an optional `{ tabId }` and report the default when the tab has no override.
 * A `tabId` that names no open tab fails (`No tab with id: …`). Members newer than Chrome 88
 * fail with the typed error, its cause saying the member is unavailable, where the browser
 * lacks them.
 */
export interface ChromeActionService {
  /**
   * An empty string clears the badge; only about four characters fit. Omitting `text`
   * reverts a tab to the default text, or clears the default text when no tab is given.
   * Current Chrome rejects text longer than 100 bytes.
   */
  readonly setBadgeText: (details: chrome.action.BadgeTextDetails) => Effect.Effect<void, ChromeActionError>
  /**
   * The badge text. When `declarativeNetRequest` shows matched-rule counts as badge text,
   * Chrome reports a placeholder unless the tab has its own text or the extension holds
   * `declarativeNetRequestFeedback`.
   */
  readonly getBadgeText: (details?: chrome.action.TabDetails) => Effect.Effect<string, ChromeActionError>
  /**
   * Accepts an RGBA array or a CSS color string (hex, `rgb()`, `rgba()`, `hsl()`, `hsla()` or a
   * color name); Chrome rejects a string it cannot parse. The getter always reports RGBA.
   */
  readonly setBadgeBackgroundColor: (details: chrome.action.BadgeColorDetails) => Effect.Effect<void, ChromeActionError>
  readonly getBadgeBackgroundColor: (details?: chrome.action.TabDetails) => Effect.Effect<ColorArray, ChromeActionError>
  /**
   * Chrome 110+. Accepts the same colors as the background, except that a fully transparent
   * color fails; until one is set Chrome picks a color contrasting with the background.
   */
  readonly setBadgeTextColor: (details: chrome.action.BadgeColorDetails) => Effect.Effect<void, ChromeActionError>
  /** Chrome 110+. */
  readonly getBadgeTextColor: (details?: chrome.action.TabDetails) => Effect.Effect<ColorArray, ChromeActionError>
  /**
   * Takes an extension-relative image `path` or `imageData` (an `ImageData`, which a service
   * worker can draw with `OffscreenCanvas`), or either keyed by pixel size. Chrome cannot
   * report the icon back. Chrome rejects an empty dictionary, and fails a `path` it cannot load.
   */
  readonly setIcon: (details: chrome.action.TabIconDetails) => Effect.Effect<void, ChromeActionError>
  /** The tooltip shown when the user hovers over the action. */
  readonly setTitle: (details: chrome.action.TitleDetails) => Effect.Effect<void, ChromeActionError>
  readonly getTitle: (details?: chrome.action.TabDetails) => Effect.Effect<string, ChromeActionError>
  /**
   * `popup` is a path relative to the extension root; an empty string removes the popup, so
   * clicks reach `onClicked` instead.
   */
  readonly setPopup: (details: chrome.action.PopupDetails) => Effect.Effect<void, ChromeActionError>
  /** The popup as an absolute `chrome-extension://` URL, or an empty string without one. */
  readonly getPopup: (details?: chrome.action.TabDetails) => Effect.Effect<string, ChromeActionError>
  /** Enables the action for one tab, or by default when no tab is given. Actions start enabled. */
  readonly enable: (tabId?: number) => Effect.Effect<void, ChromeActionError>
  /** Disables the action for one tab, or by default when no tab is given. */
  readonly disable: (tabId?: number) => Effect.Effect<void, ChromeActionError>
  /**
   * Chrome 110+. Whether the action is enabled for the tab, or by default without one. An
   * action enabled only through `declarativeContent` reports false.
   */
  readonly isEnabled: (tabId?: number) => Effect.Effect<boolean, ChromeActionError>
  /**
   * Opens the popup in the given window, or in the active one; needs no user gesture
   * (Chrome 127+; Chrome 118 to 126 allow it only to policy-installed extensions). Fails
   * when the active tab of that window has no popup or the action is disabled there (both
   * report `Extension does not have a popup on the active tab.`), when the window is not the focused one
   * (focus it with `ChromeWindows.focus` first), when Chrome finds no browser window, or when
   * a popup is already showing.
   */
  readonly openPopup: (options?: chrome.action.OpenPopupOptions) => Effect.Effect<void, ChromeActionError>
  /** Chrome 91+. Whether the user pinned the action to the toolbar; each run queries afresh. */
  readonly getUserSettings: Effect.Effect<chrome.action.UserSettings, ChromeActionError>
  /**
   * Observational subscriptions that cannot wake an MV3 service worker; register wake
   * listeners through `ChromeServiceWorker.listen`. Each buffers at most 64 events,
   * dropping the oldest. `onClicked` emits the active tab of the clicked window and never
   * fires while the action has a popup for that tab or is disabled there.
   */
  readonly onClicked: Stream.Stream<chrome.tabs.Tab, ChromeActionError>
  /** Changes to the user's action settings (Chrome 130+); only changed fields are present. */
  readonly onUserSettingsChanged: Stream.Stream<chrome.action.UserSettingsChange, ChromeActionError>
}

export class ChromeAction extends Context.Service<ChromeAction, ChromeActionService>()("effect-platform-chrome/ChromeAction") {}

const invoke = invoker((operation, cause) => new ChromeActionError({ operation, cause }))

const eventError = (operation: string) => (cause: unknown) => new ChromeActionError({ operation, cause })

/** The cause when a member newer than the running browser is called. */
const unavailable = (operation: string) => new Error(`chrome.action.${operation} is unavailable in this browser`)

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeActionApi): ChromeActionService => ChromeAction.of({
  setBadgeText: (details) => invoke("setBadgeText", () => api.setBadgeText(details)),
  getBadgeText: (details = {}) => invoke("getBadgeText", () => api.getBadgeText(details)),
  setBadgeBackgroundColor: (details) => invoke("setBadgeBackgroundColor", () => api.setBadgeBackgroundColor(details)),
  getBadgeBackgroundColor: (details = {}) => invoke("getBadgeBackgroundColor", () => api.getBadgeBackgroundColor(details)),
  setBadgeTextColor: (details) => invoke("setBadgeTextColor", () => api.setBadgeTextColor === undefined
    ? Promise.reject(unavailable("setBadgeTextColor"))
    : api.setBadgeTextColor(details)),
  getBadgeTextColor: (details = {}) => invoke("getBadgeTextColor", () => api.getBadgeTextColor === undefined
    ? Promise.reject(unavailable("getBadgeTextColor"))
    : api.getBadgeTextColor(details)),
  setIcon: (details) => invoke("setIcon", () => api.setIcon(details)),
  setTitle: (details) => invoke("setTitle", () => api.setTitle(details)),
  getTitle: (details = {}) => invoke("getTitle", () => api.getTitle(details)),
  setPopup: (details) => invoke("setPopup", () => api.setPopup(details)),
  getPopup: (details = {}) => invoke("getPopup", () => api.getPopup(details)),
  // Chrome validates arguments, so an absent tab id or option is not passed as undefined.
  enable: (tabId) => invoke("enable", () => tabId === undefined ? api.enable() : api.enable(tabId)),
  disable: (tabId) => invoke("disable", () => tabId === undefined ? api.disable() : api.disable(tabId)),
  isEnabled: (tabId) => invoke("isEnabled", () => {
    if (api.isEnabled === undefined) return Promise.reject(unavailable("isEnabled"))

    return tabId === undefined ? api.isEnabled() : api.isEnabled(tabId)
  }),
  openPopup: (options) => invoke("openPopup", () => {
    if (api.openPopup === undefined) return Promise.reject(unavailable("openPopup"))

    return options === undefined ? api.openPopup() : api.openPopup(options)
  }),
  getUserSettings: invoke("getUserSettings", () => api.getUserSettings === undefined
    ? Promise.reject(unavailable("getUserSettings"))
    : api.getUserSettings()),
  onClicked: observe(() => api.onClicked, (tab) => tab, eventError("onClicked")),
  // Failing the lookup keeps an absent event from reaching listener registration or cleanup.
  onUserSettingsChanged: observe(() => {
    const event = api.onUserSettingsChanged

    if (event === undefined) throw unavailable("onUserSettingsChanged")

    return event
  }, (change) => change, eventError("onUserSettingsChanged"))
})

export const layer = (api: ChromeActionApi): Layer.Layer<ChromeAction> => Layer.succeed(ChromeAction, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeAction, ChromeActionError> = liveLayer(
  ChromeAction, "action", (chrome) => chrome.action, make,
  (cause) => new ChromeActionError({ operation: "initialize", cause })
)
