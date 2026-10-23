// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
// chrome.userScripts has no events, so there are no bursts or subscription churn to stress here;
// these cases stress concurrent calls, interruption and the stateful fixture instead.
import { Cause, Effect, Exit, Fiber, Option } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChromeUserScriptsError, make } from "../../src/ChromeUserScripts.js"
import type {
  ChromeUserScriptsApi, ChromeUserScriptsService, InjectionResult, RegisteredUserScript, UserScriptInjection,
  UserScriptRegistration, WorldProperties
} from "../../src/ChromeUserScripts.js"
import { accessOffMessage, makeUserScripts, maxWorlds } from "../../src/testing/UserScripts.js"
import type { FrameOutcome } from "../../src/testing/UserScripts.js"

/** mulberry32: the same interleaving on every run. */
const seeded = (seed: number) => {
  let state = seed >>> 0

  return (): number => {
    state = (state + 0x6D2B79F5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

const shuffled = <A>(items: ReadonlyArray<A>, random: () => number): Array<A> => {
  const copy = [...items]

  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    const current = copy[index]
    const swapped = copy[other]

    if (current === undefined || swapped === undefined) continue

    copy[index] = swapped
    copy[other] = current
  }

  return copy
}

/** A promise opened by a native call site once `count` calls have arrived. */
const countdown = (count: number) => {
  const state = { remaining: count, open: () => {} }
  const reached = new Promise<void>((resolve) => { state.open = resolve })

  return {
    reached,
    tick: () => {
      state.remaining -= 1

      if (state.remaining === 0) state.open()
    }
  }
}

type Operation =
  | "register" | "update" | "unregister" | "getScripts"
  | "configureWorld" | "getWorldConfigurations" | "resetWorldConfiguration" | "execute"

const operations: ReadonlyArray<Operation> = [
  "register", "update", "unregister", "getScripts", "configureWorld", "getWorldConfigurations", "resetWorldConfiguration", "execute"
]

const script: UserScriptRegistration = { id: "s", matches: ["https://example.com/*"], js: [{ code: "1" }] }

const injection: UserScriptInjection = { target: { tabId: 1 }, js: [{ code: "document.title" }] }

const scripts: Array<RegisteredUserScript> = [{ id: "listed" }]

const worlds: Array<WorldProperties> = [{ worldId: "w", messaging: true }]

const frames: Array<InjectionResult> = [{ frameId: 0, documentId: "top", result: "title" }]

/** What a successful call yields: the listed value for readers, nothing for writers. */
type Outcome = Option.Option<Array<RegisteredUserScript> | Array<WorldProperties> | Array<InjectionResult>>

const run = (service: ChromeUserScriptsService, operation: Operation): Effect.Effect<Outcome, ChromeUserScriptsError> => {
  switch (operation) {
    case "register": return Effect.as(service.register([script]), Option.none())
    case "update": return Effect.as(service.update([{ id: "s" }]), Option.none())
    case "unregister": return Effect.as(service.unregister({ ids: ["s"] }), Option.none())
    case "getScripts": return Effect.asSome(service.getScripts())
    case "configureWorld": return Effect.as(service.configureWorld({ messaging: true }), Option.none())
    case "getWorldConfigurations": return Effect.asSome(service.getWorldConfigurations)
    case "resetWorldConfiguration": return Effect.as(service.resetWorldConfiguration("w"), Option.none())
    case "execute": return Effect.asSome(service.execute(injection))
  }
}

const successOf = (operation: Operation): Outcome => {
  switch (operation) {
    case "getScripts": return Option.some(scripts)
    case "getWorldConfigurations": return Option.some(worlds)
    case "execute": return Option.some(frames)
    default: return Option.none()
  }
}

type Kind = "resolve" | "reject" | "throw"

interface Plan {
  readonly kind: Kind
  readonly cause: Error
}

/** Each call's outcome, drawn from a seeded generator so throws, rejections and successes interleave. */
const planFor = (count: number, random: () => number) => {
  const plans = new Map<Operation, Array<Plan>>()
  const order: Array<Operation> = []

  for (let index = 0; index < count; index++) {
    const operation = operations[index % operations.length] ?? "register"
    const roll = random()
    const kind: Kind = roll < 0.4 ? "resolve" : roll < 0.7 ? "reject" : "throw"
    const queue = plans.get(operation) ?? []
    queue.push({ kind, cause: new Error(`${operation} #${queue.length} ${kind}`) })
    plans.set(operation, queue)
    order.push(operation)
  }

  const all = Array.from(plans.values()).flat()

  return {
    order,
    /** Planned outcomes by operation, consumed in invocation order by `plannedApi`. */
    queues: new Map(Array.from(plans, ([operation, queue]) => [operation, [...queue]])),
    causes: new Map(Array.from(plans, ([operation, queue]) => [operation, queue.filter((plan) => plan.kind !== "resolve").map((plan) => plan.cause)])),
    throws: all.filter((plan) => plan.kind === "throw").length,
    rejections: all.filter((plan) => plan.kind === "reject").length
  }
}

/**
 * A native API whose members take the next planned outcome for their operation: a
 * synchronous throw at once, or a settlement held until `release`, which applies them in
 * a seeded order. `arrived` opens once every planned call has reached it.
 */
const plannedApi = (queues: Map<Operation, Array<Plan>>, count: number, random: () => number) => {
  const held: Array<() => void> = []
  const arrivals = countdown(count)

  const call = <A>(operation: Operation, value: A): Promise<A> => {
    const plan = queues.get(operation)?.shift()
    arrivals.tick()

    if (plan === undefined) throw new Error(`unplanned ${operation} call`)

    if (plan.kind === "throw") throw plan.cause

    return new Promise<A>((resolve, reject) => {
      held.push(() => plan.kind === "resolve" ? resolve(value) : reject(plan.cause))
    })
  }

  const api: ChromeUserScriptsApi = {
    register: () => call("register", undefined),
    update: () => call("update", undefined),
    unregister: () => call("unregister", undefined),
    getScripts: () => call("getScripts", scripts),
    configureWorld: () => call("configureWorld", undefined),
    getWorldConfigurations: () => call("getWorldConfigurations", worlds),
    resetWorldConfiguration: () => call("resetWorldConfiguration", undefined),
    execute: () => call("execute", frames)
  }

  return {
    api,
    arrived: Effect.promise(() => arrivals.reached),
    held: () => held.length,
    release: () => {
      for (const settle of shuffled(held.splice(0), random)) settle()
    }
  }
}

const failureOf = <A, E>(exit: Exit.Exit<A, E>): Option.Option<E> => Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()

const messageOf = (error: ChromeUserScriptsError): string => error.cause instanceof Error ? error.cause.message : String(error.cause)

const registration = (id: string): UserScriptRegistration => ({ id, matches: ["https://example.com/*"], js: [{ code: `"${id}"` }] })

describe("ChromeUserScripts stress", () => {
  it.effect("types 2,048 concurrent calls with interleaved rejections and throws by operation", () => Effect.gen(function*() {
    const random = seeded(0x5EED)
    const plan = planFor(2048, random)
    const native = plannedApi(plan.queues, plan.order.length, random)
    const service = make(native.api)
    const fiber = yield* Effect.forkChild(Effect.forEach(plan.order, (operation) => Effect.exit(run(service, operation)), { concurrency: "unbounded" }))

    // Every call reaches Chrome before anything settles, so all of them are in flight together.
    yield* native.arrived
    expect(native.held()).toBe(plan.order.length - plan.throws)
    native.release()
    const exits = yield* Fiber.join(fiber)
    const seen = new Set<unknown>()

    exits.forEach((exit, index) => {
      const operation = plan.order[index] ?? "register"
      const failure = failureOf(exit)

      if (Option.isNone(failure)) {
        expect(exit).toEqual(Exit.succeed(successOf(operation)))

        return
      }

      expect(failure.value).toBeInstanceOf(ChromeUserScriptsError)
      expect(failure.value.operation).toBe(operation)
      expect(plan.causes.get(operation)?.some((cause) => cause === failure.value.cause)).toBe(true)
      expect(seen.has(failure.value.cause)).toBe(false)
      seen.add(failure.value.cause)
    })

    expect(seen.size).toBe(plan.throws + plan.rejections)
    expect(exits.filter(Exit.isSuccess).length).toBe(plan.order.length - plan.throws - plan.rejections)
    expect(plan.throws).toBeGreaterThan(400)
    expect(plan.rejections).toBeGreaterThan(400)
  }))

  it.effect("answers 1,024 concurrent availability probes despite interleaved throws and rejections", () => Effect.gen(function*() {
    const random = seeded(0xA11)

    const kinds: Array<Kind> = Array.from({ length: 1024 }, () => {
      const roll = random()

      return roll < 0.34 ? "resolve" : roll < 0.67 ? "reject" : "throw"
    })

    const queues = new Map<Operation, Array<Plan>>([["getScripts", kinds.map((kind, index) => ({ kind, cause: new Error(`probe ${index}`) }))]])
    const native = plannedApi(queues, kinds.length, random)
    const service = make(native.api)
    const fiber = yield* Effect.forkChild(Effect.forEach(kinds, () => service.isAvailable, { concurrency: "unbounded" }))
    yield* native.arrived
    native.release()
    const answers = yield* Fiber.join(fiber)
    expect(answers.filter((available) => available).length).toBe(kinds.filter((kind) => kind === "resolve").length)
    expect(answers.length).toBe(1024)
  }))

  it.effect("interrupts 512 in-flight calls, then absorbs their late settlements", () => Effect.gen(function*() {
    const random = seeded(0x1A7)
    const count = 512

    const queues = new Map<Operation, Array<Plan>>(operations.map((operation) => [operation, Array.from({ length: count / operations.length }, (_, index) => ({
      kind: index % 2 === 0 ? "resolve" : "reject",
      cause: new Error(`late ${operation} ${index}`)
    }))]))

    const native = plannedApi(queues, count, random)
    const service = make(native.api)

    const fibers = yield* Effect.forEach(Array.from({ length: count }, (_, index) => operations[index % operations.length] ?? "register"),
      (operation) => Effect.forkChild(run(service, operation)))

    yield* native.arrived
    expect(native.held()).toBe(count)
    yield* Fiber.interruptAll(fibers)
    const exits = yield* Fiber.awaitAll(fibers)
    expect(exits.every((exit) => Exit.hasInterrupts(exit) && Option.isNone(failureOf(exit)))).toBe(true)
    // Chrome cannot cancel a started call; its outcome arrives later and must go nowhere.
    native.release()
    yield* Effect.promise(() => Promise.resolve())
    expect(native.held()).toBe(0)
    expect(yield* Fiber.awaitAll(fibers)).toEqual(exits)
  }))

  it.effect("races 512 settlements against interruption without losing or inventing outcomes", () => Effect.gen(function*() {
    const random = seeded(0xACE)
    const count = 512

    const queues = new Map<Operation, Array<Plan>>([["execute", Array.from({ length: count }, (_, index) => ({
      kind: index % 3 === 0 ? "reject" : "resolve",
      cause: new Error(`raced ${index}`)
    }))]])

    const native = plannedApi(queues, count, random)
    const service = make(native.api)
    const fibers = yield* Effect.forEach(Array.from({ length: count }), () => Effect.forkChild(service.execute(injection)))
    yield* native.arrived
    native.release()
    yield* Effect.forEach(fibers, (fiber, index) => index % 2 === 0 ? Fiber.interrupt(fiber) : Effect.void, { concurrency: "unbounded" })
    const exits = yield* Fiber.awaitAll(fibers)

    exits.forEach((exit, index) => {
      if (Exit.isSuccess(exit)) {
        expect(exit.value).toBe(frames)

        return
      }

      const failure = failureOf(exit)

      if (Option.isSome(failure)) {
        expect(failure.value.operation).toBe("execute")
        expect(messageOf(failure.value)).toMatch(/^raced \d+$/)

        return
      }

      // Only the fibers this test interrupted may end interrupted.
      expect(index % 2).toBe(0)
      expect(Exit.hasInterrupts(exit)).toBe(true)
    })

    expect(exits.filter((exit, index) => index % 2 === 1 && Exit.hasInterrupts(exit))).toEqual([])
  }))

  it.effect("registers 4,096 scripts in 64 concurrent batches, then churns them concurrently", () => Effect.gen(function*() {
    const fixture = makeUserScripts()
    const service = make(fixture.api)
    const batches = Array.from({ length: 64 }, (_, batch) => Array.from({ length: 64 }, (_, index) => registration(`b${batch}-s${index}`)))
    yield* Effect.forEach(batches, (batch) => service.register(batch), { concurrency: "unbounded" })
    const listed = yield* service.getScripts()
    expect(listed.length).toBe(4096)
    expect(new Set(listed.map(({ id }) => id)).size).toBe(4096)

    // Chrome registers a batch atomically, so each batch stays contiguous and in order.
    for (let start = 0; start < listed.length; start += 64) {
      const batch = listed.slice(start, start + 64).map(({ id }) => id)
      const prefix = batch[0]?.split("-")[0] ?? ""
      expect(batch).toEqual(Array.from({ length: 64 }, (_, index) => `${prefix}-s${index}`))
    }

    const churn = batches.map((batch, index) => index % 2 === 0
      ? service.unregister({ ids: batch.map(({ id }) => id) })
      : service.update(batch.map(({ id }) => ({ id, runAt: "document_start" }))))

    const readers = Array.from({ length: 256 }, () => service.getScripts({ ids: [batches[1]?.[0]?.id ?? "", batches[0]?.[0]?.id ?? ""] }))

    const [, snapshots] = yield* Effect.all([
      Effect.all(churn, { concurrency: "unbounded" }),
      Effect.all(readers, { concurrency: "unbounded" })
    ], { concurrency: "unbounded" })

    const remaining = yield* service.getScripts()
    expect(remaining.length).toBe(2048)
    expect(remaining.every(({ id, runAt }) => Number(id.slice(1).split("-")[0]) % 2 === 1 && runAt === "document_start")).toBe(true)
    expect(snapshots.every((snapshot) => snapshot.length >= 1 && snapshot.length <= 2)).toBe(true)
    yield* service.unregister()
    expect(fixture.controls.scripts()).toEqual([])
  }))

  it.effect("lets exactly one of 8 concurrent registrations of each of 64 ids win", () => Effect.gen(function*() {
    const fixture = makeUserScripts()
    const service = make(fixture.api)
    const random = seeded(0xD0B)
    const attempts = shuffled(Array.from({ length: 512 }, (_, index) => `id-${index % 64}`), random)
    const exits = yield* Effect.forEach(attempts, (id) => Effect.exit(service.register([registration(id)])), { concurrency: "unbounded" })
    expect(exits.filter(Exit.isSuccess).length).toBe(64)

    exits.forEach((exit, index) => {
      const failure = failureOf(exit)

      if (Option.isSome(failure)) {
        expect(failure.value.operation).toBe("register")
        expect(messageOf(failure.value)).toBe(`Duplicate script ID '${attempts[index]}'`)
      }
    })

    expect(fixture.controls.scripts().map(({ id }) => id).sort()).toEqual(Array.from({ length: 64 }, (_, index) => `id-${index}`).sort())
  }))

  it.effect("admits exactly the world limit from 256 concurrent configurations", () => Effect.gen(function*() {
    const fixture = makeUserScripts()
    const service = make(fixture.api)
    const limit = `You may only configure up to ${maxWorlds} individual user script worlds.`

    const exits = yield* Effect.forEach(Array.from({ length: 256 }, (_, index) => `world-${index}`),
      (worldId) => Effect.exit(service.configureWorld({ worldId, messaging: true })), { concurrency: "unbounded" })

    expect(exits.filter(Exit.isSuccess).length).toBe(maxWorlds)
    expect(exits.map(failureOf).filter(Option.isSome).map(({ value }) => [value.operation, messageOf(value)]))
      .toEqual(Array.from({ length: 256 - maxWorlds }, () => ["configureWorld", limit]))
    const configured = yield* service.getWorldConfigurations
    expect(configured.length).toBe(maxWorlds)
    yield* Effect.forEach(configured.slice(0, 50), ({ worldId }) => service.resetWorldConfiguration(worldId ?? ""), { concurrency: "unbounded" })

    const refilled = yield* Effect.forEach(Array.from({ length: 60 }, (_, index) => `refill-${index}`),
      (worldId) => Effect.exit(service.configureWorld({ worldId, csp: "script-src 'none'" })), { concurrency: "unbounded" })

    expect(refilled.filter(Exit.isSuccess).length).toBe(50)
    expect((yield* service.getWorldConfigurations).length).toBe(maxWorlds)
  }))

  it.effect("fails every call after access is revoked mid-burst of 1,024, and recovers", () => Effect.gen(function*() {
    const fixture = makeUserScripts()
    const state = { calls: 0 }

    const revoking: ChromeUserScriptsApi = {
      ...fixture.api,
      register: (batch) => {
        state.calls += 1

        // The user turns access off while the burst is in flight.
        if (state.calls === 513) fixture.controls.setAccess(false)

        return fixture.api.register(batch)
      }
    }

    const service = make(revoking)

    const exits = yield* Effect.forEach(Array.from({ length: 1024 }, (_, index) => registration(`r${index}`)),
      (script) => Effect.exit(service.register([script])), { concurrency: "unbounded" })

    const failures = exits.map(failureOf).filter(Option.isSome).map(({ value }) => value)
    expect(exits.filter(Exit.isSuccess).length).toBe(512)
    expect(failures.length).toBe(512)
    expect(failures.every((error) => error.operation === "register" && messageOf(error) === accessOffMessage)).toBe(true)
    expect(yield* service.isAvailable).toBe(false)
    expect(Exit.isFailure(yield* Effect.exit(service.getWorldConfigurations))).toBe(true)
    fixture.controls.setAccess(true)
    expect(yield* service.isAvailable).toBe(true)
    expect((yield* service.getScripts()).length).toBe(512)
  }))

  it.effect("shapes 1,024 concurrent executions over up to 1,024 frames each", () => Effect.gen(function*() {
    const fixture = makeUserScripts()
    const service = make(fixture.api)
    const random = seeded(0xF4A)
    const plans = new Map<number, Array<FrameOutcome>>()

    for (let tabId = 0; tabId < 1024; tabId++) {
      const size = tabId % 64 === 0 ? 1 : 1 + Math.floor(random() * (tabId === 1 ? 1024 : 16))

      const outcomes = shuffled(Array.from({ length: size }, (_, frameId): FrameOutcome => random() < 0.25
        ? { frameId, documentId: `d${tabId}-${frameId}`, error: `frame ${frameId} of ${tabId} failed` }
        : { frameId, documentId: `d${tabId}-${frameId}`, result: frameId * tabId }), random)

      plans.set(tabId, tabId === 1 ? Array.from({ length: 1024 }, (_, frameId) => ({ frameId, documentId: `big-${frameId}`, result: frameId })) : outcomes)
    }

    fixture.controls.respond(async ({ target }) => plans.get(target.tabId) ?? [])

    const exits = yield* Effect.forEach(Array.from(plans.keys()),
      (tabId) => Effect.exit(service.execute({ target: { tabId, allFrames: true }, js: [{ code: "1" }] })), { concurrency: "unbounded" })

    exits.forEach((exit, tabId) => {
      const outcomes = plans.get(tabId) ?? []
      const [only] = outcomes

      if (outcomes.length === 1 && only?.error !== undefined) {
        expect(Option.map(failureOf(exit), messageOf)).toEqual(Option.some(only.error))

        return
      }

      const kept = outcomes.filter((outcome) => outcome.error === undefined)
      const top = kept.filter((outcome) => outcome.frameId === 0)
      const rest = kept.filter((outcome) => outcome.frameId !== 0)
      expect(exit).toEqual(Exit.succeed([...top, ...rest].map(({ frameId, documentId, result }) => ({ frameId, documentId, result }))))
    })

    expect(exits[1]).toEqual(Exit.succeed(Array.from({ length: 1024 }, (_, frameId) => ({ frameId, documentId: `big-${frameId}`, result: frameId }))))
  }))
})
