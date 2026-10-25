import { dataModules, runDataModule, type DataReport } from "./stress-data.js"
import { lifecycleModules, runLifecycleModule, type LifecycleReport } from "./stress-lifecycle.js"
import { uiModules, runUiModule, type UiReport } from "./stress-ui.js"
import { regressionModules, runRegressionModule, type RegressionReport } from "./stress-regressions.js"
import { utilityModules, runUtilityModule, type UtilityReport } from "./stress-utilities.js"
import type { LimitsReport } from "./limits-support.js"
import { element } from "./view.js"

const limits = new Map<string, ReadonlyArray<string>>([
  ["ChromeRuntime", ["ChromeRuntime"]],
  ["ChromeServiceWorker", ["finishAccepted:"]],
  ["ChromeStorage", ["ChromeStorage ", "storage.setAccessLevel:"]],
  ["ChromeKeyValueStore", ["ChromeKeyValueStore:"]],
  ["ChromeAlarms", ["ChromeAlarms:"]],
  ["ChromePort", ["ChromePort:"]],
  ["ChromeRpc", ["ChromeRpc:", "readyTimeout:", "no listener:"]],
  ["ChromeSchemaStorage", ["ChromeSchemaStorage:"]],
  ["ChromePermissions", ["ChromePermissions.contains"]],
  ["ChromeScripting", ["ChromeScripting:"]],
  ["ChromeTabs", ["tabs.connect", "tabs.captureVisibleTab:"]],
  ["ChromeWebNavigation", ["webNavigation.", "onHistoryStateUpdated:", "onCommitted:"]],
  ["ChromeCookies", ["cookies:"]],
  ["ChromeIdentity", ["identity."]],
  ["ChromeWindows", ["windows."]],
  ["ChromeNotifications", ["notifications:"]]
])

const descriptions = new Map([
  ["ChromeAction", "Round-trip title and badge values, restore the original UI, and exercise scoped action listeners."],
  ["ChromeBookmarks", "Create an owned bookmark tree, move entries, check errors, and clean it up."],
  ["ChromeCommands", "Read registered commands and churn scoped listeners. Native shortcut presses remain manual."],
  ["ChromeContextMenus", "Create, update and remove hidden owned menu items, with scoped click listeners."],
  ["ChromeCookies", "Exercise cookie lifecycle, per-domain limits and native path normalization on the reserved test host."],
  ["ChromeDebugger", "Attach to an owned tab, send CDP commands, observe events, and detach on scope closure."],
  ["ChromeDeclarativeNetRequest", "Register, match, update and remove owned dynamic and session rules."],
  ["ChromeDownloads", "Download a tiny test file, verify completion and error paths, then remove its file and record."],
  ["ChromeHistory", "Add unique test URLs, inspect visits, and delete only the owned history entries."],
  ["ChromeI18n", "Inspect language settings and exercise message lookup, detection, and missing input."],
  ["ChromeIdentity", "Generate redirect URLs and verify typed noninteractive authentication failures."],
  ["ChromeIdle", "Read idle state and exercise scoped listeners. Platform-only APIs report their availability."],
  ["ChromeManagement", "Read this extension's metadata and extension inventory without changing other extensions."],
  ["ChromeMessage", "Validate 5,000 JSON envelopes: values, failures, void replies and malformed messages."],
  ["ChromeNotifications", "Create, update and clear real OS notifications. Running this test can display notifications."],
  ["ChromeOffscreen", "Create an owned offscreen document, stress concurrent ensure calls, and verify cleanup."],
  ["ChromeOmnibox", "Exercise scoped input listeners and local suggestion projection. Native typing remains manual."],
  ["ChromeSessions", "Read recently closed sessions and devices, and check invalid limits. Nothing is restored."],
  ["ChromeTabCapture", "Read capture inventory and exercise scoped status listeners. This test does not record tabs."],
  ["ChromeTabGroups", "Group owned tabs, round-trip metadata, ungroup, and verify the empty group disappears."],
  ["ChromeTesting", "Run 100 fresh storage, event and port fixtures in the browser. These are not native Chrome calls."],
  ["ChromeUserScripts", "Register, update and unregister owned no-op scripts. Chrome's Allow User Scripts toggle is required."],
  ["ChromeWebNavigation", "Inspect frame trees, navigation and history events, including Chrome's update cap."],
  ["ChromeWebRequest", "Observe real example.com requests and verify each native listener is removed."],
  ["ChromeWindows", "Stress current-window and window metadata reads without changing your windows."]
])

type Report = DataReport | LifecycleReport | UiReport | RegressionReport | UtilityReport | LimitsReport

interface ModuleResult {
  readonly module: string
  readonly milliseconds: number
  readonly report: Report
}

interface Outcome {
  readonly state: "passed" | "failed" | "skipped"
  readonly text: string
}

interface Card {
  readonly container: HTMLElement
  readonly status: HTMLElement
  readonly output: HTMLPreElement
  readonly actions: HTMLElement
}

declare global {
  interface Window {
    effectChromeModules: {
      readonly names: ReadonlyArray<string>
      readonly run: (name: string) => Promise<ModuleResult>
    }
  }
}

