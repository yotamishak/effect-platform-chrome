import { Cause, type Duration, Effect, Exit, ManagedRuntime, Option, Queue, Stream } from "effect"
import * as RpcClient from "effect/rpc/RpcClient"
import * as ChromeCookies from "effect-platform-chrome/ChromeCookies"
import * as ChromeIdentity from "effect-platform-chrome/ChromeIdentity"
import * as ChromeNotifications from "effect-platform-chrome/ChromeNotifications"
import * as ChromeRpc from "effect-platform-chrome/ChromeRpc"
import * as ChromeRuntime from "effect-platform-chrome/ChromeRuntime"
import * as ChromeStorage from "effect-platform-chrome/ChromeStorage"
import * as ChromeTabs from "effect-platform-chrome/ChromeTabs"
import * as ChromeWebNavigation from "effect-platform-chrome/ChromeWebNavigation"
import * as ChromeWindows from "effect-platform-chrome/ChromeWindows"
import { originalModuleStages } from "./limits-modules.js"
import {
  chromeMessage, errorText, type Frames, layer, type LimitsOptions, type LimitsReport, type LimitStage, poll,
  type Stage
} from "./limits-support.js"
import { cookieHost, finishPort, FrameRpc, framePort, plainPort, roleParam, targetOrigin, workPrefix, WorkRpc } from "../../shared/limits.js"

// Limits runner. Each stage drives one module or option to a real Chrome limit (a quota,
// a cap, a buffer, a timeout) and reports what it observed. Stages are independent: one
// failure does not stop the rest. This file holds the stages for the modules added after
// the original twelve; limits-modules.ts holds the original modules' stages.

declare global {
  interface Window { effectChromeLimits: { run: (options?: LimitsOptions) => Promise<LimitsReport> } }
}

// A 1x1 PNG, so the notification stage needs no packaged icon.
const icon = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

