// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Exit } from "effect"
import { describe, expect, expectTypeOf, it, vi } from "@effect/vitest"
import { ChromeUserScripts, ChromeUserScriptsError, isAvailable, layer, layerLive, make, unavailableMessage } from "../src/ChromeUserScripts.js"
import type {
  ChromeUserScriptsApi, InjectionResult, RegisteredUserScript, UserScriptFilter, UserScriptInjection, UserScriptRegistration,
  WorldProperties
} from "../src/ChromeUserScripts.js"
import { accessOffMessage, makeUserScripts, maxWorlds } from "../src/testing/UserScripts.js"
import type { FrameOutcome, UserScriptsOperation } from "../src/testing/UserScripts.js"

const script: UserScriptRegistration = {
  id: "greeter", matches: ["https://example.com/*"], js: [{ code: "document.title" }], world: "USER_SCRIPT", worldId: "greeter-world"
}

const injection: UserScriptInjection = { target: { tabId: 7, allFrames: true }, js: [{ code: "document.title" }], world: "USER_SCRIPT" }

const frames: Array<InjectionResult> = [
  { frameId: 0, documentId: "main", result: "Example" },
  { frameId: 4, documentId: "child", result: null }
]

const mockApi = () => ({
  register: vi.fn(async (_scripts: Array<RegisteredUserScript>) => {}),
  update: vi.fn(async (_scripts: Array<RegisteredUserScript>) => {}),
  unregister: vi.fn(async (_filter?: UserScriptFilter) => {}),
  getScripts: vi.fn(async (_filter?: UserScriptFilter): Promise<Array<RegisteredUserScript>> => [script]),
  configureWorld: vi.fn(async (_properties: WorldProperties) => {}),
  getWorldConfigurations: vi.fn(async (): Promise<Array<WorldProperties>> => [{ worldId: "greeter-world", messaging: true }]),
  resetWorldConfiguration: vi.fn(async (_worldId?: string) => {}),
  execute: vi.fn(async (_injection: UserScriptInjection): Promise<Array<InjectionResult>> => frames)
}) satisfies ChromeUserScriptsApi

type Mock = ReturnType<typeof mockApi>

type Operation = keyof Mock

/** Each operation run through the service, with the native member it must reach. */
const calls: ReadonlyArray<readonly [Operation, (service: ReturnType<typeof make>) => Effect.Effect<void, ChromeUserScriptsError>]> = [
  ["register", (service) => service.register([script])],
  ["update", (service) => service.update([{ id: "greeter" }])],
  ["unregister", (service) => service.unregister({ ids: ["greeter"] })],
  ["getScripts", (service) => Effect.asVoid(service.getScripts())],
  ["configureWorld", (service) => service.configureWorld({ messaging: true })],
  ["getWorldConfigurations", (service) => Effect.asVoid(service.getWorldConfigurations)],
  ["resetWorldConfiguration", (service) => service.resetWorldConfiguration("greeter-world")],
  ["execute", (service) => Effect.asVoid(service.execute(injection))]
]

/** Restores stubbed globals when the test scope closes. */
const restoreGlobals = Effect.acquireRelease(Effect.void, () => Effect.sync(() => vi.unstubAllGlobals()))

