// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Cause, Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeWebRequestError, make } from "../../src/ChromeWebRequest.js"
import type * as WebRequest from "../../src/ChromeWebRequest.js"
import { makeWebRequest } from "../../src/testing/WebRequest.js"

/** Mulberry32: a small seeded generator, so every run churns the same way. */
const seeded = (seed: number) => {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <A>(random: () => number, values: ReadonlyArray<A>): A => {
  const value = values[Math.floor(random() * values.length)]

  if (value === undefined) throw new Error("pick from an empty list")

  return value
}

const shuffle = <A>(random: () => number, values: ReadonlyArray<A>): Array<A> => {
  const result = [...values]

  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    const current = result[index]
    const swapped = result[other]

    if (current === undefined || swapped === undefined) throw new Error("shuffle index out of range")

    result[index] = swapped
    result[other] = current
  }

  return result
}

/** Details every event accepts: the union of all detail fields, numbered through `requestId`. */
type AnyDetails = WebRequest.BeforeRequest & WebRequest.HeadersReceived & WebRequest.AuthRequired & WebRequest.Completed
  & WebRequest.ErrorOccurred & WebRequest.BeforeRedirect & WebRequest.ActionIgnored

const details = (index: number, tabId = 1): AnyDetails => ({
  requestId: String(index), action: "redirect", url: "https://a.example/", method: "GET", frameId: 0, parentFrameId: -1,
  tabId, type: "xmlhttprequest", timeStamp: index, frameType: "outermost_frame", documentLifecycle: "active",
  statusCode: 200, statusLine: "HTTP/1.1 200 OK", fromCache: false, error: "net::ERR_FAILED", redirectUrl: "https://b.example/",
  isProxy: false, scheme: "basic", challenger: { host: "a.example", port: 443 }, realm: "stress"
})

type Listener = (details: AnyDetails, asyncCallback?: WebRequest.AuthCallback) => void

/** Test hooks run inside Chrome's registration calls, as Chrome may dispatch during them. */
interface Hooks {
  onAdd: (listener: Listener) => void
  onRemove: (listener: Listener) => void
}

/**
 * A stress mock of one webRequest event. Registrations are keyed by the filter's `tabId`
 * (-1 without one), so a test can wait for, emit to, or fail one subscription among hundreds.
 */
const stressEvent = () => {
  const listeners = new Map<Listener, number>()
  const registered = new Map<number, Deferred.Deferred<Listener>>()
  const failures = new Map<number, Error>()
  const hooks: Hooks = { onAdd: () => {}, onRemove: () => {} }
  const sizeWaiters = new Map<number, Deferred.Deferred<void>>()
  let added = 0
  let removed = 0

  const notifySize = () => {
    const waiter = sizeWaiters.get(listeners.size)

    if (waiter === undefined) return

    sizeWaiters.delete(listeners.size)
    Deferred.doneUnsafe(waiter, Exit.void)
  }

  const gate = (key: number) => {
    const existing = registered.get(key)

    if (existing !== undefined) return existing

    const created = Deferred.makeUnsafe<Listener>()
    registered.set(key, created)

    return created
  }

  const addListener = (listener: Listener, filter?: WebRequest.RequestFilter) => {
    const key = filter?.tabId ?? -1
    const failure = failures.get(key)

    if (failure !== undefined) {
      failures.delete(key)
      throw failure
    }

    listeners.set(listener, key)
    added++
    hooks.onAdd(listener)
    Deferred.doneUnsafe(gate(key), Exit.succeed(listener))
    notifySize()
  }

  const removeListener = (listener: Listener) => {
    hooks.onRemove(listener)

    if (listeners.delete(listener)) removed++

    notifySize()
  }

  return {
    api: { addListener, removeListener },
    listeners,
    hooks,
    get added() { return added },
    get removed() { return removed },
    /** The listener registered with this tab id, once it is registered. */
    registration: (key: number) => Deferred.await(gate(key)),
    failNext: (key: number, cause: Error) => { failures.set(key, cause) },
    /** Waits until exactly `size` listeners are registered. */
    waitForSize: (size: number) => Effect.suspend(() => {
      if (listeners.size === size) return Effect.void

      const waiter = sizeWaiters.get(size) ?? Deferred.makeUnsafe<void>()
      sizeWaiters.set(size, waiter)

      return Deferred.await(waiter)
    }),
    emitAll: (value: AnyDetails, asyncCallback?: WebRequest.AuthCallback) => {
      for (const listener of Array.from(listeners.keys())) listener(value, asyncCallback)
    }
  }
}

