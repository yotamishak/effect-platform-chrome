// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Option, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeCookies, ChromeCookiesError, detailsOf, layer, layerLive, make } from "../src/ChromeCookies.js"
import type { ChromeCookiesApi, Cookie, CookieChange } from "../src/ChromeCookies.js"
import { makeEvent } from "../src/testing/Event.js"
import { makeCookies } from "../src/testing/Cookies.js"

const cookie: Cookie = {
  name: "session", value: "cookie-value", domain: ".app.example", hostOnly: false, path: "/app",
  secure: true, httpOnly: true, sameSite: "lax", session: true, storeId: "0"
}

const mockApi = () => ({
  getAll: vi.fn(async (_details: chrome.cookies.GetAllDetails) => [cookie]),
  get: vi.fn(async (_details: chrome.cookies.CookieDetails): Promise<Cookie | null> => cookie),
  set: vi.fn(async (_details: chrome.cookies.SetDetails): Promise<Cookie | null> => cookie),
  remove: vi.fn(async (details: chrome.cookies.CookieDetails): Promise<chrome.cookies.CookieDetails | null> => details),
  getAllCookieStores: vi.fn(async (): Promise<Array<chrome.cookies.CookieStore>> => [{ id: "0", tabIds: [1] }]),
  onChanged: makeEvent<[chrome.cookies.CookieChangeInfo]>().api
}) satisfies ChromeCookiesApi

const withChanges = () => {
  const changed = makeEvent<[chrome.cookies.CookieChangeInfo]>()

  return { api: { ...mockApi(), onChanged: changed.api }, changed: changed.controls }
}

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

  it.effect("lists cookie stores and types their failure", () => Effect.gen(function*() {
    const api = mockApi()
    const cookies = make(api)
    expect(yield* cookies.getAllCookieStores).toEqual([{ id: "0", tabIds: [1] }])
    const cause = new Error("stores unavailable")
    api.getAllCookieStores.mockRejectedValueOnce(cause)
    expect(yield* Effect.flip(cookies.getAllCookieStores)).toMatchObject({ operation: "getAllCookieStores", cause })
    expect(api.getAllCookieStores).toHaveBeenCalledTimes(2)
  }))

  it.effect("streams cookie changes and removes the listener when the stream ends", () => Effect.gen(function*() {
    const { api, changed } = withChanges()
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(make(api).onChanged, 2)))
    yield* Effect.promise(() => changed.waitForListener())
    changed.emit({ cookie, cause: "overwrite", removed: true })
    changed.emit({ cookie, cause: "explicit", removed: false })
    expect(yield* Fiber.join(fiber)).toEqual([
      { cookie, cause: "overwrite", removed: true },
      { cookie, cause: "explicit", removed: false }
    ])
    expect(changed.listenerCount).toBe(0)
  }))

  it.effect("types a failed onChanged registration and leaves no listener", () => Effect.gen(function*() {
    const { api, changed } = withChanges()
    const cause = new Error("no cookies permission")
    changed.failNext("addListener", cause)
    const error = yield* Effect.flip(Stream.runDrain(make(api).onChanged))
    expect(error).toBeInstanceOf(ChromeCookiesError)
    expect(error).toMatchObject({ operation: "onChanged", cause })
    expect(changed.listenerCount).toBe(0)
  }))
})

