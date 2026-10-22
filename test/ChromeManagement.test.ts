// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Cause, Effect, Exit, Fiber, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeManagement, ChromeManagementError, layer, layerLive, make } from "../src/ChromeManagement.js"
import type {
  ChromeManagementApi, ChromeManagementService, ExtensionInfo, LaunchType, UninstallOptions
} from "../src/ChromeManagement.js"
import { makeEvent } from "../src/ChromeTesting.js"
import { extensionId, extensionInfo, makeManagement } from "../src/testing/Management.js"
import type { ManagementOptions } from "../src/testing/Management.js"

const info: ExtensionInfo = {
  id: "abcdefghijklmnopabcdefghijklmnop", name: "Helper", shortName: "Helper", description: "", version: "1.0.0",
  enabled: true, mayDisable: true, installType: "normal", type: "extension", offlineEnabled: false,
  optionsUrl: "", permissions: ["storage"], hostPermissions: [], isApp: false
}

const app: ExtensionInfo = {
  ...info, id: "ponmlkjihgfedcbaponmlkjihgfedcba", name: "Docs", shortName: "Docs", type: "hosted_app", isApp: true,
  appLaunchUrl: "https://docs.example.com/", launchType: "OPEN_AS_WINDOW", availableLaunchTypes: ["OPEN_AS_WINDOW"]
}

const manifest = JSON.stringify({ manifest_version: 3, name: "x", version: "1", host_permissions: ["<all_urls>"] })

const mockApi = () => {
  const onInstalled = makeEvent<[ExtensionInfo]>()
  const onUninstalled = makeEvent<[string]>()
  const onEnabled = makeEvent<[ExtensionInfo]>()
  const onDisabled = makeEvent<[ExtensionInfo]>()

  return {
    api: {
      getSelf: vi.fn(async () => info),
      getAll: vi.fn(async () => [info, app]),
      get: vi.fn(async (_id: string) => info),
      getPermissionWarningsById: vi.fn(async (_id: string) => ["Read your browsing history"]),
      getPermissionWarningsByManifest: vi.fn(async (_manifestStr: string) => ["Read and change all your data"]),
      setEnabled: vi.fn(async (_id: string, _enabled: boolean) => {}),
      uninstall: vi.fn(async (_id: string, _options?: UninstallOptions) => {}),
      uninstallSelf: vi.fn(async (_options?: UninstallOptions) => {}),
      launchApp: vi.fn(async (_id: string) => {}),
      setLaunchType: vi.fn(async (_id: string, _launchType: LaunchType) => {}),
      createAppShortcut: vi.fn(async (_id: string) => {}),
      generateAppForLink: vi.fn(async (_url: string, _title: string) => app),
      installReplacementWebApp: vi.fn(async () => {}),
      onInstalled: onInstalled.api,
      onUninstalled: onUninstalled.api,
      onEnabled: onEnabled.api,
      onDisabled: onDisabled.api
    } satisfies ChromeManagementApi,
    events: { onInstalled: onInstalled.controls, onEnabled: onEnabled.controls, onDisabled: onDisabled.controls },
    onUninstalled: onUninstalled.controls
  }
}

type Api = ReturnType<typeof mockApi>["api"]

type Member = Exclude<keyof Api, "onInstalled" | "onUninstalled" | "onEnabled" | "onDisabled">

interface CallCase {
  /** The Chrome member, which is also the error's operation. */
  readonly operation: Member
  /** Runs the lazy call. */
  readonly run: (service: ChromeManagementService) => Effect.Effect<void, ChromeManagementError>
  /** Starts the gesture variant, when the call has one. */
  readonly gesture?: (service: ChromeManagementService) => Effect.Effect<void, ChromeManagementError>
  /** What Chrome receives. */
  readonly args: ReadonlyArray<string | boolean | UninstallOptions>
  /** Whether Chrome exposes it without the "management" permission. */
  readonly ungated?: true
}

const calls: ReadonlyArray<CallCase> = [
  { operation: "getSelf", run: (service) => Effect.asVoid(service.getSelf), args: [], ungated: true },
  { operation: "getAll", run: (service) => Effect.asVoid(service.getAll), args: [] },
  { operation: "get", run: (service) => Effect.asVoid(service.get(info.id)), args: [info.id] },
  {
    operation: "getPermissionWarningsById",
    run: (service) => Effect.asVoid(service.getPermissionWarningsById(info.id)), args: [info.id]
  },
  {
    operation: "getPermissionWarningsByManifest",
    run: (service) => Effect.asVoid(service.getPermissionWarningsByManifest(manifest)), args: [manifest], ungated: true
  },
  {
    operation: "setEnabled", run: (service) => service.setEnabled(info.id, false),
    gesture: (service) => service.setEnabledFromUserGesture(info.id, false), args: [info.id, false]
  },
  {
    operation: "uninstall", run: (service) => service.uninstall(info.id),
    gesture: (service) => service.uninstallFromUserGesture(info.id), args: [info.id]
  },
  {
    operation: "uninstallSelf", run: (service) => service.uninstallSelf(),
    gesture: (service) => service.uninstallSelfFromUserGesture(), args: [], ungated: true
  },
  { operation: "launchApp", run: (service) => service.launchApp(app.id), args: [app.id] },
  {
    operation: "setLaunchType", run: (service) => service.setLaunchType(app.id, "OPEN_AS_WINDOW"),
    gesture: (service) => service.setLaunchTypeFromUserGesture(app.id, "OPEN_AS_WINDOW"), args: [app.id, "OPEN_AS_WINDOW"]
  },
  {
    operation: "createAppShortcut", run: (service) => service.createAppShortcut(app.id),
    gesture: (service) => service.createAppShortcutFromUserGesture(app.id), args: [app.id]
  },
  {
    operation: "generateAppForLink", run: (service) => Effect.asVoid(service.generateAppForLink("https://docs.example.com/", "Docs")),
    gesture: (service) => Effect.asVoid(service.generateAppForLinkFromUserGesture("https://docs.example.com/", "Docs")),
    args: ["https://docs.example.com/", "Docs"]
  },
  {
    operation: "installReplacementWebApp", run: (service) => service.installReplacementWebApp,
    gesture: (service) => service.installReplacementWebAppFromUserGesture(), args: []
  }
]

