// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeIdentity, ChromeIdentityError, layer, layerLive, make } from "../src/ChromeIdentity.js"
import type { ChromeIdentityApi } from "../src/ChromeIdentity.js"

const redirect = "https://extension-id.chromiumapp.org/"

const mockApi = () => ({
  getRedirectURL: vi.fn((path?: string) => `${redirect}${path ?? ""}`),
  launchWebAuthFlow: vi.fn(async (details: chrome.identity.WebAuthFlowDetails): Promise<string | undefined> =>
    `${redirect}?code=code&from=${encodeURIComponent(details.url)}`)
}) satisfies ChromeIdentityApi

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
})
