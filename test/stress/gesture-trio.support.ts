// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
// Fresh simulated Chrome events per run are the fixture here, not an Effect service.
/* oxlint-disable anti-slop-effect/no-service-constructor-imports */
import { Deferred, Effect, Exit, Fiber, Result, Stream } from "effect"
import { expect } from "@effect/vitest"
import type { EventSource } from "../../src/internal/event.js"
import { makeEvent } from "../../src/testing/Event.js"

/** The newest events a subscription keeps (`bufferSize` in src/internal/event.ts). */
export const retained = 64

/** A deterministic mulberry32 generator in [0, 1), replacing Math.random. */
export const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

/** A seeded Fisher-Yates shuffle of a copy. */
export const shuffled = <A>(random: () => number, items: ReadonlyArray<A>): Array<A> => {
  const copy = Array.from(items)

  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    const swap = copy[index]
    const swapped = copy[other]

    if (swap !== undefined && swapped !== undefined) {
      copy[index] = swapped
      copy[other] = swap
    }
  }

  return copy
}

export type Outcome = "resolve" | "reject" | "throw"

/** Runs a call to its success or typed failure; defects still fail the test. */
export const settle = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<Result.Result<A, E>> => Effect.result(effect)

/**
 * Native calls whose outcomes follow a seeded plan: call `index` resolves, rejects or throws
 * synchronously. Pending calls settle only when `release` runs, in a seeded shuffled order,
 * so many calls are in flight at once and finish interleaved. `started` completes once every
 * planned call has reached Chrome and is pending or thrown.
 */
export const plannedNative = (count: number, seed: number) => {
  const random = seeded(seed)
  const kinds: ReadonlyArray<Outcome> = ["resolve", "reject", "throw"]
  const plan: ReadonlyArray<Outcome> = Array.from({ length: count }, () => kinds[Math.floor(random() * 3)] ?? "resolve")
  const causes = Array.from({ length: count }, (_, index) => new Error(`native failure ${index}`))
  const pending: Array<{ readonly index: number, readonly resolve: () => void, readonly reject: (cause: Error) => void }> = []
  const started = Deferred.makeUnsafe<void>()
  let calls = 0

  // Counted only once the call is pending or about to throw, so `release` sees every call.
  const record = () => {
    calls++

    if (calls === count) Deferred.doneUnsafe(started, Exit.void)
  }

  /** The native call for `index`, resolving to `value` when the plan says so. */
  const native = <A>(index: number, value: A): Promise<A> => {
    const cause = causes[index]

    if (plan[index] === "throw") {
      record()

      throw cause
    }

    const promise = new Promise<A>((resolve, reject) => {
      pending.push({ index, resolve: () => resolve(value), reject })
    })

    record()

    return promise
  }

  /** A synchronous native call for `index`, which can only return or throw. */
  const nativeSync = (index: number): void => {
    record()

    if (plan[index] !== "resolve") throw causes[index]
  }

  const release = () => {
    for (const call of shuffled(random, pending.splice(0))) {
      if (plan[call.index] === "resolve") call.resolve()
      else call.reject(causes[call.index] ?? new Error("missing cause"))
    }
  }

  return { plan, causes, native, nativeSync, started: Deferred.await(started), release, get calls() { return calls } }
}

/** Checks one settled call against the plan: success, or the typed error with this cause. */
export const expectPlanned = <A, E extends { readonly operation: string, readonly cause: unknown }>(
  settled: Result.Result<A, E>,
  outcome: Outcome | undefined,
  options: { readonly operation: string, readonly cause: Error | undefined, readonly errorClass: abstract new (...args: never) => E }
): void => {
  if (outcome === "resolve" || outcome === undefined) {
    expect(Result.isSuccess(settled)).toBe(true)

    return
  }

  expect(Result.isFailure(settled)).toBe(true)

  if (Result.isFailure(settled)) {
    expect(settled.failure).toBeInstanceOf(options.errorClass)
    expect(settled.failure.operation).toBe(options.operation)
    expect(settled.failure.cause).toBe(options.cause)
  }
}

/**
 * Proves a burst of `count` synchronous events, emitted before the consumer pulls, leaves
 * exactly the newest `retained` events in order, and that the listener is gone afterwards.
 */