const gestureCalls = calls.flatMap((call) => call.gesture === undefined ? [] : [{ ...call, gesture: call.gesture }])

/** Every way a call reaches Chrome: lazily, and through its gesture variant when it has one. */
const variants = calls.flatMap((call) => [
  { name: call.operation, operation: call.operation, start: call.run, args: call.args },
  ...call.gesture === undefined
    ? []
    : [{ name: `${call.operation}FromUserGesture`, operation: call.operation, start: call.gesture, args: call.args }]
])

/** Runs any of the service's streams to completion. */
const drain = (stream: Stream.Stream<ExtensionInfo | string, ChromeManagementError>) => Stream.runDrain(stream)

const failing = (synchronous: boolean, cause: Error) => () => {
  if (synchronous) throw cause

  return Promise.reject(cause)
}

describe("ChromeManagement", () => {
  it.effect("reads installed items and permission warnings", () => Effect.gen(function*() {
    const { api } = mockApi()
    const management = make(api)
    expect(yield* management.getSelf).toBe(info)
    expect(yield* management.getAll).toEqual([info, app])
    expect(yield* management.get(info.id)).toBe(info)
    expect(api.get).toHaveBeenCalledExactlyOnceWith(info.id)
    expect(yield* management.getPermissionWarningsById(info.id)).toEqual(["Read your browsing history"])
    expect(api.getPermissionWarningsById).toHaveBeenCalledExactlyOnceWith(info.id)
    expect(yield* management.getPermissionWarningsByManifest(manifest)).toEqual(["Read and change all your data"])
    expect(api.getPermissionWarningsByManifest).toHaveBeenCalledExactlyOnceWith(manifest)
    expect(yield* management.generateAppForLink("https://docs.example.com/", "Docs")).toBe(app)
  }))

  it.effect.each(calls)("calls $operation lazily, once per run, with exact arguments and the API receiver", (call) => Effect.gen(function*() {
    const { api } = mockApi()
    const method = api[call.operation]
    const effect = call.run(make(api))
    expect(method).not.toHaveBeenCalled()
    yield* effect
    yield* effect
    expect(method).toHaveBeenCalledTimes(2)
    expect(method.mock.calls).toEqual([call.args, call.args])
    expect(method.mock.contexts).toEqual([api, api])
  }))

  it.effect.each(gestureCalls)("starts $operation from a user gesture at once, exactly once, with the API receiver", (call) => Effect.gen(function*() {
    const { api } = mockApi()
    const method = api[call.operation]
    const outcome = call.gesture(make(api))
    expect(method.mock.calls).toEqual([call.args])
    expect(method.mock.contexts).toEqual([api])
    yield* outcome
    yield* outcome
    expect(method).toHaveBeenCalledOnce()
  }))

  it.effect("passes options only when given", () => Effect.gen(function*() {
    const { api } = mockApi()
    const management = make(api)
    const confirm: UninstallOptions = { showConfirmDialog: true }
    yield* management.uninstall(info.id)
    yield* management.uninstall(info.id, confirm)
    yield* management.uninstallFromUserGesture(info.id)
    yield* management.uninstallFromUserGesture(info.id, confirm)
    expect(api.uninstall.mock.calls).toEqual([[info.id], [info.id, confirm], [info.id], [info.id, confirm]])
    yield* management.uninstallSelf()
    yield* management.uninstallSelf({ showConfirmDialog: false })
    yield* management.uninstallSelfFromUserGesture()
    yield* management.uninstallSelfFromUserGesture(confirm)
    expect(api.uninstallSelf.mock.calls).toEqual([[], [{ showConfirmDialog: false }], [], [confirm]])
    expect(api.uninstallSelf.mock.calls[0]).toHaveLength(0)
    expect(api.uninstallSelf.mock.calls[2]).toHaveLength(0)
    yield* management.uninstallSelf({})
    expect(api.uninstallSelf.mock.lastCall).toEqual([{}])
  }))

  it.effect.each(variants)("types a rejected and a thrown $name as $operation", (variant) => Effect.gen(function*() {
    for (const synchronous of [true, false]) {
      const cause = new Error(`${variant.name} failed`)
      const api: ChromeManagementApi = { ...mockApi().api, [variant.operation]: failing(synchronous, cause) }
      const error = yield* Effect.flip(variant.start(make(api)))
      expect(error).toBeInstanceOf(ChromeManagementError)
      expect(error).toMatchObject({ operation: variant.operation, cause })
    }
  }))

  it.effect.each(variants)("types a throwing member getter for $name as $operation", (variant) => Effect.gen(function*() {
    const cause = new Error("access denied")
    const { api } = mockApi()
    Object.defineProperty(api, variant.operation, { get: () => { throw cause } })
    expect(yield* Effect.flip(variant.start(make(api)))).toMatchObject({ operation: variant.operation, cause })
  }))

  it.effect.each(variants)("types a non-Promise result from $name as $operation", (variant) => Effect.gen(function*() {
    const { api } = mockApi()
    Object.defineProperty(api, variant.operation, { value: () => undefined })
    const error = yield* Effect.flip(variant.start(make(api)))
    expect(error.operation).toBe(variant.operation)
    expect(error.cause).toBeInstanceOf(TypeError)
  }))

  it.effect("fails gated calls and events with typed errors when the API lacks the management permission", () => Effect.gen(function*() {
    const { api } = mockApi()

    // As Chrome exposes chrome.management to an extension without the permission.
    const restricted: ChromeManagementApi = {
      getSelf: api.getSelf, getPermissionWarningsByManifest: api.getPermissionWarningsByManifest, uninstallSelf: api.uninstallSelf
    }

    const management = make(restricted)

    for (const call of calls) {
      const exit = yield* Effect.exit(call.run(management))

      if (call.ungated === true) {
        expect(exit).toEqual(Exit.void)
        continue
      }

      const error = yield* Effect.flip(call.run(management))
      expect(error).toBeInstanceOf(ChromeManagementError)
      expect(error.operation).toBe(call.operation)
      expect(error.cause).toBeInstanceOf(Error)
      const requirement = call.operation === "installReplacementWebApp" ? "replacement_web_app" : "\"management\" permission"
      expect(String(error.cause)).toContain(`chrome.management.${call.operation} is unavailable`)
      expect(String(error.cause)).toContain(requirement)
    }

    for (const call of gestureCalls.filter((gesture) => gesture.ungated === undefined)) {
      expect(yield* Effect.flip(call.gesture(management))).toMatchObject({ operation: call.operation })
    }

    for (const operation of ["onInstalled", "onUninstalled", "onEnabled", "onDisabled"] as const) {
      const exit = yield* Effect.exit(drain(management[operation]))
      expect(Exit.hasDies(exit)).toBe(false)
      const error = yield* Effect.flip(drain(management[operation]))
      expect(error).toBeInstanceOf(ChromeManagementError)
      expect(error.operation).toBe(operation)
      expect(String(error.cause)).toContain(`chrome.management.${operation} is unavailable`)
    }

    expect(api.getAll).not.toHaveBeenCalled()
  }))

  it.effect("keeps the permission-free calls working on a restricted API", () => Effect.gen(function*() {
    const { api } = mockApi()
    const management = make({ getSelf: api.getSelf, getPermissionWarningsByManifest: api.getPermissionWarningsByManifest, uninstallSelf: api.uninstallSelf })
    expect(yield* management.getSelf).toBe(info)
    expect(yield* management.getPermissionWarningsByManifest(manifest)).toEqual(["Read and change all your data"])
    yield* management.uninstallSelfFromUserGesture({ showConfirmDialog: true })
    expect(api.uninstallSelf).toHaveBeenCalledExactlyOnceWith({ showConfirmDialog: true })
  }))

  it.effect.each(gestureCalls)("shares one $operation gesture outcome, rejection included, without reissuing it", (call) => Effect.gen(function*() {
    for (const synchronous of [true, false]) {
      const cause = new Error("The user did not accept the re-enable dialog.")
      const native = vi.fn(failing(synchronous, cause))
      const api: ChromeManagementApi = { ...mockApi().api, [call.operation]: native }
      const outcome = call.gesture(make(api))

      for (let attempt = 0; attempt < 3; attempt++) {
        expect(yield* Effect.flip(outcome)).toMatchObject({ operation: call.operation, cause })
      }

      expect(native).toHaveBeenCalledOnce()
    }
  }))

  it.effect("waits for a pending gesture call and survives interruption of the waiter", () => Effect.gen(function*() {
    const { api } = mockApi()
    let settle!: (error?: Error) => void
    api.uninstall.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
      settle = (error) => error === undefined ? resolve() : reject(error)
    }))
    const outcome = make(api).uninstallFromUserGesture(info.id)
    const waiter = yield* Effect.forkChild(outcome)
    yield* Fiber.interrupt(waiter)
    const exit = yield* Fiber.await(waiter)
    expect(Exit.hasInterrupts(exit)).toBe(true)
    const cause = new Error(`Extension ${info.id} uninstall canceled by user.`)
    settle(cause)
    expect(yield* Effect.flip(outcome)).toMatchObject({ operation: "uninstall", cause })
    expect(api.uninstall).toHaveBeenCalledOnce()
  }))

  it.effect("delivers a gesture outcome to concurrent observers that joined before it settled", () => Effect.gen(function*() {
    const { api } = mockApi()
    let resolve!: (value: ExtensionInfo) => void
    api.generateAppForLink.mockImplementationOnce(() => new Promise<ExtensionInfo>((done) => { resolve = done }))
    const outcome = make(api).generateAppForLinkFromUserGesture("https://docs.example.com/", "Docs")
    const observers = yield* Effect.forEach(Array.from({ length: 8 }), () => Effect.forkChild(outcome))
    resolve(app)
    expect(yield* Effect.forEach(observers, Fiber.join)).toEqual(Array.from({ length: 8 }, () => app))
    expect(api.generateAppForLink).toHaveBeenCalledOnce()
  }))

  // An unobserved gesture call is an intentional native boundary: its rejection must not leak.
  it("absorbs the rejection of a gesture call whose Effect never runs", async () => {
    const { api } = mockApi()
    const cause = new Error("chrome.management.uninstall requires a user gesture.")
    api.uninstall.mockRejectedValueOnce(cause)
    const unhandled = vi.fn()
    process.on("unhandledRejection", unhandled)

    try {
      expect(Effect.isEffect(make(api).uninstallFromUserGesture(info.id))).toBe(true)
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
      expect(unhandled).not.toHaveBeenCalled()
      expect(api.uninstall).toHaveBeenCalledOnce()
    } finally {
      process.off("unhandledRejection", unhandled)
    }
  })

  it.effect.each(["onInstalled", "onEnabled", "onDisabled"] as const)("streams %s while consumed and removes its listener", (name) => Effect.gen(function*() {
    const mock = mockApi()
    const stream = make(mock.api)[name]
    expect(mock.events[name].listenerCount).toBe(0)
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 2)))
    yield* Effect.promise(() => mock.events[name].waitForListener())
    expect(mock.events[name].listenerCount).toBe(1)
    mock.events[name].emit(info)
    mock.events[name].emit(app)
    expect(yield* Fiber.join(fiber)).toEqual([info, app])
    expect(mock.events[name].listenerCount).toBe(0)
  }))

  it.effect("streams uninstalled ids and removes its listener", () => Effect.gen(function*() {
    const mock = mockApi()
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(make(mock.api).onUninstalled, 2)))
    yield* Effect.promise(() => mock.onUninstalled.waitForListener())
    mock.onUninstalled.emit(info.id)
    mock.onUninstalled.emit(app.id)
    expect(yield* Fiber.join(fiber)).toEqual([info.id, app.id])
    expect(mock.onUninstalled.listenerCount).toBe(0)
  }))

  it.effect.each(["onInstalled", "onEnabled", "onDisabled"] as const)("removes the %s listener when interrupted", (name) => Effect.gen(function*() {
    const mock = mockApi()
    const fiber = yield* Effect.forkChild(Stream.runDrain(make(mock.api)[name]))
    yield* Effect.promise(() => mock.events[name].waitForListener())
    yield* Fiber.interrupt(fiber)
    expect(mock.events[name].listenerCount).toBe(0)
    expect(mock.events[name].emit(info)).toEqual([])
  }))

  it.effect("removes the onUninstalled listener when interrupted", () => Effect.gen(function*() {
    const mock = mockApi()
    const fiber = yield* Effect.forkChild(Stream.runDrain(make(mock.api).onUninstalled))
    yield* Effect.promise(() => mock.onUninstalled.waitForListener())
    yield* Fiber.interrupt(fiber)
    expect(mock.onUninstalled.listenerCount).toBe(0)
  }))

  it.effect.each(["onInstalled", "onEnabled", "onDisabled"] as const)("types a failing %s registration and leaves no listener", (name) => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("event unavailable")
    mock.events[name].failNext("addListener", cause)
    const error = yield* Effect.flip(Stream.runDrain(make(mock.api)[name]))
    expect(error).toBeInstanceOf(ChromeManagementError)
    expect(error).toMatchObject({ operation: name, cause })
    expect(mock.events[name].listenerCount).toBe(0)
  }))

  it.effect("types a failing onUninstalled registration and leaves no listener", () => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("event unavailable")
    mock.onUninstalled.failNext("addListener", cause)
    expect(yield* Effect.flip(Stream.runDrain(make(mock.api).onUninstalled))).toMatchObject({ operation: "onUninstalled", cause })
    expect(mock.onUninstalled.listenerCount).toBe(0)
  }))

  it.effect.each(["onInstalled", "onUninstalled", "onEnabled", "onDisabled"] as const)("types a throwing %s getter", (name) => Effect.gen(function*() {
    const { api } = mockApi()
    const cause = new Error("access denied")
    Object.defineProperty(api, name, { get: () => { throw cause } })
    const exit = yield* Effect.exit(drain(make(api)[name]))
    expect(Exit.hasDies(exit)).toBe(false)
    expect(yield* Effect.flip(drain(make(api)[name]))).toMatchObject({ operation: name, cause })
  }))

  it.effect("registers nothing until a stream runs, and one listener per consumption", () => Effect.gen(function*() {
    const mock = mockApi()
    let added = 0
    let allAdded!: () => void
    const registered = new Promise<void>((resolve) => { allAdded = resolve })

    const counted: ChromeManagementApi = {
      ...mock.api,
      onInstalled: {
        addListener: (listener) => {
          mock.api.onInstalled.addListener(listener)
          added++

          if (added === 3) allAdded()
        },
        removeListener: (listener) => mock.api.onInstalled.removeListener(listener)
      }
    }

    const management = make(counted)
    expect(added).toBe(0)
    const fibers = yield* Effect.forEach([1, 2, 3], () => Effect.forkChild(Stream.runCollect(Stream.take(management.onInstalled, 1))))
    yield* Effect.promise(() => registered)
    expect(mock.events.onInstalled.listenerCount).toBe(3)
    mock.events.onInstalled.emit(info)
    expect(yield* Effect.forEach(fibers, Fiber.join)).toEqual([[info], [info], [info]])
    expect(mock.events.onInstalled.listenerCount).toBe(0)
  }))

  it.effect("provides an injected API and reads the global only when the live layer builds", () => Effect.gen(function*() {
    const { api } = mockApi()
    expect(yield* Effect.flatMap(ChromeManagement, (service) => service.getSelf).pipe(Effect.provide(layer(api)))).toBe(info)
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", {})), () => Effect.sync(() => vi.unstubAllGlobals()))
    const missing = yield* Effect.flip(ChromeManagement.pipe(Effect.provide(layerLive)))
    expect(missing).toBeInstanceOf(ChromeManagementError)
    expect(missing).toMatchObject({ operation: "initialize" })
    expect(String(missing.cause)).toContain("chrome.management is unavailable")
    vi.stubGlobal("chrome", undefined)
    expect(yield* Effect.flip(ChromeManagement.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
    const cause = new Error("access denied")
    vi.stubGlobal("chrome", { get management() { throw cause } })
    expect(yield* Effect.flip(ChromeManagement.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize", cause })
    vi.stubGlobal("chrome", { management: api })
    expect(yield* Effect.flatMap(ChromeManagement, (service) => service.getAll).pipe(Effect.provide(layerLive))).toEqual([info, app])
    expect(api.getSelf).toHaveBeenCalledOnce()
  }))

  it.effect("builds the live layer on a namespace without the management permission", () => Effect.gen(function*() {
    const { api } = mockApi()
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", {
      management: { getSelf: api.getSelf, getPermissionWarningsByManifest: api.getPermissionWarningsByManifest, uninstallSelf: api.uninstallSelf }
    })), () => Effect.sync(() => vi.unstubAllGlobals()))

    const result = yield* Effect.gen(function*() {
      const management = yield* ChromeManagement

      return { self: yield* management.getSelf, all: yield* Effect.flip(management.getAll) }
    }).pipe(Effect.provide(layerLive))

    expect(result.self).toBe(info)
    expect(result.all).toMatchObject({ operation: "getAll" })
  }))

  it.effect("never reads the chrome global when making the service", () => Effect.gen(function*() {
    const { api } = mockApi()
    const read = vi.fn(() => api)
    yield* Effect.acquireRelease(
      Effect.sync(() => vi.stubGlobal("chrome", { get management() { return read() } })),
      () => Effect.sync(() => vi.unstubAllGlobals())
    )
    const management = make(api)
    yield* management.getAll
    expect(read).not.toHaveBeenCalled()
    yield* ChromeManagement.pipe(Effect.provide(layerLive))
    expect(read).toHaveBeenCalledOnce()
  }))

  it.effect("keeps interruption of a lazy call from becoming a typed error", () => Effect.gen(function*() {
    const { api } = mockApi()
    api.getAll.mockImplementationOnce(() => new Promise(() => {}))
    const fiber = yield* Effect.forkChild(make(api).getAll)
    yield* Effect.yieldNow
    yield* Fiber.interrupt(fiber)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  }))
})

