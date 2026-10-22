// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Cause, Effect, Exit, Fiber, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeManagement, ChromeManagementError, layerLive, make } from "../../src/ChromeManagement.js"
import type { ChromeManagementApi, ChromeManagementService, ExtensionInfo } from "../../src/ChromeManagement.js"
import type { EventSource } from "../../src/internal/event.js"
import { makeEvent } from "../../src/testing/Event.js"
import { extensionId, extensionInfo, makeManagement } from "../../src/testing/Management.js"

/** A small deterministic generator (mulberry32), so every run churns the same way. */
const seeded = (seed: number) => {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <A>(random: () => number, values: ReadonlyArray<A>): A => {
  const value = values[Math.floor(random() * values.length)]

  if (value === undefined) throw new Error("pick needs a non-empty list")

  return value
}

/** A resolvable promise used as an explicit gate. */
const gate = <A = void>() => {
  let open!: (value: A) => void
  const promise = new Promise<A>((resolve) => { open = resolve })

  return { promise, open }
}

const infos: ReadonlyArray<ExtensionInfo> = Array.from({ length: 4096 }, (_, index) => extensionInfo(extensionId(index), { version: `${index}.0` }))

const infoAt = (index: number): ExtensionInfo => infos[index] ?? extensionInfo(extensionId(index))

/** The permission-free members, as a restricted chrome.management exposes them. */
const restricted = (): ChromeManagementApi => ({
  getSelf: async () => infoAt(0),
  getPermissionWarningsByManifest: async () => [],
  uninstallSelf: async () => {}
})

type ManagementEvent = ExtensionInfo | string

type EventName = "onInstalled" | "onUninstalled" | "onEnabled" | "onDisabled"

/** Per-subscription hooks around a shared event, so each subscription can misbehave its own way. */
interface Hooks {
  readonly added: () => void
  onAdd?: () => void
  failBeforeAdd?: Error
  failAfterAdd?: Error
  /** Chrome left the event out: the API has no such member. */
  absent?: true
  readonly onRemove?: () => void
}

const hooked = <Args extends ReadonlyArray<unknown>>(real: EventSource<Args>, hooks: Hooks): EventSource<Args> => ({
  addListener: (listener) => {
    if (hooks.failBeforeAdd !== undefined) throw hooks.failBeforeAdd

    real.addListener(listener)
    hooks.added()
    hooks.onAdd?.()

    if (hooks.failAfterAdd !== undefined) throw hooks.failAfterAdd
  },
  removeListener: (listener) => {
    real.removeListener(listener)
    hooks.onRemove?.()
  }
})

/** The service over an API whose only event is `source`, under `name`, or none when absent. */
const serviceWith = <Args extends ReadonlyArray<unknown>>(name: EventName, source: EventSource<Args> | undefined) => {
  const base = restricted()

  if (source === undefined) return make(base)

  // SAFETY: each spec pairs `name` with a source of exactly that event's argument list.
  return make({ ...base, [name]: source } as ChromeManagementApi)
}

const eventSpec = <Args extends ReadonlyArray<unknown>>(
  operation: EventName,
  args: (index: number) => Args,
  expected: (index: number) => ManagementEvent
) => ({
  operation,
  expected,
  make: () => {
    const event = makeEvent<Args>()

    return {
      controls: event.controls,
      emit: (index: number) => event.controls.emit(...args(index)),
      stream: (hooks: Hooks): Stream.Stream<ManagementEvent, ChromeManagementError> =>
        serviceWith(operation, hooks.absent === true ? undefined : hooked(event.api, hooks))[operation],
      plain: (): Stream.Stream<ManagementEvent, ChromeManagementError> => serviceWith(operation, event.api)[operation]
    }
  }
})

const streams = [
  eventSpec("onInstalled", (index): [ExtensionInfo] => [infoAt(index)], infoAt),
  eventSpec("onUninstalled", (index): [string] => [extensionId(index)], extensionId),
  eventSpec("onEnabled", (index): [ExtensionInfo] => [infoAt(index)], infoAt),
  eventSpec("onDisabled", (index): [ExtensionInfo] => [infoAt(index)], infoAt)
] as const

const newest = (expected: (index: number) => ManagementEvent, total: number) =>
  Array.from({ length: Math.min(total, 64) }, (_, index) => expected(Math.max(0, total - 64) + index))

/** How a churned subscription consumes its stream: one event, a stalled element, or until interrupted. */
const consume = <A, E>(stage: string, stream: Stream.Stream<A, E>, stall: Effect.Effect<A>) => {
  if (stage === "completes") return Stream.runCollect(Stream.take(stream, 1))

  if (stage === "stalled") return Stream.runCollect(Stream.mapEffect(stream, () => stall))

  return Stream.runCollect(stream)
}

describe("ChromeManagement event stress", () => {
  it.effect.each(streams)("keeps exactly the newest 64 of a 4,096-event $operation burst during registration", (spec) => Effect.gen(function*() {
    const source = spec.make()
    let removals = 0

    const stream = source.stream({
      added: () => {},
      onAdd: () => { for (let index = 0; index < 4096; index++) source.emit(index) },
      onRemove: () => { removals++ }
    })

    expect(yield* Stream.runCollect(Stream.take(stream, 64))).toEqual(newest(spec.expected, 4096))
    expect(source.controls.listenerCount).toBe(0)
    expect(removals).toBe(1)
  }))

  it.effect.each(streams)("keeps exactly the newest 64 of a 4,096-event $operation burst into a waiting consumer", (spec) => Effect.gen(function*() {
    const source = spec.make()
    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(source.plain(), 64)))
    yield* Effect.promise(() => source.controls.waitForListener())

    for (let index = 0; index < 4096; index++) source.emit(index)

    expect(yield* Fiber.join(fiber)).toEqual(newest(spec.expected, 4096))
    expect(source.controls.listenerCount).toBe(0)
  }))

  it.effect.each(streams)("keeps the newest 64 across two 4,096-event $operation bursts drained in between", (spec) => Effect.gen(function*() {
    const source = spec.make()
    const drained = gate()
    const resume = gate()
    let seen = 0

    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(Stream.tap(source.plain(), () => Effect.promise(async () => {
      seen++

      if (seen === 64) {
        drained.open()
        await resume.promise
      }
    })), 128)))

    yield* Effect.promise(() => source.controls.waitForListener())

    for (let index = 0; index < 4096; index++) source.emit(index)

    yield* Effect.promise(() => drained.promise)

    for (let index = 4096; index < 8192; index++) source.emit(index % 4096)

    resume.open()
    const values = yield* Fiber.join(fiber)
    expect(values.slice(0, 64)).toEqual(newest(spec.expected, 4096))
    // The consumer was parked on its 64th element while the second burst arrived.
    expect(values.slice(64)).toEqual(newest(spec.expected, 4096))
    expect(source.controls.listenerCount).toBe(0)
  }))

  it.effect.each(streams)("keeps 128 independent $operation subscriptions each to the newest 64 of 4,096 events", (spec) => Effect.gen(function*() {
    const source = spec.make()
    const registered = gate()
    let added = 0

    const fibers = yield* Effect.forEach(Array.from({ length: 128 }), () => Effect.forkChild(Stream.runCollect(Stream.take(source.stream({
      added: () => {
        added++

        if (added === 128) registered.open()
      }
    }), 64))))

    yield* Effect.promise(() => registered.promise)
    expect(source.controls.listenerCount).toBe(128)

    for (let index = 0; index < 4096; index++) source.emit(index)

    for (const values of yield* Effect.forEach(fibers, Fiber.join)) expect(values).toEqual(newest(spec.expected, 4096))

    expect(source.controls.listenerCount).toBe(0)
  }))

  it.effect.each(streams)("churns 512 concurrent $operation subscriptions through interruption at every stage", (spec) => Effect.gen(function*() {
    const random = seeded(spec.operation.length * 7919)
    const source = spec.make()

    const stages = [
      "unstarted", "registered", "stalled", "midRegistration", "reentrantRelease", "partialFailure", "refused", "absent", "completes"
    ] as const

    const hold = gate<ManagementEvent>()
    let adds = 0
    let removes = 0
    let interruptedDuringRegistration = 0

    const subscriptions = yield* Effect.forEach(Array.from({ length: 512 }, (_, index) => index), (index) => Effect.gen(function*() {
      const stage = pick(random, stages)
      const added = gate()
      const cause = new Error(`${stage} ${index}`)
      let self: Fiber.Fiber<ReadonlyArray<ManagementEvent>, ChromeManagementError> | undefined

      const hooks: Hooks = {
        added: () => {
          adds++
          added.open()
        },
        // Chrome dispatching to the shared event while this listener is being removed.
        onRemove: () => {
          removes++

          if (stage === "reentrantRelease") source.emit(4095)
        }
      }

      // Interruption requested while Chrome is still inside addListener.
      if (stage === "midRegistration") {
        hooks.onAdd = () => {
          if (self === undefined) return

          interruptedDuringRegistration++
          self.interruptUnsafe()
        }
      }

      if (stage === "partialFailure") hooks.failAfterAdd = cause

      if (stage === "refused") hooks.failBeforeAdd = cause

      if (stage === "absent") hooks.absent = true

      const fiber = yield* Effect.forkChild(consume(stage, source.stream(hooks), Effect.promise(() => hold.promise)))
      self = fiber

      if (stage === "unstarted") yield* Fiber.interrupt(fiber)

      return { stage, fiber, added, cause }
    }))

    const registering = subscriptions.filter(({ stage }) => stage !== "unstarted" && stage !== "refused" && stage !== "absent")
    yield* Effect.promise(() => Promise.all(registering.map(({ added }) => added.promise)))

    for (let index = 0; index < 128; index++) source.emit(index)

    const settling = new Set(["completes", "partialFailure", "refused", "absent"])

    // Settle the self-ending subscriptions first: interrupting a reentrantRelease one emits into
    // the shared event, which would otherwise reach completing subscriptions still buffering.
    const ordered = [
      ...subscriptions.filter(({ stage }) => settling.has(stage)),
      ...subscriptions.filter(({ stage }) => !settling.has(stage))
    ]

    for (const { stage, fiber, cause } of ordered) {
      const exit = yield* (settling.has(stage) ? Fiber.await(fiber) : Effect.andThen(Fiber.interrupt(fiber), Fiber.await(fiber)))
      expect(Exit.hasDies(exit)).toBe(false)

      // The 128 events arrived in one synchronous burst, so the buffer slid to the newest 64.
      if (stage === "completes") expect(yield* exit).toEqual([spec.expected(64)])
      else if (stage === "partialFailure" || stage === "refused") {
        const error = yield* Effect.flip(exit)
        expect(error).toBeInstanceOf(ChromeManagementError)
        expect(error.operation).toBe(spec.operation)
        expect(error.cause).toBe(cause)
      } else if (stage === "absent") {
        const error = yield* Effect.flip(exit)
        expect(error.operation).toBe(spec.operation)
        expect(String(error.cause)).toContain(`chrome.management.${spec.operation} is unavailable`)
      } else expect(Exit.hasInterrupts(exit)).toBe(true)
    }

    hold.open(spec.expected(0))
    expect(source.controls.listenerCount).toBe(0)
    // Cleanup is installed before registration, so a refused registration still removes
    // (a no-op in Chrome); every listener that was added is removed exactly once. An absent
    // event fails before cleanup exists and touches nothing.
    expect(removes).toBe(adds + subscriptions.filter(({ stage }) => stage === "refused").length)
    expect(interruptedDuringRegistration).toBe(subscriptions.filter(({ stage }) => stage === "midRegistration").length)
    expect(new Set(subscriptions.map(({ stage }) => stage))).toEqual(new Set(stages))
  }))

  it.effect("runs all four streams of one fixture through 256 interleaved subscribe and interrupt rounds", () => Effect.gen(function*() {
    const random = seeded(256)
    const { api, controls } = makeManagement({ installed: [extensionInfo(extensionId(1))] })
    const service = make(api)
    const names: ReadonlyArray<EventName> = ["onInstalled", "onUninstalled", "onEnabled", "onDisabled"]

    for (let round = 0; round < 256; round++) {
      const name = pick(random, names)
      const stream: Stream.Stream<ManagementEvent, ChromeManagementError> = service[name]
      const fiber = yield* Effect.forkChild(Stream.runDrain(stream))
      yield* Effect.promise(() => controls[name].waitForListener())
      expect(controls[name].listenerCount).toBe(1)
      yield* Fiber.interrupt(fiber)

      for (const other of names) expect(controls[other].listenerCount).toBe(0)
    }
  }))
})

