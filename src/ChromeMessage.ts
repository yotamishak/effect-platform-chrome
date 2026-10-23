/**
 * The reply envelope for one-off `runtime.sendMessage` / `tabs.sendMessage` messages.
 * `ChromeServiceWorker.start` wraps every `onMessage` result in it; a content script or
 * page answering by hand builds it with `succeed` / `fail`. Senders unwrap it with
 * `decodeResponse` or `ChromeRuntime.request`, so neither side redeclares the shape.
 *
 * This is not a namespace wrapper: it has no service, layer or Chrome calls.
 *
 * Chrome serializes messages as JSON, which drops a property whose value is `undefined`:
 * `succeed(undefined)` (a handler returning `Effect.void`) arrives as `{ ok: true }`. The
 * envelope schema therefore reads a missing `value` as `undefined` and lets the value schema
 * decide whether that is acceptable (`Schema.Void` and `Schema.Undefined` accept it).
 */
import { Effect, Schema, SchemaIssue } from "effect"

/** Why the receiver could not produce a value. */
export const ErrorCode = Schema.Literals(["InitializationFailed", "HandlerFailed", "Overflow", "Disposed"])

export type ErrorCode = typeof ErrorCode.Type

/** The failure half of the envelope. */
export const WorkerError = Schema.Struct({ code: ErrorCode, message: Schema.String })

export type WorkerError = typeof WorkerError.Type

export type Response<A = unknown> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: WorkerError }

/** The schema of a `Response` whose value is described by `Value`. */
export type ResponseSchema<Value extends Schema.Constraint> = Schema.Union<readonly [
  Schema.Struct<{ readonly ok: Schema.Literal<true>; readonly value: Schema.withDecodingDefaultKey<Value> }>,
  Schema.Struct<{ readonly ok: Schema.Literal<false>; readonly error: typeof WorkerError }>
]>

/**
 * The envelope schema around a value schema. A success envelope without a `value` key, as
 * JSON serialization leaves `succeed(undefined)`, decodes its value from `undefined`.
 * Keys the envelope does not define are ignored.
 */
export const Response = <Value extends Schema.Constraint>(value: Value): ResponseSchema<Value> => Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    // SAFETY: an absent key is what JSON makes of an `undefined` value. It is handed to the
    // value schema, which validates it like any other encoded value and rejects it when the
    // encoded side does not admit `undefined`.
    value: Schema.withDecodingDefaultKey(Effect.succeed(undefined as Value["Encoded"]))(value)
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: WorkerError })
])

/** A success envelope. The value travels as given, so send the value schema's encoded form. */
export const succeed = <A>(value: A): Response<A> => ({ ok: true, value })

/**
 * A failure envelope carrying exactly `code` and `message`. Both are copied out, so an `Error`
 * that fits `WorkerError` keeps its non-enumerable `message` over JSON, and extra keys (a
 * relayed `ChromeMessageError`'s `_tag`, unserializable context) are never sent.
 */
export const fail = (error: WorkerError): Response<never> => ({
  ok: false,
  error: { code: error.code, message: error.message }
})

/** The receiver answered, but with a failure envelope. */
export class ChromeMessageError extends Schema.TaggedError<ChromeMessageError>()("ChromeMessageError", {
  code: ErrorCode,
  message: Schema.String
}) {}

/** The outcome of `decodeResponse`. */
export type Decoded<Value extends Schema.Constraint> =
  Effect.Effect<Value["Type"], ChromeMessageError | Schema.SchemaError, Value["DecodingServices"]>

const decodeEnvelope = Schema.decodeUnknownEffect(Response(Schema.Unknown))

// Report a value issue where it sits in the reply, as decoding the whole envelope would.
const atValue = (error: Schema.SchemaError): Schema.SchemaError =>
  new Schema.SchemaError(new SchemaIssue.Pointer(["value"], error.issue))

/**
 * Decodes a raw reply: the value on success, `ChromeMessageError` on a failure envelope and
 * `SchemaError` when the reply is not an envelope of this value schema. A value that fails
 * its schema is reported at path `["value", ...]`. A reply that is no envelope at all, such
 * as the `undefined` or `null` of a message nobody answered, fails with `SchemaError`.
 * Decoding happens when the Effect runs, every time it runs.
 */
export const decodeResponse = <Value extends Schema.Constraint>(value: Value) => {
  const decodeValue = Schema.decodeUnknownEffect(value)

  // A message reply is an untrusted I/O boundary; this is where it is decoded.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  return (reply: unknown): Decoded<Value> => Effect.flatMap(
    // Schema parsers read synchronous input eagerly; suspending keeps building the Effect free
    // of work and turns a reply that throws while being read into a defect of the Effect.
    Effect.suspend(() => decodeEnvelope(reply)),
    (response): Decoded<Value> => response.ok
      ? Effect.mapError(decodeValue(response.value), atValue)
      : Effect.fail(new ChromeMessageError(response.error))
  )
}
