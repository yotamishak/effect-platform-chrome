import { Schema } from "effect"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"

export const rpcChannel = "effect-wxt/rpc"

export class DemoRejected extends Schema.TaggedError<DemoRejected>()("DemoRejected", {
  message: Schema.String
}) {}

// The ChromeRpc demo intentionally exercises the RPC API pinned to Effect 4.0.4.
/* oxlint-disable effecttsgo/unstable-api-usage */
export const DemoRpc = RpcGroup.make(
  Rpc.make("Ping", { payload: { text: Schema.String }, success: Schema.String }),
  Rpc.make("Fail", { success: Schema.String, error: DemoRejected }),
  Rpc.make("Numbers", { success: Schema.Int, stream: true })
)
/* oxlint-enable effecttsgo/unstable-api-usage */
