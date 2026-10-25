// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Exit, Fiber, Option } from "effect"
import { describe, expect, expectTypeOf, it, vi } from "@effect/vitest"
import { ChromeScripting, ChromeScriptingError, layer, layerLive, make } from "../src/ChromeScripting.js"
import type {
  ChromeScriptingApi, ContentScriptFilter, ContentScriptRegistration, ContentScriptUpdate, CSSInjection, FileInjection, RegisteredContentScript
} from "../src/ChromeScripting.js"
import { makeScripting } from "../src/testing/Scripting.js"

/** An injection ignoring Chrome's exclusivity rules, as an untyped caller could build one. */
interface UntypedInjection {
  readonly target: { readonly tabId: number; readonly allFrames?: boolean; readonly frameIds?: Array<number>; readonly documentIds?: Array<string> }
  readonly files?: Array<string>
  readonly args?: Array<never>
}

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
  insertCSS: vi.fn(async (_injection: CSSInjection) => {}),
  removeCSS: vi.fn(async (_injection: CSSInjection) => {}),
  registerContentScripts: vi.fn(async (_scripts: Array<ContentScriptRegistration>) => {}),
  getRegisteredContentScripts: vi.fn(async (_filter?: ContentScriptFilter): Promise<Array<RegisteredContentScript>> => []),
  updateContentScripts: vi.fn(async (_scripts: Array<ContentScriptUpdate>) => {}),
  unregisterContentScripts: vi.fn(async (_filter?: ContentScriptFilter) => {})
}) satisfies ChromeScriptingApi

const operations = [
  "executeScript", "insertCSS", "removeCSS", "registerContentScripts", "getRegisteredContentScripts", "updateContentScripts", "unregisterContentScripts"
] as const

const failure = (exit: Exit.Exit<unknown, ChromeScriptingError>): string | undefined => {
  if (Exit.isSuccess(exit)) return undefined

  const error = Exit.findErrorOption(exit)

  return Option.isSome(error) && error.value.cause instanceof Error ? error.value.cause.message : undefined
}

