import { Schema } from "effect"
import * as ChromeMessage from "effect-platform-chrome/ChromeMessage"

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

// ChromeServiceWorker.start wraps every handler value in the ChromeMessage envelope.
// The popup decodes the whole envelope to display failures as ordinary replies;
// ChromeRuntime.request unwraps it instead, failing with ChromeMessageError.
export const Response = ChromeMessage.Response(Schema.Unknown)
