// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Exit, Fiber, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeAction, ChromeActionError, layer, layerLive, make } from "../src/ChromeAction.js"
import type { ChromeActionApi, ChromeActionService, ColorArray } from "../src/ChromeAction.js"
import { makeAction, maxBadgeTextBytes } from "../src/testing/Action.js"
import { makeEvent } from "../src/testing/Event.js"
import type { EventSource } from "../src/internal/event.js"

const tab: chrome.tabs.Tab = {
  id: 7, index: 0, windowId: 1, highlighted: false, active: true, pinned: false, incognito: false,
  discarded: false, autoDiscardable: true, groupId: -1, frozen: false, selected: true, lastAccessed: 0
}

const red: ColorArray = [255, 0, 0, 255]

type Failure = "reject" | "throw"

/** An API whose members succeed unless `fail` arms the next call of one to reject or throw. */
const mockApi = () => {
  const onClicked = makeEvent<[chrome.tabs.Tab]>()
  const onUserSettingsChanged = makeEvent<[chrome.action.UserSettingsChange]>()
  const armed = new Map<string, { readonly mode: Failure, readonly cause: Error }>()

  const method = <Args extends ReadonlyArray<unknown>, A>(name: string, result: (...args: Args) => A) =>
    vi.fn((...args: Args): Promise<A> => {
      const failure = armed.get(name)
      armed.delete(name)

      if (failure?.mode === "throw") throw failure.cause

      return failure === undefined ? Promise.resolve(result(...args)) : Promise.reject(failure.cause)
    })

  const api = {
    setBadgeText: method("setBadgeText", (_details: chrome.action.BadgeTextDetails) => undefined),
    getBadgeText: method("getBadgeText", (_details: chrome.action.TabDetails) => "3"),
    setBadgeBackgroundColor: method("setBadgeBackgroundColor", (_details: chrome.action.BadgeColorDetails) => undefined),
    getBadgeBackgroundColor: method("getBadgeBackgroundColor", (_details: chrome.action.TabDetails): ColorArray => red),
    setBadgeTextColor: method("setBadgeTextColor", (_details: chrome.action.BadgeColorDetails) => undefined),
    getBadgeTextColor: method("getBadgeTextColor", (_details: chrome.action.TabDetails): ColorArray => red),
    setIcon: method("setIcon", (_details: chrome.action.TabIconDetails) => undefined),
    setTitle: method("setTitle", (_details: chrome.action.TitleDetails) => undefined),
    getTitle: method("getTitle", (_details: chrome.action.TabDetails) => "Title"),
    setPopup: method("setPopup", (_details: chrome.action.PopupDetails) => undefined),
    getPopup: method("getPopup", (_details: chrome.action.TabDetails) => "chrome-extension://id/popup.html"),
    enable: method("enable", (_tabId?: number) => undefined),
    disable: method("disable", (_tabId?: number) => undefined),
    isEnabled: method("isEnabled", (_tabId?: number) => true),
    openPopup: method("openPopup", (_options?: chrome.action.OpenPopupOptions) => undefined),
    getUserSettings: method("getUserSettings", (): chrome.action.UserSettings => ({ isOnToolbar: true })),
    onClicked: onClicked.api,
    onUserSettingsChanged: onUserSettingsChanged.api
  } satisfies ChromeActionApi

  return {
    api,
    onClicked: onClicked.controls,
    onUserSettingsChanged: onUserSettingsChanged.controls,
    fail: (name: string, mode: Failure, cause: Error) => { armed.set(name, { mode, cause }) }
  }
}

/** Every call with the Chrome member it reaches. */
/** What any action call can succeed with. */
type ActionResult = void | string | boolean | ColorArray | chrome.action.UserSettings

const calls: ReadonlyArray<readonly [string, (action: ChromeActionService) => Effect.Effect<ActionResult, ChromeActionError>]> = [
  ["setBadgeText", (action) => action.setBadgeText({ text: "1" })],
  ["getBadgeText", (action) => action.getBadgeText()],
  ["setBadgeBackgroundColor", (action) => action.setBadgeBackgroundColor({ color: red })],
  ["getBadgeBackgroundColor", (action) => action.getBadgeBackgroundColor({ tabId: 7 })],
  ["setBadgeTextColor", (action) => action.setBadgeTextColor({ color: "#fff" })],
  ["getBadgeTextColor", (action) => action.getBadgeTextColor()],
  ["setIcon", (action) => action.setIcon({ path: "icon.png" })],
  ["setTitle", (action) => action.setTitle({ title: "Title" })],
  ["getTitle", (action) => action.getTitle()],
  ["setPopup", (action) => action.setPopup({ popup: "popup.html" })],
  ["getPopup", (action) => action.getPopup()],
  ["enable", (action) => action.enable()],
  ["disable", (action) => action.disable(7)],
  ["isEnabled", (action) => action.isEnabled()],
  ["openPopup", (action) => action.openPopup()],
  ["getUserSettings", (action) => action.getUserSettings]
]

const failures = calls.flatMap(([operation, run]) => (["reject", "throw"] as const).map((mode) => [operation, mode, run] as const))

