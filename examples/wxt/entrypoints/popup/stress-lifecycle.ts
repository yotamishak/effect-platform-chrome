import { Cause, Effect, Exit, Layer, Option, Schema, Stream } from "effect"
import * as Debugger from "effect-platform-chrome/ChromeDebugger"
import * as DNR from "effect-platform-chrome/ChromeDeclarativeNetRequest"
import * as Offscreen from "effect-platform-chrome/ChromeOffscreen"
import * as Runtime from "effect-platform-chrome/ChromeRuntime"
import * as Tabs from "effect-platform-chrome/ChromeTabs"
import * as UserScripts from "effect-platform-chrome/ChromeUserScripts"
import * as WebRequest from "effect-platform-chrome/ChromeWebRequest"

export const lifecycleModules: string[] = ["ChromeDebugger", "ChromeOffscreen", "ChromeDeclarativeNetRequest", "ChromeWebRequest", "ChromeUserScripts"]

type CheckDetails = string | boolean[] | { commands: boolean; events: number }
  | { additions: number; removals: number; remaining: number }
  | { network: { status: number } | { error: string }; stream: string }

interface Check { name: string; ok: boolean; details?: CheckDetails | undefined }

export interface LifecycleReport { module: string; ok: boolean; checks: Check[]; cleanup: Check[]; skipped?: string; error?: string }

type Report = LifecycleReport

const run = Effect.runPromise

// Promise rejection values originate in browser APIs and may be arbitrary JavaScript values.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
const errorText = (error: unknown) => Cause.pretty(Cause.fail(error))

const check = (report: Report, name: string, ok: boolean, details?: CheckDetails) => {
  report.checks.push({ name, ok, details })
}

async function cleanup(report: Report, name: string, action: () => Promise<boolean>) {
  try { report.cleanup.push({ name, ok: await action() }) }
  catch (error) { report.cleanup.push({ name, ok: false, details: errorText(error) }) }
}

async function debuggerStress(report: Report) {
  const { debugger: service, tabs } = await run(Effect.gen(function*() {
    return { debugger: yield* Debugger.ChromeDebugger, tabs: yield* Tabs.ChromeTabs }
  }).pipe(Effect.provide(Layer.merge(Debugger.layerLive, Tabs.layerLive))))

  const tab = await run(tabs.create({ url: "about:blank", active: false }))

  if (tab.id === undefined) throw new Error("Created tab has no id")
  const tabId = tab.id

  const extensionDetached = async () => {
    // getTargets.attached includes agent-browser's CDP attachment, not just ours.
    // A command through THIS extension must fail once its scoped attachment ends.
    const exit = await Effect.runPromiseExit(service.sendCommand({ tabId }, "Runtime.evaluate", { expression: "1" }))

    return Exit.isFailure(exit) && Cause.pretty(exit.cause).includes("Debugger is not attached")
  }

  try {
    for (let cycle = 0; cycle < 4; cycle++) {
      // Session installs both native listeners before attach and buffers early CDP events.
      const result = await run(Effect.scoped(Effect.gen(function*() {
        const session = yield* service.session({ tabId }, "1.3")
        yield* session.sendCommand("Runtime.enable")

        const results = yield* Effect.forEach(Array.from({ length: 12 }, (_, i) => i), (i) =>
          session.sendCommand("Runtime.evaluate", { expression: `${i} + 1`, returnByValue: true }).pipe(
            Effect.flatMap((value) => Schema.decodeUnknownEffect(Schema.Struct({
              result: Schema.Struct({ type: Schema.Literal("number"), value: Schema.Finite })
            }))(Option.getOrUndefined(value))),
            Effect.map((value) => value.result.value === i + 1)
          ), { concurrency: 3 })

        const event = yield* session.events.pipe(
          Stream.filter((value) => value.method === "Runtime.executionContextCreated"),
          Stream.take(1), Stream.runCollect, Effect.timeout("5 seconds")
        )

        return { commands: results.every(Boolean), events: event.length }
      })))

      check(report, `session ${cycle}: 12 bounded commands and real event`, result.commands && result.events === 1, result)
      check(report, `session ${cycle}: extension detached after scope`, await extensionDetached())
    }
  } finally {
    // Session release runs on failure too. Retry detach only for our new tab if still attached.
    await cleanup(report, "owned debugger attachment released", async () => {
      if (!await extensionDetached()) {
        await run(service.detach({ tabId }))
      }

      return extensionDetached()
    })
    await cleanup(report, "owned debugger tab closed", async () => {
      await run(tabs.remove(tabId))

      return !(await run(tabs.query({}))).some((value) => value.id === tabId)
    })
  }
}

