// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeUserScripts, ChromeUserScriptsError, isAvailable, layer, layerLive, make, unavailableMessage } from "../src/ChromeUserScripts.js"
import type {
  ChromeUserScriptsApi, InjectionResult, RegisteredUserScript, UserScriptFilter, UserScriptInjection, WorldProperties
} from "../src/ChromeUserScripts.js"

const script: RegisteredUserScript = {
  id: "greeter", matches: ["https://example.com/*"], js: [{ code: "document.title" }], world: "USER_SCRIPT", worldId: "greeter-world"
}

const mockApi = () => ({
  register: vi.fn(async (_scripts: Array<RegisteredUserScript>) => {}),
  update: vi.fn(async (_scripts: Array<RegisteredUserScript>) => {}),
  unregister: vi.fn(async (_filter?: UserScriptFilter) => {}),
  getScripts: vi.fn(async (_filter?: UserScriptFilter) => [script]),
  configureWorld: vi.fn(async (_properties: WorldProperties) => {}),
  getWorldConfigurations: vi.fn(async (): Promise<Array<WorldProperties>> => [{ worldId: "greeter-world", messaging: true }]),
  resetWorldConfiguration: vi.fn(async (_worldId?: string) => {}),
  execute: vi.fn(async (_injection: UserScriptInjection): Promise<Array<InjectionResult>> => [
    { frameId: 0, documentId: "main", result: "Example" },
    { frameId: 4, documentId: "child", error: "ReferenceError: x is not defined" }
  ])
}) satisfies ChromeUserScriptsApi

/** Restores stubbed globals when the test scope closes. */
const restoreGlobals = Effect.acquireRelease(Effect.void, () => Effect.sync(() => vi.unstubAllGlobals()))

describe("ChromeUserScripts", () => {
  it.effect("registers, updates, reads and unregisters scripts, preserving omitted filters", () => Effect.gen(function*() {
    const api = mockApi()
    const userScripts = make(api)
    yield* userScripts.register([script])
    expect(api.register).toHaveBeenCalledExactlyOnceWith([script])
    yield* userScripts.update([{ id: "greeter", runAt: "document_start" }])
    expect(api.update).toHaveBeenCalledExactlyOnceWith([{ id: "greeter", runAt: "document_start" }])

    for (const filter of [undefined, {}, { ids: ["greeter"] }]) {
      expect(yield* userScripts.getScripts(filter)).toEqual([script])
      yield* userScripts.unregister(filter)
      const args = filter === undefined ? [] : [filter]
      expect(api.getScripts.mock.lastCall).toEqual(args)
      expect(api.unregister.mock.lastCall).toEqual(args)
    }
  }))

  it.effect("configures, lists and resets worlds", () => Effect.gen(function*() {
    const api = mockApi()
    const userScripts = make(api)
    yield* userScripts.configureWorld({ worldId: "greeter-world", csp: "script-src 'self'", messaging: true })
    expect(api.configureWorld).toHaveBeenCalledExactlyOnceWith({ worldId: "greeter-world", csp: "script-src 'self'", messaging: true })
    expect(yield* userScripts.getWorldConfigurations).toEqual([{ worldId: "greeter-world", messaging: true }])
    yield* userScripts.resetWorldConfiguration()
    yield* userScripts.resetWorldConfiguration("greeter-world")
    expect(api.resetWorldConfiguration.mock.calls).toEqual([[], ["greeter-world"]])
  }))

  it.effect("executes once and keeps per-frame results and errors", () => Effect.gen(function*() {
    const api = mockApi()
    const injection: UserScriptInjection = { target: { tabId: 7, allFrames: true }, js: [{ code: "document.title" }], world: "USER_SCRIPT" }
    const results = yield* make(api).execute(injection)
    expect(api.execute).toHaveBeenCalledExactlyOnceWith(injection)
    expect(results.map((frame) => frame.error ?? frame.result)).toEqual(["Example", "ReferenceError: x is not defined"])
  }))

  it.effect("types revoked access, which throws synchronously, and rejections by operation", () => Effect.gen(function*() {
    const api = mockApi()
    const userScripts = make(api)
    const revoked = new Error("The userScripts API is only available for users in developer mode.")
    api.register.mockImplementationOnce(() => { throw revoked })
    const error = yield* Effect.flip(userScripts.register([script]))
    expect(error).toBeInstanceOf(ChromeUserScriptsError)
    expect(error).toMatchObject({ operation: "register", cause: revoked })
    const invalid = new Error("Script with ID 'greeter' has invalid match pattern")
    api.update.mockRejectedValueOnce(invalid)
    expect(yield* Effect.flip(userScripts.update([script]))).toMatchObject({ operation: "update", cause: invalid })
  }))

  it.effect("probes the injected API for availability on every run", () => Effect.gen(function*() {
    const api = mockApi()
    const userScripts = make(api)
    expect(api.getScripts).not.toHaveBeenCalled()
    expect(yield* userScripts.isAvailable).toBe(true)
    api.getScripts.mockImplementationOnce(() => { throw new Error("toggle off") })
    expect(yield* userScripts.isAvailable).toBe(false)
    api.getScripts.mockRejectedValueOnce(new Error("toggle off"))
    expect(yield* userScripts.isAvailable).toBe(false)
    expect(yield* userScripts.isAvailable).toBe(true)
    expect(api.getScripts).toHaveBeenCalledTimes(4)
  }))

  it.effect("probes the global for availability only when run", () => Effect.gen(function*() {
    yield* restoreGlobals
    vi.stubGlobal("chrome", undefined)
    expect(yield* isAvailable).toBe(false)
    vi.stubGlobal("chrome", {})
    expect(yield* isAvailable).toBe(false)
    vi.stubGlobal("chrome", { get userScripts() { throw new Error("developer mode is off") } })
    expect(yield* isAvailable).toBe(false)
    const api = mockApi()
    vi.stubGlobal("chrome", { userScripts: api })
    expect(yield* isAvailable).toBe(true)
  }))

  it.effect("fails the live layer with a cause pointing at the user toggle", () => Effect.gen(function*() {
    yield* restoreGlobals
    vi.stubGlobal("chrome", {})
    const missing = yield* Effect.flip(ChromeUserScripts.pipe(Effect.provide(layerLive)))
    expect(missing.operation).toBe("initialize")
    expect(missing.cause).toMatchObject({ message: unavailableMessage })
    expect(unavailableMessage).toContain("Allow User Scripts")
    const denied = new Error("developer mode is off")
    vi.stubGlobal("chrome", { get userScripts() { throw denied } })
    const thrown = yield* Effect.flip(ChromeUserScripts.pipe(Effect.provide(layerLive)))
    expect(thrown.operation).toBe("initialize")
    expect(thrown.cause).toMatchObject({ message: unavailableMessage, cause: denied })
    vi.stubGlobal("chrome", undefined)
    expect((yield* Effect.flip(ChromeUserScripts.pipe(Effect.provide(layerLive)))).operation).toBe("initialize")
  }))

  it.effect("provides injected and live APIs", () => Effect.gen(function*() {
    const api = mockApi()
    expect(yield* Effect.flatMap(ChromeUserScripts, (service) => service.getScripts()).pipe(Effect.provide(layer(api)))).toEqual([script])
    yield* restoreGlobals
    vi.stubGlobal("chrome", { userScripts: api })
    expect(yield* Effect.flatMap(ChromeUserScripts, (service) => service.isAvailable).pipe(Effect.provide(layerLive))).toBe(true)
  }))
})