describe("ChromeAction calls", () => {
  it.effect("passes setter details through as the same object", () => Effect.gen(function*() {
    const { api } = mockApi()
    const action = make(api)
    const text = { text: "3", tabId: 7 }
    const background = { color: "#f00" }
    const foreground = { color: red, tabId: 7 }
    const icon = { path: { "16": "busy-16.png", "32": "busy-32.png" }, tabId: 7 }
    const title = { title: "Title" }
    const popup = { popup: "", tabId: 0 }
    yield* action.setBadgeText(text)
    yield* action.setBadgeBackgroundColor(background)
    yield* action.setBadgeTextColor(foreground)
    yield* action.setIcon(icon)
    yield* action.setTitle(title)
    yield* action.setPopup(popup)
    expect(api.setBadgeText.mock.calls).toEqual([[text]])
    expect(api.setBadgeText.mock.calls[0]?.[0]).toBe(text)
    expect(api.setBadgeBackgroundColor.mock.calls[0]?.[0]).toBe(background)
    expect(api.setBadgeTextColor.mock.calls[0]?.[0]).toBe(foreground)
    expect(api.setIcon.mock.calls[0]?.[0]).toBe(icon)
    expect(api.setTitle.mock.calls[0]?.[0]).toBe(title)
    expect(api.setPopup.mock.calls[0]?.[0]).toBe(popup)
  }))

  it.effect("defaults every getter to the non-tab state and passes given details unchanged", () => Effect.gen(function*() {
    const { api } = mockApi()
    const action = make(api)
    const details = { tabId: 0 }
    expect(yield* action.getBadgeText()).toBe("3")
    expect(yield* action.getBadgeBackgroundColor()).toEqual(red)
    expect(yield* action.getBadgeTextColor()).toEqual(red)
    expect(yield* action.getTitle()).toBe("Title")
    expect(yield* action.getPopup()).toBe("chrome-extension://id/popup.html")
    yield* action.getBadgeText(details)
    yield* action.getBadgeBackgroundColor(details)
    yield* action.getBadgeTextColor(details)
    yield* action.getTitle(details)
    yield* action.getPopup(details)

    for (const getter of [api.getBadgeText, api.getBadgeBackgroundColor, api.getBadgeTextColor, api.getTitle, api.getPopup]) {
      expect(getter.mock.calls).toEqual([[{}], [details]])
      expect(getter.mock.calls[1]?.[0]).toBe(details)
    }
  }))

  it.effect("passes an optional tab id or popup options only when given, including tab 0", () => Effect.gen(function*() {
    const { api } = mockApi()
    const action = make(api)
    const options = { windowId: 2 }
    yield* action.enable()
    yield* action.enable(0)
    yield* action.disable()
    yield* action.disable(7)
    expect(yield* action.isEnabled()).toBe(true)
    expect(yield* action.isEnabled(0)).toBe(true)
    yield* action.openPopup()
    yield* action.openPopup({})
    yield* action.openPopup(options)
    expect(api.enable.mock.calls).toEqual([[], [0]])
    expect(api.disable.mock.calls).toEqual([[], [7]])
    expect(api.isEnabled.mock.calls).toEqual([[], [0]])
    expect(api.openPopup.mock.calls).toEqual([[], [{}], [options]])
    expect(api.openPopup.mock.calls[2]?.[0]).toBe(options)
  }))

  it.effect("keeps calls lazy and queries user settings afresh on every run", () => Effect.gen(function*() {
    const { api } = mockApi()
    const action = make(api)
    const pending = [action.setTitle({ title: "never" }), action.enable(), action.openPopup(), action.getUserSettings]
    expect(pending).toHaveLength(4)
    expect(api.setTitle).not.toHaveBeenCalled()
    expect(api.enable).not.toHaveBeenCalled()
    expect(api.openPopup).not.toHaveBeenCalled()
    expect(api.getUserSettings).not.toHaveBeenCalled()
    api.getUserSettings.mockResolvedValueOnce({ isOnToolbar: false })
    expect(yield* action.getUserSettings).toEqual({ isOnToolbar: false })
    expect(yield* action.getUserSettings).toEqual({ isOnToolbar: true })
    expect(api.getUserSettings).toHaveBeenCalledTimes(2)
    expect(api.getUserSettings.mock.calls).toEqual([[], []])
  }))

  it.effect.each(failures)("maps %s's %s to the typed error with its operation", ([operation, mode, run]) => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error(`${operation} ${mode}`)
    mock.fail(operation, mode, cause)
    const error = yield* Effect.flip(run(make(mock.api)))
    expect(error).toBeInstanceOf(ChromeActionError)
    expect(error._tag).toBe("ChromeActionError")
    expect(error.operation).toBe(operation)
    expect(error.cause).toBe(cause)
    // The failure was consumed by one call; the next one succeeds.
    yield* run(make(mock.api))
  }))

  it.effect.each(calls)("types a throwing %s member accessor", ([operation, run]) => Effect.gen(function*() {
    const { api } = mockApi()
    const cause = new Error(`${operation} accessor failed`)
    Object.defineProperty(api, operation, { get: () => { throw cause } })
    expect(yield* Effect.flip(run(make(api)))).toMatchObject({ operation, cause })
  }))

  it.effect("keeps Chrome's non-Error rejection values as the cause", () => Effect.gen(function*() {
    const { api } = mockApi()
    const action = make(api)
    const cause = { message: "Extension does not have a popup on the active tab." }
    api.openPopup.mockRejectedValueOnce(cause)
    api.getTitle.mockRejectedValueOnce(undefined)
    expect((yield* Effect.flip(action.openPopup())).cause).toBe(cause)
    const missing = yield* Effect.flip(action.getTitle())
    expect(missing.operation).toBe("getTitle")
    expect(missing.cause).toBeUndefined()
  }))
})

type MockApi = ReturnType<typeof mockApi>["api"]

/** Each version-gated call, with the mock minus that member as a browser predating it would expose. */
const gated = [
  ["setBadgeTextColor", (action: ChromeActionService) => action.setBadgeTextColor({ color: red }),
    ({ setBadgeTextColor: _absent, ...older }: MockApi): ChromeActionApi => older],
  ["getBadgeTextColor", (action: ChromeActionService) => action.getBadgeTextColor({ tabId: 1 }),
    ({ getBadgeTextColor: _absent, ...older }: MockApi): ChromeActionApi => older],
  ["isEnabled", (action: ChromeActionService) => action.isEnabled(1),
    ({ isEnabled: _absent, ...older }: MockApi): ChromeActionApi => older],
  ["openPopup", (action: ChromeActionService) => action.openPopup({ windowId: 1 }),
    ({ openPopup: _absent, ...older }: MockApi): ChromeActionApi => older],
  ["getUserSettings", (action: ChromeActionService) => action.getUserSettings,
    ({ getUserSettings: _absent, ...older }: MockApi): ChromeActionApi => older]
] as const

