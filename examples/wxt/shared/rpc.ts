import { Schema } from "effect"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"

export const rpcChannel = "effect-wxt/rpc"
export class DemoRejected extends Schema.TaggedError<DemoRejected>()("DemoRejected", {
  message: Schema.String
}) {}
export const DemoRpc = RpcGroup.make(
  Rpc.make("Ping", { payload: { text: Schema.String }, success: Schema.String }),
  Rpc.make("Fail", { success: Schema.String, error: DemoRejected }),
  Rpc.make("Numbers", { success: Schema.Int, stream: true })
)
