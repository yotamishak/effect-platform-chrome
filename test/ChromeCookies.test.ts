// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Deferred, Effect, Exit, Fiber, Option, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeCookies, ChromeCookiesError, detailsOf, layer, layerLive, make } from "../src/ChromeCookies.js"
import type { ChromeCookiesApi, ChromeCookiesService, Cookie, CookieChange, CookieDetails } from "../src/ChromeCookies.js"
import { makeEvent } from "../src/testing/Event.js"
import { makeCookies } from "../src/testing/Cookies.js"

const cookie: Cookie = {
  name: "session", value: "cookie-value", domain: ".app.example", hostOnly: false, path: "/app",
  secure: true, httpOnly: true, sameSite: "lax", session: true, storeId: "0"
}

const mockApi = () => {
  const changed = makeEvent<[chrome.cookies.CookieChangeInfo]>()

  const api = {
    get: vi.fn(async (_details: CookieDetails): Promise<Cookie | null | undefined> => cookie),
    getAll: vi.fn(async (_details: chrome.cookies.GetAllDetails): Promise<Array<Cookie>> => [cookie]),
    set: vi.fn(async (_details: chrome.cookies.SetDetails): Promise<Cookie | null | undefined> => cookie),
    remove: vi.fn(async (details: CookieDetails): Promise<CookieDetails | null | undefined> => details),
    getAllCookieStores: vi.fn(async (): Promise<Array<chrome.cookies.CookieStore>> => [{ id: "0", tabIds: [1] }]),
    getPartitionKey: vi.fn(async (_details: chrome.cookies.FrameDetails) => ({ partitionKey: { topLevelSite: "https://top.example" } })),
    onChanged: changed.api
  } satisfies ChromeCookiesApi

  return { api, changed: changed.controls }
}

type Mocked = ReturnType<typeof mockApi>["api"]

/** Every service call, the Chrome member it reaches, and how to make that member fail. */
const calls: ReadonlyArray<{
  readonly name: string
  readonly operation: string
  readonly fail: (api: Mocked, failure: () => Promise<never>) => void
  readonly run: (service: ChromeCookiesService) => Effect.Effect<void, ChromeCookiesError>
}> = [
  { name: "get", operation: "get", fail: (api, failure) => api.get.mockImplementationOnce(failure), run: (service) => Effect.asVoid(service.get({ url: "https://app.example/", name: "a" })) },
  { name: "getAll", operation: "getAll", fail: (api, failure) => api.getAll.mockImplementationOnce(failure), run: (service) => Effect.asVoid(service.getAll({})) },
  { name: "set", operation: "set", fail: (api, failure) => api.set.mockImplementationOnce(failure), run: (service) => Effect.asVoid(service.set({ url: "https://app.example/" })) },
  { name: "remove", operation: "remove", fail: (api, failure) => api.remove.mockImplementationOnce(failure), run: (service) => Effect.asVoid(service.remove({ url: "https://app.example/", name: "a" })) },
  { name: "removeCookie", operation: "remove", fail: (api, failure) => api.remove.mockImplementationOnce(failure), run: (service) => Effect.asVoid(service.removeCookie(cookie)) },
  {
    name: "getAllCookieStores", operation: "getAllCookieStores",
    fail: (api, failure) => api.getAllCookieStores.mockImplementationOnce(failure), run: (service) => Effect.asVoid(service.getAllCookieStores)
  },
  {
    name: "getPartitionKey", operation: "getPartitionKey",
    fail: (api, failure) => api.getPartitionKey.mockImplementationOnce(failure), run: (service) => Effect.asVoid(service.getPartitionKey({ tabId: 1 }))
  }
]

