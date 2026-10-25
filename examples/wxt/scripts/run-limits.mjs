// Runs the limits runner (and, with --stress, the original stress runner) headlessly against
// the production build: `npm run build && npm run limits`. Playwright passes
// --disable-ipc-flooding-protection, which lifts Chrome's history-update cap, and example.com is
// served locally so the run needs no network. Exits non-zero when a stage fails.
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

const extension = fileURLToPath(new URL("../.output/chrome-mv3", import.meta.url))

const stress = process.argv.includes("--stress")

const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
})

await context.route("https://example.com/**", (route) => route.fulfill({
  contentType: "text/html",
  body: "<!doctype html><html><head><title>Example Domain</title></head><body><h1>Example Domain</h1></body></html>"
}))

let failed = 0

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"))
  const page = await context.newPage()
  page.on("pageerror", (error) => console.error("pageerror:", error.message))
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`)
  await page.waitForFunction(() => window.effectChromeLimits !== undefined)
  const report = await page.evaluate(() => window.effectChromeLimits.run({ notifications: true }))

  for (const stage of report.stages) {
    const status = stage.skipped ? "SKIP" : stage.ok ? "PASS" : "FAIL"
    const details = stage.details ? ` ${JSON.stringify(stage.details)}` : ""
    const why = stage.skipped ? ` (${stage.skipped})` : stage.error ? `\n  ${stage.error.split("\n").slice(0, 4).join("\n  ")}` : ""
    console.log(`${status} ${stage.name}: ${stage.completed}/${stage.expected} in ${stage.milliseconds} ms${details}${why}`)
  }

  console.log(`${report.failed} failed, ${report.skipped} skipped, ${report.milliseconds} ms`)
  failed = report.failed

  if (stress) {
    const result = await page.evaluate(() => window.effectChromeStress.run())
    console.log("stress:", JSON.stringify(result))
    failed += result.errors.length
  }
} finally {
  await context.close()
}

process.exit(failed === 0 ? 0 : 1)
