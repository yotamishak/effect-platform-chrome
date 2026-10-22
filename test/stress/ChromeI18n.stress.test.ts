// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeI18n, ChromeI18nError, layerLive, make } from "../../src/ChromeI18n.js"
import type { ChromeI18nApi, LanguageDetection } from "../../src/ChromeI18n.js"
import { makeI18n, replacePlaceholders } from "../../src/testing/I18n.js"
import type { MessageCatalog } from "../../src/testing/I18n.js"

// chrome.i18n has no events, so the stress cases are calls, interruption and the fixture's text engine.

/** mulberry32: a small deterministic generator, so every run sees the same interleaving. */
const seeded = (seed: number) => {
  let state = seed >>> 0

  return (bound: number): number => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * bound)
  }
}

const shuffle = <A>(values: ReadonlyArray<A>, random: (bound: number) => number): Array<A> => {
  const copy = Array.from(values)

  for (let index = copy.length - 1; index > 0; index--) {
    const other = random(index + 1)
    const value = copy[index]
    const swapped = copy[other]

    if (value !== undefined && swapped !== undefined) {
      copy[index] = swapped
      copy[other] = value
    }
  }

  return copy
}

interface Pending<A> {
  readonly resolve: (value: A) => void
  readonly reject: (cause: Error) => void
}

const pendingPromise = <A>(pending: Array<Pending<A>>) => new Promise<A>((resolve, reject) => {
  pending.push({ resolve, reject })
})

/** Resolves once `expected` calls have reached Chrome; a native-boundary gate, not a sleep. */
const callGate = (expected: number) => {
  let calls = 0
  let open: () => void = () => {}

  const reached = new Promise<void>((resolve) => { open = resolve })

  if (expected === 0) open()

  return {
    reached,
    count: () => {
      calls++

      if (calls === expected) open()
    }
  }
}

const detected = (index: number): LanguageDetection => ({ isReliable: true, languages: [{ language: `l${index}`, percentage: index % 101 }] })

const failureOf = <A>(exit: Exit.Exit<A, ChromeI18nError>): ChromeI18nError | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined

/**
 * An independent reference for Chrome's substitution: a regular expression over the UTF-8
 * bytes held as a binary string, rather than the fixture's byte loop.
 */
const referenceReplace = (message: string, substitutions: ReadonlyArray<string>): string => {
  const encoder = new TextEncoder()
  const binary = (text: string) => Array.from(encoder.encode(text), (byte) => String.fromCharCode(byte)).join("")
  const values = substitutions.map(binary)

  const replaced = binary(message).replace(/\$(?:(\$+)|([1-9])|[\s\S]|$)/g, (_match, dollars?: string, digit?: string) =>
    dollars ?? (digit === undefined ? "" : values[Number(digit) - 1] ?? ""))

  return new TextDecoder().decode(Uint8Array.from(replaced, (character) => character.charCodeAt(0)))
}

