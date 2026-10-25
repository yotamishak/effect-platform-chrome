// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Deferred, Effect, Exit, Fiber, Result, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChromeNotificationsError, make } from "../../src/ChromeNotifications.js"
import type {
  ButtonClickedEvent,
  ChromeNotificationsApi,
  ChromeNotificationsService,
  ClosedEvent,
  NotificationCreateOptions,
  PermissionLevel
} from "../../src/ChromeNotifications.js"
import type { EventSource } from "../../src/internal/event.js"
import { makeNotifications, notificationErrors, notificationIntegerError } from "../../src/testing/Notifications.js"

/** Events in one burst: far beyond the 64-event subscription buffer. */
const burst = 4096

/** What each subscription retains of a burst it does not drain. */
const buffer = 64

const options: NotificationCreateOptions = { type: "basic", iconUrl: "icon.png", title: "Stress", message: "Burst" }

/** The newest `kept` indices of a burst of `count`, oldest first. */
const newest = (count: number, kept = buffer): Array<number> => Array.from({ length: kept }, (_, index) => count - kept + index)

/** A deterministic generator (mulberry32), so shuffles repeat from run to run. */
const seeded = (seed: number) => {
  let state = seed >>> 0

  return (): number => {
    state = (state + 0x6D2B79F5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/** A seeded Fisher-Yates shuffle into a new array. */
const shuffle = <A>(values: ReadonlyArray<A>, random: () => number): Array<A> => {
  const result = [...values]

  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    const value = result[index]
    const swapped = result[other]

    if (value !== undefined && swapped !== undefined) {
      result[index] = swapped
      result[other] = value
    }
  }

  return result
}

/** A gate that completes once `size` registrations are live at the same time. */
const gates = () => {
  const waiting: Array<{ readonly size: number; readonly deferred: Deferred.Deferred<void> }> = []

  return {
    open: (live: number) => {
      for (const gate of waiting.splice(0)) {
        if (live >= gate.size) Deferred.doneUnsafe(gate.deferred, Effect.void)
        else waiting.push(gate)
      }
    },
    wait: (live: () => number, size: number): Effect.Effect<void> => Effect.suspend(() => {
      if (live() >= size) return Effect.void

      const deferred = Deferred.makeUnsafe<void>()
      waiting.push({ size, deferred })

      return Deferred.await(deferred)
    })
  }
}

/** Code that runs inside a registration call, as a reentrant Chrome dispatch would. */
interface EventHooks {
  onAdd?: () => void
  onRemove?: () => void
}

/**
 * A Chrome-like event recording every registration and removal, with a registration gate, the
 * next `addListener` failures (optionally after registering, as a partial registration), and
 * hooks that run inside `addListener` / `removeListener` to dispatch reentrantly.
 */
const gatedEvent = <Args extends ReadonlyArray<unknown>>() => {
  type Listener = (...args: Args) => void

  const listeners = new Set<Listener>()
  const added: Array<Listener> = []
  const removed: Array<Listener> = []
  const failures: Array<{ readonly cause: Error; readonly afterRegistering: boolean }> = []
  const gate = gates()
  const hooks: EventHooks = {}

  return {
    listeners,
    added,
    removed,
    hooks,
    addListener: (listener: Listener) => {
      const failure = failures.shift()

      if (failure !== undefined && !failure.afterRegistering) throw failure.cause

      listeners.add(listener)
      added.push(listener)
      hooks.onAdd?.()
      gate.open(listeners.size)

      if (failure !== undefined) throw failure.cause
    },
    removeListener: (listener: Listener) => {
      listeners.delete(listener)
      removed.push(listener)
      hooks.onRemove?.()
    },
    /** Synchronous dispatch over a snapshot, as Chrome does. */
    emit: (...args: Args) => {
      for (const listener of Array.from(listeners)) listener(...args)
    },
    /** Calls every removed listener again, as a callback Chrome had already queued. */
    callRemoved: (...args: Args) => {
      for (const listener of removed) listener(...args)
    },
    failNext: (cause: Error, afterRegistering: boolean) => {
      failures.push({ cause, afterRegistering })
    },
    registered: (size: number): Effect.Effect<void> => gate.wait(() => listeners.size, size)
  }
}

/** Wraps an event so tests can wait for its registrations instead of scheduler turns. */
const counted = <Args extends ReadonlyArray<unknown>>(event: EventSource<Args>) => {
  const gate = gates()
  let live = 0

  const source: EventSource<Args> = {
    addListener: (listener) => {
      event.addListener(listener)
      live++
      gate.open(live)
    },
    removeListener: (listener) => {
      event.removeListener(listener)
      live--
    }
  }

  return { source, registered: (size: number) => gate.wait(() => live, size) }
}

interface PendingCall {
  readonly operation: string
  readonly resolve: () => void
  readonly reject: (cause: Error) => void
}

/**
 * Native calls that stay pending until the test settles them. Every `throwEvery`-th arrival
 * (none when 0) throws synchronously instead, as a Chrome argument error does.
 */
const pendingCalls = (throwEvery: number) => {
  const calls: Array<PendingCall> = []
  const thrown = new Map<Error, string>()
  const gate = gates()
  let arrivals = 0

  return {
    calls,
    thrown,
    call: <A>(operation: string, value: A): Promise<A> => {
      const arrival = arrivals++

      if (throwEvery > 0 && arrival % throwEvery === 0) {
        const cause = new Error(`${operation} threw synchronously`)
        thrown.set(cause, operation)

        throw cause
      }

      return new Promise<A>((resolve, reject) => {
        calls.push({ operation, resolve: () => resolve(value), reject })
        gate.open(calls.length)
      })
    },
    arrived: (size: number): Effect.Effect<void> => gate.wait(() => calls.length, size)
  }
}

const harness = (throwEvery = 7) => {
  const onClicked = gatedEvent<[notificationId: string]>()
  const onButtonClicked = gatedEvent<[notificationId: string, buttonIndex: number]>()
  const onClosed = gatedEvent<[notificationId: string, byUser: boolean]>()
  const onPermissionLevelChanged = gatedEvent<[level: PermissionLevel]>()
  const pending = pendingCalls(throwEvery)

  const create = (...args: [string, NotificationCreateOptions] | [NotificationCreateOptions]) =>
    pending.call("create", args.length === 2 ? args[0] : "generated")

  const api: ChromeNotificationsApi = {
    create,
    update: (notificationId) => pending.call("update", notificationId.length % 2 === 0),
    clear: (notificationId) => pending.call("clear", notificationId.length % 2 === 1),
    getAll: () => pending.call("getAll", { a: true, b: true }),
    getPermissionLevel: () => pending.call<PermissionLevel>("getPermissionLevel", "granted"),
    onClicked,
    onButtonClicked,
    onClosed,
    onPermissionLevelChanged
  }

  return { service: make(api), pending, onClicked, onButtonClicked, onClosed, onPermissionLevelChanged }
}

type Harness = ReturnType<typeof harness>

type Emitted = string | ButtonClickedEvent | ClosedEvent

/** The argument-independent view of one gated event that the shared stream cases need. */
interface EventView {
  readonly listeners: ReadonlySet<object>
  readonly added: ReadonlyArray<object>
  readonly removed: ReadonlyArray<object>
  readonly registered: (size: number) => Effect.Effect<void>
  readonly failNext: (cause: Error, afterRegistering: boolean) => void
  /** Emits the event numbered `index`. */
  readonly emitIndex: (index: number) => void
  /** Calls every removed listener with a late event. */
  readonly callRemoved: () => void
}

interface StreamCase {
  readonly operation: "onClicked" | "onButtonClicked" | "onClosed" | "onPermissionLevelChanged"
  readonly event: (harness: Harness) => EventView
  readonly stream: (service: ChromeNotificationsService) => Stream.Stream<Emitted, ChromeNotificationsError>
  /** What the stream delivers for the event numbered `index`. */
  readonly expected: (index: number) => Emitted
}

const levelOf = (index: number): PermissionLevel => index % 2 === 0 ? "granted" : "denied"

const view = <Args extends ReadonlyArray<unknown>>(
  event: ReturnType<typeof gatedEvent<Args>>,
  argsOf: (index: number) => Args
): EventView => ({
  listeners: event.listeners,
  added: event.added,
  removed: event.removed,
  registered: event.registered,
  failNext: event.failNext,
  emitIndex: (index) => event.emit(...argsOf(index)),
  callRemoved: () => event.callRemoved(...argsOf(-1))
})

const streamCases: ReadonlyArray<StreamCase> = [
  {
    operation: "onClicked",
    event: (h) => view(h.onClicked, (index): [string] => [`n-${index}`]),
    stream: (service) => service.onClicked,
    expected: (index) => `n-${index}`
  },
  {
    operation: "onButtonClicked",
    event: (h) => view(h.onButtonClicked, (index): [string, number] => [`n-${index}`, Math.abs(index % 2)]),
    stream: (service) => service.onButtonClicked,
    expected: (index) => ({ notificationId: `n-${index}`, buttonIndex: Math.abs(index % 2) })
  },
  {
    operation: "onClosed",
    event: (h) => view(h.onClosed, (index): [string, boolean] => [`n-${index}`, index % 3 === 0]),
    stream: (service) => service.onClosed,
    expected: (index) => ({ notificationId: `n-${index}`, byUser: index % 3 === 0 })
  },
  {
    operation: "onPermissionLevelChanged",
    event: (h) => view(h.onPermissionLevelChanged, (index): [PermissionLevel] => [levelOf(index)]),
    stream: (service) => service.onPermissionLevelChanged,
    expected: levelOf
  }
]

/**
 * Every listener added was removed exactly once, and none is left. A refused registration
 * still removes its listener, which Chrome ignores, so removals may outnumber additions.
 */
const expectNoLeaks = (event: Pick<EventView, "listeners" | "added" | "removed">) => {
  expect(event.listeners.size).toBe(0)
  expect(new Set(event.added).size).toBe(event.added.length)

  const removals = new Map<object, number>()

  for (const listener of event.removed) removals.set(listener, (removals.get(listener) ?? 0) + 1)

  expect(event.added.every((listener) => removals.get(listener) === 1)).toBe(true)
  expect(Array.from(removals.values()).every((count) => count === 1)).toBe(true)
}

describe("ChromeNotifications stress", () => {
  it.effect.each(streamCases)("$operation keeps exactly the newest 64 of a 4,096-event burst, in order", (testCase) => Effect.gen(function*() {
    const h = harness()
    const event = testCase.event(h)
    const consumer = yield* Effect.forkScoped(Stream.runCollect(Stream.take(testCase.stream(h.service), buffer)))

    yield* event.registered(1)

    for (let index = 0; index < burst; index++) event.emitIndex(index)

    expect(yield* Fiber.join(consumer)).toEqual(newest(burst).map(testCase.expected))
    expect(event.added).toHaveLength(1)
    expectNoLeaks(event)
  }))

  it.effect.each(streamCases)("$operation gives 64 concurrent subscribers each the newest 64 of a burst", (testCase) => Effect.gen(function*() {
    const h = harness()
    const event = testCase.event(h)
    const stream = testCase.stream(h.service)
    const consumers = yield* Effect.forEach(Array.from({ length: 64 }), () => Effect.forkScoped(Stream.runCollect(Stream.take(stream, buffer))))

    yield* event.registered(64)

    for (let index = 0; index < burst; index++) event.emitIndex(index)

    const expected = newest(burst).map(testCase.expected)

    for (const consumer of consumers) expect(yield* Fiber.join(consumer)).toEqual(expected)

    expect(event.added).toHaveLength(64)
    expectNoLeaks(event)
  }))

  it.effect.each(streamCases)("$operation churns 512 subscriptions through every stage, ending with no listeners", (testCase) => Effect.gen(function*() {
    const h = harness()
    const event = testCase.event(h)
    const stream = testCase.stream(h.service)
    const random = seeded(0x5EED)
    const blocked = Deferred.makeUnsafe<void>()

    for (let round = 0; round < 2; round++) {
      // Failed and partial registrations, alone so each queued failure reaches its own subscriber.
      const failing = Array.from({ length: 128 }, (_, index) => index % 2 === 1)

      for (const partial of failing) event.failNext(new Error(partial ? "registered, then failed" : "refused"), partial)

      const failures = yield* Effect.forEach(failing, () => Effect.flip(Stream.runDrain(stream)), { concurrency: "unbounded" })

      expect(failures.every((error) => error instanceof ChromeNotificationsError && error.operation === testCase.operation)).toBe(true)
      expectNoLeaks(event)

      // The rest: 0 interrupted right after forking, 1 after registering, 2 with undelivered
      // buffered events, 3 ended by `take`, 4 interrupted while its consumer is mid-element.
      const stages = Array.from({ length: 384 }, (_, index) => index % 5)

      const fibers = yield* Effect.forEach(stages, (stage) => {
        switch (stage) {
          case 2:
            // Pulls one element and blocks on it: the rest stay buffered.
            return Effect.forkChild(Stream.runDrain(Stream.mapEffect(stream, () => Deferred.await(blocked))))
          case 3:
            return Effect.forkChild(Stream.runDrain(Stream.take(stream, 3)))
          case 4:
            return Effect.forkChild(Stream.runDrain(Stream.mapEffect(Stream.take(stream, 5), () => Deferred.await(blocked))))
          default:
            return Effect.forkChild(Stream.runDrain(stream))
        }
      })

      const atStage = (wanted: ReadonlyArray<number>) => fibers.filter((_, index) => wanted.includes(stages[index] ?? -1))

      yield* Effect.forEach(atStage([0]), Fiber.interrupt)
      yield* event.registered(stages.filter((stage) => stage !== 0).length)

      for (let index = 0; index < 100; index++) event.emitIndex(index)

      const ended = yield* Effect.forEach(atStage([3]), Fiber.await)
      expect(ended.every(Exit.isSuccess)).toBe(true)

      yield* Effect.forEach(shuffle(atStage([1, 2, 4]), random), Fiber.interrupt, { concurrency: "unbounded" })
      const interrupted = yield* Effect.forEach(atStage([0, 1, 2, 4]), Fiber.await)
      expect(interrupted.every(Exit.hasInterrupts)).toBe(true)
      expectNoLeaks(event)
    }

    // Per round: 64 partial registrations, and the 307 subscriptions not interrupted right
    // after forking; those 77 may or may not have registered first.
    expect(event.added.length).toBeGreaterThanOrEqual(2 * (64 + 307))
    expect(event.added.length).toBeLessThanOrEqual(2 * (64 + 384))
    // Late callbacks to every removed listener are ignored.
    expect(() => event.callRemoved()).not.toThrow()
  }))

  it.effect("settles 1,536 concurrent calls with interleaved rejections and throws, naming each operation", () => Effect.gen(function*() {
    const h = harness(7)

    const operations: ReadonlyArray<{ readonly operation: string; readonly run: (index: number) => Effect.Effect<void, ChromeNotificationsError> }> = [
      { operation: "create", run: (index) => Effect.asVoid(h.service.create(options, `n-${index}`)) },
      { operation: "create", run: () => Effect.asVoid(h.service.create(options)) },
      { operation: "update", run: (index) => Effect.asVoid(h.service.update(`n-${index}`, { title: `t-${index}` })) },
      { operation: "clear", run: (index) => Effect.asVoid(h.service.clear(`n-${index}`)) },
      { operation: "getAll", run: () => Effect.asVoid(h.service.getAll) },
      { operation: "getPermissionLevel", run: () => Effect.asVoid(h.service.getPermissionLevel) }
    ]

    const planned = Array.from({ length: 256 }, () => operations).flat()
    const total = planned.length

    const fiber = yield* Effect.forkChild(Effect.forEach(planned, ({ operation, run }, index) =>
      Effect.map(Effect.result(run(index)), (result) => ({ operation, result })), { concurrency: "unbounded" }))

    const thrownCount = Math.ceil(total / 7)

    yield* h.pending.arrived(total - thrownCount)
    expect(h.pending.thrown.size).toBe(thrownCount)

    // Settle newest first, rejecting every other pending call.
    const rejected = new Map<Error, string>()

    for (let index = h.pending.calls.length - 1; index >= 0; index--) {
      const call = h.pending.calls[index]

      if (call === undefined) continue

      if (index % 2 === 0) {
        const cause = new Error(`${call.operation} rejected`)
        rejected.set(cause, call.operation)
        call.reject(cause)
      } else {
        call.resolve()
      }
    }

    const results = yield* Fiber.join(fiber)
    const injected = new Map([...h.pending.thrown, ...rejected])
    const seen = new Set<Error>()

    for (const { operation, result } of results) {
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(ChromeNotificationsError)
        expect(result.failure.operation).toBe(operation)
        expect(result.failure.cause).toBeInstanceOf(Error)

        if (result.failure.cause instanceof Error) {
          expect(injected.get(result.failure.cause)).toBe(operation)
          seen.add(result.failure.cause)
        }
      }
    }

    expect(seen.size).toBe(injected.size)
    expect(results.filter(({ result }) => Result.isFailure(result))).toHaveLength(injected.size)
    expect(results.filter(({ result }) => Result.isSuccess(result))).toHaveLength(total - injected.size)
  }))

  it.effect("returns each of 1,024 concurrent calls its own result, whatever the settlement order", () => Effect.gen(function*() {
    const h = harness(0)

    const fiber = yield* Effect.forkChild(Effect.all({
      created: Effect.forEach(Array.from({ length: 512 }, (_, index) => `id-${index}`), (id) => h.service.create(options, id), { concurrency: "unbounded" }),
      updated: Effect.forEach(Array.from({ length: 256 }, (_, index) => "x".repeat(index)), (id) => h.service.update(id, {}), { concurrency: "unbounded" }),
      listed: Effect.forEach(Array.from({ length: 256 }), () => h.service.getAll, { concurrency: "unbounded" })
    }, { concurrency: "unbounded" }))

    yield* h.pending.arrived(1024)

    for (const call of shuffle(h.pending.calls, seeded(42))) call.resolve()

    const { created, updated, listed } = yield* Fiber.join(fiber)
    expect(created).toEqual(Array.from({ length: 512 }, (_, index) => `id-${index}`))
    expect(updated).toEqual(Array.from({ length: 256 }, (_, index) => index % 2 === 0))
    expect(listed.every((ids) => ids.join() === "a,b")).toBe(true)
  }))

  it.effect("interrupts 512 calls mid-operation and tolerates their late settlement", () => Effect.gen(function*() {
    const h = harness(0)

    const calls = [
      (index: number) => Effect.asVoid(h.service.create(options, `n-${index}`)),
      (index: number) => Effect.asVoid(h.service.clear(`n-${index}`)),
      () => Effect.asVoid(h.service.getAll)
    ]

    const fibers = yield* Effect.forEach(Array.from({ length: 171 }, () => calls).flat().slice(0, 512), (call, index) => Effect.forkChild(call(index)))

    yield* h.pending.arrived(512)
    yield* Effect.forEach(fibers, Fiber.interrupt, { concurrency: "unbounded" })

    for (const [index, call] of h.pending.calls.entries()) {
      if (index % 2 === 0) call.reject(new Error("late rejection"))
      else call.resolve()
    }

    const exits = yield* Effect.forEach(fibers, Fiber.await)
    expect(exits.every(Exit.hasInterrupts)).toBe(true)

    const after = yield* Effect.forkChild(h.service.getPermissionLevel)

    yield* h.pending.arrived(513)
    h.pending.calls[512]?.resolve()
    expect(yield* Fiber.join(after)).toBe("granted")
  }))

  it.effect("delivers events dispatched reentrantly while registering and ignores those while removing", () => Effect.gen(function*() {
    const h = harness()
    let removals = 0

    h.onClicked.hooks.onAdd = () => h.onClicked.emit("during-add")

    h.onClicked.hooks.onRemove = () => {
      removals++
      h.onClicked.emit("during-remove")
    }

    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(h.service.onClicked, 2)))

    yield* h.onClicked.registered(1)
    h.onClicked.emit("after-add")
    expect(yield* Fiber.join(fiber)).toEqual(["during-add", "after-add"])
    expect(removals).toBe(1)
    expectNoLeaks(h.onClicked)
  }))
})

