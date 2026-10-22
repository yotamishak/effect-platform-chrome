// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Cause, Effect, Exit, Fiber, Scope, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChromeTabCaptureError, make } from "../../src/ChromeTabCapture.js"
import type { CaptureInfo, CaptureOptions, ChromeTabCaptureApi, MediaStreamOptions } from "../../src/ChromeTabCapture.js"
import { makeEvent } from "../../src/ChromeTesting.js"
import { asMediaStream, makeCaptureStream, makeTabCapture, tabCaptureErrors } from "../../src/testing/TabCapture.js"
import type { CaptureStream } from "../../src/testing/TabCapture.js"

/** mulberry32: a small deterministic generator, so every run exercises the same schedule. */
const seeded = (seed: number) => {
  let state = seed >>> 0

  const next = () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  return {
    int: (bound: number) => Math.floor(next() * bound),
    shuffle: <A>(items: ReadonlyArray<A>): Array<A> => {
      const copy = Array.from(items)

      for (let index = copy.length - 1; index > 0; index--) {
        const other = Math.floor(next() * (index + 1))
        const item = copy[index]
        const swap = copy[other]

        if (item === undefined || swap === undefined) continue

        copy[index] = swap
        copy[other] = item
      }

      return copy
    }
  }
}

/** The item at `index`, which the test guarantees exists. */
const at = <A>(items: ReadonlyArray<A>, index: number): A => {
  const item = items[index]

  if (item === undefined) throw new Error(`No item at ${index}`)

  return item
}

const info = (tabId: number): CaptureInfo => ({ tabId, status: "active", fullscreen: tabId % 2 === 0 })

/** A promise its creator settles, so a test decides when and how a Chrome call completes. */
const settleable = <A>() => {
  let resolve!: (value: A) => void
  let reject!: (cause: Error) => void

  const promise = new Promise<A>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })

  return { promise, resolve, reject }
}

/** Resolves once `ready()` holds, re-checked on every `wake`. */
const gate = () => {
  const waiting: Array<() => void> = []

  return {
    wake: () => { for (const check of waiting.splice(0)) check() },
    until: (ready: () => boolean) => Effect.promise(() => new Promise<void>((resolve) => {
      const check = () => {
        if (ready()) resolve()
        else waiting.push(check)
      }

      check()
    }))
  }
}

/** One shared Chrome event, counting registrations and waking waiters on each one. */
const countedEvent = () => {
  const event = makeEvent<[CaptureInfo]>()
  const added = gate()
  let adds = 0
  let removes = 0

  const source: ChromeTabCaptureApi["onStatusChanged"] = {
    addListener: (listener) => {
      event.api.addListener(listener)
      adds += 1
      added.wake()
    },
    removeListener: (listener) => {
      removes += 1
      event.api.removeListener(listener)
    }
  }

  return {
    event,
    source,
    get adds() { return adds },
    get removes() { return removes },
    /** Waits until at least `count` listeners are registered at once. */
    listening: (count: number) => added.until(() => event.controls.listenerCount >= count),
    /** Waits until `ready` holds, re-checked after every registration. */
    afterAdds: (ready: () => boolean) => added.until(ready)
  }
}

const baseApi = (onStatusChanged: ChromeTabCaptureApi["onStatusChanged"]): ChromeTabCaptureApi => ({
  getMediaStreamId: async () => "unused",
  getCapturedTabs: async () => [],
  onStatusChanged
})

