// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Exit, Fiber, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChromeRuntimeError, make } from "../../src/ChromeRuntime.js"
import type { ChromeRuntimeApi } from "../../src/ChromeRuntime.js"
import { burst, expectOperations, gatedEvent, labelled, newest, pendingCalls, pendingCount } from "./support.js"

const context: chrome.runtime.ExtensionContext = {
  contextId: "worker", contextType: "BACKGROUND", frameId: -1, incognito: false, tabId: -1, windowId: -1
}

const sender = (index: number): chrome.runtime.MessageSender => ({ id: `extension-${index}` })

const fixture = (throwEvery?: number) => {
  const pending = pendingCalls(throwEvery)

  const events = {
    onInstalled: gatedEvent<[details: chrome.runtime.InstalledDetails]>(),
    onStartup: gatedEvent<[]>(),
    onUpdateAvailable: gatedEvent<[details: chrome.runtime.UpdateAvailableDetails]>(),
    onSuspend: gatedEvent<[]>(),
    onMessageExternal: gatedEvent<[message: string, sender: chrome.runtime.MessageSender, sendResponse: () => void]>(),
    onConnectExternal: gatedEvent<[port: chrome.runtime.Port]>()
  }

  const api: ChromeRuntimeApi = {
    id: "extension-id",
    getManifest: () => ({ manifest_version: 3, name: "Stress", version: "1.0.0" }),
    getURL: (path) => `chrome-extension://extension-id/${path}`,
    sendMessage: () => pending.call("sendMessage").then(() => "reply"),
    getContexts: () => pending.call("getContexts").then(() => [context]),
    openOptionsPage: () => pending.call("openOptionsPage"),
    reload: () => {},
    setUninstallURL: () => pending.call("setUninstallURL"),
    getPlatformInfo: () => pending.call("getPlatformInfo").then(() => ({ os: "mac", arch: "arm64" })),
    requestUpdateCheck: () => pending.call("requestUpdateCheck").then(() => ({ status: "no_update" })),
    ...events
  }

  return { events, pending, service: make(api) }
}

describe("ChromeRuntime stress", () => {
  it.effect("keeps the newest 64 of 4,096-event bursts on one- and multi-argument events, then removes the listeners", () => Effect.gen(function*() {
    const { service, events } = fixture()
    const installed = yield* Effect.forkScoped(Stream.runCollect(Stream.take(service.onInstalled, 64)))
    const external = yield* Effect.forkScoped(Stream.runCollect(Stream.take(service.onMessageExternal, 64)))

    yield* events.onInstalled.registered(1)
    yield* events.onMessageExternal.registered(1)

    for (let index = 0; index < burst; index++) {
      events.onInstalled.emit({ reason: "update", previousVersion: `${index}` })
      events.onMessageExternal.emit(`message-${index}`, sender(index), () => {})
    }

    expect((yield* Fiber.join(installed)).map((details) => Number(details.previousVersion))).toEqual(newest(burst))
    expect(yield* Fiber.join(external)).toEqual(newest(burst).map((index) => ({ message: `message-${index}`, sender: sender(index) })))

    for (const event of [events.onInstalled, events.onMessageExternal]) {
      expect(event.listeners.size).toBe(0)
      expect(event.removed).toEqual(event.added)
    }
  }))

  it.effect("churns 512 concurrent subscriptions across every event through interruption", () => Effect.gen(function*() {
    const { service, events } = fixture()

    const streams = [
      [events.onInstalled, Stream.runDrain(service.onInstalled)],
      [events.onStartup, Stream.runDrain(service.onStartup)],
      [events.onUpdateAvailable, Stream.runDrain(service.onUpdateAvailable)],
      [events.onSuspend, Stream.runDrain(service.onSuspend)],
      [events.onMessageExternal, Stream.runDrain(service.onMessageExternal)],
      [events.onConnectExternal, Stream.runDrain(service.onConnectExternal)]
    ] as const

    for (let round = 0; round < 4; round++) {
      const fibers = yield* Effect.forEach(Array.from({ length: 512 }), (_, index) =>
        Effect.forkChild(streams[index % streams.length]![1]))

      for (const [index, [event]] of streams.entries()) {
        yield* event.registered(Math.ceil((512 - index) / streams.length))
      }

      for (let index = 0; index < 64; index++) {
        events.onStartup.emit()
        events.onSuspend.emit()
        events.onUpdateAvailable.emit({ version: `${index}` })
      }

      yield* Effect.forEach([...fibers].reverse(), Fiber.interrupt, { concurrency: "unbounded" })

      for (const [event] of streams) expect(event.listeners.size).toBe(0)
    }

    for (const [event] of streams) {
      expect(event.removed).toHaveLength(event.added.length)
      expect(new Set<object>(event.removed)).toEqual(new Set<object>(event.added))
    }

    expect(streams.map(([event]) => event.added.length)).toEqual([344, 344, 340, 340, 340, 340])
  }))

  it.effect("settles 1,024 concurrent calls newest first with interleaved rejections, keeping operation names", () => Effect.gen(function*() {
    const { service, pending } = fixture()

    const operations = [
      (index: number) => labelled("sendMessage", service.sendMessage({ index })),
      () => labelled("getContexts", service.getContexts({})),
      () => labelled("openOptionsPage", service.openOptionsPage),
      (index: number) => labelled("setUninstallURL", service.setUninstallURL(`https://example.com/${index}`)),
      () => labelled("getPlatformInfo", service.getPlatformInfo),
      () => labelled("requestUpdateCheck", service.requestUpdateCheck)
    ]

    const calls = Array.from({ length: 1024 }, (_, index) => operations[index % operations.length]!(index))
    const fiber = yield* Effect.forkChild(Effect.all(calls, { concurrency: "unbounded" }))

    yield* pending.arrived(pendingCount(1024))
    const rejected = pending.settleInterleaved()
    const results = yield* Fiber.join(fiber)

    expectOperations(results, new Map([...pending.thrown, ...rejected]), ChromeRuntimeError)
  }))

  it.effect("interrupts 512 sendMessage calls mid-flight and tolerates their late settlement", () => Effect.gen(function*() {
    const { service, pending } = fixture(0)
    const fibers = yield* Effect.forEach(Array.from({ length: 512 }), (_, index) => Effect.forkChild(service.sendMessage(index)))

    yield* pending.arrived(512)
    yield* Effect.forEach(fibers, Fiber.interrupt, { concurrency: "unbounded" })
    pending.settleInterleaved()

    const exits = yield* Effect.forEach(fibers, Fiber.await)
    expect(exits.every((exit) => Exit.hasInterrupts(exit))).toBe(true)

    const after = yield* Effect.forkChild(service.sendMessage("after"))
    yield* pending.arrived(513)
    pending.calls[512]!.resolve()
    expect(yield* Fiber.join(after)).toBe("reply")
  }))
})