interface RaceResult {
  readonly kind: "update" | "clear"
  readonly id: string
  readonly changed: boolean
}

describe("makeNotifications stress", () => {
  it.effect("holds 10,000 notifications with unique generated ids, sorted as Chrome lists them", () => Effect.gen(function*() {
    const fixture = makeNotifications()
    const notifications = make(fixture.api)
    const chosen = Array.from({ length: 5000 }, (_, index) => `notification-${index * 2 + 1}`)

    yield* Effect.forEach(chosen, (id) => notifications.create(options, id), { concurrency: "unbounded", discard: true })
    const generated = yield* Effect.forEach(Array.from({ length: 5000 }), () => notifications.create(options), { concurrency: "unbounded" })

    // Generated ids skip the odd ids already showing.
    expect(generated).toEqual(Array.from({ length: 5000 }, (_, index) => `notification-${index * 2 + 2}`))

    const all = yield* notifications.getAll
    expect(all).toHaveLength(10_000)
    expect(new Set(all)).toEqual(new Set([...chosen, ...generated]))
    expect(all).toEqual([...all].sort((left, right) => left < right ? -1 : left > right ? 1 : 0))
  }))

  it.effect("clears 10,000 notifications in one burst; an onClosed subscriber keeps the newest 64", () => Effect.gen(function*() {
    const fixture = makeNotifications()
    const notifications = make(fixture.api)
    const ids = Array.from({ length: 10_000 }, (_, index) => `n-${String(index).padStart(5, "0")}`)

    yield* Effect.forEach(ids, (id) => notifications.create(options, id), { discard: true })
    const consumer = yield* Effect.forkScoped(Stream.runCollect(Stream.take(notifications.onClosed, buffer)))

    yield* Effect.promise(() => fixture.controls.onClosed.waitForListener())

    // Each clear runs synchronously up to its result, so this loop is one burst of events.
    const cleared = ids.map((id) => fixture.api.clear(id))

    expect(yield* Effect.promise(() => Promise.all(cleared))).toEqual(ids.map(() => true))
    expect(yield* Fiber.join(consumer)).toEqual(ids.slice(-buffer).map((notificationId) => ({ notificationId, byUser: false })))
    expect(yield* notifications.getAll).toEqual([])
    expect(fixture.controls.onClosed.listenerCount).toBe(0)
  }))

  it.effect("resolves 1,024 concurrent creates of one id to a single notification, the last one", () => Effect.gen(function*() {
    const fixture = makeNotifications()
    const notifications = make(fixture.api)
    const closes = yield* Effect.forkScoped(Stream.runCollect(Stream.take(notifications.onClosed, 1)))

    yield* Effect.promise(() => fixture.controls.onClosed.waitForListener())

    const ids = yield* Effect.forEach(
      Array.from({ length: 1024 }, (_, index) => index),
      (index) => notifications.create({ ...options, message: `message-${index}` }, "shared"),
      { concurrency: "unbounded" }
    )

    expect(new Set(ids)).toEqual(new Set(["shared"]))
    expect(yield* notifications.getAll).toEqual(["shared"])
    expect(fixture.controls.notification("shared")?.message).toBe("message-1023")
    // Replacing never reported a close; the single close is the clear.
    expect(yield* notifications.clear("shared")).toBe(true)
    expect(yield* Fiber.join(closes)).toEqual([{ notificationId: "shared", byUser: false }])
  }))

  it.effect("races 512 updates against 512 clears consistently", () => Effect.gen(function*() {
    const fixture = makeNotifications()
    const notifications = make(fixture.api)
    const ids = Array.from({ length: 512 }, (_, index) => `n-${index}`)

    yield* Effect.forEach(ids, (id) => notifications.create({ ...options, type: "progress", progress: 0 }, id), { discard: true })

    const operations = shuffle(ids.flatMap((id) => [
      { kind: "update" as const, id },
      { kind: "clear" as const, id }
    ]), seeded(7))

    const results = yield* Effect.forEach(operations, ({ kind, id }): Effect.Effect<RaceResult, ChromeNotificationsError> => kind === "update"
      ? Effect.map(notifications.update(id, { progress: 50 }), (changed) => ({ kind, id, changed }))
      : Effect.map(notifications.clear(id), (changed) => ({ kind, id, changed })),
    { concurrency: "unbounded" })

    for (const id of ids) {
      const clear = results.find((result) => result.kind === "clear" && result.id === id)
      const update = results.find((result) => result.kind === "update" && result.id === id)
      const clearIndex = operations.findIndex((operation) => operation.kind === "clear" && operation.id === id)
      const updateIndex = operations.findIndex((operation) => operation.kind === "update" && operation.id === id)
      expect(clear?.changed).toBe(true)
      // An update reaches the notification exactly when it was issued before the clear.
      expect(update?.changed).toBe(updateIndex < clearIndex)
    }

    expect(yield* notifications.getAll).toEqual([])
  }))

  it.effect("refuses calls from the moment permission is denied mid-flight", () => Effect.gen(function*() {
    const fixture = makeNotifications()
    const notifications = make(fixture.api)

    const calls = Array.from({ length: 1025 }, (_, index) => index === 512
      ? Effect.sync(() => fixture.controls.setPermissionLevel("denied")).pipe(Effect.as(Result.succeed("flipped")))
      : Effect.result(notifications.create(options, `n-${index}`)))

    const results = yield* Effect.all(calls, { concurrency: "unbounded" })

    expect(results.slice(0, 512).every(Result.isSuccess)).toBe(true)

    const refused = results.slice(513)

    expect(refused).toHaveLength(512)

    for (const result of refused) {
      expect(Result.isFailure(result)).toBe(true)

      if (Result.isFailure(result)) {
        expect(result.failure.operation).toBe("create")
        expect(result.failure.cause).toEqual(new Error(notificationErrors.denied))
      }
    }

    expect(yield* notifications.getPermissionLevel).toBe("denied")
    fixture.controls.setPermissionLevel("granted")
    expect(yield* notifications.getAll).toHaveLength(512)
  }))

  it.effect("types 2,048 concurrent fixture calls that throw, reject or succeed, keeping only the accepted ones", () => Effect.gen(function*() {
    const fixture = makeNotifications()
    const notifications = make(fixture.api)
    const random = seeded(0xC0FFEE)

    type Kind = "accepted" | "throws" | "rejects"

    const kinds: ReadonlyArray<Kind> = ["accepted", "throws", "rejects"]
    const plan = Array.from({ length: 1024 }, (_, index) => ({ index, kind: kinds[Math.floor(random() * 3)] ?? "accepted" }))

    // A fractional priority throws in the bindings; a negative one is rejected by the browser.
    const priorities: Record<Kind, number> = { accepted: 1, throws: 0.5, rejects: -1 }

    const creates = plan.map(({ index, kind }) =>
      Effect.result(notifications.create({ ...options, type: "progress", priority: priorities[kind] }, `n-${index}`)))

    const created = yield* Effect.all(creates, { concurrency: "unbounded" })

    // Updates race over the same ids: integer progress succeeds where the create did.
    const updates = plan.map(({ index, kind }) => Effect.result(notifications.update(
      `n-${index}`,
      { progress: kind === "throws" ? index + 0.25 : index % 101 }
    )))

    const updated = yield* Effect.all(updates, { concurrency: "unbounded" })

    for (const [position, { index, kind }] of plan.entries()) {
      const create = created[position]
      const update = updated[position]

      if (create === undefined || update === undefined) throw new Error(`missing result ${position}`)

      if (kind === "accepted") {
        expect(create).toEqual(Result.succeed(`n-${index}`))
        expect(update).toEqual(Result.succeed(true))
        expect(fixture.controls.notification(`n-${index}`)?.progress).toBe(index % 101)
        continue
      }

      expect(Result.isFailure(create)).toBe(true)

      if (Result.isFailure(create)) {
        expect(create.failure.operation).toBe("create")
        expect(create.failure.cause).toEqual(kind === "throws"
          ? new TypeError(notificationIntegerError("priority"))
          : new Error(notificationErrors.lowPriority))
      }

      if (kind === "throws") {
        // The bindings refuse a fractional progress before the id is even looked up.
        expect(Result.isFailure(update) && update.failure.operation === "update").toBe(true)
        expect(Result.isFailure(update) ? update.failure.cause : undefined).toEqual(new TypeError(notificationIntegerError("progress")))
      } else {
        expect(update).toEqual(Result.succeed(false))
      }
    }

    const accepted = plan.filter(({ kind }) => kind === "accepted").map(({ index }) => `n-${index}`)

    expect(accepted.length).toBeGreaterThan(256)
    expect(yield* notifications.getAll).toEqual([...accepted].sort())
  }))

  it.effect("fans 32 simulated button clicks out to 512 subscribers without loss", () => Effect.gen(function*() {
    const fixture = makeNotifications()
    const buttons = counted(fixture.api.onButtonClicked)
    const notifications = make({ ...fixture.api, onButtonClicked: buttons.source })

    yield* notifications.create({ ...options, buttons: [{ title: "Yes" }, { title: "No" }] }, "fan")
    const clicks = yield* Effect.forEach(Array.from({ length: 512 }), () => Effect.forkScoped(Stream.runCollect(Stream.take(notifications.onButtonClicked, 32))))

    yield* buttons.registered(512)
    expect(fixture.controls.onButtonClicked.listenerCount).toBe(512)

    for (let index = 0; index < 32; index++) expect(fixture.controls.clickButton("fan", index % 2)).toEqual([])

    const expected = Array.from({ length: 32 }, (_, index) => ({ notificationId: "fan", buttonIndex: index % 2 }))

    for (const fiber of clicks) expect(yield* Fiber.join(fiber)).toEqual(expected)

    expect(fixture.controls.onButtonClicked.listenerCount).toBe(0)
  }))
})
