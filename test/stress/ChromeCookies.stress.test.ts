// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Cause, Deferred, Effect, Exit, Fiber, Option, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChromeCookiesError, make } from "../../src/ChromeCookies.js"
import type { ChromeCookiesApi, Cookie, CookieChange, CookieDetails, CookieStore } from "../../src/ChromeCookies.js"
import { makeEvent } from "../../src/testing/Event.js"
import { makeCookies } from "../../src/testing/Cookies.js"

/** mulberry32: a small seeded generator, so every run draws the same interleavings. */
const seeded = (seed: number) => {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => from + index)

/** A promise and the function that resolves it, without ES2024 `Promise.withResolvers`. */
const gate = <A>() => {
  let open: (value: A) => void = () => undefined
  let fail: (cause: Error) => void = () => undefined

  const promise = new Promise<A>((resolve, reject) => {
    open = resolve
    fail = reject
  })

  return { promise, open: (value: A) => open(value), fail: (cause: Error) => fail(cause) }
}

const cookieNamed = (name: string, value = name): Cookie => ({
  name, value, domain: "app.example", hostOnly: true, path: "/", secure: false, httpOnly: false,
  sameSite: "unspecified", session: true, storeId: "0"
})

const change = (index: number): chrome.cookies.CookieChangeInfo => ({ cookie: cookieNamed("id", String(index)), cause: "explicit", removed: false })

type ChangeEvent = ChromeCookiesApi["onChanged"]

const quietApi = (onChanged: ChangeEvent): ChromeCookiesApi => ({
  get: async () => null,
  getAll: async () => [],
  set: async () => null,
  remove: async () => null,
  getAllCookieStores: async () => [],
  getPartitionKey: async () => ({ partitionKey: {} }),
  onChanged
})

/** An event that completes `reached` once `target` listeners have been added in total. */
const countedEvent = (target: number, reached: Deferred.Deferred<void>) => {
  const event = makeEvent<[chrome.cookies.CookieChangeInfo]>()
  let added = 0

  const source: ChangeEvent = {
    addListener: (listener) => {
      event.api.addListener(listener)
      added++

      if (added === target) Deferred.doneUnsafe(reached, Effect.void)
    },
    removeListener: (listener) => event.api.removeListener(listener)
  }

  return { source, controls: event.controls, added: () => added }
}

