// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Cause, Effect, Exit, Fiber, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "@effect/vitest"
import { ChromeIdentityError, make } from "../../src/ChromeIdentity.js"
import type { ChromeIdentityApi, ChromeIdentityService, SignInChange } from "../../src/ChromeIdentity.js"
import { makeEvent } from "../../src/testing/Event.js"
import { makeIdentity } from "../../src/testing/Identity.js"
import type { EventSource } from "../../src/internal/event.js"

/** A small deterministic generator (mulberry32), so every run churns the same way. */
const seeded = (seed: number) => {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <A>(random: () => number, values: ReadonlyArray<A>): A => {
  const value = values[Math.floor(random() * values.length)]

  if (value === undefined) throw new Error("pick needs a non-empty list")

  return value
}

/** A resolvable promise used as an explicit gate. */
const gate = <A = void>() => {
  let open!: (value: A) => void
  const promise = new Promise<A>((resolve) => { open = resolve })

  return { promise, open }
}

const redirect = "https://stress-extension.chromiumapp.org/"

type SignInArgs = [account: chrome.identity.AccountInfo, signedIn: boolean]

/** An API with only the always-present members and the given sign-in event. */
const eventApi = (onSignInChanged: EventSource<SignInArgs>): ChromeIdentityApi => ({
  getRedirectURL: () => redirect,
  launchWebAuthFlow: () => Promise.reject(new Error("not called by event stress")),
  onSignInChanged
})

/** What event `index` of a burst carries: alternating sign-in and sign-out of rotating accounts. */
const change = (index: number): SignInChange => ({ account: { id: `account-${index % 7}` }, signedIn: index % 2 === 0 })

const emitChange = (emit: (...args: SignInArgs) => ReadonlyArray<unknown>, index: number) => {
  const { account, signedIn } = change(index)
  emit({ ...account }, signedIn)
}

const newest = (total: number) => Array.from({ length: Math.min(total, 64) }, (_, index) => change(Math.max(0, total - 64) + index))

/** Per-subscription hooks around a shared event, so each subscription can misbehave its own way. */
interface Hooks {
  readonly added: () => void
  readonly removed: () => void
  onAdd?: () => void
  failBeforeAdd?: Error
  failAfterAdd?: Error
}

const hooked = (real: EventSource<SignInArgs>, hooks: Hooks): EventSource<SignInArgs> => ({
  addListener: (listener) => {
    if (hooks.failBeforeAdd !== undefined) throw hooks.failBeforeAdd

    real.addListener(listener)
    hooks.added()
    hooks.onAdd?.()

    if (hooks.failAfterAdd !== undefined) throw hooks.failAfterAdd
  },
  removeListener: (listener) => {
    real.removeListener(listener)
    hooks.removed()
  }
})

/** How a churned subscription consumes: one event, stalled on its first event, or until it ends. */
const consume = (stage: string, stream: Stream.Stream<SignInChange, ChromeIdentityError>) => {
  if (stage === "completes") return Stream.runCollect(Stream.take(stream, 1))

  if (stage === "stalled") return Stream.runCollect(Stream.mapEffect(stream, () => Effect.never))

  return Stream.runCollect(stream)
}

describe("ChromeIdentity onSignInChanged stress", () => {
  it.effect("keeps exactly the newest 64 of a 4,096-event burst into a waiting consumer", () => Effect.gen(function*() {
    const event = makeEvent<SignInArgs>()
    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(make(eventApi(event.api)).onSignInChanged, 64)))
    yield* Effect.promise(() => event.controls.waitForListener())

    for (let index = 0; index < 4096; index++) emitChange(event.controls.emit, index)

    expect(yield* Fiber.join(fiber)).toEqual(newest(4096))
    expect(event.controls.listenerCount).toBe(0)
  }))

  it.effect("keeps exactly the newest 64 of a 4,096-event burst delivered during registration", () => Effect.gen(function*() {
    const event = makeEvent<SignInArgs>()
    let removals = 0

    const source = hooked(event.api, {
      added: () => {},
      removed: () => { removals++ },
      onAdd: () => { for (let index = 0; index < 4096; index++) emitChange(event.controls.emit, index) }
    })

    expect(yield* Stream.runCollect(Stream.take(make(eventApi(source)).onSignInChanged, 64))).toEqual(newest(4096))
    expect(event.controls.listenerCount).toBe(0)
    expect(removals).toBe(1)
  }))

  it.effect("keeps 128 independent subscriptions each to the newest 64 of 4,096 events", () => Effect.gen(function*() {
    const event = makeEvent<SignInArgs>()
    const registered = gate()
    let added = 0

    const source = hooked(event.api, {
      added: () => {
        added++

        if (added === 128) registered.open()
      },
      removed: () => {}
    })

    const stream = make(eventApi(source)).onSignInChanged
    const fibers = yield* Effect.forEach(Array.from({ length: 128 }), () => Effect.forkChild(Stream.runCollect(Stream.take(stream, 64))))
    yield* Effect.promise(() => registered.promise)

    for (let index = 0; index < 4096; index++) emitChange(event.controls.emit, index)

    for (const values of yield* Effect.forEach(fibers, Fiber.join)) expect(values).toEqual(newest(4096))

    expect(event.controls.listenerCount).toBe(0)
  }))

  it.effect("keeps the newest 64 of 4,096 sign-in changes from 2,048 fixture account switches", () => Effect.gen(function*() {
    const fixture = makeIdentity()
    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(make(fixture.api).onSignInChanged, 64)))
    yield* Effect.promise(() => fixture.controls.onSignInChanged.waitForListener())

    // The first sign-in emits once; each later one signs the previous account out first.
    for (let index = 0; index < 2048; index++) fixture.controls.signIn({ email: `user-${index}@example.com`, id: `user-${index}` })

    fixture.controls.signOut()

    // Position 0 is user-0 signing in; then 2k-1 and 2k are user-(k-1) out and user-k in;
    // 4095 is user-2047 out. So an even position p signs user-(p/2) in, an odd one signs
    // user-((p-1)/2) out.
    const expected = Array.from({ length: 64 }, (_, offset) => {
      const position = 4096 - 64 + offset

      return { account: { id: `user-${Math.floor(position / 2)}` }, signedIn: position % 2 === 0 }
    })

    expect(yield* Fiber.join(fiber)).toEqual(expected)
    expect(fixture.controls.onSignInChanged.listenerCount).toBe(0)
  }))

  it.effect("churns 512 concurrent subscriptions through interruption at every stage", () => Effect.gen(function*() {
    const random = seeded(512)
    const event = makeEvent<SignInArgs>()

    const stages = [
      "unstarted", "registered", "stalled", "midRegistration", "partialFailure", "refused", "missingEvent", "completes"
    ] as const

    let adds = 0
    let removes = 0
    let interruptedDuringRegistration = 0

    const subscriptions = yield* Effect.forEach(Array.from({ length: 512 }, (_, index) => index), (index) => Effect.gen(function*() {
      const stage = pick(random, stages)
      const added = gate()
      const cause = new Error(`${stage} ${index}`)
      let self: Fiber.Fiber<ReadonlyArray<SignInChange>, ChromeIdentityError> | undefined

      const hooks: Hooks = {
        added: () => {
          adds++
          added.open()
        },
        removed: () => { removes++ }
      }

      // Interruption requested while Chrome is still inside addListener.
      if (stage === "midRegistration") {
        hooks.onAdd = () => {
          if (self === undefined) return

          interruptedDuringRegistration++
          self.interruptUnsafe()
        }
      }

      if (stage === "partialFailure") hooks.failAfterAdd = cause

      if (stage === "refused") hooks.failBeforeAdd = cause

      const api: ChromeIdentityApi = stage === "missingEvent"
        ? { ...eventApi(event.api), get onSignInChanged(): never { throw cause } }
        : eventApi(hooked(event.api, hooks))

      const stream = make(api).onSignInChanged

      const fiber = yield* Effect.forkChild(consume(stage, stream))
      self = fiber

      if (stage === "unstarted") yield* Fiber.interrupt(fiber)

      return { stage, fiber, added, cause }
    }))

    const registering = subscriptions.filter(({ stage }) => stage !== "unstarted" && stage !== "refused" && stage !== "missingEvent")
    yield* Effect.promise(() => Promise.all(registering.map(({ added }) => added.promise)))

    for (let index = 0; index < 128; index++) emitChange(event.controls.emit, index)

    const settling = new Set<string>(["completes", "partialFailure", "refused", "missingEvent"])

    for (const { stage, fiber, cause } of subscriptions) {
      const exit = yield* (settling.has(stage) ? Fiber.await(fiber) : Effect.andThen(Fiber.interrupt(fiber), Fiber.await(fiber)))
      expect(Exit.hasDies(exit)).toBe(false)

      // The 128 events arrived in one synchronous burst, so the buffer slid to the newest 64.
      if (stage === "completes") expect(yield* exit).toEqual([change(64)])
      else if (stage === "partialFailure" || stage === "refused" || stage === "missingEvent") {
        const error = yield* Effect.flip(exit)
        expect(error).toBeInstanceOf(ChromeIdentityError)
        expect(error.operation).toBe("onSignInChanged")
        expect(error.cause).toBe(cause)
      } else expect(Exit.hasInterrupts(exit)).toBe(true)
    }

    expect(event.controls.listenerCount).toBe(0)
    // Cleanup is installed before registration, so a refused registration still removes
    // (a no-op in Chrome); every listener that was added is removed exactly once.
    expect(removes).toBe(adds + subscriptions.filter(({ stage }) => stage === "refused").length)
    expect(interruptedDuringRegistration).toBe(subscriptions.filter(({ stage }) => stage === "midRegistration").length)
    expect(new Set(subscriptions.map(({ stage }) => stage))).toEqual(new Set(stages))
  }))
})

