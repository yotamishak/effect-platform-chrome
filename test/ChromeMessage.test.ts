// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Context, Deferred, Effect, Exit, Fiber, Layer, Schema, SchemaGetter } from "effect"
import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import {
  ChromeMessageError,
  decodeResponse,
  ErrorCode,
  fail,
  Response,
  succeed,
  WorkerError
} from "../src/ChromeMessage.js"
import type { Decoded, ResponseSchema } from "../src/ChromeMessage.js"
import { start } from "../src/ChromeServiceWorker.js"
import type { ChromeEvent, MessageListener } from "../src/ChromeServiceWorker.js"

const Value = Schema.Struct({ count: Schema.FiniteFromString })

const codes: ReadonlyArray<ErrorCode> = ["InitializationFailed", "HandlerFailed", "Overflow", "Disposed"]

/** A reply after Chrome's JSON message serialization, which drops a key whose value is `undefined`. */
type Wire<A> = { readonly ok: true; readonly value?: A } | { readonly ok: false; readonly error: WorkerError }

/** What Chrome delivers: the envelope after a JSON round trip. */
const overTheWire = <A>(reply: Wire<A>): Wire<A> => JSON.parse(JSON.stringify(reply))

type Decoding<A, R> = Effect.Effect<A, ChromeMessageError | Schema.SchemaError, R>

/** A reply the test rewrites between runs of one decode. */
interface MutableReply {
  ok: boolean
  value?: unknown
  error?: unknown
}

/** A decode that must fail: a success becomes a defect, so only the error channel remains. */
const failureOf = <A, E, R>(decoded: Effect.Effect<A, E, R>) => Effect.flip(Effect.andThen(decoded, Effect.die("decoded unexpectedly")))

/** The ChromeMessageError a decode fails with; any other outcome fails the test. */
const messageFailure = <A, R>(decoded: Decoding<A, R>) => failureOf(Effect.catchTag(decoded, "SchemaError", Effect.die))

/** The SchemaError a decode fails with; any other outcome fails the test. */
const schemaFailure = <A, R>(decoded: Decoding<A, R>) => failureOf(Effect.catchTag(decoded, "ChromeMessageError", Effect.die))