type Mode = "ok" | "okLate" | "reject" | "rejectLate" | "throw"

const modes: ReadonlyArray<Mode> = ["ok", "okLate", "reject", "rejectLate", "throw"]

type Member = Exclude<keyof ChromeManagementApi, EventName>

type Outcome = void | ExtensionInfo | Array<ExtensionInfo> | Array<string>

/** Every way to reach Chrome, invoked for call `index` with the index in its arguments where it takes any. */
const operations: ReadonlyArray<{
  readonly name: string
  readonly operation: Member
  /** Starts the call; a gesture variant starts its native call right here. */
  readonly start: (service: ChromeManagementService, index: number) => Effect.Effect<Outcome, ChromeManagementError>
  /** Whether the arguments carry the index; others are planned in arrival order. */
  readonly keyed: boolean
}> = [
  { name: "getSelf", operation: "getSelf", start: (service) => service.getSelf, keyed: false },
  { name: "getAll", operation: "getAll", start: (service) => service.getAll, keyed: false },
  { name: "get", operation: "get", start: (service, index) => service.get(`${index}`), keyed: true },
  { name: "getPermissionWarningsById", operation: "getPermissionWarningsById", start: (service, index) => service.getPermissionWarningsById(`${index}`), keyed: true },
  {
    name: "getPermissionWarningsByManifest", operation: "getPermissionWarningsByManifest",
    start: (service, index) => service.getPermissionWarningsByManifest(`${index}`), keyed: true
  },
  { name: "setEnabled", operation: "setEnabled", start: (service, index) => service.setEnabled(`${index}`, index % 2 === 0), keyed: true },
  {
    name: "setEnabledFromUserGesture", operation: "setEnabled",
    start: (service, index) => service.setEnabledFromUserGesture(`${index}`, index % 2 === 0), keyed: true
  },
  { name: "uninstall", operation: "uninstall", start: (service, index) => service.uninstall(`${index}`), keyed: true },
  { name: "uninstallFromUserGesture", operation: "uninstall", start: (service, index) => service.uninstallFromUserGesture(`${index}`), keyed: true },
  { name: "uninstallSelf", operation: "uninstallSelf", start: (service, index) => service.uninstallSelf({ showConfirmDialog: index % 2 === 0 }), keyed: false },
  {
    name: "uninstallSelfFromUserGesture", operation: "uninstallSelf",
    start: (service, index) => service.uninstallSelfFromUserGesture({ showConfirmDialog: index % 2 === 0 }), keyed: false
  },
  { name: "launchApp", operation: "launchApp", start: (service, index) => service.launchApp(`${index}`), keyed: true },
  { name: "setLaunchType", operation: "setLaunchType", start: (service, index) => service.setLaunchType(`${index}`, "OPEN_AS_WINDOW"), keyed: true },
  {
    name: "setLaunchTypeFromUserGesture", operation: "setLaunchType",
    start: (service, index) => service.setLaunchTypeFromUserGesture(`${index}`, "OPEN_AS_WINDOW"), keyed: true
  },
  { name: "createAppShortcut", operation: "createAppShortcut", start: (service, index) => service.createAppShortcut(`${index}`), keyed: true },
  {
    name: "createAppShortcutFromUserGesture", operation: "createAppShortcut",
    start: (service, index) => service.createAppShortcutFromUserGesture(`${index}`), keyed: true
  },
  {
    name: "generateAppForLink", operation: "generateAppForLink",
    start: (service, index) => service.generateAppForLink(`https://example.com/${index}`, `${index}`), keyed: true
  },
  {
    name: "generateAppForLinkFromUserGesture", operation: "generateAppForLink",
    start: (service, index) => service.generateAppForLinkFromUserGesture(`https://example.com/${index}`, `${index}`), keyed: true
  },
  { name: "installReplacementWebApp", operation: "installReplacementWebApp", start: (service) => service.installReplacementWebApp, keyed: false },
  {
    name: "installReplacementWebAppFromUserGesture", operation: "installReplacementWebApp",
    start: (service) => service.installReplacementWebAppFromUserGesture(), keyed: false
  }
]