type Mode = "ok" | "okLate" | "reject" | "rejectLate" | "throw"

const asyncModes: ReadonlyArray<Mode> = ["ok", "okLate", "reject", "rejectLate", "throw"]

/** `getRedirectURL` is synchronous: it can only return or throw. */
const syncModes: ReadonlyArray<Mode> = ["ok", "throw"]

type Operation = "getRedirectURL" | "launchWebAuthFlow" | "getAuthToken" | "removeCachedAuthToken"
  | "clearAllCachedAuthTokens" | "getProfileUserInfo" | "getAccounts"

type CallResult = string | Option.Option<string> | void | chrome.identity.GetAuthTokenResult
  | chrome.identity.ProfileUserInfo | Array<chrome.identity.AccountInfo>

/** Operations whose call carries its index, so the mock knows that call's planned outcome. */
const keyed: ReadonlyArray<readonly [Operation, (identity: ChromeIdentityService, index: number) => Effect.Effect<CallResult, ChromeIdentityError>]> = [
  ["getRedirectURL", (identity, index) => identity.getRedirectURL(`${index}`)],
  ["launchWebAuthFlow", (identity, index) => identity.launchWebAuthFlow({ url: `https://auth.example/${index}` })],
  ["getAuthToken", (identity, index) => identity.getAuthToken({ scopes: [`${index}`] })],
  ["removeCachedAuthToken", (identity, index) => identity.removeCachedAuthToken({ token: `${index}` })]
]

