// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
// chrome.scripting has no events, so there are no bursts or subscription churn to stress here;
// these cases stress concurrent calls, interruption, scoped registrations and the fixture.
import { Deferred, Effect, Exit, Fiber, Option } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChromeScriptingError, make } from "../../src/ChromeScripting.js"
import type {
  ChromeScriptingApi, ChromeScriptingService, ContentScriptFilter, ContentScriptRegistration, ContentScriptUpdate, CSSInjection,
  InjectionResult, RegisteredContentScript
} from "../../src/ChromeScripting.js"
import { makeScripting } from "../../src/testing/Scripting.js"
import type { ScriptingFrame, ScriptingOperation } from "../../src/testing/Scripting.js"

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

const operations: ReadonlyArray<ScriptingOperation> = [
  "executeScript", "insertCSS", "removeCSS", "registerContentScripts", "getRegisteredContentScripts", "updateContentScripts", "unregisterContentScripts"
]

/** Values a successful call yields: the per-frame results or listed scripts, nothing for writers. */
type Outcome = Option.Option<Array<InjectionResult<number>> | Array<RegisteredContentScript>>

const idOf = (index: number) => `script-${index}`

const indexOfId = (id: string | undefined) => Number((id ?? "").slice("script-".length))

/** Calls `operation` with arguments that carry `index`, so the native side can find its plan. */
const call = (service: ChromeScriptingService, operation: ScriptingOperation, index: number): Effect.Effect<Outcome, ChromeScriptingError> => {
  const css: CSSInjection = { target: { tabId: index }, css: `#n${index} {}` }

  switch (operation) {
    case "executeScript": return Effect.asSome(service.executeScript({ target: { tabId: index }, func: (value: number) => value, args: [index] }))
    case "insertCSS": return Effect.as(service.insertCSS(css), Option.none())
    case "removeCSS": return Effect.as(service.removeCSS(css), Option.none())
    case "registerContentScripts": return Effect.as(service.registerContentScripts([{ id: idOf(index), matches: ["<all_urls>"], js: ["a.js"] }]), Option.none())
    case "getRegisteredContentScripts": return Effect.asSome(service.getRegisteredContentScripts({ ids: [idOf(index)] }))
    case "updateContentScripts": return Effect.as(service.updateContentScripts([{ id: idOf(index) }]), Option.none())
    case "unregisterContentScripts": return Effect.as(service.unregisterContentScripts({ ids: [idOf(index)] }), Option.none())
  }
}

type Kind = "resolve" | "reject" | "throw"

interface Plan {
  readonly operation: ScriptingOperation
  readonly kind: Kind
  readonly cause: Error
  readonly frames: Array<InjectionResult<number>>
  readonly scripts: Array<RegisteredContentScript>
}

const planFor = (index: number, operation: ScriptingOperation, kind: Kind): Plan => ({
  operation,
  kind,
  cause: new Error(`${operation} #${index} ${kind}`),
  frames: [{ frameId: 0, documentId: `document-${index}`, result: index }],
  scripts: [{ id: idOf(index), matches: ["<all_urls>"], js: ["a.js"] }]
})

const pick = <A>(items: ReadonlyArray<A>, random: () => number, fallback: A): A => items[Math.floor(random() * items.length)] ?? fallback

const plansFor = (count: number, random: () => number, kinds: ReadonlyArray<Kind> = ["resolve", "reject", "throw"]): Array<Plan> =>
  Array.from({ length: count }, (_, index) => planFor(index, pick(operations, random, "executeScript"), pick(kinds, random, "resolve")))

/** The value a resolved plan's call yields through the service. */
const expected = (plan: Plan): Outcome => {
  switch (plan.operation) {
    case "executeScript": return Option.some(plan.frames)
    case "getRegisteredContentScripts": return Option.some(plan.scripts)
    default: return Option.none()
  }
}

/**
 * A native API that looks up each call's plan by the index its arguments carry: it throws at
 * once, or holds the settlement until `release`, which applies them in a seeded order.
 */
