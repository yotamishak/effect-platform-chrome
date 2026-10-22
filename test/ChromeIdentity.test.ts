// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Exit, Fiber, Option, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeIdentity, ChromeIdentityError, layer, layerLive, make } from "../src/ChromeIdentity.js"
import type { ChromeIdentityApi, ChromeIdentityService } from "../src/ChromeIdentity.js"
import { makeEvent } from "../src/testing/Event.js"
import { makeIdentity } from "../src/testing/Identity.js"

const redirect = "https://extension-id.chromiumapp.org/"

/** A full API whose members are fresh spies and whose event is a fresh simulated event. */
const mockApi = () => {
  const signInChanged = makeEvent<[chrome.identity.AccountInfo, boolean]>()

  const api = {
    getRedirectURL: vi.fn((path?: string) => `${redirect}${path ?? ""}`),
    launchWebAuthFlow: vi.fn(async (details: chrome.identity.WebAuthFlowDetails): Promise<string | undefined> =>
      `${redirect}?code=code&from=${encodeURIComponent(details.url)}`),
    getAuthToken: vi.fn(async (_details?: chrome.identity.TokenDetails): Promise<chrome.identity.GetAuthTokenResult> =>
      ({ token: "token", grantedScopes: ["email"] })),
    removeCachedAuthToken: vi.fn(async (_details: chrome.identity.InvalidTokenDetails) => {}),
    clearAllCachedAuthTokens: vi.fn(async () => {}),
    getProfileUserInfo: vi.fn(async (_details?: chrome.identity.ProfileDetails): Promise<chrome.identity.ProfileUserInfo> =>
      ({ email: "user@example.com", id: "user" })),
    getAccounts: vi.fn(async (): Promise<Array<chrome.identity.AccountInfo>> => [{ id: "user" }]),
    onSignInChanged: signInChanged.api
  } satisfies ChromeIdentityApi

  return { api, signInChanged: signInChanged.controls }
}

/** Only the members every Chromium browser has. */
const webAuthOnlyApi = (): ChromeIdentityApi => ({
  getRedirectURL: (path) => `${redirect}${path ?? ""}`,
  launchWebAuthFlow: async () => redirect
})

type Api = ReturnType<typeof mockApi>["api"]

type Member = "getRedirectURL" | "launchWebAuthFlow" | "getAuthToken" | "removeCachedAuthToken"
  | "clearAllCachedAuthTokens" | "getProfileUserInfo" | "getAccounts"

type CallResult = string | Option.Option<string> | void | chrome.identity.GetAuthTokenResult
  | chrome.identity.ProfileUserInfo | Array<chrome.identity.AccountInfo>

/** Every call, with the API member it reaches and how the service invokes it. */
const calls: ReadonlyArray<{
  readonly member: Member
  readonly run: (identity: ChromeIdentityService) => Effect.Effect<CallResult, ChromeIdentityError>
}> = [
  { member: "getRedirectURL", run: (identity) => identity.getRedirectURL("cb") },
  { member: "launchWebAuthFlow", run: (identity) => identity.launchWebAuthFlow({ url: "https://auth.example/" }) },
  { member: "getAuthToken", run: (identity) => identity.getAuthToken({ interactive: true }) },
  { member: "removeCachedAuthToken", run: (identity) => identity.removeCachedAuthToken({ token: "token" }) },
  { member: "clearAllCachedAuthTokens", run: (identity) => identity.clearAllCachedAuthTokens },
  { member: "getProfileUserInfo", run: (identity) => identity.getProfileUserInfo({ accountStatus: "ANY" }) },
  { member: "getAccounts", run: (identity) => identity.getAccounts }
]

