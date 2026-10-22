/**
 * The reply envelope for one-off `runtime.sendMessage` / `tabs.sendMessage` messages.
 * `ChromeServiceWorker.start` wraps every `onMessage` result in it; a content script or
 * page answering by hand builds it with `succeed` / `fail`. Senders unwrap it with
 * `decodeResponse` or `ChromeRuntime.request`, so neither side redeclares the shape.
 */
import { Effect, Schema } from "effect"

/** Why the receiver could not produce a value. */
export const ErrorCode = Schema.Literals(["InitializationFailed", "HandlerFailed", "Overflow", "Disposed"])

export type ErrorCode = typeof ErrorCode.Type

export const WorkerError = Schema.Struct({ code: ErrorCode, message: Schema.String })

export type WorkerError = typeof WorkerError.Type

export type Response<A = unknown> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: WorkerError }

/** The envelope schema around a value schema. */
export const Response = <Value extends Schema.Constraint>(value: Value) => Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value }),
  Schema.Struct({ ok: Schema.Literal(false), error: WorkerError })
])

export const succeed = <A>(value: A): Response<A> => ({ ok: true, value })

export const fail = (error: WorkerError): Response<never> => ({ ok: false, error })

const decodeEnvelope = Schema.decodeUnknownEffect(Response(Schema.Unknown))

/** The receiver answered, but with a failure envelope. */
export class ChromeMessageError extends Schema.TaggedError<ChromeMessageError>()("ChromeMessageError", {
  code: ErrorCode,
  message: Schema.String
}) {}

/**
 * Decodes a raw reply: the value on success, `ChromeMessageError` on a failure envelope and
 * `SchemaError` when the reply is not an envelope of this value schema (for example
 * `undefined`, when no listener answered).
 */
export type Decoded<Value extends Schema.Constraint> =
  Effect.Effect<Value["Type"], ChromeMessageError | Schema.SchemaError, Value["DecodingServices"]>

export const decodeResponse = <Value extends Schema.Constraint>(value: Value) => {
  const decodeValue = Schema.decodeUnknownEffect(value)

  // A message reply is an untrusted I/O boundary; this is where it is decoded.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  return (reply: unknown): Decoded<Value> => Effect.flatMap(decodeEnvelope(reply), (response): Decoded<Value> => response.ok
    ? decodeValue(response.value)
    : Effect.fail(new ChromeMessageError(response.error)))
}
