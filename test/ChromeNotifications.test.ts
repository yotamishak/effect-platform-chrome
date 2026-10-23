// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Deferred, Effect, Exit, Fiber, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeNotifications, ChromeNotificationsError, layer, layerLive, make } from "../src/ChromeNotifications.js"
import type {
  ButtonClickedEvent,
  ChromeNotificationsApi,
  ChromeNotificationsService,
  ClosedEvent,
  NotificationCreateOptions,
  NotificationOptions,
  PermissionLevel
} from "../src/ChromeNotifications.js"
import { makeEvent } from "../src/ChromeTesting.js"
import type { EventSource } from "../src/internal/event.js"
import { makeNotifications, notificationErrors, notificationIntegerError } from "../src/testing/Notifications.js"

const options: NotificationCreateOptions = {
  type: "basic", iconUrl: "icon.png", title: "Sign-in needs you", message: "Approve the request"
}

/**
 * A simulated Chrome event with a gate that completes once `size` listeners are registered at
 * the same time, so tests synchronize on registration instead of scheduler turns.
 */
const gatedEvent = <Args extends ReadonlyArray<unknown>>() => {
  const event = makeEvent<Args>()
  const gates: Array<{ readonly size: number; readonly deferred: Deferred.Deferred<void> }> = []

  const open = () => {
    for (const gate of gates.splice(0)) {
      if (event.controls.listenerCount >= gate.size) Deferred.doneUnsafe(gate.deferred, Effect.void)
      else gates.push(gate)
    }
  }

  const api: EventSource<Args> = {
    addListener: (listener) => {
      event.api.addListener(listener)
      open()
    },
    removeListener: (listener) => event.api.removeListener(listener)
  }

  return {
    api,
    get listenerCount() { return event.controls.listenerCount },
    failNext: event.controls.failNext,
    emit: event.controls.emit,
    registered: (size: number): Effect.Effect<void> => Effect.suspend(() => {
      if (event.controls.listenerCount >= size) return Effect.void

      const deferred = Deferred.makeUnsafe<void>()
      gates.push({ size, deferred })

      return Deferred.await(deferred)
    })
  }
}

const mockApi = () => {
  const onClicked = gatedEvent<[string]>()
  const onButtonClicked = gatedEvent<[string, number]>()
  const onClosed = gatedEvent<[string, boolean]>()
  const onPermissionLevelChanged = gatedEvent<[PermissionLevel]>()

  const create = vi.fn(async (...args: [string, NotificationCreateOptions] | [NotificationCreateOptions]) =>
    args.length === 2 ? args[0] : "generated")

  const update = vi.fn(async (_notificationId: string, _options: NotificationOptions) => false)
  const clear = vi.fn(async (_notificationId: string) => true)
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
    api, create, update, clear, getAll, getPermissionLevel,
    onClicked,
    onButtonClicked,
    onClosed,
    onPermissionLevelChanged
  }
}

type Mock = ReturnType<typeof mockApi>

interface CallCase {
  readonly name: string
  readonly operation: string
  readonly fail: (mock: Mock, implementation: () => Promise<never>) => void
  readonly run: (service: ChromeNotificationsService) => Effect.Effect<void, ChromeNotificationsError>
}

const callCases: ReadonlyArray<CallCase> = [
  {
    name: "create with an id",
    operation: "create",
    fail: (mock, implementation) => { mock.create.mockImplementationOnce(implementation) },
    run: (service) => Effect.asVoid(service.create(options, "notice"))
  },
  {
    name: "create without an id",
    operation: "create",
    fail: (mock, implementation) => { mock.create.mockImplementationOnce(implementation) },
    run: (service) => Effect.asVoid(service.create(options))
  },
  {
    name: "update",
    operation: "update",
    fail: (mock, implementation) => { mock.update.mockImplementationOnce(implementation) },
    run: (service) => Effect.asVoid(service.update("notice", { progress: 10 }))
  },
  {
    name: "clear",
    operation: "clear",
    fail: (mock, implementation) => { mock.clear.mockImplementationOnce(implementation) },
    run: (service) => Effect.asVoid(service.clear("notice"))
  },
  {
    name: "getAll",
    operation: "getAll",
    fail: (mock, implementation) => { mock.getAll.mockImplementationOnce(implementation) },
    run: (service) => Effect.asVoid(service.getAll)
  },
  {
    name: "getPermissionLevel",
    operation: "getPermissionLevel",
    fail: (mock, implementation) => { mock.getPermissionLevel.mockImplementationOnce(implementation) },
    run: (service) => Effect.asVoid(service.getPermissionLevel)
  }
]

const failureCases = callCases.flatMap((call) => [
  { ...call, mode: "rejects" as const },
  { ...call, mode: "throws synchronously" as const }
])

type Emitted = string | ButtonClickedEvent | ClosedEvent

