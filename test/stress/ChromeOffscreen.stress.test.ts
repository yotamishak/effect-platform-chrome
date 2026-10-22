// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Deferred, Effect, Exit, Fiber, Option, Scope } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChromeOffscreenError, make } from "../../src/ChromeOffscreen.js"
import type { ChromeOffscreenApi, ChromeOffscreenService, CreateParameters } from "../../src/ChromeOffscreen.js"
import { makeOffscreen } from "../../src/testing/Offscreen.js"
import type { OffscreenHold } from "../../src/testing/Offscreen.js"

// chrome.offscreen has no events, so there are no bursts or subscriptions to churn here:
// the extremes are concurrent lifecycle calls, interruption at every stage of a scoped
// document, races between operations and between contexts, and long create/close runs.

/** A deterministic 32-bit generator (mulberry32), so every run explores the same schedule. */
const seeded = (seed: number) => {
  let state = seed >>> 0

  return (): number => {
    state = (state + 0x6D2B79F5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

const shuffle = <A>(values: ReadonlyArray<A>, random: () => number): Array<A> => {
  const result = [...values]

  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    const swap = result[index]
    const value = result[other]

    if (swap === undefined || value === undefined) continue

    result[index] = value
    result[other] = swap
  }

  return result
}

const page = (url: string): CreateParameters => ({ url, reasons: ["DOM_PARSER"], justification: `Parse for ${url}` })

const parameters = page("offscreen.html")

const audio = page("audio.html")

const documentUrl = "chrome-extension://test-extension/offscreen.html"

/** Settles after a seeded number of microtask turns, so Chrome calls interleave unevenly. */
const ticks = async (random: () => number) => {
  for (let turn = Math.floor(random() * 4); turn > 0; turn--) await Promise.resolve()
}

/**
 * The fixture behind asynchronous jitter, counting the create and close calls in flight
 * (one service may never overlap two) and gating the next lookup on demand. With `parking`,
 * create and close calls stay pending until `pump` lets them through, across scheduler turns.
 */
const instrumented = (random: () => number, parking = false) => {
  const fixture = makeOffscreen()
  const lookups: Array<{ readonly enter: () => void, readonly gate: Promise<void> }> = []
  const parked: Array<{ readonly tag: string, readonly release: () => void }> = []
  let inFlight = 0
  let maxInFlight = 0

  const lifecycle = <A>(tag: string, run: () => Promise<A>) => async () => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)

    try {
      if (parking) await new Promise<void>((release) => { parked.push({ tag, release }) })
      else await ticks(random)

      return await run()
    } finally {
      inFlight -= 1
    }
  }

  const api: ChromeOffscreenApi = {
    ...fixture.api,
    createDocument: (details) => lifecycle(details.justification, () => fixture.api.createDocument(details))(),
    closeDocument: lifecycle("close", () => fixture.api.closeDocument()),
    getContexts: async (filter) => {
      const lookup = lookups.shift()

      lookup?.enter()
      await lookup?.gate
      await ticks(random)

      return fixture.api.getContexts(filter)
    }
  }

  const holdNextLookup = (): OffscreenHold => {
    let release!: () => void
    let enter!: () => void
    const entered = new Promise<void>((resolve) => { enter = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })

    lookups.push({ enter, gate })

    return { entered, release: () => { release() } }
  }

  /**
   * Lets one parked call through after a seeded number of scheduler turns, forever, first
   * running `beforeRelease` with the call's tag (its justification, or "close").
   */
  const pump = (beforeRelease: (tag: string) => Effect.Effect<void>) => Effect.forever(Effect.gen(function*() {
    for (let turn = Math.floor(random() * 8); turn >= 0; turn--) yield* Effect.yieldNow

    const [call] = parked.splice(Math.floor(random() * parked.length), 1)

    if (call === undefined) return

    yield* beforeRelease(call.tag)
    call.release()
  }))

  return {
    fixture,
    api,
    pump,
    holdNextLookup,
    get inFlight() { return inFlight },
    get maxInFlight() { return maxInFlight }
  }
}

