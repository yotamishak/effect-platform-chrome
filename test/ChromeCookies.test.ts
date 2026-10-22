// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Option } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeCookies, ChromeCookiesError, detailsOf, layer, layerLive, make } from "../src/ChromeCookies.js"
import type { ChromeCookiesApi, Cookie } from "../src/ChromeCookies.js"

const cookie: Cookie = {
  name: "session", value: "cookie-value", domain: ".app.example", hostOnly: false, path: "/app",
  secure: true, httpOnly: true, sameSite: "lax", session: true, storeId: "0"
}

const mockApi = () => ({
  getAll: vi.fn(async (_details: chrome.cookies.GetAllDetails) => [cookie]),
  get: vi.fn(async (_details: chrome.cookies.CookieDetails): Promise<Cookie | null> => cookie),
  set: vi.fn(async (_details: chrome.cookies.SetDetails): Promise<Cookie | null> => cookie),
  remove: vi.fn(async (details: chrome.cookies.CookieDetails): Promise<chrome.cookies.CookieDetails | null> => details)
}) satisfies ChromeCookiesApi

describe("ChromeCookies", () => {
  it.effect("reads cookies, returning a missing or refused cookie as none", () => Effect.gen(function*() {
    const api = mockApi()
    const cookies = make(api)
    expect(yield* cookies.getAll({ domain: "app.example" })).toEqual([cookie])
    expect(yield* cookies.get({ url: "https://app.example/", name: "session" })).toEqual(Option.some(cookie))
    api.get.mockResolvedValueOnce(null)
    api.set.mockResolvedValueOnce(null)
    expect(Option.isNone(yield* cookies.get({ url: "https://app.example/", name: "gone" }))).toBe(true)
    expect(Option.isNone(yield* cookies.set({ url: "https://app.example/", name: "refused" }))).toBe(true)
  }))

  it.effect("removes a cookie read from getAll with the URL, store and partition Chrome needs", () => Effect.gen(function*() {
    const api = mockApi()
    const partitioned: Cookie = { ...cookie, secure: false, partitionKey: { topLevelSite: "https://top.example" } }
    yield* make(api).removeCookie(cookie)
    yield* make(api).removeCookie(partitioned)
    expect(api.remove.mock.calls).toEqual([
      [{ url: "https://app.example/app", name: "session", storeId: "0" }],
      [{ url: "http://app.example/app", name: "session", storeId: "0", partitionKey: { topLevelSite: "https://top.example" } }]
    ])
    expect(detailsOf(cookie)).toEqual({ url: "https://app.example/app", name: "session", storeId: "0" })
  }))

  it.effect("types rejected calls", () => Effect.gen(function*() {
    const api = mockApi()
    const cause = new Error("No host permissions for cookies at url")
    api.getAll.mockRejectedValueOnce(cause)
    const error = yield* Effect.flip(make(api).getAll({ domain: "other.example" }))
    expect(error).toBeInstanceOf(ChromeCookiesError)
    expect(error).toMatchObject({ operation: "getAll", cause })
  }))

  it.effect("provides an injected API and reads the global only when the live layer builds", () => Effect.gen(function*() {
    const api = mockApi()
    expect(yield* Effect.flatMap(ChromeCookies, (cookies) => cookies.getAll({})).pipe(Effect.provide(layer(api)))).toEqual([cookie])
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", {})), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeCookies.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
    vi.stubGlobal("chrome", { cookies: api })
    expect(yield* Effect.flatMap(ChromeCookies, (cookies) => cookies.getAll({})).pipe(Effect.provide(layerLive))).toEqual([cookie])
  }))
})