describe("ChromeTabCapture stress: onStatusChanged", () => {
  it.effect("a 4,096-event burst keeps exactly the newest 64, in order, and removes the listener", () => Effect.gen(function*() {
    const events = countedEvent()
    const changes = make(baseApi(events.source)).onStatusChanged
    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(changes, 64)))
    yield* events.listening(1)

    for (let tabId = 0; tabId < 4096; tabId++) events.event.controls.emit(info(tabId))

    const delivered = yield* Fiber.join(fiber)
    expect(delivered.map((each) => each.tabId)).toEqual(Array.from({ length: 64 }, (_, index) => 4032 + index))
    expect(delivered.at(-1)).toEqual(info(4095))
    expect(events.event.controls.listenerCount).toBe(0)
    expect([events.adds, events.removes]).toEqual([1, 1])
  }))

  it.effect("sixteen concurrent consumers each keep their own newest 64 of a burst", () => Effect.gen(function*() {
    const events = countedEvent()
    const changes = make(baseApi(events.source)).onStatusChanged

    const fibers = yield* Effect.forEach(
      Array.from({ length: 16 }),
      () => Effect.forkChild(Stream.runCollect(Stream.take(changes, 64)))
    )

    yield* events.listening(16)

    for (let tabId = 0; tabId < 4096; tabId++) events.event.controls.emit(info(tabId))

    const expected = Array.from({ length: 64 }, (_, index) => 4032 + index)

    for (const fiber of fibers) expect((yield* Fiber.join(fiber)).map((each) => each.tabId)).toEqual(expected)

    expect(events.event.controls.listenerCount).toBe(0)
    expect([events.adds, events.removes]).toEqual([16, 16])
  }))

  it.effect("a consumer that already took events keeps the newest 64 of a later burst after them", () => Effect.gen(function*() {
    const events = countedEvent()
    const received = gate()
    let seen = 0

    const changes = make(baseApi(events.source)).onStatusChanged.pipe(
      Stream.tap(() => Effect.sync(() => {
        seen += 1
        received.wake()
      }))
    )

    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(changes, 3 + 64)))
    yield* events.listening(1)

    for (let tabId = 0; tabId < 3; tabId++) events.event.controls.emit(info(tabId))

    yield* received.until(() => seen === 3)

    for (let tabId = 100; tabId < 4196; tabId++) events.event.controls.emit(info(tabId))

    const delivered = (yield* Fiber.join(fiber)).map((each) => each.tabId)
    expect(delivered).toEqual([0, 1, 2, ...Array.from({ length: 64 }, (_, index) => 4132 + index)])
    expect(events.event.controls.listenerCount).toBe(0)
  }))

  it.effect("interrupting a consumer mid-burst removes its listener and drops what it buffered", () => Effect.gen(function*() {
    const events = countedEvent()
    const fiber = yield* Effect.forkChild(Stream.runDrain(make(baseApi(events.source)).onStatusChanged))
    yield* events.listening(1)

    for (let tabId = 0; tabId < 4096; tabId++) events.event.controls.emit(info(tabId))

    yield* Fiber.interrupt(fiber)
    expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
    expect(events.event.controls.listenerCount).toBe(0)
    expect(events.event.controls.emit(info(1))).toEqual([])
  }))

  it.effect("512 subscriptions churned with interruption at every stage end with zero listeners", () => Effect.gen(function*() {
    const random = seeded(0x7ab)
    const events = countedEvent()
    const stages = ["unstarted", "registered", "delivering", "failed", "partial", "completed"] as const

    type Stage = typeof stages[number]

    const delivered = gate()

    const subscriptions = Array.from({ length: 512 }, (_, index) => {
      const stage: Stage = stages[random.int(stages.length)] ?? "completed"
      const failure = new Error(`registration ${index} refused`)
      let registered = false
      let received = 0

      const source: ChromeTabCaptureApi["onStatusChanged"] = {
        addListener: (listener) => {
          if (stage === "failed") throw failure

          // Marked first: the shared source wakes waiters as soon as it registers.
          registered = true
          events.source.addListener(listener)

          // A registration that half succeeds: Chrome kept the listener, then threw.
          if (stage === "partial") throw failure
        },
        removeListener: (listener) => events.source.removeListener(listener)
      }

      const counted = make(baseApi(source)).onStatusChanged.pipe(Stream.tap(() => Effect.sync(() => {
        received += 1
        delivered.wake()
      })))

      const run = stage === "completed" ? Stream.runCollect(Stream.take(counted, 5)) : Stream.runCollect(counted)

      return {
        stage,
        failure,
        run,
        get registered() { return registered },
        get received() { return received }
      }
    })

    const fibers = yield* Effect.forEach(subscriptions, (subscription) => Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(subscription.run)

      if (subscription.stage === "unstarted") yield* Fiber.interrupt(fiber)

      return fiber
    }))

    const live = subscriptions.filter((subscription) => ["registered", "delivering", "completed"].includes(subscription.stage))
    yield* events.afterAdds(() => live.every((subscription) => subscription.registered))
    yield* Effect.forEach(subscriptions, (subscription, index) =>
      subscription.stage === "registered" ? Fiber.interrupt(at(fibers, index)) : Effect.void)

    for (let tabId = 0; tabId < 8; tabId++) events.event.controls.emit(info(tabId))

    yield* delivered.until(() => subscriptions.every((subscription) => subscription.stage !== "delivering" || subscription.received > 0))

    const exits = yield* Effect.forEach(subscriptions, (subscription, index) => {
      const fiber = at(fibers, index)

      return subscription.stage === "delivering"
        ? Effect.andThen(Fiber.interrupt(fiber), Fiber.await(fiber))
        : Fiber.await(fiber)
    })

    subscriptions.forEach((subscription, index) => {
      const exit = exits[index]

      switch (subscription.stage) {
        case "unstarted":
        case "registered":
        case "delivering":
          expect(exit !== undefined && Exit.hasInterrupts(exit)).toBe(true)
          break
        case "failed":
        case "partial": {
          const error = exit !== undefined && Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
          expect(error).toBeInstanceOf(ChromeTabCaptureError)
          expect(error).toMatchObject({ operation: "onStatusChanged", cause: subscription.failure })
          expect(subscription.registered).toBe(subscription.stage === "partial")
          break
        }

        case "completed":
          expect(exit !== undefined && Exit.isSuccess(exit) && exit.value.map((each) => each.tabId)).toEqual([0, 1, 2, 3, 4])
      }
    })

    expect(new Set(subscriptions.map((subscription) => subscription.stage)).size).toBe(stages.length)
    expect(events.event.controls.listenerCount).toBe(0)
    expect(events.removes).toBeGreaterThanOrEqual(events.adds)
  }))
})