describe("ChromeI18n stress", () => {
  it.effect("types 4,096 concurrent calls with interleaved results, throws, rejections and malformed answers", () => Effect.gen(function*() {
    const random = seeded(0x18A)
    const total = 4096
    const gate = callGate(total)
    const pendingLanguages: Array<Pending<Array<string>>> = []
    const pendingDetections: Array<Pending<LanguageDetection>> = []
    const uiOutcomes: Array<number> = []
    const acceptOutcomes: Array<number> = []
    const causes = Array.from({ length: total }, (_, index) => new Error(`cause ${index}`))
    // Per call: the operation, then 0 = success, 1 = synchronous throw, 2 = rejection or malformed answer, 3 = missing message.
    const plan = Array.from({ length: total }, () => ({ operation: random(4), outcome: random(4) }))

    const api: ChromeI18nApi = {
      getMessage: (messageName, substitutions) => {
        gate.count()
        const index = Number(messageName.slice(1))
        const outcome = plan[index]?.outcome

        if (outcome === 1) throw causes[index]

        if (outcome === 2) return undefined

        return outcome === 3 ? "" : `message ${index} ${String(substitutions)}`
      },
      getUILanguage: () => {
        gate.count()
        const index = uiOutcomes.shift() ?? -1

        if (plan[index]?.outcome === 1) throw causes[index]

        return `ui-${index}`
      },
      getAcceptLanguages: () => {
        gate.count()
        const index = acceptOutcomes.shift() ?? -1

        if (plan[index]?.outcome === 1) throw causes[index]

        return pendingPromise(pendingLanguages).then((languages) => {
          if (plan[index]?.outcome === 2) throw causes[index]

          return [...languages, `accept-${index}`]
        })
      },
      detectLanguage: (text) => {
        gate.count()
        const index = Number(text.slice(1))

        if (plan[index]?.outcome === 1) throw causes[index]

        return pendingPromise(pendingDetections).then((detection) => {
          if (plan[index]?.outcome === 2) throw causes[index]

          return detection.languages.length === 0 ? detected(index) : detection
        })
      }
    }

    const i18n = make(api)
    const operations = ["getMessage", "getUILanguage", "getAcceptLanguages", "detectLanguage"] as const

    plan.forEach(({ operation }, index) => {
      if (operation === 1) uiOutcomes.push(index)

      if (operation === 2) acceptOutcomes.push(index)
    })

    const calls = plan.map(({ operation }, index): Effect.Effect<unknown, ChromeI18nError> => {
      switch (operation) {
        case 0: return i18n.getMessage(`m${index}`, [index, "x"])
        case 1: return i18n.getUILanguage
        case 2: return i18n.getAcceptLanguages
        default: return i18n.detectLanguage(`t${index}`)
      }
    })

    const fiber = yield* Effect.forkChild(Effect.forEach(calls, Effect.exit, { concurrency: "unbounded" }))
    yield* Effect.promise(() => gate.reached)

    for (const pending of shuffle(pendingLanguages, random)) pending.resolve(["en"])

    for (const pending of shuffle(pendingDetections, random)) pending.resolve({ isReliable: false, languages: [] })

    const exits = yield* Fiber.join(fiber)
    const uiResults = new Set<unknown>()
    const acceptResults = new Set<unknown>()
    const zeroArgumentCauses = new Set<unknown>()
    let failures = 0

    exits.forEach((exit, index) => {
      const { operation, outcome } = plan[index] ?? { operation: -1, outcome: -1 }
      const name = operations[operation] ?? "unknown"
      const error = failureOf(exit)
      const keyed = operation === 0 || operation === 3

      if (error !== undefined) {
        failures++
        expect(error).toBeInstanceOf(ChromeI18nError)
        expect(error.operation).toBe(name)

        if (keyed) {
          if (operation === 0 && outcome === 2) expect(String(error.cause)).toContain("more than 9 substitutions")
          else expect(error.cause).toBe(causes[index])
        } else {
          zeroArgumentCauses.add(error.cause)
        }

        return
      }

      expect(Exit.isSuccess(exit)).toBe(true)

      if (!Exit.isSuccess(exit)) return

      if (operation === 0) expect(exit.value).toEqual(outcome === 3 ? Option.none() : Option.some(`message ${index} ${index},x`))

      if (operation === 1) uiResults.add(exit.value)

      if (operation === 2) acceptResults.add(String(exit.value))

      if (operation === 3) expect(exit.value).toEqual(detected(index))
    })

    const expectedFailures = plan.filter(({ operation, outcome }) => outcome === 1 || (outcome === 2 && operation !== 1)).length
    expect(failures).toBe(expectedFailures)
    // Zero-argument calls cannot be told apart, so each planned result and cause must appear exactly once.
    const zeroArgument = plan.flatMap(({ operation, outcome }, index) => operation === 1 || operation === 2 ? [{ operation, outcome, index }] : [])
    expect(uiResults).toEqual(new Set(zeroArgument.flatMap(({ operation, outcome, index }) => operation === 1 && outcome !== 1 ? [`ui-${index}`] : [])))
    expect(acceptResults).toEqual(new Set(zeroArgument.flatMap(({ operation, outcome, index }) => operation === 2 && outcome !== 1 && outcome !== 2 ? [`en,accept-${index}`] : [])))
    expect(zeroArgumentCauses).toEqual(new Set(zeroArgument.flatMap(({ operation, outcome, index }) =>
      outcome === 1 || (operation === 2 && outcome === 2) ? [causes[index]] : [])))
    expect(uiOutcomes).toEqual([])
    expect(acceptOutcomes).toEqual([])
  }))

  it.effect("interrupts 1,024 detections before the call, while pending and after completion", () => Effect.gen(function*() {
    const random = seeded(0xC1D3)
    const total = 1024
    // 0 = interrupted before calling Chrome, 1 = interrupted while pending, 2 = interrupted after completing, 3 = left alone.
    const stages = Array.from({ length: total }, () => random(4))
    const rejects = Array.from({ length: total }, () => random(2) === 0)
    const called = stages.filter((stage) => stage !== 0).length
    const gate = callGate(called)
    const pending = new Map<number, Pending<LanguageDetection>>()

    const detectLanguage = vi.fn((text: string) => {
      gate.count()

      return new Promise<LanguageDetection>((resolve, reject) => {
        pending.set(Number(text), { resolve, reject })
      })
    })

    const i18n = make({ ...makeI18n().api, detectLanguage })
    const hold = yield* Deferred.make<void>()
    const go = yield* Deferred.make<void>()

    const fibers = yield* Effect.forEach(stages, (stage, index) => Effect.forkChild(
      Deferred.await(stage === 0 ? hold : go).pipe(Effect.andThen(i18n.detectLanguage(String(index))))
    ))

    yield* Effect.forEach(fibers, (fiber, index) => stages[index] === 0 ? Fiber.interrupt(fiber) : Effect.void, { discard: true })
    yield* Deferred.succeed(go, undefined)
    yield* Effect.promise(() => gate.reached)
    yield* Effect.forEach(fibers, (fiber, index) => stages[index] === 1 ? Fiber.interrupt(fiber) : Effect.void, { discard: true })

    // Settle every outstanding call in a seeded order, rejecting half: late rejections of
    // interrupted calls must be absorbed rather than surface as unhandled.
    for (const index of shuffle(Array.from(pending.keys()), random)) {
      const settle = pending.get(index)

      if (rejects[index] === true) settle?.reject(new Error(`rejected ${index}`))
      else settle?.resolve(detected(index))
    }

    const exits = yield* Effect.forEach(fibers, (fiber, index) => Effect.gen(function*() {
      if (stages[index] !== 2) return yield* Fiber.await(fiber)

      const exit = yield* Fiber.await(fiber)
      yield* Fiber.interrupt(fiber)

      return exit
    }))

    expect(detectLanguage).toHaveBeenCalledTimes(called)
    expect(new Set(detectLanguage.mock.calls.map(([text]) => Number(text)))).toEqual(new Set(stages.flatMap((stage, index) => stage === 0 ? [] : [index])))

    exits.forEach((exit, index) => {
      const stage = stages[index]

      if (stage === 0 || stage === 1) {
        expect(Exit.hasInterrupts(exit)).toBe(true)
        expect(failureOf(exit)).toBeUndefined()

        return
      }

      if (rejects[index] === true) {
        expect(failureOf(exit)).toMatchObject({ operation: "detectLanguage", cause: new Error(`rejected ${index}`) })
      } else {
        expect(Exit.isSuccess(exit) ? exit.value : exit).toEqual(detected(index))
      }
    })
  }))

  it.effect("serves a 4,096-message catalog with nine placeholders each to as many concurrent lookups", () => Effect.gen(function*() {
    const total = 4096
    const letters = ["A", "b", "C", "d", "E", "f", "G", "h", "I"]

    const catalog: MessageCatalog = Object.fromEntries(Array.from({ length: total }, (_, index) => [
      `Message_${index}`,
      {
        message: `#${index}: ${letters.map((letter) => `$${letter}$`).join(" ")} $$`,
        placeholders: Object.fromEntries(letters.map((letter, slot) => [letter.toLowerCase(), { content: `$${slot + 1}` }]))
      }
    ]))

    const fallback: MessageCatalog = { fallback_only: { message: "from default_locale" }, message_0: { message: "shadowed" } }
    const fixture = makeI18n({ messages: [catalog, fallback] })
    const i18n = make(fixture.api)
    const values = (index: number) => Array.from({ length: 9 }, (_, slot) => slot % 2 === 0 ? `${index}.${slot}` : index * 10 + slot)

    const results = yield* Effect.forEach(Array.from({ length: total }, (_, index) => index), (index) => {
      const spellings = [`MESSAGE_${index}`, `message_${index}`, `Message_${index}`]

      return i18n.getMessage(spellings[index % 3] ?? "", values(index))
    }, { concurrency: "unbounded" })

    results.forEach((result, index) => {
      expect(result).toEqual(Option.some(`#${index}: ${values(index).map(String).join(" ")} $`))
    })
    expect(yield* i18n.getMessage("fallback_only")).toEqual(Option.some("from default_locale"))
    expect(fixture.controls.message("message_0")).toBe("#0: $1 $2 $3 $4 $5 $6 $7 $8 $9 $$")

    const malformed = yield* Effect.forEach(Array.from({ length: 512 }, (_, index) => index), (index) =>
      Effect.flip(i18n.getMessage(`message_${index}`, Array.from({ length: 10 + index }, String))), { concurrency: "unbounded" })

    expect(malformed.every((error) => error.operation === "getMessage")).toBe(true)
  }))

  it.effect("matches an independent reference on 4,096 seeded templates, with and without escapeLt", () => Effect.gen(function*() {
    const random = seeded(0x5EED)
    const alphabet = ["$", "$", "$", "1", "5", "9", "0", "a", "<", " ", "é", "🌍"]
    const pieces = ["", "x", "$1", "<", "é", "🌍", "$$", "\uDC00"]

    const cases = Array.from({ length: 4096 }, () => ({
      template: Array.from({ length: random(24) }, () => alphabet[random(alphabet.length)] ?? "").join(""),
      substitutions: Array.from({ length: random(10) }, () => pieces[random(pieces.length)] ?? ""),
      escapeLt: random(2) === 0
    }))

    const results = yield* Effect.forEach(cases, ({ template, substitutions, escapeLt }) => {
      // As placeholder content the template is taken verbatim, without load-time `$name$` checks.
      const i18n = make(makeI18n({ messages: { fuzz: { message: "$template$", placeholders: { template: { content: template } } } } }).api)

      return i18n.getMessage("fuzz", substitutions, { escapeLt })
    })

    cases.forEach(({ template, substitutions, escapeLt }, index) => {
      expect(replacePlaceholders(template, substitutions)).toBe(referenceReplace(template, substitutions))
      const expected = referenceReplace(escapeLt ? template.replaceAll("<", "&lt;") : template, substitutions)
      expect(results[index]).toEqual(expected === "" ? Option.none() : Option.some(expected))
    })
  }))

  it.effect("builds 512 live layers concurrently from the global, and fails all of them without it", () => Effect.gen(function*() {
    const fixture = makeI18n({ uiLanguage: "he-IL" })
    const getUILanguage = vi.spyOn(fixture.api, "getUILanguage")
    const program = Effect.flatMap(ChromeI18n, (i18n) => i18n.getUILanguage).pipe(Effect.provide(layerLive))
    vi.stubGlobal("chrome", { i18n: fixture.api })
    const languages = yield* Effect.all(Array.from({ length: 512 }, () => program), { concurrency: "unbounded" })
    expect(new Set(languages)).toEqual(new Set(["he-IL"]))
    expect(getUILanguage).toHaveBeenCalledTimes(512)

    vi.stubGlobal("chrome", undefined)
    const errors = yield* Effect.all(Array.from({ length: 512 }, () => Effect.flip(Layer.build(layerLive))), { concurrency: "unbounded" })
    expect(errors.every((error) => error instanceof ChromeI18nError && error.operation === "initialize")).toBe(true)
  }))
})
