// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeNotifications, ChromeNotificationsError, layer, layerLive, make } from "../src/ChromeNotifications.js"
import type { ChromeNotificationsApi, PermissionLevel } from "../src/ChromeNotifications.js"
import { makeEvent } from "../src/ChromeTesting.js"
import { makeNotifications } from "../src/testing/Notifications.js"

const options: chrome.notifications.NotificationCreateOptions = {
  type: "basic", iconUrl: "icon.png", title: "Sign-in needs you", message: "Approve the request"
}

const mockApi = () => {
  const onClicked = makeEvent<[string]>()
  const onButtonClicked = makeEvent<[string, number]>()
  const onClosed = makeEvent<[string, boolean]>()
  const onPermissionLevelChanged = makeEvent<[PermissionLevel]>()
  const created: Array<[string | undefined, chrome.notifications.NotificationCreateOptions]> = []

  const create = vi.fn(async (first: string | chrome.notifications.NotificationCreateOptions, second?: chrome.notifications.NotificationCreateOptions) => {
    // Chrome's two create overloads: with or without a caller-chosen id.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    const [id, details] = typeof first === "string" ? [first, second ?? options] : [undefined, first]
    created.push([id, details])

    return id ?? "generated"
  })

  const clear = vi.fn(async (_notificationId: string) => true)
  const update = vi.fn(async (_notificationId: string, _options: chrome.notifications.NotificationOptions) => false)
  const getAll = vi.fn(async (): Promise<{ [notificationId: string]: true }> => ({ "notice-1": true, "notice-2": true }))
  const getPermissionLevel = vi.fn(async (): Promise<PermissionLevel> => "denied")

  const api: ChromeNotificationsApi = {
    create,
    update,
    clear,
    getAll,
    getPermissionLevel,
    onClicked: onClicked.api,
    onButtonClicked: onButtonClicked.api,
    onClosed: onClosed.api,
    onPermissionLevelChanged: onPermissionLevelChanged.api
  }

  return {
    api, clear, update, getAll, getPermissionLevel, created,
    onClicked: onClicked.controls,
    onButtonClicked: onButtonClicked.controls,
    onClosed: onClosed.controls,
    onPermissionLevelChanged: onPermissionLevelChanged.controls
  }
}