const filteredNames = [
  "onBeforeRequest", "onBeforeSendHeaders", "onSendHeaders", "onHeadersReceived", "onAuthRequired",
  "onResponseStarted", "onCompleted", "onErrorOccurred", "onBeforeRedirect"
] as const

type EventName = typeof filteredNames[number] | "onActionIgnored"

const eventNames: ReadonlyArray<EventName> = [...filteredNames, "onActionIgnored"]

const stressApi = () => {
  const events = {
    onBeforeRequest: stressEvent(),
    onBeforeSendHeaders: stressEvent(),
    onSendHeaders: stressEvent(),
    onHeadersReceived: stressEvent(),
    onAuthRequired: stressEvent(),
    onResponseStarted: stressEvent(),
    onCompleted: stressEvent(),
    onErrorOccurred: stressEvent(),
    onBeforeRedirect: stressEvent(),
    onActionIgnored: stressEvent()
  }

  const handlerBehaviorChanged = vi.fn(async (): Promise<void> => {})

  const api: WebRequest.ChromeWebRequestApi = {
    handlerBehaviorChanged,
    onBeforeRequest: events.onBeforeRequest.api,
    onBeforeSendHeaders: events.onBeforeSendHeaders.api,
    onSendHeaders: events.onSendHeaders.api,
    onHeadersReceived: events.onHeadersReceived.api,
    onAuthRequired: events.onAuthRequired.api,
    onResponseStarted: events.onResponseStarted.api,
    onCompleted: events.onCompleted.api,
    onErrorOccurred: events.onErrorOccurred.api,
    onBeforeRedirect: events.onBeforeRedirect.api,
    onActionIgnored: events.onActionIgnored.api
  }

  return { api, events, handlerBehaviorChanged }
}

const streamOf = (
  webRequest: WebRequest.ChromeWebRequestService,
  name: EventName,
  tabId = 1
): Stream.Stream<{ readonly requestId: string }, ChromeWebRequestError> =>
  name === "onActionIgnored" ? webRequest.onActionIgnored : webRequest[name]({ urls: ["<all_urls>"], tabId })

const ids = (values: ReadonlyArray<{ readonly requestId: string }>) => values.map(({ requestId }) => requestId)

const newest = (count: number, total: number) => Array.from({ length: count }, (_, index) => String(total - count + index))

const range = (length: number) => Array.from({ length }, (_, index) => index)

describe("ChromeWebRequest stress: bursts", () => {
  it.effect.each(eventNames)("%s keeps exactly the newest 64 of 4,096 events fired during registration", (name) =>
    Effect.gen(function*() {
      const { api, events } = stressApi()
      const event = events[name]

      event.hooks.onAdd = (listener) => {
        for (let index = 0; index < 4096; index++) listener(details(index))
      }

      const values = yield* Stream.runCollect(Stream.take(streamOf(make(api), name), 64))
      expect(ids(values)).toStrictEqual(newest(64, 4096))
      expect(event.listeners.size).toBe(0)
      expect([event.added, event.removed]).toStrictEqual([1, 1])
    }))

  it.effect.each(eventNames)("%s keeps exactly the newest 64 of 4,096 events fired at a parked consumer", (name) =>
    Effect.gen(function*() {
      const { api, events } = stressApi()
      const event = events[name]
      const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(streamOf(make(api), name), 64)))
      yield* event.registration(name === "onActionIgnored" ? -1 : 1)

      for (let index = 0; index < 4096; index++) event.emitAll(details(index))

      expect(ids(yield* Fiber.join(fiber))).toStrictEqual(newest(64, 4096))
      expect(event.listeners.size).toBe(0)
      expect([event.added, event.removed]).toStrictEqual([1, 1])
    }))

  it.effect("keeps the newest 64 independently for 128 concurrent subscriptions to one event", () => Effect.gen(function*() {
    const { api, events } = stressApi()
    const webRequest = make(api)

    const fibers = yield* Effect.forEach(range(128), (tabId) =>
      Effect.forkChild(Stream.runCollect(Stream.take(webRequest.onCompleted({ urls: [], tabId }), 64))))

    yield* Effect.forEach(range(128), (tabId) => events.onCompleted.registration(tabId), { discard: true })
    expect(events.onCompleted.listeners.size).toBe(128)

    for (let index = 0; index < 4096; index++) events.onCompleted.emitAll(details(index))

    for (const fiber of fibers) expect(ids(yield* Fiber.join(fiber))).toStrictEqual(newest(64, 4096))

    expect(events.onCompleted.listeners.size).toBe(0)
    expect([events.onCompleted.added, events.onCompleted.removed]).toStrictEqual([128, 128])
  }))
})

