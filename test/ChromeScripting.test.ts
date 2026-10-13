// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect } from "effect"
import { describe, expect, expectTypeOf, it, vi } from "@effect/vitest"
import { ChromeScripting, ChromeScriptingError, layer, layerLive, make } from "../src/ChromeScripting.js"
import type { ChromeScriptingApi, ContentScriptUpdate } from "../src/ChromeScripting.js"

interface CyclicArgument {
  self?: CyclicArgument
}

// This is local mock evaluation, not browser injection or a serialization emulator.
const executeScriptImplementation = async <Args extends Array<unknown>, Result>(
  injection: chrome.scripting.ScriptInjection<Args, Result>
): Promise<Array<chrome.scripting.InjectionResult<Awaited<Result>>>> => {
  if (injection.func === undefined) return [{ frameId: 0, documentId: "file-document" }]

  const result = "args" in injection
    ? await injection.func(...injection.args)
    : await injection.func()

  return [{ frameId: 0, documentId: "main", result }, { frameId: 4, documentId: "child", result }]
}

const mockApi = () => ({
  // SAFETY: vi.fn forwards this implementation unchanged; restore its generic call
  // signature lost by Vitest's Parameters/ReturnType mapping. Tests only mock rejection.
  executeScript: vi.fn(executeScriptImplementation) as typeof executeScriptImplementation & ReturnType<typeof vi.fn<typeof executeScriptImplementation>>,
  insertCSS: vi.fn(async (_injection: chrome.scripting.CSSInjection) => {}),
  removeCSS: vi.fn(async (_injection: chrome.scripting.CSSInjection) => {}),
  registerContentScripts: vi.fn(async (_scripts: Array<chrome.scripting.RegisteredContentScript>) => {}),
  getRegisteredContentScripts: vi.fn(async (_filter?: chrome.scripting.ContentScriptFilter): Promise<Array<chrome.scripting.RegisteredContentScript>> => []),
  updateContentScripts: vi.fn(async (_scripts: Array<ContentScriptUpdate>) => {}),
  unregisterContentScripts: vi.fn(async (_filter?: chrome.scripting.ContentScriptFilter) => {})
}) satisfies ChromeScriptingApi