export const burstKeepsNewest = <Args extends ReadonlyArray<unknown>, A, B, E>(options: {
  readonly count: number
  readonly stream: (source: EventSource<Args>) => Stream.Stream<A, E>
  readonly args: (index: number) => Args
  readonly project: (value: A) => B
  readonly expected: (index: number) => B
}) => Effect.gen(function*() {
  const event = makeEvent<Args>()
  const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(options.stream(event.api), retained)))
  yield* Effect.promise(() => event.controls.waitForListener())

  for (let index = 0; index < options.count; index++) event.controls.emit(...options.args(index))

  const values = yield* Fiber.join(fiber)
  expect(values.map(options.project)).toEqual(
    Array.from({ length: retained }, (_, offset) => options.expected(options.count - retained + offset))
  )
  expect(event.controls.listenerCount).toBe(0)

  return values
})

export type Stage = "immediate" | "registered" | "consuming" | "completed" | "failure"

const stages: ReadonlyArray<Stage> = ["immediate", "registered", "consuming", "completed", "failure"]

/**
 * Runs `subscriptions` concurrent consumptions of one event, each stopped at a seeded stage:
 * interrupted right after forking, interrupted once registered (with 128 events buffered),
 * interrupted while its consumer is mid-element, completed after one element, or failed by a
 * registration that adds the listener and then throws. Ends with zero listeners and one
 * removal per addition, and every stage reached.
 */
export const churn = <Args extends ReadonlyArray<unknown>, A, E extends { readonly operation: string }>(options: {
  readonly subscriptions: number
  readonly seed: number
  readonly operation: string
  readonly stream: (source: EventSource<Args>) => Stream.Stream<A, E>
  readonly args: (index: number) => Args
  readonly check: (value: A, index: number) => void
}) => Effect.gen(function*() {
  const random = seeded(options.seed)
  const shared = makeEvent<Args>()
  const counts = { added: 0, removed: 0 }
  const reached: Record<Stage, number> = { immediate: 0, registered: 0, consuming: 0, completed: 0, failure: 0 }
  const cause = new Error("registration refused")

  const subscription = (index: number, stage: Stage) => Effect.gen(function*() {
    const registered = yield* Deferred.make<(...args: Args) => void>()

    const source: EventSource<Args> = {
      addListener: (listener) => {
        counts.added++
        shared.api.addListener(listener)
        Deferred.doneUnsafe(registered, Exit.succeed(listener))

        if (stage === "failure") throw cause
      },
      removeListener: (listener) => {
        counts.removed++
        shared.api.removeListener(listener)
      }
    }

    const stream = options.stream(source)

    switch (stage) {
      case "immediate": {
        const fiber = yield* Effect.forkChild(Stream.runDrain(stream))
        yield* Fiber.interrupt(fiber)

        break
      }

      case "registered": {
        const fiber = yield* Effect.forkChild(Stream.runDrain(Stream.mapEffect(stream, () => Effect.never)))
        const listener = yield* Deferred.await(registered)

        for (let event = 0; event < retained * 2; event++) listener(...options.args(index))

        yield* Fiber.interrupt(fiber)

        break
      }

      case "consuming": {
        const entered = yield* Deferred.make<void>()
        const fiber = yield* Effect.forkChild(Stream.runDrain(Stream.mapEffect(stream, () => Effect.andThen(Deferred.succeed(entered, undefined), Effect.never))))
        const listener = yield* Deferred.await(registered)
        listener(...options.args(index))
        listener(...options.args(index))
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(fiber)
        expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)

        break
      }

      case "completed": {
        const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(stream, 1)))
        const listener = yield* Deferred.await(registered)
        listener(...options.args(index))
        const [value] = yield* Fiber.join(fiber)
        expect(value).toBeDefined()

        if (value !== undefined) options.check(value, index)

        break
      }

      case "failure": {
        const error = yield* Effect.flip(Stream.runDrain(stream))
        expect(error.operation).toBe(options.operation)

        break
      }
    }

    reached[stage]++
  })

  const plan = Array.from({ length: options.subscriptions }, () => stages[Math.floor(random() * stages.length)] ?? "immediate")
  yield* Effect.forEach(plan, (stage, index) => subscription(index, stage), { concurrency: "unbounded", discard: true })
  expect(shared.controls.listenerCount).toBe(0)
  expect(counts.removed).toBe(counts.added)

  for (const stage of stages) expect(reached[stage]).toBeGreaterThan(0)

  return { reached, counts }
})
