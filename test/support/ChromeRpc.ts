// Pinned Effect 4.0.4 RPC is a deliberately unstable integration.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Cause, Exit, Schema } from "effect"
import type { Layer } from "effect"
import { vi } from "@effect/vitest"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError"
import { ChromeRpcError } from "../../src/ChromeRpc.js"
import type { ChromePortApi, NativePort } from "../../src/ChromePort.js"

export class Rejected extends Schema.TaggedError<Rejected>()("Rejected", { message: Schema.String }) {}

export const group = RpcGroup.make(
  Rpc.make("Echo", { payload: { value: Schema.String }, success: Schema.String, error: Rejected }),
  Rpc.make("Wait", { success: Schema.String }),
  Rpc.make("Numbers", { success: Schema.Finite, stream: true })
)

export type Handlers = Layer.Layer<Rpc.ToHandler<RpcGroup.Rpcs<typeof group>>>

/** The transport failure a client call reports, which the adapter wraps in RpcClientError. */
export const transportError = (error: RpcClientError | Rejected): ChromeRpcError => {
  if (error instanceof RpcClientError && error.reason instanceof RpcClientDefect && error.reason.cause instanceof ChromeRpcError) {
    return error.reason.cause
  }

  throw new Error(`Expected a ChromeRpcError transport failure, got ${String(error)}`)
}

/** The transport failure a call's exit reports. */
export const transportFailure = <A>(exit: Exit.Exit<A, RpcClientError | Rejected>): ChromeRpcError => {
  const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined

  if (error instanceof RpcClientError || error instanceof Rejected) return transportError(error)

  throw new Error(`Expected a failed call, got ${String(exit)}`)
}

type MessageListener = Parameters<NativePort["onMessage"]["addListener"]>[0]

type DisconnectListener = Parameters<NativePort["onDisconnect"]["addListener"]>[0]

/**
 * Two synchronously linked native port mocks. Either side's `disconnect` closes both and
 * notifies both sides' disconnect listeners, as Chrome does for the remote end. `lastError`
 * is set only while the disconnect listeners run, as Chrome exposes it.
 */
export const pair = (lastError?: chrome.runtime.LastError) => {
  const clientMessages = new Set<MessageListener>()
  const serverMessages = new Set<MessageListener>()
  const clientDisconnects = new Set<DisconnectListener>()
  const serverDisconnects = new Set<DisconnectListener>()
  let closed = false
  let currentError: chrome.runtime.LastError | undefined

  const event = <A>(listeners: Set<A>) => ({
    addListener: (listener: A) => { listeners.add(listener) },
    removeListener: (listener: A) => { listeners.delete(listener) },
    hasListener: (listener: A) => listeners.has(listener),
    hasListeners: () => listeners.size > 0,
    addRules: vi.fn(), getRules: vi.fn(), removeRules: vi.fn()
  })

  // SAFETY: Chrome's ambient declaration makes lastError required although it is
  // undefined outside a native error callback. This mock models the actual boundary.
  const api = { connect: () => client, get lastError() { return currentError } } as ChromePortApi

  const close = vi.fn(() => {
    if (closed) return
    closed = true
    currentError = lastError

    try {
      for (const listener of clientDisconnects) listener(client)

      for (const listener of serverDisconnects) listener(server)
    } finally {
      currentError = undefined
    }
  })

  const client: NativePort = {
    name: "rpc", disconnect: close,
    onMessage: event(clientMessages), onDisconnect: event(clientDisconnects),
    postMessage: vi.fn<NativePort["postMessage"]>((frame) => {
      if (closed) throw new Error("Attempting to use a disconnected port object")

      for (const listener of serverMessages) listener(frame, server)
    })
  }

  const server: NativePort = {
    name: "rpc", disconnect: close,
    onMessage: event(serverMessages), onDisconnect: event(serverDisconnects),
    postMessage: vi.fn<NativePort["postMessage"]>((frame) => {
      if (closed) throw new Error("Attempting to use a disconnected port object")

      for (const listener of clientMessages) listener(frame, client)
    })
  }

  const listeners = () => clientMessages.size + serverMessages.size + clientDisconnects.size + serverDisconnects.size

  return { client, server, api, close, clientMessages, serverMessages, clientDisconnects, serverDisconnects, listeners }
}

export type Ports = ReturnType<typeof pair>
