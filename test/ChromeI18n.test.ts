// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Layer, Option } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeI18n, ChromeI18nError, layer, layerLive, make } from "../src/ChromeI18n.js"
import type { ChromeI18nApi, ChromeI18nService, LanguageDetection } from "../src/ChromeI18n.js"
import { makeI18n, replacePlaceholders } from "../src/testing/I18n.js"

const messages = new Map([["greeting", "Hello, $1!"], ["blank", ""]])

const english: LanguageDetection = { isReliable: true, languages: [{ language: "en", percentage: 97 }] }

const mockApi = () => ({
  getMessage: vi.fn((messageName: string, substitutions?: string | Array<string | number>, _options?: chrome.i18n.GetMessageOptions): string | undefined => {
    const message = messages.get(messageName) ?? ""

    return message.replace("$1", String([substitutions ?? []].flat()[0] ?? ""))
  }),
  getUILanguage: vi.fn(() => "en-US"),
  getAcceptLanguages: vi.fn(async () => ["en-US", "he"]),
  detectLanguage: vi.fn(async (_text: string): Promise<LanguageDetection> => english)
}) satisfies ChromeI18nApi

type Operation = "getMessage" | "getUILanguage" | "getAcceptLanguages" | "detectLanguage"

type Outcome = Option.Option<string> | string | Array<string> | LanguageDetection

const run = (i18n: ChromeI18nService, operation: Operation): Effect.Effect<Outcome, ChromeI18nError> => {
  switch (operation) {
    case "getMessage": return i18n.getMessage("greeting", ["Ada"], { escapeLt: true })
    case "getUILanguage": return i18n.getUILanguage
    case "getAcceptLanguages": return i18n.getAcceptLanguages
    case "detectLanguage": return i18n.detectLanguage("Bonjour")
  }
}

const operations: ReadonlyArray<Operation> = ["getMessage", "getUILanguage", "getAcceptLanguages", "detectLanguage"]

const fixtureMessage = (i18n: ChromeI18nService, name: string, substitutions?: string | ReadonlyArray<string | number>) =>
  i18n.getMessage(name, substitutions).pipe(Effect.map(Option.getOrElse(() => "<none>")))

