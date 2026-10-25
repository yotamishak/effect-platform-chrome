// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Deferred, Effect, Exit, Fiber, Option, Result, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeCommandsError, make } from "../../src/ChromeCommands.js"
import type { ChromeCommandsApi, CommandEvent } from "../../src/ChromeCommands.js"
import { makeEvent } from "../../src/testing/Event.js"
import { makeCommands } from "../../src/testing/Commands.js"

/** A deterministic 32-bit generator (mulberry32), so every run explores the same schedule. */
const seeded = (seed: number) => {
  let state = seed >>> 0

  return (): number => {
    state = (state + 0x6D2B79F5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

const shuffle = <A>(values: ReadonlyArray<A>, random: () => number): Array<A> => {
  const result = [...values]

  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    const swap = result[index]
    const value = result[other]

    if (swap === undefined || value === undefined) continue

    result[index] = value
    result[other] = swap
  }

  return result
}

const tabFor = (id: number): chrome.tabs.Tab => ({
  id, index: id % 16, windowId: 1, highlighted: false, active: true, pinned: false, incognito: false,
  discarded: false, autoDiscardable: true, groupId: -1, frozen: false, selected: true, lastAccessed: id
})

/** The event a burst index produces: odd indices carry a tab, even ones carry none. */
const expected = (index: number): CommandEvent => ({
  command: `command-${index}`,
  tab: index % 2 === 1 ? Option.some(tabFor(index)) : Option.none()
})

/** A fresh event with counted registrations and a gate for "n listeners are registered". */
const counted = () => {
  const event = makeEvent<[string, chrome.tabs.Tab?]>()
  const waiters: Array<{ readonly count: number, readonly resolve: () => void }> = []
  const added: Array<(command: string, tab?: chrome.tabs.Tab) => void> = []
  const removed: Array<(command: string, tab?: chrome.tabs.Tab) => void> = []

  const source = {
    addListener: (listener: (command: string, tab?: chrome.tabs.Tab) => void) => {
      added.push(listener)
      event.api.addListener(listener)

      for (const waiter of waiters.filter(({ count }) => event.controls.listenerCount >= count)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve()
      }
    },
    removeListener: (listener: (command: string, tab?: chrome.tabs.Tab) => void) => {
      removed.push(listener)
      event.api.removeListener(listener)
    }
  }

  const waitForListeners = (count: number) => Effect.promise(() => event.controls.listenerCount >= count
    ? Promise.resolve()
    : new Promise<void>((resolve) => { waiters.push({ count, resolve }) }))

  const emitBurst = (count: number) => {
    for (let index = 0; index < count; index++) {
      const { command, tab } = expected(index)

      if (Option.isSome(tab)) event.controls.emit(command, tab.value)
      else event.controls.emit(command)
    }
  }

  return { source, controls: event.controls, added, removed, waitForListeners, emitBurst }
}

const apiOver = (source: ChromeCommandsApi["onCommand"]): ChromeCommandsApi => ({
  getAll: async () => [],
  onCommand: source
})

const newest = (count: number, total: number) => Array.from({ length: Math.min(count, total) }, (_, offset) =>
  expected(Math.max(total - count, 0) + offset))

describe("ChromeCommands stress", () => {
  it.effect.each([1, 63, 64, 65, 1024, 4096])("retains exactly the newest 64 of a %i-event burst, in order", (total) => Effect.gen(function*() {
    const event = counted()
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(make(apiOver(event.source)).onCommand, Math.min(64, total))))
    yield* event.waitForListeners(1)
    event.emitBurst(total)
    expect(yield* Fiber.join(fiber)).toEqual(newest(64, total))
    expect(event.controls.listenerCount).toBe(0)
    expect(event.removed).toEqual(event.added)
  }))

  it.effect("keeps delivering after an overflowing burst and drops nothing that fits", () => Effect.gen(function*() {
    const event = counted()
    const drained = yield* Deferred.make<void>()
    let seen = 0

    const stream = Stream.tap(make(apiOver(event.source)).onCommand, () => Effect.suspend(() => {
      seen++

      return seen === 64 ? Deferred.succeed(drained, undefined) : Effect.void
    }))

    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 64 + 32)))
    yield* event.waitForListeners(1)
    event.emitBurst(4096)
    yield* Deferred.await(drained)
    event.controls.emit("after-0")

    for (let index = 1; index < 32; index++) event.controls.emit(`after-${index}`)

    const values = yield* Fiber.join(fiber)
    expect(values.slice(0, 64)).toEqual(newest(64, 4096))
    expect(values.slice(64).map(({ command }) => command)).toEqual(Array.from({ length: 32 }, (_, index) => `after-${index}`))
    expect(event.controls.listenerCount).toBe(0)
  }))

  it.effect("bounds a 4096-event startup burst independently across 128 subscriptions", () => Effect.gen(function*() {
    const event = counted()
    let registrations = 0

    const source: ChromeCommandsApi["onCommand"] = {
      addListener: (listener) => {
        event.source.addListener(listener)
        registrations++

        // Chrome may dispatch to a listener as soon as it is added; burst into this one only.
        for (let index = 0; index < 4096; index++) {
          const { command, tab } = expected(index)
          listener(command, Option.getOrUndefined(tab))
        }
      },
      removeListener: event.source.removeListener
    }

    const stream = Stream.take(make(apiOver(source)).onCommand, 64)
    const results = yield* Effect.forEach(Array.from({ length: 128 }), () => Stream.runCollect(stream), { concurrency: "unbounded" })

    for (const result of results) expect(result).toEqual(newest(64, 4096))

    expect(registrations).toBe(128)
    expect(event.controls.listenerCount).toBe(0)
    expect(new Set(event.removed)).toEqual(new Set(event.added))
    expect(event.removed).toHaveLength(128)
  }))

  it.effect("churns 512 concurrent subscriptions through every lifecycle stage without leaking a listener", () => Effect.gen(function*() {
    const random = seeded(0xC0FFEE)

    for (let round = 0; round < 2; round++) {
      const event = counted()
      const cause = new Error(`registration failed in round ${round}`)
      const downstream = new ChromeCommandsError({ operation: "consumer", cause: round })

      // Registers the listener and then throws, as a partially successful registration would.
      const failing: ChromeCommandsApi["onCommand"] = {
        addListener: (listener) => {
          event.source.addListener(listener)
          throw cause
        },
        removeListener: event.source.removeListener
      }

      const service = make(apiOver(event.source))
      const failingService = make(apiOver(failing))
      const stages = shuffle(Array.from({ length: 512 }, (_, index) => index % 6), random)
      const count = (stage: number) => stages.filter((each) => each === stage).length
      const entered = yield* Deferred.make<void>()
      const never = yield* Deferred.make<void>()
      let blocked = 0

      const block = Stream.mapEffect(service.onCommand, () => Effect.suspend(() => {
        blocked++

        return (blocked === count(2) ? Deferred.succeed(entered, undefined) : Effect.void).pipe(Effect.andThen(Deferred.await(never)))
      }))

      const run = (stage: number) => {
        switch (stage) {
          case 0: return Effect.asVoid(Stream.runDrain(service.onCommand)) // interrupted at once
          case 1: return Effect.asVoid(Stream.runDrain(service.onCommand)) // interrupted while idle
          case 2: return Effect.asVoid(Stream.runDrain(block)) // interrupted while blocked downstream
          case 3: return Effect.asVoid(Stream.runDrain(failingService.onCommand)) // partial registration
          case 4: return Effect.asVoid(Stream.runCollect(Stream.take(service.onCommand, 3))) // completes
          default: return Effect.asVoid(Stream.runDrain(Stream.mapEffect(service.onCommand, () => Effect.fail(downstream))))
        }
      }

      const fibers = yield* Effect.forEach(stages, (stage) => Effect.gen(function*() {
        const fiber = yield* Effect.forkScoped(run(stage))

        // Stage 0 is interrupted before this fiber yields, so possibly before it registered.
        if (stage === 0) yield* Fiber.interrupt(fiber)

        return { stage, fiber }
      }))

      const byStage = (stage: number) => fibers.filter((each) => each.stage === stage).map(({ fiber }) => fiber)

      for (const exit of yield* Effect.forEach(byStage(0), Fiber.await)) expect(Exit.hasInterrupts(exit)).toBe(true)

      const failures = yield* Effect.forEach(byStage(3), Fiber.await)

      for (const exit of failures) {
        expect(Exit.isFailure(exit)).toBe(true)
        expect(Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none()).toEqual(Option.some(expect.objectContaining({ operation: "onCommand", cause })))
      }

      const live = count(1) + count(2) + count(4) + count(5)
      yield* event.waitForListeners(live)
      expect(event.controls.listenerCount).toBe(live)
      yield* Fiber.interruptAll(byStage(1))
      expect(event.controls.listenerCount).toBe(live - count(1))
      event.emitBurst(100)
      yield* Deferred.await(entered)

      for (const exit of yield* Effect.forEach(byStage(4), Fiber.await)) expect(exit).toEqual(Exit.succeed(undefined))

      for (const exit of yield* Effect.forEach(byStage(5), Fiber.await)) {
        expect(Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none()).toEqual(Option.some(downstream))
      }

      expect(event.controls.listenerCount).toBe(count(2))
      yield* Fiber.interruptAll(byStage(2))

      for (const exit of yield* Effect.forEach(byStage(2), Fiber.await)) expect(Exit.hasInterrupts(exit)).toBe(true)

      expect(event.controls.listenerCount).toBe(0)
      expect(event.removed).toHaveLength(event.added.length)
      expect(new Set(event.removed)).toEqual(new Set(event.added))
      expect(event.controls.emit("after", tabFor(1))).toEqual([])
    }
  }))

  it.effect("types 2048 concurrent getAll calls with interleaved resolutions, rejections, and throws", () => Effect.gen(function*() {
    const random = seeded(0x5EED)
    const total = 2048

    const plan = Array.from({ length: total }, () => {
      const roll = random()

      return roll < 0.25 ? "throw" as const : roll < 0.5 ? "reject" as const : "resolve" as const
    })

    const asynchronous = plan.filter((kind) => kind !== "throw").length
    const releases: Array<() => void> = []
    let allStarted!: () => void
    const started = new Promise<void>((resolve) => { allStarted = resolve })
    let calls = 0

    const api: ChromeCommandsApi = {
      getAll: vi.fn(() => {
        const call = calls++
        const kind = plan[call]

        if (kind === "throw") throw new Error(`throw-${call}`)

        const pending = new Promise<Array<chrome.commands.Command>>((resolve, reject) => {
          releases.push(() => kind === "reject" ? reject(new Error(`reject-${call}`)) : resolve([{ name: `command-${call}` }]))
        })

        if (releases.length === asynchronous) allStarted()

        return pending
      }),
      onCommand: counted().source
    }

    const getAll = make(api).getAll
    const fiber = yield* Effect.forkScoped(Effect.forEach(Array.from({ length: total }), () => Effect.result(getAll), { concurrency: "unbounded" }))
    yield* Effect.promise(() => started)

    for (const release of shuffle(releases, random)) release()

    const results = yield* Fiber.join(fiber)
    const seen = new Set<number>()

    for (const result of results) {
      if (Result.isSuccess(result)) {
        const call = Number(result.success[0]?.name?.slice("command-".length))
        expect(plan[call]).toBe("resolve")
        seen.add(call)
      } else {
        const error = result.failure
        expect(error).toBeInstanceOf(ChromeCommandsError)
        expect(error.operation).toBe("getAll")
        expect(error.cause).toBeInstanceOf(Error)
        const [kind, call] = String(error.cause instanceof Error ? error.cause.message : "").split("-")
        expect(plan[Number(call)]).toBe(kind)
        seen.add(Number(call))
      }
    }

    expect(seen.size).toBe(total)
    expect(calls).toBe(total)
    expect(results.filter(Result.isFailure)).toHaveLength(plan.filter((kind) => kind !== "resolve").length)
  }))

  it.effect("interrupts a seeded half of 2048 pending getAll calls, then settles all of them late", () => Effect.gen(function*() {
    const random = seeded(0xBADC0DE)
    const total = 2048
    const settlers: Array<(call: number) => void> = []
    let allStarted!: () => void
    const started = new Promise<void>((resolve) => { allStarted = resolve })

    const api: ChromeCommandsApi = {
      getAll: () => {
        const call = settlers.length

        const pending = new Promise<Array<chrome.commands.Command>>((resolve, reject) => {
          settlers.push(() => call % 3 === 0 ? reject(new Error(`reject-${call}`)) : resolve([{ name: `command-${call}` }]))
        })

        if (settlers.length === total) allStarted()

        return pending
      },
      onCommand: counted().source
    }

    const getAll = make(api).getAll

    const fibers = yield* Effect.forEach(Array.from({ length: total }, (_, call) => call), (call) =>
      Effect.map(Effect.forkScoped(Effect.result(getAll)), (fiber) => ({ call, fiber })))

    yield* Effect.promise(() => started)
    const interrupted = new Set(shuffle(fibers, random).slice(0, total / 2).map(({ call }) => call))
    yield* Fiber.interruptAll(fibers.filter(({ call }) => interrupted.has(call)).map(({ fiber }) => fiber))

    // Vitest fails the run on an unhandled rejection, so late rejections must stay handled.
    for (const call of shuffle(Array.from({ length: total }, (_, index) => index), random)) settlers[call]?.(call)

    for (const { call, fiber } of fibers) {
      const exit = yield* Fiber.await(fiber)

      if (interrupted.has(call)) {
        expect(Exit.hasInterrupts(exit)).toBe(true)
        continue
      }

      expect(Exit.isSuccess(exit)).toBe(true)
      const result = Exit.isSuccess(exit) ? exit.value : Result.fail(new ChromeCommandsError({ operation: "missing", cause: call }))

      if (call % 3 === 0) {
        expect(Result.isFailure(result) ? result.failure : undefined).toMatchObject({ operation: "getAll", cause: new Error(`reject-${call}`) })
      } else {
        expect(Result.isSuccess(result) ? result.success : undefined).toEqual([{ name: `command-${call}` }])
      }
    }
  }))

  it.effect("removes listeners exactly once even when removal re-enters the event", () => Effect.gen(function*() {
    const event = counted()
    let reentered: ReadonlyArray<unknown> = []

    const source: ChromeCommandsApi["onCommand"] = {
      addListener: event.source.addListener,
      removeListener: (listener) => {
        // A dispatch racing the removal must not reach the closed subscription.
        listener("during-removal")
        reentered = event.controls.emit("reentrant")
        event.source.removeListener(listener)
      }
    }

    const stream = make(apiOver(source)).onCommand

    for (let index = 0; index < 256; index++) {
      const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 1)))
      yield* event.waitForListeners(1)
      event.controls.emit(`command-${index}`)
      expect(yield* Fiber.join(fiber)).toEqual([{ command: `command-${index}`, tab: Option.none() }])
      expect(reentered).toEqual([])
      expect(event.controls.listenerCount).toBe(0)
    }

    expect(event.removed).toHaveLength(256)
  }))

  it.effect("keeps 4096 fixture commands consistent across 512 getAll runs racing shortcut rewrites", () => Effect.gen(function*() {
    const random = seeded(42)
    const declared = Array.from({ length: 4096 }, (_, index) => ({ name: `command-${index}`, description: `Command ${index}`, shortcut: "v0" }))
    const fixture = makeCommands(declared)
    const getAll = make(fixture.api).getAll
    const versions: Array<number> = []

    const rewrite = (version: number) => Effect.sync(() => {
      for (let index = 0; index < 4096; index++) fixture.controls.setShortcut(`command-${index}`, `v${version}`)

      versions.push(version)
    })

    const reads = Array.from({ length: 512 }, () => Effect.asSome(getAll))
    const writes = Array.from({ length: 64 }, (_, version) => Effect.as(rewrite(version + 1), Option.none()))
    const work = shuffle([...reads, ...writes], random)
    const snapshots = (yield* Effect.all(work, { concurrency: 16 })).flatMap((each) => Option.toArray(each))
    expect(snapshots).toHaveLength(512)

    for (const snapshot of snapshots) {
      expect(snapshot).toHaveLength(4096)
      expect(snapshot.map(({ name }) => name)).toEqual(Array.from({ length: 4096 }, (_, index) => `command-${index}`))
      expect(new Set(snapshot.map(({ shortcut }) => shortcut)).size).toBe(1)
    }

    // The runs really interleaved with the rewrites: snapshots saw many distinct versions.
    expect(new Set(snapshots.map((snapshot) => snapshot[0]?.shortcut)).size).toBeGreaterThan(16)
    expect(versions).toHaveLength(64)
    expect((yield* getAll).every(({ shortcut }) => shortcut === "v64")).toBe(true)
  }))

  it.effect("fans 4096 fixture presses out to 128 subscribers, filtering reserved and unbound commands", () => Effect.gen(function*() {
    const random = seeded(7)
    const names = ["_execute_action", "bound-a", "bound-b", "unbound"]
    const shortcuts = ["Ctrl+Shift+E", "Alt+A", "Alt+B", ""]
    const fixture = makeCommands(names.map((name, index) => ({ name, shortcut: shortcuts[index] ?? "" })))
    const registered = yield* Deferred.make<void>()

    const onCommand: ChromeCommandsApi["onCommand"] = {
      addListener: (listener) => {
        fixture.api.onCommand.addListener(listener)

        if (fixture.controls.onCommand.listenerCount === 128) Deferred.doneUnsafe(registered, Effect.void)
      },
      removeListener: (listener) => fixture.api.onCommand.removeListener(listener)
    }

    const stream = make({ ...fixture.api, onCommand }).onCommand
    const presses = Array.from({ length: 4096 }, (_, index) => ({ name: names[Math.floor(random() * names.length)] ?? "bound-a", index }))
    const dispatched = presses.filter(({ name }) => name.startsWith("bound-"))
    const fibers = yield* Effect.forEach(Array.from({ length: 128 }), () => Effect.forkScoped(Stream.runCollect(Stream.take(stream, 64))))
    yield* Deferred.await(registered)

    for (const { name, index } of presses) {
      const outcome = fixture.controls.press(name, index % 2 === 1 ? tabFor(index) : undefined)
      expect(outcome.dispatched).toBe(name.startsWith("bound-"))
    }

    const expectedEvents = dispatched.slice(-64).map(({ name, index }) => ({
      command: name, tab: index % 2 === 1 ? Option.some(tabFor(index)) : Option.none()
    }))

    for (const values of yield* Effect.forEach(fibers, Fiber.join)) expect(values).toEqual(expectedEvents)

    expect(fixture.controls.onCommand.listenerCount).toBe(0)
  }))
})