type Stage = "beforeStart" | "registrationFailure" | "registered" | "midDelivery" | "completed" | "afterCompletion"

const stages: ReadonlyArray<Stage> = ["beforeStart", "registrationFailure", "registered", "midDelivery", "completed", "afterCompletion"]

describe("ChromeWebRequest stress: subscription churn", () => {
  it.effect("churns 512 concurrent subscriptions across every filtered event, interrupting at every stage, to zero listeners", () =>
    Effect.gen(function*() {
      const random = seeded(0x5eed)
      const { api, events } = stressApi()
      const webRequest = make(api)
      const outcomes = new Map<Stage, number>()
      const plan = range(512).map((tabId) => ({ tabId, name: pick(random, filteredNames), stage: pick(random, stages) }))

      // Chrome may dispatch to a listener while it is being removed; that must neither leak nor throw.
      for (const name of filteredNames) events[name].hooks.onRemove = (listener) => listener(details(-1))

      const churn = ({ tabId, name, stage }: typeof plan[number]) => Effect.gen(function*() {
        const event = events[name]
        const cause = new Error(`registration ${tabId} refused`)

        if (stage === "registrationFailure") event.failNext(tabId, cause)

        const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(streamOf(webRequest, name, tabId), 3)))

        switch (stage) {
          case "beforeStart": {
            yield* Fiber.interrupt(fiber)
            break
          }

          case "registrationFailure": {
            const exit = yield* Fiber.await(fiber)
            expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({ operation: name, cause })
            break
          }

          case "registered": {
            yield* event.registration(tabId)
            yield* Fiber.interrupt(fiber)
            break
          }

          case "midDelivery": {
            const listener = yield* event.registration(tabId)
            listener(details(1, tabId))
            listener(details(2, tabId))
            yield* Fiber.interrupt(fiber)
            listener(details(3, tabId))
            break
          }

          case "completed": {
            const listener = yield* event.registration(tabId)

            for (let index = 0; index < 5; index++) listener(details(index, tabId))

            expect(ids(yield* Fiber.join(fiber))).toStrictEqual(["0", "1", "2"])
            break
          }

          case "afterCompletion": {
            const listener = yield* event.registration(tabId)

            for (let index = 0; index < 3; index++) listener(details(index, tabId))

            yield* Fiber.await(fiber)
            listener(details(9, tabId))
            yield* Fiber.interrupt(fiber)
            break
          }
        }

        outcomes.set(stage, (outcomes.get(stage) ?? 0) + 1)
      })

      yield* Effect.forEach(plan, churn, { concurrency: "unbounded", discard: true })

      for (const name of filteredNames) {
        expect(events[name].listeners.size).toBe(0)
        expect(events[name].removed).toBe(events[name].added)
      }

      expect(new Set(outcomes.keys())).toStrictEqual(new Set(stages))
      expect(Array.from(outcomes.values()).reduce((total, count) => total + count, 0)).toBe(512)
    }))

  it.effect("churns 512 onActionIgnored subscriptions through a 4,096-event burst to zero listeners", () => Effect.gen(function*() {
    const random = seeded(0xac7)
    const { api, events } = stressApi()
    const event = events.onActionIgnored
    const webRequest = make(api)
    const fibers = yield* Effect.forEach(range(512), () => Effect.forkChild(Stream.runCollect(Stream.take(webRequest.onActionIgnored, 64))))
    const [early, late] = [fibers.slice(0, 128), fibers.slice(128)]
    yield* Effect.forEach(early, Fiber.interrupt, { discard: true })
    yield* event.waitForSize(384)
    const interrupted = shuffle(random, late).slice(0, 192)
    yield* Effect.forEach(interrupted, Fiber.interrupt, { discard: true })
    expect(event.listeners.size).toBe(192)

    for (let index = 0; index < 4096; index++) event.emitAll(details(index))

    const finished = late.filter((fiber) => !interrupted.includes(fiber))

    for (const fiber of finished) expect(ids(yield* Fiber.join(fiber))).toStrictEqual(newest(64, 4096))

    expect(event.listeners.size).toBe(0)
    expect(event.removed).toBe(event.added)
  }))
})