describe("ChromeAction version-gated members", () => {
  it.effect.each(gated)("fails %s with a typed unavailable error where the browser lacks it", ([operation, run, older]) => Effect.gen(function*() {
    const { api } = mockApi()
    const action = make(older(api))
    const exit = yield* Effect.exit(run(action))
    expect(Exit.hasDies(exit)).toBe(false)
    const error = yield* Effect.flip(run(action))
    expect(error).toBeInstanceOf(ChromeActionError)
    expect(error.operation).toBe(operation)
    expect(error.cause).toBeInstanceOf(Error)
    expect(error.cause).toMatchObject({ message: `chrome.action.${operation} is unavailable in this browser` })
    expect(api[operation]).not.toHaveBeenCalled()
  }))

  it.effect("fails onUserSettingsChanged with a typed error and no defect before Chrome 130", () => Effect.gen(function*() {
    const mock = mockApi()
    const { onUserSettingsChanged: _absent, ...older } = mock.api
    const action = make(older)
    const exit = yield* Effect.exit(Stream.runDrain(action.onUserSettingsChanged))
    expect(Exit.hasDies(exit)).toBe(false)
    expect(Exit.hasInterrupts(exit)).toBe(false)
    const error = yield* Effect.flip(Stream.runDrain(action.onUserSettingsChanged))
    expect(error).toMatchObject({ operation: "onUserSettingsChanged" })
    expect(error.cause).toMatchObject({ message: "chrome.action.onUserSettingsChanged is unavailable in this browser" })
    expect(mock.onUserSettingsChanged.listenerCount).toBe(0)
  }))

  it.effect("serves every other member of a Chrome 88 action API", () => Effect.gen(function*() {
    const mock = mockApi()

    const {
      setBadgeTextColor: _a, getBadgeTextColor: _b, isEnabled: _c, openPopup: _d, getUserSettings: _e, onUserSettingsChanged: _f,
      ...chrome88
    } = mock.api

    const action = make(chrome88)
    yield* action.setBadgeText({ text: "1" })
    expect(yield* action.getTitle()).toBe("Title")
    yield* action.enable(1)
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(action.onClicked, 1)))
    yield* Effect.promise(() => mock.onClicked.waitForListener())
    mock.onClicked.emit(tab)
    expect(yield* Fiber.join(fiber)).toEqual([tab])
    expect(mock.api.enable.mock.calls).toEqual([[1]])
  }))
})

/** Adds hooks to an event: a throw right after registering, or removals held back until released. */
const hooked = <Args extends ReadonlyArray<unknown>>(
  real: EventSource<Args>,
  hooks: { readonly failAfterAdd?: Error, readonly heldRemovals?: Array<() => void> }
): EventSource<Args> => ({
  addListener: (listener) => {
    real.addListener(listener)

    if (hooks.failAfterAdd !== undefined) throw hooks.failAfterAdd
  },
  removeListener: (listener) => {
    if (hooks.heldRemovals === undefined) real.removeListener(listener)
    else hooks.heldRemovals.push(() => real.removeListener(listener))
  }
})

type Hooks = Parameters<typeof hooked>[1]

type Mock = ReturnType<typeof mockApi>

/** What either action event emits. */
type ActionEvent = chrome.tabs.Tab | chrome.action.UserSettingsChange

/** Both streams, with what a test needs to drive and observe each one's simulated event. */
const events = [
  {
    operation: "onClicked",
    stream: (action: ChromeActionService): Stream.Stream<ActionEvent, ChromeActionError> => action.onClicked,
    controls: (mock: Mock) => mock.onClicked,
    emit: (mock: Mock, index: number) => mock.onClicked.emit({ ...tab, id: index }),
    expected: (index: number): ActionEvent => ({ ...tab, id: index }),
    hook: (mock: Mock, hooks: Hooks): ChromeActionApi => ({ ...mock.api, onClicked: hooked(mock.api.onClicked, hooks) })
  },
  {
    operation: "onUserSettingsChanged",
    stream: (action: ChromeActionService): Stream.Stream<ActionEvent, ChromeActionError> => action.onUserSettingsChanged,
    controls: (mock: Mock) => mock.onUserSettingsChanged,
    emit: (mock: Mock, index: number) => mock.onUserSettingsChanged.emit({ isOnToolbar: index % 2 === 0 }),
    expected: (index: number): ActionEvent => ({ isOnToolbar: index % 2 === 0 }),
    hook: (mock: Mock, hooks: Hooks): ChromeActionApi => ({
      ...mock.api, onUserSettingsChanged: hooked(mock.api.onUserSettingsChanged, hooks)
    })
  }
] as const

