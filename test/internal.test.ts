// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Context, Effect, Fiber, Option, References, Schema, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { attempter, invoker, liveLayer } from "../src/internal/api.js"
import { observe, observeSome } from "../src/internal/event.js"
import { makeEvent } from "../src/ChromeTesting.js"

class TestError extends Schema.TaggedError<TestError>()("TestError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

class Probe extends Context.Service<Probe, { readonly ok: boolean }>()("test/Probe") {}

const toError = (operation: string, cause: unknown) => new TestError({ operation, cause })

describe("internal/event", () => {
  it.effect("keeps only selected events, and skipped events take no buffer slot", () => Effect.gen(function*() {
    const listeners = new Set<(value: number) => void>()

    // Emits a synchronous burst during registration, before the stream is pulled.
    const source = {
      addListener: (listener: (value: number) => void) => {
        listeners.add(listener)

        for (let value = 0; value < 8; value++) listener(value)
      },
      removeListener: (listener: (value: number) => void) => { listeners.delete(listener) }
    }

    const evens = observeSome(() => source, (value) => value % 2 === 0 ? Option.some(value) : Option.none(), (cause) => toError("on", cause), 2)

    expect(yield* Stream.runCollect(Stream.take(evens, 2))).toEqual([4, 6])
    expect(listeners.size).toBe(0)
  }))

  it.effect("types a failing event lookup or registration and leaves no listener behind", () => Effect.gen(function*() {
    const event = makeEvent<[value: number]>()
    const cause = new Error("no event")
    const lookup = yield* Effect.flip(Stream.runDrain(observe(() => { throw cause }, (value: number) => value, (error) => toError("lookup", error))))
    expect(lookup).toMatchObject({ operation: "lookup", cause })

    event.controls.failNext("addListener", cause)
    const registration = yield* Effect.flip(Stream.runDrain(observe(() => event.api, (value) => value, (error) => toError("add", error))))
    expect(registration).toMatchObject({ operation: "add", cause })
    expect(event.controls.listenerCount).toBe(0)
  }))
})

describe("internal/event interruption", () => {
  it.effect.each(Array.from({ length: 16 }, (_, turns) => turns))(
    "never leaves a listener behind when interrupted after %i scheduler turns", (turns) => Effect.gen(function*() {
      const log: Array<string> = []
      const listeners = new Set<(value: number) => void>()

      const source = {
        addListener: (listener: (value: number) => void) => {
          log.push("add")
          listeners.add(listener)
        },
        removeListener: (listener: (value: number) => void) => {
          log.push("remove")
          listeners.delete(listener)
        }
      }

      // A small yield budget suspends the registration fiber between its finalizer and addListener.
      const fiber = yield* Stream.runDrain(observe(() => source, (value: number) => value, (cause) => toError("on", cause))).pipe(
        Effect.provideService(References.MaxOpsBeforeYield, 16),
        Effect.forkChild
      )

      for (let turn = 0; turn < turns; turn++) yield* Effect.yieldNow

      yield* Fiber.interrupt(fiber)

      for (let turn = 0; turn < 100; turn++) yield* Effect.yieldNow

      // Never an add after the remove: an unmatched remove is a harmless no-op for Chrome.
      expect(listeners.size).toBe(0)
      expect(log.join(",")).toMatch(/^(|remove|add,remove)$/)
    })
  )
})

describe("internal/api", () => {
  it.effect("maps rejections and throws to the module's error with the operation name", () => Effect.gen(function*() {
    const cause = new Error("rejected")
    const invoke = invoker(toError)
    const attempt = attempter(toError)

    expect(yield* invoke("get", () => Promise.resolve(1))).toBe(1)
    expect(yield* Effect.flip(invoke("get", () => Promise.reject(cause)))).toMatchObject({ operation: "get", cause })
    expect(yield* Effect.flip(invoke("set", (): Promise<number> => { throw cause }))).toMatchObject({ operation: "set", cause })
    expect(yield* Effect.flip(attempt("id", (): number => { throw cause }))).toMatchObject({ operation: "id", cause })
  }))

  it.effect("builds live layers only when provided, failing without the Chrome namespace", () => Effect.gen(function*() {
    const layer = liveLayer(Probe, "runtime", (chrome) => chrome.runtime, () => Probe.of({ ok: true }), (cause) => toError("initialize", cause))
    const error = yield* Effect.flip(Probe.pipe(Effect.provide(layer)))
    expect(error).toMatchObject({ operation: "initialize" })
    expect(String(error.cause)).toContain("chrome.runtime is unavailable")
  }))
})