interface EventControls {
  readonly listenerCount: number
  readonly registered: (size: number) => Effect.Effect<void>
  readonly failNext: (operation: "addListener" | "removeListener", cause: Error) => void
}

interface StreamCase {
  readonly operation: "onClicked" | "onButtonClicked" | "onClosed" | "onPermissionLevelChanged"
  readonly controls: (mock: Mock) => EventControls
  readonly stream: (service: ChromeNotificationsService) => Stream.Stream<Emitted, ChromeNotificationsError>
  /** Emits the two events every case delivers. */
  readonly emit: (mock: Mock) => void
  readonly expected: ReadonlyArray<Emitted>
}

const streamCases: ReadonlyArray<StreamCase> = [
  {
    operation: "onClicked",
    controls: (mock) => mock.onClicked,
    stream: (service) => service.onClicked,
    emit: (mock) => {
      mock.onClicked.emit("notice-1")
      mock.onClicked.emit("notice-2")
    },
    expected: ["notice-1", "notice-2"]
  },
  {
    operation: "onButtonClicked",
    controls: (mock) => mock.onButtonClicked,
    stream: (service) => service.onButtonClicked,
    emit: (mock) => {
      mock.onButtonClicked.emit("notice-1", 0)
      mock.onButtonClicked.emit("notice-1", 1)
    },
    expected: [{ notificationId: "notice-1", buttonIndex: 0 }, { notificationId: "notice-1", buttonIndex: 1 }]
  },
  {
    operation: "onClosed",
    controls: (mock) => mock.onClosed,
    stream: (service) => service.onClosed,
    emit: (mock) => {
      mock.onClosed.emit("notice-1", true)
      mock.onClosed.emit("notice-2", false)
    },
    expected: [{ notificationId: "notice-1", byUser: true }, { notificationId: "notice-2", byUser: false }]
  },
  {
    operation: "onPermissionLevelChanged",
    controls: (mock) => mock.onPermissionLevelChanged,
    stream: (service) => service.onPermissionLevelChanged,
    emit: (mock) => {
      mock.onPermissionLevelChanged.emit("denied")
      mock.onPermissionLevelChanged.emit("granted")
    },
    expected: ["denied", "granted"]
  }
]

/** An event whose `addListener` registers the listener and then throws, as a partial registration. */
const partiallyRegistering = <Args extends ReadonlyArray<unknown>>(cause: Error) => {
  const inner = makeEvent<Args>()

  const source: EventSource<Args> = {
    addListener: (listener) => {
      inner.api.addListener(listener)

      throw cause
    },
    removeListener: (listener) => inner.api.removeListener(listener)
  }

  return { source, inner: inner.controls }
}

/** An event that records every listener it was given, to call one after its removal. */
const recording = <Args extends ReadonlyArray<unknown>>() => {
  const inner = makeEvent<Args>()
  const added: Array<(...args: Args) => void> = []

  const source: EventSource<Args> = {
    addListener: (listener) => {
      added.push(listener)
      inner.api.addListener(listener)
    },
    removeListener: (listener) => inner.api.removeListener(listener)
  }

  return { source, added, inner: inner.controls }
}