/** The typed failure an Exit carries, if any. */
const errorOf = <A>(exit: Exit.Exit<A, ChromeOffscreenError>) => Option.getOrUndefined(Exit.findErrorOption(exit))

/** A scoped document that also lets the test know when it is held, and then keeps it. */
const holding = (service: ChromeOffscreenService, details: CreateParameters, acquired: Deferred.Deferred<void>) =>
  Effect.scoped(service.document(details).pipe(Effect.andThen(Deferred.succeed(acquired, undefined)), Effect.andThen(Effect.never)))

/** A fresh scoped document creates and closes exactly one document: no holder leaked. */
const expectNoHolders = (service: ChromeOffscreenService, fixture: ReturnType<typeof makeOffscreen>) => Effect.gen(function*() {
  const created = fixture.controls.created.length
  const closed = fixture.controls.closed
  yield* Effect.scoped(service.document(parameters))
  expect(fixture.controls.created.length - created).toBe(1)
  expect(fixture.controls.closed - closed).toBe(1)
  expect(fixture.controls.documentUrl).toBeUndefined()
})

describe("ChromeOffscreen stress", () => {
  it.effect("3,072 concurrent calls with interleaved rejections and throws each fail with their own operation and cause", () => Effect.gen(function*() {
    const random = seeded(0x0ff5c2ee)
    const fixture = makeOffscreen()
    const causes = new Map<string, Error>()
    let inFlight = 0
    let maxInFlight = 0

    let produced = 0

    const cause = (key: string) => {
      const error = new Error(key)
      produced += 1
      causes.set(key, error)

      return error
    }

    // Each call's outcome is keyed by the index carried in its URL or justification.
    const indexOf = (text: string) => Number(/(\d+)/.exec(text)?.[1] ?? Number.NaN)

    const api: ChromeOffscreenApi = {
      createDocument: async (details) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)

        try {
          await ticks(random)
          const index = indexOf(details.justification)

          if (index % 5 === 3) throw cause(`createDocument reject ${details.justification}`)
        } finally {
          inFlight -= 1
        }
      },
      closeDocument: () => Promise.resolve(),
      hasDocument: () => fixture.api.hasDocument?.() ?? Promise.resolve(false),
      getContexts: async (filter) => {
        await ticks(random)
        const url = filter.documentUrls?.[0] ?? ""

        if (indexOf(url) % 5 === 2) throw cause(`getContexts reject ${url}`)

        return []
      },
      getURL: (path) => fixture.api.getURL(path)
    }

    const throwing: ChromeOffscreenApi = {
      ...api,
      createDocument: (details) => {
        const index = indexOf(details.justification)

        if (index % 5 === 4) throw cause(`createDocument throw ${details.justification}`)

        return api.createDocument(details)
      }
    }

    const service = make(throwing)
    const total = 1024

    // Bucket 1 is a URL the resolution step rejects before any Chrome call.
    const urlOf = (index: number) => index % 5 === 1 ? `http://[${index}` : `page-${index}.html`

    const expectedFailure = (index: number) => {
      switch (index % 5) {
        case 1: return { operation: "getURL", key: undefined }
        case 2: return { operation: "getContexts", key: `getContexts reject chrome-extension://test-extension/${urlOf(index)}` }
        case 3: return { operation: "createDocument", key: `createDocument reject ${page(urlOf(index)).justification}` }
        case 4: return { operation: "createDocument", key: `createDocument throw ${page(urlOf(index)).justification}` }
        default: return undefined
      }
    }

    const ensures = Array.from({ length: total }, (_, index) => Effect.exit(service.ensureDocument(page(urlOf(index)))))
    const creates = Array.from({ length: total }, (_, index) => Effect.exit(service.createDocument(page(`created-${index}.html`))))

    // hasDocument takes no permit; alternate Chrome-150 rejections and throws through the fixture.
    const queries = Array.from({ length: total }, (_, index) => Effect.suspend(() => {
      if (index % 3 === 1) fixture.controls.failNext("hasDocument", cause(`hasDocument ${index}`))

      return Effect.exit(index % 3 === 2
        ? make({ ...throwing, hasDocument: () => { throw cause(`hasDocument ${index}`) } }).hasDocument
        : service.hasDocument)
    }))

    const [ensured, created, queried] = yield* Effect.all([
      Effect.all(ensures, { concurrency: "unbounded" }),
      Effect.all(creates, { concurrency: "unbounded" }),
      Effect.all(queries, { concurrency: "unbounded" })
    ], { concurrency: "unbounded" })

    expect(maxInFlight).toBe(1)
    // Every cause is a distinct key, so each assertion below identifies one call's own error.
    expect(causes.size).toBe(produced)

    ensured.forEach((exit, index) => {
      const failure = expectedFailure(index)

      if (failure === undefined) {
        expect(Exit.getSuccess(exit)).toStrictEqual(Option.some(true))

        return
      }

      const error = errorOf(exit)

      expect(error).toBeInstanceOf(ChromeOffscreenError)
      expect(error?.operation).toBe(failure.operation)

      if (failure.key === undefined) expect(error?.cause).toBeInstanceOf(TypeError)
      else expect(error?.cause).toBe(causes.get(failure.key))
    })

    const createKey = (index: number) => {
      const { justification } = page(`created-${index}.html`)

      switch (index % 5) {
        case 3: return `createDocument reject ${justification}`
        case 4: return `createDocument throw ${justification}`
        default: return undefined
      }
    }

    created.forEach((exit, index) => {
      const key = createKey(index)

      if (key === undefined) {
        expect(Exit.isSuccess(exit)).toBe(true)

        return
      }

      expect(errorOf(exit)).toMatchObject({ operation: "createDocument", cause: causes.get(key) })
    })

    const failedQueries = queried.filter(Exit.isFailure)
    expect(failedQueries).toHaveLength(Math.floor(total / 3) * 2 + (total % 3 === 2 ? 1 : 0))

    for (const exit of failedQueries) {
      const error = errorOf(exit)

      expect(error).toBeInstanceOf(ChromeOffscreenError)
      expect(error?.operation).toBe("hasDocument")
      expect(error?.cause).toBe(causes.get(String(error?.cause instanceof Error ? error.cause.message : "")))
    }

    expect(queried.filter(Exit.isSuccess)).toHaveLength(total - failedQueries.length)
  }))

  it.effect("1,024 concurrent ensureDocument calls on jittered Chrome create once and never overlap lifecycle calls", () => Effect.gen(function*() {
    const chrome = instrumented(seeded(1024))
    const service = make(chrome.api)
    const results = yield* Effect.all(Array.from({ length: 1024 }, () => service.ensureDocument(parameters)), { concurrency: "unbounded" })
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(chrome.fixture.controls.created).toHaveLength(1)
    expect(chrome.maxInFlight).toBe(1)
  }))

  it.effect("512 deterministic rounds interrupt a scoped document at every stage and leave nothing held", () => Effect.gen(function*() {
    const random = seeded(512)
    const chrome = instrumented(random)
    const { fixture } = chrome
    const service = make(chrome.api)
    const stages = ["permit", "lookup", "create", "held", "release"] as const
    const visited = new Map<string, number>()

    for (let round = 0; round < 512; round++) {
      const stage = stages[round % stages.length] ?? "permit"
      const keeper = (stage === "lookup" || stage === "held") && random() < 0.5
      const created = fixture.controls.created.length
      const closed = fixture.controls.closed
      const keeperScope = yield* Scope.make()

      visited.set(`${stage}${keeper ? "+keeper" : ""}`, (visited.get(`${stage}${keeper ? "+keeper" : ""}`) ?? 0) + 1)

      if (keeper) yield* Scope.provide(service.document(parameters), keeperScope)

      const acquired = yield* Deferred.make<void>()

      switch (stage) {
        case "permit": {
          const hold = fixture.controls.holdNextCreate()
          const blocker = yield* Effect.forkChild(service.ensureDocument(parameters), { startImmediately: true })
          yield* Effect.promise(() => hold.entered)
          const user = yield* Effect.forkChild(holding(service, parameters, acquired), { startImmediately: true })
          yield* Fiber.interrupt(user)
          expect(fixture.controls.created.length - created).toBe(1)
          hold.release()
          expect(yield* Fiber.join(blocker)).toBe(true)
          yield* service.closeDocument
          break
        }

        case "lookup": {
          const hold = chrome.holdNextLookup()
          const user = yield* Effect.forkChild(holding(service, parameters, acquired), { startImmediately: true })
          yield* Effect.promise(() => hold.entered)
          yield* Fiber.interrupt(user)
          hold.release()
          break
        }

        case "create": {
          const hold = fixture.controls.holdNextCreate()
          const user = yield* Effect.forkChild(holding(service, parameters, acquired), { startImmediately: true })
          yield* Effect.promise(() => hold.entered)
          const interrupting = yield* Effect.forkChild(Fiber.interrupt(user), { startImmediately: true })
          expect(interrupting.pollUnsafe()).toBeUndefined()
          hold.release()
          yield* Fiber.join(interrupting)
          break
        }

        case "held": {
          const user = yield* Effect.forkChild(holding(service, parameters, acquired), { startImmediately: true })
          yield* Deferred.await(acquired)
          expect(fixture.controls.documentUrl).toBe(documentUrl)
          yield* Fiber.interrupt(user)
          break
        }

        case "release": {
          const user = yield* Effect.forkChild(holding(service, parameters, acquired), { startImmediately: true })
          yield* Deferred.await(acquired)
          const hold = fixture.controls.holdNextClose()
          const interrupting = yield* Effect.forkChild(Fiber.interrupt(user), { startImmediately: true })
          yield* Effect.promise(() => hold.entered)
          expect(interrupting.pollUnsafe()).toBeUndefined()
          hold.release()
          yield* Fiber.join(interrupting)
          break
        }
      }

      if (keeper) {
        expect(fixture.controls.documentUrl).toBe(documentUrl)
        yield* Scope.close(keeperScope, Exit.void)
      }

      expect(fixture.controls.documentUrl).toBeUndefined()
      expect(fixture.controls.creating).toBe(false)
      expect(fixture.controls.created.length - created).toBe(fixture.controls.closed - closed)
    }

    expect([...visited.keys()].sort()).toEqual([
      "create", "held", "held+keeper", "lookup", "lookup+keeper", "permit", "release"
    ])
    expect(chrome.maxInFlight).toBe(1)
    yield* expectNoHolders(service, fixture)
  }))

  it.effect("512 concurrent scoped documents interrupted at seeded points end with zero holders", () => Effect.gen(function*() {
    const random = seeded(0x51257)
    const chrome = instrumented(random)
    const { fixture } = chrome
    const service = make(chrome.api)
    let acquiredCount = 0

    const users = yield* Effect.forEach(Array.from({ length: 512 }), () => {
      const steps = Math.floor(random() * 8)

      const user = Effect.scoped(Effect.gen(function*() {
        yield* service.document(parameters)
        acquiredCount += 1

        for (let step = 0; step < steps; step++) yield* Effect.yieldNow
      }))

      return Effect.forkChild(user, { startImmediately: true })
    })

    const interrupters = yield* Effect.forEach(shuffle(users, random), (user) => {
      const delay = Math.floor(random() * 48)

      return Effect.forkChild(Effect.gen(function*() {
        for (let step = 0; step < delay; step++) yield* Effect.yieldNow
        yield* Fiber.interrupt(user)
      }))
    })

    yield* Effect.forEach(interrupters, Fiber.join)
    const exits = yield* Effect.forEach(users, Fiber.await)

    // Every user finished either by completing or by interruption, never by a failure.
    for (const exit of exits) expect(Exit.isSuccess(exit) || Exit.hasInterrupts(exit)).toBe(true)

    expect(exits.some(Exit.isSuccess)).toBe(true)
    expect(exits.some(Exit.hasInterrupts)).toBe(true)
    expect(acquiredCount).toBeGreaterThan(0)
    expect(fixture.controls.documentUrl).toBeUndefined()
    expect(fixture.controls.creating).toBe(false)
    expect(fixture.controls.created.length).toBe(fixture.controls.closed)
    expect(chrome.maxInFlight).toBe(1)
    yield* expectNoHolders(service, fixture)
  }))

  it.effect("1,024 overlapping scopes released in seeded order share one document until the last", () => Effect.gen(function*() {
    const random = seeded(4096)
    const chrome = instrumented(random)
    const { fixture } = chrome
    const service = make(chrome.api)
    const scopes = yield* Effect.forEach(Array.from({ length: 1024 }), () => Scope.make())
    yield* Effect.forEach(scopes, (scope) => Scope.provide(service.document(parameters), scope), { concurrency: "unbounded" })
    expect(fixture.controls.created).toHaveLength(1)

    const order = shuffle(scopes, random)
    const last = order.pop()

    yield* Effect.forEach(order, (scope) => Scope.close(scope, Exit.void), { concurrency: "unbounded" })
    expect(fixture.controls.documentUrl).toBe(documentUrl)
    expect(fixture.controls.closed).toBe(0)

    if (last !== undefined) yield* Scope.close(last, Exit.void)

    expect(fixture.controls.documentUrl).toBeUndefined()
    expect(fixture.controls.closed).toBe(1)
    yield* expectNoHolders(service, fixture)
  }))

  it.effect("1,024 seeded concurrent operations, interrupted while queued or while Chrome works, never overlap Chrome calls", () => Effect.gen(function*() {
    const random = seeded(0xace)
    const chrome = instrumented(random, true)
    const { fixture } = chrome
    const service = make(chrome.api)
    const fibers: Array<Fiber.Fiber<void, ChromeOffscreenError>> = []
    const interrupted = new Set<number>()
    const tagged = (details: CreateParameters, index: number) => ({ ...details, justification: `op-${index}` })

    const operations = [
      { name: "ensure", run: (index: number) => service.ensureDocument(tagged(parameters, index)), allowed: ["createDocument"] },
      { name: "ensureAudio", run: (index: number) => service.ensureDocument(tagged(audio, index)), allowed: ["createDocument"] },
      { name: "create", run: (index: number) => service.createDocument(tagged(parameters, index)), allowed: ["createDocument"] },
      { name: "close", run: () => service.closeDocument, allowed: ["closeDocument"] },
      { name: "document", run: (index: number) => Effect.scoped(service.document(tagged(parameters, index))), allowed: ["createDocument"] },
      { name: "has", run: () => service.hasDocument, allowed: [] },
      { name: "outside", run: () => Effect.sync(() => { if (random() < 0.5) fixture.controls.close() }), allowed: [] }
    ] as const

    // Half the time, the caller whose createDocument Chrome is about to finish is
    // interrupted first; that call keeps going, and the next caller must wait for it.
    yield* Effect.forkChild(chrome.pump((tag) => Effect.suspend(() => {
      const index = Number(/^op-(\d+)$/.exec(tag)?.[1] ?? Number.NaN)
      const fiber = fibers[index]

      if (fiber === undefined || random() < 0.5) return Effect.void

      interrupted.add(index)

      return Effect.asVoid(Effect.forkChild(Fiber.interrupt(fiber), { startImmediately: true }))
    })))

    const plan = Array.from({ length: 1024 }, () => operations[Math.floor(random() * operations.length)] ?? operations[0])

    for (const [index, operation] of plan.entries()) {
      fibers.push(yield* Effect.forkChild(Effect.asVoid(operation.run(index)), { startImmediately: true }))
    }

    // A seeded third is also interrupted after a seeded number of scheduler turns, mostly
    // while still waiting for the permit.
    const targeted = new Set(Array.from({ length: fibers.length }, (_, index) => index).filter(() => random() < 1 / 3))

    const interrupters = yield* Effect.forEach([...targeted], (index) => {
      const delay = Math.floor(random() * 64)

      return Effect.forkChild(Effect.gen(function*() {
        for (let step = 0; step < delay; step++) yield* Effect.yieldNow

        const fiber = fibers[index]

        if (fiber !== undefined) yield* Fiber.interrupt(fiber)
      }))
    })

    yield* Effect.forEach(interrupters, Fiber.join)
    const exits = yield* Effect.forEach(fibers, Fiber.await)

    exits.forEach((exit, index) => {
      if (Exit.isSuccess(exit)) return

      expect(Exit.hasDies(exit)).toBe(false)

      if (Exit.hasInterrupts(exit)) {
        expect(targeted.has(index) || interrupted.has(index)).toBe(true)

        return
      }

      const allowed: ReadonlyArray<string> = plan[index]?.allowed ?? []
      const error = errorOf(exit)

      expect(error).toBeInstanceOf(ChromeOffscreenError)
      expect(allowed).toContain(error?.operation)
    })

    expect(new Set(plan.map(({ name }) => name)).size).toBe(operations.length)
    expect(exits.some((exit) => Exit.isFailure(exit) && !Exit.hasInterrupts(exit))).toBe(true)
    expect([...interrupted].filter((index) => !targeted.has(index) && Exit.hasInterrupts(exits[index] ?? Exit.void)).length).toBeGreaterThan(0)

    // A lifecycle call settles whatever an interrupted caller left in flight.
    yield* Effect.exit(service.closeDocument)
    expect(chrome.maxInFlight).toBe(1)
    expect(chrome.inFlight).toBe(0)
    expect(fixture.controls.creating).toBe(false)
    fixture.controls.close()
    yield* expectNoHolders(service, fixture)
  }))

  it.effect("256 services (extension contexts) racing ensureDocument: one creates, the rest fail typed and then find it", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const services = Array.from({ length: 256 }, () => make(fixture.api))
    const hold = fixture.controls.holdNextCreate()

    const fibers = yield* Effect.forEach(services, (service) =>
      Effect.forkChild(Effect.exit(service.ensureDocument(parameters)), { startImmediately: true }))

    yield* Effect.promise(() => hold.entered)
    hold.release()
    const exits = yield* Effect.forEach(fibers, Fiber.join)
    const created = exits.filter((exit) => Exit.isSuccess(exit) && exit.value)
    expect(created).toHaveLength(1)

    for (const exit of exits.filter(Exit.isFailure)) expect(errorOf(exit)).toMatchObject({ operation: "createDocument" })

    expect(exits.filter(Exit.isFailure)).toHaveLength(255)
    const retried = yield* Effect.forEach(services, (service) => service.ensureDocument(parameters), { concurrency: "unbounded" })
    expect(retried.every((value) => !value)).toBe(true)
    expect(fixture.controls.documentUrl).toBe(documentUrl)
  }))

  it.effect("2,048 scoped create/close cycles alternate pages and get fresh contexts each time", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const service = make(fixture.api)
    const contexts = new Set<string>()

    for (let cycle = 0; cycle < 2048; cycle++) {
      yield* Effect.scoped(Effect.gen(function*() {
        yield* service.document(cycle % 2 === 0 ? parameters : audio)
        const [context] = yield* Effect.promise(() => fixture.api.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }))
        contexts.add(context?.contextId ?? "missing")
      }))
    }

    expect(contexts.size).toBe(2048)
    expect(contexts.has("missing")).toBe(false)
    expect(fixture.controls.created).toHaveLength(2048)
    expect(fixture.controls.closed).toBe(2048)
    expect(fixture.controls.documentUrl).toBeUndefined()
  }))

  it.effect("getContexts matches the document among 4,096-entry filter lists", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    fixture.controls.open("offscreen.html")
    const urls = Array.from({ length: 4096 }, (_, index) => `chrome-extension://test-extension/page-${index}.html`)
    const query = (filter: chrome.runtime.ContextFilter) => Effect.promise(() => fixture.api.getContexts(filter))
    expect(yield* query({ documentUrls: urls })).toEqual([])
    expect(yield* query({ documentUrls: [...urls, documentUrl] })).toHaveLength(1)
    expect(yield* query({ contextIds: Array.from({ length: 4096 }, (_, index) => `offscreen-${index}`) })).toHaveLength(1)
  }))
})