export function installLimits(log: (label: string, data: unknown) => void) {
  const runtime = ManagedRuntime.make(layer)

  const frameClient = (tabId: number, frameId: number, options: ChromeRpc.Options = { readyTimeout: "2 seconds" }) =>
    Effect.gen(function*() {
      const tabs = yield* ChromeTabs.ChromeTabs
      const native = yield* Effect.acquireRelease(
        tabs.connect(tabId, { name: framePort, frameId }),
        (port) => Effect.sync(() => port.disconnect())
      )
      const protocol = yield* ChromeRpc.makeClientProtocol(chrome.runtime, native, "owned", options)
      return yield* RpcClient.make(FrameRpc).pipe(Effect.provideService(RpcClient.Protocol, protocol))
    })

  const workClient = (name: string) => Effect.gen(function*() {
    const native = yield* Effect.acquireRelease(
      Effect.sync(() => chrome.runtime.connect({ name })),
      (port) => Effect.sync(() => port.disconnect())
    )
    const protocol = yield* ChromeRpc.makeClientProtocol(chrome.runtime, native, "owned")
    return yield* RpcClient.make(WorkRpc).pipe(Effect.provideService(RpcClient.Protocol, protocol))
  })

  // Opens the target tab (top frame, four serving children, one frame that listens but never
  // serves, one with no listener) and a navigation tab, both example.com in the background.
  const openTargets = Effect.gen(function*() {
    const tabs = yield* ChromeTabs.ChromeTabs
    const navigation = yield* ChromeWebNavigation.ChromeWebNavigation
    const target = yield* tabs.create({ url: `${targetOrigin}?${roleParam}=top&children=4`, active: false })
    const nav = yield* tabs.create({ url: `${targetOrigin}?${roleParam}=plain&n=start`, active: false })
    const all = yield* poll(navigation.getAllFrames(target.id ?? -1).pipe(
      Effect.map((frames) => frames.length === 7 ? Option.some(frames) : Option.none())
    ), 400)
    const roleOf = (url: string) => new URL(url).searchParams.get(roleParam)
    const find = (role: string) => all.filter((frame) => roleOf(frame.url) === role).map((frame) => frame.frameId)
    const frames: Frames = {
      target: target.id ?? -1, nav: nav.id ?? -1, top: 0, children: find("child"),
      other: find("other")[0] ?? -1, silent: find("silent")[0] ?? -1
    }
    // A frame serves once its script has run; wait until every serving frame answers.
    yield* Effect.forEach([frames.top, ...frames.children], (frameId) => poll(
      Effect.scoped(Effect.flatMap(frameClient(frames.target, frameId, { readyTimeout: "500 millis" }), (client) => client.Where())).pipe(
        Effect.option
      ), 100
    ), { discard: true })
    yield* poll(Effect.scoped(Effect.flatMap(frameClient(frames.nav, 0, { readyTimeout: "500 millis" }), (client) => client.Where())).pipe(Effect.option), 100)
    return frames
  })

  // Navigation events for one tab's top frame, queued from a running subscription.
  const subscribe = (stream: Stream.Stream<ChromeWebNavigation.Navigation, ChromeWebNavigation.ChromeWebNavigationError>, tabId: number) =>
    Effect.gen(function*() {
      const queue = yield* Queue.unbounded<string>()
      yield* Stream.runForEach(stream, (event) =>
        event.tabId === tabId && event.frameId === 0 ? Queue.offer(queue, event.url) : Effect.void
      ).pipe(Effect.forkScoped)
      return queue
    })
  const takeUntil = (queue: Queue.Queue<string>, suffix: string, timeout: Duration.Input) => Effect.gen(function*() {
    let seen = 0
    for (;;) {
      const url = yield* Queue.take(queue)
      seen++
      if (url.endsWith(suffix)) return seen
    }
  }).pipe(Effect.timeout(timeout))

  const stages = (frames: Frames, options: LimitsOptions): ReadonlyArray<Stage> => {
    const list: Array<Stage> = [
    ["webNavigation.getAllFrames x2000 (64 concurrent)", 2000, Effect.gen(function*() {
      const navigation = yield* ChromeWebNavigation.ChromeWebNavigation
      const counts = yield* Effect.forEach(Array.from({ length: 2000 }), () =>
        navigation.getAllFrames(frames.target).pipe(Effect.map((all) => all.length)), { concurrency: 64 })
      const exact = counts.filter((count) => count === 7).length
      return { completed: exact, ok: exact === 2000, details: { framesPerCall: 7 } }
    })],
    ["tabs.connect RPC fan-out: 5 frames x 400 echoes", 2000, Effect.gen(function*() {
      const results = yield* Effect.forEach([frames.top, ...frames.children], (frameId) => Effect.scoped(Effect.gen(function*() {
        const client = yield* frameClient(frames.target, frameId)
        const echoes = yield* Effect.forEach(Array.from({ length: 400 }, (_, index) => `${frameId}:${index}`),
          (text) => client.Echo({ text }).pipe(Effect.map((echo) => echo === text)), { concurrency: 16 })
        return echoes.filter(Boolean).length
      })), { concurrency: "unbounded" })
      const completed = results.reduce((sum, count) => sum + count, 0)
      return { completed, ok: completed === 2000 }
    })],
    ["tabs.connect port churn: 300 connect/echo/disconnect", 300, Effect.gen(function*() {
      let completed = 0
      for (let index = 0; index < 300; index++) {
        const echo = yield* Effect.scoped(Effect.flatMap(frameClient(frames.target, frames.children[0] ?? -1),
          (client) => client.Echo({ text: String(index) })))
        if (echo === String(index)) completed++
      }
      return { completed, ok: completed === 300 }
    })],
    ["readyTimeout: 20 ports to a frame that listens but never serves", 20, Effect.gen(function*() {
      const elapsed: Array<number> = []
      let timedOut = 0
      for (let index = 0; index < 20; index++) {
        const start = performance.now()
        const error = yield* Effect.flip(Effect.scoped(Effect.flatMap(
          frameClient(frames.target, frames.other, { readyTimeout: "300 millis" }), (client) => client.Echo({ text: "unanswered" })
        )))
        elapsed.push(performance.now() - start)
        if (errorText(error).includes("did not answer within")) timedOut++
      }
      const slowest = Math.max(...elapsed)
      const fastest = Math.min(...elapsed)
      // A hidden page's timers are throttled to about once a second, so only the lower bound
      // is exact; the upper bound only rules out a hang.
      return { completed: timedOut, ok: timedOut === 20 && fastest >= 290 && slowest < 10000,
        details: { readyTimeoutMs: 300, fastestMs: Math.round(fastest), slowestMs: Math.round(slowest) } }
    })],
    ["no listener: 50 ports to a frame without onConnect fail at once", 50, Effect.gen(function*() {
      const elapsed: Array<number> = []
      for (let index = 0; index < 50; index++) {
        const start = performance.now()
        yield* Effect.flip(Effect.scoped(Effect.flatMap(
          frameClient(frames.target, frames.silent, { readyTimeout: "5 seconds" }), (client) => client.Echo({ text: "nobody" })
        )))
        elapsed.push(performance.now() - start)
      }
      const slowest = Math.max(...elapsed)
      return { completed: elapsed.length, ok: slowest < 1000, details: { slowestMs: Math.round(slowest) } }
    })],
    ["onHistoryStateUpdated: 100 paced pushStates", 100, Effect.gen(function*() {
      const navigation = yield* ChromeWebNavigation.ChromeWebNavigation
      const queue = yield* subscribe(navigation.onHistoryStateUpdated, frames.target)
      const client = yield* frameClient(frames.target, 0)
      // The first push also proves the subscription is registered.
      yield* poll(Effect.gen(function*() {
        yield* client.PushStates({ from: -1, count: 1 })
        return yield* takeUntil(queue, "push=-1", "500 millis").pipe(Effect.option)
      }), 20)
      // The target tab is in the background, where Chrome throttles timers: allow a slow round trip.
      let completed = 0
      for (let index = 0; index < 100; index++) {
        yield* client.PushStates({ from: index, count: 1 })
        yield* takeUntil(queue, `push=${index}`, "10 seconds")
        completed++
      }
      return { completed, ok: completed === 100 }
    })],
    ["onHistoryStateUpdated: one burst of 500 pushStates (Chrome caps history updates)", 500, Effect.gen(function*() {
      const navigation = yield* ChromeWebNavigation.ChromeWebNavigation
      const queue = yield* subscribe(navigation.onHistoryStateUpdated, frames.target)
      const client = yield* frameClient(frames.target, 0)
      yield* poll(Effect.gen(function*() {
        yield* client.PushStates({ from: -2, count: 1 })
        return yield* takeUntil(queue, "push=-2", "500 millis").pipe(Effect.option)
      }), 20)
      // Chrome's IPC flooding protection allows about 200 history updates per 10 seconds and
      // ignores the rest (automation that passes --disable-ipc-flooding-protection lifts it).
      // So the burst counts what arrives until events stop for five seconds: every update
      // Chrome applied must arrive, and the newest one it applied must be the last received.
      const start = performance.now()
      const lastApplied = yield* client.PushStates({ from: 10000, count: 500 })
      const applied = lastApplied - 10000 + 1
      const urls: Array<string> = []
      for (;;) {
        const next = yield* Queue.take(queue).pipe(Effect.timeout("5 seconds"), Effect.option)
        if (Option.isNone(next)) break
        urls.push(next.value)
        if (next.value.endsWith(`push=${lastApplied}`)) break
      }
      const pushes = urls.map((url) => Number(new URL(url).searchParams.get("push"))).filter((push) => push >= 10000)
      const inOrder = pushes.every((push, index) => index === 0 || push > (pushes[index - 1] ?? 0))
      const seconds = (performance.now() - start) / 1000
      // Every update Chrome applied must arrive, in order: the stream drops nothing at this rate.
      return { completed: pushes.length, ok: applied > 0 && pushes.length === applied && inOrder,
        details: { burst: 500, appliedByChrome: applied, received: pushes.length, inOrder,
          eventsPerSecond: Math.round(pushes.length / Math.max(seconds, 0.001)) } }
    })],
    ["onCommitted: 50 sequential navigations", 50, Effect.gen(function*() {
      const navigation = yield* ChromeWebNavigation.ChromeWebNavigation
      const tabs = yield* ChromeTabs.ChromeTabs
      const queue = yield* subscribe(navigation.onCommitted, frames.nav)
      let completed = 0
      for (let index = 0; index < 50; index++) {
        yield* tabs.update(frames.nav, { url: `${targetOrigin}?${roleParam}=plain&n=${index}` })
        yield* takeUntil(queue, `n=${index}`, "5 seconds")
        completed++
      }
      return { completed, ok: completed === 50 }
    })],
    ["cookies: 120 set, read and removed (16 concurrent)", 120, Effect.gen(function*() {
      const cookies = yield* ChromeCookies.ChromeCookies
      const set = yield* Effect.forEach(Array.from({ length: 120 }), (_, index) => cookies.set({
        url: `https://${cookieHost}/`, name: `limits-${index}`, value: String(index), secure: true
      }), { concurrency: 16 })
      const stored = (yield* cookies.getAll({ domain: cookieHost })).length
      yield* Effect.forEach(yield* cookies.getAll({ domain: cookieHost }), cookies.removeCookie, { concurrency: 16, discard: true })
      const left = (yield* cookies.getAll({ domain: cookieHost })).length
      const accepted = set.filter(Option.isSome).length
      return { completed: stored, ok: accepted === 120 && stored === 120 && left === 0, details: { accepted, stored, left } }
    })],
    ["cookies: 400 on one host (Chrome's per-domain cap)", 400, Effect.gen(function*() {
      const cookies = yield* ChromeCookies.ChromeCookies
      for (let index = 0; index < 400; index++) {
        yield* cookies.set({ url: `https://${cookieHost}/`, name: `cap-${index}`, value: String(index), secure: true })
      }
      const kept = yield* cookies.getAll({ domain: cookieHost })
      const newest = kept.some((cookie) => cookie.name === "cap-399")
      yield* Effect.forEach(kept, cookies.removeCookie, { concurrency: 16, discard: true })
      return { completed: kept.length, ok: kept.length < 400 && newest,
        details: { set: 400, kept: kept.length, newestKept: newest, note: "Chrome evicts the oldest cookies past its per-domain cap" } }
    })],
    ["identity.getRedirectURL x10000", 10000, Effect.gen(function*() {
      const identity = yield* ChromeIdentity.ChromeIdentity
      let completed = 0
      for (let index = 0; index < 10000; index++) {
        const url = yield* identity.getRedirectURL(`limits/${index}`)
        if (url.startsWith("https://") && url.includes(".chromiumapp.org/") && url.endsWith(`limits/${index}`)) completed++
      }
      return { completed, ok: completed === 10000 }
    })],
    ["identity.launchWebAuthFlow: 10 non-interactive flows to an unreachable host", 10, Effect.gen(function*() {
      const identity = yield* ChromeIdentity.ChromeIdentity
      let typed = 0
      for (let index = 0; index < 10; index++) {
        const error = yield* Effect.flip(identity.launchWebAuthFlow({ url: "https://auth.invalid/authorize", interactive: false })
          .pipe(Effect.timeout("20 seconds")))
        if (error instanceof ChromeIdentity.ChromeIdentityError) typed++
      }
      return { completed: typed, ok: typed === 10 }
    })],
    ["windows.get / getCurrent x4000 (64 concurrent)", 4000, Effect.gen(function*() {
      const windows = yield* ChromeWindows.ChromeWindows
      const current = yield* windows.getCurrent()
      const ids = yield* Effect.forEach(Array.from({ length: 4000 }), (_, index) =>
        (index % 2 === 0 ? windows.get(current.id ?? -1) : windows.getCurrent()).pipe(Effect.map((window) => window.id)),
      { concurrency: 64 })
      const matching = ids.filter((id) => id === current.id).length
      return { completed: matching, ok: matching === 4000 }
    })],
    ["tabs.captureVisibleTab: burst of 8, then 4 paced (Chrome's per-second quota)", 12, Effect.gen(function*() {
      const tabs = yield* ChromeTabs.ChromeTabs
      const windows = yield* ChromeWindows.ChromeWindows
      const windowId = (yield* windows.getCurrent()).id ?? -1
      const probe = yield* Effect.result(tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 30 }))
      if (probe._tag === "Failure" && chromeMessage(probe.failure).includes("permission is required")) {
        return { completed: 0, ok: true, skipped: "Needs activeTab: open this popup from the toolbar button, not as a tab" }
      }
      yield* Effect.sleep("1500 millis")
      const burst = yield* Effect.forEach(Array.from({ length: 8 }), () =>
        Effect.result(tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 30 })), { concurrency: "unbounded" })
      const burstOk = burst.filter((result) => result._tag === "Success").length
      const quotaErrors = burst.filter((result) => result._tag === "Failure" &&
        chromeMessage(result.failure).includes("MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND")).length
      yield* Effect.sleep("1500 millis")
      let paced = 0
      const pacedErrors: Array<string> = []
      for (let index = 0; index < 4; index++) {
        const result = yield* Effect.result(tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 30 }))
        if (result._tag === "Success") paced++
        else pacedErrors.push(chromeMessage(result.failure))
        yield* Effect.sleep("700 millis")
      }
      return { completed: burstOk + paced, ok: paced === 4 && quotaErrors > 0 && burstOk + quotaErrors === 8,
        details: { burstSucceeded: burstOk, burstQuotaErrors: quotaErrors, pacedSucceeded: paced, pacedErrors } }
    })],
    ["storage.setAccessLevel: 400 alternations on local and session", 800, Effect.gen(function*() {
      const storage = yield* ChromeStorage.ChromeStorage
      let completed = 0
      for (let index = 0; index < 400; index++) {
        const level = index % 2 === 0 ? "TRUSTED_CONTEXTS" : "TRUSTED_AND_UNTRUSTED_CONTEXTS"
        yield* storage.local.setAccessLevel(level)
        yield* storage.session.setAccessLevel(level)
        completed += 2
      }
      // Chrome's defaults: local open to content scripts, session closed.
      yield* storage.local.setAccessLevel("TRUSTED_AND_UNTRUSTED_CONTEXTS")
      yield* storage.session.setAccessLevel("TRUSTED_CONTEXTS")
      return { completed, ok: completed === 800 }
    })],
    ["finishAccepted: 40 callers disconnect mid-call, with and without it", 80, Effect.gen(function*() {
      const storage = yield* ChromeStorage.ChromeStorage
      const run = crypto.randomUUID()
      const call = (port: string, id: string) => Effect.scoped(Effect.gen(function*() {
        const client = yield* workClient(port)
        // Long enough that even a throttled page disconnects well before the work finishes.
        yield* client.Work({ id, millis: 5000 }).pipe(Effect.forkScoped)
        // Disconnect only once the worker has accepted the call.
        yield* poll(storage.local.get(`${workPrefix}started/${id}`).pipe(
          Effect.map((items) => Object.keys(items).length > 0 ? Option.some(true) : Option.none())
        ), 400)
      }))
      const ids = (prefix: string) => Array.from({ length: 40 }, (_, index) => `${run}/${prefix}-${index}`)
      yield* Effect.forEach(ids("finish"), (id) => call(finishPort, id), { concurrency: 8, discard: true })
      yield* Effect.forEach(ids("plain"), (id) => call(plainPort, id), { concurrency: 8, discard: true })
      yield* Effect.sleep("6 seconds")
      const finishedOf = (prefix: string) => storage.local.get(ids(prefix).map((id) => `${workPrefix}finished/${id}`)).pipe(
        Effect.map((items) => Object.keys(items).length)
      )
      const finished = yield* finishedOf("finish")
      const interrupted = 40 - (yield* finishedOf("plain"))
      const keys = [...ids("finish"), ...ids("plain")].flatMap((id) => [`${workPrefix}started/${id}`, `${workPrefix}finished/${id}`])
      yield* storage.local.remove(keys)
      return { completed: finished + interrupted, ok: finished === 40 && interrupted === 40,
        details: { finishedWithFinishAccepted: finished, interruptedWithout: interrupted } }
    })],
    ]
    if (options.notifications) list.push(["notifications: 50 create/clear, then 200 updates of one id", 250, Effect.gen(function*() {
      const notifications = yield* ChromeNotifications.ChromeNotifications
      const base = { type: "basic", iconUrl: icon, title: "Effect Chrome limits", silent: true } as const
      let completed = 0
      for (let index = 0; index < 50; index++) {
        const id = yield* notifications.create({ ...base, message: `create ${index}` }, `effect-wxt-limits/${index}`)
        if (yield* notifications.clear(id)) completed++
      }
      for (let index = 0; index < 200; index++) {
        yield* notifications.create({ ...base, message: `update ${index}` }, "effect-wxt-limits/update")
        completed++
      }
      const cleared = yield* notifications.clear("effect-wxt-limits/update")
      return { completed, ok: completed === 250 && cleared }
    })])
    list.push(...originalModuleStages(frames))
    const only = options.only
    return only === undefined ? list : list.filter(([name]) => only.some((part) => name.includes(part)))
  }

  let running = false
  const run = async (options: LimitsOptions = {}): Promise<LimitsReport> => {
    if (running) throw new Error("Limits run already in progress")
    running = true
    const started = performance.now()
    const results: Array<LimitStage> = []
    const record = (stage: LimitStage) => { results.push(stage); log("limits stage", stage) }
    try {
      const opened = await runtime.runPromiseExit(openTargets.pipe(Effect.timeout("30 seconds")))
      if (Exit.isFailure(opened)) {
        record({ name: "open target tabs", ok: false, completed: 0, expected: 1, milliseconds: performance.now() - started,
          error: Cause.pretty(opened.cause) })
      } else {
        const frames = opened.value
        try {
          for (const [name, expected, effect] of stages(frames, options)) {
            const start = performance.now()
            const exit = await runtime.runPromiseExit(Effect.scoped(effect).pipe(Effect.timeout("120 seconds")))
            const milliseconds = Math.round(performance.now() - start)
            record(Exit.isSuccess(exit)
              ? { name, expected, milliseconds, ...exit.value }
              : { name, expected, milliseconds, ok: false, completed: 0, error: Cause.pretty(exit.cause).slice(0, 2000) })
          }
        } finally {
          await runtime.runPromise(Effect.flatMap(ChromeTabs.ChromeTabs, (tabs) => tabs.remove([frames.target, frames.nav]))
            .pipe(Effect.ignore))
        }
      }
    } finally { running = false }
    const report: LimitsReport = { stages: results, failed: results.filter((stage) => !stage.ok).length,
      skipped: results.filter((stage) => stage.skipped !== undefined).length,
      milliseconds: Math.round(performance.now() - started) }
    log("limits report", report)
    return report
  }
  window.effectChromeLimits = { run }
  const button = document.querySelector<HTMLButtonElement>("#limits")!
  button.addEventListener("click", () => {
    button.disabled = true
    const notifications = document.querySelector<HTMLInputElement>("#limits-notifications")?.checked ?? false
    void run({ notifications }).catch((error: unknown) => log("limits error", String(error)))
      .finally(() => { button.disabled = false })
  })
  window.addEventListener("pagehide", () => { void runtime.dispose() }, { once: true })
}