describe("ChromeAction events", () => {
  it.effect("emits each event's argument itself", () => Effect.gen(function*() {
    const mock = mockApi()
    const action = make(mock.api)
    const change = { isOnToolbar: true }
    const clicks = yield* Effect.forkScoped(Stream.runCollect(Stream.take(action.onClicked, 1)))
    const changes = yield* Effect.forkScoped(Stream.runCollect(Stream.take(action.onUserSettingsChanged, 1)))
    yield* Effect.promise(() => mock.onClicked.waitForListener())
    yield* Effect.promise(() => mock.onUserSettingsChanged.waitForListener())
    mock.onClicked.emit(tab)
    mock.onUserSettingsChanged.emit(change)
    expect((yield* Fiber.join(clicks))[0]).toBe(tab)
    expect((yield* Fiber.join(changes))[0]).toBe(change)
  }))

  it.effect.each(events)("delivers $operation events in order and removes its listener when the stream ends", (event) => Effect.gen(function*() {
    const mock = mockApi()
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(event.stream(make(mock.api)), 10)))
    yield* Effect.promise(() => event.controls(mock).waitForListener())

    for (let index = 0; index < 10; index++) {
      expect(event.emit(mock, index)).toEqual([])
      yield* Effect.yieldNow
    }

    expect(yield* Fiber.join(fiber)).toEqual(Array.from({ length: 10 }, (_, index) => event.expected(index)))
    expect(event.controls(mock).listenerCount).toBe(0)
  }))

  it.effect.each(events)("registers no $operation listener until consumed, then one per consumption", (event) => Effect.gen(function*() {
    const mock = mockApi()
    const stream = event.stream(make(mock.api))
    expect(event.controls(mock).listenerCount).toBe(0)
    const first = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 1)))
    yield* Effect.promise(() => event.controls(mock).waitForListener())
    expect(event.controls(mock).listenerCount).toBe(1)

    const registered = new Promise<void>((resolve) => {
      const original = mock.api[event.operation].addListener
      Object.defineProperty(mock.api[event.operation], "addListener", {
        value: (listener: never) => {
          original(listener)
          resolve()
        }
      })
    })

    const second = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 2)))
    yield* Effect.promise(() => registered)
    expect(event.controls(mock).listenerCount).toBe(2)
    event.emit(mock, 1)
    expect(yield* Fiber.join(first)).toEqual([event.expected(1)])
    expect(event.controls(mock).listenerCount).toBe(1)
    event.emit(mock, 2)
    expect(yield* Fiber.join(second)).toEqual([event.expected(1), event.expected(2)])
    expect(event.controls(mock).listenerCount).toBe(0)
    const again = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 1)))
    yield* Effect.promise(() => event.controls(mock).waitForListener())
    event.emit(mock, 3)
    expect(yield* Fiber.join(again)).toEqual([event.expected(3)])
  }))

  it.effect.each(events)("removes the $operation listener when the consumer is interrupted", (event) => Effect.gen(function*() {
    const mock = mockApi()
    const fiber = yield* Effect.forkChild(Stream.runDrain(event.stream(make(mock.api))))
    yield* Effect.promise(() => event.controls(mock).waitForListener())
    event.emit(mock, 1)
    yield* Fiber.interrupt(fiber)
    expect(event.controls(mock).listenerCount).toBe(0)
    expect(event.emit(mock, 2)).toEqual([])
  }))

  it.effect.each(events)("types a $operation registration failure and leaves no listener", (event) => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("listener rejected")
    event.controls(mock).failNext("addListener", cause)
    const error = yield* Effect.flip(Stream.runDrain(event.stream(make(mock.api))))
    expect(error).toBeInstanceOf(ChromeActionError)
    expect(error).toMatchObject({ operation: event.operation, cause })
    expect(event.controls(mock).listenerCount).toBe(0)
  }))

  it.effect.each(events)("removes a $operation listener whose registration added it and then threw", (event) => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("partial registration")
    const error = yield* Effect.flip(Stream.runDrain(event.stream(make(event.hook(mock, { failAfterAdd: cause })))))
    expect(error).toMatchObject({ operation: event.operation, cause })
    expect(event.controls(mock).listenerCount).toBe(0)
  }))

  it.effect.each(events)("types a throwing $operation accessor and recovers once it returns the event", (event) => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("event accessor failed")
    const real = mock.api[event.operation]
    let broken = true

    const getter = vi.fn(() => {
      if (broken) throw cause

      return real
    })

    Object.defineProperty(mock.api, event.operation, { get: getter })
    const stream = event.stream(make(mock.api))
    expect(getter).not.toHaveBeenCalled()
    expect(yield* Effect.flip(Stream.runDrain(stream))).toMatchObject({ operation: event.operation, cause })
    broken = false
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 1)))
    yield* Effect.promise(() => event.controls(mock).waitForListener())
    event.emit(mock, 4)
    expect(yield* Fiber.join(fiber)).toEqual([event.expected(4)])
    expect(getter).toHaveBeenCalledTimes(2)
  }))

  it.effect.each(events)("ignores a $operation dispatch Chrome delivers after the stream ended", (event) => Effect.gen(function*() {
    const mock = mockApi()
    const heldRemovals: Array<() => void> = []
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(event.stream(make(event.hook(mock, { heldRemovals }))), 1)))
    yield* Effect.promise(() => event.controls(mock).waitForListener())
    event.emit(mock, 1)
    expect(yield* Fiber.join(fiber)).toEqual([event.expected(1)])
    expect(heldRemovals).toHaveLength(1)
    // Chrome may still run a listener for an event it dispatched before the removal took effect.
    expect(event.controls(mock).listenerCount).toBe(1)
    expect(event.emit(mock, 2)).toEqual([])

    for (const release of heldRemovals) release()

    expect(event.controls(mock).listenerCount).toBe(0)
  }))
})

