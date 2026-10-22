// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Fiber, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeOmnibox, ChromeOmniboxError, layer, layerLive, make } from "../src/ChromeOmnibox.js"
import type { SuggestResult } from "../src/ChromeOmnibox.js"
import { makeOmnibox } from "../src/testing/Omnibox.js"

const results: ReadonlyArray<SuggestResult> = [
  { content: "docs effect", description: "Search docs for <match>effect</match>" },
  { content: "docs stream", description: "Search docs for <match>stream</match>", deletable: true }
]

describe("ChromeOmnibox", () => {
  it.effect("sets the default suggestion and types a rejection", () => Effect.gen(function*() {
    const fake = makeOmnibox()
    yield* make(fake.api).setDefaultSuggestion({ description: "Search docs for <match>%s</match>" })
    expect(fake.controls.defaultSuggestion).toEqual({ description: "Search docs for <match>%s</match>" })
    const cause = new Error("Invalid description markup")
    const rejecting = makeOmnibox({ setDefaultSuggestion: vi.fn(async () => { throw cause }) })
    const error = yield* Effect.flip(make(rejecting.api).setDefaultSuggestion({ description: "<b>" }))
    expect(error).toBeInstanceOf(ChromeOmniboxError)
    expect(error).toMatchObject({ operation: "setDefaultSuggestion", cause })
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

  it.effect("types a throwing suggest callback as suggest", () => Effect.gen(function*() {
    const fake = makeOmnibox()
    const cause = new Error("Suggestion for stale input")

    const failures = yield* Effect.forkScoped(make(fake.api).onInputChanged.pipe(
      Stream.take(1),
      Stream.mapEffect((change) => Effect.flip(change.suggest(results))),
      Stream.runCollect
    ))

    yield* Effect.promise(() => fake.controls.onInputChanged.waitForListener())
    fake.controls.onInputChanged.emit("x", () => { throw cause })
    expect(yield* Fiber.join(failures)).toMatchObject([{ operation: "suggest", cause }])
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
    expect(fake.controls.onInputStarted.listenerCount + fake.controls.onInputEntered.listenerCount
      + fake.controls.onInputCancelled.listenerCount + fake.controls.onDeleteSuggestion.listenerCount).toBe(0)
  }))

  it.effect("types a failed listener registration with the event name", () => Effect.gen(function*() {
    const fake = makeOmnibox()
    const cause = new Error("listener rejected")
    fake.controls.onInputEntered.failNext("addListener", cause)
    expect(yield* Effect.flip(Stream.runDrain(make(fake.api).onInputEntered))).toMatchObject({ operation: "onInputEntered", cause })
  }))

  it.effect("provides an injected API and reads the global only when the live layer builds", () => Effect.gen(function*() {
    const fake = makeOmnibox()
    yield* Effect.flatMap(ChromeOmnibox, (omnibox) => omnibox.setDefaultSuggestion({ description: "Docs" })).pipe(Effect.provide(layer(fake.api)))
    expect(fake.controls.defaultSuggestion).toEqual({ description: "Docs" })
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", {})), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeOmnibox.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
  }))
})