describe("ChromeUserScripts", () => {
  it.effect("registers, updates, reads and unregisters scripts, passing a filter only when given", () => Effect.gen(function*() {
    const api = mockApi()
    const userScripts = make(api)
    const batch = [script]
    yield* userScripts.register(batch)
    expect(api.register.mock.calls[0]?.[0]).toBe(batch)
    yield* userScripts.update([{ id: "greeter", runAt: "document_start" }])
    expect(api.update).toHaveBeenCalledExactlyOnceWith([{ id: "greeter", runAt: "document_start" }])

    for (const filter of [undefined, {}, { ids: [] }, { ids: ["greeter"] }]) {
      expect(yield* userScripts.getScripts(filter)).toEqual([script])
      yield* userScripts.unregister(filter)
      const args = filter === undefined ? [] : [filter]
      expect(api.getScripts.mock.lastCall).toEqual(args)
      expect(api.unregister.mock.lastCall).toEqual(args)
    }
  }))

  it.effect("configures, lists and resets worlds, passing a world id only when given", () => Effect.gen(function*() {
    const api = mockApi()
    const userScripts = make(api)
    yield* userScripts.configureWorld({ worldId: "greeter-world", csp: "script-src 'self'", messaging: true })
    expect(api.configureWorld).toHaveBeenCalledExactlyOnceWith({ worldId: "greeter-world", csp: "script-src 'self'", messaging: true })
    expect(yield* userScripts.getWorldConfigurations).toEqual([{ worldId: "greeter-world", messaging: true }])
    yield* userScripts.resetWorldConfiguration()
    yield* userScripts.resetWorldConfiguration("greeter-world")
    yield* userScripts.resetWorldConfiguration("")
    expect(api.resetWorldConfiguration.mock.calls).toEqual([[], ["greeter-world"], [""]])
  }))

  it.effect("executes once, passing the injection unchanged and keeping per-frame results", () => Effect.gen(function*() {
    const api = mockApi()
    const results = yield* make(api).execute(injection)
    expect(api.execute.mock.calls).toEqual([[injection]])
    expect(api.execute.mock.calls[0]?.[0]).toBe(injection)
    expect(results).toBe(frames)
  }))

  it.effect("is lazy: nothing reaches Chrome until an operation runs, and each run calls again", () => Effect.gen(function*() {
    const api = mockApi()
    const userScripts = make(api)
    const pending = calls.map(([, run]) => run(userScripts))

    for (const [operation] of calls) expect(api[operation]).not.toHaveBeenCalled()

    yield* Effect.all(pending)
    yield* Effect.all(pending)

    for (const [operation] of calls) expect(api[operation]).toHaveBeenCalledTimes(2)
  }))

  it.effect("maps every rejection to the typed error with its operation and the cause unchanged", () => Effect.gen(function*() {
    for (const [operation, run] of calls) {
      const api = mockApi()
      const cause = new Error(`${operation} rejected`)
      api[operation].mockRejectedValueOnce(cause)
      const error = yield* Effect.flip(run(make(api)))
      expect(error).toBeInstanceOf(ChromeUserScriptsError)
      expect(error._tag).toBe("ChromeUserScriptsError")
      expect(error.operation).toBe(operation)
      expect(error.cause).toBe(cause)
    }
  }))

  it.effect("maps every synchronous throw, as after revoked access, to the typed error", () => Effect.gen(function*() {
    for (const [operation, run] of calls) {
      const api = mockApi()
      const revoked = new Error("The userScripts API is only available for users in developer mode.")
      api[operation].mockImplementationOnce(() => { throw revoked })
      const error = yield* Effect.flip(run(make(api)))
      expect(error).toMatchObject({ operation, cause: revoked })
    }
  }))

  it.effect("keeps non-Error causes, including undefined, as typed errors", () => Effect.gen(function*() {
    const api = mockApi()
    const userScripts = make(api)
    api.getScripts.mockRejectedValueOnce("plain string")
    expect(yield* Effect.flip(userScripts.getScripts())).toMatchObject({ operation: "getScripts", cause: "plain string" })
    api.register.mockRejectedValueOnce(undefined)
    const undefinedCause = yield* Effect.flip(userScripts.register([script]))
    expect(undefinedCause.operation).toBe("register")
    expect(undefinedCause.cause).toBeUndefined()
  }))

  it.effect("fails version-gated members absent before Chrome 133 and 135 with typed errors", () => Effect.gen(function*() {
    const { getWorldConfigurations: _get, resetWorldConfiguration: _reset, execute: _execute, ...older } = mockApi()
    const userScripts = make(older)
    const listed = yield* Effect.flip(userScripts.getWorldConfigurations)
    expect(listed).toMatchObject({ operation: "getWorldConfigurations", cause: { message: "userScripts.getWorldConfigurations is unavailable" } })
    const reset = yield* Effect.flip(userScripts.resetWorldConfiguration())
    expect(reset).toMatchObject({ operation: "resetWorldConfiguration", cause: { message: "userScripts.resetWorldConfiguration is unavailable" } })
    expect(yield* Effect.flip(userScripts.resetWorldConfiguration("w"))).toMatchObject({ operation: "resetWorldConfiguration" })
    const executed = yield* Effect.flip(userScripts.execute(injection))
    expect(executed).toMatchObject({ operation: "execute", cause: { message: "userScripts.execute is unavailable" } })
    expect(yield* userScripts.getScripts()).toEqual([script])
    yield* userScripts.configureWorld({ messaging: true })
    expect(older.configureWorld).toHaveBeenCalledOnce()
  }))

  it.effect("types registrations to require matches and a non-empty js", () => Effect.gen(function*() {
    const userScripts = make(mockApi())
    expectTypeOf(userScripts.register).parameter(0).toEqualTypeOf<Array<UserScriptRegistration>>()
    expectTypeOf(userScripts.update).parameter(0).toEqualTypeOf<Array<RegisteredUserScript>>()
    expectTypeOf(userScripts.execute(injection)).toEqualTypeOf<Effect.Effect<Array<InjectionResult>, ChromeUserScriptsError>>()
    // @ts-expect-error negative test: Chrome rejects a registration without js
    const withoutJs: UserScriptRegistration = { id: "a", matches: [] }
    // @ts-expect-error negative test: Chrome rejects an empty js list
    const emptyJs: UserScriptRegistration = { id: "a", matches: [], js: [] }
    // @ts-expect-error negative test: Chrome rejects a registration without matches
    const withoutMatches: UserScriptRegistration = { id: "a", js: [{ file: "a.js" }] }
    expect([withoutJs, emptyJs, withoutMatches].map((registration) => registration.id)).toEqual(["a", "a", "a"])
    yield* userScripts.register([{ id: "minimal", matches: [], js: [{ file: "minimal.js" }] }])
  }))

  it.effect("probes the injected API for availability on every run and never fails", () => Effect.gen(function*() {
    const api = mockApi()
    const userScripts = make(api)
    expect(api.getScripts).not.toHaveBeenCalled()
    expect(yield* userScripts.isAvailable).toBe(true)
    expect(api.getScripts.mock.lastCall).toEqual([])
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
    api.getScripts.mockImplementationOnce(() => { throw new Error("access revoked") })
    expect(yield* isAvailable).toBe(false)
    expect(yield* isAvailable).toBe(true)
  }))

  it.effect("fails the live layer with initialize and a cause pointing at the user toggle", () => Effect.gen(function*() {
    yield* restoreGlobals
    vi.stubGlobal("chrome", {})
    const missing = yield* Effect.flip(ChromeUserScripts.pipe(Effect.provide(layerLive)))
    expect(missing).toBeInstanceOf(ChromeUserScriptsError)
    expect(missing.operation).toBe("initialize")
    expect(missing.cause).toMatchObject({ message: unavailableMessage })
    expect(unavailableMessage).toContain("Allow User Scripts")
    expect(unavailableMessage).toContain("Developer mode")
    const denied = new Error("developer mode is off")
    vi.stubGlobal("chrome", { get userScripts() { throw denied } })
    const thrown = yield* Effect.flip(ChromeUserScripts.pipe(Effect.provide(layerLive)))
    expect(thrown.operation).toBe("initialize")
    expect(thrown.cause).toMatchObject({ message: unavailableMessage, cause: denied })
    vi.stubGlobal("chrome", undefined)
    const absent = yield* Effect.flip(ChromeUserScripts.pipe(Effect.provide(layerLive)))
    expect(absent.operation).toBe("initialize")
    expect(absent.cause).toBeInstanceOf(Error)
  }))

  it.effect("builds the live layer from a fake global, reading it once per build", () => Effect.gen(function*() {
    yield* restoreGlobals
    const api = mockApi()
    const getter = vi.fn((): ChromeUserScriptsApi => { throw new Error("API getter was read twice") }).mockImplementationOnce(() => api)
    vi.stubGlobal("chrome", { get userScripts() { return getter() } })
    const service = yield* ChromeUserScripts.pipe(Effect.provide(layerLive))
    expect(yield* service.getScripts()).toEqual([script])
    expect(yield* service.isAvailable).toBe(true)
    yield* service.execute(injection)
    expect(getter).toHaveBeenCalledTimes(1)
    api.register.mockImplementationOnce(() => { throw new Error("access revoked") })
    expect(yield* Effect.flip(service.register([script]))).toMatchObject({ operation: "register" })
  }))

  it.effect("provides an injected API through layer", () => Effect.gen(function*() {
    const api = mockApi()
    const scripts = yield* Effect.flatMap(ChromeUserScripts, (service) => service.getScripts()).pipe(Effect.provide(layer(api)))
    expect(scripts).toEqual([script])
  }))
})

