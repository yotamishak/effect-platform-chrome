// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Exit, Fiber, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeOmnibox, ChromeOmniboxError, inputChanged, layer, layerLive, make } from "../src/ChromeOmnibox.js"
import type { ChromeOmniboxApi, ChromeOmniboxService, DefaultSuggestResult, Disposition, SuggestResult } from "../src/ChromeOmnibox.js"
import type { EventSource } from "../src/internal/event.js"
import { makeOmnibox } from "../src/testing/Omnibox.js"

const results: ReadonlyArray<SuggestResult> = [
  { content: "docs effect", description: "Search docs for <match>effect</match>" },
  { content: "docs stream", description: "Search docs for <match>stream</match>", deletable: true }
]

const dispositions: ReadonlyArray<Disposition> = ["currentTab", "newForegroundTab", "newBackgroundTab"]

type Fake = ReturnType<typeof makeOmnibox>

type EventName = "onInputStarted" | "onInputChanged" | "onInputEntered" | "onInputCancelled" | "onDeleteSuggestion"

/** Replaces one event source of an API, keeping its listener types. */
type Rewire = (api: ChromeOmniboxApi, wrap: <Args extends ReadonlyArray<unknown>>(source: EventSource<Args>) => EventSource<Args>) => ChromeOmniboxApi

/** Each event, observed as strings so one table can drive every stream. */
interface EventCase {
  readonly name: EventName
  readonly stream: (omnibox: ChromeOmniboxService) => Stream.Stream<string, ChromeOmniboxError>
  readonly emit: (fake: Fake, index: number) => void
  readonly expected: (index: number) => string
  readonly rewire: Rewire
}

const events: ReadonlyArray<EventCase> = [
  {
    name: "onInputStarted",
    stream: (omnibox) => Stream.map(omnibox.onInputStarted, () => "started"),
    emit: (fake) => { fake.controls.onInputStarted.emit() },
    expected: () => "started",
    rewire: (api, wrap) => ({ ...api, onInputStarted: wrap(api.onInputStarted) })
  },
  {
    name: "onInputChanged",
    stream: (omnibox) => Stream.map(omnibox.onInputChanged, (change) => `changed:${change.text}`),
    emit: (fake, index) => { fake.controls.change(index === 0 ? "" : `q${index}`) },
    expected: (index) => `changed:${index === 0 ? "" : `q${index}`}`,
    rewire: (api, wrap) => ({ ...api, onInputChanged: wrap(api.onInputChanged) })
  },
  {
    name: "onInputEntered",
    stream: (omnibox) => Stream.map(omnibox.onInputEntered, (entry) => `${entry.text}@${entry.disposition}`),
    emit: (fake, index) => { fake.controls.onInputEntered.emit(`q${index}`, dispositions[index % 3] ?? "currentTab") },
    expected: (index) => `q${index}@${dispositions[index % 3] ?? "currentTab"}`,
    rewire: (api, wrap) => ({ ...api, onInputEntered: wrap(api.onInputEntered) })
  },
  {
    name: "onInputCancelled",
    stream: (omnibox) => Stream.map(omnibox.onInputCancelled, () => "cancelled"),
    emit: (fake) => { fake.controls.onInputCancelled.emit() },
    expected: () => "cancelled",
    rewire: (api, wrap) => ({ ...api, onInputCancelled: wrap(api.onInputCancelled) })
  },
  {
    name: "onDeleteSuggestion",
    stream: (omnibox) => omnibox.onDeleteSuggestion,
    emit: (fake, index) => { fake.controls.onDeleteSuggestion.emit(`docs ${index}`) },
    expected: (index) => `docs ${index}`,
    rewire: (api, wrap) => ({ ...api, onDeleteSuggestion: wrap(api.onDeleteSuggestion) })
  }
]