/**
 * An API whose every member settles as planned. Keyed calls carry their index as the first
 * argument (the title for generateAppForLink), so their plan is exact whatever order they
 * arrive in; the others are planned in arrival order per member. Late outcomes settle only
 * once every call has reached the API.
 */
const plannedApi = (total: number, plan: Map<string, Mode>) => {
  const causes = new Map<string, Error>()
  const arrivalsPerMember = new Map<string, number>()
  const everyCallArrived = gate()
  let arrivals = 0

  const settle = <A>(member: Member, key: string | undefined, value: A): Promise<A> => {
    arrivals++

    if (arrivals === total) everyCallArrived.open()

    const order = (arrivalsPerMember.get(member) ?? 0) + 1
    arrivalsPerMember.set(member, order)
    const id = `${member}:${key ?? `#${order}`}`
    const mode = plan.get(id) ?? "ok"
    const cause = new Error(`${id} ${mode}`)
    causes.set(id, cause)

    switch (mode) {
      case "ok": return Promise.resolve(value)
      case "okLate": return everyCallArrived.promise.then(() => value)
      case "reject": return Promise.reject(cause)
      case "rejectLate": return everyCallArrived.promise.then(() => Promise.reject(cause))
      case "throw": throw cause
    }
  }

  const api: ChromeManagementApi = {
    getSelf: () => settle("getSelf", undefined, infoAt(0)),
    getAll: () => settle("getAll", undefined, [infoAt(0)]),
    get: (id) => settle("get", id, infoAt(Number(id))),
    getPermissionWarningsById: (id) => settle("getPermissionWarningsById", id, [id]),
    getPermissionWarningsByManifest: (manifestStr) => settle("getPermissionWarningsByManifest", manifestStr, [manifestStr]),
    setEnabled: (id) => settle("setEnabled", id, undefined),
    uninstall: (id) => settle("uninstall", id, undefined),
    uninstallSelf: () => settle("uninstallSelf", undefined, undefined),
    launchApp: (id) => settle("launchApp", id, undefined),
    setLaunchType: (id) => settle("setLaunchType", id, undefined),
    createAppShortcut: (id) => settle("createAppShortcut", id, undefined),
    generateAppForLink: (_url, title) => settle("generateAppForLink", title, infoAt(Number(title))),
    installReplacementWebApp: () => settle("installReplacementWebApp", undefined, undefined)
  }

  return { api, causes }
}