/** Operations without an index-carrying argument; their outcomes are planned in arrival order. */
const arrivalOrdered: ReadonlyArray<readonly [Operation, (identity: ChromeIdentityService) => Effect.Effect<CallResult, ChromeIdentityError>]> = [
  ["clearAllCachedAuthTokens", (identity) => identity.clearAllCachedAuthTokens],
  ["getProfileUserInfo", (identity) => identity.getProfileUserInfo()],
  ["getAccounts", (identity) => identity.getAccounts]
]

const operationCount = keyed.length + arrivalOrdered.length

/**
 * A full API whose outcomes follow `plan`, keyed by `operation:index` for keyed operations and
 * `operation#arrival` for the others. Late outcomes settle only once every call has arrived.
 */
const plannedApi = (total: number, plan: Map<string, Mode>) => {
  const causes = new Map<string, Error>()
  const arrivalsByOperation = new Map<Operation, number>()
  const profileArgumentCounts: Array<number> = []
  const everyCallArrived = gate()
  let arrivals = 0

  const arrive = (key: string): Mode => {
    arrivals++

    if (arrivals === total) everyCallArrived.open()

    return plan.get(key) ?? "ok"
  }

  const causeFor = (key: string, mode: Mode) => {
    const cause = new Error(`${key} ${mode}`)
    causes.set(key, cause)

    return cause
  }

  const settle = <A>(key: string, value: A): Promise<A> => {
    const mode = arrive(key)
    const cause = causeFor(key, mode)

    switch (mode) {
      case "ok": return Promise.resolve(value)
      case "okLate": return everyCallArrived.promise.then(() => value)
      case "reject": return Promise.reject(cause)
      case "rejectLate": return everyCallArrived.promise.then(() => Promise.reject(cause))
      case "throw": throw cause
    }
  }

  const byArrival = (operation: Operation) => {
    const arrival = (arrivalsByOperation.get(operation) ?? 0) + 1
    arrivalsByOperation.set(operation, arrival)

    return `${operation}#${arrival}`
  }

  const api: ChromeIdentityApi = {
    getRedirectURL: (path) => {
      const key = `getRedirectURL:${path}`
      const mode = arrive(key)
      const cause = causeFor(key, mode)

      if (mode === "throw") throw cause

      return `${redirect}${path}`
    },
    launchWebAuthFlow: (details) => settle(`launchWebAuthFlow:${details.url.slice("https://auth.example/".length)}`, details.url),
    getAuthToken: (details) => settle(`getAuthToken:${details?.scopes?.[0]}`, { token: `token-${details?.scopes?.[0]}`, grantedScopes: details?.scopes ?? [] }),
    removeCachedAuthToken: ({ token }) => settle(`removeCachedAuthToken:${token}`, undefined),
    clearAllCachedAuthTokens: () => settle(byArrival("clearAllCachedAuthTokens"), undefined),
    getProfileUserInfo: (...args) => {
      profileArgumentCounts.push(args.length)

      return settle(byArrival("getProfileUserInfo"), { email: "user@example.com", id: "user" })
    },
    getAccounts: () => settle(byArrival("getAccounts"), [{ id: "user" }])
  }

  return { api, causes, profileArgumentCounts }
}