describe("ChromeNotifications", () => {
  it.effect("creates with or without an id and clears", () => Effect.gen(function*() {
    const mock = mockApi()
    const notifications = make(mock.api)
    expect(yield* notifications.create(options, "notice-1")).toBe("notice-1")
    expect(yield* notifications.create(options)).toBe("generated")
    expect(mock.created).toEqual([["notice-1", options], [undefined, options]])
    expect(yield* notifications.clear("notice-1")).toBe(true)
  }))

  it.effect("streams clicks and closes while consumed", () => Effect.gen(function*() {
    const mock = mockApi()
    const notifications = make(mock.api)
    const clicks = yield* Effect.forkScoped(Stream.runCollect(Stream.take(notifications.onClicked, 1)))
    const closes = yield* Effect.forkScoped(Stream.runCollect(Stream.take(notifications.onClosed, 1)))
    yield* Effect.promise(() => mock.onClicked.waitForListener())
    yield* Effect.promise(() => mock.onClosed.waitForListener())
    mock.onClicked.emit("notice-1")
    mock.onClosed.emit("notice-1", true)
    expect(yield* Fiber.join(clicks)).toEqual(["notice-1"])
    expect(yield* Fiber.join(closes)).toEqual([{ notificationId: "notice-1", byUser: true }])
    expect(mock.onClicked.listenerCount + mock.onClosed.listenerCount).toBe(0)
  }))

  it.effect("updates, lists and reads the permission level", () => Effect.gen(function*() {
    const mock = mockApi()
    const notifications = make(mock.api)
    expect(yield* notifications.update("missing", { progress: 40 })).toBe(false)
    expect(mock.update).toHaveBeenCalledExactlyOnceWith("missing", { progress: 40 })
    expect(yield* notifications.getAll).toEqual(["notice-1", "notice-2"])
    expect(yield* notifications.getPermissionLevel).toBe("denied")
  }))

  it.effect("streams button clicks and permission changes, then removes their listeners", () => Effect.gen(function*() {
    const mock = mockApi()
    const notifications = make(mock.api)
    const buttons = yield* Effect.forkScoped(Stream.runCollect(Stream.take(notifications.onButtonClicked, 2)))
    const levels = yield* Effect.forkScoped(Stream.runCollect(Stream.take(notifications.onPermissionLevelChanged, 1)))
    yield* Effect.promise(() => mock.onButtonClicked.waitForListener())
    yield* Effect.promise(() => mock.onPermissionLevelChanged.waitForListener())
    mock.onButtonClicked.emit("notice-1", 0)
    mock.onButtonClicked.emit("notice-1", 1)
    mock.onPermissionLevelChanged.emit("denied")
    expect(yield* Fiber.join(buttons)).toEqual([
      { notificationId: "notice-1", buttonIndex: 0 }, { notificationId: "notice-1", buttonIndex: 1 }
    ])
    expect(yield* Fiber.join(levels)).toEqual(["denied"])
    expect(mock.onButtonClicked.listenerCount + mock.onPermissionLevelChanged.listenerCount).toBe(0)
  }))

  it.effect("names each failing call and registration", () => Effect.gen(function*() {
    const mock = mockApi()
    const notifications = make(mock.api)
    const cause = new Error("notifications unavailable")
    mock.update.mockRejectedValueOnce(cause)
    mock.getAll.mockRejectedValueOnce(cause)
    mock.getPermissionLevel.mockRejectedValueOnce(cause)
    mock.onButtonClicked.failNext("addListener", cause)
    mock.onPermissionLevelChanged.failNext("addListener", cause)
    expect(yield* Effect.flip(notifications.update("x", {}))).toMatchObject({ operation: "update", cause })
    expect(yield* Effect.flip(notifications.getAll)).toMatchObject({ operation: "getAll", cause })
    expect(yield* Effect.flip(notifications.getPermissionLevel)).toMatchObject({ operation: "getPermissionLevel", cause })
    expect(yield* Effect.flip(Stream.runDrain(notifications.onButtonClicked))).toMatchObject({ operation: "onButtonClicked", cause })
    expect(yield* Effect.flip(Stream.runDrain(notifications.onPermissionLevelChanged)))
      .toMatchObject({ operation: "onPermissionLevelChanged", cause })
  }))

  it.effect("types rejected calls", () => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("Unable to download all specified images.")
    mock.clear.mockRejectedValueOnce(cause)
    const error = yield* Effect.flip(make(mock.api).clear("x"))
    expect(error).toBeInstanceOf(ChromeNotificationsError)
    expect(error).toMatchObject({ operation: "clear", cause })
  }))

  it.effect("provides an injected API and reads the global only when the live layer builds", () => Effect.gen(function*() {
    const mock = mockApi()
    expect(yield* Effect.flatMap(ChromeNotifications, (service) => service.clear("x")).pipe(Effect.provide(layer(mock.api)))).toBe(true)
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", {})), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeNotifications.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
  }))
})

const buttonsOptions: chrome.notifications.NotificationCreateOptions = {
  ...options, buttons: [{ title: "Approve" }, { title: "Deny" }]
}