describe("ChromeAction layers", () => {
  it.effect("provides an injected API through layer", () => Effect.gen(function*() {
    const { api } = mockApi()
    expect(yield* Effect.flatMap(ChromeAction, (action) => action.getTitle()).pipe(Effect.provide(layer(api)))).toBe("Title")
    expect(api.getTitle).toHaveBeenCalledExactlyOnceWith({})
  }))

  it.effect("fails layerLive with initialize when chrome is missing", () => Effect.gen(function*() {
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", undefined)), () => Effect.sync(() => vi.unstubAllGlobals()))
    const error = yield* Effect.flip(ChromeAction.pipe(Effect.provide(layerLive)))
    expect(error).toBeInstanceOf(ChromeActionError)
    expect(error.operation).toBe("initialize")
    expect(error.cause).toMatchObject({ message: "chrome.action is unavailable in this context" })
  }))

  it.effect("fails layerLive with initialize when chrome.action is missing, as without an action manifest key", () => Effect.gen(function*() {
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", { runtime: {} })), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeAction.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
  }))

  it.effect("types a throwing chrome.action accessor as initialize", () => Effect.gen(function*() {
    const cause = new Error("access denied")
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", { get action() { throw cause } })), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeAction.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize", cause })
  }))

  it.effect("reads chrome.action once, when layerLive builds, and serves calls and events from it", () => Effect.gen(function*() {
    const mock = mockApi()
    const getter = vi.fn(() => mock.api)
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", { get action() { return getter() } })), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(getter).not.toHaveBeenCalled()
    const action = yield* ChromeAction.pipe(Effect.provide(layerLive))
    expect(getter).toHaveBeenCalledOnce()
    yield* action.setBadgeText({ text: "9", tabId: 2 })
    expect(yield* action.isEnabled(2)).toBe(true)
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(action.onClicked, 1)))
    yield* Effect.promise(() => mock.onClicked.waitForListener())
    mock.onClicked.emit(tab)
    expect(yield* Fiber.join(fiber)).toEqual([tab])
    expect(mock.api.setBadgeText).toHaveBeenCalledExactlyOnceWith({ text: "9", tabId: 2 })
    expect(getter).toHaveBeenCalledOnce()
  }))
})