describe("ChromeCookies", () => {
  it.effect("reads, sets and removes cookies, passing details through unchanged", () => Effect.gen(function*() {
    const { api } = mockApi()
    const cookies = make(api)
    const lookup: CookieDetails = { url: "https://app.example/app", name: "session" }
    expect(yield* cookies.get(lookup)).toEqual(Option.some(cookie))
    expect(yield* cookies.getAll({ domain: "app.example" })).toEqual([cookie])
    expect(yield* cookies.set({ url: "https://app.example/", name: "session", value: "v" })).toEqual(Option.some(cookie))
    expect(yield* cookies.remove(lookup)).toEqual(Option.some(lookup))
    expect(yield* cookies.getAllCookieStores).toEqual([{ id: "0", tabIds: [1] }])
    expect(yield* cookies.getPartitionKey({ tabId: 4, frameId: 2 })).toEqual({ topLevelSite: "https://top.example" })
    expect(api.get.mock.calls).toEqual([[lookup]])
    expect(api.getAll.mock.calls).toEqual([[{ domain: "app.example" }]])
    expect(api.set.mock.calls).toEqual([[{ url: "https://app.example/", name: "session", value: "v" }]])
    expect(api.remove.mock.calls).toEqual([[lookup]])
    expect(api.getAllCookieStores.mock.calls).toEqual([[]])
    expect(api.getPartitionKey.mock.calls).toEqual([[{ tabId: 4, frameId: 2 }]])
  }))

  it.effect("returns a missing cookie, an unstored cookie or unreported removal as none, null or undefined alike", () => Effect.gen(function*() {
    const { api } = mockApi()
    const cookies = make(api)
    api.get.mockResolvedValueOnce(null).mockResolvedValueOnce(undefined)
    api.set.mockResolvedValueOnce(null).mockResolvedValueOnce(undefined)
    api.remove.mockResolvedValueOnce(null).mockResolvedValueOnce(undefined)
    const lookup: CookieDetails = { url: "https://app.example/", name: "gone" }
    expect(yield* cookies.get(lookup)).toEqual(Option.none())
    expect(yield* cookies.get(lookup)).toEqual(Option.none())
    expect(yield* cookies.set({ url: "https://app.example/", expirationDate: 1 })).toEqual(Option.none())
    expect(yield* cookies.set({ url: "https://app.example/", expirationDate: 1 })).toEqual(Option.none())
    expect(yield* cookies.remove(lookup)).toEqual(Option.none())
    expect(yield* cookies.removeCookie(cookie)).toEqual(Option.none())
    api.getAll.mockResolvedValueOnce([])
    expect(yield* cookies.getAll({ name: "none" })).toEqual([])
  }))

  it.effect("removes a cookie read from getAll with the URL, store and partition Chrome needs", () => Effect.gen(function*() {
    const { api } = mockApi()
    const partitioned: Cookie = { ...cookie, secure: false, storeId: "1", partitionKey: { topLevelSite: "https://top.example", hasCrossSiteAncestor: true } }
    const hostOnly: Cookie = { ...cookie, domain: "host.example", hostOnly: true, path: "/" }
    expect(yield* make(api).removeCookie(cookie)).toEqual(Option.some({ url: "https://app.example/app", name: "session", storeId: "0" }))
    yield* make(api).removeCookie(partitioned)
    yield* make(api).removeCookie(hostOnly)
    expect(api.remove.mock.calls).toEqual([
      [{ url: "https://app.example/app", name: "session", storeId: "0" }],
      [{ url: "http://app.example/app", name: "session", storeId: "1", partitionKey: { topLevelSite: "https://top.example", hasCrossSiteAncestor: true } }],
      [{ url: "https://host.example/", name: "session", storeId: "0" }]
    ])
    expect("partitionKey" in detailsOf(cookie)).toBe(false)
  }))

  it.effect.each(calls)("maps a rejection and a synchronous throw of $name to the typed error", ({ operation, fail, run }) => Effect.gen(function*() {
    const { api } = mockApi()
    const service = make(api)
    const rejection = new Error(`${operation} rejected`)
    const thrown = new Error(`${operation} threw`)
    fail(api, () => { throw thrown })
    const thrownError = yield* Effect.flip(run(service))
    expect(thrownError).toBeInstanceOf(ChromeCookiesError)
    expect(thrownError).toMatchObject({ operation, cause: thrown })
    fail(api, () => Promise.reject(rejection))
    const rejectedError = yield* Effect.flip(run(service))
    expect(rejectedError).toBeInstanceOf(ChromeCookiesError)
    expect(rejectedError).toMatchObject({ operation, cause: rejection })
  }))

  it.effect("fails getPartitionKey with the typed error when the browser lacks it (before Chrome 132)", () => Effect.gen(function*() {
    const { api } = mockApi()
    const { getPartitionKey: _omitted, ...older } = api
    const error = yield* Effect.flip(make(older).getPartitionKey({ tabId: 1 }))
    expect(error).toBeInstanceOf(ChromeCookiesError)
    expect(error.operation).toBe("getPartitionKey")
    expect(error.cause).toEqual(new Error("cookies.getPartitionKey is unavailable"))
    expect(api.getPartitionKey).not.toHaveBeenCalled()
  }))

  it.effect("provides an injected API and reads the global only when the live layer builds", () => Effect.gen(function*() {
    const { api } = mockApi()
    expect(yield* Effect.flatMap(ChromeCookies, (cookies) => cookies.getAll({})).pipe(Effect.provide(layer(api)))).toEqual([cookie])
    yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllGlobals()))
    const missing = yield* Effect.flip(ChromeCookies.pipe(Effect.provide(layerLive)))
    expect(missing).toBeInstanceOf(ChromeCookiesError)
    expect(missing.operation).toBe("initialize")
    vi.stubGlobal("chrome", {})
    const absent = yield* Effect.flip(ChromeCookies.pipe(Effect.provide(layerLive)))
    expect(absent).toMatchObject({ operation: "initialize", cause: new Error("chrome.cookies is unavailable in this context") })
    vi.stubGlobal("chrome", { cookies: api })
    expect(yield* Effect.flatMap(ChromeCookies, (cookies) => cookies.getAll({})).pipe(Effect.provide(layerLive))).toEqual([cookie])
  }))
})