describe("ChromeWebRequest stress: concurrent calls", () => {
  it.effect("types 2,048 concurrent handlerBehaviorChanged calls with interleaved rejections and throws", () => Effect.gen(function*() {
    const random = seeded(0xca11)
    const { api, handlerBehaviorChanged } = stressApi()
    const webRequest = make(api)
    const settle: Array<() => void> = []
    const planned = new Map<Error, "rejected" | "thrown">()
    const allCalled = Deferred.makeUnsafe<void>()
    let calls = 0

    handlerBehaviorChanged.mockImplementation(() => {
      const call = ++calls
      const outcome = pick(random, ["resolved", "rejected", "thrown"] as const)
      const cause = new Error(`call ${call} ${outcome}`)
      // Signal the last call only once its outcome is recorded: completing the Deferred may
      // run the waiting test fiber before this call returns.
      const signal = () => { if (call === 2048) Deferred.doneUnsafe(allCalled, Exit.void) }

      if (outcome === "thrown") {
        planned.set(cause, "thrown")
        signal()
        throw cause
      }

      if (outcome === "rejected") planned.set(cause, "rejected")

      const promise = new Promise<void>((resolve, reject) => {
        settle.push(() => outcome === "rejected" ? reject(cause) : resolve())
      })

      signal()

      return promise
    })

    const fiber = yield* Effect.forkChild(Effect.forEach(range(2048), () => Effect.exit(webRequest.handlerBehaviorChanged), { concurrency: "unbounded" }))
    yield* Deferred.await(allCalled)

    for (const run of shuffle(random, settle)) run()

    const exits = yield* Fiber.join(fiber)
    const failures = exits.flatMap((exit) => Exit.isFailure(exit) ? [exit.cause] : [])
    expect(exits).toHaveLength(2048)
    expect(failures).toHaveLength(planned.size)
    expect(exits.length - failures.length).toBeGreaterThan(0)
    const seen = new Set<unknown>()

    for (const cause of failures) {
      expect(Cause.hasDies(cause) || Cause.hasInterrupts(cause)).toBe(false)
      const error = Cause.squash(cause)
      expect(error).toBeInstanceOf(ChromeWebRequestError)
      expect(error).toMatchObject({ operation: "handlerBehaviorChanged" })

      if (error instanceof ChromeWebRequestError) seen.add(error.cause)
    }

    expect(seen).toStrictEqual(new Set(planned.keys()))
    expect(new Set(planned.values())).toStrictEqual(new Set(["rejected", "thrown"]))
    expect(handlerBehaviorChanged).toHaveBeenCalledTimes(2048)
  }))
})

type Behaviour = "credentials" | "cancel" | "none" | "dies" | "interrupts" | "throws" | "pending"

const behaviours: ReadonlyArray<Behaviour> = ["credentials", "cancel", "none", "dies", "interrupts", "throws", "pending"]