describe("makeAction", () => {
  it.effect("falls back from tab overrides to the defaults", () => Effect.gen(function*() {
    const fixture = makeAction({ title: "Default", popup: "popup.html" })
    const action = make(fixture.api)
    yield* action.setBadgeText({ text: "1" })
    yield* action.setBadgeText({ text: "9", tabId: 7 })
    yield* action.setTitle({ title: "Tab", tabId: 7 })
    yield* action.disable(7)
    expect(yield* action.getBadgeText({ tabId: 7 })).toBe("9")
    expect(yield* action.getBadgeText({ tabId: 8 })).toBe("1")
    expect(yield* action.getTitle()).toBe("Default")
    expect(yield* action.getTitle({ tabId: 7 })).toBe("Tab")
    expect(yield* action.isEnabled(7)).toBe(false)
    expect(yield* action.isEnabled(8)).toBe(true)
    expect(yield* action.isEnabled()).toBe(true)
    expect(fixture.controls.state(7)).toMatchObject({
      badgeText: "9", title: "Tab", popup: "chrome-extension://test-extension/popup.html", enabled: false
    })
    yield* action.setBadgeText({ tabId: 7 })
    expect(yield* action.getBadgeText({ tabId: 7 })).toBe("1")
    yield* action.setBadgeText({})
    expect(yield* action.getBadgeText()).toBe("")
    yield* action.setBadgeText({ text: "" , tabId: 8 })
    yield* action.setBadgeText({ text: "5" })
    expect(yield* action.getBadgeText({ tabId: 8 })).toBe("")
    expect(yield* action.getBadgeText({ tabId: 9 })).toBe("5")
  }))

  it.effect("makes a default change visible to tabs without their own override", () => Effect.gen(function*() {
    const fixture = makeAction()
    const action = make(fixture.api)
    yield* action.disable(3)
    yield* action.disable()
    yield* action.enable(4)
    expect(yield* action.isEnabled(3)).toBe(false)
    expect(yield* action.isEnabled(4)).toBe(true)
    expect(yield* action.isEnabled(5)).toBe(false)
    yield* action.enable()
    expect(yield* action.isEnabled(5)).toBe(true)
    expect(yield* action.isEnabled(3)).toBe(false)
  }))

  it.effect("rejects every call naming a closed tab, as Chrome never reuses tab ids", () => Effect.gen(function*() {
    const fixture = makeAction()
    const action = make(fixture.api)
    yield* action.setBadgeText({ text: "9", tabId: 7 })
    fixture.controls.closeTab(7)
    expect(fixture.controls.state(7)).toEqual(fixture.controls.state())

    const attempts = [
      action.setBadgeText({ text: "1", tabId: 7 }), action.getBadgeText({ tabId: 7 }),
      action.setBadgeBackgroundColor({ color: red, tabId: 7 }), action.getBadgeBackgroundColor({ tabId: 7 }),
      action.setBadgeTextColor({ color: red, tabId: 7 }), action.getBadgeTextColor({ tabId: 7 }),
      action.setIcon({ path: "icon.png", tabId: 7 }), action.setTitle({ title: "x", tabId: 7 }),
      action.getTitle({ tabId: 7 }), action.setPopup({ popup: "", tabId: 7 }), action.getPopup({ tabId: 7 }),
      action.enable(7), action.disable(7), action.isEnabled(7)
    ]

    for (const attempt of attempts) {
      expect((yield* Effect.flip(attempt)).cause).toMatchObject({ message: "No tab with id: 7." })
    }

    expect(fixture.controls.state(7)).toEqual(fixture.controls.state())
    expect(yield* action.getBadgeText({ tabId: 8 })).toBe("")
    // Chrome checks the schema before the tab, and parses color strings and limits after it.
    expect((yield* Effect.flip(action.setBadgeBackgroundColor({ color: [256, 0, 0, 0], tabId: 7 }))).cause).toBeInstanceOf(TypeError)
    expect((yield* Effect.flip(action.setBadgeBackgroundColor({ color: "#zz", tabId: 7 }))).cause).toMatchObject({ message: "No tab with id: 7." })
    expect((yield* Effect.flip(action.setBadgeText({ text: "x".repeat(200), tabId: 7 }))).cause).toMatchObject({ message: "No tab with id: 7." })
    expect((yield* Effect.flip(action.setPopup({ popup: "https://example.com/", tabId: 7 }))).cause).toMatchObject({ message: "No tab with id: 7." })
  }))

  it.effect.each([-1, 1.5, Number.NaN])("rejects tab id %s as Chrome's schema does", (tabId) => Effect.gen(function*() {
    const action = make(makeAction().api)

    for (const attempt of [action.setTitle({ title: "x", tabId }), action.getTitle({ tabId }), action.enable(tabId), action.isEnabled(tabId)]) {
      const error = yield* Effect.flip(attempt)
      expect(error.cause).toBeInstanceOf(TypeError)
    }
  }))

  it.effect("treats a null icon tab id as the default", () => Effect.gen(function*() {
    const fixture = makeAction()
    const action = make(fixture.api)
    yield* action.setIcon({ path: "a.png", tabId: null })
    yield* action.setIcon({ path: { "16": "busy-16.png" }, tabId: 3 })
    expect(fixture.controls.state().icon).toEqual({ path: "a.png", tabId: null })
    expect(fixture.controls.state(3).icon).toEqual({ path: { "16": "busy-16.png" }, tabId: 3 })
    expect(fixture.controls.state(4).icon).toEqual({ path: "a.png", tabId: null })
  }))

  it.effect.each<readonly [string | ColorArray, ColorArray]>([
    ["#f80", [255, 136, 0, 255]],
    ["#F80a", [255, 136, 0, 170]],
    ["#0000ff", [0, 0, 255, 255]],
    ["#0000FF80", [0, 0, 255, 128]],
    ["rgb(1,2,3)", [1, 2, 3, 255]],
    ["rgb(1, 2,   3)", [1, 2, 3, 255]],
    ["rgb(0,0,0)", [0, 0, 0, 255]],
    ["rgb(007,0,0)", [7, 0, 0, 255]],
    ["rgba(1, 2, 3, 0.5)", [1, 2, 3, 127]],
    ["rgba(255,255,255,1)", [255, 255, 255, 255]],
    ["rgba(0,0,0,0.)", [0, 0, 0, 0]],
    [[9, 8, 7, 6], [9, 8, 7, 6]],
    [[0, 0, 0, 0], [0, 0, 0, 0]]
  ])("parses background color %j as %j", ([color, rgba]) => Effect.gen(function*() {
    const action = make(makeAction().api)
    yield* action.setBadgeBackgroundColor({ color, tabId: 1 })
    expect(yield* action.getBadgeBackgroundColor({ tabId: 1 })).toEqual(rgba)
    expect(yield* action.getBadgeBackgroundColor()).toEqual([0, 0, 0, 0])
  }))

  it.effect.each(["", "#ff", "#fffff", "#ggg", " #fff", "#fff ", "rgb( 1,2,3)", "rgb(1 ,2,3)", "rgb(1,2,3 )", "RGB(1,2,3)",
    "rgb(256,0,0)", "rgb(10%,0,0)", "rgb(1,2)", "rgba(1,2,3)", "rgba(1,2,3,1.5)", "rgba(1,2,3,.)", "rgba(1,2,3,1.2.3)"
  ])("rejects color %j with Chrome's parse error", (color) => Effect.gen(function*() {
    const fixture = makeAction()
    const action = make(fixture.api)
    const error = yield* Effect.flip(action.setBadgeBackgroundColor({ color }))
    expect(error).toMatchObject({ operation: "setBadgeBackgroundColor" })
    expect(error.cause).toMatchObject({ message: "The color specification could not be parsed." })
    expect(fixture.controls.state().badgeBackgroundColor).toEqual([0, 0, 0, 0])
  }))

  it.effect("rejects color arrays outside Chrome's schema", () => Effect.gen(function*() {
    const action = make(makeAction().api)
    const invalid: Array<ColorArray> = [[256, 0, 0, 0], [-1, 0, 0, 0], [1.5, 0, 0, 0], [0, 0, 0, Number.NaN]]
    // Untyped JavaScript can pass Chrome a three-element array, which its schema rejects.
    const short: ColorArray = JSON.parse("[1, 2, 3]")
    invalid.push(short)

    for (const color of invalid) {
      expect((yield* Effect.flip(action.setBadgeBackgroundColor({ color }))).cause).toBeInstanceOf(TypeError)
    }
  }))

  it.effect("names the fixture's limit for CSS colors only Chrome parses", () => Effect.gen(function*() {
    const action = make(makeAction().api)

    for (const color of ["red", "hsl(0, 100%, 50%)", "hsla(0, 100%, 50%, 1)"]) {
      expect((yield* Effect.flip(action.setBadgeTextColor({ color }))).cause).toMatchObject({ message: expect.stringContaining("fixture") })
    }
  }))

  it.effect("rejects a fully transparent text color but not a transparent background", () => Effect.gen(function*() {
    const fixture = makeAction()
    const action = make(fixture.api)

    for (const color of ["#0000", "#00000000", "rgba(0,0,0,0)", "rgba(9,9,9,0.003)"] as const) {
      expect((yield* Effect.flip(action.setBadgeTextColor({ color }))).cause).toMatchObject({ message: "The color specification could not be parsed." })
      yield* action.setBadgeBackgroundColor({ color })
    }

    expect((yield* Effect.flip(action.setBadgeTextColor({ color: [1, 2, 3, 0] }))).operation).toBe("setBadgeTextColor")
    yield* action.setBadgeTextColor({ color: [1, 2, 3, 1], tabId: 2 })
    expect(yield* action.getBadgeTextColor({ tabId: 2 })).toEqual([1, 2, 3, 1])
    expect(yield* action.getBadgeTextColor()).toEqual([0, 0, 0, 0])
    expect(yield* action.getBadgeBackgroundColor()).toEqual([9, 9, 9, 0])
  }))

  it.effect("reports colors as fresh copies the caller cannot use to mutate state", () => Effect.gen(function*() {
    const fixture = makeAction()
    const action = make(fixture.api)
    const input: ColorArray = [1, 2, 3, 4]
    yield* action.setBadgeBackgroundColor({ color: input })
    input[0] = 200
    const first = yield* action.getBadgeBackgroundColor()
    first[1] = 200
    expect(yield* action.getBadgeBackgroundColor()).toEqual([1, 2, 3, 4])
  }))

  it.effect("enforces Chrome's 100-byte badge text limit in UTF-8 bytes", () => Effect.gen(function*() {
    const action = make(makeAction().api)
    yield* action.setBadgeText({ text: "a".repeat(maxBadgeTextBytes) })
    yield* action.setBadgeText({ text: "\u{1F600}".repeat(25) })
    yield* action.setBadgeText({ text: "€".repeat(33) })
    expect(yield* action.getBadgeText()).toBe("€".repeat(33))

    for (const [text, bytes] of [["a".repeat(101), 101], ["€".repeat(34), 102], ["\u{1F600}".repeat(26), 104]] as const) {
      const error = yield* Effect.flip(action.setBadgeText({ text, tabId: 1 }))
      expect(error.cause).toMatchObject({ message: `Badge text size is ${bytes} bytes which exceeds the limit of 100 bytes.` })
    }

    expect(yield* action.getBadgeText({ tabId: 1 })).toBe("€".repeat(33))
  }))

  it.effect("resolves popups to extension URLs and refuses other origins", () => Effect.gen(function*() {
    const fixture = makeAction({ popup: "ui/popup.html", extensionId: "abc" })
    const action = make(fixture.api)
    expect(yield* action.getPopup()).toBe("chrome-extension://abc/ui/popup.html")
    yield* action.setPopup({ popup: "/a/../b.html", tabId: 1 })
    yield* action.setPopup({ popup: "chrome-extension://abc/c.html?x=1#y", tabId: 2 })
    yield* action.setPopup({ popup: "", tabId: 3 })
    expect(yield* action.getPopup({ tabId: 1 })).toBe("chrome-extension://abc/b.html")
    expect(yield* action.getPopup({ tabId: 2 })).toBe("chrome-extension://abc/c.html?x=1#y")
    expect(yield* action.getPopup({ tabId: 3 })).toBe("")
    expect(yield* action.getPopup({ tabId: 4 })).toBe("chrome-extension://abc/ui/popup.html")

    for (const popup of ["https://example.com/popup.html", "javascript:alert(1)", "data:text/html,hi"]) {
      expect((yield* Effect.flip(action.setPopup({ popup, tabId: 1 }))).operation).toBe("setPopup")
    }

    expect(yield* action.getPopup({ tabId: 1 })).toBe("chrome-extension://abc/b.html")
    expect(() => makeAction({ popup: "https://example.com/" })).toThrow("Invalid value for 'popup'")
    expect(makeAction().controls.state().popup).toBe("")
  }))

  it.effect("fires onClicked only for enabled actions without a popup", () => Effect.gen(function*() {
    const fixture = makeAction({ popup: "popup.html" })
    const action = make(fixture.api)
    const clicks = yield* Effect.forkScoped(Stream.runCollect(Stream.take(action.onClicked, 2)))
    yield* Effect.promise(() => fixture.controls.onClicked.waitForListener())
    expect(fixture.controls.click(tab)).toBe("popup")
    yield* action.setPopup({ popup: "", tabId: 7 })
    yield* action.disable(7)
    expect(fixture.controls.click(tab)).toBe("disabled")
    yield* action.enable(7)
    expect(fixture.controls.click(tab)).toBe("clicked")
    expect(fixture.controls.click({ ...tab, id: 8 })).toBe("popup")
    yield* action.setPopup({ popup: "" })
    expect(fixture.controls.click({ ...tab, id: 8 })).toBe("clicked")
    expect(yield* Fiber.join(clicks)).toEqual([tab, { ...tab, id: 8 }])
    expect(fixture.controls.onClicked.listenerCount).toBe(0)
  }))

  it.effect("opens the popup only when the active tab has one", () => Effect.gen(function*() {
    const fixture = makeAction()
    const action = make(fixture.api)
    const missing = yield* Effect.flip(action.openPopup())
    expect(missing).toMatchObject({ operation: "openPopup" })
    expect(missing.cause).toMatchObject({ message: "Extension does not have a popup on the active tab." })
    yield* action.setPopup({ popup: "popup.html" })
    yield* action.openPopup({ windowId: 4 })
    yield* action.openPopup()
    yield* action.setPopup({ popup: "", tabId: 5 })
    fixture.controls.activateTab(5)
    expect((yield* Effect.flip(action.openPopup())).operation).toBe("openPopup")
    fixture.controls.activateTab(6)
    yield* action.openPopup()
    fixture.controls.activateTab(5)
    fixture.controls.closeTab(5)
    yield* action.openPopup()
    expect(fixture.controls.openedPopups).toEqual([{ windowId: 4 }, undefined, undefined, undefined])
  }))

  it.effect("applies and streams user settings changes, keeping fields a change leaves out", () => Effect.gen(function*() {
    const fixture = makeAction()
    const action = make(fixture.api)
    const settings = yield* action.getUserSettings
    expect(settings).toEqual({ isOnToolbar: false })
    settings.isOnToolbar = true
    expect(yield* action.getUserSettings).toEqual({ isOnToolbar: false })
    const changes = yield* Effect.forkScoped(Stream.runCollect(Stream.take(action.onUserSettingsChanged, 2)))
    yield* Effect.promise(() => fixture.controls.onUserSettingsChanged.waitForListener())
    fixture.controls.changeUserSettings({ isOnToolbar: true })
    fixture.controls.changeUserSettings({})
    expect(yield* Fiber.join(changes)).toEqual([{ isOnToolbar: true }, {}])
    expect(yield* action.getUserSettings).toEqual({ isOnToolbar: true })
  }))

  it.effect("hands out state snapshots whose mutation reaches neither this fixture nor a fresh one", () => Effect.gen(function*() {
    const fixture = makeAction()
    const action = make(fixture.api)
    yield* action.setBadgeBackgroundColor({ color: red, tabId: 1 })
    const defaults = fixture.controls.state()
    defaults.badgeBackgroundColor[0] = 99
    defaults.badgeTextColor[3] = 99
    fixture.controls.state(1).badgeBackgroundColor[1] = 99
    expect(fixture.controls.state().badgeBackgroundColor).toEqual([0, 0, 0, 0])
    expect(fixture.controls.state().badgeTextColor).toEqual([0, 0, 0, 0])
    expect(yield* action.getBadgeBackgroundColor({ tabId: 1 })).toEqual(red)
    const fresh = make(makeAction().api)
    expect(yield* fresh.getBadgeBackgroundColor()).toEqual([0, 0, 0, 0])
    expect(yield* fresh.getBadgeTextColor()).toEqual([0, 0, 0, 0])
  }))

  it.effect("keeps the icon Chrome received when the caller later mutates its details", () => Effect.gen(function*() {
    const fixture = makeAction()
    const action = make(fixture.api)
    const path = { "16": "a-16.png" }
    const details = { path, tabId: 2 }
    yield* action.setIcon(details)
    path["16"] = "b-16.png"
    details.tabId = 3
    expect(fixture.controls.state(2).icon).toEqual({ path: { "16": "a-16.png" }, tabId: 2 })
    expect(fixture.controls.state(3).icon).toBeUndefined()
    const snapshot = fixture.controls.state(2).icon

    if (snapshot !== undefined) snapshot.tabId = 9

    expect(fixture.controls.state(2).icon).toEqual({ path: { "16": "a-16.png" }, tabId: 2 })
  }))

  it.effect("rejects setIcon details without an image, as Chrome's bindings do before the tab lookup", () => Effect.gen(function*() {
    const fixture = makeAction()
    const action = make(fixture.api)
    fixture.controls.closeTab(4)
    const imageDataError = "The imageData property must contain an ImageData object or dictionary of ImageData objects."

    // Untyped JavaScript can pass Chrome details the declared union forbids.
    const invalid: ReadonlyArray<readonly [string, string]> = [
      ["{}", "Either the path or imageData property must be specified."],
      ["{\"tabId\": 4}", "Either the path or imageData property must be specified."],
      ["{\"path\": {}}", "The path property must not be empty."],
      ["{\"imageData\": {}}", imageDataError],
      ["{\"imageData\": {\"16\": {\"width\": 16}}}", imageDataError],
      ["{\"imageData\": {\"width\": 16, \"height\": 16}}", imageDataError]
    ]

    for (const [json, message] of invalid) {
      const details: chrome.action.TabIconDetails = JSON.parse(json)
      const error = yield* Effect.flip(action.setIcon(details))
      expect(error).toMatchObject({ operation: "setIcon" })
      expect(error.cause).toMatchObject({ message })
    }

    expect(fixture.controls.state().icon).toBeUndefined()
    const imageData: ImageData = JSON.parse("{\"width\": 1, \"height\": 1, \"data\": [0, 0, 0, 255]}")
    yield* action.setIcon({ imageData, tabId: 1 })
    yield* action.setIcon({ imageData: { "32": imageData }, path: { "16": "a.png" }, tabId: 2 })
    expect(fixture.controls.state(1).icon).toEqual({ imageData, tabId: 1 })
    expect((yield* Effect.flip(action.setIcon({ imageData, tabId: 4 }))).cause).toMatchObject({ message: "No tab with id: 4." })
  }))

  it.effect("refuses openPopup while the action is disabled on the active tab, as Chrome does", () => Effect.gen(function*() {
    const fixture = makeAction({ popup: "popup.html" })
    const action = make(fixture.api)
    const noPopup = { message: "Extension does not have a popup on the active tab." }
    yield* action.disable()
    expect((yield* Effect.flip(action.openPopup())).cause).toMatchObject(noPopup)
    fixture.controls.activateTab(3)
    yield* action.enable(3)
    yield* action.openPopup({ windowId: 1 })
    yield* action.disable(3)
    expect((yield* Effect.flip(action.openPopup())).cause).toMatchObject(noPopup)
    fixture.controls.activateTab(4)
    expect((yield* Effect.flip(action.openPopup())).cause).toMatchObject(noPopup)
    yield* action.enable()
    yield* action.openPopup({ windowId: 2 })
    expect(fixture.controls.openedPopups).toEqual([{ windowId: 1 }, { windowId: 2 }])
  }))

  it.effect("records openPopup options as Chrome received them", () => Effect.gen(function*() {
    const fixture = makeAction({ popup: "popup.html" })
    const options = { windowId: 1 }
    yield* make(fixture.api).openPopup(options)
    options.windowId = 2
    expect(fixture.controls.openedPopups).toEqual([{ windowId: 1 }])
  }))

  it.effect("provides its layer and lets overrides replace members", () => Effect.gen(function*() {
    const cause = new Error("Could not find an active browser window.")
    const fixture = makeAction({ popup: "popup.html" }, { openPopup: () => Promise.reject(cause), getTitle: async () => "Override" })
    const title = yield* Effect.flatMap(ChromeAction, (action) => action.getTitle()).pipe(Effect.provide(fixture.layer))
    expect(title).toBe("Override")
    expect(yield* Effect.flip(make(fixture.api).openPopup())).toMatchObject({ operation: "openPopup", cause })
    expect(fixture.controls.openedPopups).toEqual([])
  }))
})