describe("makeCookies", () => {
  it.effect("keys cookies by name, domain, path, store and partition", () => Effect.gen(function*() {
    const fixture = makeCookies()
    const cookies = make(fixture.api)
    yield* cookies.set({ url: "https://app.example/a/page", name: "id", value: "host" })
    yield* cookies.set({ url: "https://app.example/", name: "id", value: "domain", domain: "app.example", path: "/" })
    yield* cookies.set({ url: "https://app.example/", name: "id", value: "incognito", storeId: "1" })
    yield* cookies.set({ url: "https://app.example/", name: "id", value: "partitioned", partitionKey: { topLevelSite: "https://top.example" } })
    expect(fixture.controls.cookies().map((stored) => [stored.domain, stored.path, stored.hostOnly, stored.storeId, stored.value])).toEqual([
      ["app.example", "/a", true, "0", "host"],
      [".app.example", "/", false, "0", "domain"],
      ["app.example", "/", true, "1", "incognito"],
      ["app.example", "/", true, "0", "partitioned"]
    ])
    expect(Option.map(yield* cookies.get({ url: "https://app.example/a/b", name: "id" }), (found) => found.value)).toEqual(Option.some("host"))
    expect(Option.map(yield* cookies.get({ url: "https://sub.app.example/a", name: "id" }), (found) => found.value)).toEqual(Option.some("domain"))
    expect(Option.map(yield* cookies.get({ url: "https://app.example/", name: "id", storeId: "1" }), (found) => found.value)).toEqual(Option.some("incognito"))
    expect((yield* cookies.getAll({ domain: "app.example" })).map((found) => found.value)).toEqual(["host", "domain"])
    expect((yield* cookies.getAll({ partitionKey: {} })).map((found) => found.value)).toEqual(["host", "domain", "partitioned"])
    expect((yield* cookies.getAll({ partitionKey: { topLevelSite: "https://top.example" } })).map((found) => found.value)).toEqual(["partitioned"])
    expect((yield* cookies.getAll({ url: "https://app.example/other", path: "/" })).map((found) => found.value)).toEqual(["domain"])
  }))

  it.effect("refuses cookies the URL cannot set and filters secure cookies by scheme", () => Effect.gen(function*() {
    const fixture = makeCookies()
    const cookies = make(fixture.api)
    expect(Option.isNone(yield* cookies.set({ url: "https://app.example/", name: "x", domain: "other.example" }))).toBe(true)
    expect(Option.isNone(yield* cookies.set({ url: "http://app.example/", name: "x", secure: true }))).toBe(true)
    yield* cookies.set({ url: "https://app.example/", name: "x", secure: true, expirationDate: 2_000_000_000 })
    expect(Option.isNone(yield* cookies.get({ url: "http://app.example/", name: "x" }))).toBe(true)
    expect(yield* cookies.getAll({ session: false, secure: true })).toHaveLength(1)
    expect(fixture.controls.cookies()).toHaveLength(1)
  }))

  it.effect("emits overwrite, explicit removal, expiry and eviction changes", () => Effect.gen(function*() {
    const fixture = makeCookies()
    const cookies = make(fixture.api)
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(cookies.onChanged, 5)))
    yield* Effect.promise(() => fixture.controls.onChanged.waitForListener())
    yield* cookies.set({ url: "https://app.example/", name: "id", value: "1" })
    yield* cookies.set({ url: "https://app.example/", name: "id", value: "2" })
    const [stored] = yield* cookies.getAll({})
    yield* cookies.removeCookie(stored ?? cookie)
    yield* cookies.remove({ url: "https://app.example/", name: "missing" })
    const seeded = fixture.controls.seed({ url: "https://app.example/", name: "late" })
    expect(fixture.controls.drop(seeded ?? cookie, "expired")).toBe(true)
    expect(fixture.controls.drop(seeded ?? cookie, "evicted")).toBe(false)
    const changes: ReadonlyArray<CookieChange> = yield* Fiber.join(fiber)
    expect(changes.map(({ cookie: changed, cause, removed }) => [changed.name, changed.value, cause, removed])).toEqual([
      ["id", "1", "explicit", false],
      ["id", "1", "overwrite", true],
      ["id", "2", "explicit", false],
      ["id", "2", "explicit", true],
      ["late", "", "expired", true]
    ])
    expect(fixture.controls.cookies()).toEqual([])
    expect(fixture.controls.onChanged.listenerCount).toBe(0)
  }))

  it.effect("reports configured stores and injected failures", () => Effect.gen(function*() {
    const fixture = makeCookies()
    const cookies = make(fixture.api)
    expect(yield* cookies.getAllCookieStores).toEqual([{ id: "0", tabIds: [] }])
    fixture.controls.setStores([{ id: "0", tabIds: [1] }, { id: "1", tabIds: [2] }])
    expect(yield* Effect.flatMap(ChromeCookies, (service) => service.getAllCookieStores).pipe(Effect.provide(fixture.layer)))
      .toEqual([{ id: "0", tabIds: [1] }, { id: "1", tabIds: [2] }])
    const cause = new Error("No host permissions for cookies at url")
    fixture.controls.failNext("set", cause)
    expect(yield* Effect.flip(cookies.set({ url: "https://app.example/", name: "x" }))).toMatchObject({ operation: "set", cause })
    expect(Option.isSome(yield* cookies.set({ url: "https://app.example/", name: "x" }))).toBe(true)
  }))
})