describe("makeNotifications", () => {
  it.effect("keeps notifications in memory across create, update, clear and getAll", () => Effect.gen(function*() {
    const fixture = makeNotifications()
    const notifications = yield* ChromeNotifications.pipe(Effect.provide(fixture.layer))
    const closes = yield* Effect.forkScoped(Stream.runCollect(Stream.take(notifications.onClosed, 1)))
    yield* Effect.promise(() => fixture.controls.onClosed.waitForListener())
    expect(yield* notifications.create(options, "notice")).toBe("notice")
    expect(yield* notifications.create(options)).toBe("notification-1")
    expect(yield* notifications.update("notice", { progress: 50, type: "progress" })).toBe(true)
    expect(fixture.controls.notification("notice")).toEqual({ ...options, progress: 50, type: "progress" })
    expect(yield* notifications.update("missing", { progress: 50 })).toBe(false)
    expect(fixture.controls.notification("missing")).toBeUndefined()
    expect(yield* notifications.getAll).toEqual(["notice", "notification-1"])
    expect(yield* notifications.clear("notice")).toBe(true)
    expect(yield* notifications.clear("notice")).toBe(false)
    expect(yield* notifications.getAll).toEqual(["notification-1"])
    expect(yield* Fiber.join(closes)).toEqual([{ notificationId: "notice", byUser: false }])
  }))

  it.effect("simulates clicks, button presses and closes as events", () => Effect.gen(function*() {
    const fixture = makeNotifications()
    const notifications = yield* ChromeNotifications.pipe(Effect.provide(fixture.layer))
    const clicks = yield* Effect.forkScoped(Stream.runCollect(Stream.take(notifications.onClicked, 1)))
    const buttons = yield* Effect.forkScoped(Stream.runCollect(Stream.take(notifications.onButtonClicked, 1)))
    const closes = yield* Effect.forkScoped(Stream.runCollect(Stream.take(notifications.onClosed, 1)))
    yield* Effect.promise(() => fixture.controls.onClicked.waitForListener())
    yield* Effect.promise(() => fixture.controls.onButtonClicked.waitForListener())
    yield* Effect.promise(() => fixture.controls.onClosed.waitForListener())
    yield* notifications.create(buttonsOptions, "approval")
    expect(fixture.controls.click("approval")).toEqual([])
    expect(fixture.controls.clickButton("approval", 1)).toEqual([])
    expect(() => fixture.controls.clickButton("approval", 2)).toThrow("no button 2")
    expect(yield* notifications.getAll).toEqual(["approval"])
    expect(fixture.controls.close("approval")).toEqual([])
    expect(() => fixture.controls.click("approval")).toThrow("No notification is showing")
    expect(yield* Fiber.join(clicks)).toEqual(["approval"])
    expect(yield* Fiber.join(buttons)).toEqual([{ notificationId: "approval", buttonIndex: 1 }])
    expect(yield* Fiber.join(closes)).toEqual([{ notificationId: "approval", byUser: true }])
    expect(yield* notifications.getAll).toEqual([])
    expect(fixture.controls.onClicked.listenerCount + fixture.controls.onButtonClicked.listenerCount + fixture.controls.onClosed.listenerCount).toBe(0)
  }))

  it.effect("changes the permission level only when it differs", () => Effect.gen(function*() {
    const fixture = makeNotifications()
    const notifications = yield* ChromeNotifications.pipe(Effect.provide(fixture.layer))
    const levels = yield* Effect.forkScoped(Stream.runCollect(Stream.take(notifications.onPermissionLevelChanged, 2)))
    yield* Effect.promise(() => fixture.controls.onPermissionLevelChanged.waitForListener())
    expect(yield* notifications.getPermissionLevel).toBe("granted")
    fixture.controls.setPermissionLevel("granted")
    fixture.controls.setPermissionLevel("denied")
    fixture.controls.setPermissionLevel("granted")
    expect(yield* Fiber.join(levels)).toEqual(["denied", "granted"])
  }))

  it.effect("returns listener exceptions from simulated actions", () => Effect.gen(function*() {
    const fixture = makeNotifications()
    const failure = new Error("listener failed")
    fixture.api.onClicked.addListener(() => { throw failure })
    yield* Effect.promise(() => fixture.api.create("notice", options))
    expect(fixture.controls.click("notice")).toEqual([failure])
  }))
})