describe("ChromeNotifications", () => {
  it.effect("creates with a given id, passing it to Chrome only when given", () => Effect.gen(function*() {
    const mock = mockApi()
    const notifications = make(mock.api)

    expect(yield* notifications.create(options, "notice-1")).toBe("notice-1")
    expect(yield* notifications.create(options)).toBe("generated")
    expect(yield* notifications.create(options, "")).toBe("")
    expect(mock.create.mock.calls).toEqual([["notice-1", options], [options], ["", options]])
    expect(mock.create.mock.calls[1]).toHaveLength(1)
  }))

  it.effect("updates and clears by id, returning Chrome's booleans unchanged", () => Effect.gen(function*() {
    const mock = mockApi()
    const notifications = make(mock.api)

    expect(yield* notifications.update("missing", { progress: 40 })).toBe(false)
    expect(mock.update).toHaveBeenCalledExactlyOnceWith("missing", { progress: 40 })
    mock.update.mockResolvedValueOnce(true)
    expect(yield* notifications.update("notice", {})).toBe(true)
    expect(mock.update).toHaveBeenLastCalledWith("notice", {})
    expect(yield* notifications.clear("notice-1")).toBe(true)
    mock.clear.mockResolvedValueOnce(false)
    expect(yield* notifications.clear("notice-1")).toBe(false)
    expect(mock.clear.mock.calls).toEqual([["notice-1"], ["notice-1"]])
  }))

  it.effect("lists ids in Chrome's order and an empty set as an empty list", () => Effect.gen(function*() {
    const mock = mockApi()
    const notifications = make(mock.api)

    expect(yield* notifications.getAll).toEqual(["notice-1", "notice-2"])
    mock.getAll.mockResolvedValueOnce({ 2: true, 10: true, b: true, a: true })
    expect(yield* notifications.getAll).toEqual(["2", "10", "b", "a"])
    mock.getAll.mockResolvedValueOnce({})
    expect(yield* notifications.getAll).toEqual([])
    expect(mock.getAll).toHaveBeenCalledTimes(3)
    expect(mock.getAll.mock.calls.every((call) => call.length === 0)).toBe(true)
  }))

  it.effect("reads the permission level afresh on every run", () => Effect.gen(function*() {
    const mock = mockApi()
    const notifications = make(mock.api)

    expect(yield* notifications.getPermissionLevel).toBe("denied")
    mock.getPermissionLevel.mockResolvedValueOnce("granted")
    expect(yield* notifications.getPermissionLevel).toBe("granted")
    expect(mock.getPermissionLevel).toHaveBeenCalledTimes(2)
  }))

  it.effect("calls Chrome only when an operation runs", () => Effect.gen(function*() {
    const mock = mockApi()
    const notifications = make(mock.api)

    const effects = [
      notifications.create(options, "notice"), notifications.update("notice", {}), notifications.clear("notice"),
      notifications.getAll, notifications.getPermissionLevel
    ]

    for (const fn of [mock.create, mock.update, mock.clear, mock.getAll, mock.getPermissionLevel]) {
      expect(fn).not.toHaveBeenCalled()
    }

    yield* Effect.all(effects)

    for (const fn of [mock.create, mock.update, mock.clear, mock.getAll, mock.getPermissionLevel]) {
      expect(fn).toHaveBeenCalledTimes(1)
    }
  }))

  it.effect.each(failureCases)("types $name when Chrome $mode", (call) => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error(`${call.operation} failed`)

    call.fail(mock, call.mode === "rejects" ? async () => { throw cause } : () => { throw cause })
    const error = yield* Effect.flip(call.run(make(mock.api)))
    expect(error).toBeInstanceOf(ChromeNotificationsError)
    expect(error).toMatchObject({ operation: call.operation })
    expect(error.cause).toBe(cause)
    // The next call is unaffected.
    yield* call.run(make(mock.api))
  }))

  it.effect.each(streamCases)("$operation delivers in order and removes its listener when it ends", (testCase) => Effect.gen(function*() {
    const mock = mockApi()
    const controls = testCase.controls(mock)
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(testCase.stream(make(mock.api)), 2)))

    yield* controls.registered(1)
    expect(controls.listenerCount).toBe(1)
    testCase.emit(mock)
    expect(yield* Fiber.join(fiber)).toEqual(testCase.expected)
    expect(controls.listenerCount).toBe(0)
  }))

  it.effect.each(streamCases)("$operation removes its listener when interrupted", (testCase) => Effect.gen(function*() {
    const mock = mockApi()
    const controls = testCase.controls(mock)
    const fiber = yield* Effect.forkChild(Stream.runDrain(testCase.stream(make(mock.api))))

    yield* controls.registered(1)
    yield* Fiber.interrupt(fiber)
    expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
    expect(controls.listenerCount).toBe(0)
  }))

  it.effect.each(streamCases)("$operation types a failed registration and leaves no listener", (testCase) => Effect.gen(function*() {
    const mock = mockApi()
    const controls = testCase.controls(mock)
    const cause = new Error("addListener failed")
    const stream = testCase.stream(make(mock.api))

    controls.failNext("addListener", cause)
    const error = yield* Effect.flip(Stream.runDrain(stream))
    expect(error).toBeInstanceOf(ChromeNotificationsError)
    expect(error).toMatchObject({ operation: testCase.operation, cause })
    expect(controls.listenerCount).toBe(0)
    // The same stream value subscribes again once Chrome accepts the listener.
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 2)))
    yield* controls.registered(1)
    testCase.emit(mock)
    expect(yield* Fiber.join(fiber)).toEqual(testCase.expected)
    expect(controls.listenerCount).toBe(0)
  }))

  it.effect.each(streamCases)("$operation gives each consumption its own listener", (testCase) => Effect.gen(function*() {
    const mock = mockApi()
    const controls = testCase.controls(mock)
    const stream = testCase.stream(make(mock.api))
    const first = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 2)))
    const second = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 1)))

    yield* controls.registered(2)
    expect(controls.listenerCount).toBe(2)
    testCase.emit(mock)
    expect(yield* Fiber.join(first)).toEqual(testCase.expected)
    expect(yield* Fiber.join(second)).toEqual(testCase.expected.slice(0, 1))
    expect(controls.listenerCount).toBe(0)
  }))

  it.effect("cleans up a partial registration and types it", () => Effect.gen(function*() {
    const cause = new Error("registered, then failed")
    const clicked = partiallyRegistering<[string]>(cause)
    const buttons = partiallyRegistering<[string, number]>(cause)
    const closed = partiallyRegistering<[string, boolean]>(cause)
    const level = partiallyRegistering<[PermissionLevel]>(cause)

    const service = make({
      ...mockApi().api,
      onClicked: clicked.source,
      onButtonClicked: buttons.source,
      onClosed: closed.source,
      onPermissionLevelChanged: level.source
    })

    expect(yield* Effect.flip(Stream.runDrain(service.onClicked))).toMatchObject({ operation: "onClicked", cause })
    expect(yield* Effect.flip(Stream.runDrain(service.onButtonClicked))).toMatchObject({ operation: "onButtonClicked", cause })
    expect(yield* Effect.flip(Stream.runDrain(service.onClosed))).toMatchObject({ operation: "onClosed", cause })
    expect(yield* Effect.flip(Stream.runDrain(service.onPermissionLevelChanged)))
      .toMatchObject({ operation: "onPermissionLevelChanged", cause })
    expect([clicked, buttons, closed, level].map(({ inner }) => inner.listenerCount)).toEqual([0, 0, 0, 0])
  }))

  it.effect("types a throwing event getter, reading it only when a stream starts", () => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("event getter failed")
    const getter = vi.fn((): EventSource<[string]> => { throw cause })
    const api: ChromeNotificationsApi = { ...mock.api, get onClicked() { return getter() } }
    const service = make(api)

    expect(getter).not.toHaveBeenCalled()
    expect(yield* Effect.flip(Stream.runDrain(service.onClicked))).toMatchObject({ operation: "onClicked", cause })
    expect(getter).toHaveBeenCalledTimes(1)
  }))

  it.effect("ignores a Chrome callback that arrives after its listener was removed", () => Effect.gen(function*() {
    const closed = recording<[string, boolean]>()
    const service = make({ ...mockApi().api, onClosed: closed.source })
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(service.onClosed, 1)))

    yield* Effect.promise(() => closed.inner.waitForListener())
    closed.inner.emit("notice", true)
    expect(yield* Fiber.join(fiber)).toEqual([{ notificationId: "notice", byUser: true }])
    expect(closed.inner.listenerCount).toBe(0)
    expect(closed.added).toHaveLength(1)
    expect(() => closed.added[0]?.("late", false)).not.toThrow()
  }))

  it.effect("provides an injected API through layer", () => Effect.gen(function*() {
    const mock = mockApi()

    expect(yield* Effect.flatMap(ChromeNotifications, (service) => service.clear("x")).pipe(Effect.provide(layer(mock.api)))).toBe(true)
    expect(mock.clear).toHaveBeenCalledExactlyOnceWith("x")
  }))

  it.effect("fails layerLive with initialize when chrome or chrome.notifications is missing", () => Effect.gen(function*() {
    yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => vi.unstubAllGlobals()))
    vi.stubGlobal("chrome", undefined)
    const missingChrome = yield* Effect.flip(ChromeNotifications.pipe(Effect.provide(layerLive)))
    expect(missingChrome).toBeInstanceOf(ChromeNotificationsError)
    expect(missingChrome.operation).toBe("initialize")
    expect(missingChrome.cause).toEqual(new Error("chrome.notifications is unavailable in this context"))
    vi.stubGlobal("chrome", {})
    expect(yield* Effect.flip(ChromeNotifications.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
    const cause = new Error("notifications getter failed")
    vi.stubGlobal("chrome", { get notifications() { throw cause } })
    expect(yield* Effect.flip(ChromeNotifications.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize", cause })
  }))

  it.effect("builds layerLive from the global at build time", () => Effect.gen(function*() {
    yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => vi.unstubAllGlobals()))
    const first = mockApi()
    const second = mockApi()
    vi.stubGlobal("chrome", { notifications: first.api })
    expect(yield* Effect.flatMap(ChromeNotifications, (service) => service.getAll).pipe(Effect.provide(layerLive)))
      .toEqual(["notice-1", "notice-2"])
    vi.stubGlobal("chrome", { notifications: second.api })
    expect(yield* Effect.flatMap(ChromeNotifications, (service) => service.clear("x")).pipe(Effect.provide(layerLive))).toBe(true)
    expect(first.getAll).toHaveBeenCalledTimes(1)
    expect(first.clear).not.toHaveBeenCalled()
    expect(second.clear).toHaveBeenCalledExactlyOnceWith("x")
  }))
})

