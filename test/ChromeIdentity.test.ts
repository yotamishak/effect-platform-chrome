// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeIdentity, ChromeIdentityError, layer, layerLive, make } from "../src/ChromeIdentity.js"
import type { ChromeIdentityApi } from "../src/ChromeIdentity.js"
import { makeEvent } from "../src/testing/Event.js"
import { makeIdentity } from "../src/testing/Identity.js"

const redirect = "https://extension-id.chromiumapp.org/"

const mockApi = () => ({
  getRedirectURL: vi.fn((path?: string) => `${redirect}${path ?? ""}`),
  launchWebAuthFlow: vi.fn(async (details: chrome.identity.WebAuthFlowDetails): Promise<string | undefined> =>
    `${redirect}?code=code&from=${encodeURIComponent(details.url)}`)
}) satisfies ChromeIdentityApi

const tokenApi = () => {
  const signInChanged = makeEvent<[chrome.identity.AccountInfo, boolean]>()

  const api = {
    ...mockApi(),
    getAuthToken: vi.fn(async (_details?: chrome.identity.TokenDetails): Promise<chrome.identity.GetAuthTokenResult> =>
      ({ token: "token", grantedScopes: ["email"] })),
    removeCachedAuthToken: vi.fn(async (_details: chrome.identity.InvalidTokenDetails) => {}),
    clearAllCachedAuthTokens: vi.fn(async () => {}),
    getProfileUserInfo: vi.fn(async (_details?: chrome.identity.ProfileDetails): Promise<chrome.identity.ProfileUserInfo> =>
      ({ email: "user@example.com", id: "user" })),
    onSignInChanged: signInChanged.api
  } satisfies ChromeIdentityApi

  return { api, signInChanged: signInChanged.controls }
}