/** What Chrome receives for a behaviour, once it settles or its scope closes. */
const expectedAnswer = (behaviour: Behaviour, index: number): chrome.webRequest.BlockingResponse => {
  if (behaviour === "credentials") return { authCredentials: { username: `user-${index}`, password: "pw" } }

  return behaviour === "cancel" ? { cancel: true } : {}
}

const required = <K, V>(map: ReadonlyMap<K, V>, key: K): V => {
  const value = map.get(key)

  if (value === undefined) throw new Error(`missing entry ${String(key)}`)

  return value
}

describe("ChromeWebRequest stress: authentication", () => {
  it.effect("answers 1,024 concurrent challenges exactly once each, released in seeded order", () => Effect.gen(function*() {
    const random = seeded(0xa17)
    const { api, events } = stressApi()
    const plan = range(1024).map((index) => ({ index, behaviour: pick(random, behaviours) }))
    const behaviourOf = new Map(plan.map(({ index, behaviour }) => [String(index), behaviour]))
    const gates = new Map(plan.map(({ index }) => [String(index), Deferred.makeUnsafe<void>()]))
    const started = new Map(plan.map(({ index }) => [String(index), Deferred.makeUnsafe<void>()]))
    const done = new Map(plan.map(({ index }) => [String(index), Deferred.makeUnsafe<void>()]))

    const answer = (challenge: WebRequest.AuthRequired): Effect.Effect<WebRequest.AuthAnswer> => {
      const behaviour = required(behaviourOf, challenge.requestId)
      const index = Number(challenge.requestId)

      if (behaviour === "throws") throw new Error(`answer ${index} threw`)

      const outcome = Effect.suspend((): Effect.Effect<WebRequest.AuthAnswer> => {
        if (behaviour === "dies") return Effect.die(new Error(`answer ${index} died`))

        if (behaviour === "interrupts") return Effect.interrupt

        return behaviour === "pending" ? Effect.never : Effect.succeed(expectedAnswer(behaviour, index))
      })

      return Deferred.succeed(required(started, challenge.requestId), undefined).pipe(
        Effect.andThen(Deferred.await(required(gates, challenge.requestId))),
        Effect.andThen(outcome)
      )
    }

    const scope = yield* Scope.make()
    yield* make(api).answerAuthRequired({ urls: ["<all_urls>"] }, answer).pipe(Scope.provide(scope))
    const listener = yield* events.onAuthRequired.registration(-1)
    const answers = new Map(plan.map(({ index }) => [String(index), vi.fn((_response: chrome.webRequest.BlockingResponse) => {})]))

    for (const { index } of plan) {
      const requestId = String(index)

      listener(details(index), (response) => {
        required(answers, requestId)(response)
        Deferred.doneUnsafe(required(done, requestId), Exit.void)
      })
    }

    const running = plan.filter(({ behaviour }) => behaviour !== "throws")
    yield* Effect.forEach(running, ({ index }) => Deferred.await(required(started, String(index))), { discard: true })

    for (const { index } of shuffle(random, running)) yield* Deferred.succeed(required(gates, String(index)), undefined)

    const settling = plan.filter(({ behaviour }) => behaviour !== "pending")
    yield* Effect.forEach(settling, ({ index }) => Deferred.await(required(done, String(index))), { discard: true })

    for (const { index, behaviour } of plan) {
      const expected = behaviour === "pending" ? [] : [[expectedAnswer(behaviour, index)]]
      expect(required(answers, String(index)).mock.calls).toStrictEqual(expected)
    }

    yield* Scope.close(scope, Exit.void)

    for (const { index, behaviour } of plan) {
      expect(required(answers, String(index)).mock.calls).toStrictEqual([[expectedAnswer(behaviour, index)]])
    }

    expect(new Set(plan.map(({ behaviour }) => behaviour))).toStrictEqual(new Set(behaviours))
    expect(events.onAuthRequired.listeners.size).toBe(0)
  }))

  it.effect("releases each of 1,024 challenges' resources once answered while the registration stays open", () => Effect.gen(function*() {
    const random = seeded(0x5c0)
    const { api, events } = stressApi()
    const held = new Set<string>()
    const plan = range(1024).map((index) => ({ index, gate: Deferred.makeUnsafe<void>(), done: Deferred.makeUnsafe<void>() }))
    const steps = new Map(plan.map((entry) => [String(entry.index), entry]))

    const answer = (challenge: WebRequest.AuthRequired) => {
      const step = required(steps, challenge.requestId)

      return Effect.acquireRelease(
        Effect.sync(() => { held.add(challenge.requestId) }),
        () => Effect.sync(() => {
          held.delete(challenge.requestId)
          Deferred.doneUnsafe(step.done, Exit.void)
        })
      ).pipe(Effect.andThen(Deferred.await(step.gate)), Effect.as({ cancel: true }))
    }

    const scope = yield* Scope.make()
    yield* make(api).answerAuthRequired({ urls: ["<all_urls>"] }, answer).pipe(Scope.provide(scope))
    const listener = yield* events.onAuthRequired.registration(-1)
    const answered = vi.fn((_response: chrome.webRequest.BlockingResponse) => {})

    for (const { index } of plan) listener(details(index), answered)

    const released = shuffle(random, plan).slice(0, 768)

    for (const { gate } of released) yield* Deferred.succeed(gate, undefined)

    yield* Effect.forEach(released, ({ done }) => Deferred.await(done), { discard: true })
    expect(answered).toHaveBeenCalledTimes(768)
    expect(held.size).toBe(256)
    yield* Scope.close(scope, Exit.void)
    expect(held.size).toBe(0)
    expect(answered.mock.calls.slice(768)).toStrictEqual(range(256).map(() => [{}]))
  }))

  it.effect("keeps 256 concurrent registrations independent while their scopes close in seeded order", () => Effect.gen(function*() {
    const random = seeded(0x256)
    const { api, events } = stressApi()
    const webRequest = make(api)

    const registrations = yield* Effect.forEach(range(256), (tabId) => Effect.gen(function*() {
      const scope = yield* Scope.make()
      const answer = () => Effect.succeed({ authCredentials: { username: `registration-${tabId}`, password: "pw" } })
      yield* webRequest.answerAuthRequired({ urls: [], tabId }, answer).pipe(Scope.provide(scope))

      return { tabId, scope }
    }), { concurrency: "unbounded" })

    expect(events.onAuthRequired.listeners.size).toBe(256)
    const open = new Set(registrations.map(({ tabId }) => `registration-${tabId}`))

    for (const [round, closing] of shuffle(random, registrations).entries()) {
      const received: Array<string> = []
      const answered = Deferred.makeUnsafe<void>()

      events.onAuthRequired.emitAll(details(round), (response) => {
        received.push(response.authCredentials?.username ?? "none")

        if (received.length === open.size) Deferred.doneUnsafe(answered, Exit.void)
      })

      yield* Deferred.await(answered)
      expect(new Set(received)).toStrictEqual(open)
      yield* Scope.close(closing.scope, Exit.void)
      open.delete(`registration-${closing.tabId}`)
      expect(events.onAuthRequired.listeners.size).toBe(open.size)
    }

    expect(events.onAuthRequired.removed).toBe(256)
  }))

  it.effect("interrupts 512 scoped registrations at every stage without leaking listeners or unanswered challenges", () =>
    Effect.gen(function*() {
      const random = seeded(0x1a7e)
      const { api, events } = stressApi()
      const webRequest = make(api)
      const callbacks: Array<ReturnType<typeof vi.fn<(response: chrome.webRequest.BlockingResponse) => void>>> = []
      const stagesOf = ["beforeStart", "registered", "pendingChallenges"] as const
      const reached = new Set<string>()

      const run = (tabId: number) => Effect.gen(function*() {
        const stage = pick(random, stagesOf)
        const started = Deferred.makeUnsafe<void>()
        const answer = () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
        const fiber = yield* Effect.forkChild(Effect.scoped(Effect.andThen(webRequest.answerAuthRequired({ urls: [], tabId }, answer), Effect.never)))
        reached.add(stage)

        if (stage === "beforeStart") return yield* Fiber.interrupt(fiber)

        const listener = yield* events.onAuthRequired.registration(tabId)

        if (stage === "pendingChallenges") {
          const callback = vi.fn((_response: chrome.webRequest.BlockingResponse) => {})
          callbacks.push(callback)
          listener(details(tabId, tabId), callback)
          yield* Deferred.await(started)
          expect(callback).not.toHaveBeenCalled()
        }

        yield* Fiber.interrupt(fiber)
      })

      yield* Effect.forEach(range(512), run, { concurrency: "unbounded", discard: true })
      expect(reached).toStrictEqual(new Set(stagesOf))
      expect(events.onAuthRequired.listeners.size).toBe(0)
      expect(events.onAuthRequired.removed).toBe(events.onAuthRequired.added)
      expect(callbacks.length).toBeGreaterThan(0)

      for (const callback of callbacks) expect(callback.mock.calls).toStrictEqual([[{}]])
    }))
})