describe("ChromeCookies.onChanged", () => {
  it.effect("streams cookie changes as named fields and removes the listener when the stream ends", () => Effect.gen(function*() {
    const { api, changed } = mockApi()
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

  it.effect("removes the listener when the consumer is interrupted", () => Effect.gen(function*() {
    const { api, changed } = mockApi()
    const fiber = yield* Effect.forkChild(Stream.runDrain(make(api).onChanged))
    yield* Effect.promise(() => changed.waitForListener())
    expect(changed.listenerCount).toBe(1)
    yield* Fiber.interrupt(fiber)
    expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
    expect(changed.listenerCount).toBe(0)
    expect(changed.emit({ cookie, cause: "explicit", removed: false })).toEqual([])
  }))

  it.effect("owns one listener per consumption", () => Effect.gen(function*() {
    const { api, changed } = mockApi()
    const registered = yield* Deferred.make<void>()
    let added = 0

    const counted: ChromeCookiesApi["onChanged"] = {
      addListener: (listener) => {
        api.onChanged.addListener(listener)
        added++

        if (added === 2) Deferred.doneUnsafe(registered, Effect.void)
      },
      removeListener: (listener) => api.onChanged.removeListener(listener)
    }

    const stream = make({ ...api, onChanged: counted }).onChanged
    const first = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 1)))
    const second = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 1)))
    yield* Deferred.await(registered)
    expect(changed.listenerCount).toBe(2)
    changed.emit({ cookie, cause: "evicted", removed: true })
    expect(yield* Fiber.join(first)).toEqual([{ cookie, cause: "evicted", removed: true }])
    expect(yield* Fiber.join(second)).toEqual([{ cookie, cause: "evicted", removed: true }])
    expect(changed.listenerCount).toBe(0)
  }))

  it.effect("types a failed onChanged registration and leaves no listener", () => Effect.gen(function*() {
    const { api, changed } = mockApi()
    const cause = new Error("no cookies permission")
    changed.failNext("addListener", cause)
    const error = yield* Effect.flip(Stream.runDrain(make(api).onChanged))
    expect(error).toBeInstanceOf(ChromeCookiesError)
    expect(error).toMatchObject({ operation: "onChanged", cause })
    expect(changed.listenerCount).toBe(0)
  }))

  it.effect("types a missing onChanged event", () => Effect.gen(function*() {
    const { api } = mockApi()
    const cause = new Error("cookies.onChanged is unavailable")

    const unavailable: ChromeCookiesApi = {
      get: api.get, getAll: api.getAll, set: api.set, remove: api.remove, getAllCookieStores: api.getAllCookieStores,
      get onChanged(): ChromeCookiesApi["onChanged"] { throw cause }
    }

    expect(yield* Effect.flip(Stream.runDrain(make(unavailable).onChanged))).toMatchObject({ operation: "onChanged", cause })
  }))
})

