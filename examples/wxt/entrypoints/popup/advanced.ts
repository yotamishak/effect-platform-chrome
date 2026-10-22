import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Option, Schema, Stream } from "effect"
import * as RpcClient from "effect/rpc/RpcClient"
import * as ChromeRpc from "effect-platform-chrome/ChromeRpc"
import * as ChromeStorage from "effect-platform-chrome/ChromeStorage"
import * as ChromeSchemaStorage from "effect-platform-chrome/ChromeSchemaStorage"
import * as ChromePermissions from "effect-platform-chrome/ChromePermissions"
import * as ChromeScripting from "effect-platform-chrome/ChromeScripting"
import * as ChromeTabs from "effect-platform-chrome/ChromeTabs"
import { DemoRpc, rpcChannel } from "../../shared/rpc.js"
import { preferencesEntry } from "../../shared/schema-entry.js"

export interface StressStage { readonly name: string; readonly completed: number; readonly milliseconds: number }
export interface StressReport {
  readonly stages: ReadonlyArray<StressStage>
  readonly errors: ReadonlyArray<string>
  readonly milliseconds: number
  readonly heapBefore?: number
  readonly heapAfter?: number
}
declare global {
  interface Window { effectChromeStress: { run: () => Promise<StressReport>; cancel: () => void } }
}