describe("makeUserScripts", () => {
  const registration = (id: string, extra: Partial<UserScriptRegistration> = {}): UserScriptRegistration => ({
    id, matches: ["https://example.com/*"], js: [{ code: `"${id}"` }], ...extra
  })

  // Definitions a user-script manager loads as JSON: TypeScript cannot vouch for them; Chrome validates them.
  const loaded = (json: string): Array<RegisteredUserScript> => JSON.parse(json)

  const decoded = (json: string): UserScriptInjection => JSON.parse(json)

  const rejection = <A>(effect: Effect.Effect<A, ChromeUserScriptsError>) =>
    Effect.map(Effect.flip(effect), (error) => [error.operation, error.cause instanceof Error ? error.cause.message : error.cause])

  it.effect("registers with Chrome's defaults and returns isolated copies in registration order", () => Effect.gen(function*() {
    const fixture = makeUserScripts()
    const userScripts = make(fixture.api)
    const input = registration("b", { worldId: "w", includeGlobs: ["*b*"], excludeMatches: ["https://example.com/x"] })
    yield* userScripts.register([input, registration("a", { world: "MAIN", runAt: "document_start", allFrames: true })])
    input.matches.push("https://mutated.example/*")
    const listed = yield* userScripts.getScripts()
    expect(listed).toEqual([
      {
        id: "b", matches: ["https://example.com/*"], js: [{ code: "\"b\"" }], allFrames: false, runAt: "document_idle",
        world: "USER_SCRIPT", worldId: "w", includeGlobs: ["*b*"], excludeMatches: ["https://example.com/x"]
      },
      { id: "a", matches: ["https://example.com/*"], js: [{ code: "\"a\"" }], allFrames: true, runAt: "document_start", world: "MAIN" }
    ])
    listed[0]?.matches?.push("https://mutated.example/*")
    expect(fixture.controls.scripts()).toEqual(yield* userScripts.getScripts())
    expect((yield* userScripts.getScripts({ ids: ["a", "missing"] })).map(({ id }) => id)).toEqual(["a"])
    expect(yield* userScripts.getScripts({ ids: [] })).toEqual([])
    expect((yield* userScripts.getScripts({})).map(({ id }) => id)).toEqual(["b", "a"])
    // An empty world id is the default world, so it is not stored.
    yield* userScripts.register([registration("c", { worldId: "" })])
    expect(fixture.controls.scripts()[2]).not.toHaveProperty("worldId")
  }))

  it.effect("rejects invalid registrations atomically with Chrome's messages", () => Effect.gen(function*() {
    const fixture = makeUserScripts()
    const userScripts = make(fixture.api)
    yield* userScripts.register([registration("kept")])

    const invalid: ReadonlyArray<readonly [Array<RegisteredUserScript>, string]> = [
      [[registration("ok"), registration("")], "Script's ID must not be empty"],
      [[registration("ok"), registration("_reserved")], "Script's ID '_reserved' must not start with '_'"],
      [[registration("ok"), registration("kept")], "Duplicate script ID 'kept'"],
      [[registration("twice"), registration("twice")], "Duplicate script ID 'twice'"],
      [[registration("ok"), { id: "bare", js: [{ code: "1" }] }], "User script with ID 'bare' must specify 'matches'."],
      [[registration("ok"), { id: "bare", matches: [] }], "User script with ID 'bare' must specify at least one js source."],
      [[registration("ok"), { id: "bare", matches: [], js: [] }], "User script with ID 'bare' must specify at least one js source."],
      [loaded(`[{ "id": "both", "matches": [], "js": [{ "code": "1", "file": "a.js" }] }]`), "User script with ID 'both' must specify exactly one of 'code' or 'file' as a js source."],
      [loaded(`[{ "id": "neither", "matches": [], "js": [{}] }]`), "User script with ID 'neither' must specify exactly one of 'code' or 'file' as a js source."],
      [[registration("main", { world: "MAIN", worldId: "w" })], "World ID can only be specified for USER_SCRIPT worlds."],
      [[registration("main", { world: "MAIN", worldId: "" })], "World ID can only be specified for USER_SCRIPT worlds."],
      [[registration("reserved", { worldId: "_w" })], "World IDs beginning with '_' are reserved."],
      [[registration("long", { worldId: "w".repeat(257) })], "World IDs must be at most 256 characters."]
    ]

    for (const [batch, message] of invalid) {
      // SAFETY: invalid registrations are the subject here; the fixture, like Chrome, must reject them.
      const invalidBatch = batch as Array<UserScriptRegistration>
      expect(yield* rejection(userScripts.register(invalidBatch))).toEqual(["register", message])
      expect(fixture.controls.scripts().map(({ id }) => id)).toEqual(["kept"])
    }

    yield* userScripts.register([registration("long", { worldId: "w".repeat(256) })])
    expect(fixture.controls.scripts().map(({ id }) => id)).toEqual(["kept", "long"])
  }))

  it.effect("updates supplied fields atomically, keeping globs and registration order", () => Effect.gen(function*() {
    const fixture = makeUserScripts()
    const userScripts = make(fixture.api)
    yield* userScripts.register([registration("a", { includeGlobs: ["*a*"], worldId: "w" }), registration("b")])
    yield* userScripts.update([{ id: "a", runAt: "document_end", includeGlobs: ["*changed*"], excludeGlobs: ["*x*"], allFrames: true }])
    expect(fixture.controls.scripts()[0]).toEqual({
      id: "a", matches: ["https://example.com/*"], js: [{ code: "\"a\"" }], allFrames: true, runAt: "document_end",
      world: "USER_SCRIPT", worldId: "w", includeGlobs: ["*a*"]
    })
    const before = fixture.controls.scripts()
    expect(yield* rejection(userScripts.update([{ id: "b", runAt: "document_start" }, { id: "missing" }])))
      .toEqual(["update", "Script with ID 'missing' does not exist or is not fully registered"])
    expect(yield* rejection(userScripts.update([{ id: "b", runAt: "document_start" }, { id: "a", js: [] }])))
      .toEqual(["update", "User script with ID 'a' must specify at least one js source."])
    expect(yield* rejection(userScripts.update([{ id: "a", world: "MAIN" }])))
      .toEqual(["update", "World ID can only be specified for USER_SCRIPT worlds."])
    expect(fixture.controls.scripts()).toEqual(before)
    yield* userScripts.update([{ id: "a", worldId: "" }])
    yield* userScripts.update([{ id: "a", world: "MAIN" }])
    expect(fixture.controls.scripts().map(({ id, world, worldId }) => [id, world, worldId])).toEqual([["a", "MAIN", undefined], ["b", "USER_SCRIPT", undefined]])
  }))

  it.effect("unregisters by id atomically, everything without ids, and nothing for an empty list", () => Effect.gen(function*() {
    const fixture = makeUserScripts()
    const userScripts = make(fixture.api)
    yield* userScripts.register(["a", "b", "c"].map((id) => registration(id)))
    expect(yield* rejection(userScripts.unregister({ ids: ["a", "missing"] }))).toEqual(["unregister", "Nonexistent script ID 'missing'"])
    expect(yield* rejection(userScripts.unregister({ ids: ["a", "_x"] }))).toEqual(["unregister", "Script's ID '_x' must not start with '_'"])
    expect(yield* rejection(userScripts.unregister({ ids: [""] }))).toEqual(["unregister", "Script's ID must not be empty"])
    yield* userScripts.unregister({ ids: [] })
    expect(fixture.controls.scripts().map(({ id }) => id)).toEqual(["a", "b", "c"])
    yield* userScripts.unregister({ ids: ["b", "b"] })
    expect(fixture.controls.scripts().map(({ id }) => id)).toEqual(["a", "c"])
    yield* userScripts.unregister({})
    expect(fixture.controls.scripts()).toEqual([])
    yield* userScripts.register([registration("d")])
    yield* userScripts.unregister()
    expect(fixture.controls.scripts()).toEqual([])
  }))

  it.effect("stores world configurations like Chrome, up to its limit", () => Effect.gen(function*() {
    const fixture = makeUserScripts()
    const userScripts = make(fixture.api)
    yield* userScripts.configureWorld({ worldId: "noop" })
    yield* userScripts.configureWorld({ worldId: "noop", messaging: false })
    expect(yield* userScripts.getWorldConfigurations).toEqual([])
    yield* userScripts.configureWorld({ messaging: true })
    yield* userScripts.configureWorld({ worldId: "w", csp: "script-src 'none'" })
    yield* userScripts.configureWorld({ worldId: "w", messaging: true })
    expect(yield* userScripts.getWorldConfigurations).toEqual([
      { messaging: true },
      { worldId: "w", csp: "script-src 'none'", messaging: true }
    ])
    expect(yield* rejection(userScripts.configureWorld({ worldId: "_w" }))).toEqual(["configureWorld", "World IDs beginning with '_' are reserved."])
    expect(yield* rejection(userScripts.resetWorldConfiguration("w".repeat(257)))).toEqual(["resetWorldConfiguration", "World IDs must be at most 256 characters."])
    yield* userScripts.resetWorldConfiguration("")
    yield* userScripts.resetWorldConfiguration("never-configured")
    expect(fixture.controls.worlds()).toEqual([{ worldId: "w", csp: "script-src 'none'", messaging: true }])
    yield* userScripts.resetWorldConfiguration()
    yield* userScripts.resetWorldConfiguration("w")
    expect(fixture.controls.worlds()).toEqual([])

    for (let index = 0; index < maxWorlds; index++) yield* userScripts.configureWorld({ worldId: `w${index}`, messaging: true })

    const limit = `You may only configure up to ${maxWorlds} individual user script worlds.`
    expect(yield* rejection(userScripts.configureWorld({ worldId: "one-more", messaging: true }))).toEqual(["configureWorld", limit])
    // Chrome counts before looking at the target, so even an existing world is refused at the limit.
    expect(yield* rejection(userScripts.configureWorld({ worldId: "w0", csp: "x" }))).toEqual(["configureWorld", limit])
    yield* userScripts.resetWorldConfiguration("w0")
    yield* userScripts.configureWorld({ worldId: "one-more", messaging: true })
    expect((yield* userScripts.getWorldConfigurations).length).toBe(maxWorlds)
  }))

  it.effect("validates injections and reports frames like Chrome", () => Effect.gen(function*() {
    const fixture = makeUserScripts()
    const userScripts = make(fixture.api)
    expect(yield* rejection(userScripts.execute(injection))).toEqual(["execute", "No tab with id: 7"])

    const responder = vi.fn((_injection: UserScriptInjection): ReadonlyArray<FrameOutcome> => [
      { frameId: 3, documentId: "c", result: 0 },
      { frameId: 5, documentId: "gone", error: "Frame was removed" },
      { frameId: 0, documentId: "top", result: { title: "Example" } },
      { frameId: 4, documentId: "d" },
      { frameId: 6, documentId: "e", result: false }
    ])

    fixture.controls.respond(responder)
    expect(yield* userScripts.execute(injection)).toEqual([
      { frameId: 0, documentId: "top", result: { title: "Example" } },
      { frameId: 3, documentId: "c", result: 0 },
      { frameId: 4, documentId: "d", result: null },
      { frameId: 6, documentId: "e", result: false }
    ])
    expect(responder.mock.calls[0]?.[0]).toEqual(injection)
    expect(responder.mock.calls[0]?.[0]).not.toBe(injection)
    fixture.controls.respond(async () => [{ frameId: 0, documentId: "top", error: "Cannot access contents of the page." }])
    expect(yield* rejection(userScripts.execute(injection))).toEqual(["execute", "Cannot access contents of the page."])
    fixture.controls.respond(() => [])
    expect(yield* userScripts.execute(injection)).toEqual([])

    const invalid: ReadonlyArray<readonly [UserScriptInjection, string]> = [
      [decoded(`{ "target": { "tabId": 1 }, "js": [] }`), "User script must specify at least one js source."],
      [decoded(`{ "target": { "tabId": 1 }, "js": [{ "code": "1", "file": "a.js" }] }`), "User script must specify exactly one of 'code' or 'file' as a js source."],
      [{ target: { tabId: 1 }, js: [{ code: "1" }], world: "MAIN", worldId: "w" }, "World ID can only be specified for USER_SCRIPT worlds."],
      [{ target: { tabId: 1 }, js: [{ code: "1" }], worldId: "_w" }, "World IDs beginning with '_' are reserved."],
      [decoded(`{ "target": { "tabId": 1, "frameIds": [0], "documentIds": ["d"] }, "js": [{ "code": "1" }] }`), "Cannot specify both 'frameIds' and 'documentIds'."],
      [decoded(`{ "target": { "tabId": 1, "allFrames": true, "frameIds": [0] }, "js": [{ "code": "1" }] }`), "Cannot specify 'allFrames' if either 'frameIds' or 'documentIds' is specified."]
    ]

    for (const [request, message] of invalid) {
      expect(yield* rejection(userScripts.execute(request))).toEqual(["execute", message])
    }

    expect(responder).toHaveBeenCalledOnce()
  }))

  it.effect("throws synchronously from every member while access is off, and recovers", () => Effect.gen(function*() {
    const fixture = makeUserScripts()
    const userScripts = make(fixture.api)
    fixture.controls.respond(() => [{ frameId: 0, documentId: "top", result: 1 }])
    fixture.controls.setAccess(false)
    expect(() => fixture.api.getScripts()).toThrow(accessOffMessage)
    expect(yield* userScripts.isAvailable).toBe(false)

    for (const [operation, run] of calls) {
      expect(yield* rejection(run(userScripts))).toEqual([operation, accessOffMessage])
    }

    fixture.controls.setAccess(true)
    expect(yield* userScripts.isAvailable).toBe(true)
    expect(yield* userScripts.execute(injection)).toEqual([{ frameId: 0, documentId: "top", result: 1 }])
  }))

  it.effect("fails the next call of an operation once, after the access check", () => Effect.gen(function*() {
    const fixture = makeUserScripts()
    const userScripts = make(fixture.api)
    const operations: ReadonlyArray<UserScriptsOperation> = calls.map(([operation]) => operation)
    fixture.controls.respond(() => [])
    yield* userScripts.register([script])

    for (const operation of operations) fixture.controls.failNext(operation, new Error(`${operation} failed`))

    fixture.controls.setAccess(false)
    expect(yield* rejection(userScripts.getScripts())).toEqual(["getScripts", accessOffMessage])
    fixture.controls.setAccess(true)

    for (const [operation, run] of calls) {
      const exit = yield* Effect.exit(run(userScripts))
      expect(exit).toEqual(Exit.fail(new ChromeUserScriptsError({ operation, cause: new Error(`${operation} failed`) })))
    }

    expect(fixture.controls.scripts().map(({ id }) => id)).toEqual(["greeter"])
    yield* userScripts.unregister()

    for (const [, run] of calls) yield* run(userScripts)
  }))

  it.effect("replaces members with overrides and provides its layer over the same state", () => Effect.gen(function*() {
    const getScripts = vi.fn(async (): Promise<Array<RegisteredUserScript>> => [script])
    const fixture = makeUserScripts({ getScripts })
    expect(yield* make(fixture.api).getScripts()).toEqual([script])
    expect(getScripts).toHaveBeenCalledOnce()
    const plain = makeUserScripts()
    yield* Effect.flatMap(ChromeUserScripts, (service) => service.register([registration("from-layer")])).pipe(Effect.provide(plain.layer))
    expect(plain.controls.scripts().map(({ id }) => id)).toEqual(["from-layer"])
  }))
})

