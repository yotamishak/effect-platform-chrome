// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Deferred, Effect, Exit, Fiber, Logger, Option, Result, Scope, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChromeDebuggerError, make } from "../../src/ChromeDebugger.js"
import type { ChromeDebuggerApi, CommandParams, CommandTarget, Debuggee, DetachReason, TargetInfo } from "../../src/ChromeDebugger.js"
import { makeEvent } from "../../src/ChromeTesting.js"
import { makeDebugger } from "../../src/testing/Debugger.js"
import type { EventSource } from "../../src/internal/event.js"

/** mulberry32: a deterministic generator, so every run takes the same interleavings. */
const seeded = (seed: number) => {
  let state = seed >>> 0

  return (): number => {
    state = (state + 0x6D2B79F5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

const shuffle = <A>(items: ReadonlyArray<A>, random: () => number): Array<A> => {
  const shuffled = Array.from(items)

  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    const swap = shuffled[index]!
    shuffled[index] = shuffled[other]!
    shuffled[other] = swap
  }

  return shuffled
}

const range = (length: number): Array<number> => Array.from({ length }, (_, index) => index)

/** A promise settled by the test, for holding a Chrome call open. */
const gate = <A = void>() => {
  let resolve!: (value: A) => void
  let reject!: (cause: Error) => void

  const promise = new Promise<A>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })

  return { promise, resolve, reject }
}

/** A simulated event whose listener count can be awaited without polling. */
const watchedEvent = <Args extends ReadonlyArray<unknown>>() => {
  const event = makeEvent<Args>()
  let waiters: Array<{ readonly count: number, readonly resolve: () => void }> = []

  const check = () => {
    const ready = waiters.filter((waiter) => waiter.count === event.controls.listenerCount)
    waiters = waiters.filter((waiter) => waiter.count !== event.controls.listenerCount)

    for (const waiter of ready) waiter.resolve()
  }

  const api: EventSource<Args> = {
    addListener: (listener) => {
      event.api.addListener(listener)
      check()
    },
    removeListener: (listener) => {
      event.api.removeListener(listener)
      check()
    }
  }

  return {
    api,
    controls: event.controls,
    /** Waits until exactly `count` listeners are registered. */
    waitForCount: (count: number) => Effect.promise(() => count === event.controls.listenerCount
      ? Promise.resolve()
      : new Promise<void>((resolve) => { waiters.push({ count, resolve }) }))
  }
}

const baseApi = () => {
  const onEvent = watchedEvent<[source: CommandTarget, method: string, params?: object]>()
  const onDetach = watchedEvent<[source: Debuggee, reason: DetachReason]>()

  const api: ChromeDebuggerApi = {
    attach: async () => {},
    detach: async () => {},
    sendCommand: async () => ({}),
    getTargets: async () => [],
    onEvent: onEvent.api,
    onDetach: onDetach.api
  }

  return { api, onEvent, onDetach, listeners: () => onEvent.controls.listenerCount + onDetach.controls.listenerCount }
}

const burst = 4096

const methods = (events: ReadonlyArray<{ readonly method: string }>) => events.map((event) => event.method)

const newest = (count: number, total = burst) => range(count).map((index) => `Event.${total - count + index}`)

