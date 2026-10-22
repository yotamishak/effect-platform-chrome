// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Exit, Fiber, Option, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChromeSessionsError, make, MAX_SESSION_RESULTS } from "../../src/ChromeSessions.js"
import type { ChromeSessionsApi, Device, Filter, Session } from "../../src/ChromeSessions.js"
import { makeEvent } from "../../src/ChromeTesting.js"
import { makeSessions } from "../../src/testing/Sessions.js"

/** Deterministic mulberry32, so every run exercises the same interleaving. */
const seeded = (seed: number) => {
  let state = seed >>> 0

  return (): number => {
    state = (state + 0x6D2B79F5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <A>(items: ReadonlyArray<A>, random: () => number): A => {
  const item = items[Math.floor(random() * items.length)]

  if (item === undefined) throw new Error("pick from an empty list")

  return item
}

const shuffle = <A>(items: ReadonlyArray<A>, random: () => number): Array<A> => {
  const result = Array.from(items)

  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    const current = result[index]
    const swapped = result[other]

    if (current !== undefined && swapped !== undefined) {
      result[index] = swapped
      result[other] = current
    }
  }

  return result
}

/** Resolves waiters once a counter reaches their target; never relies on scheduler turns. */
const counter = () => {
  const waiting: Array<{ readonly target: number, readonly resolve: () => void }> = []
  let value = 0

  const settle = () => {
    for (const waiter of waiting.filter((candidate) => value >= candidate.target)) {
      waiting.splice(waiting.indexOf(waiter), 1)
      waiter.resolve()
    }
  }

  return {
    get value() { return value },
    increment: () => {
      value++
      settle()
    },
    reaches: (target: number): Promise<void> => new Promise((resolve) => {
      waiting.push({ target, resolve })
      settle()
    })
  }
}

/** A makeEvent whose registrations can be awaited by total count. */
const trackedEvent = () => {
  const event = makeEvent<[]>()
  const registrations = counter()

  return {
    api: {
      addListener: (listener: () => void) => {
        event.api.addListener(listener)
        registrations.increment()
      },
      removeListener: (listener: () => void) => event.api.removeListener(listener)
    },
    controls: {
      burst: (count: number) => {
        for (let index = 0; index < count; index++) event.controls.emit()
      },
      get listenerCount() { return event.controls.listenerCount },
      waitForRegistrations: (count: number) => registrations.reaches(count),
      failNext: event.controls.failNext
    }
  }
}

const unusedCalls = {
  getRecentlyClosed: () => Promise.reject(new Error("unused")),
  getDevices: () => Promise.reject(new Error("unused")),
  restore: () => Promise.reject(new Error("unused"))
} satisfies Omit<ChromeSessionsApi, "onChanged">

const withEvent = (onChanged: ChromeSessionsApi["onChanged"]) => make({ ...unusedCalls, onChanged })

/** Records the size of each pulled chunk; every pull takes all buffered changes at once. */
const chunkRecorder = () => {
  const sizes: Array<number> = []
  const recorded = counter()

  return {
    sizes,
    record: (chunk: ReadonlyArray<void>) => Effect.sync(() => {
      sizes.push(chunk.length)
      recorded.increment()
    }),
    waitForChunks: (count: number) => recorded.reaches(count)
  }
}

describe("ChromeSessions stress: onChanged", () => {
  it.effect("keeps exactly the newest 64 of each 4,096-change burst on one listener, then removes it", () => Effect.gen(function*() {
    const event = trackedEvent()
    const recorder = chunkRecorder()
    const fiber = yield* Effect.forkChild(Stream.runForEach(Stream.chunks(withEvent(event.api).onChanged), recorder.record))
    yield* Effect.promise(() => event.controls.waitForRegistrations(1))

    // onChanged carries no value, so what survives is measured by count: each synchronous burst
    // lands in the sliding buffer before the consumer can pull, and the pull takes all of it.
    const bursts = [4096, 63, 64, 65, 1, 4096, 4096]

    for (const [index, burst] of bursts.entries()) {
      event.controls.burst(burst)
      yield* Effect.promise(() => recorder.waitForChunks(index + 1))
    }

    expect(recorder.sizes).toEqual([64, 63, 64, 64, 1, 64, 64])
    expect(event.controls.listenerCount).toBe(1)
    yield* Fiber.interrupt(fiber)
    expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
    expect(event.controls.listenerCount).toBe(0)
    event.controls.burst(4096)
    expect(recorder.sizes).toHaveLength(bursts.length)
  }))

  it.effect("keeps 64 of a 4,096-change burst Chrome dispatches during registration", () => Effect.gen(function*() {
    const event = makeEvent<[]>()

    const eager = {
      addListener: (listener: () => void) => {
        event.api.addListener(listener)

        for (let index = 0; index < 4096; index++) event.controls.emit()
      },
      removeListener: (listener: () => void) => event.api.removeListener(listener)
    }

    const head = yield* Stream.runHead(Stream.chunks(withEvent(eager).onChanged))
    expect(Option.map(head, (chunk) => chunk.length)).toEqual(Option.some(64))
    expect(event.controls.listenerCount).toBe(0)
  }))

  it.effect("gives 256 concurrent consumers 64 changes each from one 4,096-change burst", () => Effect.gen(function*() {
    const event = trackedEvent()
    const changes = withEvent(event.api).onChanged
    const fibers = yield* Effect.forEach(Array.from({ length: 256 }), () => Effect.forkChild(Stream.runHead(Stream.chunks(changes))))
    yield* Effect.promise(() => event.controls.waitForRegistrations(256))
    expect(event.controls.listenerCount).toBe(256)
    event.controls.burst(4096)
    const heads = yield* Fiber.joinAll(fibers)
    expect(heads.map((head) => Option.getOrElse(Option.map(head, (chunk) => chunk.length), () => 0))).toEqual(Array.from({ length: 256 }, () => 64))
    expect(event.controls.listenerCount).toBe(0)
  }))

  it.effect("churns 512 subscriptions through every stage of their life, four times, leaving no listener", () => Effect.gen(function*() {
    for (let round = 0; round < 4; round++) {
      const shared = trackedEvent()
      const early = trackedEvent()
      const refusing = trackedEvent()
      const partial = makeEvent<[]>()
      const refusal = new Error(`refused in round ${round}`)

      // Registers, then throws, as a partly failing Chrome registration might.
      const partlyFailing = {
        addListener: (listener: () => void) => {
          partial.api.addListener(listener)

          throw refusal
        },
        removeListener: (listener: () => void) => partial.api.removeListener(listener)
      }

      const interruptedEarly: Array<Fiber.Fiber<void, ChromeSessionsError>> = []
      const idle: Array<Fiber.Fiber<void, ChromeSessionsError>> = []
      const blocked: Array<Fiber.Fiber<void, ChromeSessionsError>> = []
      const refused: Array<Fiber.Fiber<void, ChromeSessionsError>> = []
      const partlyRefused: Array<Fiber.Fiber<void, ChromeSessionsError>> = []
      const completing: Array<Fiber.Fiber<Array<void>, ChromeSessionsError>> = []

      for (let index = 0; index < 512; index++) {
        switch (index % 6) {
          case 0: {
            // Interrupted at once, before or during its registration.
            const fiber = yield* Effect.forkChild(Stream.runDrain(withEvent(early.api).onChanged))
            yield* Fiber.interrupt(fiber)
            interruptedEarly.push(fiber)
            break
          }

          case 1:
            idle.push(yield* Effect.forkChild(Stream.runDrain(withEvent(shared.api).onChanged)))
            break

          case 2:
            blocked.push(yield* Effect.forkChild(Stream.runDrain(withEvent(shared.api).onChanged.pipe(Stream.mapEffect(() => Effect.never)))))
            break

          case 3:
            refusing.controls.failNext("addListener", refusal)
            refused.push(yield* Effect.forkChild(Stream.runDrain(withEvent(refusing.api).onChanged)))
            break

          case 4:
            partlyRefused.push(yield* Effect.forkChild(Stream.runDrain(withEvent(partlyFailing).onChanged)))
            break

          default:
            completing.push(yield* Effect.forkChild(Stream.runCollect(Stream.take(withEvent(shared.api).onChanged, 10))))
        }
      }

      yield* Effect.promise(() => shared.controls.waitForRegistrations(idle.length + blocked.length + completing.length))
      expect(shared.controls.listenerCount).toBe(idle.length + blocked.length + completing.length)

      // Idle subscribers go first, then buffered-but-blocked ones once changes are pending.
      yield* Fiber.interruptAll(idle)
      shared.controls.burst(100)
      const completed = yield* Fiber.joinAll(completing)
      expect(completed.map((values) => values.length)).toEqual(completing.map(() => 10))
      yield* Fiber.interruptAll(blocked)

      for (const fiber of [...interruptedEarly, ...idle, ...blocked]) {
        const exit = yield* Fiber.await(fiber)
        expect(Exit.hasInterrupts(exit)).toBe(true)
        expect(Option.isNone(Exit.findErrorOption(exit))).toBe(true)
      }

      for (const fiber of [...refused, ...partlyRefused]) {
        const error = yield* Effect.flip(Fiber.join(fiber))
        expect(error).toBeInstanceOf(ChromeSessionsError)
        expect(error).toMatchObject({ operation: "onChanged", cause: refusal })
      }

      expect([shared, early, refusing].map((event) => event.controls.listenerCount)).toEqual([0, 0, 0])
      expect(partial.controls.listenerCount).toBe(0)
    }
  }))

  it.effect("keeps a removed listener inert when Chrome dispatches while removing it", () => Effect.gen(function*() {
    const event = makeEvent<[]>()
    const registrations = counter()
    const delivered: Array<string> = []
    let reentered = 0

    // Chrome may still be dispatching when removeListener runs; emit before actually removing.
    const reentrant = {
      addListener: (listener: () => void) => {
        event.api.addListener(listener)
        registrations.increment()
      },
      removeListener: (listener: () => void) => {
        reentered++
        event.controls.emit()
        event.api.removeListener(listener)
      }
    }

    const changes = withEvent(reentrant).onChanged
    const survivor = yield* Effect.forkChild(Stream.runCollect(Stream.take(changes, 2).pipe(Stream.tap(() => Effect.sync(() => delivered.push("survivor"))))))
    const leaver = yield* Effect.forkChild(Stream.runCollect(Stream.take(changes, 1).pipe(Stream.tap(() => Effect.sync(() => delivered.push("leaver"))))))
    yield* Effect.promise(() => registrations.reaches(2))
    event.controls.emit()
    expect(yield* Fiber.join(leaver)).toHaveLength(1)

    // The leaver's removal re-emitted once: only the survivor, still registered, may see it.
    expect(yield* Fiber.join(survivor)).toHaveLength(2)
    expect(reentered).toBe(2)
    expect(delivered.filter((name) => name === "leaver")).toHaveLength(1)
    expect(event.controls.listenerCount).toBe(0)
  }))
})

type Operation = "getRecentlyClosed" | "getDevices" | "restore"

type Outcome = "resolve" | "reject" | "throw"

type Result = Session | Array<Session> | Array<Device>

/** A distinct result per call, so identity shows which call it came from. */
const resultFor = (operation: Operation, index: number): Result => {
  switch (operation) {
    case "getRecentlyClosed": return [{ lastModified: index }]
    case "getDevices": return [{ deviceName: `device ${index}`, sessions: [] }]
    case "restore": return { lastModified: index }
  }
}

interface Planned {
  readonly index: number
  readonly operation: Operation
  readonly outcome: Outcome
  readonly withArgument: boolean
  readonly interrupt: boolean
  readonly value: Result
  readonly cause: Error
}

describe("ChromeSessions stress: calls", () => {
  it.effect("settles 2,048 concurrent calls in shuffled order, typing every rejection and throw", () => Effect.gen(function*() {
    const random = seeded(0x5E55_1015)
    const operations: ReadonlyArray<Operation> = ["getRecentlyClosed", "getDevices", "restore"]
    const outcomes: ReadonlyArray<Outcome> = ["resolve", "reject", "throw"]

    const plan: Array<Planned> = Array.from({ length: 2048 }, (_, index) => {
      const operation = pick(operations, random)
      const outcome = pick(outcomes, random)
      const withArgument = random() < 0.75

      return {
        index, operation, outcome, withArgument,
        value: resultFor(operation, index),
        // Only calls Chrome can tell apart by argument are interrupted, so each one's fate is known.
        interrupt: withArgument && outcome !== "throw" && random() < 0.15,
        cause: new Error(`${outcome} ${operation} ${index}`)
      }
    })

    const filters = new Map<Filter, Planned>()
    const unnamed = new Map<Operation, Array<Planned>>(operations.map((operation) => [operation, plan.filter((entry) => entry.operation === operation && !entry.withArgument)]))
    const pending: Array<() => void> = []
    const invoked = counter()

    const run = <A>(entry: Planned | undefined): Promise<A> => {
      invoked.increment()

      if (entry === undefined) throw new Error("unplanned call")

      if (entry.outcome === "throw") throw entry.cause

      return new Promise<A>((resolve, reject) => {
        pending.push(() => {
          if (entry.outcome === "reject") {
            reject(entry.cause)

            return
          }

          // SAFETY: resultFor built this value for the entry's own operation, whose result type is A.
          resolve(entry.value as A)
        })
      })
    }

    const fromFilter = (operation: Operation, filter: Filter | undefined) =>
      filter === undefined ? unnamed.get(operation)?.shift() : filters.get(filter)

    const sessions = make({
      getRecentlyClosed: (filter) => run(fromFilter("getRecentlyClosed", filter)),
      getDevices: (filter) => run(fromFilter("getDevices", filter)),
      restore: (sessionId) => run(sessionId === undefined ? unnamed.get("restore")?.shift() : plan[Number(sessionId)]),
      onChanged: makeEvent<[]>().api
    })

    const effectOf = (entry: Planned): Effect.Effect<Result, ChromeSessionsError> => {
      const filter: Filter = { maxResults: entry.index % (MAX_SESSION_RESULTS + 1) }

      if (entry.withArgument) filters.set(filter, entry)

      switch (entry.operation) {
        case "getRecentlyClosed": return entry.withArgument ? sessions.getRecentlyClosed(filter) : sessions.getRecentlyClosed()
        case "getDevices": return entry.withArgument ? sessions.getDevices(filter) : sessions.getDevices()
        case "restore": return entry.withArgument ? sessions.restore(String(entry.index)) : sessions.restore()
      }
    }

    const fibers = yield* Effect.forEach(plan, (entry) => Effect.forkChild(effectOf(entry)))
    yield* Effect.promise(() => invoked.reaches(plan.length))
    yield* Fiber.interruptAll(fibers.filter((_, index) => plan[index]?.interrupt === true))

    for (const settle of shuffle(pending, random)) settle()

    const exits = yield* Effect.forEach(fibers, (fiber) => Fiber.await(fiber))
    const seen = new Map<Operation, Array<Result | Error>>(operations.map((operation) => [operation, []]))

    for (const [index, exit] of exits.entries()) {
      const entry = plan[index]

      if (entry === undefined) throw new Error("missing plan entry")

      if (entry.interrupt) {
        expect(Exit.hasInterrupts(exit)).toBe(true)
        continue
      }

      expect(Exit.hasInterrupts(exit)).toBe(false)

      if (Exit.isSuccess(exit)) {
        if (entry.withArgument) expect(entry.outcome).toBe("resolve")

        seen.get(entry.operation)?.push(exit.value)

        if (entry.withArgument) expect(exit.value).toBe(entry.value)
      } else {
        const error = Exit.findErrorOption(exit)

        if (entry.withArgument) expect(entry.outcome).not.toBe("resolve")

        expect(Option.isSome(error)).toBe(true)

        if (Option.isSome(error)) {
          expect(error.value).toBeInstanceOf(ChromeSessionsError)
          expect(error.value.operation).toBe(entry.operation)
          expect(error.value.cause).toBeInstanceOf(Error)

          if (error.value.cause instanceof Error) seen.get(entry.operation)?.push(error.value.cause)

          if (entry.withArgument) expect(error.value.cause).toBe(entry.cause)
        }
      }
    }

    // Calls without an argument are indistinguishable to Chrome, so match them as a set.
    for (const operation of operations) {
      const expected = plan.flatMap((entry) => entry.operation !== operation || entry.interrupt
        ? []
        : [entry.outcome === "resolve" ? entry.value : entry.cause])

      const observed = seen.get(operation) ?? []
      expect(observed).toHaveLength(expected.length)
      expect(new Set(observed)).toEqual(new Set(expected))
    }

    expect(new Set(plan.map((entry) => entry.outcome))).toEqual(new Set(outcomes))
    expect(plan.filter((entry) => entry.interrupt).length).toBeGreaterThan(64)
  }))

  it.effect("interrupts 1,024 restores Chrome never answers, and later answers reach nobody", () => Effect.gen(function*() {
    const settlers: Array<{ readonly resolve: (session: Session) => void, readonly reject: (cause: Error) => void }> = []
    const started = counter()

    const sessions = make({
      ...unusedCalls,
      restore: () => new Promise<Session>((resolve, reject) => {
        settlers.push({ resolve, reject })
        started.increment()
      }),
      onChanged: makeEvent<[]>().api
    })

    const fibers = yield* Effect.forEach(Array.from({ length: 1024 }, (_, index) => index), (index) =>
      Effect.forkChild(index % 2 === 0 ? sessions.restore() : sessions.restore(String(index))))

    yield* Effect.promise(() => started.reaches(1024))
    yield* Fiber.interruptAll(fibers)

    for (const fiber of fibers) expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)

    // Late rejections must stay handled: an unhandled one would fail the run.
    for (const [index, settler] of settlers.entries()) {
      if (index % 2 === 0) settler.reject(new Error(`late ${index}`))
      else settler.resolve({ lastModified: index })
    }

    expect(settlers).toHaveLength(1024)
  }))
})

describe("ChromeSessions stress: fixture", () => {
  it.effect("keeps the newest 25 of 50,000 closed tabs with unique, increasing session ids", () => Effect.gen(function*() {
    const fixture = makeSessions()
    const sessions = make(fixture.api)
    const recorder = chunkRecorder()
    const fiber = yield* Effect.forkChild(Stream.runForEach(Stream.chunks(sessions.onChanged), recorder.record))
    yield* Effect.promise(() => fixture.controls.onChanged.waitForListener())

    for (let index = 0; index < 50_000; index++) fixture.controls.closeTab({ title: `tab ${index}` })

    yield* Effect.promise(() => recorder.waitForChunks(1))
    expect(recorder.sizes).toEqual([64])
    const closed = yield* sessions.getRecentlyClosed()
    expect(closed.map((entry) => entry.tab?.title)).toEqual(Array.from({ length: 25 }, (_, index) => `tab ${49_999 - index}`))
    expect(closed.map((entry) => Number(entry.tab?.sessionId))).toEqual(Array.from({ length: 25 }, (_, index) => 50_000 - index))

    for (let maxResults = 0; maxResults <= MAX_SESSION_RESULTS; maxResults++) {
      expect(yield* sessions.getRecentlyClosed({ maxResults })).toEqual(closed.slice(0, maxResults))
    }

    yield* Fiber.interrupt(fiber)
    expect(fixture.controls.onChanged.listenerCount).toBe(0)
  }))

  it.effect("lets exactly 25 of 1,024 concurrent restores succeed, each entry once, and reports every change", () => Effect.gen(function*() {
    const fixture = makeSessions()
    const sessions = make(fixture.api)

    for (let index = 0; index < 25; index++) fixture.controls.closeTab({ title: `tab ${index}` })

    const changes = yield* Effect.forkChild(Stream.runCollect(Stream.take(sessions.onChanged, 50)))
    yield* Effect.promise(() => fixture.controls.onChanged.waitForListener())
    const exits = yield* Effect.all(Array.from({ length: 1024 }, () => Effect.exit(sessions.restore())), { concurrency: "unbounded" })
    const restored = exits.flatMap((exit) => Exit.isSuccess(exit) ? [exit.value.tab?.title] : [])
    const failures = exits.flatMap((exit) => Exit.isFailure(exit) ? [Exit.findErrorOption(exit)] : [])
    expect(restored).toHaveLength(25)
    expect(new Set(restored)).toEqual(new Set(Array.from({ length: 25 }, (_, index) => `tab ${index}`)))
    expect(failures).toHaveLength(999)

    for (const failure of failures) {
      expect(Option.isSome(failure)).toBe(true)

      if (Option.isSome(failure)) {
        expect(failure.value.operation).toBe("restore")
        expect(String(failure.value.cause)).toContain("There are no recently closed sessions.")
      }
    }

    // Each restore removes its entry and then finishes, firing twice: 50 changes, under the buffer.
    expect(yield* Fiber.join(changes)).toHaveLength(50)
    expect(fixture.controls.onChanged.listenerCount).toBe(0)
    expect(yield* sessions.getRecentlyClosed()).toEqual([])
  }))

  it.effect("lets exactly one of 512 concurrent restores of the same tab, window or window tab succeed", () => Effect.gen(function*() {
    const fixture = makeSessions()
    const sessions = make(fixture.api)
    const tab = fixture.controls.closeTab()
    const window = fixture.controls.closeWindow({}, [{}, {}])
    const ids = [tab.tab?.sessionId, window.window?.sessionId, fixture.controls.closeWindow({}, [{}, {}]).window?.tabs?.[1]?.sessionId]

    for (const sessionId of ids) {
      if (sessionId === undefined) throw new Error("fixture entries carry session ids")

      const exits = yield* Effect.all(Array.from({ length: 512 }, () => Effect.exit(sessions.restore(sessionId))), { concurrency: "unbounded" })
      expect(exits.filter(Exit.isSuccess)).toHaveLength(1)

      for (const exit of exits.filter(Exit.isFailure)) {
        const error = Exit.findErrorOption(exit)
        expect(Option.getOrElse(Option.map(error, (value) => String(value.cause)), () => "")).toContain(`Invalid session id: "${sessionId}".`)
      }
    }
  }))

  it.effect("matches a reference model through 4,000 seeded closes, restores and clears", () => Effect.gen(function*() {
    const random = seeded(0xC105ED)
    const fixture = makeSessions()
    const sessions = make(fixture.api)

    // The model keeps each entry's session id and, for windows, its tabs' ids.
    const model: Array<{ readonly id: string, readonly tabs: Array<string> }> = []
    let changes = 0
    fixture.api.onChanged.addListener(() => { changes++ })
    let expectedChanges = 0

    const idsOf = (list: ReadonlyArray<Session>) => list.map((entry) => ({
      id: entry.tab?.sessionId ?? entry.window?.sessionId ?? "",
      tabs: entry.window?.tabs?.map((tab) => tab.sessionId ?? "") ?? []
    }))

    for (let step = 0; step < 4000; step++) {
      const roll = random()

      if (roll < 0.35) {
        const closed = fixture.controls.closeTab()
        model.unshift({ id: closed.tab?.sessionId ?? "", tabs: [] })
        model.splice(MAX_SESSION_RESULTS)
        expectedChanges++
      } else if (roll < 0.55) {
        const closed = fixture.controls.closeWindow({}, Array.from({ length: 1 + Math.floor(random() * 4) }, () => ({})))
        model.unshift({ id: closed.window?.sessionId ?? "", tabs: closed.window?.tabs?.map((tab) => tab.sessionId ?? "") ?? [] })
        model.splice(MAX_SESSION_RESULTS)
        expectedChanges++
      } else if (roll < 0.7) {
        const exit = yield* Effect.exit(sessions.restore())
        expect(Exit.isSuccess(exit)).toBe(model.length > 0)

        if (model.length > 0) {
          model.shift()
          expectedChanges += 2
        }
      } else if (roll < 0.97) {
        const entry = model.length === 0 ? undefined : pick(model, random)
        const target = entry === undefined || entry.tabs.length === 0 || random() < 0.5 ? entry?.id : pick(entry.tabs, random)
        const sessionId = target ?? String(1_000_000 + step)
        // Chrome parses ids as integers, so every spelling of the same number names the same entry.
        const spelling = `${pick(["", "", "0", "000", "+", "+0"], random)}${sessionId}`
        const exit = yield* Effect.exit(sessions.restore(spelling))
        expect(Exit.isSuccess(exit)).toBe(entry !== undefined)

        if (Exit.isFailure(exit)) {
          const error = Exit.findErrorOption(exit)
          expect(Option.map(error, (value) => String(value.cause))).toEqual(Option.some(`Error: Invalid session id: "${sessionId}".`))
        }

        if (entry !== undefined) {
          if (target === entry.id) {
            model.splice(model.indexOf(entry), 1)
            expectedChanges += 2
          } else {
            entry.tabs.splice(entry.tabs.indexOf(sessionId), 1)

            if (entry.tabs.length === 0) {
              model.splice(model.indexOf(entry), 1)
              expectedChanges += 2
            } else {
              expectedChanges += 1
            }
          }
        }
      } else {
        fixture.controls.clear()
        model.splice(0)
        expectedChanges++
      }

      expect(idsOf(fixture.controls.recentlyClosed())).toEqual(model)
    }

    expect(changes).toBe(expectedChanges)
  }))

  it.effect("lists 1,000 devices with 30 windows each, bounded per device by every maxResults", () => Effect.gen(function*() {
    const fixture = makeSessions()
    const sessions = make(fixture.api)

    const devices: Array<Device> = Array.from({ length: 1000 }, (_, device) => ({
      deviceName: `device ${device}`,
      sessions: Array.from({ length: 30 }, (_, window) => ({
        lastModified: 30 - window,
        window: { sessionId: `device${device}.${window}`, focused: false, alwaysOnTop: false, incognito: false, tabs: [] }
      }))
    }))

    fixture.controls.setDevices(devices)

    for (const maxResults of [undefined, 0, 1, 24, 25]) {
      const listed = yield* (maxResults === undefined ? sessions.getDevices() : sessions.getDevices({ maxResults }))
      expect(listed).toHaveLength(1000)
      expect(listed.every((device) => device.sessions.length === (maxResults ?? MAX_SESSION_RESULTS))).toBe(true)
      expect(listed[999]?.sessions.at(-1)?.window?.sessionId).toBe(maxResults === 0 ? undefined : `device999.${(maxResults ?? 25) - 1}`)
    }

    const restored = yield* Effect.all(Array.from({ length: 1000 }, (_, device) => sessions.restore(`device${device}.29`)), { concurrency: "unbounded" })
    expect(new Set(restored.map((session) => session.window?.id)).size).toBe(1000)
    expect(yield* sessions.getDevices({ maxResults: 25 })).toHaveLength(1000)
  }))
})