/** Makes one member reject (or throw, for the synchronous `getRedirectURL`) once. */
const failOnce = (api: Api, member: Member, cause: Error, how: "reject" | "throw") => {
  const fail = (): Promise<never> => {
    if (how === "throw") throw cause

    return Promise.reject(cause)
  }

  switch (member) {
    case "getRedirectURL": api.getRedirectURL.mockImplementationOnce(() => { throw cause }); break
    case "launchWebAuthFlow": api.launchWebAuthFlow.mockImplementationOnce(fail); break
    case "getAuthToken": api.getAuthToken.mockImplementationOnce(fail); break
    case "removeCachedAuthToken": api.removeCachedAuthToken.mockImplementationOnce(fail); break
    case "clearAllCachedAuthTokens": api.clearAllCachedAuthTokens.mockImplementationOnce(fail); break
    case "getProfileUserInfo": api.getProfileUserInfo.mockImplementationOnce(fail); break
    case "getAccounts": api.getAccounts.mockImplementationOnce(fail); break
  }
}

/** What a test puts in place of the `chrome` global. */
interface FakeChrome {
  readonly identity?: ChromeIdentityApi
}

const stubChrome = (value: FakeChrome | undefined) =>
  Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", value)), () => Effect.sync(() => vi.unstubAllGlobals()))

