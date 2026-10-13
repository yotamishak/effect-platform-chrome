import { Schema } from "effect"

export const channel = "effect-wxt-demo"
export const alarmName = "effect-wxt-demo/wakeup"
export const storageKey = "effect-wxt-demo/value"
export const workerKey = "effect-wxt-demo/worker"
export const alarmKey = "effect-wxt-demo/last-alarm"
export const lifecycleKey = "effect-wxt-demo/lifecycle"

export const Request = Schema.Struct({
  channel: Schema.Literal(channel),
  op: Schema.Literals(["ping", "status", "fail"]),
  text: Schema.String
})

// ChromeServiceWorker.start wraps successful handler values itself. Do not
// wrap a handler's return value again, or expect a bare value on the client.
export const Response = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      code: Schema.Literals(["InitializationFailed", "HandlerFailed", "Overflow", "Disposed"]),
      message: Schema.String
    })
  })
])