describe("ChromeTabCapture stress: calls", () => {
  it.effect("1,536 concurrent calls settle in shuffled order, each with its own value or typed error", () => Effect.gen(function*() {
    const random = seeded(0xcafe)
    const outcomes = ["resolve", "reject", "throw"] as const
    const pending: Array<{ readonly index: number, readonly settle: () => void }> = []
    const invoked = gate()
    let calls = 0

    const plan = Array.from({ length: 1536 }, (_, index) => ({
      index,
      operation: index % 3 === 0 ? "getCapturedTabs" as const : "getMediaStreamId" as const,
      outcome: outcomes[random.int(outcomes.length)] ?? "resolve",
      cause: new Error(`call ${index} failed`)
    }))

    const call = (index: number) => {
      const step = at(plan, index)
      calls += 1
      invoked.wake()

      if (step.outcome === "throw") throw step.cause

      return step
    }

    let current = 0

    const api: ChromeTabCaptureApi = {
      getMediaStreamId: (options?: MediaStreamOptions) => {
        const step = call(options?.targetTabId ?? -1)
        const result = settleable<string>()
        pending.push({ index: step.index, settle: () => step.outcome === "reject" ? result.reject(step.cause) : result.resolve(`id-${step.index}`) })

        return result.promise
      },
      getCapturedTabs: () => {
        const step = call(current)
        const result = settleable<Array<CaptureInfo>>()
        pending.push({ index: step.index, settle: () => step.outcome === "reject" ? result.reject(step.cause) : result.resolve([info(step.index)]) })

        return result.promise
      },
      onStatusChanged: countedEvent().source
    }

    const capture = make(api)

    const run = (step: typeof plan[number]): Effect.Effect<string | Array<CaptureInfo>, ChromeTabCaptureError> =>
      step.operation === "getMediaStreamId"
        ? capture.getMediaStreamId({ targetTabId: step.index })
        : Effect.suspend(() => {
          current = step.index

          return capture.getCapturedTabs
        })

    const fibers = yield* Effect.forEach(plan, (step) => Effect.forkChild(Effect.exit(run(step))))
    yield* invoked.until(() => calls === plan.length)

    for (const each of random.shuffle(pending)) each.settle()

    const exits = yield* Effect.forEach(fibers, Fiber.join)

    plan.forEach((step, index) => {
      const exit = exits[index]

      if (step.outcome === "resolve") {
        expect(exit !== undefined && Exit.isSuccess(exit) && exit.value).toEqual(step.operation === "getMediaStreamId" ? `id-${index}` : [info(index)])
      } else {
        const error = exit !== undefined && Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        expect(error).toBeInstanceOf(ChromeTabCaptureError)
        expect(error).toMatchObject({ operation: step.operation, cause: step.cause })
      }
    })
    expect(pending).toHaveLength(plan.filter((step) => step.outcome !== "throw").length)
  }))

  it.effect("1,024 concurrent captures with every callback outcome, delivered out of order, leak no stream", () => Effect.gen(function*() {
    const random = seeded(0x51ce)
    const fates = ["deliver", "lastError", "streamAndLastError", "null", "throw", "repeat", "syncDeliver"] as const
    const callbacks = new Map<number, (stream: MediaStream | null) => void>()
    const invoked = gate()
    const streams: Array<CaptureStream> = []
    let lastError: chrome.runtime.LastError | undefined
    let calls = 0

    const plan = Array.from({ length: 1024 }, (_, index) => ({
      index,
      fate: fates[random.int(fates.length)] ?? "deliver",
      cause: new Error(`capture ${index} threw`),
      error: { message: `capture ${index} failed` }
    }))

    const streamFor = (id: string) => {
      const stream = makeCaptureStream(id, { audio: true, video: true })
      streams.push(stream)

      return asMediaStream(stream)
    }

    /** The stream a capture that succeeds must have taken. */
    const deliveredId = (fate: typeof fates[number], index: number): string => {
      switch (fate) {
        case "syncDeliver":
          return `sync-${index}`
        case "repeat":
          return `first-${index}`
        default:
          return `stream-${index}`
      }
    }

    /** The cause a capture that fails must carry. */
    const expectedCause = (step: typeof plan[number]) => {
      switch (step.fate) {
        case "throw":
          return step.cause
        case "null":
          return new Error("chrome.tabCapture.capture delivered no stream")
        default:
          return step.error
      }
    }

    const respond = (index: number, stream: MediaStream | null, error?: chrome.runtime.LastError) => {
      lastError = error

      try { callbacks.get(index)?.(stream) } finally { lastError = undefined }
    }

    const api: ChromeTabCaptureApi = {
      ...baseApi(countedEvent().source),
      capture: (options: CaptureOptions, callback) => {
        const index = options.videoConstraints?.mandatory === undefined ? -1 : Number(Object.keys(options.videoConstraints.mandatory)[0])
        const step = at(plan, index)
        calls += 1
        invoked.wake()

        if (step.fate === "throw") throw step.cause

        if (step.fate === "syncDeliver") return callback(streamFor(`sync-${index}`))

        callbacks.set(index, callback)
      },
      get lastError() { return lastError }
    }

    const capture = make(api)
    const scopes = yield* Effect.forEach(plan, () => Scope.make())

    const fibers = yield* Effect.forEach(plan, (step, index) => Effect.forkChild(Effect.exit(Scope.provide(
      capture.capture({ video: true, videoConstraints: { mandatory: { [step.index]: true } } }),
      at(scopes, index)
    ))))

    yield* invoked.until(() => calls === plan.length)

    for (const step of random.shuffle(plan)) {
      switch (step.fate) {
        case "deliver":
          respond(step.index, streamFor(`stream-${step.index}`))
          break
        case "lastError":
          respond(step.index, null, step.error)
          break
        case "streamAndLastError":
          respond(step.index, streamFor(`errored-${step.index}`), step.error)
          break
        case "null":
          respond(step.index, null)
          break
        case "repeat":
          respond(step.index, streamFor(`first-${step.index}`))
          respond(step.index, streamFor(`second-${step.index}`))
          respond(step.index, null, step.error)
          break
        case "throw":
        case "syncDeliver":
          break
      }
    }

    const exits = yield* Effect.forEach(fibers, Fiber.join)
    const live = new Set<string>()

    plan.forEach((step, index) => {
      const exit = exits[index]

      if (exit === undefined) throw new Error(`capture ${index} did not finish`)

      if (Exit.isSuccess(exit)) {
        live.add(exit.value.id)
        expect(exit.value.id).toBe(deliveredId(step.fate, index))

        return
      }

      const error = Cause.squash(exit.cause)
      expect(error).toBeInstanceOf(ChromeTabCaptureError)
      expect(error).toMatchObject({ operation: "capture", cause: expectedCause(step) })
    })

    expect(streams.flatMap((stream) => stream.active ? [stream.id] : []).sort()).toEqual(Array.from(live).sort())
    yield* Effect.forEach(scopes, (scope) => Scope.close(scope, Exit.void))
    expect(streams.filter((stream) => stream.active)).toEqual([])
    expect(new Set(plan.map((step) => step.fate)).size).toBe(fates.length)
  }))

  it.effect("1,024 captures interrupted or orphaned mid-acquire stop every late stream at once", () => Effect.gen(function*() {
    const random = seeded(0xdead)
    const fates = ["interruptThenDeliver", "deliverThenInterrupt", "closeThenDeliver", "deliverThenClose", "interruptThenFail"] as const
    const callbacks: Array<(stream: MediaStream | null) => void> = []
    const invoked = gate()

    const api: ChromeTabCaptureApi = {
      ...baseApi(countedEvent().source),
      capture: (_options, callback) => {
        callbacks.push(callback)
        invoked.wake()
      }
    }

    const capture = make(api)
    const plan = Array.from({ length: 1024 }, (_, index) => ({ index, fate: fates[random.int(fates.length)] ?? "interruptThenDeliver" }))
    const scopes = yield* Effect.forEach(plan, () => Scope.make())

    // One capture at a time, so each callback slot is known to belong to its plan step.
    const fibers: Array<Fiber.Fiber<MediaStream, ChromeTabCaptureError>> = []

    for (const step of plan) {
      fibers.push(yield* Effect.forkChild(Scope.provide(capture.capture({ video: true }), at(scopes, step.index))))
      yield* invoked.until(() => callbacks.length > step.index)
    }

    const streams = plan.map((step) => makeCaptureStream(`stream-${step.index}`, { video: true }))
    const delivering = plan.filter((step) => step.fate !== "interruptThenFail")

    for (const step of random.shuffle(plan)) {
      const fiber = at(fibers, step.index)
      const scope = at(scopes, step.index)
      const callback = at(callbacks, step.index)
      const stream = asMediaStream(at(streams, step.index))

      switch (step.fate) {
        case "interruptThenDeliver":
          yield* Fiber.interrupt(fiber)
          callback(stream)
          break
        case "deliverThenInterrupt":
          callback(stream)
          yield* Fiber.interrupt(fiber)
          break
        case "closeThenDeliver":
          yield* Scope.close(scope, Exit.void)
          callback(stream)
          break
        case "deliverThenClose":
          callback(stream)
          yield* Scope.close(scope, Exit.void)
          break
        case "interruptThenFail":
          yield* Fiber.interrupt(fiber)
          callback(null)
      }
    }

    const exits = yield* Effect.forEach(fibers, Fiber.await)

    plan.forEach((step) => {
      const exit = at(exits, step.index)
      const stream = at(streams, step.index)

      switch (step.fate) {
        case "interruptThenDeliver":
        case "interruptThenFail":
          expect(Exit.hasInterrupts(exit)).toBe(true)
          // A late stream stops at once, though its scope is still open.
          expect(stream.active).toBe(step.fate === "interruptThenFail")
          break
        case "deliverThenInterrupt":
          // The fiber had already taken the stream, so its scope still owns it.
          expect(Exit.isSuccess(exit)).toBe(true)
          expect(stream.active).toBe(true)
          break
        case "closeThenDeliver":
          expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
            operation: "capture", cause: new Error("The capture's scope closed before Chrome delivered the stream")
          })
          expect(stream.active).toBe(false)
          break
        case "deliverThenClose":
          expect(Exit.isSuccess(exit)).toBe(true)
          expect(stream.active).toBe(false)
      }
    })

    yield* Effect.forEach(scopes, (scope) => Scope.close(scope, Exit.void))
    expect(delivering.filter((step) => at(streams, step.index).active)).toEqual([])
    expect(new Set(plan.map((step) => step.fate)).size).toBe(fates.length)
  }))

  it.effect("closing one scope shared by 512 captures stops the delivered streams and orphans the rest", () => Effect.gen(function*() {
    const callbacks: Array<(stream: MediaStream | null) => void> = []
    const invoked = gate()

    const api: ChromeTabCaptureApi = {
      ...baseApi(countedEvent().source),
      capture: (_options, callback) => {
        callbacks.push(callback)
        invoked.wake()
      }
    }

    const capture = make(api)
    const scope = yield* Scope.make()
    const fibers = yield* Effect.forEach(Array.from({ length: 512 }), () => Effect.forkChild(Scope.provide(capture.capture({ audio: true }), scope)))
    yield* invoked.until(() => callbacks.length === 512)
    const streams = callbacks.map((_, index) => makeCaptureStream(`shared-${index}`, { audio: true }))
    callbacks.forEach((callback, index) => { if (index % 2 === 0) callback(asMediaStream(at(streams, index))) })
    const firstHalf = yield* Effect.forEach(fibers.filter((_, index) => index % 2 === 0), Fiber.join)
    expect(firstHalf).toHaveLength(256)
    const delivered = streams.filter((_, index) => index % 2 === 0)
    expect(delivered.every((stream) => stream.active)).toBe(true)
    yield* Scope.close(scope, Exit.void)
    expect(delivered.filter((stream) => stream.active)).toEqual([])
    callbacks.forEach((callback, index) => { if (index % 2 === 1) callback(asMediaStream(at(streams, index))) })
    expect(streams.filter((stream) => stream.active)).toEqual([])
    const orphans = yield* Effect.forEach(fibers.filter((_, index) => index % 2 === 1), (fiber) => Effect.flip(Fiber.join(fiber)))
    expect(orphans.every((error) => error.operation === "capture")).toBe(true)
  }))
})

