// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Option, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeCommands, ChromeCommandsError, layer, layerLive, make } from "../src/ChromeCommands.js"
import type { ChromeCommandsApi } from "../src/ChromeCommands.js"
import { makeEvent } from "../src/testing/Event.js"

const tab: chrome.tabs.Tab = {
  id: 7, index: 0, windowId: 1, highlighted: false, active: true, pinned: false, incognito: false,
  discarded: false, autoDiscardable: true, groupId: -1, frozen: false, selected: true, lastAccessed: 0
}

const commands: Array<chrome.commands.Command> = [
  { name: "toggle-reader", description: "Toggle reader mode", shortcut: "Ctrl+Shift+Y" },
  { name: "capture", description: "Capture the page", shortcut: "" }
]

const mockApi = () => {
  const onCommand = makeEvent<[string, chrome.tabs.Tab?]>()

  const api = {
    getAll: vi.fn(async () => commands),
    onCommand: onCommand.api
  } satisfies ChromeCommandsApi

  return { api, onCommand: onCommand.controls }
}

describe("ChromeCommands", () => {
  it.effect("queries the commands afresh on each run", () => Effect.gen(function*() {
    const { api } = mockApi()
    const getAll = make(api).getAll
    expect(yield* getAll).toEqual(commands)
    expect(yield* getAll).toEqual(commands)
    expect(api.getAll).toHaveBeenCalledTimes(2)
  }))

  it.effect("streams commands with an optional tab while consumed", () => Effect.gen(function*() {
    const mock = mockApi()
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(make(mock.api).onCommand, 2)))
    yield* Effect.promise(() => mock.onCommand.waitForListener())
    mock.onCommand.emit("toggle-reader", tab)
    mock.onCommand.emit("capture")
    expect(yield* Fiber.join(fiber)).toEqual([
      { command: "toggle-reader", tab: Option.some(tab) },
      { command: "capture", tab: Option.none() }
    ])
    expect(mock.onCommand.listenerCount).toBe(0)
  }))

  it.effect("types rejected calls and registration failures", () => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("commands unavailable")
    mock.api.getAll.mockRejectedValueOnce(cause)
    const error = yield* Effect.flip(make(mock.api).getAll)
    expect(error).toBeInstanceOf(ChromeCommandsError)
    expect(error).toMatchObject({ operation: "getAll", cause })
    mock.onCommand.failNext("addListener", cause)
    expect(yield* Effect.flip(Stream.runDrain(make(mock.api).onCommand))).toMatchObject({ operation: "onCommand", cause })
    expect(mock.onCommand.listenerCount).toBe(0)
  }))

  it.effect("provides an injected API and reads the global only when the live layer builds", () => Effect.gen(function*() {
    const { api } = mockApi()
    expect(yield* Effect.flatMap(ChromeCommands, (service) => service.getAll).pipe(Effect.provide(layer(api)))).toEqual(commands)
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", {})), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeCommands.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
  }))
})