describe("ChromeIdentity calls", () => {
  it.effect("reads the redirect URL lazily, passing the path only when given", () => Effect.gen(function*() {
    const { api } = mockApi()
    const identity = make(api)
    const lookup = identity.getRedirectURL()
    expect(api.getRedirectURL).not.toHaveBeenCalled()
    expect(yield* lookup).toBe(redirect)
    expect(yield* identity.getRedirectURL("callback")).toBe(`${redirect}callback`)
    expect(yield* identity.getRedirectURL("")).toBe(redirect)
    expect(yield* lookup).toBe(redirect)
    expect(api.getRedirectURL.mock.calls).toEqual([[], ["callback"], [""], []])
  }))

  it.effect("runs a web auth flow lazily with its details unchanged, as Some redirect URL", () => Effect.gen(function*() {
    const { api } = mockApi()

    const details: chrome.identity.WebAuthFlowDetails = {
      url: "https://auth.example/authorize", interactive: false, abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 5000
    }

    const flow = make(api).launchWebAuthFlow(details)
    expect(api.launchWebAuthFlow).not.toHaveBeenCalled()
    expect(yield* flow).toEqual(Option.some(`${redirect}?code=code&from=${encodeURIComponent("https://auth.example/authorize")}`))
    expect(api.launchWebAuthFlow).toHaveBeenCalledExactlyOnceWith(details)
    expect(api.launchWebAuthFlow.mock.calls[0]?.[0]).toBe(details)
  }))

  it.effect("returns None when Chrome resolves a web auth flow without a URL", () => Effect.gen(function*() {
    const { api } = mockApi()
    api.launchWebAuthFlow.mockResolvedValueOnce(undefined)
    expect(yield* make(api).launchWebAuthFlow({ url: "https://auth.example/" })).toEqual(Option.none())
    // An empty URL is still a URL Chrome reported.
    api.launchWebAuthFlow.mockResolvedValueOnce("")
    expect(yield* make(api).launchWebAuthFlow({ url: "https://auth.example/" })).toEqual(Option.some(""))
  }))

  it.effect("calls the Google token APIs lazily, passing optional details only when given", () => Effect.gen(function*() {
    const { api } = mockApi()
    const identity = make(api)
    const token = identity.getAuthToken({ interactive: false, scopes: ["email"] })
    const clear = identity.clearAllCachedAuthTokens
    const accounts = identity.getAccounts
    expect(api.getAuthToken).not.toHaveBeenCalled()
    expect(api.clearAllCachedAuthTokens).not.toHaveBeenCalled()
    expect(api.getAccounts).not.toHaveBeenCalled()
    expect(yield* token).toEqual({ token: "token", grantedScopes: ["email"] })
    yield* identity.getAuthToken()
    yield* identity.removeCachedAuthToken({ token: "token" })
    yield* clear
    yield* clear
    expect(yield* identity.getProfileUserInfo()).toEqual({ email: "user@example.com", id: "user" })
    yield* identity.getProfileUserInfo({ accountStatus: "ANY" })
    expect(yield* accounts).toEqual([{ id: "user" }])
    expect(api.getAuthToken.mock.calls).toEqual([[{ interactive: false, scopes: ["email"] }], []])
    expect(api.removeCachedAuthToken.mock.calls).toEqual([[{ token: "token" }]])
    expect(api.clearAllCachedAuthTokens.mock.calls).toEqual([[], []])
    expect(api.getProfileUserInfo.mock.calls).toEqual([[], [{ accountStatus: "ANY" }]])
    expect(api.getAccounts.mock.calls).toEqual([[]])
  }))

  it.effect("returns Chrome's token result and empty account lists unchanged", () => Effect.gen(function*() {
    const { api } = mockApi()
    const result: chrome.identity.GetAuthTokenResult = { token: "t" }
    api.getAuthToken.mockResolvedValueOnce(result)
    api.getAccounts.mockResolvedValueOnce([])
    api.getProfileUserInfo.mockResolvedValueOnce({ email: "", id: "" })
    const identity = make(api)
    expect(yield* identity.getAuthToken()).toBe(result)
    expect(yield* identity.getAccounts).toEqual([])
    expect(yield* identity.getProfileUserInfo()).toEqual({ email: "", id: "" })
  }))

  it.effect.each(calls)("types a rejection and a synchronous throw from $member", ({ member, run }) => Effect.gen(function*() {
    const { api } = mockApi()
    const identity = make(api)

    for (const how of ["reject", "throw"] as const) {
      const cause = new Error(`${member} ${how}`)
      failOnce(api, member, cause, how)
      const exit = yield* Effect.exit(run(identity))
      expect(Exit.hasDies(exit)).toBe(false)
      const error = yield* Effect.flip(exit)
      expect(error).toBeInstanceOf(ChromeIdentityError)
      expect(error._tag).toBe("ChromeIdentityError")
      expect(error).toMatchObject({ operation: member, cause })
    }

    // The failures were one-shot: the same Effect value succeeds afterwards.
    expect(Exit.isSuccess(yield* Effect.exit(run(identity)))).toBe(true)
  }))

  it.effect("keeps non-Error rejection causes unchanged", () => Effect.gen(function*() {
    const { api } = mockApi()
    const cause = { message: "Authorization page could not be loaded." }
    api.launchWebAuthFlow.mockRejectedValueOnce(cause)
    api.getAuthToken.mockRejectedValueOnce("string cause")
    const identity = make(api)
    expect((yield* Effect.flip(identity.launchWebAuthFlow({ url: "https://auth.example/" }))).cause).toBe(cause)
    expect((yield* Effect.flip(identity.getAuthToken())).cause).toBe("string cause")
  }))

  it.effect("fails Google account members absent from an injected API with typed errors", () => Effect.gen(function*() {
    const identity = make(webAuthOnlyApi())

    const absent = [
      ["getAuthToken", identity.getAuthToken()],
      ["removeCachedAuthToken", identity.removeCachedAuthToken({ token: "token" })],
      ["clearAllCachedAuthTokens", identity.clearAllCachedAuthTokens],
      ["getProfileUserInfo", identity.getProfileUserInfo()],
      ["getAccounts", identity.getAccounts],
      ["onSignInChanged", Stream.runDrain(identity.onSignInChanged)]
    ] as const

    for (const [operation, effect] of absent) {
      const error = yield* Effect.flip(effect)
      expect(error).toBeInstanceOf(ChromeIdentityError)
      expect(error.operation).toBe(operation)
      expect(error.cause).toEqual(new Error(`identity.${operation} is unavailable`))
    }

    // The web auth flow members still work.
    expect(yield* identity.launchWebAuthFlow({ url: "https://auth.example/" })).toEqual(Option.some(redirect))
  }))

  it.effect("checks an optional member when the call runs, not when the service is made", () => Effect.gen(function*() {
    const api: { -readonly [K in keyof ChromeIdentityApi]: ChromeIdentityApi[K] } = webAuthOnlyApi()
    const identity = make(api)
    const accounts = identity.getAccounts
    expect((yield* Effect.flip(accounts)).operation).toBe("getAccounts")
    api.getAccounts = async () => [{ id: "late" }]
    expect(yield* accounts).toEqual([{ id: "late" }])
  }))

  it.effect("types a throwing member getter as that operation's error", () => Effect.gen(function*() {
    const cause = new Error("getter failed")

    const api: ChromeIdentityApi = {
      getRedirectURL: () => redirect,
      launchWebAuthFlow: async () => redirect,
      get getAuthToken(): never { throw cause },
      get onSignInChanged(): never { throw cause }
    }

    const identity = make(api)
    expect(yield* Effect.flip(identity.getAuthToken())).toMatchObject({ operation: "getAuthToken", cause })
    expect(yield* Effect.flip(Stream.runDrain(identity.onSignInChanged))).toMatchObject({ operation: "onSignInChanged", cause })
  }))
})