/** What a keyed call resolves to when it succeeds. */
const expectedValue = (operation: Operation, index: number): CallResult => {
  switch (operation) {
    case "getRedirectURL": return `${redirect}${index}`
    case "launchWebAuthFlow": return Option.some(`https://auth.example/${index}`)
    case "getAuthToken": return { token: `token-${index}`, grantedScopes: [`${index}`] }
    default: return undefined
  }
}

describe("ChromeIdentity call stress", () => {
  it.effect("types 1,029 concurrent calls with interleaved rejections, late rejections and throws", () => Effect.gen(function*() {
    const random = seeded(1029)

    const calls = Array.from({ length: 1029 }, (_, index) => {
      const slot = index % operationCount
      const keyedEntry = keyed[slot]

      if (keyedEntry !== undefined) {
        const [operation, run] = keyedEntry

        return { index, operation, run: (identity: ChromeIdentityService) => run(identity, index), mode: pick(random, operation === "getRedirectURL" ? syncModes : asyncModes), keyed: true }
      }

      const arrivalEntry = arrivalOrdered[slot - keyed.length]

      if (arrivalEntry === undefined) throw new Error("no operation")

      return { index, operation: arrivalEntry[0], run: arrivalEntry[1], mode: pick(random, asyncModes), keyed: false }
    })

    const plan = new Map<string, Mode>()
    const arrivalCounts = new Map<Operation, number>()

    for (const call of calls) {
      if (call.keyed) plan.set(`${call.operation}:${call.index}`, call.mode)
      else {
        const arrival = (arrivalCounts.get(call.operation) ?? 0) + 1
        arrivalCounts.set(call.operation, arrival)
        plan.set(`${call.operation}#${arrival}`, call.mode)
      }
    }

    const { api, causes, profileArgumentCounts } = plannedApi(calls.length, plan)
    const identity = make(api)
    const exits = yield* Effect.forEach(calls, (call) => Effect.exit(call.run(identity)), { concurrency: "unbounded" })
    const arrivalFailures = new Map<Operation, Set<unknown>>()

    for (const [position, exit] of exits.entries()) {
      const call = calls[position]

      if (call === undefined) throw new Error("missing call")

      expect(Exit.hasDies(exit)).toBe(false)
      expect(Exit.hasInterrupts(exit)).toBe(false)

      if (call.keyed) {
        const failing = call.mode === "reject" || call.mode === "rejectLate" || call.mode === "throw"

        if (failing) {
          const error = yield* Effect.flip(exit)
          expect(error).toBeInstanceOf(ChromeIdentityError)
          expect(error.operation).toBe(call.operation)
          expect(error.cause).toBe(causes.get(`${call.operation}:${call.index}`))
        } else expect(yield* exit).toEqual(expectedValue(call.operation, call.index))
      } else if (Exit.isFailure(exit)) {
        const error = yield* Effect.flip(exit)
        expect(error).toBeInstanceOf(ChromeIdentityError)
        expect(error.operation).toBe(call.operation)
        const seen = arrivalFailures.get(call.operation) ?? new Set()
        seen.add(error.cause)
        arrivalFailures.set(call.operation, seen)
      }
    }

    // Arrival-ordered failures are exactly the planned ones, each with its own cause.
    for (const [operation] of arrivalOrdered) {
      const planned = calls.filter((call) => call.operation === operation && call.mode !== "ok" && call.mode !== "okLate")

      const expectedCauses = new Set(Array.from(plan.entries())
        .filter(([key, mode]) => key.startsWith(`${operation}#`) && mode !== "ok" && mode !== "okLate")
        .map(([key]) => causes.get(key)))

      const failures = arrivalFailures.get(operation) ?? new Set()
      expect(failures.size).toBe(expectedCauses.size)

      for (const cause of failures) expect(Array.from(expectedCauses).some((expected) => expected === cause)).toBe(true)

      expect(expectedCauses.size).toBe(planned.length)
    }

    // getProfileUserInfo() never passed an explicit undefined, even under concurrency.
    expect(profileArgumentCounts).toEqual(Array.from({ length: profileArgumentCounts.length }, () => 0))
    expect(profileArgumentCounts.length).toBe(calls.filter((call) => call.operation === "getProfileUserInfo").length)
    expect(new Set(calls.map((call) => call.mode))).toEqual(new Set(asyncModes))
  }))

  it.effect("interrupts 512 of 1,024 pending web auth flows and ignores their late settlement", () => Effect.gen(function*() {
    const pending = new Map<string, { readonly resolve: (url: string) => void, readonly reject: (cause: Error) => void }>()
    const everyFlowArrived = gate()

    const api: ChromeIdentityApi = {
      getRedirectURL: () => redirect,
      launchWebAuthFlow: (details) => new Promise<string | undefined>((resolve, reject) => {
        pending.set(details.url, { resolve, reject })

        if (pending.size === 1024) everyFlowArrived.open()
      })
    }

    const identity = make(api)
    const urls = Array.from({ length: 1024 }, (_, index) => `https://auth.example/${index}`)
    const fibers = yield* Effect.forEach(urls, (url) => Effect.forkChild(identity.launchWebAuthFlow({ url, interactive: true })))
    yield* Effect.promise(() => everyFlowArrived.promise)
    yield* Effect.forEach(fibers.filter((_, index) => index % 2 === 1), Fiber.interrupt, { concurrency: "unbounded", discard: true })

    // Chrome settles every flow later: the user finishes the even ones and closes the odd ones.
    for (const [index, url] of urls.entries()) {
      const settle = pending.get(url)

      if (settle === undefined) throw new Error(`flow ${url} never arrived`)

      if (index % 2 === 0) settle.resolve(`${redirect}?state=${index}`)
      else settle.reject(new Error("The user did not approve access."))
    }

    for (const [index, fiber] of fibers.entries()) {
      const exit = yield* Fiber.await(fiber)
      expect(Exit.hasDies(exit)).toBe(false)

      if (index % 2 === 0) expect(yield* exit).toEqual(Option.some(`${redirect}?state=${index}`))
      else expect(Exit.hasInterrupts(exit)).toBe(true)
    }
  }))

  it.effect("times out 256 hung non-interactive flows on the test clock without settling them", () => Effect.gen(function*() {
    const arrived = gate()
    let calls = 0

    const api: ChromeIdentityApi = {
      getRedirectURL: () => redirect,
      launchWebAuthFlow: () => {
        calls++

        if (calls === 256) arrived.open()

        return new Promise<string | undefined>(() => {})
      }
    }

    const identity = make(api)

    const fibers = yield* Effect.forEach(Array.from({ length: 256 }, (_, index) => index), (index) => Effect.forkChild(
      identity.launchWebAuthFlow({ url: `https://auth.invalid/${index}`, interactive: false }).pipe(Effect.timeout("20 seconds"))
    ))

    yield* Effect.promise(() => arrived.promise)
    yield* TestClock.adjust("19 seconds")

    for (const fiber of fibers) expect(fiber.pollUnsafe()).toBeUndefined()

    yield* TestClock.adjust("1 second")

    for (const fiber of fibers) {
      const error = yield* Effect.flip(Fiber.join(fiber))
      expect(Cause.isTimeoutError(error)).toBe(true)
    }

    expect(calls).toBe(256)
  }))
})

