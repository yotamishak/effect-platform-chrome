// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeAction, ChromeActionError, layer, layerLive, make } from "../src/ChromeAction.js"
import type { ChromeActionApi, ColorArray } from "../src/ChromeAction.js"
import { makeAction } from "../src/testing/Action.js"
import { makeEvent } from "../src/testing/Event.js"

const tab: chrome.tabs.Tab = {
  id: 7, index: 0, windowId: 1, highlighted: false, active: true, pinned: false, incognito: false,
  discarded: false, autoDiscardable: true, groupId: -1, frozen: false, selected: true, lastAccessed: 0
}

const red: ColorArray = [255, 0, 0, 255]

const mockApi = () => {
  const onClicked = makeEvent<[chrome.tabs.Tab]>()
  const onUserSettingsChanged = makeEvent<[chrome.action.UserSettingsChange]>()

  const api = {
    setBadgeText: vi.fn(async (_details: chrome.action.BadgeTextDetails) => {}),
    getBadgeText: vi.fn(async (_details: chrome.action.TabDetails) => "3"),
    setBadgeBackgroundColor: vi.fn(async (_details: chrome.action.BadgeColorDetails) => {}),
    getBadgeBackgroundColor: vi.fn(async (_details: chrome.action.TabDetails): Promise<ColorArray> => red),
    setBadgeTextColor: vi.fn(async (_details: chrome.action.BadgeColorDetails) => {}),
    getBadgeTextColor: vi.fn(async (_details: chrome.action.TabDetails): Promise<ColorArray> => red),
    setIcon: vi.fn(async (_details: chrome.action.TabIconDetails) => {}),
    setTitle: vi.fn(async (_details: chrome.action.TitleDetails) => {}),
    getTitle: vi.fn(async (_details: chrome.action.TabDetails) => "Title"),
    setPopup: vi.fn(async (_details: chrome.action.PopupDetails) => {}),
    getPopup: vi.fn(async (_details: chrome.action.TabDetails) => "popup.html"),
    enable: vi.fn(async (_tabId?: number) => {}),
    disable: vi.fn(async (_tabId?: number) => {}),
    isEnabled: vi.fn(async (_tabId?: number) => true),
    openPopup: vi.fn(async (_options?: chrome.action.OpenPopupOptions) => {}),
    getUserSettings: vi.fn(async (): Promise<chrome.action.UserSettings> => ({ isOnToolbar: true })),
    onClicked: onClicked.api,
    onUserSettingsChanged: onUserSettingsChanged.api
  } satisfies ChromeActionApi

  return { api, onClicked: onClicked.controls, onUserSettingsChanged: onUserSettingsChanged.controls }
}

describe("ChromeAction", () => {
  it.effect("passes details through and defaults getters to the non-tab state", () => Effect.gen(function*() {
    const { api } = mockApi()
    const action = make(api)
    yield* action.setBadgeText({ text: "3", tabId: 7 })
    yield* action.setBadgeBackgroundColor({ color: "#f00" })
    yield* action.setBadgeTextColor({ color: red, tabId: 7 })
    yield* action.setIcon({ path: "icon.png", tabId: 7 })
    yield* action.setTitle({ title: "Title" })
    yield* action.setPopup({ popup: "popup.html", tabId: 7 })
    expect(yield* action.getBadgeText()).toBe("3")
    expect(yield* action.getBadgeBackgroundColor({ tabId: 7 })).toEqual(red)
    expect(yield* action.getBadgeTextColor()).toEqual(red)
    expect(yield* action.getTitle({ tabId: 7 })).toBe("Title")
    expect(yield* action.getPopup()).toBe("popup.html")
    expect(yield* action.getUserSettings).toEqual({ isOnToolbar: true })
    expect(api.setBadgeText).toHaveBeenCalledExactlyOnceWith({ text: "3", tabId: 7 })
    expect(api.setIcon).toHaveBeenCalledExactlyOnceWith({ path: "icon.png", tabId: 7 })
    expect(api.getBadgeText).toHaveBeenCalledExactlyOnceWith({})
    expect(api.getBadgeBackgroundColor).toHaveBeenCalledExactlyOnceWith({ tabId: 7 })
    expect(api.getPopup).toHaveBeenCalledExactlyOnceWith({})
  }))

  it.effect("passes an optional tab id or popup window only when given", () => Effect.gen(function*() {
    const { api } = mockApi()
    const action = make(api)
    yield* action.enable()
    yield* action.enable(7)
    yield* action.disable(7)
    expect(yield* action.isEnabled()).toBe(true)
    yield* action.openPopup()
    yield* action.openPopup({ windowId: 2 })
    expect(api.enable.mock.calls).toEqual([[], [7]])
    expect(api.disable.mock.calls).toEqual([[7]])
    expect(api.isEnabled.mock.calls).toEqual([[]])
    expect(api.openPopup.mock.calls).toEqual([[], [{ windowId: 2 }]])
  }))

  it.effect("streams clicks and settings changes while consumed", () => Effect.gen(function*() {
    const mock = mockApi()
    const action = make(mock.api)
    const clicks = yield* Effect.forkScoped(Stream.runCollect(Stream.take(action.onClicked, 1)))
    const changes = yield* Effect.forkScoped(Stream.runCollect(Stream.take(action.onUserSettingsChanged, 1)))
    yield* Effect.promise(() => mock.onClicked.waitForListener())
    yield* Effect.promise(() => mock.onUserSettingsChanged.waitForListener())
    mock.onClicked.emit(tab)
    mock.onUserSettingsChanged.emit({ isOnToolbar: false })
    expect(yield* Fiber.join(clicks)).toEqual([tab])
    expect(yield* Fiber.join(changes)).toEqual([{ isOnToolbar: false }])
    expect(mock.onClicked.listenerCount + mock.onUserSettingsChanged.listenerCount).toBe(0)
  }))

  it.effect("types registration failures with the event name", () => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("listener rejected")
    mock.onClicked.failNext("addListener", cause)
    expect(yield* Effect.flip(Stream.runDrain(make(mock.api).onClicked))).toMatchObject({ operation: "onClicked", cause })
    expect(mock.onClicked.listenerCount).toBe(0)
  }))

  it.effect("types rejected calls with their operation", () => Effect.gen(function*() {
    const { api } = mockApi()
    const action = make(api)
    const cause = new Error("Extension does not have a popup on the active tab.")
    api.openPopup.mockRejectedValueOnce(cause)
    api.setIcon.mockImplementationOnce(() => { throw cause })
    const popup = yield* Effect.flip(action.openPopup())
    expect(popup).toBeInstanceOf(ChromeActionError)
    expect(popup).toMatchObject({ operation: "openPopup", cause })
    expect(yield* Effect.flip(action.setIcon({ path: "missing.png" }))).toMatchObject({ operation: "setIcon", cause })
  }))

  it.effect("provides an injected API and reads the global only when the live layer builds", () => Effect.gen(function*() {
    const { api } = mockApi()
    expect(yield* Effect.flatMap(ChromeAction, (action) => action.getTitle()).pipe(Effect.provide(layer(api)))).toBe("Title")
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", {})), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeAction.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
  }))
})