/** Rewires one event so a test can wait until its source has seen `target` registrations. */
const countRegistrations = (event: EventCase, fake: Fake) => {
  let added = 0
  const waiting: Array<{ readonly target: number, readonly resolve: () => void }> = []

  const api = event.rewire(fake.api, (source) => ({
    addListener: (listener) => {
      source.addListener(listener)
      added += 1

      for (const waiter of waiting.filter(({ target }) => added >= target)) waiter.resolve()
    },
    removeListener: (listener) => { source.removeListener(listener) }
  }))

  return {
    api,
    registered: (target: number): Promise<void> => added >= target
      ? Promise.resolve()
      : new Promise((resolve) => { waiting.push({ target, resolve }) })
  }
}

const listenerTotal = (fake: Fake) => events.reduce((total, { name }) => total + fake.controls[name].listenerCount, 0)

describe("ChromeOmnibox", () => {
  it.effect("passes the default suggestion's description to Chrome, only when run", () => Effect.gen(function*() {
    const fake = makeOmnibox()
    const setDefaultSuggestion = vi.fn((suggestion: DefaultSuggestResult) => fake.api.setDefaultSuggestion(suggestion))
    const omnibox = make({ ...fake.api, setDefaultSuggestion })
    const suggestion: DefaultSuggestResult = { description: "Search docs for <match>%s</match>" }
    const set = omnibox.setDefaultSuggestion(suggestion)
    expect(setDefaultSuggestion).not.toHaveBeenCalled()
    yield* set
    expect(setDefaultSuggestion).toHaveBeenCalledExactlyOnceWith(suggestion)
    expect(setDefaultSuggestion.mock.calls[0]?.[0]).toStrictEqual(suggestion)
    expect(fake.controls.defaultSuggestion).toEqual(suggestion)
    yield* set
    expect(setDefaultSuggestion).toHaveBeenCalledTimes(2)
  }))

  it.effect("types a rejected or throwing setDefaultSuggestion with its cause unchanged", () => Effect.gen(function*() {
    const rejection = new Error("Invalid description markup")
    const rejecting = make(makeOmnibox({ setDefaultSuggestion: vi.fn(async () => { throw rejection }) }).api)
    const rejected = yield* Effect.flip(rejecting.setDefaultSuggestion({ description: "<b>" }))
    expect(rejected).toBeInstanceOf(ChromeOmniboxError)
    expect(rejected).toMatchObject({ operation: "setDefaultSuggestion", cause: rejection })
    const thrown = new TypeError("Error in invocation of omnibox.setDefaultSuggestion")

    const throwing = make(makeOmnibox({
      setDefaultSuggestion: vi.fn((): Promise<void> => { throw thrown })
    }).api)

    const failed = yield* Effect.flip(throwing.setDefaultSuggestion({ description: "Docs" }))
    expect(failed).toBeInstanceOf(ChromeOmniboxError)
    expect(failed).toMatchObject({ operation: "setDefaultSuggestion", cause: thrown })
    expect(failed.cause).toBe(thrown)
    const literal = make(makeOmnibox({ setDefaultSuggestion: vi.fn(async () => { throw "quota" }) }).api)
    expect(yield* Effect.flip(literal.setDefaultSuggestion({ description: "Docs" }))).toMatchObject({ cause: "quota" })
  }))

  it.effect("creates the service without registering any listener", () => Effect.sync(() => {
    const fake = makeOmnibox()
    const omnibox = make(fake.api)
    expect(Object.keys(omnibox).sort()).toEqual([
      "onDeleteSuggestion", "onInputCancelled", "onInputChanged", "onInputEntered", "onInputStarted", "setDefaultSuggestion"
    ])
    expect(listenerTotal(fake)).toBe(0)
  }))

  it.effect("answers input changes through the event's own suggest callback", () => Effect.gen(function*() {
    const fake = makeOmnibox()

    const changes = yield* Effect.forkScoped(make(fake.api).onInputChanged.pipe(
      Stream.take(2),
      Stream.mapEffect((change) => Effect.as(change.suggest(results.filter((result) => result.content.endsWith(change.text))), change.text)),
      Stream.runCollect
    ))

    yield* Effect.promise(() => fake.controls.onInputChanged.waitForListener())
    const first = fake.controls.change("effect")
    const second = fake.controls.change("stream")
    expect(yield* Fiber.join(changes)).toEqual(["effect", "stream"])
    expect(first).toEqual([[results[0]]])
    expect(second).toEqual([[results[1]]])
    expect(fake.controls.onInputChanged.listenerCount).toBe(0)
  }))

  it.effect("sends a fresh mutable copy on every suggest call, empty lists included, only when run", () => Effect.gen(function*() {
    const fake = makeOmnibox()
    const sent: Array<Array<SuggestResult>> = []
    const changes = yield* Effect.forkScoped(Stream.runCollect(Stream.take(make(fake.api).onInputChanged, 1)))
    yield* Effect.promise(() => fake.controls.onInputChanged.waitForListener())
    fake.controls.onInputChanged.emit("", (suggestResults) => { sent.push(suggestResults) })
    const [change] = yield* Fiber.join(changes)

    if (change === undefined) return expect.fail("no input change")
    expect(change.text).toBe("")
    const frozen = Object.freeze([...results])
    const suggest = change.suggest(frozen)
    expect(sent).toEqual([])
    yield* suggest
    yield* suggest
    yield* change.suggest([])
    expect(sent).toEqual([[...results], [...results], []])
    expect(sent[0]).not.toBe(frozen)
    expect(sent[1]).not.toBe(sent[0])
    expect(Object.isFrozen(sent[0])).toBe(false)
  }))

  it.effect("sends Chrome only the suggestion fields its schema accepts, from wider objects too", () => Effect.gen(function*() {
    const fake = makeOmnibox()
    const defaults: Array<DefaultSuggestResult> = []

    const omnibox = make({
      ...fake.api,
      setDefaultSuggestion: (suggestion) => {
        defaults.push(suggestion)

        return fake.api.setDefaultSuggestion(suggestion)
      }
    })

    // A search hit is structurally a SuggestResult, so TypeScript accepts it, but Chrome's
    // schema rejects any property it does not declare.
    const hit = { content: "docs effect", description: "Effect <match>docs</match>", deletable: true, score: 0.9 }
    yield* omnibox.setDefaultSuggestion(hit)
    expect(defaults).toStrictEqual([{ description: hit.description }])
    expect(fake.controls.defaultSuggestion).toStrictEqual({ description: hit.description })
    const changes = yield* Effect.forkScoped(Stream.runCollect(Stream.take(omnibox.onInputChanged, 1)))
    yield* Effect.promise(() => fake.controls.onInputChanged.waitForListener())
    const batches = fake.controls.change("docs")
    const [change] = yield* Fiber.join(changes)

    if (change === undefined) return expect.fail("no input change")
    yield* change.suggest([hit, { content: "docs plain", description: "Plain", deletable: undefined }, { ...hit, deletable: false }])
    expect(batches).toStrictEqual([[
      { content: "docs effect", description: "Effect <match>docs</match>", deletable: true },
      { content: "docs plain", description: "Plain" },
      { content: "docs effect", description: "Effect <match>docs</match>", deletable: false }
    ]])
    const sent: Array<Array<SuggestResult>> = []
    yield* inputChanged("wake", (suggestResults) => { sent.push(suggestResults) }).suggest([hit])
    expect(sent).toStrictEqual([[{ content: "docs effect", description: "Effect <match>docs</match>", deletable: true }]])
  }))

  it.effect("still forwards suggest calls made after the stream ended", () => Effect.gen(function*() {
    const fake = makeOmnibox()
    const changes = yield* Effect.forkScoped(Stream.runCollect(Stream.take(make(fake.api).onInputChanged, 1)))
    yield* Effect.promise(() => fake.controls.onInputChanged.waitForListener())
    const batches = fake.controls.change("late")
    const [change] = yield* Fiber.join(changes)
    expect(fake.controls.onInputChanged.listenerCount).toBe(0)
    yield* change?.suggest(results) ?? Effect.void
    expect(batches).toEqual([results])
  }))

  it.effect("types a throwing suggest callback as suggest, keeping the cause", () => Effect.gen(function*() {
    const fake = makeOmnibox()
    const cause = new Error("Suggestion for stale input")

    const failures = yield* Effect.forkScoped(make(fake.api).onInputChanged.pipe(
      Stream.take(2),
      Stream.mapEffect((change) => Effect.flip(change.suggest(results))),
      Stream.runCollect
    ))

    yield* Effect.promise(() => fake.controls.onInputChanged.waitForListener())
    fake.controls.onInputChanged.emit("x", () => { throw cause })
    fake.controls.onInputChanged.emit("y", () => { throw 7 })
    const [first, second] = yield* Fiber.join(failures)
    expect(first).toBeInstanceOf(ChromeOmniboxError)
    expect(first).toMatchObject({ operation: "suggest", cause })
    expect(second).toMatchObject({ operation: "suggest", cause: 7 })
  }))

  it.effect("emits every disposition and empty input", () => Effect.gen(function*() {
    const fake = makeOmnibox()
    const omnibox = make(fake.api)
    const entered = yield* Effect.forkScoped(Stream.runCollect(Stream.take(omnibox.onInputEntered, 4)))
    yield* Effect.promise(() => fake.controls.onInputEntered.waitForListener())

    for (const disposition of dispositions) fake.controls.onInputEntered.emit("docs effect", disposition)
    fake.controls.onInputEntered.emit("", "currentTab")
    expect(yield* Fiber.join(entered)).toEqual([
      { text: "docs effect", disposition: "currentTab" },
      { text: "docs effect", disposition: "newForegroundTab" },
      { text: "docs effect", disposition: "newBackgroundTab" },
      { text: "", disposition: "currentTab" }
    ])
  }))

  it.effect("streams session start, entry, cancellation and deletions while consumed", () => Effect.gen(function*() {
    const fake = makeOmnibox()
    const omnibox = make(fake.api)
    const started = yield* Effect.forkScoped(Stream.runCollect(Stream.take(omnibox.onInputStarted, 1)))
    const entered = yield* Effect.forkScoped(Stream.runCollect(Stream.take(omnibox.onInputEntered, 1)))
    const cancelled = yield* Effect.forkScoped(Stream.runCollect(Stream.take(omnibox.onInputCancelled, 1)))
    const deleted = yield* Effect.forkScoped(Stream.runCollect(Stream.take(omnibox.onDeleteSuggestion, 1)))
    yield* Effect.promise(() => fake.controls.onInputStarted.waitForListener())
    yield* Effect.promise(() => fake.controls.onInputEntered.waitForListener())
    yield* Effect.promise(() => fake.controls.onInputCancelled.waitForListener())
    yield* Effect.promise(() => fake.controls.onDeleteSuggestion.waitForListener())
    fake.controls.onInputStarted.emit()
    fake.controls.onInputEntered.emit("docs effect", "newForegroundTab")
    fake.controls.onInputCancelled.emit()
    fake.controls.onDeleteSuggestion.emit("docs stream")
    expect(yield* Fiber.join(started)).toEqual([undefined])
    expect(yield* Fiber.join(entered)).toEqual([{ text: "docs effect", disposition: "newForegroundTab" }])
    expect(yield* Fiber.join(cancelled)).toEqual([undefined])
    expect(yield* Fiber.join(deleted)).toEqual(["docs stream"])
    expect(listenerTotal(fake)).toBe(0)
  }))

  for (const event of events) {
    describe(event.name, () => {
      it.effect("delivers events in order to each subscription, then removes its listener", () => Effect.gen(function*() {
        const fake = makeOmnibox()
        const controls = fake.controls[event.name]
        const counted = countRegistrations(event, fake)
        const omnibox = make(counted.api)
        event.emit(fake, 99)
        const first = yield* Effect.forkScoped(Stream.runCollect(Stream.take(event.stream(omnibox), 3)))
        const second = yield* Effect.forkScoped(Stream.runCollect(Stream.take(event.stream(omnibox), 3)))
        yield* Effect.promise(() => counted.registered(2))
        expect(controls.listenerCount).toBe(2)

        for (const index of [0, 1, 2]) event.emit(fake, index)
        const expected = [0, 1, 2].map(event.expected)
        expect(yield* Fiber.join(first)).toEqual(expected)
        expect(yield* Fiber.join(second)).toEqual(expected)
        expect(controls.listenerCount).toBe(0)
      }))

      it.effect("removes its listener when interrupted while waiting", () => Effect.gen(function*() {
        const fake = makeOmnibox()
        const controls = fake.controls[event.name]
        const fiber = yield* Effect.forkScoped(Stream.runDrain(event.stream(make(fake.api))))
        yield* Effect.promise(() => controls.waitForListener())
        expect(controls.listenerCount).toBe(1)
        const exit = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)))
        expect(Exit.hasInterrupts(exit)).toBe(true)
        expect(controls.listenerCount).toBe(0)
      }))

      it.effect("types a failed listener registration with the event name", () => Effect.gen(function*() {
        const fake = makeOmnibox()
        const controls = fake.controls[event.name]
        const cause = new Error("listener rejected")
        controls.failNext("addListener", cause)
        const error = yield* Effect.flip(Stream.runDrain(event.stream(make(fake.api))))
        expect(error).toBeInstanceOf(ChromeOmniboxError)
        expect(error).toMatchObject({ operation: event.name, cause })
        expect(controls.listenerCount).toBe(0)
      }))

      it.effect("removes a listener whose registration added it and then threw", () => Effect.gen(function*() {
        const fake = makeOmnibox()
        const controls = fake.controls[event.name]
        const cause = new Error("registered, then failed")

        const api = event.rewire(fake.api, (source) => ({
          addListener: (listener) => {
            source.addListener(listener)
            throw cause
          },
          removeListener: (listener) => { source.removeListener(listener) }
        }))

        expect(yield* Effect.flip(Stream.runDrain(event.stream(make(api))))).toMatchObject({ operation: event.name, cause })
        expect(controls.listenerCount).toBe(0)
      }))

      it.effect("types a throwing event lookup with the event name", () => Effect.gen(function*() {
        const fake = makeOmnibox()
        const cause = new Error("omnibox is not available in this context")
        const api: ChromeOmniboxApi = { ...fake.api }
        Object.defineProperty(api, event.name, { get: () => { throw cause } })
        const omnibox = make(api)
        expect(yield* Effect.flip(Stream.runDrain(event.stream(omnibox)))).toMatchObject({ operation: event.name, cause })
      }))
    })
  }

  it.effect("wraps native wake-listener arguments like the stream does", () => Effect.gen(function*() {
    const sent: Array<ReadonlyArray<SuggestResult>> = []
    const change = inputChanged("effect", (suggestResults) => { sent.push(suggestResults) })
    expect(change.text).toBe("effect")
    yield* change.suggest(results)
    expect(sent).toEqual([results])
    const cause = new TypeError("Invalid suggestResults")
    const failing = inputChanged("bad", () => { throw cause })
    expect(yield* Effect.flip(failing.suggest(results))).toMatchObject({ operation: "suggest", cause })
  }))

  it.effect("provides an injected API through layer", () => Effect.gen(function*() {
    const fake = makeOmnibox()
    yield* Effect.flatMap(ChromeOmnibox, (omnibox) => omnibox.setDefaultSuggestion({ description: "Docs" })).pipe(Effect.provide(layer(fake.api)))
    expect(fake.controls.defaultSuggestion).toEqual({ description: "Docs" })
  }))

  it.effect("fails the live layer with initialize when chrome or chrome.omnibox is missing", () => Effect.gen(function*() {
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", undefined)), () => Effect.sync(() => vi.unstubAllGlobals()))
    const missing = yield* Effect.flip(ChromeOmnibox.pipe(Effect.provide(layerLive)))
    expect(missing).toBeInstanceOf(ChromeOmniboxError)
    expect(missing).toMatchObject({ operation: "initialize" })
    expect(String(missing.cause)).toContain("chrome.omnibox is unavailable")
    vi.stubGlobal("chrome", {})
    expect(yield* Effect.flip(ChromeOmnibox.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
  }))

  it.effect("builds the live layer from the global when it is built", () => Effect.gen(function*() {
    const fake = makeOmnibox()
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", { omnibox: fake.api })), () => Effect.sync(() => vi.unstubAllGlobals()))
    const omnibox = yield* ChromeOmnibox.pipe(Effect.provide(layerLive))
    yield* omnibox.setDefaultSuggestion({ description: "Live <dim>docs</dim>" })
    expect(fake.controls.defaultSuggestion).toEqual({ description: "Live <dim>docs</dim>" })
    const deleted = yield* Effect.forkScoped(Stream.runCollect(Stream.take(omnibox.onDeleteSuggestion, 1)))
    yield* Effect.promise(() => fake.controls.onDeleteSuggestion.waitForListener())
    fake.controls.onDeleteSuggestion.emit("docs live")
    expect(yield* Fiber.join(deleted)).toEqual(["docs live"])
    expect(fake.controls.onDeleteSuggestion.listenerCount).toBe(0)
  }))
})

