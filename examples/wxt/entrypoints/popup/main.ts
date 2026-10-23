import { Effect, Fiber, Layer, ManagedRuntime, Option, Schema, Stream } from "effect"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as ChromeStorage from "effect-platform-chrome/ChromeStorage"
import * as ChromeKeyValueStore from "effect-platform-chrome/ChromeKeyValueStore"
import * as ChromeRuntime from "effect-platform-chrome/ChromeRuntime"
import * as ChromePort from "effect-platform-chrome/ChromePort"
import * as ChromeTabs from "effect-platform-chrome/ChromeTabs"
import * as ChromeAlarms from "effect-platform-chrome/ChromeAlarms"
import { alarmName, channel, Request, Response, storageKey } from "../../shared/protocol"
import "./style.css"
import { installAdvanced } from "./advanced.js"
import { installLimits } from "./limits.js"

const runtime = ManagedRuntime.make(Layer.mergeAll(
  ChromeStorage.layerLive, ChromeRuntime.layerLive, ChromePort.layerLive,
  ChromeTabs.layerLive, ChromeAlarms.layerLive,
  ChromeKeyValueStore.layerLive({ namespace: "wxt-seven-modules-demo" })
))
const output = document.querySelector<HTMLPreElement>("#output")!
const value = () => document.querySelector<HTMLInputElement>("#value")!.value
const log = (label: string, data: unknown) => {
  const text = data instanceof Error ? `${data.name}: ${data.message}` :
    JSON.stringify(data, (_key, item: unknown) => item instanceof Uint8Array ? Array.from(item) : item, 2)
  output.textContent = `[${new Date().toLocaleTimeString()}] ${label}\n${text}\n\n${output.textContent}`.slice(0, 24000)
}

type Services = ChromeStorage.ChromeStorage | ChromeRuntime.ChromeRuntime | ChromePort.ChromePort |
  ChromeTabs.ChromeTabs | ChromeAlarms.ChromeAlarms | KeyValueStore.KeyValueStore
function button<A, E>(id: string, action: () => Effect.Effect<A, E, Services>) {
  const element = document.querySelector<HTMLButtonElement>(`#${id}`)!
  element.addEventListener("click", () => {
    element.disabled = true
    void runtime.runPromise(Effect.suspend(action)).then(
      (result) => log(id, result ?? "Done"), (error: unknown) => log(`${id}: error`, error)
    ).finally(() => { element.disabled = false })
  })
}

button("storage-write", () => Effect.gen(function*() {
  const storage = yield* ChromeStorage.ChromeStorage
  const item = { [storageKey]: { text: value(), at: new Date().toISOString() } }
  yield* storage.local.set(item)
  yield* storage.sync.set(item)
  yield* storage.session.set(item)
  return "Wrote demo key in all three writable areas"
}))
button("storage-read", () => Effect.gen(function*() {
  const storage = yield* ChromeStorage.ChromeStorage
  return { local: yield* storage.local.get(storageKey), sync: yield* storage.sync.get(storageKey),
    session: yield* storage.session.get(storageKey) }
}))
button("managed", () => Effect.gen(function*() {
  const storage = yield* ChromeStorage.ChromeStorage
  return yield* storage.managed.get().pipe(
    Effect.map((items) => Object.keys(items).length ? items : { note: "No managed policy configured (expected)" }),
    Effect.catch((error) => Effect.succeed({ note: "Managed policy unavailable; optional demo skipped", error }))
  )
}))
button("kv", () => Effect.gen(function*() {
  const kv = yield* KeyValueStore.KeyValueStore
  yield* kv.set("greeting", value())
  yield* kv.set("bytes", new Uint8Array([0, 1, 127, 128, 255]))
  return { string: yield* kv.get("greeting"), binary: yield* kv.getUint8Array("bytes"), size: yield* kv.size }
}))
button("kv-clear", () => Effect.gen(function*() {
  const kv = yield* KeyValueStore.KeyValueStore
  yield* kv.clear
  return { remaining: yield* kv.size, note: "Unrelated ChromeStorage keys are untouched" }
}))
button("metadata", () => Effect.gen(function*() {
  const service = yield* ChromeRuntime.ChromeRuntime
  return { id: yield* service.id, manifest: yield* service.getManifest, popupURL: yield* service.getURL("popup.html") }
}))
for (const op of ["ping", "status", "fail"] as const) {
  button(op, () => Effect.gen(function*() {
    const service = yield* ChromeRuntime.ChromeRuntime
    // The failure button returns a decoded {ok:false,error}, not a transport
    // exception. Transport/schema errors still fail the Effect separately.
    return yield* service.sendMessageSchema(Request, Response, { channel, op, text: value() })
  }))
}