describe("makeCookies", () => {
  it.effect("keys cookies by name, domain, path, store and partition", () => Effect.gen(function*() {
    const fixture = makeCookies()
    fixture.controls.setStores([{ id: "0", tabIds: [] }, { id: "1", tabIds: [7] }])
    const cookies = make(fixture.api)
    yield* cookies.set({ url: "https://app.example/a/page", name: "id", value: "host" })
    yield* cookies.set({ url: "https://app.example/", name: "id", value: "domain", domain: "app.example", path: "/" })
    yield* cookies.set({ url: "https://app.example/", name: "id", value: "incognito", storeId: "1" })
    yield* cookies.set({ url: "https://app.example/", name: "id", value: "partitioned", secure: true, partitionKey: { topLevelSite: "https://top.example" } })
    expect(fixture.controls.cookies().map((stored) => [stored.domain, stored.path, stored.hostOnly, stored.storeId, stored.value])).toEqual([
      ["app.example", "/a", true, "0", "host"],
      [".app.example", "/", false, "0", "domain"],
      ["app.example", "/", true, "1", "incognito"],
      ["app.example", "/", true, "0", "partitioned"]
    ])
    const valueOf = (found: Option.Option<Cookie>) => Option.map(found, (each) => each.value)
    expect(valueOf(yield* cookies.get({ url: "https://app.example/a/b", name: "id" }))).toEqual(Option.some("host"))
    expect(valueOf(yield* cookies.get({ url: "https://sub.app.example/a", name: "id" }))).toEqual(Option.some("domain"))
    expect(valueOf(yield* cookies.get({ url: "https://app.example/", name: "id", storeId: "1" }))).toEqual(Option.some("incognito"))
    expect(valueOf(yield* cookies.get({ url: "https://app.example/", name: "id", partitionKey: { topLevelSite: "https://top.example" } })))
      .toEqual(Option.some("partitioned"))
    expect(yield* cookies.get({ url: "https://app.example/", name: "other" })).toEqual(Option.none())
    expect((yield* cookies.getAll({ domain: "app.example" })).map((found) => found.value)).toEqual(["host", "domain"])
    expect((yield* cookies.getAll({ partitionKey: {} })).map((found) => found.value)).toEqual(["host", "domain", "partitioned"])
    expect((yield* cookies.getAll({ partitionKey: { topLevelSite: "https://top.example" } })).map((found) => found.value)).toEqual(["partitioned"])
    expect((yield* cookies.getAll({ url: "https://app.example/other", path: "/" })).map((found) => found.value)).toEqual(["domain"])
    expect((yield* cookies.getAll({ storeId: "1" })).map((found) => found.value)).toEqual(["incognito"])
  }))

  it.effect("orders get and getAll longest path first, then earliest created", () => Effect.gen(function*() {
    const fixture = makeCookies()
    const cookies = make(fixture.api)
    fixture.controls.seed({ url: "https://app.example/", name: "id", value: "root-1", path: "/" })
    fixture.controls.seed({ url: "https://app.example/", name: "id", value: "deep", path: "/a/b" })
    fixture.controls.seed({ url: "https://app.example/", name: "id", value: "root-2", path: "/", domain: "app.example" })
    fixture.controls.seed({ url: "https://app.example/", name: "id", value: "mid", path: "/a" })
    expect((yield* cookies.getAll({})).map((found) => found.value)).toEqual(["deep", "mid", "root-1", "root-2"])
    expect(Option.map(yield* cookies.get({ url: "https://app.example/a/b/c", name: "id" }), (found) => found.value)).toEqual(Option.some("deep"))
    expect(Option.map(yield* cookies.get({ url: "https://app.example/z", name: "id" }), (found) => found.value)).toEqual(Option.some("root-1"))
  }))

  it.effect("rejects with Chrome's messages for invalid URLs, unknown stores and cookies it cannot set", () => Effect.gen(function*() {
    const fixture = makeCookies()
    const cookies = make(fixture.api)
    const failure = <A>(effect: Effect.Effect<A, ChromeCookiesError>) => Effect.map(Effect.flip(Effect.asVoid(effect)), (error) => [error.operation, error.cause])
    expect(yield* failure(cookies.get({ url: "not a url", name: "x" }))).toEqual(["get", new Error("Invalid url: \"not a url\".")])
    expect(yield* failure(cookies.getAll({ url: "::" }))).toEqual(["getAll", new Error("Invalid url: \"::\".")])
    expect(yield* failure(cookies.remove({ url: "", name: "x" }))).toEqual(["remove", new Error("Invalid url: \"\".")])
    expect(yield* failure(cookies.getAll({ storeId: "9" }))).toEqual(["getAll", new Error("Invalid cookie store id: \"9\".")])
    expect(yield* failure(cookies.set({ url: "https://app.example/", storeId: "1", name: "x" }))).toEqual(["set", new Error("Invalid cookie store id: \"1\".")])
    const refused = new Error("Failed to parse or set cookie named \"x\".")
    expect(yield* failure(cookies.set({ url: "https://app.example/", name: "x", domain: "other.example" }))).toEqual(["set", refused])
    expect(yield* failure(cookies.set({ url: "http://app.example/", name: "x", secure: true }))).toEqual(["set", refused])
    expect(yield* failure(cookies.set({ url: "https://app.example/", name: "x", partitionKey: { topLevelSite: "https://top.example" } }))).toEqual(["set", refused])
    expect(yield* failure(cookies.set({ url: "https://app.example/", domain: "x.example" })))
      .toEqual(["set", new Error("Failed to parse or set cookie named \"\".")])
    expect(fixture.controls.cookies()).toEqual([])
    expect(() => fixture.controls.seed({ url: "nope" })).toThrow("Invalid url: \"nope\".")
    expect(fixture.controls.seed({ url: "https://app.example/", domain: "other.example" })).toBeNull()
  }))

  it.effect("filters secure cookies by scheme and sessions by expiry", () => Effect.gen(function*() {
    const fixture = makeCookies()
    const cookies = make(fixture.api)
    yield* cookies.set({ url: "https://app.example/", name: "x", secure: true, expirationDate: 4_000_000_000 })
    yield* cookies.set({ url: "http://app.example/", name: "y" })
    expect(yield* cookies.get({ url: "http://app.example/", name: "x" })).toEqual(Option.none())
    expect((yield* cookies.getAll({ url: "http://app.example/" })).map((found) => found.name)).toEqual(["y"])
    expect((yield* cookies.getAll({ session: false, secure: true })).map((found) => found.name)).toEqual(["x"])
    expect((yield* cookies.getAll({ session: true })).map((found) => found.name)).toEqual(["y"])
  }))

  it.effect("emits overwrite, explicit, expired_overwrite, expiry and eviction changes", () => Effect.gen(function*() {
    const fixture = makeCookies()
    const cookies = make(fixture.api)
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(cookies.onChanged, 7)))
    yield* Effect.promise(() => fixture.controls.onChanged.waitForListener())
    yield* cookies.set({ url: "https://app.example/", name: "id", value: "1" })
    yield* cookies.set({ url: "https://app.example/", name: "id", value: "2" })
    const [stored] = yield* cookies.getAll({})
    expect(yield* cookies.removeCookie(stored ?? cookie)).toEqual(Option.some({ url: "http://app.example/", name: "id", storeId: "0" }))
    expect(yield* cookies.remove({ url: "https://app.example/x?q#h", name: "missing" }))
      .toEqual(Option.some({ url: "https://app.example/x?q#h", name: "missing", storeId: "0" }))
    yield* cookies.set({ url: "https://app.example/", name: "old", value: "kept" })
    expect(yield* cookies.set({ url: "https://app.example/", name: "old", expirationDate: 1 })).toEqual(Option.none())
    expect(yield* cookies.set({ url: "https://app.example/", name: "never", expirationDate: 1 })).toEqual(Option.none())
    const seeded = fixture.controls.seed({ url: "https://app.example/", name: "late" })
    expect(fixture.controls.drop(seeded ?? cookie, "expired")).toBe(true)
    expect(fixture.controls.drop(seeded ?? cookie, "evicted")).toBe(false)
    const changes: ReadonlyArray<CookieChange> = yield* Fiber.join(fiber)
    expect(changes.map(({ cookie: changed, cause, removed }) => [changed.name, changed.value, cause, removed])).toEqual([
      ["id", "1", "explicit", false],
      ["id", "1", "overwrite", true],
      ["id", "2", "explicit", false],
      ["id", "2", "explicit", true],
      ["old", "kept", "explicit", false],
      ["old", "kept", "expired_overwrite", true],
      ["late", "", "expired", true]
    ])
    expect(fixture.controls.cookies()).toEqual([])
    expect(fixture.controls.onChanged.listenerCount).toBe(0)
  }))

  it.effect("removes every same-named cookie the URL receives, within the given partition only", () => Effect.gen(function*() {
    const fixture = makeCookies()
    const cookies = make(fixture.api)
    fixture.controls.seed({ url: "https://app.example/", name: "id", value: "root", path: "/" })
    fixture.controls.seed({ url: "https://app.example/", name: "id", value: "deep", path: "/a" })
    fixture.controls.seed({ url: "https://app.example/", name: "id", value: "parent", domain: "app.example" })
    fixture.controls.seed({ url: "https://app.example/", name: "id", value: "elsewhere", path: "/b" })
    fixture.controls.seed({ url: "https://app.example/", name: "other", value: "other" })
    fixture.controls.seed({ url: "https://app.example/", name: "id", value: "partitioned", secure: true, partitionKey: { topLevelSite: "https://top.example" } })
    yield* cookies.remove({ url: "https://app.example/a/page", name: "id" })
    expect(fixture.controls.cookies().map((each) => each.value)).toEqual(["elsewhere", "other", "partitioned"])
    expect(yield* cookies.remove({ url: "https://app.example/", name: "id", partitionKey: { topLevelSite: "https://top.example" } }))
      .toEqual(Option.some({ url: "https://app.example/", name: "id", storeId: "0", partitionKey: { topLevelSite: "https://top.example" } }))
    expect(fixture.controls.cookies().map((each) => each.value)).toEqual(["elsewhere", "other"])
  }))

  it.effect("resolves partition keys of added frames and rejects unknown frames", () => Effect.gen(function*() {
    const fixture = makeCookies()
    const cookies = make(fixture.api)
    fixture.controls.addFrame({ tabId: 1, frameId: 0, documentId: "doc-main" }, { topLevelSite: "https://top.example", hasCrossSiteAncestor: false })
    fixture.controls.addFrame({ tabId: 1, frameId: 3, documentId: "doc-child" }, { topLevelSite: "https://top.example", hasCrossSiteAncestor: true })
    expect(yield* cookies.getPartitionKey({ tabId: 1 })).toEqual({ topLevelSite: "https://top.example", hasCrossSiteAncestor: false })
    expect(yield* cookies.getPartitionKey({ tabId: 1, frameId: 3 })).toEqual({ topLevelSite: "https://top.example", hasCrossSiteAncestor: true })
    expect(yield* cookies.getPartitionKey({ documentId: "doc-child" })).toEqual({ topLevelSite: "https://top.example", hasCrossSiteAncestor: true })
    expect((yield* Effect.flip(cookies.getPartitionKey({ tabId: 2 }))).operation).toBe("getPartitionKey")
    expect((yield* Effect.flip(cookies.getPartitionKey({ documentId: "doc-child", tabId: 2 }))).cause).toBeInstanceOf(Error)
    expect(yield* Effect.flip(cookies.getPartitionKey({}))).toMatchObject({ cause: new Error("Either tabId or documentId must be given.") })
  }))

  it.effect("reports configured stores and fails each operation once with an injected cause", () => Effect.gen(function*() {
    const fixture = makeCookies()
    const cookies = make(fixture.api)
    expect(yield* cookies.getAllCookieStores).toEqual([{ id: "0", tabIds: [] }])
    fixture.controls.setStores([{ id: "0", tabIds: [1] }, { id: "1", tabIds: [2] }])
    expect(yield* Effect.flatMap(ChromeCookies, (service) => service.getAllCookieStores).pipe(Effect.provide(fixture.layer)))
      .toEqual([{ id: "0", tabIds: [1] }, { id: "1", tabIds: [2] }])
    fixture.controls.addFrame({ tabId: 1, frameId: 0 }, { topLevelSite: "https://top.example" })

    const runs: ReadonlyArray<readonly [Parameters<typeof fixture.controls.failNext>[0], Effect.Effect<void, ChromeCookiesError>]> = [
      ["get", Effect.asVoid(cookies.get({ url: "https://app.example/", name: "x" }))],
      ["getAll", Effect.asVoid(cookies.getAll({}))],
      ["set", Effect.asVoid(cookies.set({ url: "https://app.example/", name: "x" }))],
      ["remove", Effect.asVoid(cookies.remove({ url: "https://app.example/", name: "x" }))],
      ["getAllCookieStores", Effect.asVoid(cookies.getAllCookieStores)],
      ["getPartitionKey", Effect.asVoid(cookies.getPartitionKey({ tabId: 1 }))]
    ]

    for (const [operation, run] of runs) {
      const cause = new Error(`No host permissions for cookies at url (${operation})`)
      fixture.controls.failNext(operation, cause)
      expect(yield* Effect.flip(run)).toMatchObject({ operation, cause })
      expect(Exit.isSuccess(yield* Effect.exit(run))).toBe(true)
    }
  }))

  it.effect("accepts overrides for any member", () => Effect.gen(function*() {
    const cause = new Error("replaced")
    const fixture = makeCookies({ getAllCookieStores: () => Promise.reject(cause) })
    expect(yield* Effect.flip(make(fixture.api).getAllCookieStores)).toMatchObject({ operation: "getAllCookieStores", cause })
  }))
})