describe("ChromeWebRequest stress: fixture populations", () => {
  it.effect("routes 1,024 filtered fixture listeners across 512 requests exactly as their filters say", () => Effect.gen(function*() {
    const fixture = makeWebRequest()
    const webRequest = make(fixture.api)
    const hosts = ["a", "b", "c", "d"] as const
    const hostOf = (index: number) => hosts[index % 4] ?? "a"

    // Subscription i listens to tab i % 16 on host i % 4, asking for headers on odd subscriptions.
    const fibers = yield* Effect.forEach(range(1024), (index) => {
      const filter = { urls: [`https://${hostOf(index)}.example/*`], tabId: index % 16 }
      const stream = index % 2 === 0 ? webRequest.onCompleted(filter) : webRequest.onCompleted(filter, ["responseHeaders"])

      return Effect.forkChild(Stream.runCollect(Stream.take(stream, 8)))
    })

    yield* Effect.promise(() => fixture.controls.onCompleted.waitForListener(1024))

    // Request r goes to tab r % 16 on host (r >> 4) % 4, so each (tab, host) pair gets 8 of the 512.
    for (const request of range(512)) {
      fixture.controls.request({
        url: `https://${hostOf(request >> 4)}.example/${request}`, tabId: request % 16,
        response: { responseHeaders: [{ name: "x-request", value: String(request) }] }
      })
    }

    for (const [index, fiber] of fibers.entries()) {
      const received = yield* Fiber.join(fiber)
      const expected = range(512).filter((request) => request % 16 === index % 16 && (request >> 4) % 4 === index % 4)
      expect(received.map((completed) => completed.url)).toStrictEqual(expected.map((request) => `https://${hostOf(index)}.example/${request}`))
      expect(received.every((completed) => ("responseHeaders" in completed) === (index % 2 === 1))).toBe(true)
    }

    expect(fixture.controls.onCompleted.listenerCount).toBe(0)
  }))

  it("settles 1,024 fixture challenges across 64 asyncBlocking listeners removed in seeded order", async () => {
    const random = seeded(0xf17)
    const fixture = makeWebRequest()

    const listeners = range(64).map((index) => (_details: WebRequest.AuthRequired, asyncCallback?: WebRequest.AuthCallback) => {
      if (index % 2 === 0) asyncCallback?.({ cancel: true })
    })

    for (const listener of listeners) fixture.api.onAuthRequired.addListener(listener, { urls: [] }, ["asyncBlocking"])

    const pending = range(1024).map((index) => fixture.controls.onAuthRequired.challenge({ ...details(index), realm: "r" }))
    expect(fixture.controls.onAuthRequired.pendingChallenges).toBe(1024 * 32)

    for (const listener of shuffle(random, listeners)) fixture.api.onAuthRequired.removeListener(listener)

    const answers = await Promise.all(pending)
    expect(fixture.controls.onAuthRequired.pendingChallenges).toBe(0)

    for (const answer of answers) expect(answer).toStrictEqual(range(64).map((index) => index % 2 === 0 ? { cancel: true } : {}))
  })
})