async function offscreenStress(report: Report) {
  const { service, runtime } = await run(Effect.gen(function*() {
    return { service: yield* Offscreen.ChromeOffscreen, runtime: yield* Runtime.ChromeRuntime }
  }).pipe(Effect.provide(Layer.merge(Offscreen.layerLive, Runtime.layerLive))))

  const contexts = () => run(runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }))

  if ((await contexts()).length > 0) {
    report.skipped = "Host already owns an offscreen document; left it open."

    return
  }

  const url = chrome.runtime.getURL(`stress-offscreen.html?owner=${crypto.randomUUID()}`)

  const parameters: Offscreen.CreateParameters = {
    url, reasons: ["DOM_PARSER"], justification: "Exercise owned offscreen DOM document lifecycle and concurrent ensure calls"
  }

  let ownedDocumentId: string | undefined
  let created = false

  try {
    // Unlike ensureDocument, successful createDocument proves this invocation created it.
    await run(service.createDocument(parameters))
    created = true
    ownedDocumentId = (await contexts()).find((context) => context.documentUrl === url)?.documentId
    check(report, "created owned offscreen context", ownedDocumentId !== undefined)
    const results = await run(Effect.forEach(Array.from({ length: 16 }), () => service.ensureDocument(parameters), { concurrency: 4 }))
    check(report, "16 concurrent ensures reuse document", results.every((value) => !value))
    check(report, "one owned context remains", (await contexts()).filter((context) => context.documentUrl === url).length === 1)
  } finally {
    if (created) await cleanup(report, "owned offscreen document closed", async () => {
      const current = await contexts()

      const owned = current.find((context) => context.documentUrl === url
        && (ownedDocumentId === undefined || context.documentId === ownedDocumentId))

      if (owned !== undefined) await run(service.closeDocument)

      return !(await contexts()).some((context) => context.documentUrl === url)
    })
  }
}

async function dnrStress(report: Report) {
  const service = await run(DNR.ChromeDeclarativeNetRequest.pipe(Effect.provide(DNR.layerLive)))
  const existing = [...await run(service.getDynamicRules()), ...await run(service.getSessionRules())]
  const occupied = new Set(existing.map((rule) => rule.id))
  const base = 1_900_000_000 + crypto.getRandomValues(new Uint32Array(1))[0]! % 100_000_000
  const ids = Array.from({ length: 8 }, (_, i) => base + i)

  if (ids.some((id) => occupied.has(id))) {
    report.skipped = "Reserved high rule IDs conflict with existing rules; no changes made."

    return
  }

  const host = `${crypto.randomUUID()}.example.invalid`

  const rules: DNR.Rule[] = ids.map((id) => ({
    id, priority: 1, action: { type: chrome.declarativeNetRequest.RuleActionType.BLOCK },
    condition: { urlFilter: `||${host}/rule-${id}`, resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST] }
  }))

  for (const kind of ["dynamic", "session"] as const) {
    const get = kind === "dynamic" ? service.getDynamicRules : service.getSessionRules
    const update = kind === "dynamic" ? service.updateDynamicRules : service.updateSessionRules
    let owned = false

    try {
      await run(update({ addRules: rules }))
      owned = true
      check(report, `${kind}: 8 owned rules registered`, (await run(get({ ruleIds: ids }))).length === ids.length)

      const outcomes = await run(Effect.forEach(ids, (id) => service.testMatchOutcome({
        url: `https://${host}/rule-${id}`, type: chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST
      }).pipe(Effect.map((matches) => matches.some((match) => match.ruleId === id
        && match.rulesetId === (kind === "dynamic" ? DNR.DYNAMIC_RULESET_ID : DNR.SESSION_RULESET_ID)))), { concurrency: 2 }))

      check(report, `${kind}: hypothetical reserved-host matches`, outcomes.every(Boolean), outcomes)
      await run(update({ removeRuleIds: ids, addRules: rules.map((rule) => ({ ...rule, priority: 2 })) }))
      const updated = await run(get({ ruleIds: ids }))
      check(report, `${kind}: owned rules updated`, updated.length === ids.length && updated.every((rule) => rule.priority === 2))
    } finally {
      if (owned) await cleanup(report, `${kind}: owned rules removed`, async () => {
        await run(update({ removeRuleIds: ids }))

        return (await run(get({ ruleIds: ids }))).length === 0
      })
    }
  }
}

async function userScriptsStress(report: Report) {
  if (!await run(UserScripts.isAvailable)) {
    report.skipped = UserScripts.unavailableMessage

    return
  }

  const service = await run(UserScripts.ChromeUserScripts.pipe(Effect.provide(UserScripts.layerLive)))
  const ids = Array.from({ length: 8 }, (_, i) => `wxt-lifecycle-${crypto.randomUUID()}-${i}`)

  if ((await run(service.getScripts({ ids }))).length !== 0) throw new Error("Owned script IDs conflict")
  let registered = false

  try {
    await run(service.register(ids.map((id) => ({
      id, matches: ["https://example.com/*"],
      // No page state changes, even if the user happens to navigate during this short registration.
      js: [{ code: "void 0" }], runAt: "document_idle"
    }))))
    registered = true
    check(report, "8 owned scripts registered", (await run(service.getScripts({ ids }))).length === ids.length)
    await run(Effect.forEach(ids, (id) => service.update([{ id, runAt: "document_start" }]), { concurrency: 2 }))
    const scripts = await run(service.getScripts({ ids }))
    check(report, "8 owned scripts updated", scripts.length === ids.length && scripts.every((script) => script.runAt === "document_start"))
  } finally {
    if (registered) await cleanup(report, "owned user scripts unregistered", async () => {
      await run(service.unregister({ ids }))

      return (await run(service.getScripts({ ids }))).length === 0
    })
  }
}

