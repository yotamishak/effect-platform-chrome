// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Deferred, Effect, Exit, Fiber, Layer, Schema, SchemaGetter } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChromeMessageError, decodeResponse, fail, Response, succeed } from "../../src/ChromeMessage.js"
import type { ErrorCode, WorkerError } from "../../src/ChromeMessage.js"
import { start } from "../../src/ChromeServiceWorker.js"
import type { ChromeEvent, MessageListener } from "../../src/ChromeServiceWorker.js"

// ChromeMessage has no Chrome calls or event streams: its extremes are concurrent decoding,
// interruption of asynchronous value schemas, large payloads and the replies a busy
// ChromeServiceWorker produces.

/** Deterministic mulberry32, so every run sees the same interleaving. */
const seeded = (seed: number) => {
  let state = seed >>> 0

  return (): number => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A reply after Chrome's JSON message serialization, which drops a key whose value is `undefined`. */
type Wire<A> = { readonly ok: true; readonly value?: A } | { readonly ok: false; readonly error: WorkerError }

const overTheWire = <A>(reply: Wire<A>): Wire<A> => JSON.parse(JSON.stringify(reply))

const codes: ReadonlyArray<ErrorCode> = ["InitializationFailed", "HandlerFailed", "Overflow", "Disposed"]

const malformed: ReadonlyArray<unknown> = [
  undefined, null, 0, "", [], {}, { ok: "true", value: "1" }, { ok: true, value: "x" }, { ok: true, value: 1 },
  { ok: false }, { ok: false, error: { code: "Other", message: "" } }, { ok: false, error: { code: "Overflow" } }
]

type Outcome =
  | { readonly kind: "value"; readonly value: number | undefined }
  | { readonly kind: "failure"; readonly code: ErrorCode; readonly message: string }
  | { readonly kind: "invalid" }

/** A fuzzed reply field: anything JSON delivers, or a key left out. */
type Wild = undefined | null | boolean | number | string | symbol | ReadonlyArray<number> | { readonly [key: string]: string | number }

/** A fuzzed reply object; each envelope key may be missing or of any kind. */
interface Fuzzed {
  ok?: Wild
  value?: Wild
  error?: Wild
}

interface Case {
  readonly reply: unknown
  readonly expected: Outcome
}

const Count = Schema.UndefinedOr(Schema.FiniteFromString)

const outcome = (decoded: Effect.Effect<number | undefined, ChromeMessageError | Schema.SchemaError>): Effect.Effect<Outcome> =>
  decoded.pipe(
    Effect.map((value): Outcome => ({ kind: "value", value })),
    Effect.catchTags({
      ChromeMessageError: (error) => Effect.succeed<Outcome>({ kind: "failure", code: error.code, message: error.message }),
      SchemaError: () => Effect.succeed<Outcome>({ kind: "invalid" })
    })
  )

describe("ChromeMessage stress", () => {
  it.effect("decodes 4,096 concurrent interleaved replies with one decoder, each to its own outcome", () => Effect.gen(function*() {
    const random = seeded(0xC0FFEE)
    const decode = decodeResponse(Count)

    const cases = Array.from({ length: 4096 }, (_, index): Case => {
      const roll = random()

      if (roll < 0.35) return { reply: overTheWire(succeed(String(index))), expected: { kind: "value", value: index } }

      if (roll < 0.5) return { reply: overTheWire(succeed(undefined)), expected: { kind: "value", value: undefined } }

      if (roll < 0.8) {
        const code = codes[Math.floor(random() * codes.length)]!

        return { reply: overTheWire(fail({ code, message: `failure ${index}` })), expected: { kind: "failure", code, message: `failure ${index}` } }
      }

      return { reply: malformed[Math.floor(random() * malformed.length)], expected: { kind: "invalid" } }
    })

    const outcomes = yield* Effect.forEach(cases, ({ reply }) => outcome(decode(reply)), { concurrency: "unbounded" })

    expect(outcomes).toStrictEqual(cases.map(({ expected }) => expected))
    expect(new Set(outcomes.map(({ kind }) => kind))).toStrictEqual(new Set(["value", "failure", "invalid"]))
  }))

  it.effect("fails every one of 1,024 concurrent failure envelopes with its own ChromeMessageError", () => Effect.gen(function*() {
    const decode = decodeResponse(Schema.Never)

    const errors = yield* Effect.forEach(
      Array.from({ length: 1024 }, (_, index) => index),
      (index) => Effect.flip(Effect.catchTag(decode(fail({ code: codes[index % codes.length]!, message: `#${index}` })), "SchemaError", Effect.die)),
      { concurrency: "unbounded" }
    )

    errors.forEach((error, index) => {
      expect(error).toBeInstanceOf(ChromeMessageError)
      expect({ code: error.code, message: error.message }).toStrictEqual({ code: codes[index % codes.length], message: `#${index}` })
    })
  }))

  it.effect("interrupts 1,024 asynchronous decodes at every stage and completes the rest", () => Effect.gen(function*() {
    const random = seeded(1024)
    const gate = yield* Deferred.make<void>()
    let entered = 0
    let finished = 0

    const Gated = Schema.String.pipe(Schema.decodeTo(Schema.Finite, {
      decode: SchemaGetter.transformEffect((text: string) => Effect.gen(function*() {
        entered += 1
        yield* Deferred.await(gate)
        finished += 1

        return Number(text)
      })),
      encode: SchemaGetter.transform((n: number) => String(n))
    }))

    const decode = decodeResponse(Gated)
    // Stage 0: interrupted before it starts; 1: while waiting on the gate; 2: never interrupted
    // before completing, then interrupted after.
    const stages = Array.from({ length: 1024 }, () => Math.floor(random() * 3))

    const fibers = yield* Effect.forEach(stages, (stage, index) => stage === 0
      ? Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(decode(succeed(String(index))), { startImmediately: false })

        yield* Fiber.interrupt(fiber)

        return fiber
      })
      : Effect.forkChild(decode(succeed(String(index))), { startImmediately: true }))

    expect(entered).toBe(stages.filter((stage) => stage !== 0).length)
    yield* Effect.forEach(fibers, (fiber, index) => stages[index] === 1 ? Fiber.interrupt(fiber) : Effect.void, { discard: true })
    yield* Deferred.succeed(gate, undefined)

    yield* Effect.forEach(fibers, (fiber) => Fiber.await(fiber), { discard: true })
    // Interrupting a completed decode changes nothing.
    yield* Effect.forEach(fibers, (fiber, index) => stages[index] === 2 ? Fiber.interrupt(fiber) : Effect.void, { discard: true })

    const exits = yield* Effect.forEach(fibers, (fiber) => Fiber.await(fiber))

    exits.forEach((exit, index) => {
      if (stages[index] === 2) expect(exit).toStrictEqual(Exit.succeed(index))
      else expect(Exit.hasInterrupts(exit)).toBe(true)
    })
    expect(finished).toBe(stages.filter((stage) => stage === 2).length)
    expect(new Set(stages)).toStrictEqual(new Set([0, 1, 2]))
  }))

  it.effect("agrees with decoding the whole Response envelope on 1,024 fuzzed replies", () => Effect.gen(function*() {
    const random = seeded(0xE7E10E)
    const pick = <A>(items: ReadonlyArray<A>): A => items[Math.floor(random() * items.length)]!

    const schemas = [
      Schema.FiniteFromString,
      Schema.UndefinedOr(Schema.FiniteFromString),
      Schema.Struct({ count: Schema.FiniteFromString }),
      Schema.NullOr(Schema.Finite),
      Schema.Unknown,
      Schema.Void
    ] as const

    const absent = Symbol("absent")
    const oks: ReadonlyArray<Wild> = [true, true, false, false, "true", 1, null, undefined, absent]
    const values: ReadonlyArray<Wild> = [absent, undefined, null, 0, 7, "7", "x", "", { count: "3" }, { count: 3 }, [1], {}]

    const errors: ReadonlyArray<Wild> = [
      absent, null, "boom", { code: "Overflow", message: "full" }, { code: "Disposed", message: "" },
      { code: "Other", message: "m" }, { code: "Overflow" }, { code: "HandlerFailed", message: "m", stack: "s" }
    ]

    const replies = Array.from({ length: 1024 }, (): Fuzzed | Wild => {
      if (random() < 0.05) return pick<Wild>([undefined, null, 0, "", [], true])

      const reply: Fuzzed = {}

      for (const [key, choices] of [["ok", oks], ["value", values], ["error", errors]] as const) {
        const choice = pick(choices)

        if (choice !== absent) reply[key] = choice
      }

      return reply
    })

    const summary = <A>(decoded: Effect.Effect<A, ChromeMessageError | Schema.SchemaError>) => decoded.pipe(
      Effect.map((value) => ({ kind: "value", value }) as const),
      Effect.catchTags({
        ChromeMessageError: (error) => Effect.succeed({ kind: "failure", code: error.code, message: error.message } as const),
        SchemaError: (error) => Effect.succeed({ kind: "invalid", message: error.message } as const)
      })
    )

    const direct = yield* Effect.forEach(replies, (reply, index) => summary(decodeResponse(schemas[index % schemas.length]!)(reply)))

    const whole = yield* Effect.forEach(replies, (reply, index) => summary(Effect.flatMap(
      Schema.decodeUnknownEffect(Response(schemas[index % schemas.length]!))(reply),
      (response) => response.ok ? Effect.succeed(response.value) : Effect.fail(new ChromeMessageError(response.error))
    )))

    expect(direct).toStrictEqual(whole)
    expect(new Set(direct.map(({ kind }) => kind))).toStrictEqual(new Set(["value", "failure", "invalid"]))
  }))

  it.effect("delivers 1,024 fail envelopes of every kind of WorkerError over JSON as the same code and message", () => Effect.gen(function*() {
    const random = seeded(0xFA11)

    class CodedError extends Error {
      constructor(readonly code: ErrorCode, message: string) {
        super(message)
      }
    }

    const senders: ReadonlyArray<(code: ErrorCode, message: string) => WorkerError> = [
      (code, message) => ({ code, message }),
      (code, message) => new CodedError(code, message),
      (code, message) => new ChromeMessageError({ code, message }),
      (code, message) => ({ code, message, stack: "s", cause: { nested: [1, 2] } })
    ]

    const decode = decodeResponse(Schema.Never)

    const sent = Array.from({ length: 1024 }, (_, index) => ({
      code: codes[Math.floor(random() * codes.length)]!,
      message: random() < 0.1 ? "" : `failure ${index} \u{1F600}`
    }))

    const received = yield* Effect.forEach(sent, ({ code, message }, index) => Effect.flip(Effect.catchTag(
      decode(overTheWire(fail(senders[index % senders.length]!(code, message)))),
      "SchemaError",
      Effect.die
    )))

    expect(received.map(({ code, message }) => ({ code, message }))).toStrictEqual(sent)
  }))

  it.effect("keeps 512 concurrently built decoders for different schemas apart", () => Effect.gen(function*() {
    const results = yield* Effect.forEach(Array.from({ length: 512 }, (_, index) => index), (index) => {
      const Exact = Schema.Literal(index)

      return Effect.all([
        decodeResponse(Exact)(succeed(index)),
        Effect.flip(decodeResponse(Exact)(succeed(index + 1)))
      ])
    }, { concurrency: "unbounded" })

    results.forEach(([value, error], index) => {
      expect(value).toBe(index)
      expect(error).toBeInstanceOf(Schema.SchemaError)
      expect(error.message).toContain('at ["value"]')
    })
  }))

  it.effect("round-trips large and deep values", () => Effect.gen(function*() {
    const text = "x".repeat(1_000_000)

    expect(yield* decodeResponse(Schema.String)(overTheWire(succeed(text)))).toHaveLength(1_000_000)

    const numbers = Array.from({ length: 65_536 }, (_, index) => index)

    expect(yield* decodeResponse(Schema.Array(Schema.Finite))(overTheWire(succeed(numbers)))).toStrictEqual(numbers)

    interface Node { readonly next: Node | null }

    const NodeSchema: Schema.Codec<Node> = Schema.Struct({ next: Schema.NullOr(Schema.suspend(() => NodeSchema)) })
    let deep: Node = { next: null }

    for (let depth = 1; depth < 512; depth++) deep = { next: deep }

    expect(yield* decodeResponse(NodeSchema)(overTheWire(succeed(deep)))).toStrictEqual(deep)

    // An invalid leaf deep inside a large value is still reported at its path.
    const broken = [...numbers.slice(0, 40_000), "x", ...numbers.slice(40_001)]
    const error = yield* Effect.flip(decodeResponse(Schema.Array(Schema.Finite))(overTheWire(succeed(broken))))

    expect(error.message).toContain('at ["value"][40000]')
  }))

  it.effect("encodes and decodes 4,096 envelopes with the Response schema in both directions", () => Effect.gen(function*() {
    const random = seeded(7)
    const schema = Response(Schema.FiniteFromString)

    const values = Array.from({ length: 4096 }, (_, index) => random() < 0.5
      ? succeed(index)
      : fail({ code: codes[index % codes.length]!, message: String(index) }))

    const encode = Schema.encodeEffect(schema)
    const decode = Schema.decodeUnknownEffect(schema)
    const encoded = yield* Effect.forEach(values, (value) => encode(value), { concurrency: "unbounded" })
    const decoded = yield* Effect.forEach(encoded, (reply) => decode(overTheWire(reply)), { concurrency: "unbounded" })

    expect(decoded).toStrictEqual(values)
  }))

  // The worker owns an independent ManagedRuntime; its replies arrive through native callbacks.
  it.effect("decodes a 4,096-message startup burst: the first 64 queued values, then Overflow", () => Effect.gen(function*() {
    const listeners = new Set<MessageListener>()

    const event: ChromeEvent<MessageListener> = {
      addListener: (listener) => { listeners.add(listener) },
      removeListener: (listener) => { listeners.delete(listener) }
    }

    let open!: () => void
    const initialized = new Promise<void>((resolve) => { open = resolve })

    const running = start({
      chrome: { runtime: { onMessage: event } },
      layer: Layer.empty,
      initialize: Effect.promise(() => initialized),
      selectMessage: () => true,
      onMessage: (message) => Effect.succeed(String(message)),
      onError: () => {}
    })

    expect(listeners.size).toBe(1)

    const replies = Array.from({ length: 4096 }, (_, index) => new Promise<Wire<unknown>>((resolve) => {
      for (const listener of listeners) listener(index, { id: "sender" }, (reply) => { resolve(overTheWire(reply)) })
    }))

    open()
    expect(Exit.isSuccess(yield* Effect.promise(() => running.ready))).toBe(true)

    const decode = decodeResponse(Schema.FiniteFromString)
    const outcomes = yield* Effect.forEach(replies, (reply) => Effect.flatMap(Effect.promise(() => reply), (wire) => outcome(decode(wire))))

    expect(outcomes.slice(0, 64)).toStrictEqual(Array.from({ length: 64 }, (_, index) => ({ kind: "value", value: index })))
    expect(outcomes.slice(64).every((result) => result.kind === "failure" && result.code === "Overflow")).toBe(true)

    yield* Effect.promise(running.dispose)
    expect(listeners.size).toBe(0)
  }))
})