export function installAdvanced(log: (label: string, data: unknown) => void, value: () => string) {
  const storageLayer = ChromeStorage.layerLive
  const runtime = ManagedRuntime.make(Layer.mergeAll(
    storageLayer,
    ChromeSchemaStorage.layer.pipe(Layer.provide(storageLayer)),
    ChromePermissions.layerLive, ChromeScripting.layerLive, ChromeTabs.layerLive
  ))
  type Services = ChromeStorage.ChromeStorage | ChromeSchemaStorage.ChromeSchemaStorage |
    ChromePermissions.ChromePermissions | ChromeScripting.ChromeScripting | ChromeTabs.ChromeTabs
  const running = new Set<Fiber.Fiber<unknown, unknown>>()
  const run = <A, E>(effect: Effect.Effect<A, E, Services>) => {
    const fiber = runtime.runFork(effect)
    running.add(fiber)
    fiber.addObserver(() => running.delete(fiber))
    return Effect.runPromise(Fiber.join(fiber))
  }
  const button = <A, E>(id: string, action: () => Effect.Effect<A, E, Services>) => {
    const element = document.querySelector<HTMLButtonElement>(`#${id}`)!
    element.addEventListener("click", () => {
      element.disabled = true
      void run(Effect.suspend(action)).then((result) => log(id, result ?? "Done"),
        (error: unknown) => log(`${id}: error`, String(error))).finally(() => { element.disabled = false })
    })
  }
  const rpc = Effect.gen(function*() {
    // Acquire the native connection in the caller scope, including failure paths.
    const native = yield* Effect.acquireRelease(
      Effect.sync(() => chrome.runtime.connect({ name: rpcChannel })),
      (port) => Effect.sync(() => port.disconnect())
    )
    const protocol = yield* ChromeRpc.makeClientProtocol(chrome.runtime, native, "owned")
    return yield* RpcClient.make(DemoRpc).pipe(Effect.provideService(RpcClient.Protocol, protocol))
  })
  button("rpc-demo", () => Effect.scoped(Effect.gen(function*() {
    const client = yield* rpc
    const ping = yield* client.Ping({ text: value() })
    const failure = yield* Effect.flip(client.Fail())
    const numbers = yield* Stream.runCollect(client.Numbers().pipe(Stream.take(5)))
    return { ping, failure, numbers, note: "take(5) cancels remaining server stream; scope closes port" }
  })).pipe(Effect.timeout("15 seconds")))
  button("schema-write", () => Effect.gen(function*() {
    const service = yield* ChromeSchemaStorage.ChromeSchemaStorage
    const entry = preferencesEntry(service)
    yield* entry.set({ text: value(), revision: 1 })
    return yield* entry.get()
  }))
  button("schema-migrate", () => Effect.gen(function*() {
    const service = yield* ChromeSchemaStorage.ChromeSchemaStorage
    const storage = yield* ChromeStorage.ChromeStorage
    const entry = preferencesEntry(service)
    yield* storage.local.set({ [entry.storageKey]: { version: 0, payload: { greeting: value() } } })
    const migrated = yield* entry.get({ writeBack: true })
    return { migrated, envelope: yield* storage.local.get(entry.storageKey) }
  }))
  let observer: Fiber.Fiber<unknown, unknown> | undefined
  button("schema-subscribe", () => Effect.gen(function*() {
    if (observer) return "Already subscribed"
    const service = yield* ChromeSchemaStorage.ChromeSchemaStorage
    observer = runtime.runFork(Stream.runForEach(preferencesEntry(service).observe,
      (item) => Effect.sync(() => log("schema observed", item))))
    running.add(observer)
    observer.addObserver(() => { if (observer) running.delete(observer); observer = undefined })
    return "Subscribed; stop or close popup to remove listener"
  }))
  button("schema-stop", () => Effect.gen(function*() {
    if (observer) yield* Fiber.interrupt(observer)
    return "Subscription scope closed"
  }))
  const hosts = { origins: ["https://example.com/*"] }
  button("permissions", () => Effect.gen(function*() {
    const permissions = yield* ChromePermissions.ChromePermissions
    return { contains: yield* permissions.contains(hosts), all: yield* permissions.getAll }
  }))
  // Capture the service before the click. Never await runtime/layer initialization
  // inside the gesture before calling the eager native request bridge.
  const requestButton = document.querySelector<HTMLButtonElement>("#permission-request")!
  requestButton.disabled = true
  void runtime.runPromise(ChromePermissions.ChromePermissions).then((permissions) => {
    requestButton.disabled = false
    requestButton.addEventListener("click", () => {
      const result = permissions.requestFromUserGesture(hosts)
      void run(result).then((granted) => log("permission request", { granted }),
        (error: unknown) => log("permission request error", String(error)))
    })
  }, (error: unknown) => log("permissions initialization error", String(error)))
  button("scripting", () => Effect.gen(function*() {
    const tabs = yield* ChromeTabs.ChromeTabs
    const permissions = yield* ChromePermissions.ChromePermissions
    if (!(yield* permissions.contains(hosts))) return "Grant example.com host access first"
    const tab = (yield* tabs.query({ active: true, currentWindow: true, url: "https://example.com/*" }))[0]
    if (tab?.id === undefined) return "Activate an example.com tab first"
    const scripting = yield* ChromeScripting.ChromeScripting
    return yield* scripting.executeScript({ target: { tabId: tab.id },
      func: () => ({ title: document.title, url: location.href }) })
  }))

  const heap = (): number | undefined => {
    // Nonstandard Chrome memory API: coarse observation, not leak evidence.
    try { return Schema.decodeUnknownSync(Schema.Struct({ usedJSHeapSize: Schema.Number }))(
      Reflect.get(performance, "memory")).usedJSHeapSize } catch { return undefined }
  }
  let controller: AbortController | undefined
  const stress = async (): Promise<StressReport> => {
    if (controller) throw new Error("Stress already running")
    controller = new AbortController()
    const started = performance.now()
    const heapBefore = heap()
    const stages: Array<StressStage> = []
    const errors: Array<string> = []
    const stage = <A, E, R>(name: string, count: number, action: (index: number) => Effect.Effect<A, E, R>) =>
      Effect.gen(function*() {
        const start = performance.now()
        let completed = 0
        yield* Effect.gen(function*() {
          for (let index = 0; index < count; index++) { yield* action(index); completed++ }
        }).pipe(Effect.ensuring(Effect.sync(() => {
          const result = { name, completed, milliseconds: performance.now() - start }
          stages.push(result); log("stress stage", result)
        })))
      })
    const namespace = `wxt-stress-${crypto.randomUUID()}`
    try {
      await runtime.runPromise(Effect.scoped(Effect.gen(function*() {
        const client = yield* rpc
        for (const count of [100, 1000, 5000]) {
          yield* stage(`rpc-${count}`, count, (index) => client.Ping({ text: String(index) }).pipe(
            Effect.flatMap((echo) => echo === String(index) ? Effect.void : Effect.fail(new Error("RPC echo mismatch")))
          ))
        }
        yield* stage("stream-cancellation", 20, () => Effect.gen(function*() {
          const numbers = yield* Stream.runCollect(client.Numbers().pipe(Stream.take(5)))
          if (numbers.length !== 5 || numbers[4] !== 4) return yield* Effect.fail(new Error("Stream mismatch"))
        }))
        yield* stage("typed-failure", 20, () => Effect.flip(client.Fail()).pipe(
          Effect.flatMap((error) => error._tag === "DemoRejected" ? Effect.void : Effect.fail(new Error("Wrong RPC error")))
        ))
        const service = yield* ChromeSchemaStorage.ChromeSchemaStorage
        const entry = preferencesEntry(service, namespace)
        yield* Effect.addFinalizer(() => entry.remove.pipe(Effect.orDie))
        yield* stage("schema-local-churn", 1000, (index) => Effect.scoped(Effect.gen(function*() {
          // Initial observation is the registration gate, not a guessed sleep.
          const ready = yield* Deferred.make<void>()
          const listener = yield* Stream.runForEach(entry.observe, () => Deferred.succeed(ready, undefined)).pipe(Effect.forkScoped)
          yield* Deferred.await(ready)
          yield* entry.set({ text: "stress", revision: index })
          const read = yield* entry.get()
          if (Option.isNone(read) || read.value.revision !== index) return yield* Effect.fail(new Error("Storage mismatch"))
          yield* Fiber.interrupt(listener)
          yield* entry.remove
        })))
      })).pipe(Effect.timeout("5 minutes")), { signal: controller.signal })
    } catch (error) { errors.push(String(error)) }
    finally { controller = undefined }
    const heapAfter = heap()
    const report: StressReport = { stages, errors, milliseconds: performance.now() - started,
      ...(heapBefore === undefined ? {} : { heapBefore }), ...(heapAfter === undefined ? {} : { heapAfter }) }
    log("stress report", report)
    return report
  }
  window.effectChromeStress = { run: stress, cancel: () => controller?.abort() }
  button("stress", () => Effect.promise(stress))
  button("stress-cancel", () => Effect.sync(() => window.effectChromeStress.cancel()))
  window.addEventListener("pagehide", () => {
    controller?.abort()
    void Effect.runPromise(Fiber.interruptAll([...running])).then(() => runtime.dispose())
  }, { once: true })
}
