import { Effect, Layer, Schema, Stream } from "effect"
import * as ChromeStorage from "effect-platform-chrome/ChromeStorage"
import { ChromePort } from "effect-platform-chrome/ChromePort"
import * as ChromeServiceWorker from "effect-platform-chrome/ChromeServiceWorker"
import * as ChromeRpc from "effect-platform-chrome/ChromeRpc"
import { DemoRejected, DemoRpc, rpcChannel } from "../shared/rpc.js"
import { defineBackground } from "wxt/utils/define-background"
import { alarmKey, alarmName, channel, lifecycleKey, Request, workerKey } from "../shared/protocol"

export default defineBackground(() => {
  const bootId = crypto.randomUUID()
  const recordLifecycle = (event: unknown) => Effect.gen(function*() {
    const storage = yield* ChromeStorage.ChromeStorage
    yield* storage.local.set({ [lifecycleKey]: { event, at: new Date().toISOString(), bootId } })
  })

  // WXT invokes this main callback synchronously when its generated worker
  // loads. Never await initialization before start: all wake listeners must
  // already exist before Chrome dispatches the event which started this worker.
  const worker = ChromeServiceWorker.start({
    chrome,
    layer: Layer.mergeAll(ChromeStorage.layer, ChromePort.layerLive),
    maxPending: 32,
    initialize: Effect.gen(function*() {
      // Deliberate short delay makes the initialization gate visible: requests
      // received now are retained and answered only after initialization.
      yield* Effect.sleep("250 millis")
      const storage = yield* ChromeStorage.ChromeStorage
      yield* storage.local.set({
        [workerKey]: { bootId, initializedAt: new Date().toISOString(), gateMs: 250 }
      })
    }),
    selectMessage: (message) => typeof message === "object" && message !== null &&
      "channel" in message && message.channel === channel,
    onMessage: (raw, sender) => Effect.gen(function*() {
      const request = yield* Schema.decodeUnknownEffect(Request)(raw)
      if (request.op === "fail") return yield* Effect.fail(new Error("Intentional demo handler failure"))
      if (request.op === "ping") return { echo: request.text, bootId, fromTab: sender.tab?.id ?? null }
      const storage = yield* ChromeStorage.ChromeStorage
      return yield* storage.local.get([workerKey, alarmKey, lifecycleKey])
    }),
    onConnect: (native) => {
      // The existing synchronous wake listener dispatches dedicated RPC ports.
      // Ping/Pong retries bridge the worker initialization/adoption gate.
      if (native.name === rpcChannel) return ChromeRpc.serve(chrome.runtime, native, "owned", DemoRpc).pipe(
        Effect.provide(DemoRpc.toLayer({
          Ping: ({ text }) => Effect.succeed(text),
          Fail: () => Effect.fail(new DemoRejected({ message: "Intentional typed RPC failure" })),
          Numbers: () => Stream.range(0, 9999).pipe(Stream.rechunk(1))
        }))
      )
      if (native.name !== channel) return Effect.void
      return Effect.scoped(Effect.gen(function*() {
        const ports = yield* ChromePort
        // Owned adoption disconnects this side and removes listeners on scope
        // exit. Stream completion (popup disconnect) closes the handler scope.
        const port = yield* ports.adopt(native, "owned")
        yield* port.send({ type: "connected", bootId })
        yield* Stream.runForEach(port.messages, (message) =>
          port.send({ type: "echo", message, bootId }))
      }))
    },
    onInstalled: (details) => recordLifecycle({ type: "installed", reason: details.reason }),
    onStartup: () => recordLifecycle({ type: "startup" }),
    onAlarm: (alarm) => Effect.gen(function*() {
      if (alarm.name !== alarmName) return
      const storage = yield* ChromeStorage.ChromeStorage
      yield* storage.local.set({
        [alarmKey]: { name: alarm.name, scheduledTime: alarm.scheduledTime,
          handledAt: new Date().toISOString(), bootId }
      })
    }),
    onError: (error) => console.error("Demo worker:", error)
  })

  // Additional synchronous registration goes through the same init gate.
  worker.register(chrome.tabs.onActivated, (info) => recordLifecycle({ type: "tab-activated", ...info }))
  void worker.ready.then((exit) => console.info("Demo worker initialization", bootId, exit))
  // Chrome termination is not a graceful shutdown event. Only explicitly dispose
  // when a host really tears down a runtime; never dispose after each message.
})