const fibers = new Set<Fiber.Fiber<unknown, unknown>>()
const fork = <A, E>(effect: Effect.Effect<A, E, Services>) => {
  const fiber = runtime.runFork(effect)
  fibers.add(fiber)
  fiber.addObserver(() => fibers.delete(fiber))
  return fiber
}
let port: ChromePort.Port | undefined
let portReady = false
let portFiber: Fiber.Fiber<unknown, unknown> | undefined
button("connect", () => Effect.sync(() => {
  if (portFiber) return "Already connected / connecting"
  portFiber = fork(Effect.scoped(Effect.gen(function*() {
    const service = yield* ChromePort.ChromePort
    port = yield* service.connect({ name: channel })
    // onConnect is gated during worker initialization. Wait for the server's
    // greeting instead of sending before it has adopted the native port.
    yield* Stream.runForEach(port.messages, (message) => Effect.gen(function*() {
      log("port", message)
      if (typeof message === "object" && message !== null &&
        "type" in message && message.type === "connected") {
        portReady = true
        yield* port!.send({ text: "Hello from popup" })
      }
    }))
  })).pipe(
    Effect.catch((error) => Effect.sync(() => log("port error", error))),
    Effect.ensuring(Effect.sync(() => { port = undefined; portReady = false; portFiber = undefined }))
  ))
  return "Opening owned scoped connection"
}))
button("port-send", () => port && portReady ? port.send({ text: value(), at: Date.now() }) : Effect.succeed("Connect and wait for the background greeting first"))
button("disconnect", () => Effect.gen(function*() {
  if (portFiber) yield* Fiber.interrupt(portFiber)
  return "Port scope closed; native connection released"
}))

button("tabs", () => Effect.gen(function*() {
  const tabs = yield* ChromeTabs.ChromeTabs
  return (yield* tabs.query({ currentWindow: true })).map(({ id, title, url, active }) => ({ id, title, url, active }))
}))
button("open", () => Effect.gen(function*() {
  const tabs = yield* ChromeTabs.ChromeTabs
  return yield* tabs.create({ url: "https://example.com/" })
}))
button("content", () => Effect.gen(function*() {
  const tabs = yield* ChromeTabs.ChromeTabs
  const candidates = yield* tabs.query({ url: "https://example.com/*" })
  const tab = candidates.find((candidate) => candidate.active) ?? candidates[0]
  if (tab?.id === undefined) return "Open example.com first, then reopen this popup"
  return yield* Schema.decodeUnknownEffect(Response)(yield* tabs.sendMessage(tab.id, { channel: `${channel}/content` }))
}))
button("alarm-create", () => Effect.gen(function*() {
  const alarms = yield* ChromeAlarms.ChromeAlarms
  yield* alarms.create(alarmName, { delayInMinutes: 1 })
  return Option.getOrNull(yield* alarms.get(alarmName))
}))
button("alarm-query", () => Effect.gen(function*() {
  const alarms = yield* ChromeAlarms.ChromeAlarms
  return { demo: Option.getOrNull(yield* alarms.get(alarmName)), all: yield* alarms.getAll }
}))
button("alarm-clear", () => Effect.gen(function*() {
  const alarms = yield* ChromeAlarms.ChromeAlarms
  return { cleared: yield* alarms.clear(alarmName) }
}))
document.querySelector("#clear-output")!.addEventListener("click", () => { output.textContent = "" })

// These live streams own listeners only while their fibers run. They are NOT
// worker wake handlers; those are registered synchronously in background.ts.
fork(Effect.gen(function*() {
  const storage = yield* ChromeStorage.ChromeStorage
  const tabs = yield* ChromeTabs.ChromeTabs
  const alarms = yield* ChromeAlarms.ChromeAlarms
  const observe = <A, E>(name: string, stream: Stream.Stream<A, E>) =>
    Stream.runForEach(stream, (event) => Effect.sync(() => log(name, event)))
  yield* Effect.all([
    observe("storage changed", storage.onChanged),
    observe("tab created", tabs.onCreated), observe("tab updated", tabs.onUpdated),
    observe("tab removed", tabs.onRemoved), observe("tab activated", tabs.onActivated),
    observe("alarm observed in popup", alarms.onAlarm)
  ], { concurrency: "unbounded" })
}).pipe(Effect.catch((error) => Effect.sync(() => log("observation error", error)))))

window.addEventListener("pagehide", () => {
  // Best-effort unload cleanup; context destruction itself also releases native
  // listeners/ports. Do not assume Chrome awaits this Promise during unload.
  void Effect.runPromise(Fiber.interruptAll([...fibers])).then(() => runtime.dispose())
}, { once: true })
log("Ready", "Use the buttons above; streams remain active only while this popup is open.")
installAdvanced(log, value)
installLimits(log)