const plannedApi = (plans: ReadonlyArray<Plan>, random: () => number) => {
  const held: Array<() => void> = []
  const seen: Array<number> = []
  const waiters: Array<{ readonly count: number; readonly open: () => void }> = []

  const arrive = (index: number) => {
    seen.push(index)

    for (const waiter of waiters.filter((candidate) => candidate.count <= seen.length)) {
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.open()
    }
  }

  const settle = <A>(operation: ScriptingOperation, index: number, value: (plan: Plan) => A): Promise<A> => {
    const plan = plans[index]
    arrive(index)

    if (plan === undefined || plan.operation !== operation) throw new Error(`unplanned ${operation} #${index}`)

    if (plan.kind === "throw") throw plan.cause

    return new Promise<A>((resolve, reject) => {
      held.push(() => plan.kind === "resolve" ? resolve(value(plan)) : reject(plan.cause))
    })
  }

  const api: ChromeScriptingApi = {
    executeScript: <Args extends Array<unknown>, Result>(injection: chrome.scripting.ScriptInjection<Args, Result>) =>
      // SAFETY: every planned executeScript injects `(value: number) => value`, so its awaited result is a number.
      settle("executeScript", injection.target.tabId, (plan) => plan.frames) as Promise<Array<InjectionResult<Awaited<Result>>>>,
    insertCSS: (injection) => settle("insertCSS", injection.target.tabId, () => {}),
    removeCSS: (injection) => settle("removeCSS", injection.target.tabId, () => {}),
    registerContentScripts: (scripts) => settle("registerContentScripts", indexOfId(scripts[0]?.id), () => {}),
    getRegisteredContentScripts: (filter?: ContentScriptFilter) => settle("getRegisteredContentScripts", indexOfId(filter?.ids?.[0]), (plan) => plan.scripts),
    updateContentScripts: (scripts: Array<ContentScriptUpdate>) => settle("updateContentScripts", indexOfId(scripts[0]?.id), () => {}),
    unregisterContentScripts: (filter?: ContentScriptFilter) => settle("unregisterContentScripts", indexOfId(filter?.ids?.[0]), () => {})
  }

  return {
    api,
    /** The indices of the calls that reached Chrome, in arrival order. */
    seen,
    /** Resolves once `count` calls have reached Chrome. */
    arrived: (count: number) => new Promise<void>((open) => {
      if (seen.length >= count) open()
      else waiters.push({ count, open })
    }),
    pending: () => held.length,
    release: () => {
      for (const settleNext of shuffled(held, random)) settleNext()
      held.length = 0
    }
  }
}

/** Asserts that `exit` is what `plan` makes the call produce. */
const expectPlanned = (exit: Exit.Exit<Outcome, ChromeScriptingError>, plan: Plan) => {
  if (plan.kind === "resolve") {
    expect(exit).toEqual(Exit.succeed(expected(plan)))

    return
  }

  const error = Exit.findErrorOption(exit)
  expect(Option.isSome(error)).toBe(true)

  if (Option.isNone(error)) return

  expect(error.value).toBeInstanceOf(ChromeScriptingError)
  expect(error.value.operation).toBe(plan.operation)
  expect(error.value.cause).toBe(plan.cause)
}

