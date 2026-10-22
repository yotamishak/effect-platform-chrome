// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeManagement, ChromeManagementError, layer, layerLive, make } from "../src/ChromeManagement.js"
import type { ChromeManagementApi, ExtensionInfo, UninstallOptions } from "../src/ChromeManagement.js"
import { makeEvent } from "../src/ChromeTesting.js"

const info: ExtensionInfo = {
  id: "abcdefghijklmnopabcdefghijklmnop", name: "Helper", shortName: "Helper", description: "", version: "1.0.0",
  enabled: true, mayDisable: true, installType: "normal", type: "extension", offlineEnabled: false,
  optionsUrl: "", permissions: ["storage"], hostPermissions: [], isApp: false
}

const mockApi = () => {
  const onInstalled = makeEvent<[ExtensionInfo]>()
  const onUninstalled = makeEvent<[string]>()
  const onEnabled = makeEvent<[ExtensionInfo]>()
  const onDisabled = makeEvent<[ExtensionInfo]>()

  return {
    api: {
      getSelf: vi.fn(async () => info),
      getAll: vi.fn(async () => [info]),
      get: vi.fn(async (_id: string) => info),
      getPermissionWarningsById: vi.fn(async (_id: string) => ["Read your browsing history"]),
      getPermissionWarningsByManifest: vi.fn(async (_manifest: string) => ["Read and change all your data"]),
      setEnabled: vi.fn(async (_id: string, _enabled: boolean) => {}),
      uninstall: vi.fn(async (_id: string, _options?: UninstallOptions) => {}),
      uninstallSelf: vi.fn(async (_options?: UninstallOptions) => {}),
      onInstalled: onInstalled.api,
      onUninstalled: onUninstalled.api,
      onEnabled: onEnabled.api,
      onDisabled: onDisabled.api
    } satisfies ChromeManagementApi,
    events: { onInstalled: onInstalled.controls, onEnabled: onEnabled.controls, onDisabled: onDisabled.controls },
    onUninstalled: onUninstalled.controls
  }
}

describe("ChromeManagement", () => {
  it.effect("reads installed items and permission warnings", () => Effect.gen(function*() {
    const { api } = mockApi()
    const management = make(api)
    expect(yield* management.getSelf).toBe(info)
    expect(yield* management.getAll).toEqual([info])
    expect(yield* management.get(info.id)).toBe(info)
    expect(api.get).toHaveBeenCalledExactlyOnceWith(info.id)
    expect(yield* management.getPermissionWarningsById(info.id)).toEqual(["Read your browsing history"])
    const manifest = JSON.stringify({ manifest_version: 3, name: "x", version: "1", host_permissions: ["<all_urls>"] })
    expect(yield* management.getPermissionWarningsByManifest(manifest)).toEqual(["Read and change all your data"])
    expect(api.getPermissionWarningsByManifest).toHaveBeenCalledExactlyOnceWith(manifest)
  }))

  it.effect("forwards enable and uninstall calls, preserving omitted options", () => Effect.gen(function*() {
    const { api } = mockApi()
    const management = make(api)
    yield* management.setEnabled(info.id, false)
    expect(api.setEnabled).toHaveBeenCalledExactlyOnceWith(info.id, false)
    yield* management.uninstall(info.id)
    yield* management.uninstall(info.id, { showConfirmDialog: true })
    expect(api.uninstall.mock.calls).toEqual([[info.id], [info.id, { showConfirmDialog: true }]])
    yield* management.uninstallSelf()
    yield* management.uninstallSelf({ showConfirmDialog: false })
    expect(api.uninstallSelf.mock.calls).toEqual([[], [{ showConfirmDialog: false }]])
  }))

  it.effect("is lazy and types synchronous and rejected failures by operation", () => Effect.gen(function*() {
    const { api } = mockApi()
    const management = make(api)
    const effect = management.uninstall(info.id)
    expect(api.uninstall).not.toHaveBeenCalled()
    const cancelled = new Error("User cancelled uninstall")
    api.uninstall.mockRejectedValueOnce(cancelled)
    const error = yield* Effect.flip(effect)
    expect(error).toBeInstanceOf(ChromeManagementError)
    expect(error).toMatchObject({ operation: "uninstall", cause: cancelled })
    const denied = new Error("'management.getAll' requires the management permission")
    api.getAll.mockImplementationOnce(() => { throw denied })
    expect(yield* Effect.flip(management.getAll)).toMatchObject({ operation: "getAll", cause: denied })
  }))

  it.effect.each(["onInstalled", "onEnabled", "onDisabled"] as const)("streams %s while consumed and removes its listener", (name) => Effect.gen(function*() {
    const mock = mockApi()
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(make(mock.api)[name], 1)))
    yield* Effect.promise(() => mock.events[name].waitForListener())
    mock.events[name].emit(info)
    expect(yield* Fiber.join(fiber)).toEqual([info])
    expect(mock.events[name].listenerCount).toBe(0)
  }))

  it.effect("streams uninstalled ids and types a failing registration", () => Effect.gen(function*() {
    const mock = mockApi()
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(make(mock.api).onUninstalled, 1)))
    yield* Effect.promise(() => mock.onUninstalled.waitForListener())
    mock.onUninstalled.emit(info.id)
    expect(yield* Fiber.join(fiber)).toEqual([info.id])
    expect(mock.onUninstalled.listenerCount).toBe(0)
    const cause = new Error("event unavailable")
    mock.onUninstalled.failNext("addListener", cause)
    expect(yield* Effect.flip(Stream.runDrain(make(mock.api).onUninstalled))).toMatchObject({ operation: "onUninstalled", cause })
  }))

  it.effect("provides an injected API and reads the global only when the live layer builds", () => Effect.gen(function*() {
    const { api } = mockApi()
    expect(yield* Effect.flatMap(ChromeManagement, (service) => service.getSelf).pipe(Effect.provide(layer(api)))).toBe(info)
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", {})), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeManagement.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
    vi.stubGlobal("chrome", undefined)
    expect(yield* Effect.flip(ChromeManagement.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
    vi.stubGlobal("chrome", { management: api })
    expect(yield* Effect.flatMap(ChromeManagement, (service) => service.getAll).pipe(Effect.provide(layerLive))).toEqual([info])
  }))
})