describe("ChromeMessage", () => {
  it("imports without chrome globals", async () => {
    expect(globalThis.chrome).toBeUndefined()
    expect((await import("../src/ChromeMessage.js")).decodeResponse).toBeTypeOf("function")
  })

  describe("succeed / fail", () => {
    it("builds exactly the two envelope shapes", () => {
      expect(succeed({ count: "3" })).toStrictEqual({ ok: true, value: { count: "3" } })
      expect(succeed(undefined)).toStrictEqual({ ok: true, value: undefined })
      expect(fail({ code: "Overflow", message: "full" })).toStrictEqual({ ok: false, error: { code: "Overflow", message: "full" } })
      expectTypeOf(succeed(1)).toEqualTypeOf<Response<number>>()
      expectTypeOf(fail({ code: "Disposed", message: "" })).toEqualTypeOf<Response<never>>()
    })

    it("defines exactly the four codes ChromeServiceWorker reports", () => {
      expect(ErrorCode.literals).toStrictEqual(codes)
    })

    it.effect("fails with an Error that is a WorkerError, whose message JSON would drop", () => Effect.gen(function*() {
      class HandlerFailure extends Error {
        readonly code = "HandlerFailed" as const
      }

      const failure = new HandlerFailure("boom")

      // An Error's own message is not enumerable, so JSON would send it as { code } alone.
      expect(JSON.parse(JSON.stringify(failure))).toStrictEqual({ code: "HandlerFailed" })

      const error = yield* messageFailure(decodeResponse(Value)(overTheWire(fail(failure))))

      expect({ code: error.code, message: error.message }).toStrictEqual({ code: "HandlerFailed", message: "boom" })
      expect(fail(failure)).toStrictEqual({ ok: false, error: { code: "HandlerFailed", message: "boom" } })
    }))

    it.effect("relays a received ChromeMessageError as exactly the envelope it came from", () => Effect.gen(function*() {
      const received = yield* messageFailure(decodeResponse(Value)(fail({ code: "Overflow", message: "full" })))

      expect(fail(received)).toStrictEqual({ ok: false, error: { code: "Overflow", message: "full" } })
      expect(overTheWire(fail(received))).toStrictEqual({ ok: false, error: { code: "Overflow", message: "full" } })
    }))

    it("sends no WorkerError key beyond code and message, so extra context cannot break serialization", () => {
      interface Cyclic { self?: Cyclic }

      const cyclic: Cyclic = {}

      cyclic.self = cyclic

      const error = { code: "HandlerFailed" as const, message: "m", context: cyclic }

      expect(overTheWire(fail(error))).toStrictEqual({ ok: false, error: { code: "HandlerFailed", message: "m" } })
    })
  })

  describe("decodeResponse", () => {
    it.effect("decodes the value of a success envelope with the value schema", () => Effect.gen(function*() {
      const decoded = decodeResponse(Value)(succeed({ count: "3" }))

      expectTypeOf(decoded).toEqualTypeOf<Decoded<typeof Value>>()
      expect(yield* decoded).toStrictEqual({ count: 3 })
    }))

    it.effect.each(codes)("fails with ChromeMessageError on a %s failure envelope", (code) => Effect.gen(function*() {
      const error = yield* messageFailure(decodeResponse(Value)(fail({ code, message: `${code} happened` })))

      expect(error).toBeInstanceOf(ChromeMessageError)
      expect(error).toBeInstanceOf(Error)
      expect(error._tag).toBe("ChromeMessageError")
      expect(error.code).toBe(code)
      expect(error.message).toBe(`${code} happened`)
    }))

    it.effect("fails with a ChromeMessageError that catchTag recovers", () => Effect.gen(function*() {
      const recovered = yield* decodeResponse(Value)(fail({ code: "HandlerFailed", message: "boom" })).pipe(
        Effect.catchTag("ChromeMessageError", (error) => Effect.succeed(`recovered ${error.code}`))
      )

      expect(recovered).toBe("recovered HandlerFailed")
    }))

    it.effect("never decodes the value of a failure envelope", () => Effect.gen(function*() {
      const error = yield* messageFailure(decodeResponse(Schema.Never)({ ok: false, error: { code: "Disposed", message: "gone" }, value: 1 }))

      expect(error).toBeInstanceOf(ChromeMessageError)
    }))

    it.effect.each([
      ["undefined, when every receiver left the message unanswered", undefined],
      ["null, what Chrome sends for a bare sendResponse()", null],
      ["a bare value", { count: "3" }],
      ["a number", 1],
      ["a string", "ok"],
      ["a boolean", true],
      ["an array", [true, { count: "3" }]],
      ["an empty object", {}],
      ["a value without ok", { value: { count: "3" } }],
      ["a string ok", { ok: "true", value: { count: "3" } }],
      ["a numeric ok", { ok: 1, value: { count: "3" } }],
      ["an invalid value", { ok: true, value: { count: "x" } }],
      ["a null value for a struct schema", { ok: true, value: null }],
      ["a failure without error", { ok: false }],
      ["a null error", { ok: false, error: null }],
      ["a string error", { ok: false, error: "boom" }],
      ["an unknown code", { ok: false, error: { code: "Other", message: "" } }],
      ["a lower-case code", { ok: false, error: { code: "overflow", message: "" } }],
      ["a missing message", { ok: false, error: { code: "Overflow" } }],
      ["a non-string message", { ok: false, error: { code: "Overflow", message: 1 } }]
    ])("fails with SchemaError on %s", ([, reply]) => Effect.gen(function*() {
      expect(yield* schemaFailure(decodeResponse(Value)(reply))).toBeInstanceOf(Schema.SchemaError)
    }))

    it.effect("reports an invalid value at its path inside the reply", () => Effect.gen(function*() {
      const error = yield* schemaFailure(decodeResponse(Value)({ ok: true, value: { count: "x" } }))

      expect(error.message).toContain('at ["value"]["count"]')
    }))

    it.effect("reports a missing required value at the value key", () => Effect.gen(function*() {
      const error = yield* schemaFailure(decodeResponse(Value)({ ok: true }))

      expect(error.message).toContain('at ["value"]')
    }))

    it.effect("reports an invalid failure envelope at its path inside the reply", () => Effect.gen(function*() {
      const error = yield* schemaFailure(decodeResponse(Value)({ ok: false, error: { code: "Other", message: "" } }))

      expect(error.message).toContain('["error"]["code"]')
    }))

    it.effect("ignores keys the envelope does not define", () => Effect.gen(function*() {
      expect(yield* decodeResponse(Value)({ ok: true, value: { count: "1", extra: 1 }, error: "ignored" })).toStrictEqual({ count: 1 })

      const error = yield* messageFailure(decodeResponse(Value)({
        ok: false, error: { code: "Overflow", message: "full", stack: "ignored" }, value: { count: "1" }
      }))

      expect({ code: error.code, message: error.message }).toStrictEqual({ code: "Overflow", message: "full" })
    }))

    it.effect("reuses one decoder for any number of replies", () => Effect.gen(function*() {
      const decode = decodeResponse(Value)

      expect(yield* decode(succeed({ count: "1" }))).toStrictEqual({ count: 1 })
      expect(yield* messageFailure(decode(fail({ code: "Overflow", message: "full" })))).toBeInstanceOf(ChromeMessageError)
      expect(yield* schemaFailure(decode(null))).toBeInstanceOf(Schema.SchemaError)
      expect(yield* decode(succeed({ count: "2" }))).toStrictEqual({ count: 2 })
    }))

    it.effect("is lazy: a reply that throws while being read is a defect when run, not a throw", () => Effect.gen(function*() {
      let reads = 0

      const hostile = {
        get ok(): boolean {
          reads += 1
          throw new Error("hostile getter")
        }
      }

      const decoded = decodeResponse(Value)(hostile)

      expect(reads).toBe(0)

      const exit = yield* Effect.exit(decoded)

      expect(reads).toBe(1)
      expect(Exit.hasDies(exit)).toBe(true)
    }))

    it.effect("reads the reply again every time the Effect runs", () => Effect.gen(function*() {
      const reply: MutableReply = { ok: true, value: { count: "1" } }
      const decoded = decodeResponse(Value)(reply)

      expect(yield* decoded).toStrictEqual({ count: 1 })

      reply.value = { count: "2" }
      expect(yield* decoded).toStrictEqual({ count: 2 })

      reply.ok = false
      reply.error = { code: "Overflow", message: "full" }
      expect((yield* messageFailure(decoded)).code).toBe("Overflow")
    }))

    it.effect("provides the value schema's decoding services", () => Effect.gen(function*() {
      class Scale extends Context.Service<Scale, number>()("test/ChromeMessage/Scale") {}

      const Scaled = Schema.Finite.pipe(Schema.decodeTo(Schema.Finite, {
        decode: SchemaGetter.transformEffect((n: number) => Effect.map(Effect.service(Scale), (scale) => n * scale)),
        encode: SchemaGetter.transform((n: number) => n)
      }))

      const decoded = decodeResponse(Scaled)(succeed(2))

      expectTypeOf(decoded).toEqualTypeOf<Effect.Effect<number, ChromeMessageError | Schema.SchemaError, Scale>>()
      expect(yield* decoded.pipe(Effect.provideService(Scale, 21))).toBe(42)
    }))

    it.effect("interrupts an asynchronous value decode", () => Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const never = yield* Deferred.make<number>()

      const Slow = Schema.Finite.pipe(Schema.decodeTo(Schema.Finite, {
        decode: SchemaGetter.transformEffect(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(never)))),
        encode: SchemaGetter.transform((n: number) => n)
      }))

      const fiber = yield* Effect.forkChild(decodeResponse(Slow)(succeed(1)))

      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
    }))
  })

  describe("JSON serialization, as Chrome sends replies", () => {
    it.effect.each([
      ["Schema.Void", Schema.Void],
      ["Schema.Undefined", Schema.Undefined],
      ["Schema.Unknown", Schema.Unknown],
      ["Schema.UndefinedOr", Schema.UndefinedOr(Schema.Finite)]
    ] as const)("decodes succeed(undefined), which arrives without a value key, with %s", ([, schema]) => Effect.gen(function*() {
      const wire = overTheWire(succeed(undefined))

      expect(wire).toStrictEqual({ ok: true })
      expect(yield* decodeResponse(schema)(wire)).toBeUndefined()
    }))

    it.effect("rejects a missing value that the value schema does not accept", () => Effect.gen(function*() {
      const error = yield* schemaFailure(decodeResponse(Schema.Finite)(overTheWire(succeed(undefined))))

      expect(error.message).toContain('at ["value"]')
    }))

    it.effect("rejects a present undefined value that the value schema does not accept", () => Effect.gen(function*() {
      const error = yield* schemaFailure(decodeResponse(Schema.Finite)(succeed(undefined)))

      expect(error.message).toContain('at ["value"]')
    }))

    it.effect.each([
      ["null", null, Schema.Null],
      ["false", false, Schema.Boolean],
      ["zero", 0, Schema.Finite],
      ["an empty string", "", Schema.String],
      ["an empty array", [], Schema.Array(Schema.Finite)],
      ["a unicode string with NUL", "a\u0000\u{1F600}", Schema.String],
      ["a nested record", { a: { b: [1, "two", null] } }, Schema.Unknown]
    ] as const)("round-trips %s", ([, value, schema]) => Effect.gen(function*() {
      expect(yield* decodeResponse(schema)(overTheWire(succeed(value)))).toStrictEqual(value)
    }))

    it.effect("delivers what JSON makes of non-JSON values, which the value schema then judges", () => Effect.gen(function*() {
      const wire = overTheWire(succeed({ nan: Number.NaN, date: new Date(0), missing: undefined }))

      expect(wire).toStrictEqual({ ok: true, value: { nan: null, date: "1970-01-01T00:00:00.000Z" } })
      expect(yield* schemaFailure(decodeResponse(Schema.Struct({ nan: Schema.Finite }))(wire))).toBeInstanceOf(Schema.SchemaError)
      expect(yield* decodeResponse(Schema.Struct({ date: Schema.DateFromString }))(wire)).toStrictEqual({ date: new Date(0) })
    }))

    it.effect.each(codes)("round-trips a %s failure", (code) => Effect.gen(function*() {
      const error = yield* messageFailure(decodeResponse(Value)(overTheWire(fail({ code, message: "m" }))))

      expect(error.code).toBe(code)
      expect(error.message).toBe("m")
    }))
  })

  describe("Response", () => {
    it.effect("decodes both envelope shapes", () => Effect.gen(function*() {
      const decode = Schema.decodeUnknownEffect(Response(Value))

      expect(yield* decode({ ok: true, value: { count: "1" } })).toStrictEqual({ ok: true, value: { count: 1 } })
      expect(yield* decode({ ok: false, error: { code: "Overflow", message: "full" } })).toStrictEqual({
        ok: false, error: { code: "Overflow", message: "full" }
      })
    }))

    it.effect("decodes a success envelope without a value key from undefined", () => Effect.gen(function*() {
      expect(yield* Schema.decodeEffect(Response(Schema.Void))({ ok: true })).toStrictEqual({ ok: true, value: undefined })
      expect(yield* Schema.decodeEffect(Response(Schema.Unknown))({ ok: true })).toStrictEqual({ ok: true, value: undefined })

      const error = yield* Effect.flip(Schema.decodeEffect(Response(Value))({ ok: true }))

      expect(error.message).toContain('at ["value"]')
    }))

    it.effect("rejects what is not an envelope", () => Effect.gen(function*() {
      const decode = Schema.decodeUnknownEffect(Response(Value))

      for (const reply of [undefined, null, {}, { ok: "true" }, { ok: false }]) {
        expect(yield* Effect.flip(decode(reply))).toBeInstanceOf(Schema.SchemaError)
      }
    }))

    it.effect("encodes the value with the value schema, for a receiver answering by hand", () => Effect.gen(function*() {
      const encode = Schema.encodeEffect(Response(Value))

      expect(yield* encode(succeed({ count: 3 }))).toStrictEqual({ ok: true, value: { count: "3" } })
      expect(yield* encode(fail({ code: "Disposed", message: "gone" }))).toStrictEqual({ ok: false, error: { code: "Disposed", message: "gone" } })
    }))

    it.effect("round-trips an encoded envelope through JSON and decodeResponse", () => Effect.gen(function*() {
      const wire = overTheWire(yield* Schema.encodeEffect(Response(Value))(succeed({ count: 9 })))

      expect(yield* decodeResponse(Value)(wire)).toStrictEqual({ count: 9 })
    }))

    it.effect("validates WorkerError on its own", () => Effect.gen(function*() {
      expect(yield* Schema.decodeEffect(WorkerError)({ code: "Overflow", message: "m" })).toStrictEqual({ code: "Overflow", message: "m" })
      expect(yield* Effect.flip(Schema.decodeUnknownEffect(WorkerError)({ code: "overflow", message: "m" }))).toBeInstanceOf(Schema.SchemaError)
    }))

    it("types the decoded and encoded sides", () => {
      type Envelope = ResponseSchema<typeof Value>

      expectTypeOf(Response(Value)).toEqualTypeOf<Envelope>()
      expectTypeOf<Envelope["Type"]>().toEqualTypeOf<
        | { readonly ok: true; readonly value: { readonly count: number } }
        | { readonly ok: false; readonly error: WorkerError }
      >()
      expectTypeOf<Envelope["Encoded"]>().toEqualTypeOf<
        | { readonly ok: true; readonly value?: { readonly count: string } }
        | { readonly ok: false; readonly error: { readonly code: ErrorCode; readonly message: string } }
      >()
    })
  })

  describe("with ChromeServiceWorker", () => {
    // start owns an independent ManagedRuntime; its replies arrive through native callbacks.
    const worker = (
      onMessage: () => Effect.Effect<unknown, string>,
      options: { readonly maxPending?: number; readonly initialize?: Effect.Effect<void, string> } = {}
    ) => {
      const listeners = new Set<MessageListener>()

      const event: ChromeEvent<MessageListener> = {
        addListener: (listener) => { listeners.add(listener) },
        removeListener: (listener) => { listeners.delete(listener) }
      }

      const running = start({
        chrome: { runtime: { onMessage: event } },
        layer: Layer.empty,
        selectMessage: () => true,
        onMessage,
        onError: () => {},
        ...options
      })

      const send = (): Promise<Wire<unknown>> => new Promise((resolve) => {
        for (const listener of listeners) listener("message", { id: "sender" }, (reply) => { resolve(overTheWire(reply)) })
      })

      return { running, send }
    }

    it.effect("decodes a void handler's reply", () => Effect.gen(function*() {
      const { running, send } = worker(() => Effect.void)

      yield* Effect.promise(() => running.ready)
      expect(yield* decodeResponse(Schema.Void)(yield* Effect.promise(send))).toBeUndefined()
      yield* Effect.promise(running.dispose)
    }))

    it.effect("decodes a void handler's reply as a whole envelope", () => Effect.gen(function*() {
      const { running, send } = worker(() => Effect.void)

      yield* Effect.promise(() => running.ready)
      expect(yield* Schema.decodeEffect(Response(Schema.Unknown))(yield* Effect.promise(send)))
        .toStrictEqual({ ok: true, value: undefined })
      yield* Effect.promise(running.dispose)
    }))

    it.effect("decodes a handler's encoded value", () => Effect.gen(function*() {
      const { running, send } = worker(() => Effect.succeed({ count: "7" }))

      yield* Effect.promise(() => running.ready)
      expect(yield* decodeResponse(Value)(yield* Effect.promise(send))).toStrictEqual({ count: 7 })
      yield* Effect.promise(running.dispose)
    }))

    it.effect("fails with HandlerFailed when the handler fails", () => Effect.gen(function*() {
      const { running, send } = worker(() => Effect.fail("nope"))

      yield* Effect.promise(() => running.ready)

      const error = yield* messageFailure(decodeResponse(Value)(yield* Effect.promise(send)))

      expect(error.code).toBe("HandlerFailed")
      expect(error.message).toContain("nope")
      yield* Effect.promise(running.dispose)
    }))

    it.effect("fails with InitializationFailed when initialization fails", () => Effect.gen(function*() {
      const { running, send } = worker(() => Effect.void, { initialize: Effect.fail("no init") })
      const reply = send()

      expect(Exit.isFailure(yield* Effect.promise(() => running.ready))).toBe(true)

      const error = yield* messageFailure(decodeResponse(Schema.Void)(yield* Effect.promise(() => reply)))

      expect(error.code).toBe("InitializationFailed")
      expect(error.message).toContain("no init")
      yield* Effect.promise(running.dispose)
    }))

    it.effect("fails with Overflow when the startup queue is full", () => Effect.gen(function*() {
      const { running, send } = worker(() => Effect.void, { maxPending: 0 })
      const error = yield* messageFailure(decodeResponse(Schema.Void)(yield* Effect.promise(send)))

      expect(error.code).toBe("Overflow")
      yield* Effect.promise(running.dispose)
    }))

    it.effect("fails with Disposed after disposal", () => Effect.gen(function*() {
      const { running, send } = worker(() => Effect.void)
      const reply = send()

      yield* Effect.promise(running.dispose)

      const error = yield* messageFailure(decodeResponse(Schema.Void)(yield* Effect.promise(() => reply)))

      expect(error.code).toBe("Disposed")
    }))
  })
})