describe("makeOmnibox", () => {
  it.effect("records a copy of the last accepted default suggestion", () => Effect.gen(function*() {
    const fake = makeOmnibox()
    expect(fake.controls.defaultSuggestion).toBeUndefined()
    const omnibox = make(fake.api)
    const suggestion = { description: "First" }
    yield* omnibox.setDefaultSuggestion(suggestion)
    suggestion.description = "Mutated"
    expect(fake.controls.defaultSuggestion).toEqual({ description: "First" })
    yield* omnibox.setDefaultSuggestion({ description: "Second <match>%s</match>" })
    expect(fake.controls.defaultSuggestion).toEqual({ description: "Second <match>%s</match>" })
  }))

  it.effect.each([
    "Search <match>%s</match>",
    "<dim>nested <match>match</match></dim> and <url>https://example.com/?a=1&amp;b=2</url>",
    "a &amp; b &lt;&gt;&quot;&apos; &#38; &#x26; c > d",
    "line<br/>break and <url  >spaced</url>",
    "plain",
    "<dim class=\"a\" data-x='b &amp; c > d'>attributes</dim>",
    "<dim>spaced close</dim > and <url />",
    "tab\tnewline\ncarriage\r",
    "&#9;&#xA;&#xD;&#x20;&#xFFFD;&#x10000;&#x10FFFF;"
  ])("accepts well-formed markup: %s", (description) => Effect.gen(function*() {
    const fake = makeOmnibox()
    yield* make(fake.api).setDefaultSuggestion({ description })
    expect(fake.controls.defaultSuggestion).toEqual({ description })
  }))

  it.effect.each([
    { description: "", message: "must not be empty" },
    { description: "<match>open", message: "Unclosed <match>" },
    { description: "close</dim>", message: "Unexpected </dim>" },
    { description: "<match>crossed</dim>", message: "Unexpected </dim>" },
    { description: "<dim><match>x</dim></match>", message: "Unexpected </dim>" },
    { description: "a & b", message: "Unescaped \"&\"" },
    { description: "&nbsp;", message: "Unescaped \"&\"" },
    { description: "a < b", message: "Malformed tag" },
    { description: "</>", message: "Malformed tag" },
    { description: "<b/ >", message: "Malformed tag" },
    { description: "<dim x>bare attribute</dim>", message: "Malformed tag" },
    { description: "<dim x=y>unquoted</dim>", message: "Malformed tag" },
    { description: "<dim a=\"1\"b=\"2\">unseparated</dim>", message: "Malformed tag" },
    { description: "<dim a=\"<\">lt in value</dim>", message: "Malformed tag" },
    { description: "<dim a=\"1\" a=\"2\">twice</dim>", message: "Duplicate attribute a" },
    { description: "<dim a=\"&\">amp in value</dim>", message: "Unescaped \"&\"" },
    { description: "<dim>x</dim y=\"1\">", message: "Malformed tag" },
    { description: "a ]]> b", message: "\"]]>\"" },
    { description: "bell\u0007", message: "Invalid character" },
    { description: "noncharacter\uFFFF", message: "Invalid character" },
    { description: "&#0;", message: "Invalid character reference" },
    { description: "&#x1F;", message: "Invalid character reference" },
    { description: "&#xD800;", message: "Invalid character reference" },
    { description: "&#xFFFE;", message: "Invalid character reference" },
    { description: "&#x110000;", message: "Invalid character reference" },
    { description: "&#99999999999999999999;", message: "Invalid character reference" }
  ])("rejects $description without changing the default suggestion", ({ description, message }) => Effect.gen(function*() {
    const fake = makeOmnibox()
    const omnibox = make(fake.api)
    yield* omnibox.setDefaultSuggestion({ description: "Kept" })
    const error = yield* Effect.flip(omnibox.setDefaultSuggestion({ description }))
    expect(error).toMatchObject({ operation: "setDefaultSuggestion" })
    expect(String(error.cause)).toContain(message)
    expect(fake.controls.defaultSuggestion).toEqual({ description: "Kept" })
  }))

  it.effect("collects every suggest batch for a keystroke as a copy, and nothing without listeners", () => Effect.sync(() => {
    const fake = makeOmnibox()
    expect(fake.controls.change("unheard")).toEqual([])
    let answer: ((suggestResults: Array<SuggestResult>) => void) | undefined
    fake.api.onInputChanged.addListener((_text, suggest) => { answer = suggest })
    const batches = fake.controls.change("effect")
    expect(batches).toEqual([])
    const sent = [{ content: "docs effect", description: "Effect" }]
    answer?.(sent)
    answer?.([])
    sent[0] = { content: "changed", description: "Changed" }
    expect(batches).toEqual([[{ content: "docs effect", description: "Effect" }], []])
  }))

  it.effect("throws like Chrome for an empty content or description, recording nothing", () => Effect.gen(function*() {
    const fake = makeOmnibox()

    const failures = yield* Effect.forkScoped(make(fake.api).onInputChanged.pipe(
      Stream.take(1),
      Stream.mapEffect((change) => Effect.all([
        Effect.flip(change.suggest([{ content: "", description: "Empty content" }])),
        Effect.flip(change.suggest([results[0] ?? { content: "x", description: "x" }, { content: "x", description: "" }]))
      ])),
      Stream.runCollect
    ))

    yield* Effect.promise(() => fake.controls.onInputChanged.waitForListener())
    const batches = fake.controls.change("x")
    const [[content, description] = []] = yield* Fiber.join(failures)
    expect(content).toMatchObject({ operation: "suggest" })
    expect(content?.cause).toBeInstanceOf(TypeError)
    expect(String(content?.cause)).toContain("suggestResults[0].content")
    expect(String(description?.cause)).toContain("suggestResults[1].description")
    expect(batches).toEqual([])
  }))

  it.effect("throws like Chrome's schema check for an undeclared property, recording nothing", () => Effect.sync(() => {
    const fake = makeOmnibox()
    const withContent = { description: "Docs", content: "docs" }
    expect(() => fake.api.setDefaultSuggestion(withContent)).toThrow(TypeError)
    expect(() => fake.api.setDefaultSuggestion(withContent)).toThrow("Unexpected property: 'content'")
    expect(fake.controls.defaultSuggestion).toBeUndefined()
    let answer: ((suggestResults: Array<SuggestResult>) => void) | undefined
    fake.api.onInputChanged.addListener((_text, suggest) => { answer = suggest })
    const batches = fake.controls.change("docs")
    const scored = { content: "docs a", description: "A", score: 1 }
    expect(() => answer?.([{ content: "docs b", description: "B" }, scored])).toThrow(TypeError)
    expect(() => answer?.([scored])).toThrow("suggestResults[0]: Unexpected property: 'score'")
    answer?.([{ content: "docs c", description: "C", deletable: undefined }])
    expect(batches).toEqual([[{ content: "docs c", description: "C", deletable: undefined }]])
  }))

  it.effect("replaces members with overrides and provides its layer", () => Effect.gen(function*() {
    const setDefaultSuggestion = vi.fn(async (_suggestion: DefaultSuggestResult) => {})
    const fake = makeOmnibox({ setDefaultSuggestion })
    yield* Effect.flatMap(ChromeOmnibox, (omnibox) => omnibox.setDefaultSuggestion({ description: "<unbalanced" })).pipe(Effect.provide(fake.layer))
    expect(setDefaultSuggestion).toHaveBeenCalledExactlyOnceWith({ description: "<unbalanced" })
    expect(fake.controls.defaultSuggestion).toBeUndefined()
    expect(fake.api.onInputChanged).toBeDefined()
  }))
})
