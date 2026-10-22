import { Schema } from "effect"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"

// Ports and procedures of the limits runner (popup/limits.ts). The limits content
// script serves FrameRpc in example.com frames opened with `roleParam`; the worker
// serves WorkRpc twice, once wrapped in ChromeRpc.finishAccepted and once plain.
export const framePort = "effect-wxt-limits/frame"
export const roleParam = "effect-limits"
export const targetOrigin = "https://example.com/"
export const finishPort = "effect-wxt-limits/work-finish"
export const plainPort = "effect-wxt-limits/work-plain"
export const workPrefix = "effect-wxt-limits/work/"
export const cookieHost = "limits.effect-platform-chrome.test"

export const FrameRpc = RpcGroup.make(
  Rpc.make("Echo", { payload: { text: Schema.String }, success: Schema.String }),
  // Synchronous history.pushState calls. Answers the last push index Chrome applied: past its
  // history-update cap Chrome ignores pushState, and the page's URL stops there.
  Rpc.make("PushStates", { payload: { from: Schema.Int, count: Schema.Int }, success: Schema.Int }),
  Rpc.make("Where", { success: Schema.Struct({ url: Schema.String, top: Schema.Boolean }) })
)

// Sleeps, then records `${workPrefix}${id}` in local storage: proof the work finished.
export const WorkRpc = RpcGroup.make(
  Rpc.make("Work", { payload: { id: Schema.String, millis: Schema.Int }, success: Schema.String })
)