const buttonsOptions: NotificationCreateOptions = {
  ...options, buttons: [{ title: "Approve" }, { title: "Deny" }]
}

const progressOptions: NotificationCreateOptions = { ...options, type: "progress", progress: 0 }

const listOptions: NotificationCreateOptions = { ...options, type: "list", items: [{ title: "First", message: "One" }] }

const imageOptions: NotificationCreateOptions = { ...options, type: "image", imageUrl: "image.png" }

/** `options` without one required field, as an untyped caller could pass it. */
const without = (field: "type" | "iconUrl" | "title" | "message"): NotificationCreateOptions => {
  const copy = { ...options }

  Reflect.deleteProperty(copy, field)

  return copy
}

/** A copy of `value` with `field` explicitly undefined, as an untyped caller could pass it. */
const withUndefined = <O extends NotificationOptions>(value: O, field: keyof NotificationOptions): O => {
  const copy = { ...value }

  Reflect.set(copy, field, undefined)

  return copy
}

interface RejectedCreate {
  readonly name: string
  readonly options: NotificationCreateOptions
  readonly notificationId?: string
  readonly message: string
}

const rejectedCreates: ReadonlyArray<RejectedCreate> = [
  { name: "a missing type", options: without("type"), message: notificationErrors.missingRequired },
  { name: "a missing iconUrl", options: without("iconUrl"), message: notificationErrors.missingRequired },
  { name: "a missing title", options: without("title"), message: notificationErrors.missingRequired },
  { name: "a missing message", options: without("message"), message: notificationErrors.missingRequired },
  { name: "an explicitly undefined title", options: withUndefined(options, "title"), message: notificationErrors.missingRequired },
  { name: "priority -1", options: { ...options, priority: -1 }, message: notificationErrors.lowPriority },
  { name: "priority -2", options: { ...options, priority: -2 }, message: notificationErrors.lowPriority },
  { name: "progress on a basic notification", options: { ...options, progress: 0 }, message: notificationErrors.progressType },
  { name: "progress above 100", options: { ...progressOptions, progress: 101 }, message: notificationErrors.progressRange },
  { name: "progress below 0", options: { ...progressOptions, progress: -1 }, message: notificationErrors.progressRange },
  { name: "a list without items", options: { ...options, type: "list" }, message: notificationErrors.itemsType },
  { name: "a list with empty items", options: { ...listOptions, items: [] }, message: notificationErrors.itemsType },
  { name: "items on a basic notification", options: { ...options, items: [{ title: "a", message: "b" }] }, message: notificationErrors.itemsType },
  { name: "an image without imageUrl", options: { ...options, type: "image" }, message: notificationErrors.imageType },
  { name: "imageUrl on a basic notification", options: { ...options, imageUrl: "image.png" }, message: notificationErrors.imageType },
  { name: "a 501-character ASCII id", options, notificationId: "n".repeat(501), message: notificationErrors.idTooLong },
  { name: "251 two-byte characters", options, notificationId: "é".repeat(251), message: notificationErrors.idTooLong },
  { name: "126 four-byte characters", options, notificationId: "\u{1F600}".repeat(126), message: notificationErrors.idTooLong }
]