describe("ChromeCookies stress", () => {
  it.effect("keeps exactly the newest 64 of a 4,096-event burst, in order, and removes the listener", () => Effect.gen(function*() {
    const event = makeEvent<[chrome.cookies.CookieChangeInfo]>()
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(make(quietApi(event.api)).onChanged, 64)))
    yield* Effect.promise(() => event.controls.waitForListener())

    for (const index of range(0, 4096)) expect(event.controls.emit(change(index))).toEqual([])

    const received: ReadonlyArray<CookieChange> = yield* Fiber.join(fiber)
    expect(received.map((each) => Number(each.cookie.value))).toEqual(range(4032, 4096))
    expect(event.controls.listenerCount).toBe(0)
    expect(event.controls.emit(change(4096))).toEqual([])
  }))

  it.effect("buffers the newest 64 independently for each of 64 subscribers to one 4,096-event burst", () => Effect.gen(function*() {
    const registered = yield* Deferred.make<void>()
    const event = countedEvent(64, registered)
    const stream = make(quietApi(event.source)).onChanged
    const fibers = yield* Effect.forEach(range(0, 64), () => Effect.forkScoped(Stream.runCollect(Stream.take(stream, 64))))
    yield* Deferred.await(registered)

    for (const index of range(0, 4096)) event.controls.emit(change(index))

    for (const received of yield* Fiber.joinAll(fibers)) expect(received.map((each) => Number(each.cookie.value))).toEqual(range(4032, 4096))

    expect(event.controls.listenerCount).toBe(0)
  }))

  it.effect("delivers the newest 64 of the 4,097 changes a 2,049-overwrite fixture burst emits", () => Effect.gen(function*() {
    const fixture = makeCookies()
    const all: Array<string> = []
    fixture.api.onChanged.addListener(({ cookie, cause, removed }) => { all.push(`${cookie.value}:${cause}:${removed}`) })
    const registered = yield* Deferred.make<void>()

    const counted: ChangeEvent = {
      addListener: (listener) => {
        fixture.api.onChanged.addListener(listener)
        Deferred.doneUnsafe(registered, Effect.void)
      },
      removeListener: (listener) => fixture.api.onChanged.removeListener(listener)
    }

    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(make({ ...fixture.api, onChanged: counted }).onChanged, 64)))
    yield* Deferred.await(registered)
    yield* Effect.promise(() => Promise.all(range(0, 2049).map((index) => fixture.api.set({ url: "https://app.example/", name: "id", value: String(index) }))))
    const received: ReadonlyArray<CookieChange> = yield* Fiber.join(fiber)
    expect(all).toHaveLength(4097)
    expect(received.map(({ cookie, cause, removed }) => `${cookie.value}:${cause}:${removed}`)).toEqual(all.slice(-64))
    expect(fixture.controls.onChanged.listenerCount).toBe(1)
    expect(fixture.controls.cookies().map((cookie) => cookie.value)).toEqual(["2048"])
  }))

  it.effect("churns 512 subscriptions with interruption at every stage and ends with zero listeners", () => Effect.gen(function*() {
    const random = seeded(512)
    const kinds = ["beforeStart", "failedRegistration", "failedLookup", "waiting", "midDelivery", "completed", "consumerFailed"] as const
    const plan = range(0, 512).map((index) => index < kinds.length ? kinds[index] ?? "waiting" : kinds[Math.floor(random() * kinds.length)] ?? "waiting")
    const live = new Set<string>(["waiting", "midDelivery", "completed", "consumerFailed"])
    const onShared = plan.filter((kind) => live.has(kind)).length
    const registered = yield* Deferred.make<void>()
    const shared = countedEvent(onShared, registered)
    const early = makeEvent<[chrome.cookies.CookieChangeInfo]>()
    const registrationCause = new Error("no cookies permission")
    const lookupCause = new Error("cookies.onChanged is unavailable")
    const consumerCause = new Error("consumer failed")
    let failedRemovals = 0

    const failing = make(quietApi({
      addListener: () => { throw registrationCause },
      removeListener: () => { failedRemovals++ }
    })).onChanged

    const unavailable = make({
      ...quietApi(early.api),
      get onChanged(): ChangeEvent { throw lookupCause }
    }).onChanged

    const stream = make(quietApi(shared.source)).onChanged
    const beforeStart = make(quietApi(early.api)).onChanged
    const interruptible: Array<Fiber.Fiber<void, ChromeCookiesError>> = []
    const midDelivery: Array<Deferred.Deferred<void>> = []
    const completed: Array<Fiber.Fiber<ReadonlyArray<CookieChange>, ChromeCookiesError>> = []
    const consumerFailed: Array<Fiber.Fiber<void, ChromeCookiesError | Error>> = []
    const typed: Array<Fiber.Fiber<ChromeCookiesError, void>> = []
    const waiting: Array<Fiber.Fiber<void, ChromeCookiesError>> = []

    for (const kind of plan) {
      if (kind === "beforeStart") {
        const fiber = yield* Effect.forkChild(Stream.runDrain(beforeStart))
        yield* Fiber.interrupt(fiber)
        expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
      } else if (kind === "failedRegistration") {
        typed.push(yield* Effect.forkScoped(Effect.flip(Stream.runDrain(failing))))
      } else if (kind === "failedLookup") {
        typed.push(yield* Effect.forkScoped(Effect.flip(Stream.runDrain(unavailable))))
      } else if (kind === "waiting") {
        const fiber = yield* Effect.forkScoped(Stream.runDrain(stream))
        waiting.push(fiber)
        interruptible.push(fiber)
      } else if (kind === "midDelivery") {
        const reached = yield* Deferred.make<void>()
        const after = 1 + Math.floor(random() * 4)
        let seen = 0
        midDelivery.push(reached)

        interruptible.push(yield* Effect.forkScoped(Stream.runForEach(stream, () => Effect.sync(() => {
          seen++

          if (seen === after) Deferred.doneUnsafe(reached, Effect.void)
        }))))
      } else if (kind === "completed") {
        completed.push(yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 3))))
      } else {
        consumerFailed.push(yield* Effect.forkScoped(Stream.runDrain(Stream.mapEffect(stream, (each) =>
          each.cookie.value === "2" ? Effect.fail(consumerCause) : Effect.void))))
      }
    }

    yield* Deferred.await(registered)
    expect(shared.controls.listenerCount).toBe(onShared)
    // Interrupt half the idle subscribers before any event arrives, the rest after delivery.
    yield* Fiber.interruptAll(waiting.slice(0, Math.floor(waiting.length / 2)))

    for (const index of range(0, 5)) shared.controls.emit(change(index))

    for (const reached of midDelivery) yield* Deferred.await(reached)

    yield* Fiber.interruptAll(interruptible)

    for (const fiber of completed) expect((yield* Fiber.join(fiber)).map((each) => each.cookie.value)).toEqual(["0", "1", "2"])

    for (const fiber of consumerFailed) expect(yield* Fiber.await(fiber)).toEqual(Exit.fail(consumerCause))

    for (const fiber of typed) {
      const error = yield* Fiber.join(fiber)
      expect(error).toBeInstanceOf(ChromeCookiesError)
      expect(error.operation).toBe("onChanged")
      expect([registrationCause, lookupCause]).toContain(error.cause)
    }

    for (const fiber of interruptible) expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)

    expect(waiting.length + midDelivery.length + completed.length + consumerFailed.length).toBe(onShared)
    expect(shared.added()).toBe(onShared)
    expect(shared.controls.listenerCount).toBe(0)
    expect(early.controls.listenerCount).toBe(0)
    // A registration that throws is still removed, in case Chrome added it before throwing.
    expect(failedRemovals).toBe(plan.filter((kind) => kind === "failedRegistration").length)
    expect(new Set(plan).size).toBe(kinds.length)
  }))

  it.effect("types 1,536 concurrent calls with interleaved results, rejections and synchronous throws", () => Effect.gen(function*() {
    const random = seeded(1536)
    const total = 1536
    const operations = ["get", "getAll", "set", "remove", "removeCookie", "getAllCookieStores", "getPartitionKey"] as const
    const outcomes = ["resolve", "reject", "throw"] as const

    const plan = range(0, total).map((index) => ({
      operation: operations[index % operations.length] ?? "get",
      outcome: outcomes[Math.floor(random() * outcomes.length)] ?? "resolve"
    }))

    const started = yield* Deferred.make<void>()
    const release = gate<void>()
    let calls = 0
    let storeCalls = 0

    /** Settles call `index` as planned after every call has started; throws synchronously when planned. */
    const settle = <A>(index: number, value: A): Promise<A> => {
      calls++

      if (calls === total) Deferred.doneUnsafe(started, Effect.void)

      const outcome = plan[index]?.outcome
      const cause = new Error(`call ${index}`)

      if (outcome === "throw") throw cause

      return release.promise.then(() => outcome === "reject" ? Promise.reject(cause) : value)
    }

    const indexOf = (name: string | undefined) => Number((name ?? "").slice("call-".length))
    const storeIndexes = plan.flatMap((entry, index) => entry.operation === "getAllCookieStores" ? [index] : [])

    const api: ChromeCookiesApi = {
      get: (details) => settle(indexOf(details.name), cookieNamed(details.name)),
      getAll: (details) => settle(indexOf(details.name), [cookieNamed(details.name ?? "")]),
      set: (details) => settle(indexOf(details.name), cookieNamed(details.name ?? "")),
      remove: (details) => settle(indexOf(details.name), details),
      // Zero-argument calls start in plan order, since forEach starts its fibers in order.
      getAllCookieStores: () => {
        const index = storeIndexes[storeCalls] ?? -1
        storeCalls++

        return settle<Array<CookieStore>>(index, [{ id: `call-${index}`, tabIds: [] }])
      },
      getPartitionKey: (details) => settle(details.tabId ?? -1, { partitionKey: { topLevelSite: `call-${details.tabId}` } }),
      onChanged: makeEvent<[chrome.cookies.CookieChangeInfo]>().api
    }

    const cookies = make(api)

    const call = (index: number): Effect.Effect<string, ChromeCookiesError> => {
      const name = `call-${index}`
      const operation = plan[index]?.operation
      const url = "https://app.example/"

      if (operation === "get") return Effect.map(cookies.get({ url, name }), (found) => Option.match(found, { onNone: () => "", onSome: (each) => each.name }))

      if (operation === "getAll") return Effect.map(cookies.getAll({ name }), (found) => found[0]?.name ?? "")

      if (operation === "set") return Effect.map(cookies.set({ url, name }), (found) => Option.match(found, { onNone: () => "", onSome: (each) => each.name }))

      if (operation === "remove") return Effect.map(cookies.remove({ url, name }), (found) => Option.match(found, { onNone: () => "", onSome: (each) => each.name }))

      if (operation === "removeCookie") {
        return Effect.map(cookies.removeCookie(cookieNamed(name)), (found) => Option.match(found, { onNone: () => "", onSome: (each) => each.name }))
      }

      if (operation === "getAllCookieStores") return Effect.map(cookies.getAllCookieStores, (stores) => stores[0]?.id ?? "")

      return Effect.map(cookies.getPartitionKey({ tabId: index }), (key) => key.topLevelSite ?? "")
    }

    const fiber = yield* Effect.forkScoped(Effect.forEach(range(0, total), (index) => Effect.exit(call(index)), { concurrency: "unbounded" }))
    yield* Deferred.await(started)
    release.open()
    const exits = yield* Fiber.join(fiber)

    for (const [index, exit] of exits.entries()) {
      const entry = plan[index]
      const operation = entry?.operation === "removeCookie" ? "remove" : entry?.operation ?? ""

      if (entry?.outcome === "resolve") expect(exit).toEqual(Exit.succeed(`call-${index}`))
      else expect(exit).toEqual(Exit.fail(new ChromeCookiesError({ operation, cause: new Error(`call ${index}`) })))
    }

    expect(exits.filter(Exit.isFailure)).toHaveLength(plan.filter((entry) => entry.outcome !== "resolve").length)
    expect(new Set(plan.map((entry) => `${entry.operation}:${entry.outcome}`)).size).toBe(operations.length * outcomes.length)
    expect(calls).toBe(total)
  }))

  it.effect("interrupts 1,024 in-flight calls across operations and ignores their late settlement", () => Effect.gen(function*() {
    const total = 1024
    const started = yield* Deferred.make<void>()
    const pending: Array<ReturnType<typeof gate<never>>> = []

    const hold = <A>(): Promise<A> => {
      const settlement = gate<never>()
      pending.push(settlement)

      if (pending.length === total) Deferred.doneUnsafe(started, Effect.void)

      return settlement.promise
    }

    const api: ChromeCookiesApi = {
      ...quietApi(makeEvent<[chrome.cookies.CookieChangeInfo]>().api),
      get: hold, getAll: hold, set: hold, remove: hold, getAllCookieStores: hold, getPartitionKey: hold
    }

    const cookies = make(api)
    const url = "https://app.example/"

    const calls: ReadonlyArray<(index: number) => Effect.Effect<void, ChromeCookiesError>> = [
      (index) => Effect.asVoid(cookies.get({ url, name: `n${index}` })),
      (index) => Effect.asVoid(cookies.getAll({ name: `n${index}` })),
      (index) => Effect.asVoid(cookies.set({ url, name: `n${index}` })),
      (index) => Effect.asVoid(cookies.remove({ url, name: `n${index}` })),
      (index) => Effect.asVoid(cookies.removeCookie(cookieNamed(`n${index}`))),
      () => Effect.asVoid(cookies.getAllCookieStores),
      (index) => Effect.asVoid(cookies.getPartitionKey({ tabId: index }))
    ]

    const fibers = yield* Effect.forEach(range(0, total), (index) => Effect.forkScoped(calls[index % calls.length]?.(index) ?? Effect.void))
    yield* Deferred.await(started)
    yield* Fiber.interruptAll(fibers)

    for (const fiber of fibers) expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)

    for (const [index, settlement] of pending.entries()) settlement.fail(new Error(`late ${index}`))

    const late = yield* Effect.promise(() => Promise.allSettled(pending.map((settlement) => settlement.promise)))
    expect(late.every((outcome) => outcome.status === "rejected")).toBe(true)
    // The service stays usable after the interrupted calls.
    expect(yield* make(quietApi(makeEvent<[chrome.cookies.CookieChangeInfo]>().api)).get({ url, name: "after" })).toEqual(Option.none())
  }))

  it.effect("deactivates a listener whose removal throws, so a later 4,096-event burst delivers nothing", () => Effect.gen(function*() {
    const event = makeEvent<[chrome.cookies.CookieChangeInfo]>()
    const cause = new Error("removeListener failed")
    event.controls.failNext("removeListener", cause)
    const delivered: Array<string> = []
    const stream = Stream.tap(make(quietApi(event.api)).onChanged, (each) => Effect.sync(() => { delivered.push(each.cookie.value) }))
    const fiber = yield* Effect.forkScoped(Effect.exit(Stream.runCollect(Stream.take(stream, 1))))
    yield* Effect.promise(() => event.controls.waitForListener())
    event.controls.emit(change(0))
    const exit = yield* Fiber.join(fiber)
    expect(Exit.hasDies(exit)).toBe(true)
    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toBe(cause)
    expect(event.controls.listenerCount).toBe(1)

    for (const index of range(1, 4097)) expect(event.controls.emit(change(index))).toEqual([])

    expect(delivered).toEqual(["0"])
  }))

  it.effect("cleans up 256 concurrent registrations that add the listener and then throw", () => Effect.gen(function*() {
    const event = makeEvent<[chrome.cookies.CookieChangeInfo]>()
    const cause = new Error("registered, then failed")

    const source: ChangeEvent = {
      addListener: (listener) => {
        event.api.addListener(listener)
        throw cause
      },
      removeListener: (listener) => event.api.removeListener(listener)
    }

    const stream = make(quietApi(source)).onChanged
    const errors = yield* Effect.forEach(range(0, 256), () => Effect.flip(Stream.runDrain(stream)), { concurrency: "unbounded" })
    expect(errors.every((error) => error instanceof ChromeCookiesError && error.operation === "onChanged" && error.cause === cause)).toBe(true)
    expect(event.controls.listenerCount).toBe(0)
  }))

  it.effect("races 512 concurrent sets of one cookie into one survivor matching the change log", () => Effect.gen(function*() {
    const fixture = makeCookies()
    const cookies = make(fixture.api)
    const events: Array<chrome.cookies.CookieChangeInfo> = []
    fixture.api.onChanged.addListener((each) => { events.push(each) })

    const results = yield* Effect.forEach(range(0, 512), (index) =>
      cookies.set({ url: "https://app.example/", name: "id", value: String(index) }), { concurrency: "unbounded" })

    expect(results.map((result) => Option.map(result, (cookie) => cookie.value))).toEqual(range(0, 512).map((index) => Option.some(String(index))))
    const survivors = fixture.controls.cookies()
    expect(survivors).toHaveLength(1)
    expect(survivors[0]?.value).toBe(events.at(-1)?.cookie.value)
    expect(events.filter((each) => each.cause === "explicit" && !each.removed)).toHaveLength(512)
    expect(events.filter((each) => each.cause === "overwrite" && each.removed)).toHaveLength(511)
  }))

  it.effect("keeps 2,048 interleaved concurrent sets, expiring sets and removes consistent with the change log", () => Effect.gen(function*() {
    const random = seeded(2048)
    const fixture = makeCookies()
    const cookies = make(fixture.api)
    const events: Array<chrome.cookies.CookieChangeInfo> = []
    fixture.api.onChanged.addListener((each) => { events.push(each) })
    const names = ["a", "b", "c", "d"]
    const kinds = ["set", "set", "remove", "expire"] as const

    const plan = range(0, 2048).map((index) => ({
      name: names[Math.floor(random() * names.length)] ?? "a", kind: kinds[Math.floor(random() * kinds.length)] ?? "set", value: String(index)
    }))

    const url = "https://app.example/"

    const results = yield* Effect.forEach(plan, (step) => step.kind === "remove"
      ? Effect.map(cookies.remove({ url, name: step.name }), Option.isSome)
      : Effect.map(cookies.set(step.kind === "expire"
        ? { url, name: step.name, value: step.value, expirationDate: 1 }
        : { url, name: step.name, value: step.value }), Option.isSome),
    { concurrency: "unbounded" })

    // Removes always report their details; expiring sets never return a cookie.
    expect(results).toEqual(plan.map((step) => step.kind !== "expire"))
    const model = new Map<string, string>()
    let pendingOverwrite: string | undefined

    for (const each of events) {
      const name = each.cookie.name

      if (each.removed) {
        expect(model.get(name)).toBe(each.cookie.value)
        expect(pendingOverwrite).toBeUndefined()
        model.delete(name)

        if (each.cause === "overwrite") pendingOverwrite = name
        else expect(["explicit", "expired_overwrite"]).toContain(each.cause)
      } else {
        expect(model.has(name)).toBe(false)
        expect([undefined, name]).toContain(pendingOverwrite)
        pendingOverwrite = undefined
        model.set(name, each.cookie.value)
      }
    }

    expect(pendingOverwrite).toBeUndefined()
    expect(new Map(fixture.controls.cookies().map((cookie) => [cookie.name, cookie.value]))).toEqual(model)
    expect(events.filter((each) => !each.removed)).toHaveLength(plan.filter((step) => step.kind === "set").length)
  }))

  it.effect("lists, orders and removes a 2,048-cookie population across hosts, paths, stores and partitions", () => Effect.gen(function*() {
    const fixture = makeCookies()
    fixture.controls.setStores([{ id: "0", tabIds: [] }, { id: "1", tabIds: [1] }])
    const cookies = make(fixture.api)
    const removed: Array<string> = []
    fixture.api.onChanged.addListener(({ cookie, removed: isRemoval }) => { if (isRemoval) removed.push(cookie.name) })
    const paths = ["/", "/a", "/a/b", "/a/b/c"]

    for (const index of range(0, 2048)) {
      const host = `h${index % 32}.app.example`
      const path = paths[index % paths.length] ?? "/"
      const variant = index % 8

      const details: chrome.cookies.SetDetails = { url: `https://${host}${path}`, name: `n${index}`, value: String(index), path, secure: variant >= 4 }

      if (variant === 1) details.domain = host

      if (variant === 2) details.storeId = "1"

      if (variant === 5) details.partitionKey = { topLevelSite: `https://top${index % 3}.example` }

      expect(fixture.controls.seed(details)).not.toBeNull()
    }

    const regular = yield* cookies.getAll({ partitionKey: {} })
    const incognito = yield* cookies.getAll({ storeId: "1", partitionKey: {} })
    expect(regular.length + incognito.length).toBe(2048)
    expect(incognito).toHaveLength(256)

    for (const [index, each] of regular.entries()) {
      const next = regular[index + 1]

      if (next !== undefined) expect(each.path.length).toBeGreaterThanOrEqual(next.path.length)
    }

    expect(yield* cookies.getAll({ domain: "h3.app.example" })).toHaveLength(64)
    expect(yield* cookies.getAll({ domain: "h2.app.example" })).toHaveLength(0)
    expect(yield* cookies.getAll({ domain: "h2.app.example", storeId: "1" })).toHaveLength(64)
    expect(yield* cookies.getAll({ domain: "h5.app.example" })).toHaveLength(0)
    expect(yield* cookies.getAll({ domain: "h5.app.example", partitionKey: {} })).toHaveLength(64)
    expect(yield* cookies.getAll({ domain: "app.example", partitionKey: {} })).toHaveLength(2048 - 256)
    expect(yield* cookies.getAll({ partitionKey: { topLevelSite: "https://top1.example" } })).toHaveLength(85)
    expect(yield* cookies.getAll({})).toHaveLength(2048 - 256 - 256)
    expect((yield* cookies.getAll({ url: "https://h0.app.example/a/b/c/d" })).every((each) => each.domain.endsWith("h0.app.example"))).toBe(true)
    yield* Effect.forEach([...regular, ...incognito], cookies.removeCookie, { concurrency: 64, discard: true })
    expect(fixture.controls.cookies()).toEqual([])
    expect(removed).toHaveLength(2048)
    expect(new Set(removed).size).toBe(2048)
  }))

  it.effect("rejects 1,024 concurrent invalid calls with Chrome's messages and leaves the jar empty", () => Effect.gen(function*() {
    const fixture = makeCookies()
    const cookies = make(fixture.api)
    const lookup = (index: number): CookieDetails => ({ url: index % 2 === 0 ? "not a url" : "https://app.example/", name: "x", storeId: index % 2 === 0 ? "0" : "9" })

    const errors = yield* Effect.forEach(range(0, 1024), (index) => Effect.flip(index % 4 < 2
      ? Effect.asVoid(cookies.get(lookup(index)))
      : Effect.asVoid(cookies.set({ ...lookup(index), secure: true }))), { concurrency: "unbounded" })

    for (const [index, error] of errors.entries()) {
      expect(error.operation).toBe(index % 4 < 2 ? "get" : "set")
      expect(error.cause).toEqual(new Error(index % 2 === 0 ? "Invalid url: \"not a url\"." : "Invalid cookie store id: \"9\"."))
    }

    expect(fixture.controls.cookies()).toEqual([])
  }))

  it.effect("resolves 1,024 concurrent partition-key lookups over 256 frames, rejecting unknown frames", () => Effect.gen(function*() {
    const fixture = makeCookies()
    const cookies = make(fixture.api)

    for (const tabId of range(0, 64)) {
      for (const frameId of range(0, 4)) {
        fixture.controls.addFrame({ tabId, frameId, documentId: `doc-${tabId}-${frameId}` }, { topLevelSite: `https://top${tabId}.example`, hasCrossSiteAncestor: frameId > 0 })
      }
    }

    const results = yield* Effect.forEach(range(0, 1024), (index) => {
      const tabId = index % 80
      const frameId = index % 4
      const details = index % 3 === 0 ? { documentId: `doc-${tabId}-${frameId}` } : { tabId, frameId }

      return Effect.exit(cookies.getPartitionKey(details))
    }, { concurrency: "unbounded" })

    for (const [index, exit] of results.entries()) {
      const tabId = index % 80

      if (tabId < 64) {
        expect(exit).toEqual(Exit.succeed({ topLevelSite: `https://top${tabId}.example`, hasCrossSiteAncestor: index % 4 > 0 }))
      } else {
        expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toMatchObject({ operation: "getPartitionKey" })
      }
    }
  }))
})