describe("ChromeIdentity", () => {
  it.effect("reads the redirect URL with and without a path", () => Effect.gen(function*() {
    const api = mockApi()
    const identity = make(api)
    expect(yield* identity.getRedirectURL()).toBe(redirect)
    expect(yield* identity.getRedirectURL("callback")).toBe(`${redirect}callback`)
    expect(api.getRedirectURL.mock.calls).toEqual([[], ["callback"]])
  }))

  it.effect("runs a web auth flow lazily and passes its details through", () => Effect.gen(function*() {
    const api = mockApi()
    const flow = make(api).launchWebAuthFlow({ url: "https://auth.example/authorize", interactive: true })
    expect(api.launchWebAuthFlow).not.toHaveBeenCalled()
    expect(yield* flow).toBe(`${redirect}?code=code&from=${encodeURIComponent("https://auth.example/authorize")}`)
    expect(api.launchWebAuthFlow).toHaveBeenCalledExactlyOnceWith({ url: "https://auth.example/authorize", interactive: true })
  }))

  it.effect("types a cancelled flow and a throwing redirect lookup", () => Effect.gen(function*() {
    const api = mockApi()
    const cancelled = new Error("The user did not approve access.")
    api.launchWebAuthFlow.mockRejectedValueOnce(cancelled)
    api.getRedirectURL.mockImplementationOnce(() => { throw cancelled })
    const identity = make(api)
    const error = yield* Effect.flip(identity.launchWebAuthFlow({ url: "https://auth.example/" }))
    expect(error).toBeInstanceOf(ChromeIdentityError)
    expect(error).toMatchObject({ operation: "launchWebAuthFlow", cause: cancelled })
    expect(yield* Effect.flip(identity.getRedirectURL())).toMatchObject({ operation: "getRedirectURL", cause: cancelled })
  }))

  it.effect("provides an injected API and reads the global only when the live layer builds", () => Effect.gen(function*() {
    const api = mockApi()
    expect(yield* Effect.flatMap(ChromeIdentity, (identity) => identity.getRedirectURL()).pipe(Effect.provide(layer(api)))).toBe(redirect)
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", { identity: api })), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flatMap(ChromeIdentity, (identity) => identity.getRedirectURL()).pipe(Effect.provide(layerLive))).toBe(redirect)
  }))

  it.effect("fails the live layer in a context without the API", () => Effect.gen(function*() {
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", {})), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeIdentity.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
  }))

  it.effect("calls the Google token APIs lazily, omitting absent details", () => Effect.gen(function*() {
    const { api } = tokenApi()
    const identity = make(api)
    const token = identity.getAuthToken({ interactive: false, scopes: ["email"] })
    expect(api.getAuthToken).not.toHaveBeenCalled()
    expect(yield* token).toEqual({ token: "token", grantedScopes: ["email"] })
    yield* identity.getAuthToken()
    yield* identity.removeCachedAuthToken({ token: "token" })
    yield* identity.clearAllCachedAuthTokens
    expect(yield* identity.getProfileUserInfo()).toEqual({ email: "user@example.com", id: "user" })
    yield* identity.getProfileUserInfo({ accountStatus: "ANY" })
    expect(api.getAuthToken.mock.calls).toEqual([[{ interactive: false, scopes: ["email"] }], []])
    expect(api.removeCachedAuthToken).toHaveBeenCalledExactlyOnceWith({ token: "token" })
    expect(api.clearAllCachedAuthTokens).toHaveBeenCalledExactlyOnceWith()
    expect(api.getProfileUserInfo.mock.calls).toEqual([[], [{ accountStatus: "ANY" }]])
  }))

  it.effect("types a non-interactive token failure", () => Effect.gen(function*() {
    const { api } = tokenApi()
    const cause = new Error("OAuth2 not granted or revoked.")
    api.getAuthToken.mockRejectedValueOnce(cause)
    const error = yield* Effect.flip(make(api).getAuthToken({ interactive: false }))
    expect(error).toBeInstanceOf(ChromeIdentityError)
    expect(error).toMatchObject({ operation: "getAuthToken", cause })
  }))

  it.effect("fails Google account members absent from an injected API with typed errors", () => Effect.gen(function*() {
    const identity = make(mockApi())
    expect(yield* Effect.flip(identity.getAuthToken())).toMatchObject({ operation: "getAuthToken" })
    expect(yield* Effect.flip(identity.removeCachedAuthToken({ token: "token" }))).toMatchObject({ operation: "removeCachedAuthToken" })
    expect(yield* Effect.flip(identity.clearAllCachedAuthTokens)).toMatchObject({ operation: "clearAllCachedAuthTokens" })
    expect(yield* Effect.flip(identity.getProfileUserInfo())).toMatchObject({ operation: "getProfileUserInfo" })
    expect(yield* Effect.flip(Stream.runDrain(identity.onSignInChanged))).toMatchObject({ operation: "onSignInChanged" })
  }))

  it.effect("streams sign-in changes and removes the listener when the stream ends", () => Effect.gen(function*() {
    const { api, signInChanged } = tokenApi()
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(make(api).onSignInChanged, 2)))
    yield* Effect.promise(() => signInChanged.waitForListener())
    signInChanged.emit({ id: "user" }, true)
    signInChanged.emit({ id: "user" }, false)
    expect(yield* Fiber.join(fiber)).toEqual([
      { account: { id: "user" }, signedIn: true },
      { account: { id: "user" }, signedIn: false }
    ])
    expect(signInChanged.listenerCount).toBe(0)
  }))

  it.effect("types a failed onSignInChanged registration and leaves no listener", () => Effect.gen(function*() {
    const { api, signInChanged } = tokenApi()
    const cause = new Error("registration failed")
    signInChanged.failNext("addListener", cause)
    expect(yield* Effect.flip(Stream.runDrain(make(api).onSignInChanged))).toMatchObject({ operation: "onSignInChanged", cause })
    expect(signInChanged.listenerCount).toBe(0)
  }))
})