describe("ChromeIdentity onSignInChanged", () => {
  it.effect("registers nothing until consumed, then delivers named fields in order and removes the listener", () => Effect.gen(function*() {
    const { api, signInChanged } = mockApi()
    const stream = make(api).onSignInChanged
    expect(signInChanged.listenerCount).toBe(0)
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 3)))
    yield* Effect.promise(() => signInChanged.waitForListener())
    expect(signInChanged.listenerCount).toBe(1)
    signInChanged.emit({ id: "a" }, true)
    signInChanged.emit({ id: "a" }, false)
    signInChanged.emit({ id: "b" }, true)
    expect(yield* Fiber.join(fiber)).toEqual([
      { account: { id: "a" }, signedIn: true },
      { account: { id: "a" }, signedIn: false },
      { account: { id: "b" }, signedIn: true }
    ])
    expect(signInChanged.listenerCount).toBe(0)
  }))

  it.effect("removes the listener when the consumer is interrupted", () => Effect.gen(function*() {
    const { api, signInChanged } = mockApi()
    const fiber = yield* Effect.forkScoped(Stream.runDrain(make(api).onSignInChanged))
    yield* Effect.promise(() => signInChanged.waitForListener())
    signInChanged.emit({ id: "a" }, true)
    yield* Fiber.interrupt(fiber)
    expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
    expect(signInChanged.listenerCount).toBe(0)
    // A late emission reaches nothing and throws nothing.
    expect(signInChanged.emit({ id: "a" }, false)).toEqual([])
  }))

  it.effect("removes the listener when the consumer fails", () => Effect.gen(function*() {
    const { api, signInChanged } = mockApi()
    const failure = new ChromeIdentityError({ operation: "consumer", cause: "stop" })
    const fiber = yield* Effect.forkScoped(Stream.runDrain(Stream.mapEffect(make(api).onSignInChanged, () => Effect.fail(failure))))
    yield* Effect.promise(() => signInChanged.waitForListener())
    signInChanged.emit({ id: "a" }, true)
    expect(yield* Effect.flip(Fiber.join(fiber))).toBe(failure)
    expect(signInChanged.listenerCount).toBe(0)
  }))

  it.effect("gives each consumption its own listener", () => Effect.gen(function*() {
    const { api, signInChanged } = mockApi()
    const source = api.onSignInChanged
    let bothAdded!: () => void
    const registered = new Promise<void>((resolve) => { bothAdded = resolve })
    let adds = 0

    const counted: ChromeIdentityApi = {
      ...api,
      onSignInChanged: {
        addListener: (listener) => {
          source.addListener(listener)
          adds++

          if (adds === 2) bothAdded()
        },
        removeListener: (listener) => source.removeListener(listener)
      }
    }

    const stream = make(counted).onSignInChanged
    const first = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 1)))
    const second = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 2)))
    yield* Effect.promise(() => registered)
    expect(signInChanged.listenerCount).toBe(2)
    signInChanged.emit({ id: "a" }, true)
    expect(yield* Fiber.join(first)).toEqual([{ account: { id: "a" }, signedIn: true }])
    expect(signInChanged.listenerCount).toBe(1)
    signInChanged.emit({ id: "a" }, false)
    expect(yield* Fiber.join(second)).toEqual([{ account: { id: "a" }, signedIn: true }, { account: { id: "a" }, signedIn: false }])
    expect(signInChanged.listenerCount).toBe(0)
  }))

  it.effect("types a failed registration and leaves no listener", () => Effect.gen(function*() {
    const { api, signInChanged } = mockApi()
    const cause = new Error("registration failed")
    signInChanged.failNext("addListener", cause)
    const error = yield* Effect.flip(Stream.runDrain(make(api).onSignInChanged))
    expect(error).toBeInstanceOf(ChromeIdentityError)
    expect(error).toMatchObject({ operation: "onSignInChanged", cause })
    expect(signInChanged.listenerCount).toBe(0)
  }))

  it.effect("removes a listener whose registration threw after adding it", () => Effect.gen(function*() {
    const { api, signInChanged } = mockApi()
    const cause = new Error("added, then threw")
    const source = api.onSignInChanged

    const partial: ChromeIdentityApi = {
      ...api,
      onSignInChanged: {
        addListener: (listener) => {
          source.addListener(listener)
          throw cause
        },
        removeListener: (listener) => source.removeListener(listener)
      }
    }

    expect(yield* Effect.flip(Stream.runDrain(make(partial).onSignInChanged))).toMatchObject({ operation: "onSignInChanged", cause })
    expect(signInChanged.listenerCount).toBe(0)
  }))
})

