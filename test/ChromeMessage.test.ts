// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Schema } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChromeMessageError, decodeResponse, fail, Response, succeed } from "../src/ChromeMessage.js"

const Value = Schema.Struct({ count: Schema.FiniteFromString })

describe("ChromeMessage", () => {
  it.effect("decodes the value of a success envelope with the value schema", () => Effect.gen(function*() {
    expect(yield* decodeResponse(Value)(succeed({ count: "3" }))).toEqual({ count: 3 })
  }))

  it.effect("fails with ChromeMessageError on a failure envelope", () => Effect.gen(function*() {
    const error = yield* Effect.flip(decodeResponse(Value)(fail({ code: "HandlerFailed", message: "boom" })))
    expect(error).toBeInstanceOf(ChromeMessageError)
    expect(error).toMatchObject({ code: "HandlerFailed", message: "boom" })
  }))

  it.effect.each([undefined, { count: "3" }, { ok: true, value: { count: "x" } }, { ok: false, error: { code: "Other", message: "" } }])(
    "fails with SchemaError on a reply that is not this envelope: %j", (reply) => Effect.gen(function*() {
      expect(yield* Effect.flip(decodeResponse(Value)(reply))).toBeInstanceOf(Schema.SchemaError)
    })
  )

  it.effect("builds a schema for both envelope shapes", () => Effect.gen(function*() {
    const decode = Schema.decodeUnknownEffect(Response(Value))
    expect(yield* decode({ ok: true, value: { count: "1" } })).toEqual({ ok: true, value: { count: 1 } })
    expect(yield* decode({ ok: false, error: { code: "Overflow", message: "full" } })).toEqual({
      ok: false, error: { code: "Overflow", message: "full" }
    })
  }))
})