describe("makeManagement", () => {
  const helper = (properties: Partial<ExtensionInfo> = {}) => extensionInfo(extensionId(1), { name: "Helper", ...properties })

  const docs = () => extensionInfo(extensionId(2), {
    name: "Docs", type: "packaged_app", availableLaunchTypes: ["OPEN_AS_REGULAR_TAB", "OPEN_AS_WINDOW"], launchType: "OPEN_AS_REGULAR_TAB"
  })

  const fixture = (options: ManagementOptions = {}) => {
    const management = makeManagement({ installed: [helper(), docs()], ...options })

    return { ...management, service: make(management.api) }
  }

  /** The message of a typed failure's cause. */
  const message = (error: ChromeManagementError): string => String(error.cause).replace(/^Error: /, "")

  it("numbers ids in Chrome's alphabet and fills complete entries", () => {
    expect(extensionId(0)).toBe("a".repeat(32))
    expect(extensionId(17)).toBe(`${"a".repeat(30)}bb`)
    expect(extensionId(Number.MAX_SAFE_INTEGER)).toMatch(/^[a-p]{32}$/)
    const ids = new Set(Array.from({ length: 1024 }, (_, index) => extensionId(index)))
    expect(ids.size).toBe(1024)
    expect(() => extensionId(-1)).toThrow(RangeError)
    expect(() => extensionId(1.5)).toThrow(RangeError)
    expect(extensionInfo("x")).toMatchObject({ id: "x", name: "Extension", shortName: "Extension", type: "extension", isApp: false, enabled: true })
    expect(extensionInfo("x", { name: "Tool" })).toMatchObject({ name: "Tool", shortName: "Tool" })
    expect(extensionInfo("x", { name: "Tool", shortName: "T" }).shortName).toBe("T")
    expect(extensionInfo("x", { type: "hosted_app" }).isApp).toBe(true)
    expect(extensionInfo("x", { type: "theme" }).isApp).toBe(false)
    expect(extensionInfo("x", { type: "hosted_app", isApp: false }).isApp).toBe(false)
    expect(() => makeManagement({ installed: [helper(), helper()] })).toThrow(/duplicate installed id/)
    expect(() => makeManagement({ installed: [extensionInfo(extensionId(0))] })).toThrow(/duplicate installed id/)
  })

  it.effect("lists the extension first, then installed items, as copies", () => Effect.gen(function*() {
    const { service, controls } = fixture({ self: { name: "Me" } })
    const self = yield* service.getSelf
    expect(self).toMatchObject({ id: extensionId(0), name: "Me", shortName: "Me" })
    const all = yield* service.getAll
    expect(all.map((item) => item.id)).toEqual([extensionId(0), extensionId(1), extensionId(2)])
    expect(controls.ids).toEqual(all.map((item) => item.id))
    self.name = "Changed"
    all[1]?.permissions.push("tabs")
    expect((yield* service.getSelf).name).toBe("Me")
    expect((yield* service.get(extensionId(1))).permissions).toEqual([])
    expect(yield* service.get(extensionId(2))).toEqual(docs())
    const error = yield* Effect.flip(service.get("missing"))
    expect(error.operation).toBe("get")
    expect(message(error)).toBe("Failed to find extension with id missing.")
  }))

  it.effect("reports configured warnings for installed items and manifests", () => Effect.gen(function*() {
    const warnings = new Map([["tabs", "Read your browsing history"], ["<all_urls>", "Read and change all your data on all websites"]])
    const { service } = fixture({ installed: [helper({ permissions: ["storage", "tabs"], hostPermissions: ["<all_urls>"] })], warnings })
    expect(yield* service.getPermissionWarningsById(extensionId(1))).toEqual(["Read your browsing history", "Read and change all your data on all websites"])
    expect(yield* service.getPermissionWarningsById(extensionId(0))).toEqual([])
    expect(message(yield* Effect.flip(service.getPermissionWarningsById("missing")))).toBe("Failed to find extension with id missing.")
    const valid = { name: "x", version: "1", manifest_version: 3 }
    expect(yield* service.getPermissionWarningsByManifest(JSON.stringify({ ...valid, permissions: ["tabs", 7, "alarms"], host_permissions: ["<all_urls>"] })))
      .toEqual(["Read your browsing history", "Read and change all your data on all websites"])
    expect(yield* service.getPermissionWarningsByManifest(JSON.stringify(valid))).toEqual([])
    const invalid = yield* Effect.flip(service.getPermissionWarningsByManifest("{ name: x }"))
    expect(invalid.operation).toBe("getPermissionWarningsByManifest")
    expect(invalid.cause).toBeInstanceOf(SyntaxError)

    for (const text of ["[]", "null", "3", "\"manifest\""]) {
      expect(message(yield* Effect.flip(service.getPermissionWarningsByManifest(text)))).toBe("Failed to parse manifest.")
    }

    for (const manifestObject of [{}, { name: "x", version: "1" }, { ...valid, manifest_version: "3" }, { ...valid, permissions: "tabs" }]) {
      expect(message(yield* Effect.flip(service.getPermissionWarningsByManifest(JSON.stringify(manifestObject)))))
        .toBe("Failed to create extension from manifest.")
    }
  }))

  it.effect("disables and enables items, emitting only real changes", () => Effect.gen(function*() {
    const { service, controls } = fixture()
    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(Stream.merge(service.onDisabled, service.onEnabled), 2)))
    yield* Effect.promise(() => controls.onEnabled.waitForListener())
    yield* Effect.promise(() => controls.onDisabled.waitForListener())
    yield* service.setEnabled(extensionId(1), true)
    yield* service.setEnabled(extensionId(1), false)
    yield* service.setEnabled(extensionId(1), false)
    expect(controls.item(extensionId(1))).toMatchObject({ enabled: false, disabledReason: "unknown", mayEnable: true })
    yield* service.setEnabled(extensionId(1), true)
    const [off, on] = yield* Fiber.join(fiber)
    expect(off).toMatchObject({ id: extensionId(1), enabled: false, disabledReason: "unknown" })
    expect(on).toEqual(helper())
    expect(controls.item(extensionId(1))).toEqual(helper())
    expect(message(yield* Effect.flip(service.setEnabled("missing", false)))).toBe("Failed to find extension with id missing.")
  }))

  it.effect("refuses changes the user may not make", () => Effect.gen(function*() {
    const locked = extensionInfo(extensionId(3), { mayDisable: false, installType: "admin" })
    const blocked = extensionInfo(extensionId(4), { enabled: false, mayEnable: false, disabledReason: "unknown" })
    const { service, controls } = fixture({ installed: [locked, blocked] })

    for (const effect of [service.setEnabled(locked.id, false), service.setEnabled(locked.id, true), service.uninstallFromUserGesture(locked.id)]) {
      expect(message(yield* Effect.flip(effect))).toBe(`Extension ${locked.id} cannot be modified by user.`)
    }

    expect(message(yield* Effect.flip(service.setEnabled(blocked.id, true)))).toBe(`Extension ${blocked.id} cannot be modified by user.`)
    yield* service.setEnabled(blocked.id, false)
    expect(controls.item(locked.id)).toEqual(locked)
    expect(controls.item(blocked.id)).toEqual(blocked)
  }))

  it.effect("needs a gesture and an accepted prompt to re-enable after a permissions increase", () => Effect.gen(function*() {
    const { service, controls } = fixture()
    controls.setEnabled(extensionId(1), false, "permissions_increase")
    expect(controls.item(extensionId(1))).toMatchObject({ enabled: false, disabledReason: "permissions_increase" })
    const lazy = controls.withUserGesture(() => service.setEnabled(extensionId(1), true))
    const error = yield* Effect.flip(lazy)
    expect(error.operation).toBe("setEnabled")
    expect(message(error)).toBe("Re-enabling an extension disabled due to permissions increase requires a user gesture.")
    controls.answerDialogs("cancel")
    const declined = controls.withUserGesture(() => service.setEnabledFromUserGesture(extensionId(1), true))
    expect(message(yield* Effect.flip(declined))).toBe("The user did not accept the re-enable dialog.")
    expect(controls.item(extensionId(1))?.enabled).toBe(false)
    controls.answerDialogs("accept")
    yield* controls.withUserGesture(() => service.setEnabledFromUserGesture(extensionId(1), true))
    expect(controls.item(extensionId(1))).toEqual(helper())
    controls.setEnabled(extensionId(1), false)
    yield* service.setEnabled(extensionId(1), true)
    expect(controls.item(extensionId(1))?.enabled).toBe(true)
  }))

  it.effect("uninstalls other items only from a gesture with a confirmed dialog", () => Effect.gen(function*() {
    const { service, controls } = fixture()
    const ids = yield* Effect.forkChild(Stream.runCollect(Stream.take(service.onUninstalled, 1)))
    yield* Effect.promise(() => controls.onUninstalled.waitForListener())
    const noGesture = yield* Effect.flip(service.uninstall(extensionId(1), { showConfirmDialog: false }))
    expect(noGesture.operation).toBe("uninstall")
    expect(message(noGesture)).toBe("chrome.management.uninstall requires a user gesture.")
    const late = controls.withUserGesture(() => service.uninstall(extensionId(1)))
    expect(message(yield* Effect.flip(late))).toBe("chrome.management.uninstall requires a user gesture.")
    controls.answerDialogs("cancel")
    const cancelled = controls.withUserGesture(() => service.uninstallFromUserGesture(extensionId(1)))
    expect(message(yield* Effect.flip(cancelled))).toBe(`Extension ${extensionId(1)} uninstall canceled by user.`)
    expect(controls.item(extensionId(1))).toBeDefined()
    controls.answerDialogs("accept")
    yield* controls.withUserGesture(() => service.uninstallFromUserGesture(extensionId(1)))
    expect(yield* Fiber.join(ids)).toEqual([extensionId(1)])
    expect(controls.item(extensionId(1))).toBeUndefined()
    expect(message(yield* Effect.flip(controls.withUserGesture(() => service.uninstallFromUserGesture(extensionId(1))))))
      .toBe(`Failed to find extension with id ${extensionId(1)}.`)
  }))

  it.effect("holds dialogs until answered and acts on the state at that moment", () => Effect.gen(function*() {
    const { service, controls } = fixture()
    controls.answerDialogs("hold")
    const first = controls.withUserGesture(() => service.uninstallFromUserGesture(extensionId(1)))
    const second = controls.withUserGesture(() => service.createAppShortcutFromUserGesture(extensionId(2)))
    expect(controls.pendingDialogs).toEqual([{ kind: "uninstall", id: extensionId(1) }, { kind: "createAppShortcut", id: extensionId(2) }])
    controls.answerDialogs("accept")
    expect(controls.pendingDialogs).toHaveLength(2)
    expect(controls.uninstall(extensionId(1))).toEqual([])
    expect(controls.answerDialog(true)).toEqual({ kind: "uninstall", id: extensionId(1) })
    expect(message(yield* Effect.flip(first))).toBe(`Failed to find extension with id ${extensionId(1)}.`)
    expect(controls.answerDialog(false)).toEqual({ kind: "createAppShortcut", id: extensionId(2) })
    expect(message(yield* Effect.flip(second))).toBe("App shortcuts creation canceled by user.")
    expect(controls.shortcuts).toEqual([])
    expect(() => controls.answerDialog(true)).toThrow("No dialog is pending")
  }))

  it.effect("uninstalls itself, invalidating every later call", () => Effect.gen(function*() {
    const { service, controls } = fixture()
    const removed = yield* Effect.forkChild(Stream.runCollect(Stream.take(service.onUninstalled, 1)))
    yield* Effect.promise(() => controls.onUninstalled.waitForListener())
    expect(message(yield* Effect.flip(service.uninstallSelf({ showConfirmDialog: true }))))
      .toBe("chrome.management.uninstall requires a user gesture.")
    controls.answerDialogs("cancel")
    const cancelled = controls.withUserGesture(() => service.uninstallSelfFromUserGesture({ showConfirmDialog: true }))
    expect(yield* Effect.flip(cancelled)).toMatchObject({ operation: "uninstallSelf" })
    expect(controls.selfUninstalled).toBe(false)
    yield* service.uninstallSelf()
    expect(controls.selfUninstalled).toBe(true)
    expect(controls.self).toBeUndefined()

    for (const call of calls) {
      const error = yield* Effect.flip(call.run(service))
      expect(error.operation).toBe(call.operation)
      expect(message(error)).toBe(call.operation === "installReplacementWebApp"
        ? "chrome.management.installReplacementWebApp is unavailable: it requires the \"replacement_web_app\" manifest key"
        : "Extension context invalidated.")
    }

    controls.onUninstalled.emit(extensionId(9))
    expect(yield* Fiber.join(removed)).toEqual([extensionId(9)])
  }))

  it.effect("honours showConfirmDialog when uninstalling its own id through uninstall", () => Effect.gen(function*() {
    const { service, controls } = fixture()
    expect(message(yield* Effect.flip(service.uninstall(extensionId(0), { showConfirmDialog: true }))))
      .toBe("chrome.management.uninstall requires a user gesture.")
    yield* service.uninstall(extensionId(0))
    expect(controls.selfUninstalled).toBe(true)
  }))

  it.effect("launches apps and changes their launch type within a gesture", () => Effect.gen(function*() {
    const { service, controls } = fixture()
    yield* service.launchApp(extensionId(2))
    expect(controls.launches).toEqual([extensionId(2)])
    expect(message(yield* Effect.flip(service.launchApp(extensionId(1))))).toBe(`Extension ${extensionId(1)} is not an App.`)
    expect(message(yield* Effect.flip(service.launchApp("missing")))).toBe("Failed to find extension with id missing.")
    expect(message(yield* Effect.flip(service.setLaunchType(extensionId(2), "OPEN_AS_WINDOW"))))
      .toBe("chrome.management.setLaunchType requires a user gesture.")
    yield* controls.withUserGesture(() => service.setLaunchTypeFromUserGesture(extensionId(2), "OPEN_AS_WINDOW"))
    expect(controls.item(extensionId(2))?.launchType).toBe("OPEN_AS_WINDOW")
    expect(message(yield* Effect.flip(controls.withUserGesture(() => service.setLaunchTypeFromUserGesture(extensionId(2), "OPEN_FULL_SCREEN")))))
      .toBe("The launch type is not available for this app.")
    expect(message(yield* Effect.flip(controls.withUserGesture(() => service.setLaunchTypeFromUserGesture(extensionId(1), "OPEN_AS_WINDOW")))))
      .toBe(`Extension ${extensionId(1)} is not an App.`)
  }))

  it.effect("creates app shortcuts within a gesture after the dialog", () => Effect.gen(function*() {
    const { service, controls } = fixture()
    expect(message(yield* Effect.flip(service.createAppShortcut(extensionId(2))))).toBe("chrome.management.createAppShortcut requires a user gesture.")
    yield* controls.withUserGesture(() => service.createAppShortcutFromUserGesture(extensionId(2)))
    expect(controls.shortcuts).toEqual([extensionId(2)])
    expect(message(yield* Effect.flip(controls.withUserGesture(() => service.createAppShortcutFromUserGesture(extensionId(1))))))
      .toBe(`Extension ${extensionId(1)} is not an App.`)
  }))

  it.effect("generates apps for http(s) links within a gesture", () => Effect.gen(function*() {
    const { service, controls } = fixture()
    const installed = yield* Effect.forkChild(Stream.runCollect(Stream.take(service.onInstalled, 2)))
    yield* Effect.promise(() => controls.onInstalled.waitForListener())
    expect(message(yield* Effect.flip(service.generateAppForLink("https://example.com/", "Example"))))
      .toBe("chrome.management.generateAppForLink requires a user gesture.")

    for (const url of ["ftp://example.com/", "not a url", "javascript:alert(1)", ""]) {
      expect(message(yield* Effect.flip(controls.withUserGesture(() => service.generateAppForLinkFromUserGesture(url, "Example")))))
        .toBe(`The URL "${url}" is invalid.`)
    }

    expect(message(yield* Effect.flip(controls.withUserGesture(() => service.generateAppForLinkFromUserGesture("https://example.com/", "")))))
      .toBe("The title can not be empty.")
    const first = yield* controls.withUserGesture(() => service.generateAppForLinkFromUserGesture("https://example.com/", "Example"))
    const second = yield* controls.withUserGesture(() => service.generateAppForLinkFromUserGesture("http://example.org/", "Org"))
    expect(first).toMatchObject({ name: "Example", type: "hosted_app", isApp: true, appLaunchUrl: "https://example.com/" })
    expect(second.id).not.toBe(first.id)
    expect(yield* Fiber.join(installed)).toEqual([first, second])
    expect(yield* service.get(first.id)).toEqual(first)
    yield* service.launchApp(first.id)
    expect(controls.launches).toEqual([first.id])
  }))

  it.effect("exposes installReplacementWebApp only with the manifest key, inside a gesture", () => Effect.gen(function*() {
    expect("installReplacementWebApp" in fixture().api).toBe(false)
    const { service, controls, api } = fixture({ replacementWebApp: "https://app.example.com/" })
    expect("installReplacementWebApp" in api).toBe(true)
    expect(message(yield* Effect.flip(service.installReplacementWebApp))).toBe("chrome.management.installReplacementWebApp requires a user gesture.")
    yield* controls.withUserGesture(() => service.installReplacementWebAppFromUserGesture())
    expect(controls.replacementWebAppLaunches).toEqual(["https://app.example.com/"])
  }))

  it.effect("drops the gated members without the management permission", () => Effect.gen(function*() {
    const { service, api } = fixture({ permission: false, replacementWebApp: "https://app.example.com/" })
    expect(Object.keys(api).sort()).toEqual(["getPermissionWarningsByManifest", "getSelf", "installReplacementWebApp", "uninstallSelf"])
    expect((yield* service.getSelf).id).toBe(extensionId(0))
    const error = yield* Effect.flip(service.getAll)
    expect(message(error)).toBe("chrome.management.getAll is unavailable: it requires the \"management\" permission")
    expect(yield* Effect.flip(drain(service.onEnabled))).toMatchObject({ operation: "onEnabled" })
  }))

  it.effect("simulates installs, removals and state changes outside the API", () => Effect.gen(function*() {
    const { service, controls } = fixture()
    const events = yield* Effect.forkChild(Stream.runCollect(Stream.take(Stream.merge(service.onInstalled, service.onDisabled), 3)))
    yield* Effect.promise(() => controls.onInstalled.waitForListener())
    yield* Effect.promise(() => controls.onDisabled.waitForListener())
    const added = extensionInfo(extensionId(5), { name: "Added" })
    expect(controls.install(added)).toEqual([])
    expect(controls.install({ ...added, version: "2.0.0" })).toEqual([])
    expect(controls.setEnabled(extensionId(5), false, "permissions_increase")).toEqual([])
    expect(controls.setEnabled(extensionId(5), false)).toEqual([])
    const [first, updated, disabled] = yield* Fiber.join(events)
    expect(first).toEqual(added)
    expect(updated).toMatchObject({ version: "2.0.0" })
    expect(disabled).toMatchObject({ enabled: false, disabledReason: "permissions_increase", mayEnable: true })
    expect(controls.ids).toEqual([extensionId(0), extensionId(1), extensionId(2), extensionId(5)])
    expect(() => controls.uninstall("missing")).toThrow("Failed to find extension with id missing.")
    expect(() => controls.setEnabled("missing", true)).toThrow("Failed to find extension with id missing.")
  }))

  it.effect("limits a gesture to the callback's synchronous run, restoring it after throws and nesting", () => Effect.gen(function*() {
    const { controls, service } = fixture()
    expect(controls.withUserGesture(() => controls.withUserGesture(() => 1) + 1)).toBe(2)
    expect(() => controls.withUserGesture(() => { throw new Error("handler failed") })).toThrow("handler failed")
    expect(message(yield* Effect.flip(service.createAppShortcut(extensionId(2))))).toBe("chrome.management.createAppShortcut requires a user gesture.")

    const nested = controls.withUserGesture(() => {
      controls.withUserGesture(() => 0)

      return service.createAppShortcutFromUserGesture(extensionId(2))
    })

    yield* nested
    expect(controls.shortcuts).toEqual([extensionId(2)])
  }))

  it.effect("replaces members through overrides and provides its layer", () => Effect.gen(function*() {
    const getSelf = vi.fn(async () => helper())
    const { layer: provided, controls } = makeManagement({ overrides: { getSelf } })
    expect(yield* Effect.flatMap(ChromeManagement, (service) => service.getSelf).pipe(Effect.provide(provided))).toEqual(helper())
    expect(getSelf).toHaveBeenCalledOnce()
    expect(controls.self?.id).toBe(extensionId(0))
  }))
})