describe("makeAction", () => {
  it.effect("falls back from tab overrides to the defaults until the tab closes", () => Effect.gen(function*() {
    const fixture = makeAction({ title: "Default", popup: "popup.html" })
    const action = make(fixture.api)
    yield* action.setBadgeText({ text: "1" })
    yield* action.setBadgeText({ text: "9", tabId: 7 })
    yield* action.setTitle({ title: "Tab", tabId: 7 })
    yield* action.disable(7)
    expect(yield* action.getBadgeText({ tabId: 7 })).toBe("9")
    expect(yield* action.getBadgeText({ tabId: 8 })).toBe("1")
    expect(yield* action.getTitle()).toBe("Default")
    expect(yield* action.isEnabled(7)).toBe(false)
    expect(fixture.controls.state(7)).toMatchObject({ badgeText: "9", title: "Tab", popup: "popup.html", enabled: false })
    yield* action.setBadgeText({ tabId: 7 })
    expect(yield* action.getBadgeText({ tabId: 7 })).toBe("1")
    fixture.controls.closeTab(7)
    expect(fixture.controls.state(7)).toEqual(fixture.controls.state())
  }))

  it.effect("reports colors as RGBA arrays and records icons", () => Effect.gen(function*() {
    const fixture = makeAction()
    const action = make(fixture.api)
    expect(yield* action.getBadgeBackgroundColor()).toEqual([0, 0, 0, 0])
    yield* action.setBadgeBackgroundColor({ color: "#f80" })
    yield* action.setBadgeTextColor({ color: "#0000ff", tabId: 3 })
    yield* action.setIcon({ path: { "16": "busy-16.png" }, tabId: 3 })
    expect(yield* action.getBadgeBackgroundColor({ tabId: 3 })).toEqual([255, 136, 0, 255])
    expect(yield* action.getBadgeTextColor({ tabId: 3 })).toEqual([0, 0, 255, 255])
    expect(fixture.controls.state(3).icon).toEqual({ path: { "16": "busy-16.png" }, tabId: 3 })
    expect(fixture.controls.state().icon).toBeUndefined()
    expect(yield* Effect.flip(action.setBadgeTextColor({ color: "red" }))).toMatchObject({ operation: "setBadgeTextColor" })
  }))

  it.effect("fires onClicked only for enabled actions without a popup", () => Effect.gen(function*() {
    const fixture = makeAction({ popup: "popup.html" })
    const action = make(fixture.api)
    const clicks = yield* Effect.forkScoped(Stream.runCollect(Stream.take(action.onClicked, 1)))
    yield* Effect.promise(() => fixture.controls.onClicked.waitForListener())
    expect(fixture.controls.click(tab)).toBe("popup")
    yield* action.setPopup({ popup: "", tabId: 7 })
    yield* action.disable(7)
    expect(fixture.controls.click(tab)).toBe("disabled")
    yield* action.enable(7)
    expect(fixture.controls.click(tab)).toBe("clicked")
    expect(yield* Fiber.join(clicks)).toEqual([tab])
  }))

  it.effect("opens the popup only when one is set", () => Effect.gen(function*() {
    const fixture = makeAction()
    const action = make(fixture.api)
    expect(yield* Effect.flip(action.openPopup())).toMatchObject({ operation: "openPopup" })
    yield* action.setPopup({ popup: "popup.html" })
    yield* action.openPopup({ windowId: 4 })
    expect(fixture.controls.openedPopups).toEqual([{ windowId: 4 }])
  }))

  it.effect("applies and streams user settings changes", () => Effect.gen(function*() {
    const fixture = makeAction()
    const action = make(fixture.api)
    expect(yield* action.getUserSettings).toEqual({ isOnToolbar: false })
    const changes = yield* Effect.forkScoped(Stream.runCollect(Stream.take(action.onUserSettingsChanged, 1)))
    yield* Effect.promise(() => fixture.controls.onUserSettingsChanged.waitForListener())
    fixture.controls.changeUserSettings({ isOnToolbar: true })
    expect(yield* Fiber.join(changes)).toEqual([{ isOnToolbar: true }])
    expect(yield* action.getUserSettings).toEqual({ isOnToolbar: true })
  }))
})