interface AcceptedCreate {
  readonly name: string
  readonly options: NotificationCreateOptions
  readonly notificationId: string
}

const acceptedCreates: ReadonlyArray<AcceptedCreate> = [
  { name: "priority 0", options: { ...options, priority: 0 }, notificationId: "priority-0" },
  { name: "priority 2", options: { ...options, priority: 2 }, notificationId: "priority-2" },
  { name: "progress 0", options: progressOptions, notificationId: "progress-0" },
  { name: "progress 100", options: { ...progressOptions, progress: 100 }, notificationId: "progress-100" },
  { name: "a progress notification without progress", options: { ...options, type: "progress" }, notificationId: "progress" },
  { name: "a list with items", options: listOptions, notificationId: "list" },
  { name: "an image with imageUrl", options: imageOptions, notificationId: "image" },
  { name: "empty strings in required fields", options: { type: "basic", iconUrl: "", title: "", message: "" }, notificationId: "empty" },
  { name: "a 500-character ASCII id", options, notificationId: "n".repeat(500) },
  { name: "250 two-byte characters", options, notificationId: "é".repeat(250) },
  { name: "125 four-byte characters", options, notificationId: "\u{1F600}".repeat(125) }
]

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

  it.effect("generates ids for a missing or empty id, skipping ids already showing", () => Effect.gen(function*() {
    const fixture = makeNotifications()
    const notifications = make(fixture.api)

    expect(yield* notifications.create(options, "notification-1")).toBe("notification-1")
    expect(yield* notifications.create(options, "notification-3")).toBe("notification-3")
    expect(yield* notifications.create(options)).toBe("notification-2")
    expect(yield* notifications.create(options, "")).toBe("notification-4")
    expect(yield* notifications.clear("notification-1")).toBe(true)
    // Generated ids are never reused, even once free.
    expect(yield* notifications.create(options)).toBe("notification-5")
    expect(yield* notifications.getAll).toEqual(["notification-2", "notification-3", "notification-4", "notification-5"])
  }))

  it.effect("replaces a notification with the same id in place, without onClosed", () => Effect.gen(function*() {
    const fixture = makeNotifications()
    const notifications = make(fixture.api)
    const closes = yield* Effect.forkScoped(Stream.runCollect(Stream.take(notifications.onClosed, 1)))

    yield* Effect.promise(() => fixture.controls.onClosed.waitForListener())
    yield* notifications.create(options, "notice")
    yield* notifications.create({ ...progressOptions, progress: 30 }, "notice")
    expect(fixture.controls.notification("notice")).toEqual({ ...progressOptions, progress: 30 })
    expect(yield* notifications.getAll).toEqual(["notice"])
    yield* notifications.clear("notice")
    // The only close is the clear: replacing did not report one.
    expect(yield* Fiber.join(closes)).toEqual([{ notificationId: "notice", byUser: false }])
  }))

  it.effect.each(rejectedCreates)("rejects $name as Chrome does, showing nothing", (testCase) => Effect.gen(function*() {
    const fixture = makeNotifications()
    const notifications = make(fixture.api)
    const error = yield* Effect.flip(notifications.create(testCase.options, testCase.notificationId))

    expect(error).toBeInstanceOf(ChromeNotificationsError)
    expect(error.operation).toBe("create")
    expect(error.cause).toEqual(new Error(testCase.message))
    expect(yield* notifications.getAll).toEqual([])
  }))

  it.effect.each(acceptedCreates)("accepts $name", (testCase) => Effect.gen(function*() {
    const fixture = makeNotifications()
    const notifications = make(fixture.api)

    expect(yield* notifications.create(testCase.options, testCase.notificationId)).toBe(testCase.notificationId)
    expect(fixture.controls.notification(testCase.notificationId)).toEqual(testCase.options)
    expect(yield* notifications.getAll).toEqual([testCase.notificationId])
  }))

  it.effect("drops absent fields and shows at most two buttons", () => Effect.gen(function*() {
    const fixture = makeNotifications()
    const notifications = make(fixture.api)

    const given = withUndefined({ ...options, buttons: [{ title: "One" }, { title: "Two" }, { title: "Three" }] }, "contextMessage")

    yield* notifications.create(given, "notice")
    const stored = fixture.controls.notification("notice")
    expect(stored).toBeDefined()
    expect(Object.keys(stored ?? {})).not.toContain("contextMessage")
    expect(stored?.buttons).toEqual([{ title: "One" }, { title: "Two" }])
    expect(given.buttons).toHaveLength(3)
    expect(fixture.controls.clickButton("notice", 1)).toEqual([])
    expect(() => fixture.controls.clickButton("notice", 2)).toThrow("has no button 2")
    expect(() => fixture.controls.clickButton("notice", -1)).toThrow("has no button -1")
    expect(() => fixture.controls.clickButton("notice", 0.5)).toThrow("has no button 0.5")
    yield* notifications.update("notice", { buttons: [{ title: "A" }, { title: "B" }, { title: "C" }] })
    expect(fixture.controls.notification("notice")?.buttons).toEqual([{ title: "A" }, { title: "B" }])
    yield* notifications.update("notice", { buttons: [] })
    expect(() => fixture.controls.clickButton("notice", 0)).toThrow("has no button 0")
  }))

  it.effect("checks updates against the resulting template, changing nothing when rejected", () => Effect.gen(function*() {
    const fixture = makeNotifications()
    const notifications = make(fixture.api)

    const rejected = (notificationId: string, update: NotificationOptions) =>
      Effect.flip(notifications.update(notificationId, update)).pipe(Effect.map((error) => {
        expect(error.operation).toBe("update")

        return error.cause
      }))

    // An unknown id is not validated.
    expect(yield* notifications.update("missing", { priority: -1, progress: 500 })).toBe(false)
    yield* notifications.create(options, "notice")
    expect(yield* rejected("notice", { progress: 5 })).toEqual(new Error(notificationErrors.progressType))
    expect(yield* rejected("notice", { type: "progress", progress: 101 })).toEqual(new Error(notificationErrors.progressRange))
    expect(yield* rejected("notice", { title: "Changed", priority: -1 })).toEqual(new Error(notificationErrors.lowPriority))
    expect(yield* rejected("notice", { imageUrl: "image.png" })).toEqual(new Error(notificationErrors.imageType))
    expect(yield* rejected("notice", { items: [{ title: "a", message: "b" }] })).toEqual(new Error(notificationErrors.itemsType))
    expect(fixture.controls.notification("notice")).toEqual(options)

    expect(yield* notifications.update("notice", { type: "progress", progress: 5 })).toBe(true)
    expect(yield* notifications.update("notice", { progress: 100 })).toBe(true)
    expect(yield* notifications.update("notice", { type: "image", imageUrl: "image.png" })).toBe(true)
    // Chrome does not re-check fields the update leaves alone, such as the old progress.
    expect(fixture.controls.notification("notice")).toEqual({ ...options, type: "image", progress: 100, imageUrl: "image.png" })
    expect(yield* notifications.update("notice", { type: "list", items: [{ title: "a", message: "b" }] })).toBe(true)
    expect(yield* notifications.update("notice", { items: [] })).toBe(true)
    expect(fixture.controls.notification("notice")?.items).toEqual([{ title: "a", message: "b" }])
    expect(yield* notifications.update("notice", withUndefined({}, "title"))).toBe(true)
    expect(fixture.controls.notification("notice")?.title).toBe(options.title)
    expect(yield* notifications.update("notice", {})).toBe(true)
  }))

  it.effect("throws synchronously for a non-integer priority or progress, as Chrome's bindings do", () => Effect.gen(function*() {
    const fixture = makeNotifications()
    const notifications = make(fixture.api)

    yield* notifications.create(progressOptions, "notice")
    expect(() => fixture.api.create({ ...options, priority: 1.5 })).toThrow(new TypeError(notificationIntegerError("priority")))
    expect(() => fixture.api.create("other", { ...progressOptions, progress: Number.NaN }))
      .toThrow(new TypeError(notificationIntegerError("progress")))
    expect(() => fixture.api.update("notice", { progress: 12.5 })).toThrow(new TypeError(notificationIntegerError("progress")))
    // Validation precedes the id lookup, so an unknown id throws as well.
    expect(() => fixture.api.update("missing", { priority: Number.POSITIVE_INFINITY }))
      .toThrow(new TypeError(notificationIntegerError("priority")))

    const created = yield* Effect.flip(notifications.create({ ...options, priority: 0.5 }, "other"))
    expect(created).toMatchObject({ operation: "create", cause: new TypeError(notificationIntegerError("priority")) })
    const updated = yield* Effect.flip(notifications.update("notice", { progress: 99.9 }))
    expect(updated).toMatchObject({ operation: "update", cause: new TypeError(notificationIntegerError("progress")) })
    expect(fixture.controls.notification("notice")).toEqual(progressOptions)
    expect(yield* notifications.getAll).toEqual(["notice"])
    expect(yield* notifications.update("notice", { progress: 100, priority: 2 })).toBe(true)
  }))

  it.effect("lists ids sorted as Chrome sorts them", () => Effect.gen(function*() {
    const fixture = makeNotifications()
    const notifications = make(fixture.api)
    const ids = ["b", "a", "10", "2", "�", "\u{1F600}", "Z", "a-"]

    yield* Effect.forEach(ids, (id) => notifications.create(options, id))
    // Integer-like keys lead any object; the rest follow code point (UTF-8 byte) order.
    expect(yield* notifications.getAll).toEqual(["2", "10", "Z", "a", "a-", "b", "�", "\u{1F600}"])
  }))

  it.effect("refuses every call but getPermissionLevel while denied", () => Effect.gen(function*() {
    const fixture = makeNotifications()
    const notifications = make(fixture.api)
    const levels = yield* Effect.forkScoped(Stream.runCollect(Stream.take(notifications.onPermissionLevelChanged, 2)))

    yield* Effect.promise(() => fixture.controls.onPermissionLevelChanged.waitForListener())
    yield* notifications.create(buttonsOptions, "notice")
    expect(fixture.controls.setPermissionLevel("denied")).toEqual([])
    expect(fixture.controls.permissionLevel).toBe("denied")
    expect(yield* notifications.getPermissionLevel).toBe("denied")

    const failures = yield* Effect.all([
      Effect.flip(notifications.create(options, "other")),
      Effect.flip(notifications.create(options)),
      Effect.flip(notifications.update("notice", { title: "Changed" })),
      Effect.flip(notifications.update("missing", {})),
      Effect.flip(notifications.clear("notice")),
      Effect.flip(notifications.getAll)
    ])

    expect(failures.map((error) => error.operation)).toEqual(["create", "create", "update", "update", "clear", "getAll"])
    expect(failures.map((error) => error.cause)).toEqual(Array.from({ length: 6 }, () => new Error(notificationErrors.denied)))
    // What was showing stays showing, unchanged, and the user can still act on it.
    expect(fixture.controls.notification("notice")).toEqual(buttonsOptions)
    expect(fixture.controls.click("notice")).toEqual([])
    expect(fixture.controls.setPermissionLevel("granted")).toEqual([])
    expect(yield* notifications.getAll).toEqual(["notice"])
    expect(yield* notifications.create(options)).toBe("notification-1")
    expect(yield* Fiber.join(levels)).toEqual(["denied", "granted"])
  }))

  it.effect("simulates clicks, button presses and closes as events", () => Effect.gen(function*() {
    const fixture = makeNotifications()
    const notifications = yield* ChromeNotifications.pipe(Effect.provide(fixture.layer))
    const clicks = yield* Effect.forkScoped(Stream.runCollect(Stream.take(notifications.onClicked, 1)))
    const buttons = yield* Effect.forkScoped(Stream.runCollect(Stream.take(notifications.onButtonClicked, 1)))
    const closes = yield* Effect.forkScoped(Stream.runCollect(Stream.take(notifications.onClosed, 2)))

    yield* Effect.promise(() => fixture.controls.onClicked.waitForListener())
    yield* Effect.promise(() => fixture.controls.onButtonClicked.waitForListener())
    yield* Effect.promise(() => fixture.controls.onClosed.waitForListener())
    yield* notifications.create(buttonsOptions, "approval")
    yield* notifications.create(options, "system")
    expect(fixture.controls.click("approval")).toEqual([])
    expect(fixture.controls.clickButton("approval", 1)).toEqual([])
    expect(() => fixture.controls.clickButton("approval", 2)).toThrow("no button 2")
    expect(() => fixture.controls.clickButton("system", 0)).toThrow("no button 0")
    expect(yield* notifications.getAll).toEqual(["approval", "system"])
    expect(fixture.controls.close("approval")).toEqual([])
    expect(fixture.controls.close("system", false)).toEqual([])
    expect(() => fixture.controls.click("approval")).toThrow("No notification is showing")
    expect(() => fixture.controls.clickButton("approval", 0)).toThrow("No notification is showing")
    expect(() => fixture.controls.close("approval")).toThrow("No notification is showing")
    expect(yield* Fiber.join(clicks)).toEqual(["approval"])
    expect(yield* Fiber.join(buttons)).toEqual([{ notificationId: "approval", buttonIndex: 1 }])

    expect(yield* Fiber.join(closes)).toEqual([
      { notificationId: "approval", byUser: true }, { notificationId: "system", byUser: false }
    ])

    expect(yield* notifications.getAll).toEqual([])

    expect(
      fixture.controls.onClicked.listenerCount + fixture.controls.onButtonClicked.listenerCount + fixture.controls.onClosed.listenerCount
    ).toBe(0)
  }))

  it.effect("changes the permission level only when it differs", () => Effect.gen(function*() {
    const fixture = makeNotifications()
    const notifications = yield* ChromeNotifications.pipe(Effect.provide(fixture.layer))
    const levels = yield* Effect.forkScoped(Stream.runCollect(Stream.take(notifications.onPermissionLevelChanged, 2)))

    yield* Effect.promise(() => fixture.controls.onPermissionLevelChanged.waitForListener())
    expect(yield* notifications.getPermissionLevel).toBe("granted")
    expect(fixture.controls.permissionLevel).toBe("granted")
    expect(fixture.controls.setPermissionLevel("granted")).toEqual([])
    fixture.controls.setPermissionLevel("denied")
    fixture.controls.setPermissionLevel("denied")
    fixture.controls.setPermissionLevel("granted")
    expect(yield* Fiber.join(levels)).toEqual(["denied", "granted"])
  }))

  it.effect("returns copies of stored options", () => Effect.gen(function*() {
    const fixture = makeNotifications()
    const given = { ...buttonsOptions, buttons: [{ title: "Approve" }] }

    yield* make(fixture.api).create(given, "notice")
    given.buttons[0] = { title: "Changed by the caller" }
    const copy = fixture.controls.notification("notice")
    copy?.buttons?.push({ title: "Changed by the reader" })
    expect(fixture.controls.notification("notice")?.buttons).toEqual([{ title: "Approve" }])
  }))

  it.effect("returns listener exceptions from simulated actions", () => Effect.gen(function*() {
    const fixture = makeNotifications()
    const failure = new Error("listener failed")

    fixture.api.onClicked.addListener(() => { throw failure })
    fixture.api.onClosed.addListener(() => { throw failure })
    yield* Effect.promise(() => fixture.api.create("notice", options))
    expect(fixture.controls.click("notice")).toEqual([failure])
    expect(fixture.controls.close("notice")).toEqual([failure])
    // clear does not surface listener exceptions; Chrome reports them only to the console.
    yield* Effect.promise(() => fixture.api.create("notice", options))
    expect(yield* Effect.promise(() => fixture.api.clear("notice"))).toBe(true)
  }))

  it.effect("lets overrides replace members while controls keep the in-memory state", () => Effect.gen(function*() {
    const cause = new Error("overridden")
    const fixture = makeNotifications({ getPermissionLevel: () => Promise.reject(cause) })
    const notifications = make(fixture.api)

    expect(yield* Effect.flip(notifications.getPermissionLevel)).toMatchObject({ operation: "getPermissionLevel", cause })
    yield* notifications.create(options, "notice")
    expect(fixture.controls.notification("notice")).toEqual(options)
    expect(fixture.controls.click("notice")).toEqual([])
  }))
})
