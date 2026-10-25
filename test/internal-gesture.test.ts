// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Deferred, Effect, Exit, Fiber, Schema } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { starter } from "../src/internal/gesture.js"

class TestError extends Schema.TaggedError<TestError>()("TestError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

const start = starter((operation, cause) => new TestError({ operation, cause }))

describe("internal/gesture", () => {
  it.effect("calls Chrome before returning and replays the one outcome to every run", () => Effect.gen(function*() {
    const run = vi.fn(async () => 7)
    const outcome = start("request", run)
    expect(run).toHaveBeenCalledOnce()
    expect(yield* outcome).toBe(7)
    expect(yield* outcome).toBe(7)
    expect(run).toHaveBeenCalledOnce()
  }))

  it.effect("attaches both settlement handlers synchronously, before the Effect runs", () => Effect.gen(function*() {
    const pending = Promise.resolve(3)
    const then = vi.spyOn(pending, "then")
    const outcome = start("request", () => pending)
    expect(then).toHaveBeenCalledOnce()
    expect(then.mock.calls[0]?.[0]).toBeTypeOf("function")
    expect(then.mock.calls[0]?.[1]).toBeTypeOf("function")
    expect(yield* outcome).toBe(3)
  }))

  it.effect("types a rejection, a synchronous throw, and a non-Promise result without retrying", () => Effect.gen(function*() {
    const cause = new Error("needs a user gesture")
    const rejecting = vi.fn(() => Promise.reject(cause))
    const throwing = vi.fn((): Promise<number> => { throw cause })
    // SAFETY: models a callback-only Chrome build that returns undefined where a Promise is declared.
    const bare = vi.fn((): Promise<number> => undefined as never)

    for (const [run, expected] of [[rejecting, cause], [throwing, cause]] as const) {
      const outcome = start("open", run)

      for (let round = 0; round < 3; round++) {
        const error = yield* Effect.flip(outcome)
        expect(error).toBeInstanceOf(TestError)
        expect(error).toMatchObject({ operation: "open", cause: expected })
      }

      expect(run).toHaveBeenCalledOnce()
    }

    const error = yield* Effect.flip(start("open", bare))
    expect(error.operation).toBe("open")
    expect(error.cause).toBeInstanceOf(TypeError)
    expect(bare).toHaveBeenCalledOnce()
  }))

  it.effect("keeps a rejection handled when the outcome is never run", () => Effect.gen(function*() {
    const settled = yield* Deferred.make<void>()
    const cause = new Error("dismissed")

    // A never-observed rejection would surface as an unhandled rejection and fail the run.
    const unobserved = [start("request", () => Promise.reject(cause).finally(() => Deferred.doneUnsafe(settled, Exit.void)))]
    yield* Deferred.await(settled)
    expect(unobserved).toHaveLength(1)
  }))

  it.effect("stops waiting on interruption, and a later run still sees the late outcome", () => Effect.gen(function*() {
    let resolve!: (value: string) => void
    const run = vi.fn(() => new Promise<string>((done) => { resolve = done }))
    const outcome = start("acceptDanger", run)
    const waiting = yield* Effect.forkChild(outcome)
    yield* Effect.yieldNow
    yield* Fiber.interrupt(waiting)
    expect((yield* Fiber.await(waiting))._tag).toBe("Failure")
    resolve("late")
    expect(yield* outcome).toBe("late")
    expect(run).toHaveBeenCalledOnce()
  }))
})