describe("ChromeIdentity layers", () => {
  it.effect("provides an injected API", () => Effect.gen(function*() {
    const { api } = mockApi()
    expect(yield* Effect.flatMap(ChromeIdentity, (identity) => identity.getRedirectURL()).pipe(Effect.provide(layer(api)))).toBe(redirect)
  }))

  it.effect("makes the service without reading globals", () => Effect.gen(function*() {
    yield* stubChrome({ get identity(): never { throw new Error("read chrome.identity") } })
    const identity = make(webAuthOnlyApi())
    expect(yield* identity.getRedirectURL("x")).toBe(`${redirect}x`)
  }))

  it.effect("fails the live layer with initialize when there is no chrome global", () => Effect.gen(function*() {
    yield* stubChrome(undefined)
    const error = yield* Effect.flip(ChromeIdentity.pipe(Effect.provide(layerLive)))
    expect(error).toBeInstanceOf(ChromeIdentityError)
    expect(error.operation).toBe("initialize")
    expect(error.cause).toEqual(new Error("chrome.identity is unavailable in this context"))
  }))

  it.effect("fails the live layer with initialize without chrome.identity or when reading it throws", () => Effect.gen(function*() {
    yield* stubChrome({})
    expect(yield* Effect.flip(ChromeIdentity.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
    const cause = new Error("identity permission missing")
    vi.stubGlobal("chrome", { get identity() { throw cause } })
    expect(yield* Effect.flip(ChromeIdentity.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize", cause })
  }))

  it.effect("builds the live layer from a fake global, read when it builds", () => Effect.gen(function*() {
    const { api, signInChanged } = mockApi()
    yield* stubChrome({ identity: api })
    const identity = yield* ChromeIdentity.pipe(Effect.provide(layerLive))
    expect(yield* identity.getRedirectURL()).toBe(redirect)
    expect(yield* identity.getAuthToken()).toEqual({ token: "token", grantedScopes: ["email"] })
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(identity.onSignInChanged, 1)))
    yield* Effect.promise(() => signInChanged.waitForListener())
    signInChanged.emit({ id: "user" }, true)
    expect(yield* Fiber.join(fiber)).toEqual([{ account: { id: "user" }, signedIn: true }])
    // A later build reads the global again.
    const other = mockApi()
    other.api.getRedirectURL.mockReturnValue("https://other.chromiumapp.org/")
    vi.stubGlobal("chrome", { identity: other.api })
    expect(yield* Effect.flatMap(ChromeIdentity, (service) => service.getRedirectURL()).pipe(Effect.provide(layerLive)))
      .toBe("https://other.chromiumapp.org/")
  }))
})

describe("makeIdentity", () => {
  it.effect("builds redirect URLs from the configured base the way Chrome joins paths", () => Effect.gen(function*() {
    const identity = make(makeIdentity({ redirectURL: "https://abc.chromiumapp.org/" }).api)
    expect(yield* identity.getRedirectURL()).toBe("https://abc.chromiumapp.org/")
    expect(yield* identity.getRedirectURL("")).toBe("https://abc.chromiumapp.org/")
    expect(yield* identity.getRedirectURL("/callback")).toBe("https://abc.chromiumapp.org/callback")
    expect(yield* identity.getRedirectURL("callback?x=1")).toBe("https://abc.chromiumapp.org/callback?x=1")
    expect(yield* identity.getRedirectURL("//double")).toBe("https://abc.chromiumapp.org//double")
    expect(yield* make(makeIdentity().api).getRedirectURL("cb")).toBe("https://test-extension-id.chromiumapp.org/cb")
  }))

  it.effect("does not glue a path onto a base without a trailing slash", () => Effect.gen(function*() {
    const identity = make(makeIdentity({ redirectURL: "https://abc.chromiumapp.org" }).api)
    expect(yield* identity.getRedirectURL()).toBe("https://abc.chromiumapp.org/")
    expect(yield* identity.getRedirectURL("cb")).toBe("https://abc.chromiumapp.org/cb")
  }))

  it.effect("plays scripted web auth flow outcomes in order and rejects unscripted flows", () => Effect.gen(function*() {
    const fixture = makeIdentity()
    const identity = make(fixture.api)
    const denied = new Error("access_denied")
    fixture.controls.resolveNextFlow("https://test-extension-id.chromiumapp.org/?code=1")
    fixture.controls.resolveNextFlow((details) => `${details.url}#echo`)
    fixture.controls.rejectNextFlow(denied)
    fixture.controls.resolveNextFlow(() => undefined)
    expect(yield* identity.launchWebAuthFlow({ url: "https://auth.example/1", interactive: true }))
      .toEqual(Option.some("https://test-extension-id.chromiumapp.org/?code=1"))
    expect(yield* identity.launchWebAuthFlow({ url: "https://auth.example/2" })).toEqual(Option.some("https://auth.example/2#echo"))
    expect(yield* Effect.flip(identity.launchWebAuthFlow({ url: "https://auth.example/3" }))).toMatchObject({ operation: "launchWebAuthFlow", cause: denied })
    expect(yield* identity.launchWebAuthFlow({ url: "https://auth.example/4" })).toEqual(Option.none())
    expect((yield* Effect.flip(identity.launchWebAuthFlow({ url: "https://auth.example/5" }))).cause).toEqual(new Error("User interaction required."))
    expect((yield* Effect.flip(identity.launchWebAuthFlow({ url: "https://auth.example/6", interactive: true }))).cause)
      .toEqual(new Error("The user did not approve access."))
    expect(fixture.controls.flows.map((details) => details.url)).toEqual([1, 2, 3, 4, 5, 6].map((index) => `https://auth.example/${index}`))
  }))

  it.effect("records a copy of each flow's details and types a throwing resolver", () => Effect.gen(function*() {
    const fixture = makeIdentity()
    const identity = make(fixture.api)
    const details: chrome.identity.WebAuthFlowDetails = { url: "https://auth.example/", interactive: false, timeoutMsForNonInteractive: 10 }
    const cause = new Error("resolver failed")
    fixture.controls.resolveNextFlow(() => { throw cause })
    expect(yield* Effect.flip(identity.launchWebAuthFlow(details))).toMatchObject({ operation: "launchWebAuthFlow", cause })
    details.url = "https://mutated.example/"
    expect(fixture.controls.flows).toEqual([{ url: "https://auth.example/", interactive: false, timeoutMsForNonInteractive: 10 }])
  }))

  it.effect("serves, grants and evicts cached tokens per scope set", () => Effect.gen(function*() {
    const fixture = makeIdentity()
    const identity = make(fixture.api)
    expect((yield* Effect.flip(identity.getAuthToken({ interactive: true }))).cause).toEqual(new Error("The user is not signed in."))
    fixture.controls.signIn({ email: "user@example.com", id: "user" })
    expect(yield* identity.getProfileUserInfo()).toEqual({ email: "user@example.com", id: "user" })
    expect((yield* Effect.flip(identity.getAuthToken({ scopes: ["email"] }))).cause).toEqual(new Error("OAuth2 not granted or revoked."))
    fixture.controls.grantNext("granted")
    expect(yield* identity.getAuthToken({ interactive: true, scopes: ["email", "profile"] })).toEqual({ token: "granted", grantedScopes: ["email", "profile"] })
    expect(yield* identity.getAuthToken({ scopes: ["profile", "email", "profile"] })).toEqual({ token: "granted", grantedScopes: ["email", "profile"] })
    expect((yield* Effect.flip(identity.getAuthToken({ interactive: true }))).cause).toEqual(new Error("The user did not approve access."))
    fixture.controls.cacheToken("seeded")
    expect(yield* identity.getAuthToken()).toEqual({ token: "seeded", grantedScopes: [] })
    expect(fixture.controls.cachedTokens()).toEqual(["granted", "seeded"])
    yield* identity.removeCachedAuthToken({ token: "granted" })
    yield* identity.removeCachedAuthToken({ token: "unknown" })
    expect(fixture.controls.cachedTokens()).toEqual(["seeded"])
    yield* identity.clearAllCachedAuthTokens
    expect(fixture.controls.cachedTokens()).toEqual([])
    expect((yield* Effect.flip(identity.getAuthToken())).cause).toEqual(new Error("OAuth2 not granted or revoked."))
  }))

  it.effect("deduplicates granted scopes and isolates returned scope lists from the cache", () => Effect.gen(function*() {
    const fixture = makeIdentity()
    const identity = make(fixture.api)
    fixture.controls.signIn({ email: "user@example.com", id: "user" })
    fixture.controls.grantNext("granted")
    const first = yield* identity.getAuthToken({ interactive: true, scopes: ["b", "a", "b"] })
    expect(first).toEqual({ token: "granted", grantedScopes: ["a", "b"] })
    first.grantedScopes?.push("tampered")
    expect(yield* identity.getAuthToken({ scopes: ["a", "b"] })).toEqual({ token: "granted", grantedScopes: ["a", "b"] })
    fixture.controls.cacheToken("seeded", ["z", "y", "z"])
    expect(yield* identity.getAuthToken({ scopes: ["y", "z"] })).toEqual({ token: "seeded", grantedScopes: ["y", "z"] })
  }))

  it.effect("rejects token requests for an account that is not signed in", () => Effect.gen(function*() {
    const fixture = makeIdentity()
    const identity = make(fixture.api)
    fixture.controls.signIn({ email: "user@example.com", id: "user" })
    fixture.controls.cacheToken("token")
    expect((yield* Effect.flip(identity.getAuthToken({ account: { id: "other" } }))).cause).toEqual(new Error("The user is not signed in."))
    expect(yield* identity.getAuthToken({ account: { id: "user" } })).toEqual({ token: "token", grantedScopes: [] })
  }))

  it.effect("returns the primary account only when it syncs unless accountStatus is ANY", () => Effect.gen(function*() {
    const fixture = makeIdentity()
    const identity = make(fixture.api)
    expect(yield* identity.getProfileUserInfo({ accountStatus: "ANY" })).toEqual({ email: "", id: "" })
    expect(yield* identity.getAccounts).toEqual([])
    fixture.controls.signIn({ email: "user@example.com", id: "user" }, { syncing: false })
    expect(yield* identity.getProfileUserInfo()).toEqual({ email: "", id: "" })
    expect(yield* identity.getProfileUserInfo({ accountStatus: "SYNC" })).toEqual({ email: "", id: "" })
    expect(yield* identity.getProfileUserInfo({ accountStatus: "ANY" })).toEqual({ email: "user@example.com", id: "user" })
    expect(yield* identity.getAccounts).toEqual([{ id: "user" }])
    fixture.controls.signIn({ email: "user@example.com", id: "user" })
    expect(yield* identity.getProfileUserInfo()).toEqual({ email: "user@example.com", id: "user" })
    const info = yield* identity.getProfileUserInfo()
    info.email = "tampered"
    expect(yield* identity.getProfileUserInfo()).toEqual({ email: "user@example.com", id: "user" })
  }))

  it.effect("emits sign-in changes only when the signed-in account changes", () => Effect.gen(function*() {
    const fixture = makeIdentity()
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(make(fixture.api).onSignInChanged, 4)))
    yield* Effect.promise(() => fixture.controls.onSignInChanged.waitForListener())
    fixture.controls.signOut()
    fixture.controls.signIn({ email: "a@example.com", id: "a" })
    fixture.controls.signIn({ email: "a2@example.com", id: "a" }, { syncing: false })
    fixture.controls.cacheToken("token-a")
    fixture.controls.signIn({ email: "b@example.com", id: "b" })
    expect(fixture.controls.cachedTokens()).toEqual([])
    fixture.controls.signOut()
    fixture.controls.signOut()
    expect(yield* Fiber.join(fiber)).toEqual([
      { account: { id: "a" }, signedIn: true },
      { account: { id: "a" }, signedIn: false },
      { account: { id: "b" }, signedIn: true },
      { account: { id: "b" }, signedIn: false }
    ])
    expect(fixture.controls.onSignInChanged.listenerCount).toBe(0)
  }))

  it.effect("fails each call once per queued cause, in order, then recovers", () => Effect.gen(function*() {
    const fixture = makeIdentity()
    const identity = make(fixture.api)
    fixture.controls.signIn({ email: "user@example.com", id: "user" })
    fixture.controls.cacheToken("token")
    fixture.controls.resolveNextFlow("https://test-extension-id.chromiumapp.org/")

    for (const { member, run } of calls) {
      const first = new Error(`${member} first`)
      const second = new Error(`${member} second`)
      fixture.controls.failNext(member, first)
      fixture.controls.failNext(member, second)
      expect(yield* Effect.flip(run(identity))).toMatchObject({ operation: member, cause: first })
      expect(yield* Effect.flip(run(identity))).toMatchObject({ operation: member, cause: second })
      expect(Exit.isSuccess(yield* Effect.exit(run(identity)))).toBe(true)
    }

    // A failed flow consumed no scripted outcome: the one scripted above served the success.
    expect(fixture.controls.flows).toHaveLength(1)
  }))

  it.effect("applies overrides over the simulated members and provides its layer", () => Effect.gen(function*() {
    const fixture = makeIdentity({ overrides: { getAccounts: async () => [{ id: "override" }] } })
    const identity = yield* ChromeIdentity.pipe(Effect.provide(fixture.layer))
    expect(yield* identity.getAccounts).toEqual([{ id: "override" }])
    expect(fixture.controls.cachedTokens()).toEqual([])
  }))
})
