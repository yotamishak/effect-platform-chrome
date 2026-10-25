import { Cause, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import * as Action from "effect-platform-chrome/ChromeAction"
import * as Commands from "effect-platform-chrome/ChromeCommands"
import * as ContextMenus from "effect-platform-chrome/ChromeContextMenus"
import * as Idle from "effect-platform-chrome/ChromeIdle"
import * as Omnibox from "effect-platform-chrome/ChromeOmnibox"
import * as SidePanel from "effect-platform-chrome/ChromeSidePanel"
import * as TabCapture from "effect-platform-chrome/ChromeTabCapture"
import * as Tabs from "effect-platform-chrome/ChromeTabs"

export const uiModules: string[] = ["ChromeAction", "ChromeCommands", "ChromeContextMenus", "ChromeIdle", "ChromeOmnibox", "ChromeSidePanel", "ChromeTabCapture"]

export interface UiReport {
  module: string
  ok: boolean
  checks: Partial<Record<CheckName, number>>
  skips: string[]
  errors: string[]
}

type Report = UiReport

type EventName = "onClicked" | "onUserSettingsChanged" | "onCommand" | "onStateChanged"
  | "onInputStarted" | "onInputChanged" | "onInputEntered" | "onInputCancelled"
  | "onDeleteSuggestion" | "onOpened" | "onClosed" | "onStatusChanged"

type CheckName = `${EventName}: scoped registrations/removals`
  | "title/badge write-read rounds (4 calls each)"
  | "restoration and unchanged colors/popup/enabled/user settings"
  | "getAll successful reads" | "own hidden menu create/update/remove rounds"
  | "unsupported getAutoLockDelay returns typed error" | "queryState/getAutoLockDelay read pairs" | "queryState reads"
  | "pure inputChanged/suggest projection (local callback, not Chrome typing)"
  | "own-tab setOptions/getOptions pairs" | "owned tab closed"
  | "getCapturedTabs successful reads (contents not retained)"

const check = (condition: boolean, message: string) =>
  condition ? Effect.void : Effect.die(new Error(message))

interface EventSource<A extends unknown[]> {
  addListener(listener: (...args: A) => void): void
  removeListener(listener: (...args: A) => void): void
  hasListener(listener: (...args: A) => void): boolean
}

// Instrument only our listeners, forwarding registration to the real Chrome event.
// A gate acknowledges addListener; no sleeps, fabricated events, or scheduler guesses.
const churn = Effect.fnUntraced(function*<A extends unknown[], E>(
  report: Report,
  name: EventName,
  source: EventSource<A>,
  stream: (event: EventSource<A>) => Stream.Stream<unknown, E>,
  rounds = 100
) {
  for (let index = 0; index < rounds; index++) {
    const registered = yield* Deferred.make<void>()
    let added = 0
    let removed = 0

    const event: EventSource<A> = {
      addListener(listener) {
        source.addListener(listener)

        if (!source.hasListener(listener)) throw new Error(`${name}: registration missing`)
        added++
        Deferred.doneUnsafe(registered, Exit.void)
      },
      removeListener(listener) {
        source.removeListener(listener)

        if (source.hasListener(listener)) throw new Error(`${name}: listener leaked`)
        removed++
      },
      hasListener: (listener) => source.hasListener(listener)
    }

    yield* Effect.scoped(Effect.gen(function*() {
      const fiber = yield* Stream.runDrain(stream(event)).pipe(Effect.forkScoped)
      yield* Effect.raceFirst(Deferred.await(registered), Fiber.join(fiber)).pipe(Effect.timeout("5 seconds"))
      yield* Fiber.interrupt(fiber)
    }))
    yield* check(added === 1 && removed === 1, `${name}: expected one registration and removal`)
    report.checks[`${name}: scoped registrations/removals`] = index + 1
  }
})

const action = (report: Report) => Effect.gen(function*() {
  const api = yield* Action.ChromeAction

  const original = {
    title: yield* api.getTitle(), text: yield* api.getBadgeText(),
    background: yield* api.getBadgeBackgroundColor(), foreground: yield* api.getBadgeTextColor(),
    popup: yield* api.getPopup(), enabled: yield* api.isEnabled(), settings: yield* api.getUserSettings
  }

  // Preserve automatic text contrast: Chrome has no getter for whether a color is automatic.
  // Exercise color/settings reads without writing them, so their underlying mode is unchanged.
  yield* Effect.scoped(Effect.gen(function*() {
    yield* Effect.addFinalizer(() => Effect.gen(function*() {
      const results = yield* Effect.all([
        Effect.exit(api.setTitle({ title: original.title })),
        Effect.exit(api.setBadgeText({ text: original.text }))
      ])

      for (const result of results) {
        if (Exit.isFailure(result)) report.errors.push(`Action restore: ${Cause.pretty(result.cause)}`)
      }

      yield* check(results.every(Exit.isSuccess), "Action restoration failed").pipe(Effect.orDie)
    }))

    for (let i = 0; i < 50; i++) {
      const title = `Effect stress ${i}`
      const text = String(i)
      yield* api.setTitle({ title })
      yield* api.setBadgeText({ text })
      yield* check((yield* api.getTitle()) === title && (yield* api.getBadgeText()) === text, "Action round trip")
      report.checks["title/badge write-read rounds (4 calls each)"] = i + 1
    }
  }))
  yield* check((yield* api.getTitle()) === original.title && (yield* api.getBadgeText()) === original.text, "Action restoration")
  yield* check(JSON.stringify(yield* api.getBadgeBackgroundColor()) === JSON.stringify(original.background)
    && JSON.stringify(yield* api.getBadgeTextColor()) === JSON.stringify(original.foreground)
    && (yield* api.getPopup()) === original.popup && (yield* api.isEnabled()) === original.enabled
    && JSON.stringify(yield* api.getUserSettings) === JSON.stringify(original.settings), "Action unchanged settings/colors")
  report.checks["restoration and unchanged colors/popup/enabled/user settings"] = 1
  yield* churn(report, "onClicked", chrome.action.onClicked, (onClicked) => Action.make({ ...chrome.action, onClicked }).onClicked, 50)
  yield* churn(report, "onUserSettingsChanged", chrome.action.onUserSettingsChanged,
    (onUserSettingsChanged) => Action.make({ ...chrome.action, onUserSettingsChanged }).onUserSettingsChanged, 50)
  report.skips.push("setIcon: no original icon getter", "color setters: automatic contrast mode cannot be restored exactly",
    "popup/enabled/settings writes and openPopup: preserve current UI", "native action event delivery: no user click generated")
}).pipe(Effect.provide(Action.layerLive))

const commands = (report: Report) => Effect.gen(function*() {
  const api = yield* Commands.ChromeCommands

  for (let i = 0; i < 200; i++) {
    yield* api.getAll
    report.checks["getAll successful reads"] = i + 1
  }

  yield* churn(report, "onCommand", chrome.commands.onCommand, (onCommand) => Commands.make({ ...chrome.commands, onCommand }).onCommand)
  report.skips.push("native command delivery: no keyboard shortcut generated")
}).pipe(Effect.provide(Commands.layerLive))

const contextMenus = (report: Report) => Effect.gen(function*() {
  const api = yield* ContextMenus.ChromeContextMenus
  const prefix = `effect-ui-stress-${crypto.randomUUID()}`

  for (let i = 0; i < 100; i++) {
    yield* Effect.scoped(Effect.gen(function*() {
      const id = yield* Effect.acquireRelease(
        api.create({ id: `${prefix}-${i}`, title: "Effect stress", visible: false }),
        (id) => api.remove(id).pipe(Effect.orDie)
      )

      yield* check(id === `${prefix}-${i}`, "ContextMenus returned own id")
      yield* api.update(id, { title: `Effect stress ${i}`, enabled: false })
    }))
    report.checks["own hidden menu create/update/remove rounds"] = i + 1
  }

  yield* churn(report, "onClicked", chrome.contextMenus.onClicked, (onClicked) => ContextMenus.make({
    create: (properties, callback) => chrome.contextMenus.create(properties, callback),
    update: (id, properties) => chrome.contextMenus.update(id, properties),
    remove: (id) => chrome.contextMenus.remove(id), removeAll: () => chrome.contextMenus.removeAll(),
    get lastError() { return chrome.runtime.lastError }, onClicked
  }).onClicked)
  report.skips.push("removeAll: never invoked", "native click delivery: hidden owned items only")
}).pipe(Effect.provide(ContextMenus.layerLive))

const idle = (report: Report) => Effect.gen(function*() {
  const api = yield* Idle.ChromeIdle
  // ChromeOS-only native method may be absent despite Chrome's platform-wide types.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  const hasAutoLockDelay = typeof chrome.idle.getAutoLockDelay === "function"

  if (!hasAutoLockDelay) {
    const unavailable = yield* Effect.flip(api.getAutoLockDelay)
    yield* check(unavailable.operation === "getAutoLockDelay", "Unavailable auto lock delay keeps typed operation")
    report.checks["unsupported getAutoLockDelay returns typed error"] = 1
    report.skips.push("getAutoLockDelay: ChromeOS-only method is unavailable on this platform")
  }

  for (let i = 0; i < 100; i++) {
    const state = yield* api.queryState(15 + i)
    yield* check(["active", "idle", "locked"].includes(state), "Idle state")

    if (hasAutoLockDelay) yield* check((yield* api.getAutoLockDelay) >= 0, "Idle auto lock delay")
    report.checks[hasAutoLockDelay ? "queryState/getAutoLockDelay read pairs" : "queryState reads"] = i + 1
  }

  yield* churn(report, "onStateChanged", chrome.idle.onStateChanged, (onStateChanged) => Idle.make({ ...chrome.idle, onStateChanged }).onStateChanged)
  report.skips.push("setDetectionInterval: Chrome exposes no getter to restore the extension-wide interval", "native idle transitions: not induced")
}).pipe(Effect.provide(Idle.layerLive))

const omnibox = (report: Report) => Effect.gen(function*() {
  yield* Omnibox.ChromeOmnibox
  const native = chrome.omnibox
  yield* churn(report, "onInputStarted", native.onInputStarted, (onInputStarted) => Omnibox.make({ ...native, onInputStarted }).onInputStarted, 40)
  yield* churn(report, "onInputChanged", native.onInputChanged, (onInputChanged) => Omnibox.make({ ...native, onInputChanged }).onInputChanged, 40)
  yield* churn(report, "onInputEntered", native.onInputEntered, (onInputEntered) => Omnibox.make({ ...native, onInputEntered }).onInputEntered, 40)
  yield* churn(report, "onInputCancelled", native.onInputCancelled, (onInputCancelled) => Omnibox.make({ ...native, onInputCancelled }).onInputCancelled, 40)
  yield* churn(report, "onDeleteSuggestion", native.onDeleteSuggestion, (onDeleteSuggestion) => Omnibox.make({ ...native, onDeleteSuggestion }).onDeleteSuggestion, 40)

  for (let i = 0; i < 200; i++) {
    const row = { content: `stress-${i}`, description: "<match>Stress</match> &amp; validation", deletable: true, extra: i }
    let received: Omnibox.SuggestResult[] = []
    const event = Omnibox.inputChanged(row.content, (rows) => { received = rows })
    yield* event.suggest([row])
    yield* check(event.text === row.content && received.length === 1
      && JSON.stringify(received[0]) === JSON.stringify({ content: row.content, description: row.description, deletable: true }), "Pure suggestion projection")
    report.checks["pure inputChanged/suggest projection (local callback, not Chrome typing)"] = i + 1
  }

  report.skips.push("setDefaultSuggestion: persistent setting has no getter for restoration",
    "native typing/selection/suggest delivery and Chrome markup validation: no user omnibox session generated")
}).pipe(Effect.provide(Omnibox.layerLive))

const sidePanel = (report: Report) => Effect.gen(function*() {
  const api = yield* SidePanel.ChromeSidePanel
  const tabs = yield* Tabs.ChromeTabs
  yield* Effect.scoped(Effect.gen(function*() {
    const tab = yield* Effect.acquireRelease(tabs.create({ url: "about:blank", active: false }),
      (tab) => tab.id === undefined ? Effect.void : tabs.remove(tab.id).pipe(Effect.orDie))

    if (tab.id === undefined) return yield* Effect.die(new Error("Created tab has no id"))
    const tabId = tab.id
    yield* api.getOptions({ tabId })

    for (let i = 0; i < 100; i++) {
      const enabled = i % 2 === 0
      yield* api.setOptions({ tabId, path: "popup.html", enabled })
      const options = yield* api.getOptions({ tabId })
      yield* check(options.path === "popup.html" && options.enabled === enabled, "SidePanel own-tab options")
      report.checks["own-tab setOptions/getOptions pairs"] = i + 1
    }
  }))
  report.checks["owned tab closed"] = 1
  yield* churn(report, "onOpened", chrome.sidePanel.onOpened, (onOpened) => SidePanel.make({ ...chrome.sidePanel, onOpened }).onOpened, 50)
  yield* churn(report, "onClosed", chrome.sidePanel.onClosed, (onClosed) => SidePanel.make({ ...chrome.sidePanel, onClosed }).onClosed, 50)
  report.skips.push("open/openFromUserGesture: async stress runner has no true user gesture", "close/native panel events: panel was not opened", "setPanelBehavior/global options: preserve existing UI")
}).pipe(Effect.provide(Layer.merge(SidePanel.layerLive, Tabs.layerLive)))

const tabCapture = (report: Report) => Effect.gen(function*() {
  const api = yield* TabCapture.ChromeTabCapture

  for (let i = 0; i < 200; i++) {
    yield* api.getCapturedTabs
    report.checks["getCapturedTabs successful reads (contents not retained)"] = i + 1
  }

  yield* churn(report, "onStatusChanged", chrome.tabCapture.onStatusChanged,
    (onStatusChanged) => TabCapture.make({ ...chrome.tabCapture, onStatusChanged }).onStatusChanged)
  report.skips.push("capture/getMediaStreamId/media acquisition: requires user invocation; no tabs recorded", "native capture status delivery: no capture initiated")
}).pipe(Effect.provide(TabCapture.layerLive))

// Serialize invocations in this page so Action snapshots cannot overlap.
let pending: Promise<void> = Promise.resolve()

export async function runUiModule(name: string): Promise<UiReport> {
  const run = async () => {
    const report: Report = { module: name, ok: false, checks: {}, skips: [], errors: [] }

    const result = await Effect.runPromiseExit(runNamedModule(name, report))
    report.ok = Exit.isSuccess(result)

    if (Exit.isFailure(result)) report.errors.push(Cause.pretty(result.cause))

    return report
  }

  const result = pending.then(run, run)
  // The caller receives the report promise; the serialization gate only tracks completion.
  pending = result.then(() => undefined, () => undefined)

  return result
}

const runNamedModule = Effect.fn("stress.ui.module")(function*(name: string, report: Report) {
  switch (name) {
    case "ChromeAction": return yield* action(report)
    case "ChromeCommands": return yield* commands(report)
    case "ChromeContextMenus": return yield* contextMenus(report)
    case "ChromeIdle": return yield* idle(report)
    case "ChromeOmnibox": return yield* omnibox(report)
    case "ChromeSidePanel": return yield* sidePanel(report)
    case "ChromeTabCapture": return yield* tabCapture(report)
    default: return yield* Effect.die(new Error(`Unknown UI module: ${name}`))
  }
})
