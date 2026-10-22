import { Deferred, Effect, Fiber, Option, Ref, Stream } from "effect"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as RpcClient from "effect/rpc/RpcClient"
import * as ChromeAlarms from "effect-platform-chrome/ChromeAlarms"
import * as ChromePermissions from "effect-platform-chrome/ChromePermissions"
import * as ChromePort from "effect-platform-chrome/ChromePort"
import * as ChromeRpc from "effect-platform-chrome/ChromeRpc"
import * as ChromeRuntime from "effect-platform-chrome/ChromeRuntime"
import * as ChromeSchemaStorage from "effect-platform-chrome/ChromeSchemaStorage"
import * as ChromeScripting from "effect-platform-chrome/ChromeScripting"
import * as ChromeStorage from "effect-platform-chrome/ChromeStorage"
import { channel, Request, Response } from "../../shared/protocol.js"
import { DemoRpc, rpcChannel } from "../../shared/rpc.js"
import { preferencesEntry } from "../../shared/schema-entry.js"
import { chromeMessage, type Frames, poll, type Stage } from "./limits-support.js"

// Stages for the original twelve modules, each driven to the Chrome limit it meets in
// practice: storage quotas, the alarm cap, the RPC frame limit, runtime messaging and
// port fan-out at volume, many schema-storage subscribers, and script injection.

const MB = 1024 * 1024
const prefix = "effect-wxt-limits/"

const demoClient = (options?: ChromeRpc.Options) => Effect.gen(function*() {
  const native = yield* Effect.acquireRelease(
    Effect.sync(() => chrome.runtime.connect({ name: rpcChannel })),
    (port) => Effect.sync(() => port.disconnect())
  )
  const protocol = yield* ChromeRpc.makeClientProtocol(chrome.runtime, native, "owned", options)
  return yield* RpcClient.make(DemoRpc).pipe(Effect.provideService(RpcClient.Protocol, protocol))
})

// Writes 1 MB items until the area refuses one, then removes everything it wrote.
const fillArea = (area: "local" | "session") => Effect.gen(function*() {
  const storage = yield* ChromeStorage.ChromeStorage
  const run = crypto.randomUUID()
  const value = "x".repeat(MB - 128)
  const written: Array<string> = []
  let refusal = ""
  for (let index = 0; index < 20 && refusal === ""; index++) {
    const key = `${prefix}quota/${area}/${run}/${index}`
    const result = yield* Effect.result(storage[area].set({ [key]: value }))
    if (result._tag === "Success") written.push(key)
    else refusal = chromeMessage(result.failure)
  }
  if (written.length > 0) yield* storage[area].remove(written)
  const left = Object.keys(yield* storage[area].get(written)).length
  return {
    completed: written.length,
    // Chrome words it "Resource::kQuotaBytes quota exceeded" (local) or "Session storage quota
    // bytes exceeded" (session).
    ok: /quota/i.test(refusal) && written.length >= 8 && written.length <= 10 && left === 0,
    details: { itemsOf1MB: written.length, refusal, left }
  }
})

// A port to the worker's echo handler; `seen` and `order` collect this client's echoed seqs.
const echoPort = (client: number) => Effect.gen(function*() {
  const ports = yield* ChromePort.ChromePort
  const port = yield* ports.connect({ name: channel })
  const greeted = yield* Deferred.make<void>()
  const seen = yield* Ref.make(new Set<number>())
  const order = yield* Ref.make<ReadonlyArray<number>>([])
  yield* Stream.runForEach(port.messages, (message) => Effect.gen(function*() {
    if (typeof message !== "object" || message === null || !("type" in message)) return
    if (message.type === "connected") yield* Deferred.succeed(greeted, undefined)
    if (message.type === "echo" && "message" in message && typeof message.message === "object" &&
      message.message !== null && "client" in message.message && message.message.client === client &&
      "seq" in message.message && typeof message.message.seq === "number") {
      const seq = message.message.seq
      yield* Ref.update(seen, (set) => new Set(set).add(seq))
      yield* Ref.update(order, (list) => [...list, seq])
    }
  })).pipe(Effect.forkScoped)
  yield* Deferred.await(greeted)
  return { port, seen, order }
})