const expectedValue = (operation: Member, index: number): Outcome => {
  switch (operation) {
    case "getSelf": return infoAt(0)
    case "getAll": return [infoAt(0)]
    case "get": return infoAt(index)
    case "generateAppForLink": return infoAt(index)
    case "getPermissionWarningsById": return [`${index}`]
    case "getPermissionWarningsByManifest": return [`${index}`]
    default: return undefined
  }
}

describe("ChromeManagement call stress", () => {
  it.effect("types 1,280 concurrent calls with interleaved rejections, late rejections and throws", () => Effect.gen(function*() {
    const random = seeded(1280)

    const calls = Array.from({ length: 1280 }, (_, index) => {
      const entry = operations[index % operations.length]

      if (entry === undefined) throw new Error("no operation")

      return { index, ...entry, mode: pick(random, modes) }
    })

    // Unkeyed calls are planned in arrival order per member, so only each member's multiset
    // of outcomes is fixed; the checks compare failure counts and causes per member.
    const plan = new Map<string, Mode>()
    const unkeyedModes = new Map<Member, Array<Mode>>()

    for (const call of calls) {
      if (call.keyed) {
        plan.set(`${call.operation}:${call.index}`, call.mode)
        continue
      }

      const planned = [...unkeyedModes.get(call.operation) ?? [], call.mode]
      unkeyedModes.set(call.operation, planned)
      plan.set(`${call.operation}:#${planned.length}`, call.mode)
    }

    const { api, causes } = plannedApi(calls.length, plan)
    const management = make(api)
    // Gesture variants start their native calls now, before any Effect runs.
    const started = calls.map((call) => ({ call, effect: call.start(management, call.index) }))
    const exits = yield* Effect.forEach(started, ({ effect }) => Effect.exit(effect), { concurrency: "unbounded" })
    const unkeyedFailures = new Map<Member, number>()

    for (const [position, exit] of exits.entries()) {
      const call = calls[position]

      if (call === undefined) throw new Error("missing call")

      expect(Exit.hasDies(exit)).toBe(false)
      expect(Exit.hasInterrupts(exit)).toBe(false)

      if (!call.keyed) {
        if (Exit.isFailure(exit)) {
          unkeyedFailures.set(call.operation, (unkeyedFailures.get(call.operation) ?? 0) + 1)
          const error = yield* Effect.flip(exit)
          expect(error).toBeInstanceOf(ChromeManagementError)
          expect(error.operation).toBe(call.operation)
          expect(String(error.cause)).toMatch(new RegExp(`^Error: ${call.operation}:#\\d+ (reject|rejectLate|throw)$`))
        } else expect(yield* exit).toEqual(expectedValue(call.operation, call.index))

        continue
      }

      const failing = call.mode === "reject" || call.mode === "rejectLate" || call.mode === "throw"
      expect(Exit.isFailure(exit)).toBe(failing)

      if (failing) {
        const error = yield* Effect.flip(exit)
        expect(error).toBeInstanceOf(ChromeManagementError)
        expect(error.operation).toBe(call.operation)
        expect(error.cause).toBe(causes.get(`${call.operation}:${call.index}`))
      } else expect(yield* exit).toEqual(expectedValue(call.operation, call.index))
    }

    for (const [operation, planned] of unkeyedModes) {
      const failures = planned.filter((mode) => mode === "reject" || mode === "rejectLate" || mode === "throw").length
      expect(unkeyedFailures.get(operation) ?? 0).toBe(failures)
    }

    expect(new Set(calls.map((call) => call.mode))).toEqual(new Set(modes))
  }))

  it.effect("types 1,024 concurrent calls on a namespace without the management permission", () => Effect.gen(function*() {
    const management = make(restricted())

    const calls = Array.from({ length: 1024 }, (_, index) => {
      const entry = operations[index % operations.length]

      if (entry === undefined) throw new Error("no operation")

      return { index, ...entry }
    })

    const exits = yield* Effect.forEach(calls, (call) => Effect.exit(call.start(management, call.index)), { concurrency: "unbounded" })
    const free = new Set<Member>(["getSelf", "getPermissionWarningsByManifest", "uninstallSelf"])

    for (const [position, exit] of exits.entries()) {
      const call = calls[position]

      if (call === undefined) throw new Error("missing call")

      expect(Exit.hasDies(exit)).toBe(false)

      if (free.has(call.operation)) {
        expect(Exit.isSuccess(exit)).toBe(true)
        continue
      }

      const error = yield* Effect.flip(exit)
      expect(error).toBeInstanceOf(ChromeManagementError)
      expect(error.operation).toBe(call.operation)
      expect(String(error.cause)).toContain(`chrome.management.${call.operation} is unavailable`)
    }
  }))

  it.effect("interrupts 1,024 pending lazy calls without typed errors or leaked rejections", () => Effect.gen(function*() {
    const pending: Array<(cause: Error) => void> = []
    const arrived = gate()

    const api: ChromeManagementApi = {
      ...restricted(),
      get: () => new Promise<ExtensionInfo>((_resolve, reject) => {
        pending.push(reject)

        if (pending.length === 1024) arrived.open()
      })
    }

    const management = make(api)
    const fibers = yield* Effect.forEach(Array.from({ length: 1024 }, (_, index) => index), (index) => Effect.forkChild(management.get(`${index}`)))
    yield* Effect.promise(() => arrived.promise)
    yield* Effect.forEach(fibers, Fiber.interrupt, { concurrency: "unbounded" })

    for (const fiber of fibers) {
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    }

    // Chrome settles them after the interruption; nothing observes or leaks the rejections.
    for (const reject of pending) reject(new Error("late rejection"))

    yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)))
  }))

  it.effect("absorbs 1,024 rejected gesture calls whose outcomes are never awaited", () => Effect.gen(function*() {
    const unhandled = vi.fn()
    yield* Effect.acquireRelease(
      Effect.sync(() => process.on("unhandledRejection", unhandled)),
      () => Effect.sync(() => process.off("unhandledRejection", unhandled))
    )
    const uninstall = vi.fn(async () => { throw new Error("chrome.management.uninstall requires a user gesture.") })
    const management = make({ ...restricted(), uninstall })
    const outcomes = Array.from({ length: 1024 }, (_, index) => management.uninstallFromUserGesture(`${index}`))
    expect(uninstall).toHaveBeenCalledTimes(1024)
    yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)))
    yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)))
    expect(unhandled).not.toHaveBeenCalled()
    // Observed later, each still reports its own typed failure.
    const errors = yield* Effect.forEach(outcomes, Effect.flip, { concurrency: "unbounded" })
    expect(errors.every((error) => error.operation === "uninstall")).toBe(true)
    expect(uninstall).toHaveBeenCalledTimes(1024)
  }))

  it.effect("replays one gesture outcome to 4,096 concurrent observers, half interrupted first", () => Effect.gen(function*() {
    const settled = gate<ExtensionInfo>()
    const generateAppForLink = vi.fn(() => settled.promise)
    const outcome = make({ ...restricted(), generateAppForLink }).generateAppForLinkFromUserGesture("https://example.com/", "Example")
    const observers = yield* Effect.forEach(Array.from({ length: 4096 }), () => Effect.forkChild(outcome))
    yield* Effect.forEach(observers.filter((_, index) => index % 2 === 0), Fiber.interrupt, { concurrency: "unbounded" })
    settled.open(infoAt(7))
    const exits = yield* Effect.forEach(observers, Fiber.await)

    for (const [index, exit] of exits.entries()) {
      if (index % 2 === 0) expect(Exit.hasInterrupts(exit)).toBe(true)
      else expect(exit).toEqual(Exit.succeed(infoAt(7)))
    }

    expect(yield* outcome).toBe(infoAt(7))
    expect(generateAppForLink).toHaveBeenCalledOnce()
  }))

  it.effect("builds 512 live layers back to back against present, missing and throwing namespaces", () => Effect.gen(function*() {
    const random = seeded(512)
    const kinds = ["present", "missing", "throwing"] as const
    const cause = new Error("access denied")
    let current: (typeof kinds)[number] = "present"
    const api = restricted()

    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", {
      get management() {
        if (current === "throwing") throw cause

        return current === "present" ? api : undefined
      }
    })), () => Effect.sync(() => vi.unstubAllGlobals()))

    const plan = Array.from({ length: 512 }, () => pick(random, kinds))

    // Each build reads the global synchronously when it starts, so the kind is set just before.
    const exits = yield* Effect.forEach(plan, (kind) => Effect.suspend(() => {
      current = kind

      return Effect.exit(Effect.flatMap(ChromeManagement, (service) => service.getSelf).pipe(Effect.provide(layerLive)))
    }), { concurrency: 1 })

    for (const [index, exit] of exits.entries()) {
      const kind = plan[index]
      expect(Exit.hasDies(exit)).toBe(false)

      if (kind === "present") expect(exit).toEqual(Exit.succeed(infoAt(0)))
      else {
        const error = yield* Effect.flip(exit)
        expect(error.operation).toBe("initialize")

        if (kind === "throwing") expect(error.cause).toBe(cause)
      }
    }

    expect(new Set(plan)).toEqual(new Set(kinds))
  }))
})