describe("ChromeScripting", () => {
  it.effect("snapshots the live API getter once per layer build", () => Effect.gen(function*() {
    const api = mockApi()
    const getter = vi.fn((): ChromeScriptingApi => { throw new Error("API getter was read twice") }).mockImplementationOnce(() => api)
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", { get scripting() { return getter() } })), () => Effect.sync(() => vi.unstubAllGlobals()))
    const service = yield* ChromeScripting.pipe(Effect.provide(layerLive))
    yield* service.getRegisteredContentScripts()
    expect(getter).toHaveBeenCalledTimes(1)
  }))

  it.effect("infers optional and rest argument tuples without changing argument identity", () => Effect.gen(function*() {
    const api = mockApi()
    const scripting = make(api)
    const optional = scripting.executeScript({ target: { tabId: 1 }, func: (label?: string) => label ?? "default" })
    expectTypeOf(optional).toEqualTypeOf<Effect.Effect<Array<chrome.scripting.InjectionResult<string>>, ChromeScriptingError>>()
    expect((yield* optional)[0]?.result).toBe("default")
    const args: [number, ...Array<string>] = [7, "a", "b"]
    const injection = { target: { tabId: 1 }, func: (n: number, ...labels: Array<string>) => ({ n, labels }), args }
    expect((yield* scripting.executeScript(injection))[0]?.result).toEqual({ n: 7, labels: ["a", "b"] })
    expect(api.executeScript.mock.lastCall?.[0]).toBe(injection)
  }))

  it.effect("leaves serialization failures at Chrome's boundary and does not run supplied functions locally", () => Effect.gen(function*() {
    const api = mockApi()
    const scripting = make(api)
    const cyclic: CyclicArgument = {}
    cyclic.self = cyclic
    const func = vi.fn((_value: CyclicArgument | bigint | (() => void)) => "must not run")

    for (const value of [cyclic, 1n, () => {}]) {
      const injection = { target: { tabId: 1 }, func, args: [value] satisfies [CyclicArgument | bigint | (() => void)] }
      const cause = new TypeError("Native argument serialization failed")
      api.executeScript.mockRejectedValueOnce(cause)
      expect(yield* Effect.flip(scripting.executeScript(injection))).toMatchObject({ operation: "executeScript", cause })
      expect(api.executeScript.mock.lastCall?.[0]).toBe(injection)
    }

    expect(func).not.toHaveBeenCalled()
  }))

  it.effect("preserves empty and per-frame boundary results across 4096 runs with revocation and tab loss", () => Effect.gen(function*() {
    const api = mockApi()
    const scripting = make(api)
    const injection = { target: { tabId: 17, frameIds: [0, 4] }, files: ["packaged.js"] }
    const effect = scripting.executeScript(injection)
    const frames = [{ frameId: 4, documentId: "child" }, { frameId: 0, documentId: "main", result: null }]
    const failures = ["Host permission revoked", "No tab with id: 17", "Frame 4 disappeared", "Native result serialization failed"]

    for (let index = 0; index < 4096; index++) {
      if (index % 1024 === 1023) {
        const cause = new Error(failures[Math.floor(index / 1024)])
        api.executeScript.mockRejectedValueOnce(cause)
        expect(yield* Effect.flip(effect)).toMatchObject({ operation: "executeScript", cause })
      } else {
        const results = index % 2 === 0 ? [] : frames
        api.executeScript.mockResolvedValueOnce(results)
        expect(yield* effect).toBe(results)
      }

      expect(api.executeScript.mock.lastCall?.[0]).toBe(injection)
    }

    expect(api.executeScript).toHaveBeenCalledTimes(4096)
    expect(api.unregisterContentScripts).not.toHaveBeenCalled()
  }))

  it.effect("captures scripting method and global getter failures without eager access", () => Effect.gen(function*() {
    const api = mockApi()
    const cause = new Error("scripting access denied")
    const getter = vi.fn(() => { throw cause })
    Object.defineProperty(api, "executeScript", { get: getter })
    const effect = make(api).executeScript({ target: { tabId: 1 }, files: ["packaged.js"] })
    expect(getter).not.toHaveBeenCalled()
    expect(yield* Effect.flip(effect)).toMatchObject({ operation: "executeScript", cause })
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", { get scripting() { throw cause } })), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeScripting.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize", cause })
  }))

  it.effect("preserves function arguments, worlds, target options and awaited per-frame results", () => Effect.gen(function*() {
    const api = mockApi()
    const scripting = make(api)

    const injection = {
      target: { tabId: 0, frameIds: [0, 4] },
      world: "MAIN",
      injectImmediately: true,
      func: async (count: number, label: string) => ({ count, label }),
      args: [3, "value"]
    } satisfies chrome.scripting.ScriptInjection<[number, string], Promise<{ count: number; label: string }>>

    const effect = scripting.executeScript(injection)
    expectTypeOf(effect).toEqualTypeOf<Effect.Effect<Array<chrome.scripting.InjectionResult<{ count: number; label: string }>>, ChromeScriptingError>>()
    expect(api.executeScript).not.toHaveBeenCalled()
    expect(yield* effect).toEqual([
      { frameId: 0, documentId: "main", result: { count: 3, label: "value" } },
      { frameId: 4, documentId: "child", result: { count: 3, label: "value" } }
    ])
    expect(api.executeScript).toHaveBeenCalledExactlyOnceWith(injection)
    const isolated = { target: { tabId: 7, documentIds: ["document"] }, world: "ISOLATED", func: () => 42 } satisfies chrome.scripting.ScriptInjection<[], number>
    expect((yield* scripting.executeScript(isolated))[0]?.result).toBe(42)
    expect(api.executeScript).toHaveBeenLastCalledWith(isolated)
  }))

  it.effect("keeps file results unknown and passes packaged files without function arguments", () => Effect.gen(function*() {
    const api = mockApi()
    const scripting = make(api)
    const injection = { target: { tabId: 7, allFrames: true }, files: ["content.js"], world: "ISOLATED" } satisfies chrome.scripting.ScriptInjection<[], unknown>
    const effect = scripting.executeScript(injection)
    expectTypeOf(effect).toEqualTypeOf<Effect.Effect<Array<chrome.scripting.InjectionResult<unknown>>, ChromeScriptingError>>()
    expect(yield* effect).toEqual([{ frameId: 0, documentId: "file-document" }])
    expect(api.executeScript).toHaveBeenCalledExactlyOnceWith(injection)

    // Compile-only assertions; no invalid injection is executed.
    // eslint-disable-next-line no-constant-condition -- Compile-only negative type checks.
    if (false) {
      // @ts-expect-error Arguments must match the injected function's parameters.
      yield* scripting.executeScript({ target: { tabId: 1 }, func: (value: number) => value, args: ["wrong"] })
      // @ts-expect-error Required function arguments cannot be omitted.
      yield* scripting.executeScript({ target: { tabId: 1 }, func: (value: number) => value })
      // @ts-expect-error File injections do not accept a fabricated result generic.
      yield* scripting.executeScript<[], string>({ target: { tabId: 1 }, files: ["content.js"] })
      // @ts-expect-error Files cannot carry function arguments.
      yield* scripting.executeScript({ target: { tabId: 1 }, files: ["content.js"], args: [] })
      // @ts-expect-error Chrome disallows allFrames with explicit frameIds.
      yield* scripting.executeScript({ target: { tabId: 1, allFrames: true, frameIds: [0] }, func: () => 1 })
    }
  }))

  it.effect("forwards CSS and registration options through an injectable service without automatic unregister", () => Effect.gen(function*() {
    const api = mockApi()
    const css: chrome.scripting.CSSInjection = { target: { tabId: 0, frameIds: [0] }, css: "body { color: red }", origin: "USER" }
    const files: chrome.scripting.CSSInjection = { target: { tabId: 0, allFrames: true }, files: ["content.css"], origin: "AUTHOR" }

    const scripts: Array<chrome.scripting.RegisteredContentScript> = [{
      id: "owned-script", matches: ["https://example.com/*"], excludeMatches: ["https://example.com/private/*"],
      js: ["content.js"], css: ["content.css"], world: "ISOLATED", runAt: "document_start",
      allFrames: true, matchOriginAsFallback: true, persistAcrossSessions: false
    }]

    api.getRegisteredContentScripts.mockResolvedValueOnce(scripts)
    yield* Effect.gen(function*() {
      const scripting = yield* ChromeScripting
      yield* scripting.insertCSS(css)
      yield* scripting.removeCSS(css)
      yield* scripting.insertCSS(files)
      yield* scripting.removeCSS(files)
      yield* scripting.registerContentScripts(scripts)
      expect(yield* scripting.getRegisteredContentScripts({ ids: ["owned-script"] })).toBe(scripts)
      yield* scripting.updateContentScripts(scripts)
    }).pipe(Effect.provide(layer(api)))
    expect(api.insertCSS.mock.calls).toEqual([[css], [files]])
    expect(api.removeCSS.mock.calls).toEqual([[css], [files]])
    expect(api.registerContentScripts).toHaveBeenCalledExactlyOnceWith(scripts)
    expect(api.updateContentScripts).toHaveBeenCalledExactlyOnceWith(scripts)
    expect(api.getRegisteredContentScripts).toHaveBeenCalledExactlyOnceWith({ ids: ["owned-script"] })
    expect(api.unregisterContentScripts).not.toHaveBeenCalled()
    yield* make(api).updateContentScripts([{ id: "owned-script", world: "MAIN" }, { id: "unchanged" }])
    expect(api.updateContentScripts).toHaveBeenLastCalledWith([{ id: "owned-script", world: "MAIN" }, { id: "unchanged" }])
    yield* make(api).unregisterContentScripts({ ids: ["owned-script"] })
    expect(api.unregisterContentScripts).toHaveBeenCalledExactlyOnceWith({ ids: ["owned-script"] })
  }))

  it.effect("is lazy on every execution and preserves omitted, empty and explicit filters", () => Effect.gen(function*() {
    const api = mockApi()
    const scripting = make(api)

    const effects = [
      Effect.asVoid(scripting.executeScript({ target: { tabId: 0 }, func: () => 0 })),
      scripting.insertCSS({ target: { tabId: 0 }, css: "" }),
      scripting.removeCSS({ target: { tabId: 0 }, css: "" }),
      scripting.registerContentScripts([]), Effect.asVoid(scripting.getRegisteredContentScripts({ ids: [] })),
      scripting.updateContentScripts([]), scripting.unregisterContentScripts({ ids: [] })
    ]

    expect(api.executeScript).not.toHaveBeenCalled()
    expect(api.unregisterContentScripts).not.toHaveBeenCalled()

    for (let index = 0; index < 32; index++) {
      for (const effect of effects) yield* effect
    }

    for (const method of Object.values(api)) expect(method).toHaveBeenCalledTimes(32)
    expect(api.getRegisteredContentScripts).toHaveBeenLastCalledWith({ ids: [] })
    expect(api.unregisterContentScripts).toHaveBeenLastCalledWith({ ids: [] })

    for (const filter of [undefined, {}, { ids: ["script"] }]) {
      yield* scripting.getRegisteredContentScripts(filter)
      yield* scripting.unregisterContentScripts(filter)
      const args = filter === undefined ? [] : [filter]
      expect(api.getRegisteredContentScripts.mock.lastCall).toEqual(args)
      expect(api.unregisterContentScripts.mock.lastCall).toEqual(args)
    }
  }))

  it.effect.each(["executeScript", "insertCSS", "removeCSS", "registerContentScripts", "getRegisteredContentScripts", "updateContentScripts", "unregisterContentScripts"] as const)(
    "captures synchronous and rejected %s failures without compensation", (operation) => Effect.gen(function*() {
      for (const synchronous of [true, false]) {
        const cause = new Error("failed after partial browser work")

        const fail = () => {
          if (synchronous) throw cause

          return Promise.reject(cause)
        }

        const api: ChromeScriptingApi = { ...mockApi(), [operation]: fail }
        const scripting = make(api)

        const effects = {
          executeScript: Effect.asVoid(scripting.executeScript({ target: { tabId: 7 }, func: () => 1 })),
          insertCSS: scripting.insertCSS({ target: { tabId: 7 }, css: "" }),
          removeCSS: scripting.removeCSS({ target: { tabId: 7 }, css: "" }),
          registerContentScripts: scripting.registerContentScripts([]),
          getRegisteredContentScripts: Effect.asVoid(scripting.getRegisteredContentScripts()),
          updateContentScripts: scripting.updateContentScripts([]),
          unregisterContentScripts: scripting.unregisterContentScripts({ ids: ["owned"] })
        }

        const error = yield* Effect.flip(effects[operation])
        expect(error).toBeInstanceOf(ChromeScriptingError)
        expect(error.operation).toBe(operation)
        expect(error.cause).toBe(cause)
      }
    })
  )

  it.effect("preserves invalid target and missing permission rejections then permits a fresh run", () => Effect.gen(function*() {
    const api = mockApi()
    const effect = make(api).executeScript({ target: { tabId: -1 }, files: ["content.js"] })

    for (const message of ["Invalid tab ID", "Missing host permission", "Cannot access chrome:// URLs"]) {
      const cause = new Error(message)
      api.executeScript.mockRejectedValueOnce(cause)
      const error = yield* Effect.flip(effect)
      expect(error.operation).toBe("executeScript")
      expect(error.cause).toBe(cause)
    }

    expect(yield* effect).toEqual([{ frameId: 0, documentId: "file-document" }])
    expect(api.executeScript).toHaveBeenCalledTimes(4)
  }))

  it.effect("reads Chrome only when the live layer is built and reports unavailable contexts", () => Effect.gen(function*() {
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", undefined)), () => Effect.sync(() => vi.unstubAllGlobals()))
    const error = yield* Effect.flip(ChromeScripting.pipe(Effect.provide(layerLive)))
    expect(error.operation).toBe("initialize")
    vi.stubGlobal("chrome", {})
    expect((yield* Effect.flip(ChromeScripting.pipe(Effect.provide(layerLive)))).operation).toBe("initialize")
    const api = mockApi()
    vi.stubGlobal("chrome", { scripting: api })
    yield* Effect.gen(function*() {
      const scripting = yield* ChromeScripting
      yield* scripting.insertCSS({ target: { tabId: 7 }, css: "" })
    }).pipe(Effect.provide(layerLive))
    expect(api.insertCSS).toHaveBeenCalledExactlyOnceWith({ target: { tabId: 7 }, css: "" })
  }))
})
