// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Deferred, Effect, Exit, Fiber, Result, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChromeOmniboxError, inputChanged, make } from "../../src/ChromeOmnibox.js"
import type { ChromeOmniboxApi, ChromeOmniboxService, Disposition, SuggestResult } from "../../src/ChromeOmnibox.js"
import type { EventSource } from "../../src/internal/event.js"
import { makeOmnibox } from "../../src/testing/Omnibox.js"

/** mulberry32: a deterministic generator so every run churns in the same order. */
const seeded = (seed: number) => {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <A>(items: ReadonlyArray<A>, random: () => number): A => {
  const item = items[Math.floor(random() * items.length)]

  if (item === undefined) throw new Error("pick from an empty list")

  return item
}

const shuffle = <A>(items: ReadonlyArray<A>, random: () => number): Array<A> => {
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

const range = (start: number, end: number) => Array.from({ length: end - start }, (_, index) => start + index)

const burst = 4096

const capacity = 64

const dispositions: ReadonlyArray<Disposition> = ["currentTab", "newForegroundTab", "newBackgroundTab"]

type Fake = ReturnType<typeof makeOmnibox>

type EventName = "onInputStarted" | "onInputChanged" | "onInputEntered" | "onInputCancelled" | "onDeleteSuggestion"

interface EventCase {
  readonly name: EventName
  readonly stream: (omnibox: ChromeOmniboxService) => Stream.Stream<string, ChromeOmniboxError>
  readonly emit: (fake: Fake, index: number) => void
  readonly expected: (index: number) => string
}

const events: ReadonlyArray<EventCase> = [
  {
    name: "onInputStarted",
    stream: (omnibox) => Stream.map(omnibox.onInputStarted, () => "started"),
    emit: (fake) => { fake.controls.onInputStarted.emit() },
    expected: () => "started"
  },
  {
    name: "onInputChanged",
    stream: (omnibox) => Stream.map(omnibox.onInputChanged, (change) => change.text),
    emit: (fake, index) => { fake.controls.change(`q${index}`) },
    expected: (index) => `q${index}`
  },
  {
    name: "onInputEntered",
    stream: (omnibox) => Stream.map(omnibox.onInputEntered, (entry) => `${entry.text}@${entry.disposition}`),
    emit: (fake, index) => { fake.controls.onInputEntered.emit(`q${index}`, dispositions[index % 3] ?? "currentTab") },
    expected: (index) => `q${index}@${dispositions[index % 3] ?? "currentTab"}`
  },
  {
    name: "onInputCancelled",
    stream: (omnibox) => Stream.map(omnibox.onInputCancelled, () => "cancelled"),
    emit: (fake) => { fake.controls.onInputCancelled.emit() },
    expected: () => "cancelled"
  },
  {
    name: "onDeleteSuggestion",
    stream: (omnibox) => omnibox.onDeleteSuggestion,
    emit: (fake, index) => { fake.controls.onDeleteSuggestion.emit(`docs ${index}`) },
    expected: (index) => `docs ${index}`
  }
]

const listenerTotal = (fake: Fake) => events.reduce((total, { name }) => total + fake.controls[name].listenerCount, 0)

/**
 * Wraps every event of a fixture: counts successful registrations so a test can wait for them,
 * and can make the next registrations add their listener and then throw.
 */
const instrument = (fake: Fake) => {
  const added = new Map<EventName, number>()
  const owedPartial = new Map<EventName, number>()
  const partialCause = new Map<EventName, Error>(events.map(({ name }) => [name, new Error(`${name} registered, then threw`)]))
  const waiting: Array<{ readonly name: EventName, readonly target: number, readonly resolve: () => void }> = []

  const wrap = (name: EventName) => <Args extends ReadonlyArray<unknown>>(source: EventSource<Args>): EventSource<Args> => ({
    addListener: (listener) => {
      source.addListener(listener)
      const owed = owedPartial.get(name) ?? 0

      if (owed > 0) {
        owedPartial.set(name, owed - 1)
        throw partialCause.get(name)
      }

      const count = (added.get(name) ?? 0) + 1
      added.set(name, count)

      for (const waiter of waiting.filter((each) => each.name === name && count >= each.target)) waiter.resolve()
    },
    removeListener: (listener) => { source.removeListener(listener) }
  })

  const api: ChromeOmniboxApi = {
    setDefaultSuggestion: (suggestion) => fake.api.setDefaultSuggestion(suggestion),
    onInputStarted: wrap("onInputStarted")(fake.api.onInputStarted),
    onInputChanged: wrap("onInputChanged")(fake.api.onInputChanged),
    onInputEntered: wrap("onInputEntered")(fake.api.onInputEntered),
    onInputCancelled: wrap("onInputCancelled")(fake.api.onInputCancelled),
    onDeleteSuggestion: wrap("onDeleteSuggestion")(fake.api.onDeleteSuggestion)
  }

  return {
    api,
    partialCause,
    added: (name: EventName) => added.get(name) ?? 0,
    owePartial: (name: EventName, count: number) => { owedPartial.set(name, (owedPartial.get(name) ?? 0) + count) },
    registered: (name: EventName, target: number): Promise<void> => (added.get(name) ?? 0) >= target
      ? Promise.resolve()
      : new Promise((resolve) => { waiting.push({ name, target, resolve }) })
  }
}

describe("ChromeOmnibox stress", () => {
  for (const event of events) {
    it.effect(`${event.name}: keeps exactly the newest ${capacity} of a ${burst}-event burst, in order`, () => Effect.gen(function*() {
      const fake = makeOmnibox()
      const controls = fake.controls[event.name]
      const omnibox = make(fake.api)
      const newest = range(burst - capacity, burst).map(event.expected)

      yield* Effect.scoped(Effect.gen(function*() {
        const pull = yield* Stream.toPull(event.stream(omnibox))
        yield* Effect.promise(() => controls.waitForListener())

        for (const index of range(0, burst)) event.emit(fake, index)
        expect(yield* pull).toEqual(newest)
        const next = yield* Effect.forkChild(pull)
        event.emit(fake, burst)
        expect(yield* Fiber.join(next)).toEqual([event.expected(burst)])
        expect(controls.listenerCount).toBe(1)
      }))
      expect(controls.listenerCount).toBe(0)

      const collected = yield* Effect.forkChild(Stream.runCollect(Stream.take(event.stream(omnibox), capacity)))
      yield* Effect.promise(() => controls.waitForListener())

      for (const index of range(0, burst)) event.emit(fake, index)
      expect(yield* Fiber.join(collected)).toEqual(newest)
      expect(controls.listenerCount).toBe(0)
      expect(listenerTotal(fake)).toBe(0)
    }))
  }

  it.effect("answers only the surviving keystrokes of a burst, each through its own callback", () => Effect.gen(function*() {
    const fake = makeOmnibox()
    const batches: Array<ReadonlyArray<ReadonlyArray<SuggestResult>>> = []

    const answered = yield* Effect.forkChild(make(fake.api).onInputChanged.pipe(
      Stream.take(capacity),
      Stream.mapEffect((change) => change.suggest([{ content: change.text, description: `Result for ${change.text}` }]), { concurrency: 16 }),
      Stream.runDrain
    ))

    yield* Effect.promise(() => fake.controls.onInputChanged.waitForListener())

    for (const index of range(0, burst)) batches.push(fake.controls.change(`q${index}`))
    yield* Fiber.join(answered)
    expect(fake.controls.onInputChanged.listenerCount).toBe(0)

    batches.forEach((batch, index) => {
      expect(batch).toEqual(index < burst - capacity ? [] : [[{ content: `q${index}`, description: `Result for q${index}` }]])
    })
  }))

  it.effect("churns 512 subscriptions, interrupted at every stage, down to zero listeners", () => Effect.gen(function*() {
    const random = seeded(0x5eed0512)
    const fake = makeOmnibox()
    const probe = instrument(fake)
    const omnibox = make(probe.api)
    const stages = ["beforeStart", "registered", "inHandler", "betweenEvents", "completed", "rejected", "partial"] as const

    type Stage = typeof stages[number]

    const subscriptions = range(0, 512).map((id) => ({ id, stage: pick(stages, random), event: pick(events, random) }))
    const failureCause = new Map<EventName, Error>(events.map(({ name }) => [name, new Error(`${name} refused`)]))
    let emission = 0

    /** Call before forking a wave; the returned Effect waits until all of its listeners are registered. */
    const registrationOf = (wave: ReadonlyArray<{ readonly event: EventCase }>) => {
      const targets = events.map((event) => ({ event, target: probe.added(event.name) + wave.filter((each) => each.event === event).length }))

      return Effect.forEach(targets, ({ event, target }) => Effect.promise(() => probe.registered(event.name, target)), { discard: true })
    }

    const emitOnce = (wave: ReadonlyArray<{ readonly event: EventCase }>) => {
      for (const event of events.filter((each) => wave.some((subscription) => subscription.event === each))) {
        event.emit(fake, emission)
        emission += 1
      }
    }

    const runWave = (stage: Stage) => Effect.gen(function*() {
      const wave = subscriptions.filter((each) => each.stage === stage)
      const registered = registrationOf(wave)

      switch (stage) {
        case "beforeStart": {
          const fibers = yield* Effect.forEach(wave, ({ event }) => Effect.forkChild(Stream.runDrain(event.stream(omnibox))))

          for (const fiber of shuffle(fibers, random)) {
            yield* Fiber.interrupt(fiber)
            expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
          }

          break
        }

        case "registered": {
          const fibers = yield* Effect.forEach(wave, ({ event }) => Effect.forkChild(Stream.runDrain(event.stream(omnibox))))
          yield* registered

          for (const fiber of shuffle(fibers, random)) yield* Fiber.interrupt(fiber)

          break
        }

        case "inHandler":
        case "betweenEvents": {
          const running = yield* Effect.forEach(wave, ({ event }) => Effect.gen(function*() {
            const received = yield* Deferred.make<void>()

            const handle = () => stage === "inHandler"
              ? Deferred.succeed(received, undefined).pipe(Effect.andThen(Effect.never))
              : Deferred.succeed(received, undefined)

            const fiber = yield* Effect.forkChild(Stream.runForEach(event.stream(omnibox), handle))

            return { fiber, received }
          }))

          yield* registered
          emitOnce(wave)
          yield* Effect.forEach(running, ({ received }) => Deferred.await(received), { discard: true })

          for (const { fiber } of shuffle(running, random)) {
            yield* Fiber.interrupt(fiber)
            expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
          }

          break
        }

        case "completed": {
          const fibers = yield* Effect.forEach(wave, ({ event }) => Effect.forkChild(Stream.runCollect(Stream.take(event.stream(omnibox), 1))))
          yield* registered
          const first = emission
          emitOnce(wave)

          for (const [index, fiber] of fibers.entries()) {
            const subscription = wave[index]

            if (subscription === undefined) continue
            const offset = events.filter((each) => wave.some((other) => other.event === each)).indexOf(subscription.event)
            expect(yield* Fiber.join(fiber)).toEqual([subscription.event.expected(first + offset)])
          }

          break
        }

        case "rejected": {
          for (const { event } of wave) fake.controls[event.name].failNext("addListener", failureCause.get(event.name))
          const errors = yield* Effect.forEach(wave, ({ event }) => Effect.flip(Stream.runDrain(event.stream(omnibox))), { concurrency: "unbounded" })

          errors.forEach((error, index) => {
            const name = wave[index]?.event.name
            expect(error).toBeInstanceOf(ChromeOmniboxError)
            expect(error).toMatchObject({ operation: name, cause: name === undefined ? undefined : failureCause.get(name) })
          })

          break
        }

        case "partial": {
          for (const { event } of wave) probe.owePartial(event.name, 1)
          const errors = yield* Effect.forEach(wave, ({ event }) => Effect.flip(Stream.runDrain(event.stream(omnibox))), { concurrency: "unbounded" })

          errors.forEach((error, index) => {
            const name = wave[index]?.event.name
            expect(error).toMatchObject({ operation: name, cause: name === undefined ? undefined : probe.partialCause.get(name) })
          })

          break
        }
      }

      expect(listenerTotal(fake)).toBe(0)

      return wave.length
    })

    const counts = yield* Effect.forEach(shuffle(stages, random), runWave)
    expect(counts.reduce((total, count) => total + count, 0)).toBe(512)
    expect(counts.every((count) => count > 0)).toBe(true)
    expect(listenerTotal(fake)).toBe(0)
  }))

  it.effect("settles 1,536 concurrent setDefaultSuggestion calls out of order with the right typed errors", () => Effect.gen(function*() {
    const total = 1536
    const random = seeded(0xdef0)
    const outcomes = range(0, total).map(() => pick(["resolve", "reject", "throw"] as const, random))
    const settle = new Map<number, () => void>()
    const causes = new Map<number, Error>()
    let invoked = 0
    let allInvoked!: () => void
    const everyCall = new Promise<void>((resolve) => { allInvoked = resolve })

    const omnibox = make({
      ...makeOmnibox().api,
      setDefaultSuggestion: (suggestion) => {
        const index = Number(suggestion.description)
        invoked += 1

        if (invoked === total) allInvoked()

        const outcome = outcomes[index]

        if (outcome === "throw") {
          const cause = new TypeError(`throw ${index}`)
          causes.set(index, cause)
          throw cause
        }

        return new Promise<void>((resolve, reject) => {
          settle.set(index, () => {
            if (outcome === "resolve") return resolve()

            const cause = new Error(`reject ${index}`)
            causes.set(index, cause)
            reject(cause)
          })
        })
      }
    })

    const calls = yield* Effect.forkChild(Effect.forEach(
      range(0, total),
      (index) => Effect.result(omnibox.setDefaultSuggestion({ description: String(index) })),
      { concurrency: "unbounded" }
    ))

    yield* Effect.promise(() => everyCall)

    for (const index of shuffle([...settle.keys()], random)) settle.get(index)?.()
    const results = yield* Fiber.join(calls)
    expect(new Set(outcomes)).toEqual(new Set(["resolve", "reject", "throw"]))

    results.forEach((result, index) => {
      if (outcomes[index] === "resolve") return expect(Result.isSuccess(result)).toBe(true)

      if (Result.isSuccess(result)) return expect.fail(`call ${index} should have failed`)
      expect(result.failure).toBeInstanceOf(ChromeOmniboxError)
      expect(result.failure.operation).toBe("setDefaultSuggestion")
      expect(result.failure.cause).toBe(causes.get(index))
    })
  }))

  it.effect("interrupts 512 pending setDefaultSuggestion calls, then absorbs Chrome settling them late", () => Effect.gen(function*() {
    const total = 512
    const random = seeded(0x1a7e)
    const settle: Array<() => void> = []
    const pending: Array<Promise<void>> = []
    let allInvoked!: () => void
    const everyCall = new Promise<void>((resolve) => { allInvoked = resolve })

    const omnibox = make({
      ...makeOmnibox().api,
      setDefaultSuggestion: (suggestion) => {
        const call = new Promise<void>((resolve, reject) => {
          settle.push(() => random() < 0.5 ? resolve() : reject(new Error(`late ${suggestion.description}`)))
        })

        pending.push(call)

        if (pending.length === total) allInvoked()

        return call
      }
    })

    const calls = yield* Effect.forkChild(Effect.forEach(
      range(0, total),
      (index) => omnibox.setDefaultSuggestion({ description: `d${index}` }),
      { concurrency: "unbounded" }
    ))

    yield* Effect.promise(() => everyCall)
    const exit = yield* Fiber.interrupt(calls).pipe(Effect.andThen(Fiber.await(calls)))
    expect(Exit.hasInterrupts(exit)).toBe(true)
    expect(Exit.hasFails(exit)).toBe(false)
    expect(Exit.hasDies(exit)).toBe(false)

    for (const run of shuffle(settle, random)) run()
    const settled = yield* Effect.promise(() => Promise.allSettled(pending))
    expect(settled.filter(({ status }) => status === "rejected").length).toBeGreaterThan(0)
    expect(settled.filter(({ status }) => status === "fulfilled").length).toBeGreaterThan(0)
    expect(pending).toHaveLength(total)
  }))

  it.effect("runs 2,048 concurrent suggest calls with interleaved throws, each typed as suggest", () => Effect.gen(function*() {
    const total = 2048
    const random = seeded(0x5106)
    const throws = range(0, total).map(() => random() < 0.4)
    const sent = new Map<number, ReadonlyArray<SuggestResult>>()
    const causes = new Map<number, Error>()
    const fake = makeOmnibox()
    const changes = yield* Effect.forkChild(Stream.runCollect(Stream.take(make(fake.api).onInputChanged, 1)))
    yield* Effect.promise(() => fake.controls.onInputChanged.waitForListener())

    // One keystroke's suggest callback, answered by every caller at once.
    fake.controls.onInputChanged.emit("shared", (suggestResults) => {
      const index = Number(suggestResults[0]?.content)

      if (throws[index] === true) {
        const cause = new Error(`suggest ${index}`)
        causes.set(index, cause)
        throw cause
      }

      sent.set(index, suggestResults)
    })

    const [shared] = yield* Fiber.join(changes)

    if (shared === undefined) return expect.fail("no keystroke")

    const wakeChanges = range(0, total).map((index) => inputChanged(`wake ${index}`, (suggestResults) => {
      if (throws[index] === true) throw new Error(`wake ${index}`)

      sent.set(total + index, suggestResults)
    }))

    const results = yield* Effect.forEach(range(0, total), (index) => Effect.all([
      Effect.result(shared.suggest([{ content: String(index), description: `Row ${index}` }])),
      Effect.result(wakeChanges[index]?.suggest([{ content: `wake ${index}`, description: "Wake" }]) ?? Effect.void)
    ]), { concurrency: "unbounded" })

    results.forEach(([fromStream, fromWake], index) => {
      for (const result of [fromStream, fromWake]) {
        if (throws[index] !== true) return expect(Result.isSuccess(result)).toBe(true)

        if (Result.isSuccess(result)) return expect.fail(`suggest ${index} should have failed`)
        expect(result.failure).toBeInstanceOf(ChromeOmniboxError)
        expect(result.failure.operation).toBe("suggest")
      }

      if (Result.isFailure(fromStream)) expect(fromStream.failure.cause).toBe(causes.get(index))
    })
    expect(sent.size).toBe(throws.filter((each) => !each).length * 2)
  }))

  it.effect("interrupts 255 stale lookups with switchMap and answers only the newest keystroke", () => Effect.gen(function*() {
    const keystrokes = 256
    const fake = makeOmnibox()
    const started = yield* Effect.forEach(range(0, keystrokes), () => Deferred.make<void>())
    const release = yield* Deferred.make<void>()
    const answered = yield* Deferred.make<string>()
    let interrupted = 0

    const lookups = yield* Effect.forkChild(make(fake.api).onInputChanged.pipe(
      Stream.take(keystrokes),
      Stream.switchMap((change) => Stream.fromEffect(Effect.gen(function*() {
        const index = Number(change.text.slice(1))
        yield* Deferred.succeed(started[index] ?? release, undefined)
        yield* Deferred.await(release)
        yield* change.suggest([{ content: change.text, description: `Result for ${change.text}` }])
        yield* Deferred.succeed(answered, change.text)
      }).pipe(Effect.onInterrupt(() => Effect.sync(() => { interrupted += 1 }))))),
      Stream.runDrain
    ))

    yield* Effect.promise(() => fake.controls.onInputChanged.waitForListener())
    const batches: Array<ReadonlyArray<ReadonlyArray<SuggestResult>>> = []

    for (const index of range(0, keystrokes)) {
      batches.push(fake.controls.change(`q${index}`))
      yield* Deferred.await(started[index] ?? release)
    }

    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(lookups)
    expect(yield* Deferred.await(answered)).toBe(`q${keystrokes - 1}`)
    expect(interrupted).toBe(keystrokes - 1)
    expect(batches.slice(0, -1).every((batch) => batch.length === 0)).toBe(true)
    expect(batches.at(-1)).toEqual([[{ content: `q${keystrokes - 1}`, description: `Result for q${keystrokes - 1}` }]])
    expect(fake.controls.onInputChanged.listenerCount).toBe(0)
  }))

  it.effect("collects the batches of 256 concurrent subscribers and copies a 10,000-row batch intact", () => Effect.gen(function*() {
    const subscribers = 256
    const fake = makeOmnibox()
    const counted = instrument(fake)
    const omnibox = make(counted.api)

    const fibers = yield* Effect.forEach(range(0, subscribers), (subscriber) => Effect.forkChild(omnibox.onInputChanged.pipe(
      Stream.take(1),
      Stream.mapEffect((change) => change.suggest([{ content: `${change.text} ${subscriber}`, description: `Subscriber ${subscriber}` }])),
      Stream.runDrain
    )))

    yield* Effect.promise(() => counted.registered("onInputChanged", subscribers))
    const batches = fake.controls.change("docs")
    yield* Fiber.joinAll(fibers)
    expect(batches).toHaveLength(subscribers)
    const contents = new Set(batches.map((batch) => batch[0]?.content))
    expect(contents).toEqual(new Set(range(0, subscribers).map((subscriber) => `docs ${subscriber}`)))
    expect(fake.controls.onInputChanged.listenerCount).toBe(0)

    const rows = range(0, 10_000).map((index) => ({ content: `row ${index}`, description: `<dim>${index}</dim> &amp; more`, deletable: index % 2 === 0 }))
    const large = yield* Effect.forkChild(Stream.runCollect(Stream.take(omnibox.onInputChanged, 1)))
    yield* Effect.promise(() => counted.registered("onInputChanged", subscribers + 1))
    const largeBatches = fake.controls.change("large")
    const [change] = yield* Fiber.join(large)
    yield* change?.suggest(rows) ?? Effect.void
    rows[0] = { content: "mutated", description: "mutated", deletable: false }
    expect(largeBatches).toHaveLength(1)
    expect(largeBatches[0]).toHaveLength(10_000)
    expect(largeBatches[0]?.[0]).toEqual({ content: "row 0", description: "<dim>0</dim> &amp; more", deletable: true })
    expect(largeBatches[0]?.[9_999]).toEqual({ content: "row 9999", description: "<dim>9999</dim> &amp; more", deletable: false })
  }))

  it.effect("keeps the last accepted default suggestion across 1,024 racing valid and invalid calls", () => Effect.gen(function*() {
    const total = 1024
    const random = seeded(0xd1ff)
    const fake = makeOmnibox()
    const order: Array<number> = []
    const valid = range(0, total).map(() => random() < 0.7)

    const omnibox = make({
      ...fake.api,
      setDefaultSuggestion: (suggestion) => {
        order.push(Number(/\d+/.exec(suggestion.description)?.[0]))

        return fake.api.setDefaultSuggestion(suggestion)
      }
    })

    const description = (index: number) => valid[index] === true ? `<match>${index}</match>` : `<match>${index}`

    const results = yield* Effect.forEach(
      shuffle(range(0, total), random),
      (index) => Effect.map(Effect.result(omnibox.setDefaultSuggestion({ description: description(index) })), (result) => ({ index, result })),
      { concurrency: "unbounded" }
    )

    for (const { index, result } of results) {
      expect(Result.isSuccess(result)).toBe(valid[index])

      if (Result.isFailure(result)) expect(result.failure).toMatchObject({ operation: "setDefaultSuggestion" })
    }

    expect(order).toHaveLength(total)
    const lastValid = order.filter((index) => valid[index] === true).at(-1)
    expect(fake.controls.defaultSuggestion).toEqual({ description: `<match>${lastValid}</match>` })
  }))

  it.effect("delivers an event dispatched inside registration and drops one dispatched inside removal, 512 times", () => Effect.gen(function*() {
    const rounds = 512
    const fake = makeOmnibox()
    const bystander: Array<string> = []
    let listenerThrows = 0
    fake.api.onDeleteSuggestion.addListener((text) => { bystander.push(text) })

    const omnibox = make({
      ...fake.api,
      onDeleteSuggestion: {
        addListener: (listener) => {
          fake.api.onDeleteSuggestion.addListener(listener)
          listenerThrows += fake.controls.onDeleteSuggestion.emit("during add").length
        },
        removeListener: (listener) => {
          listenerThrows += fake.controls.onDeleteSuggestion.emit("during remove").length
          fake.api.onDeleteSuggestion.removeListener(listener)
        }
      }
    })

    const seen: Array<string> = []

    for (const round of range(0, rounds)) {
      const [text] = yield* Stream.runCollect(Stream.take(omnibox.onDeleteSuggestion, 1))
      seen.push(`${round}:${text}`)
    }

    expect(seen).toEqual(range(0, rounds).map((round) => `${round}:during add`))
    expect(bystander).toEqual(range(0, rounds).flatMap(() => ["during add", "during remove"]))
    expect(listenerThrows).toBe(0)
    expect(fake.controls.onDeleteSuggestion.listenerCount).toBe(1)
  }))
})