describe("makeIdentity", () => {
  it.effect("builds redirect URLs from the configured base", () => Effect.gen(function*() {
    const identity = make(makeIdentity({ redirectURL: "https://abc.chromiumapp.org/" }).api)
    expect(yield* identity.getRedirectURL()).toBe("https://abc.chromiumapp.org/")
    expect(yield* identity.getRedirectURL("/callback")).toBe("https://abc.chromiumapp.org/callback")
    expect(yield* make(makeIdentity().api).getRedirectURL("cb")).toBe("https://test-extension-id.chromiumapp.org/cb")
  }))

  it.effect("plays scripted web auth flow outcomes in order and rejects unscripted flows", () => Effect.gen(function*() {
    const fixture = makeIdentity()
    const identity = make(fixture.api)
    const denied = new Error("access_denied")
    fixture.controls.resolveNextFlow("https://test-extension-id.chromiumapp.org/?code=1")
    fixture.controls.resolveNextFlow((details) => `${details.url}#echo`)
    fixture.controls.rejectNextFlow(denied)
    expect(yield* identity.launchWebAuthFlow({ url: "https://auth.example/1", interactive: true })).toBe("https://test-extension-id.chromiumapp.org/?code=1")
    expect(yield* identity.launchWebAuthFlow({ url: "https://auth.example/2" })).toBe("https://auth.example/2#echo")
    expect(yield* Effect.flip(identity.launchWebAuthFlow({ url: "https://auth.example/3" }))).toMatchObject({ operation: "launchWebAuthFlow", cause: denied })
    expect((yield* Effect.flip(identity.launchWebAuthFlow({ url: "https://auth.example/4" }))).cause).toEqual(new Error("User interaction required."))
    expect((yield* Effect.flip(identity.launchWebAuthFlow({ url: "https://auth.example/5", interactive: true }))).cause)
      .toEqual(new Error("The user did not approve access."))
    expect(fixture.controls.flows.map((details) => details.url)).toEqual([1, 2, 3, 4, 5].map((index) => `https://auth.example/${index}`))
  }))

  it.effect("serves, grants and evicts cached tokens per scope set", () => Effect.gen(function*() {
    const fixture = makeIdentity()
    const identity = make(fixture.api)
    expect(yield* Effect.flip(identity.getAuthToken({ interactive: true }))).toMatchObject({ operation: "getAuthToken" })
    fixture.controls.signIn({ email: "user@example.com", id: "user" })
    expect(yield* identity.getProfileUserInfo()).toEqual({ email: "user@example.com", id: "user" })
    expect((yield* Effect.flip(identity.getAuthToken({ scopes: ["email"] }))).cause).toEqual(new Error("OAuth2 not granted or revoked."))
    fixture.controls.grantNext("granted")
    expect(yield* identity.getAuthToken({ interactive: true, scopes: ["email", "profile"] })).toEqual({ token: "granted", grantedScopes: ["email", "profile"] })
    expect(yield* identity.getAuthToken({ scopes: ["profile", "email"] })).toEqual({ token: "granted", grantedScopes: ["email", "profile"] })
    expect((yield* Effect.flip(identity.getAuthToken({ interactive: true }))).cause).toEqual(new Error("The user did not approve access."))
    fixture.controls.cacheToken("seeded")
    expect(yield* identity.getAuthToken()).toEqual({ token: "seeded", grantedScopes: [] })
    expect(fixture.controls.cachedTokens()).toEqual(["granted", "seeded"])
    yield* identity.removeCachedAuthToken({ token: "granted" })
    expect(fixture.controls.cachedTokens()).toEqual(["seeded"])
    yield* identity.clearAllCachedAuthTokens
    expect(fixture.controls.cachedTokens()).toEqual([])
  }))

  it.effect("emits sign-in changes, clears tokens on sign-out and fails calls on demand", () => Effect.gen(function*() {
    const fixture = makeIdentity()
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(make(fixture.api).onSignInChanged, 2)))
    yield* Effect.promise(() => fixture.controls.onSignInChanged.waitForListener())
    fixture.controls.signIn({ email: "user@example.com", id: "user" })
    fixture.controls.cacheToken("token")
    fixture.controls.signOut()
    expect(yield* Fiber.join(fiber)).toEqual([
      { account: { id: "user" }, signedIn: true },
      { account: { id: "user" }, signedIn: false }
    ])
    expect(fixture.controls.cachedTokens()).toEqual([])
    const cause = new Error("profile unavailable")
    fixture.controls.failNext("getProfileUserInfo", cause)
    const identity = yield* ChromeIdentity.pipe(Effect.provide(fixture.layer))
    expect(yield* Effect.flip(identity.getProfileUserInfo())).toMatchObject({ operation: "getProfileUserInfo", cause })
    expect(yield* identity.getProfileUserInfo()).toEqual({ email: "", id: "" })
  }))
})