describe("ChromeManagement fixture stress", () => {
  it.effect("serves 10,000 installed items and 1,024 concurrent lookups", () => Effect.gen(function*() {
    const random = seeded(10_000)

    const installed = Array.from({ length: 10_000 }, (_, index) => extensionInfo(extensionId(index + 1), {
      permissions: index % 3 === 0 ? ["tabs"] : [], hostPermissions: index % 5 === 0 ? ["<all_urls>"] : []
    }))

    const warnings = new Map([["tabs", "Read your browsing history"], ["<all_urls>", "Read and change all your data on all websites"]])
    const { api } = makeManagement({ installed, warnings })
    const management = make(api)
    const all = yield* management.getAll
    expect(all).toHaveLength(10_001)
    expect(all.slice(1)).toEqual(installed)
    const picks = Array.from({ length: 1024 }, () => Math.floor(random() * 10_000))
    const found = yield* Effect.forEach(picks, (index) => management.get(extensionId(index + 1)), { concurrency: "unbounded" })
    expect(found).toEqual(picks.map((index) => installed[index]))

    const warned = yield* Effect.forEach(picks, (index) => management.getPermissionWarningsById(extensionId(index + 1)), { concurrency: "unbounded" })

    for (const [position, index] of picks.entries()) {
      const expected = [...index % 3 === 0 ? ["Read your browsing history"] : [], ...index % 5 === 0 ? ["Read and change all your data on all websites"] : []]
      expect(warned[position]).toEqual(expected)
    }

    const missing = yield* Effect.forEach(Array.from({ length: 256 }, (_, index) => extensionId(20_000 + index)), (id) => Effect.flip(management.get(id)), { concurrency: "unbounded" })
    expect(missing.every((error) => error.operation === "get")).toBe(true)
  }))

  it.effect("races 2,048 concurrent enable and disable calls on 16 items into a consistent event history", () => Effect.gen(function*() {
    const random = seeded(2048)
    const installed = Array.from({ length: 16 }, (_, index) => extensionInfo(extensionId(index + 1)))
    const { api, controls } = makeManagement({ installed })
    const history = new Map<string, Array<boolean>>()
    const record = (enabled: boolean) => (info: ExtensionInfo) => history.set(info.id, [...history.get(info.id) ?? [], enabled])
    api.onEnabled?.addListener(record(true))
    api.onDisabled?.addListener(record(false))
    const management = make(api)
    const plan = Array.from({ length: 2048 }, () => ({ id: extensionId(1 + Math.floor(random() * 16)), enabled: random() < 0.5 }))
    const exits = yield* Effect.forEach(plan, ({ id, enabled }) => Effect.exit(management.setEnabled(id, enabled)), { concurrency: "unbounded" })
    expect(exits.every(Exit.isSuccess)).toBe(true)

    for (const item of installed) {
      const changes = history.get(item.id) ?? []

      // Each event is a real transition: they alternate, starting from enabled.
      for (const [index, enabled] of changes.entries()) expect(enabled).toBe(index % 2 === 1)

      const last = plan.filter(({ id }) => id === item.id).at(-1)
      expect(controls.item(item.id)?.enabled).toBe(last?.enabled ?? true)
      expect(controls.item(item.id)?.enabled).toBe(changes.at(-1) ?? true)
    }
  }))

  it.effect("lets exactly one of 256 racing held uninstall dialogs remove an item", () => Effect.gen(function*() {
    const { api, controls } = makeManagement({ installed: [extensionInfo(extensionId(1))] })
    const removed: Array<string> = []
    api.onUninstalled?.addListener((id) => { removed.push(id) })
    const management = make(api)
    controls.answerDialogs("hold")
    const outcomes = controls.withUserGesture(() => Array.from({ length: 256 }, () => management.uninstallFromUserGesture(extensionId(1))))
    expect(controls.pendingDialogs).toHaveLength(256)
    const waiters = yield* Effect.forEach(outcomes, (outcome) => Effect.forkChild(Effect.exit(outcome)))

    for (let index = 0; index < 256; index++) controls.answerDialog(true)

    const exits = yield* Effect.forEach(waiters, Fiber.join)
    expect(exits.filter(Exit.isSuccess)).toHaveLength(1)
    expect(Exit.isSuccess(exits[0] ?? Exit.void)).toBe(true)

    for (const exit of exits.slice(1)) {
      const error = yield* Effect.flip(exit)
      expect(error.operation).toBe("uninstall")
      expect(String(error.cause)).toBe(`Error: Failed to find extension with id ${extensionId(1)}.`)
    }

    expect(removed).toEqual([extensionId(1)])
    expect(controls.ids).toEqual([extensionId(0)])
  }))

  it.effect("answers 1,024 held dialogs out of a seeded mix of accepts and cancels", () => Effect.gen(function*() {
    const random = seeded(1024)
    const installed = Array.from({ length: 1024 }, (_, index) => extensionInfo(extensionId(index + 1)))
    const { api, controls } = makeManagement({ installed })
    const management = make(api)
    controls.answerDialogs("hold")
    const outcomes = controls.withUserGesture(() => installed.map((item) => management.uninstallFromUserGesture(item.id)))
    const answers = installed.map(() => random() < 0.5)

    for (const accepted of answers) controls.answerDialog(accepted)

    const exits = yield* Effect.forEach(outcomes, Effect.exit, { concurrency: "unbounded" })

    for (const [index, exit] of exits.entries()) {
      const id = extensionId(index + 1)

      if (answers[index] === true) {
        expect(Exit.isSuccess(exit)).toBe(true)
        expect(controls.item(id)).toBeUndefined()
      } else {
        expect(String((yield* Effect.flip(exit)).cause)).toBe(`Error: Extension ${id} uninstall canceled by user.`)
        expect(controls.item(id)).toBeDefined()
      }
    }

    expect(controls.ids).toHaveLength(1 + answers.filter((accepted) => !accepted).length)
  }))
})