describe("ChromeDebugger stress", () => {
  it.effect("keeps exactly the newest 64 of 4,096 events on each stream, then removes the listener", () => Effect.gen(function*() {
    const mock = baseApi()
    const service = make(mock.api)

    const events = yield* Effect.forkChild(Stream.runCollect(Stream.take(service.onEvent, 64)))
    yield* mock.onEvent.waitForCount(1)

    for (let index = 0; index < burst; index++) mock.onEvent.controls.emit({ tabId: index }, `Event.${index}`)

    const collected = yield* Fiber.join(events)
    expect(methods(collected)).toEqual(newest(64))
    expect(collected.map((event) => event.source.tabId)).toEqual(range(64).map((index) => burst - 64 + index))
    expect(mock.onEvent.controls.listenerCount).toBe(0)

    const detaches = yield* Effect.forkChild(Stream.runCollect(Stream.take(service.onDetach, 64)))
    yield* mock.onDetach.waitForCount(1)

    for (let index = 0; index < burst; index++) mock.onDetach.controls.emit({ tabId: index }, index % 2 === 0 ? "target_closed" : "canceled_by_user")

    expect((yield* Fiber.join(detaches)).map((event) => event.source.tabId)).toEqual(range(64).map((index) => burst - 64 + index))
    expect(mock.listeners()).toBe(0)
  }))

  it.effect("keeps exactly the newest `capacity` of 4,096 session events among other targets' noise", () => Effect.gen(function*() {
    for (const capacity of [1, 7, 64, 1000, burst]) {
      const mock = baseApi()
      const random = seeded(capacity)

      const collected = yield* Effect.scoped(Effect.gen(function*() {
        const session = capacity === 64
          ? yield* make(mock.api).session({ tabId: 1 }, "1.3")
          : yield* make(mock.api).session({ tabId: 1 }, "1.3", { capacity })

        for (let index = 0; index < burst; index++) {
          // Other targets' events and detaches never take a buffer slot or end the session.
          if (random() < 0.5) mock.onEvent.controls.emit({ tabId: 2 }, "Noise.event")

          if (random() < 0.1) mock.onDetach.controls.emit({ tabId: 3 }, "target_closed")

          mock.onEvent.controls.emit(index % 3 === 0 ? { tabId: 1, sessionId: `child-${index}` } : { tabId: 1 }, `Event.${index}`)
        }

        mock.onDetach.controls.emit({ tabId: 1 }, "target_closed")

        return yield* Stream.runCollect(session.events)
      }))

      const kept = Math.min(capacity, burst)
      expect(methods(collected)).toEqual(newest(kept))
      expect(collected.map((event) => Option.getOrUndefined(event.sessionId))).toEqual(
        range(kept).map((index) => (burst - kept + index) % 3 === 0 ? `child-${burst - kept + index}` : undefined)
      )
      expect(mock.listeners()).toBe(0)
    }
  }))

  it.effect("churns 512 subscriptions per stream with interruption at every stage, ending with no listeners", () => Effect.gen(function*() {
    const random = seeded(512)

    for (const name of ["onEvent", "onDetach"] as const) {
      const mock = baseApi()
      const service = make(mock.api)
      const event = mock[name]

      const emit = () => name === "onEvent"
        ? mock.onEvent.controls.emit({ tabId: 1 }, "Page.loadEventFired", {})
        : mock.onDetach.controls.emit({ tabId: 1 }, "target_closed")

      const stream: Stream.Stream<unknown, ChromeDebuggerError> = name === "onEvent" ? service.onEvent : service.onDetach
      // 0: interrupted before it may register; 1: after registering; 2: after its first event; 3: ends by itself.
      const stages = range(512).map((index) => index % 4)

      const subscriptions = yield* Effect.forEach(shuffle(range(512), random), (index) => Effect.gen(function*() {
        const received = yield* Deferred.make<void>()
        const stage = stages[index]!

        const consume = stage === 3
          ? Stream.runCollect(Stream.take(stream, 1))
          : Stream.runCollect(Stream.tap(stream, () => Deferred.succeed(received, undefined)))

        const fiber = yield* Effect.forkChild(consume)

        if (stage === 0) yield* Fiber.interrupt(fiber)

        return { stage, fiber, received }
      }))

      yield* event.waitForCount(384)
      const byStage = (stage: number) => subscriptions.filter((subscription) => subscription.stage === stage)
      yield* Effect.forEach(shuffle(byStage(1), random), ({ fiber }) => Fiber.interrupt(fiber))
      yield* event.waitForCount(256)
      expect(emit()).toEqual([])
      yield* Effect.forEach(byStage(2), ({ received }) => Deferred.await(received))

      for (const { fiber } of byStage(3)) expect((yield* Fiber.join(fiber))).toHaveLength(1)

      yield* Effect.forEach(shuffle(byStage(2), random), ({ fiber }) => Fiber.interrupt(fiber))

      for (const { fiber } of [...byStage(0), ...byStage(1), ...byStage(2)]) {
        expect(Exit.hasInterrupts(yield* Effect.exit(Fiber.join(fiber)))).toBe(true)
      }

      expect(event.controls.listenerCount).toBe(0)
    }
  }))

  it.effect("maps 2,048 concurrent calls with interleaved rejections and throws to the right typed errors", () => Effect.gen(function*() {
    const random = seeded(2048)
    const outcomes = range(2048).map(() => (["resolve", "reject", "throw"] as const)[Math.floor(random() * 3)]!)
    const delays = range(2048).map(() => Math.floor(random() * 4))
    const causes = range(2048).map((index) => new Error(`call ${index}`))
    let getTargetsCalls = 0
    const getTargetsCauses = new Set<Error>()

    /** Settles call `index` after a seeded number of microtask turns, or throws synchronously. */
    const settle = async <A>(index: number, value: A): Promise<A> => {
      const outcome = outcomes[index]!

      if (outcome === "throw") throw causes[index]!

      for (let turn = 0; turn < delays[index]!; turn++) await Promise.resolve()

      if (outcome === "reject") throw causes[index]!

      return value
    }

    const mock = baseApi()

    const api: ChromeDebuggerApi = {
      ...mock.api,
      // A synchronous throw must escape the call itself, not become a rejection.
      attach: (target) => outcomes[target.tabId!] === "throw" ? (() => { throw causes[target.tabId!]! })() : settle(target.tabId!, undefined),
      detach: (target) => outcomes[target.tabId!] === "throw" ? (() => { throw causes[target.tabId!]! })() : settle(target.tabId!, undefined),
      sendCommand: (target, method, params) => outcomes[target.tabId!] === "throw"
        ? (() => { throw causes[target.tabId!]! })()
        : settle(target.tabId!, { method, params }),
      getTargets: () => {
        const index = getTargetsCalls++
        const cause = causes[index]!

        if (outcomes[index] !== "resolve") getTargetsCauses.add(cause)

        if (outcomes[index] === "throw") throw cause

        return settle(index, [])
      }
    }

    const service = make(api)
    const operations = ["attach", "detach", "sendCommand", "getTargets"] as const

    const run: Record<typeof operations[number], (index: number, target: Debuggee) => Effect.Effect<unknown, ChromeDebuggerError>> = {
      attach: (_, target) => service.attach(target, "1.3"),
      detach: (_, target) => service.detach(target),
      sendCommand: (index, target) => index % 8 === 2
        ? service.sendCommand(target, "Runtime.evaluate", { expression: String(index) })
        : service.sendCommand(target, "Page.enable"),
      getTargets: () => service.getTargets
    }

    const results = yield* Effect.forEach(range(2048), (index) => {
      const operation = operations[index % 4]!
      const target = { tabId: index }

      const call = run[operation](index, target)

      return Effect.match(call, {
        onFailure: (error) => ({ index, operation, error: Option.some(error), value: Option.none<unknown>() }),
        onSuccess: (value) => ({ index, operation, error: Option.none<ChromeDebuggerError>(), value: Option.some(value) })
      })
    }, { concurrency: "unbounded" })

    const failedTargets: Array<unknown> = []

    for (const { index, operation, error, value } of results) {
      if (operation === "getTargets") {
        if (Option.isSome(error)) {
          expect(error.value).toBeInstanceOf(ChromeDebuggerError)
          expect(error.value.operation).toBe("getTargets")
          failedTargets.push(error.value.cause)
        }

        continue
      }

      if (outcomes[index] === "resolve") {
        expect(Option.isSome(value)).toBe(true)

        if (operation === "sendCommand") {
          expect(value).toEqual(Option.some(Option.some(index % 8 === 2
            ? { method: "Runtime.evaluate", params: { expression: String(index) } }
            : { method: "Page.enable", params: undefined })))
        }
      } else {
        expect(Option.getOrThrow(error)).toBeInstanceOf(ChromeDebuggerError)
        expect(Option.getOrThrow(error)).toMatchObject({ operation, cause: causes[index] })
      }
    }

    expect(getTargetsCalls).toBe(512)
    expect(new Set(failedTargets)).toEqual(getTargetsCauses)
    expect(failedTargets).toHaveLength(getTargetsCauses.size)
  }))

  it.effect("runs 1,024 concurrent session commands with interleaved failures on one attachment", () => Effect.gen(function*() {
    const random = seeded(1024)
    const outcomes = range(1024).map(() => (["resolve", "reject", "throw"] as const)[Math.floor(random() * 3)]!)
    const mock = baseApi()

    const api: ChromeDebuggerApi = {
      ...mock.api,
      sendCommand: (target, method, params?: CommandParams) => {
        const index = Number(method.slice("Command.".length))

        if (outcomes[index] === "throw") throw new Error(`throw ${index} ${target.sessionId ?? "root"}`)

        return outcomes[index] === "reject"
          ? Promise.reject(new Error(`reject ${index} ${target.sessionId ?? "root"}`))
          : Promise.resolve({ index, sessionId: target.sessionId, params })
      }
    }

    const results = yield* Effect.scoped(Effect.gen(function*() {
      const session = yield* make(api).session({ tabId: 1 }, "1.3")

      return yield* Effect.forEach(range(1024), (index) => Effect.result(index % 2 === 0
        ? session.sendCommand(`Command.${index}`)
        : session.sendCommand(`Command.${index}`, { index }, `child-${index}`)), { concurrency: "unbounded" })
    }))

    results.forEach((result, index) => {
      const sessionId = index % 2 === 0 ? "root" : `child-${index}`

      if (outcomes[index] === "resolve") {
        expect(Result.getOrThrow(result)).toEqual(
          Option.some({ index, sessionId: index % 2 === 0 ? undefined : `child-${index}`, params: index % 2 === 0 ? undefined : { index } })
        )
      } else {
        expect(Result.isFailure(result) && result.failure).toMatchObject({
          operation: "sendCommand", cause: new Error(`${outcomes[index]} ${index} ${sessionId}`)
        })
      }
    })
    expect(mock.listeners()).toBe(0)
  }))

  it.effect("churns 512 sessions, interrupting before, during and after attach, while consuming and during release", () => Effect.gen(function*() {
    const random = seeded(4242)
    const kinds = ["beforeAttach", "attachResolves", "attachRejects", "consuming", "chromeDetach", "releasing"] as const

    type Kind = typeof kinds[number]

    const plan: ReadonlyArray<Kind> = range(512).map(() => kinds[Math.floor(random() * kinds.length)]!)
    const attachGates = new Map<number, ReturnType<typeof gate<void>>>()
    const attachCalled = new Map<number, ReturnType<typeof gate<void>>>()
    const detachGates = new Map<number, ReturnType<typeof gate<void>>>()
    const detachCalled = new Map<number, ReturnType<typeof gate<void>>>()
    const attachCalls = new Map<number, number>()
    const detachCalls = new Map<number, number>()

    for (const [tabId, kind] of plan.entries()) {
      if (kind === "attachResolves" || kind === "attachRejects") {
        attachGates.set(tabId, gate())
        attachCalled.set(tabId, gate())
      }

      if (kind === "releasing") {
        detachGates.set(tabId, gate())
        detachCalled.set(tabId, gate())
      }
    }

    const mock = baseApi()

    const api: ChromeDebuggerApi = {
      ...mock.api,
      attach: async (target) => {
        const tabId = target.tabId!
        attachCalls.set(tabId, (attachCalls.get(tabId) ?? 0) + 1)
        attachCalled.get(tabId)?.resolve()
        await attachGates.get(tabId)?.promise
      },
      detach: async (target) => {
        const tabId = target.tabId!
        detachCalls.set(tabId, (detachCalls.get(tabId) ?? 0) + 1)
        detachCalled.get(tabId)?.resolve()
        await detachGates.get(tabId)?.promise
      }
    }

    const service = make(api)

    const sessions = yield* Effect.forEach(range(512), (tabId) => Effect.gen(function*() {
      const kind = plan[tabId]!
      const ready = yield* Deferred.make<void>()

      const fiber = yield* Effect.forkChild(Effect.scoped(Effect.gen(function*() {
        const session = yield* service.session({ tabId }, "1.3")
        yield* Deferred.succeed(ready, undefined)

        if (kind === "consuming") return yield* Effect.as(Stream.runDrain(session.events), [])

        if (kind === "chromeDetach") {
          const events = yield* Stream.runCollect(session.events)

          return [...methods(events), yield* session.detached]
        }

        if (kind === "releasing") return []

        return yield* Effect.never
      })))

      if (kind === "beforeAttach") yield* Fiber.interrupt(fiber)

      return { tabId, kind, fiber, ready }
    }))

    const ofKind = (kind: Kind) => sessions.filter((session) => session.kind === kind)

    // Interrupt while attach is pending, then let it settle in seeded order.
    const pending = shuffle([...ofKind("attachResolves"), ...ofKind("attachRejects")], random)
    yield* Effect.forEach(pending, ({ tabId }) => Effect.promise(() => attachCalled.get(tabId)!.promise))
    const interrupting = yield* Effect.forEach(pending, ({ fiber }) => Effect.forkChild(Fiber.interrupt(fiber)))

    for (const { tabId, kind } of pending) {
      expect(detachCalls.get(tabId)).toBeUndefined()

      if (kind === "attachResolves") attachGates.get(tabId)!.resolve()
      else attachGates.get(tabId)!.reject(new Error(`Another debugger is already attached to the tab with id: ${tabId}.`))
    }

    yield* Effect.forEach(interrupting, Fiber.join)

    // Every live session receives its own events; Chrome then ends some of them.
    const live = [...ofKind("consuming"), ...ofKind("chromeDetach"), ...ofKind("releasing")]
    yield* Effect.forEach(live, ({ ready }) => Deferred.await(ready))

    for (const { tabId } of shuffle(live, random)) mock.onEvent.controls.emit({ tabId }, `Event.${tabId}`)

    for (const { tabId } of ofKind("chromeDetach")) mock.onDetach.controls.emit({ tabId }, "target_closed")

    for (const { tabId, fiber } of ofKind("chromeDetach")) expect(yield* Fiber.join(fiber)).toEqual([`Event.${tabId}`, "target_closed"])

    yield* Effect.forEach(shuffle(ofKind("consuming"), random), ({ fiber }) => Fiber.interrupt(fiber))

    // Interrupting a session already releasing waits for its pending detach.
    yield* Effect.forEach(ofKind("releasing"), ({ tabId }) => Effect.promise(() => detachCalled.get(tabId)!.promise))
    const releasing = yield* Effect.forEach(ofKind("releasing"), ({ fiber }) => Effect.forkChild(Fiber.interrupt(fiber)))

    for (const { fiber } of ofKind("releasing")) expect(fiber.pollUnsafe()).toBeUndefined()

    for (const { tabId } of shuffle(ofKind("releasing"), random)) detachGates.get(tabId)!.resolve()

    yield* Effect.forEach(releasing, Fiber.join)

    for (const { tabId, kind } of sessions) {
      const attached = attachCalls.get(tabId) ?? 0
      const detached = detachCalls.get(tabId) ?? 0

      if (kind === "beforeAttach") expect(detached).toBe(attached)
      else expect(attached).toBe(1)

      if (kind === "attachResolves" || kind === "consuming" || kind === "releasing") expect(detached).toBe(1)

      if (kind === "attachRejects" || kind === "chromeDetach") expect(detached).toBe(0)
    }

    expect(new Set(plan)).toEqual(new Set(kinds))
    expect(mock.listeners()).toBe(0)
  }))

  it.effect("races Chrome's detach against 256 releases without leaking or logging", () => {
    const logged: Array<unknown> = []

    return Effect.gen(function*() {
    const random = seeded(256)
    const mock = baseApi()
    const detachGates = new Map<number, ReturnType<typeof gate<void>>>()
    const detachCalled = new Map<number, ReturnType<typeof gate<void>>>()

    for (const tabId of range(256)) {
      detachGates.set(tabId, gate())
      detachCalled.set(tabId, gate())
    }

    const api: ChromeDebuggerApi = {
      ...mock.api,
      detach: async (target) => {
        detachCalled.get(target.tabId!)!.resolve()
        await detachGates.get(target.tabId!)!.promise
      }
    }

    const scopes = yield* Effect.forEach(range(256), (tabId) => Effect.gen(function*() {
      const scope = yield* Scope.make()
      const session = yield* make(api).session({ tabId }, "1.3").pipe(Scope.provide(scope))
      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void))

      return { tabId, session, closing }
    }))

    yield* Effect.forEach(scopes, ({ tabId }) => Effect.promise(() => detachCalled.get(tabId)!.promise))

    // While each detach is pending, the tab closes: Chrome's event (when it arrives in time), then
    // detach's failure, in seeded order.
    const closedByChrome = new Set<number>()

    for (const { tabId } of shuffle(scopes, random)) {
      if (random() < 0.5) {
        closedByChrome.add(tabId)
        mock.onDetach.controls.emit({ tabId }, "target_closed")
      }

      detachGates.get(tabId)!.reject(new Error(`No tab with given id ${tabId}.`))
    }

    yield* Effect.forEach(scopes, ({ closing }) => Fiber.join(closing))
    expect(mock.listeners()).toBe(0)

    // A session Chrome ended has an ended stream; any other released session interrupts readers.
    for (const { tabId, session } of scopes) {
      const exit = yield* Effect.exit(Stream.runCollect(session.events))

      if (closedByChrome.has(tabId)) {
        expect(exit).toEqual(Exit.succeed([]))
        expect(yield* session.detached).toBe("target_closed")
      } else {
        expect(Exit.hasInterrupts(exit)).toBe(true)
      }
    }

    expect(closedByChrome.size).toBeGreaterThan(0)
    expect(closedByChrome.size).toBeLessThan(256)

    expect(logged).toEqual([])
  }).pipe(Effect.provide(Logger.layer([Logger.make((options) => { logged.push(options.message) })])))
  })

  it.effect("lets exactly one of 256 concurrent sessions attach to one target", () => Effect.gen(function*() {
    const { api, controls } = makeDebugger()
    controls.addTarget({ type: "page", id: "target-1", tabId: 1, attached: false, title: "One", url: "https://example.com/" })
    const winner = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()

    const results = yield* Effect.forEach(range(256), (index) => Effect.result(Effect.scoped(Effect.gen(function*() {
      const session = yield* make(api).session(index % 2 === 0 ? { tabId: 1 } : { targetId: "target-1" }, "1.3")
      yield* Deferred.succeed(winner, undefined)
      yield* Deferred.await(release)

      return session.target
    }))), { concurrency: "unbounded" }).pipe(
      Effect.forkChild
    )

    yield* Deferred.await(winner)
    expect(controls.isAttached({ tabId: 1 })).toBe(true)
    yield* Deferred.succeed(release, undefined)
    const settled = yield* Fiber.join(results)
    const successes = settled.filter(Result.isSuccess)
    expect(successes).toHaveLength(1)

    for (const result of settled) {
      if (Result.isFailure(result)) {
        expect(result.failure.operation).toBe("attach")
        expect(String(result.failure.cause)).toMatch(/Another debugger is already attached to the (tab|target) with id: (1|target-1)\./)
      }
    }

    expect(controls.isAttached({ tabId: 1 })).toBe(false)
    expect(controls.onEvent.listenerCount + controls.onDetach.listenerCount).toBe(0)
  }))

  it.effect("routes a 1,024-target fixture population's interleaved events and Chrome's detaches", () => Effect.gen(function*() {
    const random = seeded(1024)
    const { api, controls } = makeDebugger()

    const targets: Array<TargetInfo> = range(1024).map((tabId) => ({
      type: "page", id: `target-${tabId}`, tabId, attached: false, title: `Tab ${tabId}`, url: `https://example.com/${tabId}`
    }))

    for (const target of targets) controls.addTarget(target)

    const perTarget = 4
    const fateCycle = ["closed", "canceled", "released", "released"] as const
    const fates = range(1024).map((tabId) => fateCycle[tabId % 4]!)

    const reasons: Record<typeof fateCycle[number], Option.Option<DetachReason>> = {
      closed: Option.some("target_closed"),
      canceled: Option.some("canceled_by_user"),
      released: Option.none()
    }

    const ready = yield* Deferred.make<void>()
    const service = make(api)

    const fiber = yield* Effect.forkChild(Effect.forEach(range(1024), (tabId) => Effect.scoped(Effect.gen(function*() {
      const session = yield* service.session({ tabId }, "1.3")
      yield* session.sendCommand("Page.enable")

      if (controls.commands.length === 1024) yield* Deferred.succeed(ready, undefined)

      if (fates[tabId] === "released") {
        const events = yield* Stream.runCollect(Stream.take(session.events, perTarget))

        return { tabId, events, reason: Option.none<DetachReason>() }
      }

      const events = yield* Stream.runCollect(session.events)

      return { tabId, events, reason: Option.some(yield* session.detached) }
    })), { concurrency: "unbounded" }))

    yield* Deferred.await(ready)
    const emissions = shuffle(range(1024 * perTarget), random)
    const sent = new Map<number, number>()

    for (const emission of emissions) {
      const tabId = emission % 1024
      const sequence = sent.get(tabId) ?? 0
      sent.set(tabId, sequence + 1)
      controls.emit({ tabId }, `Event.${sequence}`, { sequence }, sequence % 2 === 0 ? undefined : `child-${tabId}`)
    }

    for (const tabId of shuffle(range(1024), random)) {
      if (fates[tabId] === "closed") controls.removeTarget(`target-${tabId}`)
      else if (fates[tabId] === "canceled") controls.cancel({ tabId })
    }

    const results = yield* Fiber.join(fiber)

    for (const { tabId, events, reason } of results) {
      expect(events).toEqual(range(perTarget).map((sequence) => ({
        method: `Event.${sequence}`,
        params: Option.some({ sequence }),
        sessionId: sequence % 2 === 0 ? Option.none() : Option.some(`child-${tabId}`)
      })))
      expect(reason).toEqual(reasons[fates[tabId]!])
      expect(controls.isAttached({ tabId })).toBe(false)
    }

    expect((yield* service.getTargets).filter((target) => target.attached)).toEqual([])
    expect(controls.onEvent.listenerCount + controls.onDetach.listenerCount).toBe(0)
  }))

  it.effect("fails 512 pending commands with a typed error when Chrome ends their attachments", () => Effect.gen(function*() {
    const { api, controls } = makeDebugger()
    const invoked = gate()
    let calls = 0

    for (const tabId of range(8)) {
      controls.addTarget({ type: "page", id: `target-${tabId}`, tabId, attached: false, title: "", url: "https://example.com/" })
    }

    controls.respond("Debugger.pause", () => {
      calls++

      if (calls === 512) invoked.resolve()

      return new Promise<object>(() => {})
    })

    const results = yield* Effect.scoped(Effect.gen(function*() {
      const sessions = yield* Effect.forEach(range(8), (tabId) => make(api).session({ tabId }, "1.3"))

      const commands = yield* Effect.forkChild(Effect.forEach(range(512), (index) =>
        Effect.flip(sessions[index % 8]!.sendCommand("Debugger.pause", undefined, index % 3 === 0 ? `child-${index}` : undefined)), { concurrency: "unbounded" }))

      yield* Effect.promise(() => invoked.promise)
      expect(controls.pendingCommands).toBe(512)

      for (const tabId of range(8)) {
        if (tabId % 2 === 0) controls.cancel({ tabId })
        else controls.removeTarget(`target-${tabId}`)
      }

      return yield* Fiber.join(commands)
    }))

    expect(results).toHaveLength(512)

    for (const error of results) expect(error).toMatchObject({ operation: "sendCommand", cause: new Error("Detached while handling command.") })

    expect(controls.pendingCommands).toBe(0)
    expect(controls.onEvent.listenerCount + controls.onDetach.listenerCount).toBe(0)
  }))

  it.effect("hands 4,096 session events across seeded runs of sequential consumers without losing one", () => Effect.gen(function*() {
    const random = seeded(4096)
    const mock = baseApi()
    const taken: Array<string> = []

    yield* Effect.scoped(Effect.gen(function*() {
      const session = yield* make(mock.api).session({ tabId: 1 }, "1.3", { capacity: burst })
      let emitted = 0

      while (emitted < burst) {
        const batch = Math.min(burst - emitted, Math.floor(random() * 24))

        for (let index = 0; index < batch; index++) mock.onEvent.controls.emit({ tabId: 1 }, `Event.${emitted + index}`)

        emitted += batch
        const available = emitted - taken.length

        // Each consumer stops after a seeded share of what is buffered; the next one continues.
        if (available > 0) taken.push(...methods(yield* Stream.runCollect(Stream.take(session.events, 1 + Math.floor(random() * available)))))
      }

      mock.onDetach.controls.emit({ tabId: 1 }, "target_closed")
      taken.push(...methods(yield* Stream.runCollect(session.events)))
    }))

    expect(taken).toEqual(range(burst).map((index) => `Event.${index}`))
    expect(mock.listeners()).toBe(0)
  }))

  it.effect("sends 256 commands before a release and refuses 256 after it starts, none reaching Chrome late", () => Effect.gen(function*() {
    const { api, controls } = makeDebugger()
    controls.addTarget({ type: "page", id: "target-1", tabId: 1, attached: false, title: "One", url: "https://example.com/" })
    const invoked = gate()
    let calls = 0

    controls.respond("Debugger.pause", () => {
      calls++

      if (calls === 256) invoked.resolve()

      return new Promise<object>(() => {})
    })

    const scope = yield* Scope.make()
    const session = yield* make(api).session({ tabId: 1 }, "1.3").pipe(Scope.provide(scope))
    const command = (index: number) => Effect.flip(session.sendCommand("Debugger.pause", { index }, index % 2 === 0 ? undefined : `child-${index}`))
    const before = yield* Effect.forkChild(Effect.forEach(range(256), command, { concurrency: "unbounded" }))
    yield* Effect.promise(() => invoked.promise)
    yield* Scope.close(scope, Exit.void)
    const after = yield* Effect.forEach(range(256), (index) => command(256 + index), { concurrency: "unbounded" })

    for (const error of yield* Fiber.join(before)) expect(error).toMatchObject({ operation: "sendCommand", cause: new Error("Detached while handling command.") })

    for (const error of after) expect(error).toMatchObject({ operation: "sendCommand", cause: new Error("Debugger is not attached to the tab with id: 1.") })

    expect(controls.commands.map((sent) => sent.params?.["index"])).toEqual(range(256))
    expect(controls.isAttached({ tabId: 1 })).toBe(false)
    expect(controls.onEvent.listenerCount + controls.onDetach.listenerCount).toBe(0)
  }))
})
