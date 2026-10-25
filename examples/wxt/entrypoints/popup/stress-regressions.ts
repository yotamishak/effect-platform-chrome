import { Cause, Effect, Exit, Layer, Match, Option, Predicate, Schema } from "effect"
import * as ChromeCookies from "effect-platform-chrome/ChromeCookies"
import * as ChromeSchemaStorage from "effect-platform-chrome/ChromeSchemaStorage"
import * as ChromeStorage from "effect-platform-chrome/ChromeStorage"
import { cookieHost } from "../../shared/limits.js"

export const regressionModules: Array<string> = ["ChromeSchemaStorage-edgecases", "ChromeCookies-edgecases"]

interface Check {
  readonly name: string
  readonly ok: boolean
  readonly details?: RegressionDetails
  readonly error?: string | undefined
}

interface RegressionDetails {
  readonly storageKey?: string
  readonly remainingKeys?: string[]
  readonly area?: "local" | "session"
  readonly expectedJson?: string
  readonly actualJson?: string | null
  readonly missing?: boolean
  readonly remaining?: readonly ChromeCookies.Cookie[]
  readonly requestedPath?: string
  readonly storedPath?: string
  readonly setReturnedPath?: string
  readonly normalized?: boolean
  readonly before?: readonly ChromeCookies.Cookie[]
  readonly after?: readonly ChromeCookies.Cookie[]
  readonly reason?: string
  readonly path?: string
  readonly removalUrl?: string
  readonly rootRemoved?: boolean
  readonly semantics?: string
  readonly name?: string
  readonly expirationDate?: number
  readonly names?: string[]
}

export interface RegressionReport {
  name: string
  run: string
  ok: boolean
  passed: number
  failed: number
  checks: Check[]
  milliseconds: number
}

// Compare JSON structurally: Chrome may return object properties in a different order.
const canonical = (value: Schema.Json): string => {
  if (value === null || Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)) return JSON.stringify(value)

  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`

  return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`
}

// This is the diagnostic boundary: defects and cleanup failures must also be reported.
const record = <E, R>(checks: Array<Check>, name: string, effect: Effect.Effect<Omit<Check, "name">, E, R>) =>
  Effect.gen(function*() {
    const exit = yield* Effect.exit(effect)
    checks.push(Exit.isSuccess(exit)
      ? { name, ...exit.value }
      : { name, ok: false, error: Cause.pretty(exit.cause) })
  })

const schemaRegressions = (checks: Array<Check>, run: string) => Effect.gen(function*() {
  const storage = yield* ChromeStorage.ChromeStorage
  const schemas = yield* ChromeSchemaStorage.ChromeSchemaStorage

  const cases: ReadonlyArray<readonly [string, Schema.Json]> = [
    ["valid Unicode control", "Hello 🌍 café 中文 \ufffd"],
    ["lone high surrogate", "before\ud800after"],
    ["lone low surrogate", "before\udfffafter"],
    ["nested key collision", { nested: { "\ud800": "surrogate-key", "\ufffd": "replacement-key" } }]
  ]

  for (const area of ["local", "session"] as const) {
    for (const [label, expected] of cases) {
      const entry = schemas.entry({ namespace: `wxt-regression/${run}`, key: label, area, version: 0, schema: Schema.Json })
      yield* record(checks, `${area}: ${label}`, Effect.scoped(Effect.gen(function*() {
        // Registered before writing, including a write which mutates then rejects.
        yield* Effect.addFinalizer(() => Effect.gen(function*() {
          yield* record(checks, `${area}: ${label}: cleanup remove`, entry.remove.pipe(Effect.as({ ok: true })))
          yield* record(checks, `${area}: ${label}: cleanup verified`, Effect.map(storage[area].get(entry.storageKey), (items) => ({
            ok: !Object.hasOwn(items, entry.storageKey), details: { storageKey: entry.storageKey, remainingKeys: Object.keys(items) }
          })))
        }))
        yield* entry.set(expected)
        const actual = yield* entry.get()

        return {
          ok: Option.isSome(actual) && canonical(actual.value) === canonical(expected),
          details: {
            area, storageKey: entry.storageKey, expectedJson: canonical(expected),
            actualJson: Option.isSome(actual) ? canonical(actual.value) : null,
            missing: Option.isNone(actual)
          }
        }
      })))
    }
  }
}).pipe(Effect.provide(ChromeSchemaStorage.layer.pipe(Layer.provideMerge(ChromeStorage.layerLive))))