describe("ChromeScripting stress", () => {
  it.effect("settles 2,048 concurrent calls with interleaved rejections and throws, each with its own typed error", () => Effect.gen(function*() {
    const random = seeded(0x5C21)
    const plans = plansFor(2048, random)
    const native = plannedApi(plans, random)
    const service = make(native.api)
    const fiber = yield* Effect.forkChild(Effect.forEach(plans, (plan, index) => Effect.exit(call(service, plan.operation, index)), { concurrency: "unbounded" }))
    yield* Effect.promise(() => native.arrived(plans.length))
    expect(native.pending()).toBe(plans.filter((plan) => plan.kind !== "throw").length)
    native.release()
    const exits = yield* Fiber.join(fiber)

    for (const [index, exit] of exits.entries()) {
      const plan = plans[index]

      if (plan === undefined) throw new Error(`missing plan #${index}`)

      expectPlanned(exit, plan)
    }

    expect([...native.seen].sort((left, right) => left - right)).toEqual(plans.map((_, index) => index))

    for (const operation of operations) expect(plans.filter((plan) => plan.operation === operation).length).toBeGreaterThan(200)

    for (const kind of ["resolve", "reject", "throw"] as const) expect(plans.filter((plan) => plan.kind === kind).length).toBeGreaterThan(600)
  }))

  it.effect("interrupts 512 calls before, during and after their native call", () => Effect.gen(function*() {
    const random = seeded(0xC0FFEE)
    const stages = Array.from({ length: 512 }, () => pick(["before", "pending", "settled"] as const, random, "before"))

    // A pending call must still be waiting on Chrome, so only settled calls may throw.
    const plans = stages.map((stage, index) =>
      planFor(index, pick(operations, random, "executeScript"), pick(stage === "settled" ? ["resolve", "reject", "throw"] : ["resolve", "reject"], random, "resolve")))

    const native = plannedApi(plans, random)
    const service = make(native.api)
    const gates = yield* Effect.forEach(plans, () => Deferred.make<void>())

    const fibers = yield* Effect.forEach(plans, (plan, index) => Effect.forkChild(Effect.andThen(
      Deferred.await(gates[index] ?? Deferred.makeUnsafe<void>()),
      call(service, plan.operation, index)
    )))

    const at = (stage: (typeof stages)[number]) => fibers.filter((_, index) => stages[index] === stage)
    const started = stages.filter((stage) => stage !== "before").length

    // Interrupted before the call: Chrome never sees it.
    yield* Fiber.interruptAll(at("before"))
    expect(native.seen).toEqual([])

    for (const [index, gate] of gates.entries()) {
      if (stages[index] !== "before") yield* Deferred.succeed(gate, undefined)
    }

    yield* Effect.promise(() => native.arrived(started))

    // Interrupted while Chrome holds the call: the fiber ends at once, the settlement is dropped.
    yield* Fiber.interruptAll(at("pending"))
    native.release()
    expect(native.pending()).toBe(0)

    for (const [index, fiber] of fibers.entries()) {
      const exit = yield* Fiber.await(fiber)
      const plan = plans[index]

      if (plan === undefined) throw new Error(`missing plan #${index}`)

      if (stages[index] === "settled") {
        expectPlanned(exit, plan)
        // Interrupting a finished call changes nothing.
        yield* Fiber.interrupt(fiber)
        expect(yield* Fiber.await(fiber)).toBe(exit)
      } else {
        expect(Exit.hasInterrupts(exit)).toBe(true)
      }
    }

    const reached = new Set(native.seen)
    expect(stages.every((stage, index) => reached.has(index) === (stage !== "before"))).toBe(true)

    for (const stage of ["before", "pending", "settled"] as const) expect(at(stage).length).toBeGreaterThan(140)
  }))

  it.effect("replays one Effect 4,096 times, keeping results, empty arrays and failures distinct", () => Effect.gen(function*() {
    const results: Array<Array<InjectionResult<unknown>>> = []
    const failures = ["Host permission revoked", "No tab with id: 17.", "Frame 4 disappeared", "Unserializable argument passed."]
    let calls = 0

    const api: ChromeScriptingApi = {
      ...makeScripting().api,
      executeScript: async <Args extends Array<unknown>, Result>(_injection: chrome.scripting.ScriptInjection<Args, Result>) => {
        const index = calls
        calls += 1

        if (index % 1024 === 1023) throw new Error(failures[Math.floor(index / 1024)])

        const frames: Array<InjectionResult<Awaited<Result>>> = index % 2 === 0 ? [] : [{ frameId: 0, documentId: "main" }, { frameId: 4, documentId: "child" }]
        results.push(frames)

        return frames
      }
    }

    const effect = make(api).executeScript({ target: { tabId: 17, frameIds: [0, 4] }, files: ["packaged.js"] })
    let successes = 0

    for (let index = 0; index < 4096; index++) {
      const exit = yield* Effect.exit(effect)

      if (index % 1024 === 1023) {
        expect(Exit.findErrorOption(exit)).toEqual(Option.some(new ChromeScriptingError({ operation: "executeScript", cause: new Error(failures[Math.floor(index / 1024)]) })))
      } else {
        expect(Exit.isSuccess(exit) && exit.value === results[successes]).toBe(true)
        successes += 1
      }
    }

    expect(calls).toBe(4096)
    expect(successes).toBe(4092)
  }))
})