describe("ChromeTabCapture stress: fixture", () => {
  it.effect("4,096 tabs captured concurrently are listed in order, and their status burst keeps the newest 64", () => Effect.gen(function*() {
    const fake = makeTabCapture()
    const capture = make(fake.api)
    const tabIds = Array.from({ length: 4096 }, (_, index) => index + 2)

    for (const tabId of tabIds) {
      fake.controls.openTab(tabId)
      fake.controls.invoke(tabId)
    }

    const ids = yield* Effect.forEach(tabIds, (tabId) => capture.getMediaStreamId({ targetTabId: tabId }), { concurrency: "unbounded" })
    expect(new Set(ids).size).toBe(4096)
    const captured = yield* capture.getCapturedTabs
    expect(captured.map((each) => each.tabId)).toEqual(tabIds)
    expect(captured.every((each) => each.status === "pending")).toBe(true)
    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(capture.onStatusChanged, 64)))
    yield* Effect.promise(() => fake.controls.onStatusChanged.waitForListener())
    const streams = ids.map((id) => fake.controls.redeem(id))
    const burst = yield* Fiber.join(fiber)
    expect(burst.map((each) => each.tabId)).toEqual(tabIds.slice(-64))
    expect(burst.every((each) => each.status === "active")).toBe(true)
    expect(fake.controls.onStatusChanged.listenerCount).toBe(0)

    for (const stream of streams) for (const track of stream.getTracks()) track.stop()

    expect(yield* capture.getCapturedTabs).toEqual([])
  }))

  it.effect("1,024 concurrent stream-id requests for one tab let exactly one through", () => Effect.gen(function*() {
    const fake = makeTabCapture()
    const capture = make(fake.api)
    fake.controls.invoke()
    const exits = yield* Effect.forEach(Array.from({ length: 1024 }), () => Effect.exit(capture.getMediaStreamId()), { concurrency: "unbounded" })
    const successes = exits.filter(Exit.isSuccess)
    expect(successes).toHaveLength(1)
    const failures = exits.filter(Exit.isFailure).map((exit) => Cause.squash(exit.cause))
    expect(failures).toHaveLength(1023)

    for (const failure of failures) {
      expect(failure).toBeInstanceOf(ChromeTabCaptureError)
      expect(failure).toMatchObject({ operation: "getMediaStreamId", cause: new Error(tabCaptureErrors.sameTab) })
    }

    expect(fake.controls.captures()).toHaveLength(1)
  }))

  it.effect("1,024 concurrent captures of the active tab: one wins, the rest fail, and the tab frees on release", () => Effect.gen(function*() {
    const fake = makeTabCapture()
    const capture = make(fake.api)
    fake.controls.invoke()
    const scope = yield* Scope.make()

    const exits = yield* Effect.forEach(
      Array.from({ length: 1024 }),
      () => Effect.exit(Scope.provide(capture.capture({ video: true, audio: true }), scope)),
      { concurrency: "unbounded" }
    )

    const winners = exits.filter(Exit.isSuccess)
    expect(winners).toHaveLength(1)
    const failures = exits.filter(Exit.isFailure).map((exit) => Cause.squash(exit.cause))
    expect(failures).toHaveLength(1023)

    for (const failure of failures) {
      expect(failure).toBeInstanceOf(ChromeTabCaptureError)
      expect(failure).toMatchObject({ operation: "capture", cause: { message: tabCaptureErrors.sameTab } })
    }

    expect(fake.controls.captures()).toEqual([{ tabId: 1, status: "active", fullscreen: false }])
    yield* Scope.close(scope, Exit.void)
    expect(winners[0]?.value.active).toBe(false)
    expect(fake.controls.captures()).toEqual([])
    const again = yield* Effect.scoped(Effect.map(capture.capture({ video: true }), (stream) => stream.active))
    expect(again).toBe(true)
  }))
})
