// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeNotifications, ChromeNotificationsError, layer, layerLive, make } from "../src/ChromeNotifications.js"
import type { ChromeNotificationsApi } from "../src/ChromeNotifications.js"
import { makeEvent } from "../src/ChromeTesting.js"

const options: chrome.notifications.NotificationCreateOptions = {
  type: "basic", iconUrl: "icon.png", title: "Sign-in needs you", message: "Approve the request"
}

const mockApi = () => {
  const onClicked = makeEvent<[string]>()
  const onClosed = makeEvent<[string, boolean]>()
  const created: Array<[string | undefined, chrome.notifications.NotificationCreateOptions]> = []

  const create = vi.fn(async (first: string | chrome.notifications.NotificationCreateOptions, second?: chrome.notifications.NotificationCreateOptions) => {
    // Chrome's two create overloads: with or without a caller-chosen id.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    const [id, details] = typeof first === "string" ? [first, second ?? options] : [undefined, first]
    created.push([id, details])

    return id ?? "generated"
  })

  const clear = vi.fn(async (_notificationId: string) => true)

  const api: ChromeNotificationsApi = {
    create,
    clear,
    onClicked: onClicked.api,
    onClosed: onClosed.api
  }

  return { api, clear, created, onClicked: onClicked.controls, onClosed: onClosed.controls }
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