async function webRequestStress(report: Report) {
  for (let cycle = 0; cycle < 6; cycle++) {
    const url = `https://example.com/?wxt-lifecycle=${crypto.randomUUID()}`
    let ready!: () => void
    const registered = new Promise<void>((resolve) => { ready = resolve })
    let additions = 0
    let removals = 0
    let remaining = 0
    // Instrument an injected REAL Chrome event to synchronize registration and verify removal.
    const native = chrome.webRequest.onBeforeRequest
    const listeners = new Map<(details: WebRequest.BeforeRequest) => void, (details: WebRequest.BeforeRequest) => undefined>()

    const event: WebRequest.ChromeWebRequestApi["onBeforeRequest"] = {
      addListener(listener, filter, spec) {
        const callback = (details: WebRequest.BeforeRequest) => { listener(details);

 return undefined }

        listeners.set(listener, callback)
        native.addListener(callback, filter, spec)
        additions++
        remaining++
        ready()
      },
      removeListener(listener) {
        const callback = listeners.get(listener)

        if (callback === undefined) return
        native.removeListener(callback)
        removals++

        if (!native.hasListener(callback)) remaining--
        listeners.delete(listener)
      }
    }

    const api: WebRequest.ChromeWebRequestApi = {
      handlerBehaviorChanged: () => chrome.webRequest.handlerBehaviorChanged(),
      onBeforeRequest: event,
      onBeforeSendHeaders: chrome.webRequest.onBeforeSendHeaders,
      onSendHeaders: chrome.webRequest.onSendHeaders,
      onHeadersReceived: chrome.webRequest.onHeadersReceived,
      onAuthRequired: chrome.webRequest.onAuthRequired,
      onResponseStarted: chrome.webRequest.onResponseStarted,
      onCompleted: chrome.webRequest.onCompleted,
      onErrorOccurred: chrome.webRequest.onErrorOccurred,
      onBeforeRedirect: chrome.webRequest.onBeforeRedirect,
      onActionIgnored: chrome.webRequest.onActionIgnored
    }

    const controller = new AbortController()

    const observed = Effect.runPromiseExit(Effect.gen(function*() {
      const service = yield* WebRequest.ChromeWebRequest

      return yield* service.onBeforeRequest({ urls: [url] }).pipe(
        Stream.filter((details) => details.url === url), Stream.take(1), Stream.runCollect,
        Effect.timeout("10 seconds")
      )
    }).pipe(Effect.provide(WebRequest.layer(api))), { signal: controller.signal })

    try {
      await Promise.race([registered, observed.then((exit) => {
        if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
      })])

      const request = fetch(url, { cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(8_000) })
        .then(async (response) => { await response.body?.cancel();

 return { status: response.status } },
          // Fetch rejection is an untyped native browser boundary.
          // oxlint-disable-next-line anti-slop/no-unknown-parameters
          (error: unknown) => ({ error: errorText(error) }))

      const [exit, network] = await Promise.all([observed, request])
      check(report, `subscription ${cycle}: own request observed`, Exit.isSuccess(exit) && exit.value.length === 1,
        { network, stream: Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "received" })
    } finally {
      controller.abort()
      await observed
      report.cleanup.push({ name: `subscription ${cycle}: native listener removed`, ok: additions === 1 && removals === 1 && remaining === 0,
        details: { additions, removals, remaining } })
    }
  }
}

const running = new Set<string>()

export async function runLifecycleModule(name: string): Promise<LifecycleReport> {
  const report: Report = { module: name, ok: false, checks: [], cleanup: [] }

  if (running.has(name)) return { ...report, skipped: "This lifecycle module is already running." }
  running.add(name)

  try {
    switch (name) {
      case "ChromeDebugger": await debuggerStress(report); break
      case "ChromeOffscreen": await offscreenStress(report); break
      case "ChromeDeclarativeNetRequest": await dnrStress(report); break
      case "ChromeWebRequest": await webRequestStress(report); break
      case "ChromeUserScripts": await userScriptsStress(report); break
      default: throw new Error(`Unknown lifecycle module: ${name}`)
    }

    report.ok = report.skipped === undefined && report.checks.length > 0
      && report.checks.every((value) => value.ok) && report.cleanup.every((value) => value.ok)
  } catch (error) {
    report.error = errorText(error)
  } finally {
    running.delete(name)
  }

  return report
}