describe("makeIdentity stress", () => {
  it.effect("serves 4,096 cached scope sets concurrently, then evicts half and clears the rest", () => Effect.gen(function*() {
    const fixture = makeIdentity()
    const identity = make(fixture.api)
    fixture.controls.signIn({ email: "user@example.com", id: "user" })

    for (let index = 0; index < 4096; index++) fixture.controls.cacheToken(`token-${index}`, [`scope-${index}`, "shared"])

    const results = yield* Effect.forEach(Array.from({ length: 4096 }, (_, index) => index), (index) =>
      identity.getAuthToken({ scopes: ["shared", `scope-${index}`, "shared"] }), { concurrency: "unbounded" })

    for (const [index, result] of results.entries()) {
      expect(result.token).toBe(`token-${index}`)
      expect(result.grantedScopes).toEqual([`scope-${index}`, "shared"].sort())
    }

    yield* Effect.forEach(Array.from({ length: 2048 }, (_, index) => index * 2), (index) =>
      identity.removeCachedAuthToken({ token: `token-${index}` }), { concurrency: "unbounded", discard: true })
    expect(fixture.controls.cachedTokens()).toEqual(Array.from({ length: 2048 }, (_, index) => `token-${index * 2 + 1}`))

    const misses = yield* Effect.forEach(Array.from({ length: 2048 }, (_, index) => index * 2), (index) =>
      Effect.flip(identity.getAuthToken({ scopes: [`scope-${index}`, "shared"] })), { concurrency: "unbounded" })

    for (const error of misses) expect(error).toMatchObject({ operation: "getAuthToken", cause: new Error("OAuth2 not granted or revoked.") })

    yield* identity.clearAllCachedAuthTokens
    expect(fixture.controls.cachedTokens()).toEqual([])
  }))

  it.effect("grants one consent to 1,024 concurrent interactive requests for the same scope set", () => Effect.gen(function*() {
    const fixture = makeIdentity()
    const identity = make(fixture.api)
    fixture.controls.signIn({ email: "user@example.com", id: "user" })
    fixture.controls.grantNext("first")
    fixture.controls.grantNext("second")

    const results = yield* Effect.forEach(Array.from({ length: 1024 }), () =>
      identity.getAuthToken({ interactive: true, scopes: ["email"] }), { concurrency: "unbounded" })

    expect(new Set(results.map((result) => result.token))).toEqual(new Set(["first"]))
    expect(yield* identity.getAuthToken({ interactive: true, scopes: ["profile"] })).toEqual({ token: "second", grantedScopes: ["profile"] })
  }))

  it.effect("grants 1,024 distinct scope sets concurrently and fails the requests beyond the queued grants", () => Effect.gen(function*() {
    const fixture = makeIdentity()
    const identity = make(fixture.api)
    fixture.controls.signIn({ email: "user@example.com", id: "user" })

    for (let index = 0; index < 1024; index++) fixture.controls.grantNext(`grant-${index}`)

    const exits = yield* Effect.forEach(Array.from({ length: 1536 }, (_, index) => index), (index) =>
      Effect.exit(identity.getAuthToken({ interactive: true, scopes: [`scope-${index}`] })), { concurrency: "unbounded" })

    const tokens = exits.filter(Exit.isSuccess).map((exit) => exit.value.token)
    expect(new Set(tokens)).toEqual(new Set(Array.from({ length: 1024 }, (_, index) => `grant-${index}`)))
    expect(tokens).toHaveLength(1024)

    for (const exit of exits.filter(Exit.isFailure)) {
      expect(Exit.hasDies(exit)).toBe(false)
      expect(yield* Effect.flip(exit)).toMatchObject({ operation: "getAuthToken", cause: new Error("The user did not approve access.") })
    }

    expect(exits.filter(Exit.isFailure)).toHaveLength(512)
    expect(fixture.controls.cachedTokens()).toHaveLength(1024)
  }))

  it.effect("plays 1,024 concurrent scripted flows, each outcome decided by its own details", () => Effect.gen(function*() {
    const fixture = makeIdentity()
    const identity = make(fixture.api)

    for (let index = 0; index < 1024; index++) {
      fixture.controls.resolveNextFlow((details) => {
        if (details.url.endsWith("/denied")) throw new Error(`denied ${details.url}`)

        return `${redirect}?for=${encodeURIComponent(details.url)}`
      })
    }

    const urls = Array.from({ length: 1024 }, (_, index) => `https://auth.example/${index}${index % 3 === 0 ? "/denied" : ""}`)
    const exits = yield* Effect.forEach(urls, (url) => Effect.exit(identity.launchWebAuthFlow({ url })), { concurrency: "unbounded" })

    for (const [index, exit] of exits.entries()) {
      const url = urls[index] ?? ""

      expect(Exit.hasDies(exit)).toBe(false)

      if (index % 3 === 0) expect(yield* Effect.flip(exit)).toMatchObject({ operation: "launchWebAuthFlow", cause: new Error(`denied ${url}`) })
      else expect(yield* exit).toEqual(Option.some(`${redirect}?for=${encodeURIComponent(url)}`))
    }

    expect(new Set(fixture.controls.flows.map((details) => details.url))).toEqual(new Set(urls))
    // Every scripted outcome was consumed; the next flow is unscripted.
    expect((yield* Effect.flip(identity.launchWebAuthFlow({ url: "https://auth.example/extra" }))).cause).toEqual(new Error("User interaction required."))
  }))

  it.effect("resolves 10,000 redirect URLs and fails a queued burst of 1,024 lookups in order", () => Effect.gen(function*() {
    const fixture = makeIdentity()
    const identity = make(fixture.api)
    const causes = Array.from({ length: 1024 }, (_, index) => new Error(`lookup ${index}`))

    for (const cause of causes) fixture.controls.failNext("getRedirectURL", cause)

    for (const cause of causes) expect((yield* Effect.flip(identity.getRedirectURL("x"))).cause).toBe(cause)

    const urls = yield* Effect.forEach(Array.from({ length: 10000 }, (_, index) => index), (index) => identity.getRedirectURL(`limits/${index}`))
    expect(urls.every((url, index) => url === `https://test-extension-id.chromiumapp.org/limits/${index}`)).toBe(true)
  }))
})