describe("ChromeI18n", () => {
  it.effect("maps Chrome's empty string for a missing message to none", () => Effect.gen(function*() {
    const api = mockApi()
    const i18n = make(api)
    expect(yield* i18n.getMessage("greeting", "Ada")).toEqual(Option.some("Hello, Ada!"))
    expect(yield* i18n.getMessage("missing")).toEqual(Option.none())
    expect(yield* i18n.getMessage("blank")).toEqual(Option.none())
    api.getMessage.mockReturnValueOnce(" ")
    expect(yield* i18n.getMessage("blank")).toEqual(Option.some(" "))
  }))

  it.effect("types Chrome's undefined answer to a malformed call instead of reporting a missing message", () => Effect.gen(function*() {
    const api = mockApi()
    const i18n = make(api)
    const tooMany = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]
    api.getMessage.mockReturnValueOnce(undefined)
    const error = yield* Effect.flip(i18n.getMessage("greeting", tooMany))
    expect(error).toBeInstanceOf(ChromeI18nError)
    expect(error.operation).toBe("getMessage")
    expect(error.cause).toBeInstanceOf(Error)
    expect(String(error.cause)).toContain("more than 9 substitutions")
    expect(String(error.cause)).toContain("\"greeting\"")
    expect(api.getMessage).toHaveBeenCalledExactlyOnceWith("greeting", tooMany)
  }))

  it.effect("passes substitutions and options only when given, copying readonly arrays", () => Effect.gen(function*() {
    const api = mockApi()
    const i18n = make(api)
    const substitutions: ReadonlyArray<string | number> = ["Ada", 2]
    const options = { escapeLt: true }
    yield* i18n.getMessage("greeting")
    yield* i18n.getMessage("greeting", "Ada")
    yield* i18n.getMessage("greeting", substitutions)
    yield* i18n.getMessage("greeting", [])
    yield* i18n.getMessage("greeting", "")
    yield* i18n.getMessage("greeting", undefined, options)
    yield* i18n.getMessage("greeting", "Ada", {})
    yield* i18n.getMessage("greeting", substitutions, options)
    yield* i18n.getMessage("greeting", undefined, undefined)
    expect(api.getMessage.mock.calls).toEqual([
      ["greeting"],
      ["greeting", "Ada"],
      ["greeting", ["Ada", 2]],
      ["greeting", []],
      ["greeting", ""],
      ["greeting", undefined, { escapeLt: true }],
      ["greeting", "Ada", {}],
      ["greeting", ["Ada", 2], { escapeLt: true }],
      ["greeting"]
    ])
    expect(api.getMessage.mock.calls.map((call) => call.length)).toEqual([1, 2, 2, 2, 2, 3, 3, 3, 1])
    expect(api.getMessage.mock.calls[2]?.[1]).not.toBe(substitutions)
    expect(api.getMessage.mock.calls[7]?.[1]).not.toBe(substitutions)
    expect(api.getMessage.mock.calls[5]?.[2]).toBe(options)
    expect(substitutions).toEqual(["Ada", 2])
  }))

  it.effect("copies the substitutions afresh on every run of the same effect", () => Effect.gen(function*() {
    const api = mockApi()
    const substitutions = ["Ada"]
    const message = make(api).getMessage("greeting", substitutions)
    expect(yield* message).toEqual(Option.some("Hello, Ada!"))
    substitutions[0] = "Grace"
    expect(yield* message).toEqual(Option.some("Hello, Grace!"))
    expect(api.getMessage.mock.calls[0]?.[1]).not.toBe(api.getMessage.mock.calls[1]?.[1])
  }))

  it.effect("calls nothing until run and reads afresh on each run", () => Effect.gen(function*() {
    const api = mockApi()
    const i18n = make(api)
    const effects = operations.map((operation) => run(i18n, operation))
    expect(api.getMessage).not.toHaveBeenCalled()
    expect(api.getUILanguage).not.toHaveBeenCalled()
    expect(api.getAcceptLanguages).not.toHaveBeenCalled()
    expect(api.detectLanguage).not.toHaveBeenCalled()
    yield* Effect.all(effects)
    yield* Effect.all(effects)
    expect(api.getMessage).toHaveBeenCalledTimes(2)
    expect(api.getUILanguage).toHaveBeenCalledTimes(2)
    expect(api.getAcceptLanguages).toHaveBeenCalledTimes(2)
    expect(api.detectLanguage).toHaveBeenCalledTimes(2)
    api.getUILanguage.mockReturnValueOnce("he")
    api.getAcceptLanguages.mockResolvedValueOnce(["he"])
    expect(yield* i18n.getUILanguage).toBe("he")
    expect(yield* i18n.getUILanguage).toBe("en-US")
    expect(yield* i18n.getAcceptLanguages).toEqual(["he"])
    expect(yield* i18n.getAcceptLanguages).toEqual(["en-US", "he"])
  }))

  it.effect("passes the text to detect unchanged and returns Chrome's result as is", () => Effect.gen(function*() {
    const api = mockApi()
    const i18n = make(api)
    const none: LanguageDetection = { isReliable: false, languages: [] }
    api.detectLanguage.mockResolvedValueOnce(none)
    expect(yield* i18n.detectLanguage("")).toBe(none)
    expect(yield* i18n.detectLanguage("Hello there")).toBe(english)
    const long = "x".repeat(100_000)
    yield* i18n.detectLanguage(long)
    expect(api.detectLanguage.mock.calls).toEqual([[""], ["Hello there"], [long]])
  }))

  it.effect.each(operations)("maps a synchronous throw from %s to a typed error", (operation) => Effect.gen(function*() {
    const api = mockApi()
    const cause = new Error("Extension context invalidated.")
    api[operation].mockImplementationOnce(() => { throw cause })
    const error = yield* Effect.flip(run(make(api), operation))
    expect(error).toBeInstanceOf(ChromeI18nError)
    expect(error).toMatchObject({ operation, cause })
  }))

  it.effect.each(["getAcceptLanguages", "detectLanguage"] as const)("maps a rejection of %s to a typed error", (operation) => Effect.gen(function*() {
    const api = mockApi()
    const cause = new Error("Extension context invalidated.")
    api[operation].mockRejectedValueOnce(cause)
    const error = yield* Effect.flip(run(make(api), operation))
    expect(error).toBeInstanceOf(ChromeI18nError)
    expect(error).toMatchObject({ operation, cause })
  }))

  it.effect("keeps non-Error causes unchanged", () => Effect.gen(function*() {
    const api = mockApi()
    const i18n = make(api)
    api.getAcceptLanguages.mockRejectedValueOnce("plain string")
    api.getUILanguage.mockImplementationOnce(() => { throw undefined })
    expect((yield* Effect.flip(i18n.getAcceptLanguages)).cause).toBe("plain string")
    const error = yield* Effect.flip(i18n.getUILanguage)
    expect(error.operation).toBe("getUILanguage")
    expect(error.cause).toBeUndefined()
  }))

  it.effect("recovers after a failure, since each run calls Chrome again", () => Effect.gen(function*() {
    const api = mockApi()
    const i18n = make(api)
    api.detectLanguage.mockRejectedValueOnce(new Error("busy"))
    const detection = i18n.detectLanguage("Hello")
    expect(yield* Effect.flip(detection)).toMatchObject({ operation: "detectLanguage" })
    expect(yield* detection).toBe(english)
  }))

  it.effect("provides an injected API through layer", () => Effect.gen(function*() {
    const api = mockApi()
    const language = yield* Effect.flatMap(ChromeI18n, (i18n) => i18n.getUILanguage).pipe(Effect.provide(layer(api)))
    expect(language).toBe("en-US")
  }))

  it.effect("fails layerLive with initialize when chrome is missing", () => Effect.gen(function*() {
    vi.stubGlobal("chrome", undefined)
    const error = yield* Effect.flip(Layer.build(layerLive))
    expect(error).toBeInstanceOf(ChromeI18nError)
    expect(error.operation).toBe("initialize")
    expect(String(error.cause)).toContain("chrome.i18n is unavailable")
  }))

  it.effect("fails layerLive with initialize when chrome.i18n is missing or its getter throws", () => Effect.gen(function*() {
    vi.stubGlobal("chrome", {})
    expect(yield* Effect.flip(ChromeI18n.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
    const cause = new Error("Access to i18n is denied")
    vi.stubGlobal("chrome", { get i18n() { throw cause } })
    expect(yield* Effect.flip(ChromeI18n.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize", cause })
  }))

  it.effect("builds layerLive from the global present when it is built", () => Effect.gen(function*() {
    const first = mockApi()
    const second = mockApi()
    second.getUILanguage.mockReturnValue("fr-FR")
    vi.stubGlobal("chrome", { i18n: first })
    const program = Effect.flatMap(ChromeI18n, (i18n) => i18n.getUILanguage).pipe(Effect.provide(layerLive))
    expect(yield* program).toBe("en-US")
    vi.stubGlobal("chrome", { i18n: second })
    expect(yield* program).toBe("fr-FR")
    expect(first.getUILanguage).toHaveBeenCalledOnce()
  }))
})

describe("testing/I18n", () => {
  const catalog = {
    greeting: { message: "Hello, $user$! You have $count$ new messages.", placeholders: { USER: { content: "$1", example: "Ada" }, count: { content: "$2" } } },
    Mixed_Case: { message: "Case-insensitive" },
    price: { message: "Costs $$$1, $$ $1, not $$5 or $ 1 $" },
    html: { message: "<b>$1</b>" },
    empty: { message: "" },
    nested: { message: "$outer$", placeholders: { outer: { content: "$inner$ stays" } } }
  }

  it.effect("resolves messages.json placeholders and Chrome's runtime substitution through the service", () => Effect.gen(function*() {
    const fixture = makeI18n({ messages: catalog })
    const i18n = make(fixture.api)
    expect(yield* fixtureMessage(i18n, "greeting", ["Ada", 3])).toBe("Hello, Ada! You have 3 new messages.")
    expect(yield* fixtureMessage(i18n, "GREETING", "Ada")).toBe("Hello, Ada! You have  new messages.")
    expect(yield* fixtureMessage(i18n, "greeting")).toBe("Hello, ! You have  new messages.")
    expect(yield* fixtureMessage(i18n, "mixed_case")).toBe("Case-insensitive")
    // A run of n dollars keeps n - 1 and swallows no digit, so "$$$1" is "$$1"; "$ " and a final "$" vanish.
    expect(yield* fixtureMessage(i18n, "price", ["9"])).toBe("Costs $$1, $ 9, not $5 or 1 ")
    // Placeholder content is not rescanned at load time, but runtime substitution still applies.
    expect(fixture.controls.message("nested")).toBe("$inner$ stays")
    expect(yield* fixtureMessage(i18n, "nested")).toBe("nnerstays")
    expect(yield* fixtureMessage(i18n, "empty")).toBe("<none>")
    expect(yield* fixtureMessage(i18n, "unknown")).toBe("<none>")
    expect(fixture.controls.message("Greeting")).toBe("Hello, $1! You have $2 new messages.")
    expect(fixture.controls.message("unknown")).toBeUndefined()
  }))

  it.effect("escapes < in the message only, and fails more than 9 substitutions", () => Effect.gen(function*() {
    const i18n = make(makeI18n({ messages: catalog }).api)
    expect(yield* i18n.getMessage("html", "<i>x</i>", { escapeLt: true })).toEqual(Option.some("&lt;b><i>x</i>&lt;/b>"))
    expect(yield* i18n.getMessage("html", "<i>", { escapeLt: false })).toEqual(Option.some("<b><i></b>"))
    expect(yield* i18n.getMessage("html", "x", {})).toEqual(Option.some("<b>x</b>"))
    const nine = ["1", "2", "3", "4", "5", "6", "7", "8", "9"]
    expect(yield* i18n.getMessage("html", nine)).toEqual(Option.some("<b>1</b>"))
    expect(yield* Effect.flip(i18n.getMessage("html", [...nine, "10"]))).toMatchObject({ operation: "getMessage" })
    expect(yield* Effect.flip(i18n.getMessage("unknown", [...nine, "10"]))).toMatchObject({ operation: "getMessage" })
  }))

  it("substitutes exactly like base::ReplaceStringPlaceholders", () => {
    const subs = ["a", "b", "c", "d", "e", "f", "g", "h", "i"]
    expect(replacePlaceholders("$1$2$3$4$5$6$7$8$9", subs)).toBe("abcdefghi")
    expect(replacePlaceholders("$10", subs)).toBe("a0")
    expect(replacePlaceholders("$0 $a $ $", subs)).toBe("  ")
    expect(replacePlaceholders("$", [])).toBe("")
    expect(replacePlaceholders("x$", [])).toBe("x")
    expect(replacePlaceholders("$$", [])).toBe("$")
    expect(replacePlaceholders("$$$", [])).toBe("$$")
    expect(replacePlaceholders("$$$$1", ["z"])).toBe("$$$1")
    expect(replacePlaceholders("$$1", ["z"])).toBe("$1")
    expect(replacePlaceholders("$3", ["only"])).toBe("")
    expect(replacePlaceholders("$1", ["$2"])).toBe("$2")
    expect(replacePlaceholders("שלום $1 🌍", ["עולם"])).toBe("שלום עולם 🌍")
    expect(replacePlaceholders("", subs)).toBe("")
    // Chrome works on UTF-8 bytes: "$" swallows only the lead byte of a non-ASCII character.
    expect(replacePlaceholders("a$éb", [])).toBe("a�b")
    expect(replacePlaceholders("$🌍", [])).toBe("���")
    expect(replacePlaceholders("$1", ["\uD800"])).toBe("�")
    expect(replacePlaceholders("$1", ["x".repeat(1_000_000)])).toHaveLength(1_000_000)
  })

  it.effect("takes the first catalog defining a name, as Chrome layers locale, parent and default_locale", () => Effect.gen(function*() {
    const i18n = make(makeI18n({
      messages: [
        { colour: { message: "colour (en_GB)" } },
        { colour: { message: "color (en)" }, title: { message: "Title (en)" } },
        { colour: { message: "default" }, title: { message: "default" }, only_default: { message: "fallback" } }
      ]
    }).api)

    expect(yield* fixtureMessage(i18n, "colour")).toBe("colour (en_GB)")
    expect(yield* fixtureMessage(i18n, "title")).toBe("Title (en)")
    expect(yield* fixtureMessage(i18n, "only_default")).toBe("fallback")
  }))

  it.effect("serves Chrome's reserved messages, the locale ones only for a localized extension", () => Effect.gen(function*() {
    const unlocalized = make(makeI18n({ extensionId: "ext" }).api)
    expect(yield* fixtureMessage(unlocalized, "@@extension_id")).toBe("ext")
    expect(yield* fixtureMessage(unlocalized, "@@ui_locale")).toBe("<none>")
    expect(yield* fixtureMessage(unlocalized, "@@bidi_dir")).toBe("<none>")

    const fixture = makeI18n({ messages: { "@@extension_id": { message: "mine" }, "@@custom": { message: "allowed" } } })
    const i18n = make(fixture.api)
    expect(yield* fixtureMessage(i18n, "@@EXTENSION_ID")).toBe("abcdefghijklmnopabcdefghijklmnop")
    expect(yield* fixtureMessage(i18n, "@@custom")).toBe("allowed")
    expect(yield* fixtureMessage(i18n, "@@ui_locale")).toBe("en_US")
    expect(yield* Effect.all([
      fixtureMessage(i18n, "@@bidi_dir"), fixtureMessage(i18n, "@@bidi_reversed_dir"),
      fixtureMessage(i18n, "@@bidi_start_edge"), fixtureMessage(i18n, "@@bidi_end_edge")
    ])).toEqual(["ltr", "rtl", "left", "right"])

    fixture.controls.setUILanguage("he")
    expect(yield* i18n.getUILanguage).toBe("he")
    expect(yield* fixtureMessage(i18n, "@@ui_locale")).toBe("he")
    expect(yield* Effect.all([
      fixtureMessage(i18n, "@@bidi_dir"), fixtureMessage(i18n, "@@bidi_reversed_dir"),
      fixtureMessage(i18n, "@@bidi_start_edge"), fixtureMessage(i18n, "@@bidi_end_edge")
    ])).toEqual(["rtl", "ltr", "right", "left"])

    fixture.controls.setUILanguage("pa-Arab-PK")
    expect(yield* fixtureMessage(i18n, "@@bidi_dir")).toBe("rtl")
    fixture.controls.setUILanguage("uz-Latn")
    expect(yield* fixtureMessage(i18n, "@@bidi_dir")).toBe("ltr")
    fixture.controls.setUILanguage("fa_IR")
    expect(yield* fixtureMessage(i18n, "@@ui_locale")).toBe("fa_IR")
    expect(yield* fixtureMessage(i18n, "@@bidi_dir")).toBe("rtl")
  }))

  it("rejects catalogs Chrome would refuse to load", () => {
    expect(() => makeI18n({ messages: { "bad-name": { message: "x" } } })).toThrow("Name of a key \"bad-name\" is invalid")
    expect(() => makeI18n({ messages: { "": { message: "x" } } })).toThrow("is invalid")
    expect(() => makeI18n({ messages: { ok: { message: "$x$", placeholders: { "x-y": { content: "1" } } } } })).toThrow("is invalid")
    expect(() => makeI18n({ messages: { ok: { message: "Hi $who$" } } })).toThrow("Variable $who$ used but not defined")
    expect(() => makeI18n({ messages: [{ ok: { message: "x" } }, { "@@UI_LOCALE": { message: "x" } }] })).toThrow("Reserved key \"@@ui_locale\"")
    expect(() => makeI18n({ messages: { "@@bidi_dir": { message: "x" } } })).toThrow("Reserved key")
    expect(() => makeI18n({ messages: { ok: { message: "a $not valid$ b $1" } } })).not.toThrow()
  })

  it.effect("reports and copies the languages it holds", () => Effect.gen(function*() {
    const fixture = makeI18n({ uiLanguage: "de-DE", acceptLanguages: ["de", "en"] })
    const i18n = make(fixture.api)
    expect(yield* i18n.getUILanguage).toBe("de-DE")
    const languages = yield* i18n.getAcceptLanguages
    languages.push("mutated")
    expect(yield* i18n.getAcceptLanguages).toEqual(["de", "en"])
    const next = ["he"]
    fixture.controls.setAcceptLanguages(next)
    next.push("mutated")
    expect(yield* i18n.getAcceptLanguages).toEqual(["he"])
    expect(yield* make(makeI18n().api).getAcceptLanguages).toEqual(["en-US", "en"])
    expect(yield* make(makeI18n().api).getUILanguage).toBe("en-US")
  }))

  it.effect("post-processes detection like Chrome", () => Effect.gen(function*() {
    const long = "This sentence is comfortably longer than fifty bytes of text."

    const detect = vi.fn((text: string): LanguageDetection => text.startsWith("mixed")
      ? {
        isReliable: true,
        languages: [
          { language: "sr-Latn", percentage: 40 }, { language: "fr", percentage: 30 },
          { language: "und", percentage: 20 }, { language: "de", percentage: 10 }
        ]
      }
      : { isReliable: true, languages: [{ language: "en", percentage: 60 }, { language: "de", percentage: 30 }, { language: "nl", percentage: 5 }, { language: "fy", percentage: 5 }] })

    const i18n = make(makeI18n({ detect }).api)
    expect(yield* i18n.detectLanguage(long)).toEqual({ isReliable: true, languages: [{ language: "en", percentage: 60 }, { language: "de", percentage: 30 }, { language: "nl", percentage: 5 }] })
    expect(yield* i18n.detectLanguage("short")).toMatchObject({ isReliable: false })
    expect(yield* i18n.detectLanguage(`mixed ${long}`)).toEqual({ isReliable: true, languages: [{ language: "fr", percentage: 30 }] })
    // 25 Hebrew letters are 50 UTF-8 bytes, though their JavaScript length is 25.
    expect((yield* i18n.detectLanguage("ש".repeat(25))).isReliable).toBe(true)
    expect((yield* i18n.detectLanguage("ש".repeat(24))).isReliable).toBe(false)
    expect(detect).toHaveBeenCalledTimes(5)

    const unreliable = make(makeI18n({ detect: () => ({ isReliable: false, languages: [{ language: "en", percentage: 99 }] }) }).api)
    expect((yield* unreliable.detectLanguage(long)).isReliable).toBe(false)
    const unknown = make(makeI18n({ detect: () => ({ isReliable: true, languages: [{ language: "und", percentage: 100 }] }) }).api)
    expect(yield* unknown.detectLanguage(long)).toEqual({ isReliable: false, languages: [] })
    expect(yield* make(makeI18n().api).detectLanguage(long)).toEqual({ isReliable: false, languages: [] })
  }))

  it.effect.each(operations)("fails the next %s once through failNext", (operation) => Effect.gen(function*() {
    const fixture = makeI18n({ messages: { greeting: { message: "Hi $1" } } })
    const i18n = make(fixture.api)
    const first = new Error("first")
    const second = new Error("second")
    fixture.controls.failNext(operation, first)
    fixture.controls.failNext(operation, second)
    expect(yield* Effect.flip(run(i18n, operation))).toMatchObject({ operation, cause: first })
    expect(yield* Effect.flip(run(i18n, operation))).toMatchObject({ operation, cause: second })
    yield* run(i18n, operation)

    for (const other of operations) yield* run(i18n, other)
  }))

  it.effect("applies overrides and provides its layer", () => Effect.gen(function*() {
    const getUILanguage = vi.fn(() => "ja")
    const fixture = makeI18n({ overrides: { getUILanguage } })
    expect(fixture.api).toMatchObject({ getUILanguage })
    const language = yield* Effect.flatMap(ChromeI18n, (i18n) => i18n.getUILanguage).pipe(Effect.provide(fixture.layer))
    expect(language).toBe("ja")
  }))
})