function outcome(report: Report): Outcome {
  if ("stages" in report) {
    if (report.failed > 0) return { state: "failed", text: `${report.failed} failed stage(s)` }

    return { state: "passed", text: report.skipped > 0 ? `Passed · ${report.skipped} skipped stage(s)` : "Passed" }
  }

  if ("skipped" in report && report.skipped !== undefined) return { state: "skipped", text: report.skipped }

  const passed = "ok" in report ? report.ok : report.passed

  if (!passed) return { state: "failed", text: "Failed · inspect results" }

  return { state: "passed", text: "skips" in report && report.skips.length > 0 ? "Passed · some operations skipped" : "Passed" }
}

async function runReport(name: string): Promise<Report> {
  const only = limits.get(name)

  if (only !== undefined) return window.effectChromeLimits.run({ only, notifications: name === "ChromeNotifications" })

  if (dataModules.includes(name)) return runDataModule(name)

  if (lifecycleModules.includes(name)) return runLifecycleModule(name)

  if (uiModules.includes(name)) return runUiModule(name)

  if (utilityModules.includes(name)) return runUtilityModule(name)

  return runRegressionModule(name)
}

function makeCard(name: string, grid: HTMLElement): Card {
  const container = document.querySelector<HTMLElement>(`[data-module="${name}"]`) ?? document.createElement("section")

  if (!container.hasAttribute("data-module")) {
    const title = document.createElement("h2")
    const description = document.createElement("p")
    title.textContent = name
    description.textContent = descriptions.get(name) ?? "Run this module's bounded integration checks and inspect the results."
    container.className = "module-card"
    container.dataset.module = name
    container.append(title, description)
  }

  const actions = document.createElement("div")
  const status = document.createElement("span")
  const details = document.createElement("details")
  const summary = document.createElement("summary")
  const output = document.createElement("pre")
  actions.className = "module-stress"
  status.className = "module-status"
  status.setAttribute("role", "status")
  status.textContent = "Not run"
  summary.textContent = "Last test result"
  output.textContent = "Run this module to see its counts, checks and cleanup results."
  actions.append(status)
  details.append(summary, output)
  container.append(actions, details)
  grid.append(container)

  return { container, status, output, actions }
}

export function installModules(log: (label: string, data: ModuleResult | string) => void) {
  const names = [...limits.keys(), ...dataModules, ...lifecycleModules, ...uiModules, ...utilityModules, ...regressionModules]
  const moduleNames = names.filter((name) => !name.endsWith("-edgecases")).sort()
  const grid = element("#module-grid")
  const cards = new Map(moduleNames.map((name) => [name, makeCard(name, grid)]))
  const controls: HTMLButtonElement[] = []
  let running = false

  const run = async (name: string): Promise<ModuleResult> => {
    if (running) throw new Error("A module stress run is already in progress")

    if (!names.includes(name)) throw new Error(`Unknown stress module: ${name}`)

    running = true

    const card = cards.get(name.replace(/-edgecases$/, ""))
    const started = performance.now()

    for (const control of controls) control.disabled = true

    if (card !== undefined) {
      card.container.dataset.state = "running"
      card.status.textContent = name.endsWith("-edgecases") ? "Probing edge cases…" : "Running…"
    }

    try {
      const report = await runReport(name)
      const result = { module: name, milliseconds: Math.round(performance.now() - started), report }
      const status = outcome(report)

      if (card !== undefined) {
        card.container.dataset.state = status.state
        card.status.textContent = `${status.text} · ${result.milliseconds} ms`
        card.output.textContent = JSON.stringify(result, null, 2)
      }

      log("module stress", result)

      return result
    } catch (error) {
      if (card !== undefined) {
        card.container.dataset.state = "failed"
        card.status.textContent = "Run failed"
        card.output.textContent = String(error)
      }

      throw error
    } finally {
      running = false

      for (const control of controls) control.disabled = false
    }
  }

  window.effectChromeModules = { names, run }

  for (const name of names) {
    const card = cards.get(name.replace(/-edgecases$/, ""))

    if (card === undefined) continue

    const button = document.createElement("button")
    button.textContent = name.endsWith("-edgecases") ? "Probe edge cases" : "Run stress test"
    button.dataset.stressRun = name
    button.setAttribute("aria-label", `${button.textContent}: ${name}`)
    button.addEventListener("click", () => {
      void run(name).catch((error) => log("module stress error", String(error)))
    })
    controls.push(button)
    card.actions.insertBefore(button, card.status)
  }

  const search = element<HTMLInputElement>("#module-search")
  const count = element("#module-count")
  const empty = element("#no-modules")

  const filter = () => {
    const query = search.value.trim().toLowerCase()
    let visible = 0

    for (const [name, card] of cards) {
      const matches = name.toLowerCase().includes(query)
      card.container.hidden = !matches

      if (matches) visible++
    }

    count.textContent = `${visible} / ${cards.size} modules`
    empty.hidden = visible > 0
  }

  search.addEventListener("input", filter)
  filter()
}
