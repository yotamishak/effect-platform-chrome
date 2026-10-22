// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Exit, Fiber, Scope } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeOffscreen, ChromeOffscreenError, layer, layerLive, make } from "../src/ChromeOffscreen.js"
import type { CreateParameters } from "../src/ChromeOffscreen.js"
import { makeOffscreen } from "../src/testing/Offscreen.js"

const parameters: CreateParameters = {
  url: "offscreen.html",
  reasons: ["DOM_PARSER"],
  justification: "Parse HTML fetched by the service worker"
}

const documentUrl = "chrome-extension://test-extension/offscreen.html"

describe("ChromeOffscreen", () => {
  it.effect("creates and closes the document, failing like Chrome when it is absent or already open", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const offscreen = make(fixture.api)
    yield* offscreen.createDocument(parameters)
    expect(fixture.controls.documentUrl).toBe(documentUrl)
    expect(yield* Effect.flip(offscreen.createDocument(parameters))).toMatchObject({ operation: "createDocument" })
    yield* offscreen.closeDocument
    expect(fixture.controls.documentUrl).toBeUndefined()
    const error = yield* Effect.flip(offscreen.closeDocument)
    expect(error).toBeInstanceOf(ChromeOffscreenError)
    expect(error.operation).toBe("closeDocument")
  }))

  it.effect("ensureDocument creates only when no matching offscreen context exists", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const getContexts = vi.spyOn(fixture.api, "getContexts")
    const offscreen = make(fixture.api)
    expect(yield* offscreen.ensureDocument(parameters)).toBe(true)
    expect(yield* offscreen.ensureDocument({ ...parameters, url: "/offscreen.html" })).toBe(false)
    expect(fixture.controls.created).toHaveLength(1)
    expect(getContexts).toHaveBeenLastCalledWith({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [documentUrl] })
  }))

  it.effect.each([2, 16, 256])("%i concurrent ensureDocument calls create the document exactly once", (count) => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const offscreen = make(fixture.api)
    const hold = fixture.controls.holdNextCreate()

    // Each fiber runs until it suspends: the first inside createDocument, the rest on the lock.
    const fibers = yield* Effect.forEach(Array.from({ length: count }), () =>
      Effect.forkChild(offscreen.ensureDocument(parameters), { startImmediately: true }))

    yield* Effect.promise(() => hold.entered)
    expect(fixture.controls.created).toHaveLength(1)
    hold.release()

    const created = yield* Effect.forEach(fibers, Fiber.join)
    expect(created.filter(Boolean)).toHaveLength(1)
    expect(created[0]).toBe(true)
    expect(fixture.controls.created).toHaveLength(1)
    expect(fixture.controls.documentUrl).toBe(documentUrl)
  }))

  it.effect("the fixture reproduces the race that ensureDocument serialises away", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const hold = fixture.controls.holdNextCreate()
    const first = fixture.api.createDocument(parameters)
    yield* Effect.promise(() => hold.entered)
    const second = yield* Effect.promise(() => fixture.api.createDocument(parameters).then(() => "created", () => "rejected"))
    expect(second).toBe("rejected")
    hold.release()
    yield* Effect.promise(() => first)
    expect(fixture.controls.documentUrl).toBe(documentUrl)
  }))

  it.effect("a failed creation releases the lock for waiting and later callers", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const offscreen = make(fixture.api)
    const cause = new Error("Reasons must not be empty")
    fixture.controls.failNext("createDocument", cause)
    const hold = fixture.controls.holdNextCreate()

    const failing = yield* Effect.forkChild(offscreen.ensureDocument(parameters), { startImmediately: true })
    const waiting = yield* Effect.forkChild(offscreen.ensureDocument(parameters), { startImmediately: true })

    const error = yield* Effect.flip(Fiber.join(failing))
    expect(error).toBeInstanceOf(ChromeOffscreenError)
    expect(error).toMatchObject({ operation: "createDocument", cause })

    yield* Effect.promise(() => hold.entered)
    hold.release()
    expect(yield* Fiber.join(waiting)).toBe(true)
    expect(yield* offscreen.ensureDocument(parameters)).toBe(false)
    expect(fixture.controls.documentUrl).toBe(documentUrl)
  }))

  it.effect("a lookup failure fails ensureDocument without creating and releases the lock", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const offscreen = make(fixture.api)
    const cause = new Error("getContexts unavailable")
    fixture.controls.failNext("getContexts", cause)
    expect(yield* Effect.flip(offscreen.ensureDocument(parameters))).toMatchObject({ operation: "getContexts", cause })
    expect(fixture.controls.created).toHaveLength(0)
    expect(yield* offscreen.ensureDocument(parameters)).toBe(true)
  }))

  it.effect("treats a document created meanwhile by another context as already open", () => Effect.gen(function*() {
    const fixture = makeOffscreen()

    const offscreen = make({
      ...fixture.api,
      createDocument: (details) => {
        fixture.controls.open(details.url)

        return fixture.api.createDocument(details)
      }
    })

    expect(yield* offscreen.ensureDocument(parameters)).toBe(false)
    expect(fixture.controls.created).toHaveLength(1)
  }))

  it.effect("fails while a document with another URL is open", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    fixture.controls.open("audio.html")
    const error = yield* Effect.flip(make(fixture.api).ensureDocument(parameters))
    expect(error.operation).toBe("createDocument")
    expect(fixture.controls.documentUrl).toBe("chrome-extension://test-extension/audio.html")
  }))

  it.effect("document closes on release, and overlapping scopes share it until the last closes", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const offscreen = make(fixture.api)

    yield* Effect.scoped(offscreen.document(parameters))
    expect(fixture.controls.documentUrl).toBeUndefined()

    const outer = yield* Scope.make()
    const inner = yield* Scope.make()
    yield* Scope.provide(offscreen.document(parameters), outer)
    yield* Scope.provide(offscreen.document(parameters), inner)
    expect(fixture.controls.created).toHaveLength(2)
    yield* Scope.close(outer, Exit.void)
    expect(fixture.controls.documentUrl).toBe(documentUrl)
    yield* Scope.close(inner, Exit.void)
    expect(fixture.controls.documentUrl).toBeUndefined()
  }))

  it.effect("document release ignores an already closed document, and a failed acquire holds nothing", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const offscreen = make(fixture.api)

    yield* Effect.scoped(Effect.gen(function*() {
      yield* offscreen.document(parameters)
      fixture.controls.close()
    }))

    fixture.controls.failNext("createDocument", new Error("denied"))
    expect(yield* Effect.flip(Effect.scoped(offscreen.document(parameters)))).toMatchObject({ operation: "createDocument" })

    yield* Effect.scoped(offscreen.document(parameters))
    expect(fixture.controls.documentUrl).toBeUndefined()
  }))

  it.effect("provides an injected API and reads the globals only when the live layer builds", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    expect(yield* Effect.flatMap(ChromeOffscreen, (service) => service.ensureDocument(parameters)).pipe(Effect.provide(layer(fixture.api)))).toBe(true)
    yield* Effect.acquireRelease(Effect.sync(() => vi.stubGlobal("chrome", { runtime: {} })), () => Effect.sync(() => vi.unstubAllGlobals()))
    expect(yield* Effect.flip(ChromeOffscreen.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
    vi.stubGlobal("chrome", { offscreen: fixture.api, runtime: fixture.api })
    expect(yield* Effect.flatMap(ChromeOffscreen, (service) => service.ensureDocument(parameters)).pipe(Effect.provide(layerLive))).toBe(false)
  }))
})