export const originalModuleStages = (frames: Frames): Array<Stage> => [
  ["ChromeStorage local: 1 MB items until QUOTA_BYTES (10 MB)", 10, fillArea("local")],
  ["ChromeStorage session: 1 MB items until QUOTA_BYTES (10 MB)", 10, fillArea("session")],
  ["ChromeStorage sync: one item over QUOTA_BYTES_PER_ITEM (8 KB) is refused", 1, Effect.gen(function*() {
    // Only a write sync refuses outright: nothing reaches the signed-in profile's sync data.
    const storage = yield* ChromeStorage.ChromeStorage
    const result = yield* Effect.result(storage.sync.set({ [`${prefix}sync-oversized`]: "x".repeat(9000) }))
    const refusal = result._tag === "Failure" ? chromeMessage(result.failure) : ""
    return { completed: refusal === "" ? 0 : 1, ok: /QuotaBytesPerItem|QUOTA_BYTES_PER_ITEM/.test(refusal), details: { refusal } }
  })],
  ["ChromeKeyValueStore: 2000 keys (64 concurrent), then a 4 MB binary value", 2001, Effect.gen(function*() {
    const kv = yield* KeyValueStore.KeyValueStore
    yield* kv.clear
    yield* Effect.forEach(Array.from({ length: 2000 }), (_, index) => kv.set(`key-${index}`, `value-${index}`),
      { concurrency: 64, discard: true })
    const size = yield* kv.size
    const sample = yield* Effect.forEach([0, 999, 1999], (index) => kv.get(`key-${index}`))
    const bytes = new Uint8Array(4 * MB).map((_, index) => index % 251)
    yield* kv.set("binary", bytes)
    const read = yield* kv.getUint8Array("binary")
    const same = read !== undefined && read.length === bytes.length && read.every((byte, index) => byte === bytes[index])
    yield* kv.clear
    const left = yield* kv.size
    const sampled = sample.every((value, index) => value === `value-${[0, 999, 1999][index]}`)
    return { completed: size + (same ? 1 : 0), ok: size === 2000 && sampled && same && left === 0,
      details: { size, sampled, binaryRoundTrip: same, left } }
  })],
  ["ChromeAlarms: 600 one-hour alarms (Chrome's per-extension cap)", 600, Effect.gen(function*() {
    const alarms = yield* ChromeAlarms.ChromeAlarms
    const name = (index: number) => `${prefix}alarm/${index}`
    let refused = 0
    let refusal = ""
    for (let index = 0; index < 600; index++) {
      const result = yield* Effect.result(alarms.create(name(index), { delayInMinutes: 60 }))
      if (result._tag === "Failure") {
        refused++
        refusal ||= chromeMessage(result.failure)
      }
    }
    const ours = (yield* alarms.getAll).filter((alarm) => alarm.name.startsWith(`${prefix}alarm/`))
    yield* Effect.forEach(ours, (alarm) => alarms.clear(alarm.name), { concurrency: 32, discard: true })
    const left = (yield* alarms.getAll).filter((alarm) => alarm.name.startsWith(`${prefix}alarm/`)).length
    return { completed: ours.length, ok: left === 0 && ours.length + refused === 600,
      details: { active: ours.length, refused, refusal, left } }
  })],
  ["ChromeRuntime + ChromeServiceWorker: 10,000 concurrent sendMessage pings", 10000, Effect.gen(function*() {
    const runtime = yield* ChromeRuntime.ChromeRuntime
    const echoes = yield* Effect.forEach(Array.from({ length: 10000 }, (_, index) => String(index)), (text) =>
      runtime.sendMessageSchema(Request, Response, { channel, op: "ping", text }).pipe(
        Effect.map((response) => response.ok && JSON.stringify(response.value).includes(`"echo":"${text}"`))
      ), { concurrency: "unbounded" })
    const matched = echoes.filter(Boolean).length
    return { completed: matched, ok: matched === 10000 }
  })],
  ["ChromePort: 50 adopted ports x 200 echoes, in windows of 20", 10000, Effect.gen(function*() {
    // Both ends keep a 64-message sliding buffer, so each port keeps at most 20 in flight.
    const counts = yield* Effect.forEach(Array.from({ length: 50 }, (_, client) => client), (client) =>
      Effect.scoped(Effect.gen(function*() {
        const { port, seen } = yield* echoPort(client)
        for (let window = 0; window < 10; window++) {
          for (let seq = window * 20; seq < (window + 1) * 20; seq++) yield* port.send({ client, seq })
          yield* poll(Ref.get(seen).pipe(Effect.map((set) => set.size >= (window + 1) * 20 ? Option.some(true) : Option.none())), 200)
        }
        return (yield* Ref.get(seen)).size
      })), { concurrency: "unbounded" })
    const completed = counts.reduce((sum, count) => sum + count, 0)
    return { completed, ok: completed === 10000 }
  })],
  ["ChromePort: 2000 messages blasted at one port (64-message sliding buffers)", 2000, Effect.gen(function*() {
    // Past what either buffer holds, the oldest messages are dropped by design; what does
    // arrive must arrive once each, in order.
    const { port, seen, order } = yield* echoPort(-1)
    for (let seq = 0; seq < 2000; seq++) yield* port.send({ client: -1, seq })
    let last = -1
    for (;;) {
      yield* Effect.sleep("1 second")
      const size = (yield* Ref.get(seen)).size
      if (size === last || size === 2000) break
      last = size
    }
    const received = yield* Ref.get(order)
    const inOrder = received.every((seq, index) => index === 0 || seq > (received[index - 1] ?? 0))
    const unique = new Set(received).size === received.length
    return { completed: received.length, ok: received.length >= 64 && inOrder && unique,
      details: { sent: 2000, received: received.length, dropped: 2000 - received.length, inOrder, unique } }
  })],
  ["ChromeRpc: 2048 concurrent calls on one port", 2048, Effect.gen(function*() {
    const client = yield* demoClient()
    const echoes = yield* Effect.forEach(Array.from({ length: 2048 }, (_, index) => String(index)),
      (text) => client.Ping({ text }).pipe(Effect.map((echo) => echo === text)), { concurrency: "unbounded" })
    const matched = echoes.filter(Boolean).length
    return { completed: matched, ok: matched === 2048 }
  })],
  ["ChromeRpc: frames at the 1 MiB maxFrameLength default", 2, Effect.gen(function*() {
    // Under the limit the call round-trips; over it the client refuses before sending.
    const under = "u".repeat(1_000_000)
    const echoed = yield* Effect.scoped(Effect.flatMap(demoClient(), (client) => client.Ping({ text: under })))
    const over = yield* Effect.scoped(Effect.flatMap(demoClient(), (client) => client.Ping({ text: "o".repeat(1_100_000) })))
      .pipe(Effect.flip, Effect.map(chromeMessage))
    const fitted = echoed.length === under.length
    const refused = over.includes("oversized")
    return { completed: Number(fitted) + Number(refused), ok: fitted && refused,
      details: { underLimitChars: under.length, overLimitRefusal: over } }
  })],
  ["ChromeSchemaStorage: 256 subscribers follow 100 writes", 256, Effect.gen(function*() {
    const service = yield* ChromeSchemaStorage.ChromeSchemaStorage
    const entry = preferencesEntry(service, `wxt-limits-${crypto.randomUUID()}`)
    yield* Effect.addFinalizer(() => entry.remove.pipe(Effect.ignore))
    const latest = yield* Effect.forEach(Array.from({ length: 256 }), () => Effect.gen(function*() {
      const last = yield* Ref.make(-1)
      const ready = yield* Deferred.make<void>()
      const fiber = yield* Stream.runForEach(entry.observe, (value) => Effect.gen(function*() {
        yield* Deferred.succeed(ready, undefined)
        if (Option.isSome(value)) yield* Ref.set(last, value.value.revision)
      })).pipe(Effect.forkScoped)
      yield* Deferred.await(ready)
      return { last, fiber }
    }))
    for (let revision = 0; revision < 100; revision++) yield* entry.set({ text: "limits", revision })
    const caughtUp = yield* poll(Effect.gen(function*() {
      const revisions = yield* Effect.forEach(latest, ({ last }) => Ref.get(last))
      const count = revisions.filter((revision) => revision === 99).length
      return count === 256 ? Option.some(count) : Option.none()
    }), 200).pipe(Effect.orElseSucceed(() => 0))
    yield* Effect.forEach(latest, ({ fiber }) => Fiber.interrupt(fiber), { discard: true })
    return { completed: caughtUp, ok: caughtUp === 256 }
  })],
  ["ChromePermissions.contains x5000 (64 concurrent)", 5000, Effect.gen(function*() {
    const permissions = yield* ChromePermissions.ChromePermissions
    const answers = yield* Effect.forEach(Array.from({ length: 5000 }), () =>
      permissions.contains({ permissions: ["storage"] }), { concurrency: 64 })
    const granted = answers.filter(Boolean).length
    return { completed: granted, ok: granted === 5000 }
  })],
  ["ChromeScripting: 100 injections into all 7 frames of the target tab", 700, Effect.gen(function*() {
    const permissions = yield* ChromePermissions.ChromePermissions
    if (!(yield* permissions.contains({ origins: ["https://example.com/*"] }))) {
      return { completed: 0, ok: true, skipped: "Needs example.com access: click Request example.com access first" }
    }
    const scripting = yield* ChromeScripting.ChromeScripting
    let completed = 0
    for (let index = 0; index < 100; index++) {
      const results = yield* scripting.executeScript({
        target: { tabId: frames.target, allFrames: true },
        func: () => location.href
      })
      completed += results.filter((result) => typeof result.result === "string").length
    }
    return { completed, ok: completed === 700 }
  })]
]
