import { Cause, Effect, Fiber, Layer, ManagedRuntime, Option, Schema, Stream } from "effect"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as ChromeStorage from "effect-platform-chrome/ChromeStorage"
import * as ChromeKeyValueStore from "effect-platform-chrome/ChromeKeyValueStore"
import * as ChromeRuntime from "effect-platform-chrome/ChromeRuntime"
import * as ChromePort from "effect-platform-chrome/ChromePort"
import * as ChromeTabs from "effect-platform-chrome/ChromeTabs"
import * as ChromeAlarms from "effect-platform-chrome/ChromeAlarms"
import { alarmName, channel, Request, Response, storageKey } from "../../shared/protocol.js"
import "./style.css"
import { installAdvanced } from "./advanced.js"
import { installLimits } from "./limits.js"
import { installModules } from "./modules.js"
import { renderPlayground } from "./view.js"
import { installSidePanel } from "./sidepanel-controls.js"

renderPlayground()

const runtime = ManagedRuntime.make(Layer.mergeAll(
  ChromeStorage.layerLive, ChromeRuntime.layerLive, ChromePort.layerLive,
  ChromeTabs.layerLive, ChromeAlarms.layerLive,
  ChromeKeyValueStore.layerLive({ namespace: "wxt-seven-modules-demo" })
))

const output = document.querySelector<HTMLPreElement>("#output")!

const value = () => document.querySelector<HTMLInputElement>("#value")!.value

// JSON display is the terminal boundary for arbitrary Chrome results and Effect errors.
/* oxlint-disable anti-slop/no-unknown-parameters */
const log = (label: string, data: unknown) => {
  const text = data instanceof Error ? `${data.name}: ${data.message}` :
    JSON.stringify(data, (_key, item: unknown) => item instanceof Uint8Array ? Array.from(item) : item, 2)

  output.textContent = `[${new Date().toLocaleTimeString()}] ${label}\n${text}\n\n${output.textContent}`.slice(0, 24000)
}
/* oxlint-enable anti-slop/no-unknown-parameters */

type Services = ChromeStorage.ChromeStorage | ChromeRuntime.ChromeRuntime | ChromePort.ChromePort |
  // Pinned Effect 4.0.4 persistence service implemented by the Chrome storage adapter.
  // oxlint-disable-next-line effecttsgo/unstable-api-usage
  ChromeTabs.ChromeTabs | ChromeAlarms.ChromeAlarms | KeyValueStore.KeyValueStore

function button<A, E>(id: string, action: () => Effect.Effect<A, E, Services>) {
  const element = document.querySelector<HTMLButtonElement>(`#${id}`)!
  element.addEventListener("click", () => {
    element.disabled = true
    void runtime.runPromise(Effect.suspend(action).pipe(Effect.matchCause({
      onSuccess: (result) => log(id, result ?? "Done"),
      onFailure: (cause) => log(`${id}: error`, Cause.squash(cause))
    }))).finally(() => { element.disabled = false })
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
  // Pinned Effect 4.0.4 persistence API exercised by this adapter demo.
  // oxlint-disable-next-line effecttsgo/unstable-api-usage
  const kv = yield* KeyValueStore.KeyValueStore
  yield* kv.set("greeting", value())
  yield* kv.set("bytes", new Uint8Array([0, 1, 127, 128, 255]))

  return { string: yield* kv.get("greeting"), binary: yield* kv.getUint8Array("bytes"), size: yield* kv.size }
}))

button("kv-clear", () => Effect.gen(function*() {
  // Pinned Effect 4.0.4 persistence API exercised by this adapter demo.
  // oxlint-disable-next-line effecttsgo/unstable-api-usage
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

type BackgroundFiber = ReturnType<typeof runtime.runFork<void, never>>

const fibers = new Set<BackgroundFiber>()

const fork = (effect: Effect.Effect<void, never, Services>) => {
  const fiber = runtime.runFork(effect)
  fibers.add(fiber)
  fiber.addObserver(() => fibers.delete(fiber))

  return fiber
}

let port: ChromePort.Port | undefined

let portReady = false

let portFiber: BackgroundFiber | undefined

const PortGreeting = Schema.Struct({ type: Schema.Literal("connected"), bootId: Schema.String })

button("connect", () => Effect.sync(() => {
  if (portFiber) return "Already connected / connecting"
  portFiber = fork(Effect.scoped(Effect.gen(function*() {
    const service = yield* ChromePort.ChromePort
    const connection = yield* service.connect({ name: channel })
    port = connection
    // onConnect is gated during worker initialization. Wait for the server's
    // greeting instead of sending before it has adopted the native port.
    yield* Stream.runForEach(connection.messages, (message) => Effect.gen(function*() {
      log("port", message)
      const greeting = Schema.decodeUnknownOption(PortGreeting)(message)

      if (Option.isSome(greeting)) {
        portReady = true
        yield* connection.send({ text: "Hello from popup" })
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

button("open-playground", () => Effect.gen(function*() {
  const service = yield* ChromeRuntime.ChromeRuntime
  const tabs = yield* ChromeTabs.ChromeTabs
  const url = yield* service.getURL("popup.html")

  return yield* tabs.create({ url })
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

installModules(log)

installSidePanel(log)
