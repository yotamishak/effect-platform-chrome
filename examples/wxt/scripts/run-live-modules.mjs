// Reuses a named agent-browser daemon; connection details and reports stay local.
// First run: npm run stress:live -- --port 62939 --extension <extension-id>
// Later: npm run stress:live -- ChromeBookmarks ChromeHistory
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"

const directory = fileURLToPath(new URL("../.browser-stress/", import.meta.url))

mkdirSync(directory, { recursive: true })

const configFile = `${directory}/connection.json`

const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : { session: "effect-chrome-stress" }

const names = []

for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index]

  if (argument === "--port" || argument === "--extension" || argument === "--session") {
    const value = process.argv[++index]

    if (!value) throw new Error(`${argument} requires a value`)
    config[argument.slice(2)] = value
  } else names.push(argument)
}

if (!config.port || !config.extension) throw new Error("First run needs --port and --extension")

writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`)

const browser = (...args) => execFileSync("npx", ["--yes", "agent-browser", "--session", config.session, ...args], {
  encoding: "utf8", timeout: 240000, maxBuffer: 16 * 1024 * 1024
}).trim()

const evaluate = (expression) => JSON.parse(browser("eval", expression))

const endpoint = browser("get", "cdp-url")

if (new URL(endpoint).port !== String(config.port)) browser("connect", String(config.port))

// A new, pinned runner tab keeps other browser tabs out of the automation path.
browser("tab", "new", `chrome-extension://${config.extension}/popup.html`)

browser("--pin-tab", "wait", "--fn", "!!window.effectChromeModules")

const selected = names.length ? names : evaluate("window.effectChromeModules.names")

const reports = []

let failed = false

const reportFile = `${directory}/report-${new Date().toISOString().replaceAll(":", "-")}.json`

for (const name of selected) {
  console.log(`START ${name}`)
  const token = randomUUID()

  try {
    evaluate(`(() => {
    const token = ${JSON.stringify(token)};
    window.effectChromeModuleRun = { running: true, token };
    window.effectChromeModules.run(${JSON.stringify(name)}).then(
      result => { window.effectChromeModuleRun = { running: false, token, result }; },
      error => { window.effectChromeModuleRun = { running: false, token, error: String(error) }; }
    );
    return true;
  })()`)
  } catch (error) {
    // A lost daemon response does not prove the mutation failed. Inspect its token;
    // never replay an uncertain resource-creating operation.
    const state = evaluate("window.effectChromeModuleRun ?? null")

    if (state?.token !== token) throw error
  }

  try {
    browser("wait", "--fn", "window.effectChromeModuleRun?.running === false", "--timeout", "180000")
  } catch (error) {
    reports.push({ module: name, error: String(error), incomplete: true })
    writeFileSync(reportFile, `${JSON.stringify(reports, null, 2)}\n`)
    throw new Error(`Module ${name} did not settle; stopped before starting another module. Report: ${reportFile}`, { cause: error })
  }

  const outcome = evaluate("window.effectChromeModuleRun")
  reports.push({ module: name, ...outcome })
  const report = outcome.result?.report

  if (outcome.error || (!report?.skipped && (report?.passed === false || report?.ok === false)) || report?.failed > 0
    || (Array.isArray(report?.checks) && report.checks.some(check => check.ok === false && !check.skipped))
    || report?.cleanup?.some(check => check.ok === false)) failed = true
  console.log(JSON.stringify({ module: name, ...outcome }))
  writeFileSync(reportFile, `${JSON.stringify(reports, null, 2)}\n`)
}

console.log(`Report: ${reportFile}`)

console.log(`Connection retained: ${config.session} (${config.port})`)

process.exitCode = failed ? 1 : 0