const byText = (left: string | undefined, right: string | undefined) => (left ?? "").localeCompare(right ?? "")

const scriptFor = (id: string): ContentScriptRegistration => ({ id, matches: ["<all_urls>"], js: ["a.js"] })

const errorMessage = (exit: Exit.Exit<void, ChromeScriptingError>): string | undefined => {
  const error = Exit.findErrorOption(exit)

  return Option.isSome(error) && error.value.cause instanceof Error ? error.value.cause.message : undefined
}

describe("makeScripting stress", () => {
  it.effect("registers 4,096 scripts in 64 concurrent batches, then lists, filters and unregisters them", () => Effect.gen(function*() {
    const fixture = makeScripting()
    fixture.controls.addFile("a.js")
    const service = make(fixture.api)
    const batches = Array.from({ length: 64 }, (_, batch) => Array.from({ length: 64 }, (_, item) => scriptFor(`b${batch}-s${item}`)))
    yield* Effect.forEach(batches, (batch) => service.registerContentScripts(batch), { concurrency: "unbounded", discard: true })
    const listed = yield* service.getRegisteredContentScripts()
    expect(listed.length).toBe(4096)
    expect(listed.map((script) => script.id)).toEqual(batches.flat().map((script) => script.id))
    expect(fixture.controls.pending()).toEqual([])

    const random = seeded(42)
    const wanted = shuffled(listed.map((script) => script.id), random).slice(0, 512)
    expect((yield* service.getRegisteredContentScripts({ ids: wanted })).map((script) => script.id).sort(byText)).toEqual([...wanted].sort(byText))

    // An invalid batch at the end of a large registration leaves everything as it was.
    const invalid = yield* Effect.exit(service.registerContentScripts([...Array.from({ length: 1024 }, (_, item) => scriptFor(`late-${item}`)), scriptFor("b0-s0")]))
    expect(errorMessage(invalid)).toBe("Duplicate script ID 'b0-s0'")
    expect(fixture.controls.scripts().length).toBe(4096)

    yield* Effect.forEach(batches, (batch) =>
      service.unregisterContentScripts({ ids: batch.map((script) => script.id) }), { concurrency: "unbounded", discard: true })
    expect(fixture.controls.scripts()).toEqual([])
  }))

  it.effect("lets exactly one of two racing registrations, updates and unregistrations of each id win", () => Effect.gen(function*() {
    const fixture = makeScripting()
    fixture.controls.addFile("a.js")
    fixture.controls.addFile("b.js")
    const service = make(fixture.api)
    const random = seeded(7)
    const ids = Array.from({ length: 256 }, (_, index) => `racer-${index}`)
    const twice = shuffled([...ids, ...ids], random)

    const registered = yield* Effect.forEach(twice, (id) => Effect.exit(service.registerContentScripts([scriptFor(id)])), { concurrency: "unbounded" })
    expect(registered.filter(Exit.isSuccess).length).toBe(256)
    expect(registered.filter(Exit.isFailure).map(errorMessage).sort(byText)).toEqual(ids.map((id) => `Duplicate script ID '${id}'`).sort(byText))
    expect(fixture.controls.scripts().length).toBe(256)

    // Concurrent updates of one id: the second one meets the first one's reservation.
    const updated = yield* Effect.forEach(twice, (id) => Effect.exit(service.updateContentScripts([{ id, js: ["b.js"] }])), { concurrency: "unbounded" })
    expect(updated.filter(Exit.isSuccess).length).toBe(256)
    expect(updated.filter(Exit.isFailure).map(errorMessage).sort(byText)).toEqual(ids.map((id) => `Duplicate script ID '${id}'`).sort(byText))
    expect(fixture.controls.scripts().every((script) => script.js?.[0] === "b.js")).toBe(true)

    const unregistered = yield* Effect.forEach(twice, (id) => Effect.exit(service.unregisterContentScripts({ ids: [id] })), { concurrency: "unbounded" })
    expect(unregistered.filter(Exit.isSuccess).length).toBe(256)
    expect(unregistered.filter(Exit.isFailure).map(errorMessage).sort(byText)).toEqual(ids.map((id) => `Nonexistent script ID '${id}'`).sort(byText))
    expect(fixture.controls.scripts()).toEqual([])
  }))

  it.effect("an empty ids filter racing 512 targeted removals clears every script, as Chrome does", () => Effect.gen(function*() {
    const fixture = makeScripting()
    fixture.controls.addFile("a.js")
    const service = make(fixture.api)
    const ids = Array.from({ length: 512 }, (_, index) => `owned-${index}`)
    yield* service.registerContentScripts(ids.map(scriptFor))
    const random = seeded(11)
    const filters = shuffled([...ids.map((id): ContentScriptFilter => ({ ids: [id] })), { ids: [] }], random)
    const exits = yield* Effect.forEach(filters, (filter) => Effect.exit(service.unregisterContentScripts(filter)), { concurrency: "unbounded" })
    const wipe = filters.findIndex((filter) => filter.ids?.length === 0)

    // Removals that ran before the wipe succeed; every later one finds its script gone.
    expect(exits.slice(0, wipe + 1).every(Exit.isSuccess)).toBe(true)
    expect(exits.slice(wipe + 1).map(errorMessage)).toEqual(filters.slice(wipe + 1).map((filter) => `Nonexistent script ID '${filter.ids?.[0] ?? ""}'`))
    expect(fixture.controls.scripts()).toEqual([])
  }))

  it.effect("keeps a registration Chrome already started even when its Effect is interrupted", () => Effect.gen(function*() {
    const fixture = makeScripting()
    fixture.controls.addFile("a.js")
    const native: Array<Promise<void>> = []

    const service = make({
      ...fixture.api,
      registerContentScripts: (scripts) => {
        const running = fixture.api.registerContentScripts(scripts)
        native.push(running)

        return running
      }
    })

    const held = fixture.controls.holdNext("registerContentScripts")
    const fiber = yield* Effect.forkChild(service.registerContentScripts([scriptFor("orphan")]))
    yield* Effect.promise(() => held.entered)
    yield* Fiber.interrupt(fiber)
    expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
    expect(fixture.controls.pending()).toEqual(["orphan"])
    // The reservation still blocks a second registration of the id.
    expect(errorMessage(yield* Effect.exit(service.registerContentScripts([scriptFor("orphan")])))).toBe("Duplicate script ID 'orphan'")
    held.release()
    // The interrupted call's native promise still settles, and successfully.
    yield* Effect.promise(() => native[0] ?? Promise.reject(new Error("never reached Chrome")))
    expect(native.length).toBe(2)
    expect(fixture.controls.scripts().map((script) => script.id)).toEqual(["orphan"])
  }))

  it.effect("cleans up 64 scoped registrations interrupted mid-acquire and mid-release", () => Effect.gen(function*() {
    const fixture = makeScripting()
    fixture.controls.addFile("a.js")
    const service = make(fixture.api)

    const owned = (id: string) => Effect.acquireRelease(
      service.registerContentScripts([scriptFor(id)]),
      () => Effect.orDie(service.unregisterContentScripts({ ids: [id] }))
    )

    for (let round = 0; round < 64; round++) {
      const acquiring = fixture.controls.holdNext("registerContentScripts")
      const id = `scoped-${round}`
      const fiber = yield* Effect.forkChild(Effect.scoped(Effect.andThen(owned(id), Effect.never)))
      yield* Effect.promise(() => acquiring.entered)
      // Acquisition is uninterruptible: the interrupt waits for Chrome, then the release runs.
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))
      acquiring.release()
      yield* Fiber.join(interrupting)
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
      expect(fixture.controls.scripts()).toEqual([])

      const releasing = fixture.controls.holdNext("unregisterContentScripts")
      const registered = yield* Deferred.make<void>()
      const second = yield* Effect.forkChild(Effect.scoped(Effect.andThen(owned(id), Effect.andThen(Deferred.succeed(registered, undefined), Effect.never))))
      yield* Deferred.await(registered)
      expect(fixture.controls.scripts().map((script) => script.id)).toEqual([id])
      const stopping = yield* Effect.forkChild(Fiber.interrupt(second))
      yield* Effect.promise(() => releasing.entered)
      // A second interrupt cannot cut the release short either.
      const again = yield* Effect.forkChild(Fiber.interrupt(second))
      expect(fixture.controls.scripts().map((script) => script.id)).toEqual([id])
      releasing.release()
      yield* Fiber.join(stopping)
      yield* Fiber.join(again)
      expect(fixture.controls.scripts()).toEqual([])
    }

    expect(fixture.controls.pending()).toEqual([])
  }))

  it.effect("injects 100 times into every frame of a 64-frame tab, leaving out frames it cannot reach", () => Effect.gen(function*() {
    const fixture = makeScripting()

    const frames: Array<ScriptingFrame> = Array.from({ length: 64 }, (_, index) => {
      const frameId = 63 - index
      const base = { frameId, documentId: `doc-${frameId}` }

      if (frameId % 9 === 8) return { ...base, url: "chrome://newtab" }

      return frameId % 13 === 12 ? { ...base, error: "Missing host permission" } : base
    })

    fixture.controls.setTab(1, frames)
    const service = make(fixture.api)
    const reachable = frames.filter((frame) => frame.url === undefined && frame.error === undefined)
    let evaluations = 0

    const results = yield* Effect.forEach(Array.from({ length: 100 }, (_, run) => run), (run) => service.executeScript({
      target: { tabId: 1, allFrames: true },
      func: (offset: number) => {
        evaluations += 1

        return (fixture.controls.evaluatingFrame()?.frameId ?? -1000) + offset
      },
      args: [run * 1000]
    }), { concurrency: "unbounded" })

    expect(evaluations).toBe(100 * reachable.length)

    for (const [run, perFrame] of results.entries()) {
      expect(perFrame[0]?.frameId).toBe(0)
      expect(perFrame.length).toBe(reachable.length)
      expect(perFrame.every((result) => result.result === result.frameId + run * 1000)).toBe(true)
      expect(new Set(perFrame.map((result) => result.documentId)).size).toBe(reachable.length)
    }
  }))

  it.effect("balances 4,096 concurrent CSS insertions and removals across frames and navigations", () => Effect.gen(function*() {
    const fixture = makeScripting()
    const frames = Array.from({ length: 16 }, (_, frameId) => ({ frameId, documentId: `doc-${frameId}` }))
    fixture.controls.setTab(1, frames)
    fixture.controls.setTab(2)
    const service = make(fixture.api)
    const random = seeded(99)

    const injections = Array.from({ length: 2048 }, (_, index): CSSInjection => ({
      target: { tabId: 1, frameIds: [index % 16] }, css: `.c${index % 32} {}`, origin: index % 3 === 0 ? "USER" : "AUTHOR"
    }))

    yield* Effect.forEach(shuffled(injections, random), service.insertCSS, { concurrency: "unbounded", discard: true })
    expect(fixture.controls.styles().length).toBe(2048)
    yield* Effect.forEach(shuffled(injections, random), service.removeCSS, { concurrency: "unbounded", discard: true })
    expect(fixture.controls.styles()).toEqual([])

    // Navigation drops a document's styles; removing them afterwards is Chrome's no-op.
    yield* Effect.forEach(injections, service.insertCSS, { concurrency: "unbounded", discard: true })
    yield* service.insertCSS({ target: { tabId: 2 }, css: "kept" })

    for (const frame of frames) fixture.controls.navigate(1, { frameId: frame.frameId, documentId: `${frame.documentId}-next` })

    expect(fixture.controls.styles()).toEqual([{ tabId: 2, frameId: 0, documentId: "document-2", origin: "AUTHOR", css: "kept" }])
    yield* Effect.forEach(injections, service.removeCSS, { concurrency: "unbounded", discard: true })
    expect(fixture.controls.styles().length).toBe(1)
  }))
})