describe("ChromeScripting", () => {
  it.effect("snapshots the live API getter once per layer build", () => Effect.gen(function*() {
    const api = mockApi()
    const getter = vi.fn((): ChromeScriptingApi => { throw new Error("API getter was read twice") }).mockImplementationOnce(() => api)
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", { get scripting() { return getter() } })), () => Effect.sync(() => vi.unstubAllGlobals()))
    const service = yield* ChromeScripting.pipe(Effect.provide(layerLive))
    yield* service.getRegisteredContentScripts()
    expect(getter).toHaveBeenCalledTimes(1)
  }))

  it.effect("reads Chrome only when the live layer is built and reports unavailable contexts", () => Effect.gen(function*() {
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", undefined)), () => Effect.sync(() => vi.unstubAllGlobals()))
    const error = yield* Effect.flip(ChromeScripting.pipe(Effect.provide(layerLive)))
    expect(error).toBeInstanceOf(ChromeScriptingError)
    expect(error.operation).toBe("initialize")
    expect(error.cause).toEqual(new Error("chrome.scripting is unavailable in this context"))
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
      // @ts-expect-error Chrome requires matches when registering.
      yield* scripting.registerContentScripts([{ id: "no-matches", js: ["content.js"] }])
      // @ts-expect-error Chrome requires a js or css file when registering.
      yield* scripting.registerContentScripts([{ id: "no-files", matches: ["<all_urls>"] }])
      // @ts-expect-error Chrome never changes a registered script's world on update.
      yield* scripting.updateContentScripts([{ id: "owned-script", world: "MAIN" }])
    }
  }))

  it.effect("forwards CSS and registration options through an injectable service without automatic unregister", () => Effect.gen(function*() {
    const api = mockApi()
    const css: CSSInjection = { target: { tabId: 0, frameIds: [0] }, css: "body { color: red }", origin: "USER" }
    const files: CSSInjection = { target: { tabId: 0, allFrames: true }, files: ["content.css"], origin: "AUTHOR" }

    const scripts: Array<ContentScriptRegistration> = [{
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
    yield* make(api).updateContentScripts([{ id: "owned-script", runAt: "document_end" }, { id: "unchanged" }])
    expect(api.updateContentScripts).toHaveBeenLastCalledWith([{ id: "owned-script", runAt: "document_end" }, { id: "unchanged" }])
    yield* make(api).unregisterContentScripts({ ids: ["owned-script"] })
    expect(api.unregisterContentScripts).toHaveBeenCalledExactlyOnceWith({ ids: ["owned-script"] })
  }))

  it.effect("is lazy on every execution and passes omitted, empty and explicit filters as given", () => Effect.gen(function*() {
    const api = mockApi()
    const scripting = make(api)

    const effects = [
      Effect.asVoid(scripting.executeScript({ target: { tabId: 0 }, func: () => 0 })),
      scripting.insertCSS({ target: { tabId: 0 }, css: "" }),
      scripting.removeCSS({ target: { tabId: 0 }, css: "" }),
      scripting.registerContentScripts([]), Effect.asVoid(scripting.getRegisteredContentScripts({ ids: [] })),
      scripting.updateContentScripts([]), scripting.unregisterContentScripts({ ids: [] })
    ]

    for (const method of Object.values(api)) expect(method).not.toHaveBeenCalled()

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

    yield* scripting.getRegisteredContentScripts()
    yield* scripting.unregisterContentScripts()
    expect(api.getRegisteredContentScripts.mock.lastCall).toEqual([])
    expect(api.unregisterContentScripts.mock.lastCall).toEqual([])
  }))

  it.effect.each(operations)("maps a synchronous throw and a rejection from %s to its typed error", (operation) => Effect.gen(function*() {
    for (const synchronous of [true, false]) {
      const cause = new Error(`${operation} failed after partial browser work`)

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
  }))

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
})

describe("makeScripting", () => {
  it.effect("runs a function once per frame with its own argument copy, main frame first", () => Effect.gen(function*() {
    const fixture = makeScripting()
    fixture.controls.setTab(1, [{ frameId: 3, documentId: "child" }, { frameId: 0, documentId: "top" }, { frameId: 5, documentId: "other" }])
    const scripting = make(fixture.api)
    const seen: Array<{ readonly frameId: number | undefined; readonly tags: Array<string> }> = []
    const options = { tags: ["a"] }

    const results = yield* scripting.executeScript({
      target: { tabId: 1, allFrames: true },
      func: (received: { tags: Array<string> }) => {
        received.tags.push("mutated")
        seen.push({ frameId: fixture.controls.evaluatingFrame()?.frameId, tags: received.tags })

        return fixture.controls.evaluatingFrame()?.documentId
      },
      args: [options]
    })

    expect(results[0]).toEqual({ frameId: 0, documentId: "top", result: "top" })
    expect(results.map((result) => result.frameId).sort((left, right) => left - right)).toEqual([0, 3, 5])
    expect(seen.map((entry) => entry.tags)).toEqual([["a", "mutated"], ["a", "mutated"], ["a", "mutated"]])
    expect(options).toEqual({ tags: ["a"] })
    expect(fixture.controls.evaluatingFrame()).toBeUndefined()

    // The main frame alone by default; undefined, functions and promises serialize like JSON.
    expect(yield* scripting.executeScript({ target: { tabId: 1 }, func: () => undefined })).toEqual([{ frameId: 0, documentId: "top", result: null }])
    expect(yield* scripting.executeScript({ target: { tabId: 1, frameIds: [5] }, func: async () => ({ keep: 1, drop: undefined, call: () => 2 }) }))
      .toEqual([{ frameId: 5, documentId: "other", result: { keep: 1 } }])
    expect(yield* scripting.executeScript({ target: { tabId: 1, documentIds: ["child", "child"] }, func: () => [undefined] }))
      .toEqual([{ frameId: 3, documentId: "child", result: [null] }])
  }))

  it.effect("validates targets and injections like Chrome", () => Effect.gen(function*() {
    const fixture = makeScripting()
    fixture.controls.setTab(1)
    fixture.controls.addFile("a.js", (frame) => frame.documentId)
    const scripting = make(fixture.api)
    const run = (injection: FileInjection) => Effect.exit(scripting.executeScript(injection))

    expect(failure(yield* run({ target: { tabId: 9 }, files: ["a.js"] }))).toBe("No tab with id: 9.")
    expect(failure(yield* run({ target: { tabId: 1, frameIds: [4] }, files: ["a.js"] }))).toBe("No frame with id 4 in tab with id 1")
    expect(failure(yield* run({ target: { tabId: 1, documentIds: ["gone"] }, files: ["a.js"] }))).toBe("No document with id gone in tab with id 1")
    expect(failure(yield* run({ target: { tabId: 1 }, files: ["missing.js"] }))).toBe("Could not load file: 'missing.js'.")
    expect(failure(yield* run({ target: { tabId: 1 }, files: ["a.js", "a.js"] }))).toBe("Duplicate file specified: 'a.js'.")
    expect(failure(yield* run({ target: { tabId: 1 }, files: [] }))).toBe("At least one file must be specified.")

    // Shapes the types forbid still reach the native fixture from untyped callers.
    const raw = fixture.api

    const rejected = async <A>(call: () => Promise<A>) => {
      try {
        await call()

        return undefined
      } catch (cause) {
        return cause instanceof Error ? cause.message : undefined
      }
    }

    // Plain JavaScript callers can build shapes the types forbid; JSON stands in for them.
    const untyped = <A>(injection: UntypedInjection): A => JSON.parse(JSON.stringify(injection))
    const files = ["a.js"]
    expect(yield* Effect.promise(() => rejected(() => raw.executeScript(untyped({ target: { tabId: 1, allFrames: true, frameIds: [0] }, files })))))
      .toBe("Cannot specify 'allFrames' if either 'frameIds' or 'documentIds' is specified.")
    expect(yield* Effect.promise(() => rejected(() => raw.executeScript(untyped({ target: { tabId: 1, frameIds: [0], documentIds: ["document-1"] }, files })))))
      .toBe("Cannot specify both 'frameIds' and 'documentIds'.")
    expect(yield* Effect.promise(() => rejected(() => raw.executeScript(untyped({ target: { tabId: 1 } })))))
      .toBe("Exactly one of 'func' and 'files' must be specified")
    expect(yield* Effect.promise(() => rejected(() => raw.executeScript(untyped({ target: { tabId: 1 }, files, args: [] })))))
      .toBe("'args' may not be used with file injections.")
    expect(yield* Effect.promise(() => rejected(() => raw.executeScript({ target: { tabId: 1 }, func: (value: bigint) => String(value), args: [1n] }))))
      .toBe("Unserializable argument passed.")
    expect(yield* Effect.promise(() => rejected(() => raw.insertCSS(untyped({ target: { tabId: 1 } })))))
      .toBe("Exactly one of 'css' and 'files' must be specified.")

    // The last file's evaluation is the frame's result.
    fixture.controls.addFile("b.js", () => ({ last: true }))
    expect(yield* scripting.executeScript({ target: { tabId: 1 }, files: ["a.js", "b.js"] })).toEqual([{ frameId: 0, documentId: "document-1", result: { last: true } }])
  }))

  it.effect("rejects an unreachable lone frame and leaves unreachable frames out of a wider target", () => Effect.gen(function*() {
    const fixture = makeScripting()

    fixture.controls.setTab(1, [
      { frameId: 0, documentId: "top", url: "chrome://settings" },
      { frameId: 1, documentId: "store", url: "https://chromewebstore.google.com/detail/x" },
      { frameId: 2, documentId: "denied", error: "Cannot access contents of the page." },
      { frameId: 3, documentId: "open", url: "https://example.com/" },
      { frameId: 4, documentId: "throws" }
    ])

    const scripting = make(fixture.api)

    const probe = (frameIds: Array<number>) => Effect.exit(scripting.executeScript({
      target: { tabId: 1, frameIds },
      func: () => {
        if (fixture.controls.evaluatingFrame()?.frameId === 4) throw new Error("script threw")

        return "ran"
      }
    }))

    expect(failure(yield* probe([0]))).toBe("Cannot access a chrome:// URL")
    expect(failure(yield* probe([1]))).toBe("The extensions gallery cannot be scripted.")
    expect(failure(yield* probe([2]))).toBe("Cannot access contents of the page.")
    expect(failure(yield* probe([4]))).toBe("script threw")
    expect(yield* scripting.executeScript({ target: { tabId: 1, allFrames: true }, func: () => fixture.controls.evaluatingFrame()?.frameId === 4 ? Promise.reject(new Error("x")) : "ran" }))
      .toEqual([{ frameId: 3, documentId: "open", result: "ran" }])
    expect(failure(yield* Effect.exit(scripting.insertCSS({ target: { tabId: 1, frameIds: [0] }, css: "a {}" })))).toBe("Cannot access a chrome:// URL")
    yield* scripting.insertCSS({ target: { tabId: 1, allFrames: true }, css: "a {}" })
    expect(fixture.controls.styles().map((style) => style.documentId)).toEqual(["open", "throws"])
  }))

  it.effect("records CSS per document and removes the latest exact match, ignoring absent ones", () => Effect.gen(function*() {
    const fixture = makeScripting()
    fixture.controls.setTab(1, [{ frameId: 0, documentId: "top" }, { frameId: 1, documentId: "child" }])
    fixture.controls.setTab(2)
    fixture.controls.addFile("a.css")
    const scripting = make(fixture.api)
    yield* scripting.insertCSS({ target: { tabId: 1 }, css: "x" })
    yield* scripting.insertCSS({ target: { tabId: 1, allFrames: true }, css: "x", origin: "USER" })
    yield* scripting.insertCSS({ target: { tabId: 2 }, files: ["a.css"] })

    expect(fixture.controls.styles()).toEqual([
      { tabId: 1, frameId: 0, documentId: "top", origin: "AUTHOR", css: "x" },
      { tabId: 1, frameId: 0, documentId: "top", origin: "USER", css: "x" },
      { tabId: 1, frameId: 1, documentId: "child", origin: "USER", css: "x" },
      { tabId: 2, frameId: 0, documentId: "document-2", origin: "AUTHOR", files: ["a.css"] }
    ])

    // The origin and the content must match; an unmatched removal is a no-op.
    yield* scripting.removeCSS({ target: { tabId: 1 }, css: "x", origin: "USER" })
    yield* scripting.removeCSS({ target: { tabId: 1 }, css: "y" })
    yield* scripting.removeCSS({ target: { tabId: 2 }, files: ["a.css"], origin: "USER" })
    expect(fixture.controls.styles().length).toBe(3)
    yield* scripting.removeCSS({ target: { tabId: 2 }, files: ["a.css"] })
    expect(fixture.controls.styles().map((style) => style.documentId)).toEqual(["top", "child"])

    // A navigation drops the old document's styles; closing a tab drops all of them.
    fixture.controls.navigate(1, { frameId: 1, documentId: "child-2" })
    expect(fixture.controls.styles().map((style) => style.documentId)).toEqual(["top"])
    expect(() => fixture.controls.navigate(9, { frameId: 0, documentId: "x" })).toThrow("No tab with id: 9.")
    fixture.controls.removeTab(1)
    expect(fixture.controls.styles()).toEqual([])
  }))

  it.effect("registers all-or-nothing with Chrome's defaults and rejections", () => Effect.gen(function*() {
    const fixture = makeScripting()
    fixture.controls.addFile("a.js")
    fixture.controls.addFile("a.css")
    const scripting = make(fixture.api)
    const register = (scripts: Array<ContentScriptRegistration>) => Effect.exit(scripting.registerContentScripts(scripts))
    yield* scripting.registerContentScripts([{ id: "one", matches: ["<all_urls>"], js: ["a.js"] }, { id: "two", matches: ["https://*/*"], css: ["a.css"], excludeMatches: [] }])

    expect(yield* scripting.getRegisteredContentScripts()).toEqual([
      { id: "one", matches: ["<all_urls>"], js: ["a.js"], allFrames: false, matchOriginAsFallback: false, persistAcrossSessions: true, runAt: "document_idle", world: "ISOLATED" },
      { id: "two", matches: ["https://*/*"], css: ["a.css"], allFrames: false, matchOriginAsFallback: false, persistAcrossSessions: true, runAt: "document_idle", world: "ISOLATED" }
    ])

    const valid: ContentScriptRegistration = { id: "three", matches: ["<all_urls>"], js: ["a.js"] }
    expect(failure(yield* register([valid, { id: "one", matches: ["<all_urls>"], js: ["a.js"] }]))).toBe("Duplicate script ID 'one'")
    expect(failure(yield* register([valid, { ...valid }]))).toBe("Duplicate script ID 'three'")
    expect(failure(yield* register([valid, { id: "", matches: ["<all_urls>"], js: ["a.js"] }]))).toBe("Script's ID must not be empty")
    expect(failure(yield* register([valid, { id: "_x", matches: ["<all_urls>"], js: ["a.js"] }]))).toBe("Script's ID '_x' must not start with '_'")
    expect(failure(yield* register([valid, { id: "m", matches: [], js: ["a.js"] }]))).toBe("Script with ID 'm' must specify at least one match.")
    expect(failure(yield* register([valid, { id: "f", matches: ["<all_urls>"], js: [] }]))).toBe("Script with ID 'f' must specify at least one js or css file.")
    expect(failure(yield* register([valid, { id: "u", matches: ["<all_urls>"], js: ["missing.js"] }]))).toBe("Could not load file: 'missing.js'.")
    // SAFETY: an untyped caller can omit matches; the fixture rejects it like Chrome.
    expect(failure(yield* register([valid, { id: "n", js: ["a.js"] } as ContentScriptRegistration]))).toBe("Script with ID 'n' must specify 'matches'.")
    expect(fixture.controls.scripts().map((script) => script.id)).toEqual(["one", "two"])
  }))

  it.effect("updates supplied fields all-or-nothing, never the world, keeping registration order", () => Effect.gen(function*() {
    const fixture = makeScripting()
    fixture.controls.addFile("a.js")
    fixture.controls.addFile("b.js")
    const scripting = make(fixture.api)
    yield* scripting.registerContentScripts([{ id: "one", matches: ["<all_urls>"], js: ["a.js"], world: "MAIN" }, { id: "two", matches: ["<all_urls>"], js: ["a.js"] }])
    yield* scripting.updateContentScripts([{ id: "one", js: ["b.js"], runAt: "document_start", persistAcrossSessions: false }, { id: "two" }])
    // SAFETY: an untyped caller can pass world; Chrome ignores it on update.
    yield* scripting.updateContentScripts([{ id: "one", world: "ISOLATED" } as ContentScriptUpdate])
    const [one, two] = yield* scripting.getRegisteredContentScripts({ ids: ["two", "one"] })
    expect(one).toMatchObject({ id: "one", js: ["b.js"], runAt: "document_start", persistAcrossSessions: false, world: "MAIN" })
    expect(two).toMatchObject({ id: "two", js: ["a.js"], runAt: "document_idle", persistAcrossSessions: true })

    expect(failure(yield* Effect.exit(scripting.updateContentScripts([{ id: "one", js: ["a.js"] }, { id: "ghost" }]))))
      .toBe("Script with ID 'ghost' does not exist or is not fully registered")
    expect(failure(yield* Effect.exit(scripting.updateContentScripts([{ id: "two", js: ["missing.js"] }, { id: "one", js: ["a.js"] }]))))
      .toBe("Could not load file: 'missing.js'.")
    expect(failure(yield* Effect.exit(scripting.updateContentScripts([{ id: "two", matches: [] }])))).toBe("Script with ID 'two' must specify at least one match.")
    expect(fixture.controls.scripts().map((script) => script.js)).toEqual([["b.js"], ["a.js"]])

    // A browser restart keeps only the scripts that persist across sessions.
    fixture.controls.restart()
    expect(fixture.controls.scripts().map((script) => script.id)).toEqual(["two"])
  }))

  it.effect("treats an absent or empty ids filter as every script, as Chrome does", () => Effect.gen(function*() {
    const fixture = makeScripting()
    fixture.controls.addFile("a.js")
    const scripting = make(fixture.api)
    const register = scripting.registerContentScripts(["x", "y", "z"].map((id) => ({ id, matches: ["<all_urls>"], js: ["a.js"] })))
    yield* register
    expect((yield* scripting.getRegisteredContentScripts({ ids: [] })).length).toBe(3)
    expect((yield* scripting.getRegisteredContentScripts({})).length).toBe(3)
    expect((yield* scripting.getRegisteredContentScripts({ ids: ["y", "ghost"] })).map((script) => script.id)).toEqual(["y"])

    expect(failure(yield* Effect.exit(scripting.unregisterContentScripts({ ids: ["x", "ghost"] })))).toBe("Nonexistent script ID 'ghost'")
    expect(failure(yield* Effect.exit(scripting.unregisterContentScripts({ ids: ["_x"] })))).toBe("Script's ID '_x' must not start with '_'")
    expect(fixture.controls.scripts().length).toBe(3)
    yield* scripting.unregisterContentScripts({ ids: ["x"] })
    expect(fixture.controls.scripts().map((script) => script.id)).toEqual(["y", "z"])
    yield* scripting.unregisterContentScripts({ ids: [] })
    expect(fixture.controls.scripts()).toEqual([])
    yield* register
    yield* scripting.unregisterContentScripts()
    expect(fixture.controls.scripts()).toEqual([])
  }))

  it.effect("isolates stored state from caller mutation", () => Effect.gen(function*() {
    const fixture = makeScripting()
    fixture.controls.addFile("a.js")
    const scripting = make(fixture.api)
    const script: ContentScriptRegistration = { id: "x", matches: ["<all_urls>"], js: ["a.js"] }
    yield* scripting.registerContentScripts([script])
    script.matches.push("https://mutated/*")
    const listed = yield* scripting.getRegisteredContentScripts()
    listed[0]?.matches?.push("https://mutated-too/*")
    expect(fixture.controls.scripts()[0]?.matches).toEqual(["<all_urls>"])
  }))

  it.effect("fails, throws or holds the next call of an operation once, and accepts overrides", () => Effect.gen(function*() {
    const fixture = makeScripting({ getRegisteredContentScripts: async () => [{ id: "override", matches: [], js: [] }] })
    fixture.controls.setTab(1)
    const scripting = make(fixture.api)
    const rejected = new Error("rejected")
    const thrown = new Error("thrown")
    fixture.controls.failNext("insertCSS", rejected)
    fixture.controls.throwNext("insertCSS", thrown)
    const css = scripting.insertCSS({ target: { tabId: 1 }, css: "a {}" })
    // A queued throw comes before a queued rejection, each used once.
    expect(yield* Effect.flip(css)).toMatchObject({ operation: "insertCSS", cause: thrown })
    expect(yield* Effect.flip(css)).toMatchObject({ operation: "insertCSS", cause: rejected })
    yield* css
    expect(fixture.controls.styles().length).toBe(1)

    const held = fixture.controls.holdNext("removeCSS")
    const fiber = yield* Effect.forkChild(scripting.removeCSS({ target: { tabId: 1 }, css: "a {}" }))
    yield* Effect.promise(() => held.entered)
    expect(fixture.controls.styles().length).toBe(1)
    held.release()
    yield* Fiber.join(fiber)
    expect(fixture.controls.styles()).toEqual([])

    expect(yield* scripting.getRegisteredContentScripts()).toEqual([{ id: "override", matches: [], js: [] }])

    const viaLayer = Effect.gen(function*() {
      const service = yield* ChromeScripting

      return yield* service.getRegisteredContentScripts()
    })

    expect(yield* Effect.provide(viaLayer, fixture.layer)).toEqual([{ id: "override", matches: [], js: [] }])
  }))
})
