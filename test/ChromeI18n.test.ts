// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Option } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeI18n, ChromeI18nError, layer, layerLive, make } from "../src/ChromeI18n.js"
import type { ChromeI18nApi } from "../src/ChromeI18n.js"

const messages = new Map([["greeting", "Hello, $1!"], ["blank", ""]])

const mockApi = () => ({
  getMessage: vi.fn((messageName: string, substitutions?: string | Array<string | number>, _options?: chrome.i18n.GetMessageOptions): string | undefined => {
    const message = messages.get(messageName) ?? ""

    return message.replace("$1", String([substitutions ?? []].flat()[0] ?? ""))
  }),
  getUILanguage: vi.fn(() => "en-US"),
  getAcceptLanguages: vi.fn(async () => ["en-US", "he"]),
  detectLanguage: vi.fn(async (_text: string): Promise<chrome.i18n.LanguageDetectionResult> => ({
    isReliable: true, languages: [{ language: "en", percentage: 97 }]
  }))
}) satisfies ChromeI18nApi

describe("ChromeI18n", () => {
  it.effect("maps Chrome's empty string for a missing message to none", () => Effect.gen(function*() {
    const api = mockApi()
    const i18n = make(api)
    expect(yield* i18n.getMessage("greeting", "Ada")).toEqual(Option.some("Hello, Ada!"))
    expect(yield* i18n.getMessage("missing")).toEqual(Option.none())
    expect(yield* i18n.getMessage("blank")).toEqual(Option.none())
    // Chrome answers a malformed call, such as more than 9 substitutions, with undefined.
    api.getMessage.mockReturnValueOnce(undefined)
    expect(yield* i18n.getMessage("greeting", ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"])).toEqual(Option.none())
  }))

  it.effect("passes substitutions and options only when given, copying readonly arrays", () => Effect.gen(function*() {
    const api = mockApi()
    const i18n = make(api)
    const substitutions: ReadonlyArray<string | number> = ["Ada", 2]
    yield* i18n.getMessage("greeting")
    yield* i18n.getMessage("greeting", "Ada")
    yield* i18n.getMessage("greeting", substitutions)
    yield* i18n.getMessage("greeting", undefined, { escapeLt: true })
    expect(api.getMessage.mock.calls).toEqual([
      ["greeting"],
      ["greeting", ["Ada"]],
      ["greeting", ["Ada", 2]],
      ["greeting", undefined, { escapeLt: true }]
    ])
    expect(api.getMessage.mock.calls[2]?.[1]).not.toBe(substitutions)
  }))

  it.effect("reads languages and detects one lazily", () => Effect.gen(function*() {
    const api = mockApi()
    const i18n = make(api)
    const detection = i18n.detectLanguage("Hello there")
    expect(api.detectLanguage).not.toHaveBeenCalled()
    expect((yield* detection).languages).toEqual([{ language: "en", percentage: 97 }])
    expect(yield* i18n.getUILanguage).toBe("en-US")
    expect(yield* i18n.getAcceptLanguages).toEqual(["en-US", "he"])
    api.getUILanguage.mockReturnValueOnce("he")
    expect(yield* i18n.getUILanguage).toBe("he")
  }))

  it.effect("types throwing and rejected calls", () => Effect.gen(function*() {
    const api = mockApi()
    const cause = new Error("Extension context invalidated.")
    api.getMessage.mockImplementationOnce(() => { throw cause })
    api.getUILanguage.mockImplementationOnce(() => { throw cause })
    api.getAcceptLanguages.mockRejectedValueOnce(cause)
    api.detectLanguage.mockRejectedValueOnce(cause)
    const i18n = make(api)
    const error = yield* Effect.flip(i18n.getMessage("greeting"))
    expect(error).toBeInstanceOf(ChromeI18nError)
    expect(error).toMatchObject({ operation: "getMessage", cause })
    expect(yield* Effect.flip(i18n.getUILanguage)).toMatchObject({ operation: "getUILanguage", cause })
    expect(yield* Effect.flip(i18n.getAcceptLanguages)).toMatchObject({ operation: "getAcceptLanguages", cause })
    expect(yield* Effect.flip(i18n.detectLanguage("x"))).toMatchObject({ operation: "detectLanguage", cause })
  }))

  it.effect("provides an injected API and reads the global only when the live layer builds", () => Effect.gen(function*() {
    const api = mockApi()
    expect(yield* Effect.flatMap(ChromeI18n, (i18n) => i18n.getUILanguage).pipe(Effect.provide(layer(api)))).toBe("en-US")
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", {})), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeI18n.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
  }))
})