const cookieRegressions = (checks: Array<Check>, run: string) => Effect.gen(function*() {
  const cookies = yield* ChromeCookies.ChromeCookies
  const names: Array<string> = []

  for (const [index, path] of ["/a?b", "/a#b", "/a/../b"].entries()) {
    const name = `effect-regression-${run}-${index}`
    names.push(name)
    const base = { url: `https://${cookieHost}/`, name, secure: true }
    yield* record(checks, `cookie ${path}: exercise`, Effect.scoped(Effect.gen(function*() {
      const cleanupPaths = new Set([path, "/"])
      yield* Effect.addFinalizer(() => Effect.gen(function*() {
        // Expire both submitted and returned paths using the original valid URL.
        // Never rely on the removal helper under test for cleanup.
        for (const cleanupPath of cleanupPaths) {
          yield* record(checks, `cookie ${path}: expire ${cleanupPath}`, cookies.set({
            ...base, path: cleanupPath, value: "", expirationDate: 1
          }).pipe(Effect.as({ ok: true })))
        }

        yield* record(checks, `cookie ${path}: cleanup verified`, Effect.map(cookies.getAll({ domain: cookieHost, name }), (remaining) => ({
          ok: remaining.length === 0, details: { remaining }
        })))
      }))
      // Bound leftovers even if the popup is closed before finalizers can run.
      const expirationDate = Date.now() / 1000 + 120
      const root = yield* cookies.set({ ...base, path: "/", value: "root-control", expirationDate })
      const target = yield* cookies.set({ ...base, path, value: "raw-path-target", expirationDate })

      if (Option.isSome(root)) cleanupPaths.add(root.value.path)

      if (Option.isSome(target)) cleanupPaths.add(target.value.path)

      if (Option.isNone(root) || Option.isNone(target)) return yield* Effect.die(new Error("Chrome did not store both regression cookies"))
      // Injected raw cookies exposed URL reconstruction mismatches in the fixture.
      // Live Chrome normalizes paths on SET; that finding is not a confirmed native
      // removal bug. Read the stored target: set() can return the cookie matching
      // its URL (the root control), rather than the explicitly supplied deeper path.
      const before = yield* cookies.getAll({ domain: cookieHost, name })
      const storedTarget = before.find((cookie) => cookie.value === "raw-path-target")

      if (storedTarget === undefined) return yield* Effect.die(new Error("Stored target is missing from getAll"))
      cleanupPaths.add(storedTarget.path)
      const storedPath = storedTarget.path

      const controlsPresent = before.some((cookie) => cookie.path === storedPath && cookie.value === "raw-path-target")
        && before.some((cookie) => cookie.path === root.value.path && cookie.value === "root-control")

      checks.push({
        name: `cookie ${path}: native SET normalization and controls`,
        ok: controlsPresent,
        details: { requestedPath: path, storedPath, setReturnedPath: target.value.path, normalized: storedPath !== path, before }
      })

      if (!controlsPresent) {
        return { ok: false, details: { reason: "Stored target or root control is missing", path, storedPath, before } }
      }

      const removal = yield* Effect.exit(cookies.removeCookie(storedTarget))
      const after = yield* cookies.getAll({ domain: cookieHost, name })
      checks.push({
        name: `cookie ${path}: intended cookie removed`,
        ok: Exit.isSuccess(removal) && !after.some((cookie) => cookie.path === storedPath),
        details: { requestedPath: path, storedPath, before, after, removalUrl: ChromeCookies.detailsOf(storedTarget).url },
        error: Exit.isFailure(removal) ? Cause.pretty(removal.cause) : undefined
      })
      checks.push({
        name: `cookie ${path}: same-name root removed per documented semantics`,
        ok: Exit.isSuccess(removal) && !after.some((cookie) => cookie.path === root.value.path),
        details: {
          rootRemoved: !after.some((cookie) => cookie.path === root.value.path),
          semantics: "removeCookie also removes same-named cookies received from shorter paths", after
        }
      })

      return { ok: true, details: { name, requestedPath: path, storedPath, expirationDate } }
    })))
  }

  yield* record(checks, "cookies: all own names cleaned", Effect.map(cookies.getAll({ domain: cookieHost }), (all) => {
    const remaining = all.filter((cookie) => names.includes(cookie.name))

    return { ok: remaining.length === 0, details: { names, remaining } }
  }))
}).pipe(Effect.provide(ChromeCookies.layerLive))

export async function runRegressionModule(name: string): Promise<RegressionReport> {
  const started = performance.now()
  const run = crypto.randomUUID()
  const checks: Array<Check> = []

  const effect = Match.value(name).pipe(
    Match.when("ChromeSchemaStorage-edgecases", () => schemaRegressions(checks, run)),
    Match.when("ChromeCookies-edgecases", () => cookieRegressions(checks, run)),
    Match.orElse(() => Effect.die(new Error(`Unknown regression module: ${name}`)))
  )

  await Effect.runPromise(record(checks, `${name}: execution and scope`, Effect.scoped(effect).pipe(Effect.as({ ok: true }))))
  const failed = checks.filter((check) => !check.ok).length

  return { name, run, ok: failed === 0, passed: checks.length - failed, failed, checks, milliseconds: performance.now() - started }
}
