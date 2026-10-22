// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Exit, Fiber, Layer, Scope } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeOffscreen, ChromeOffscreenError, layer, layerLive, make } from "../src/ChromeOffscreen.js"
import type { ChromeOffscreenApi, ChromeOffscreenService, CreateParameters } from "../src/ChromeOffscreen.js"
import { makeOffscreen } from "../src/testing/Offscreen.js"

const parameters: CreateParameters = {
  url: "offscreen.html",
  reasons: ["DOM_PARSER"],
  justification: "Parse HTML fetched by the service worker"
}

const audio: CreateParameters = { url: "audio.html", reasons: ["AUDIO_PLAYBACK"], justification: "Play sounds" }

const documentUrl = "chrome-extension://test-extension/offscreen.html"

const audioUrl = "chrome-extension://test-extension/audio.html"

type Mode = "reject" | "throw"

/** A Chrome call that fails with `cause`, as a rejection or as a synchronous throw. */
const failing = (mode: Mode, cause: Error) => (): Promise<never> => {
  if (mode === "throw") throw cause

  return Promise.reject(cause)
}

interface FailureCase {
  readonly name: string
  readonly operation: string
  readonly api: (mode: Mode, cause: Error) => Partial<ChromeOffscreenApi>
  readonly run: (service: ChromeOffscreenService) => Effect.Effect<void, ChromeOffscreenError>
}

const scopedDocument = (service: ChromeOffscreenService) => Effect.scoped(service.document(parameters))

const failureCases: ReadonlyArray<FailureCase> = [
  {
    name: "createDocument",
    operation: "createDocument",
    api: (mode, cause) => ({ createDocument: failing(mode, cause) }),
    run: (service) => service.createDocument(parameters)
  },
  {
    name: "closeDocument",
    operation: "closeDocument",
    api: (mode, cause) => ({ closeDocument: failing(mode, cause) }),
    run: (service) => service.closeDocument
  },
  {
    name: "hasDocument",
    operation: "hasDocument",
    api: (mode, cause) => ({ hasDocument: failing(mode, cause) }),
    run: (service) => Effect.asVoid(service.hasDocument)
  },
  {
    name: "ensureDocument's lookup",
    operation: "getContexts",
    api: (mode, cause) => ({ getContexts: failing(mode, cause) }),
    run: (service) => Effect.asVoid(service.ensureDocument(parameters))
  },
  {
    name: "ensureDocument's creation, with a failing second lookup",
    operation: "createDocument",
    api: (mode, cause) => {
      let lookups = 0

      return {
        createDocument: failing(mode, cause),
        getContexts: () => {
          lookups += 1

          return lookups === 1 ? Promise.resolve([]) : Promise.reject(new Error("second lookup failed"))
        }
      }
    },
    run: (service) => Effect.asVoid(service.ensureDocument(parameters))
  },
  {
    name: "document's lookup",
    operation: "getContexts",
    api: (mode, cause) => ({ getContexts: failing(mode, cause) }),
    run: scopedDocument
  },
  {
    name: "document's creation",
    operation: "createDocument",
    api: (mode, cause) => ({ createDocument: failing(mode, cause) }),
    run: scopedDocument
  }
]

const urlCases: ReadonlyArray<FailureCase> = [
  {
    name: "ensureDocument",
    operation: "getURL",
    api: (_, cause) => ({ getURL: () => { throw cause } }),
    run: (service) => Effect.asVoid(service.ensureDocument(parameters))
  },
  {
    name: "document",
    operation: "getURL",
    api: (_, cause) => ({ getURL: () => { throw cause } }),
    run: scopedDocument
  }
]

describe("ChromeOffscreen calls", () => {
  it.effect.each(failureCases.flatMap((failure) => (["reject", "throw"] as const).map((mode) => ({ failure, mode }))))(
    "maps a $mode from $failure.name to the typed error",
    ({ failure, mode }) => Effect.gen(function*() {
      const cause = new Error(`${failure.name} ${mode}`)
      const fixture = makeOffscreen(failure.api(mode, cause))
      const service = make(fixture.api)
      const error = yield* Effect.flip(failure.run(service))

      expect(error).toBeInstanceOf(ChromeOffscreenError)
      expect(error.operation).toBe(failure.operation)
      expect(error.cause).toBe(cause)
      expect(fixture.controls.documentUrl).toBeUndefined()

      // The permit was released: a lifecycle call afterwards still runs.
      fixture.controls.open("other.html")
      expect(Exit.isSuccess(yield* Effect.exit(service.closeDocument))).toBe(failure.name !== "closeDocument")
    })
  )

  it.effect.each(urlCases)("maps a getURL throw in $name to the typed error without calling Chrome", (failure) => Effect.gen(function*() {
    const cause = new TypeError("Invalid URL")
    const fixture = makeOffscreen(failure.api("throw", cause))
    const getContexts = vi.spyOn(fixture.api, "getContexts")
    const error = yield* Effect.flip(failure.run(make(fixture.api)))

    expect(error).toMatchObject({ operation: "getURL", cause })
    expect(getContexts).not.toHaveBeenCalled()
    expect(fixture.controls.created).toHaveLength(0)
  }))

  it.effect("passes the parameters to Chrome unchanged and resolves pages against the extension root", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const createDocument = vi.spyOn(fixture.api, "createDocument")
    const getURL = vi.spyOn(fixture.api, "getURL")
    const service = make(fixture.api)

    yield* service.createDocument(parameters)
    expect(createDocument).toHaveBeenCalledExactlyOnceWith(parameters)
    expect(createDocument.mock.calls[0]?.[0]).toBe(parameters)
    yield* service.closeDocument
    yield* service.ensureDocument(parameters)
    expect(getURL).toHaveBeenCalledWith("/")
    expect(createDocument).toHaveBeenLastCalledWith(parameters)
  }))

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

  it.effect("closeDocument is a reusable Effect value", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const offscreen = make(fixture.api)
    const close = offscreen.closeDocument

    for (let round = 0; round < 3; round += 1) {
      yield* offscreen.createDocument(parameters)
      yield* close
    }

    expect(fixture.controls.closed).toBe(3)
  }))

  it.effect("hasDocument reports any open document, whatever its URL", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const offscreen = make(fixture.api)
    expect(yield* offscreen.hasDocument).toBe(false)
    fixture.controls.open("audio.html")
    expect(yield* offscreen.hasDocument).toBe(true)
    fixture.controls.close()
    expect(yield* offscreen.hasDocument).toBe(false)
  }))

  it.effect("hasDocument fails with the typed error where Chrome lacks it (before 150)", () => Effect.gen(function*() {
    const fixture = makeOffscreen({ hasDocument: undefined })
    const error = yield* Effect.flip(make(fixture.api).hasDocument)
    expect(error).toBeInstanceOf(ChromeOffscreenError)
    expect(error.operation).toBe("hasDocument")
    expect(String(error.cause)).toContain("unavailable before Chrome 150")
    // Everything else still works without it.
    expect(yield* make(fixture.api).ensureDocument(parameters)).toBe(true)
  }))

  it.effect("hasDocument does not wait for the lifecycle permit", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const offscreen = make(fixture.api)
    const hold = fixture.controls.holdNextCreate()
    const creating = yield* Effect.forkChild(offscreen.ensureDocument(parameters), { startImmediately: true })
    yield* Effect.promise(() => hold.entered)
    expect(yield* offscreen.hasDocument).toBe(false)
    hold.release()
    expect(yield* Fiber.join(creating)).toBe(true)
    expect(yield* offscreen.hasDocument).toBe(true)
  }))
})

describe("ChromeOffscreen.ensureDocument", () => {
  it.effect("creates only when no matching offscreen context exists", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const getContexts = vi.spyOn(fixture.api, "getContexts")
    const offscreen = make(fixture.api)
    expect(yield* offscreen.ensureDocument(parameters)).toBe(true)
    expect(yield* offscreen.ensureDocument({ ...parameters, url: "/offscreen.html" })).toBe(false)
    expect(fixture.controls.created).toHaveLength(1)
    expect(getContexts).toHaveBeenLastCalledWith({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [documentUrl] })
  }))

  it.effect.each(["offscreen.html", "/offscreen.html", "./offscreen.html", "nested/../offscreen.html", documentUrl])(
    "treats %s as the same page",
    (url) => Effect.gen(function*() {
      const fixture = makeOffscreen()
      const offscreen = make(fixture.api)
      fixture.controls.open("offscreen.html")
      expect(yield* offscreen.ensureDocument({ ...parameters, url })).toBe(false)
      expect(fixture.controls.created).toHaveLength(0)
    })
  )

  it.effect("treats a different query string as a different page", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const getContexts = vi.spyOn(fixture.api, "getContexts")
    const offscreen = make(fixture.api)
    expect(yield* offscreen.ensureDocument({ ...parameters, url: "offscreen.html?mode=a" })).toBe(true)
    expect(getContexts).toHaveBeenCalledWith({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [`${documentUrl}?mode=a`] })
    expect(yield* Effect.flip(offscreen.ensureDocument(parameters))).toMatchObject({ operation: "createDocument" })
  }))

  it.effect("fails with getURL before calling Chrome for a URL that does not resolve", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const getContexts = vi.spyOn(fixture.api, "getContexts")
    const error = yield* Effect.flip(make(fixture.api).ensureDocument({ ...parameters, url: "http://[" }))
    expect(error.operation).toBe("getURL")
    expect(error.cause).toBeInstanceOf(TypeError)
    expect(getContexts).not.toHaveBeenCalled()
    expect(fixture.controls.created).toHaveLength(0)
  }))

  it.effect("passes a page outside the extension to Chrome, which rejects it", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const getContexts = vi.spyOn(fixture.api, "getContexts")
    const error = yield* Effect.flip(make(fixture.api).ensureDocument({ ...parameters, url: "https://example.com/page.html" }))
    expect(getContexts).toHaveBeenCalledWith({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: ["https://example.com/page.html"] })
    expect(error.operation).toBe("createDocument")
    expect(String(error.cause)).toContain("extension pages")
    expect(fixture.controls.documentUrl).toBeUndefined()
  }))

  it.effect("resolves against the extension id getURL reports", () => Effect.gen(function*() {
    const fixture = makeOffscreen({}, "abcdefghijklmnop")
    expect(yield* make(fixture.api).ensureDocument(parameters)).toBe(true)
    expect(fixture.controls.documentUrl).toBe("chrome-extension://abcdefghijklmnop/offscreen.html")
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

  it.effect("keeps createDocument's error when the second lookup finds nothing", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const cause = new Error("Page failed to load")
    fixture.controls.failNext("createDocument", cause)
    const getContexts = vi.spyOn(fixture.api, "getContexts")
    expect(yield* Effect.flip(make(fixture.api).ensureDocument(parameters))).toMatchObject({ operation: "createDocument", cause })
    expect(getContexts).toHaveBeenCalledTimes(2)
  }))

  it.effect("fails while a document with another URL is open", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    fixture.controls.open("audio.html")
    const error = yield* Effect.flip(make(fixture.api).ensureDocument(parameters))
    expect(error.operation).toBe("createDocument")
    expect(String(error.cause)).toContain("single offscreen document")
    expect(fixture.controls.documentUrl).toBe(audioUrl)
  }))

  it.effect("fails while another context's creation is still loading, and finds the document once it has", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const hold = fixture.controls.holdNextCreate()
    const elsewhere = fixture.api.createDocument(parameters)
    yield* Effect.promise(() => hold.entered)
    const offscreen = make(fixture.api)
    expect(yield* Effect.flip(offscreen.ensureDocument(parameters))).toMatchObject({ operation: "createDocument" })
    hold.release()
    yield* Effect.promise(() => elsewhere)
    expect(yield* offscreen.ensureDocument(parameters)).toBe(false)
  }))
})

describe("ChromeOffscreen interruption", () => {
  it.effect("an ensureDocument interrupted mid-creation lets the next caller find the document", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const offscreen = make(fixture.api)
    const hold = fixture.controls.holdNextCreate()
    const first = yield* Effect.forkChild(offscreen.ensureDocument(parameters), { startImmediately: true })
    yield* Effect.promise(() => hold.entered)

    // Interruption is prompt: Chrome's call cannot be cancelled, so it keeps going.
    expect(Exit.hasInterrupts(yield* Fiber.interrupt(first).pipe(Effect.andThen(Fiber.await(first))))).toBe(true)
    expect(fixture.controls.creating).toBe(true)

    // Without waiting for that call, this would collide with it and fail.
    const second = yield* Effect.forkChild(offscreen.ensureDocument(parameters), { startImmediately: true })
    expect(second.pollUnsafe()).toBeUndefined()
    expect(fixture.controls.created).toHaveLength(1)
    hold.release()
    expect(yield* Fiber.join(second)).toBe(false)
    expect(fixture.controls.created).toHaveLength(1)
    expect(fixture.controls.documentUrl).toBe(documentUrl)
  }))

  it.effect("a createDocument interrupted mid-call settles before the next closeDocument", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const offscreen = make(fixture.api)
    const hold = fixture.controls.holdNextCreate()
    const creating = yield* Effect.forkChild(offscreen.createDocument(parameters), { startImmediately: true })
    yield* Effect.promise(() => hold.entered)
    yield* Fiber.interrupt(creating)
    const closing = yield* Effect.forkChild(offscreen.closeDocument, { startImmediately: true })
    expect(closing.pollUnsafe()).toBeUndefined()
    hold.release()
    yield* Fiber.join(closing)
    expect(fixture.controls.documentUrl).toBeUndefined()
    expect(fixture.controls.closed).toBe(1)
  }))

  it.effect("a closeDocument interrupted mid-call settles before the next createDocument", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const offscreen = make(fixture.api)
    yield* offscreen.createDocument(parameters)
    const hold = fixture.controls.holdNextClose()
    const closing = yield* Effect.forkChild(offscreen.closeDocument, { startImmediately: true })
    yield* Effect.promise(() => hold.entered)
    yield* Fiber.interrupt(closing)
    expect(fixture.controls.documentUrl).toBe(documentUrl)
    const creating = yield* Effect.forkChild(offscreen.createDocument(audio), { startImmediately: true })
    expect(creating.pollUnsafe()).toBeUndefined()
    hold.release()
    yield* Fiber.join(creating)
    expect(fixture.controls.documentUrl).toBe(audioUrl)
  }))

  it.effect("a synchronous throw leaves nothing for the next caller to wait on", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    let throwing = true
    const cause = new Error("sync")

    const offscreen = make({
      ...fixture.api,
      createDocument: (details) => {
        if (throwing) throw cause

        return fixture.api.createDocument(details)
      }
    })

    expect(yield* Effect.flip(offscreen.createDocument(parameters))).toMatchObject({ operation: "createDocument", cause })
    throwing = false
    yield* offscreen.createDocument(parameters)
    expect(fixture.controls.documentUrl).toBe(documentUrl)
  }))

  it.effect("a waiter interrupted on the permit leaves without calling Chrome", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const offscreen = make(fixture.api)
    const getContexts = vi.spyOn(fixture.api, "getContexts")
    const hold = fixture.controls.holdNextCreate()
    const owner = yield* Effect.forkChild(offscreen.ensureDocument(parameters), { startImmediately: true })
    yield* Effect.promise(() => hold.entered)

    const waiters = yield* Effect.forEach([
      offscreen.ensureDocument(parameters),
      offscreen.createDocument(parameters),
      offscreen.closeDocument,
      Effect.scoped(offscreen.document(parameters))
    ], (effect) => Effect.forkChild(effect, { startImmediately: true }))

    yield* Effect.forEach(waiters, Fiber.interrupt)
    expect(waiters.every((fiber) => fiber.pollUnsafe() !== undefined)).toBe(true)
    expect(getContexts).toHaveBeenCalledTimes(1)
    hold.release()
    expect(yield* Fiber.join(owner)).toBe(true)
    expect(fixture.controls.created).toHaveLength(1)
    expect(fixture.controls.closed).toBe(0)
    expect(fixture.controls.documentUrl).toBe(documentUrl)
  }))
})

describe("ChromeOffscreen.document", () => {
  it.effect("closes on release, and overlapping scopes share it until the last closes", () => Effect.gen(function*() {
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

  it.effect("release ignores an already closed document, and a failed acquire holds nothing", () => Effect.gen(function*() {
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
    expect(fixture.controls.closed).toBe(1)
  }))

  it.effect("the last scope closes a document a plain ensureDocument created", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const offscreen = make(fixture.api)
    expect(yield* offscreen.ensureDocument(parameters)).toBe(true)
    yield* Effect.scoped(offscreen.document(parameters))
    expect(fixture.controls.documentUrl).toBeUndefined()
  }))

  it.effect("release leaves alone a document that replaced the scope's page", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const offscreen = make(fixture.api)
    const scope = yield* Scope.make()
    yield* Scope.provide(offscreen.document(parameters), scope)
    fixture.controls.close()
    fixture.controls.open("audio.html")
    yield* Scope.close(scope, Exit.void)
    expect(fixture.controls.documentUrl).toBe(audioUrl)
    expect(fixture.controls.closed).toBe(0)
  }))

  it.effect("counts holders per page when the document is swapped under open scopes", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const offscreen = make(fixture.api)
    const first = yield* Scope.make()
    const second = yield* Scope.make()
    yield* Scope.provide(offscreen.document(parameters), first)
    yield* offscreen.closeDocument
    yield* Scope.provide(offscreen.document(audio), second)
    yield* Scope.close(first, Exit.void)
    expect(fixture.controls.documentUrl).toBe(audioUrl)
    yield* Scope.close(second, Exit.void)
    expect(fixture.controls.documentUrl).toBeUndefined()
    expect(fixture.controls.closed).toBe(2)
  }))

  it.effect("the replacement page's last holder closes it even while the old page's holder stays", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const offscreen = make(fixture.api)
    const first = yield* Scope.make()
    const second = yield* Scope.make()
    yield* Scope.provide(offscreen.document(parameters), first)
    fixture.controls.close()
    yield* Scope.provide(offscreen.document(audio), second)
    yield* Scope.close(second, Exit.void)
    expect(fixture.controls.documentUrl).toBeUndefined()
    yield* Scope.close(first, Exit.void)
    expect(fixture.controls.closed).toBe(1)
  }))

  it.effect("release waits for a close an interrupted caller left pending", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const offscreen = make(fixture.api)
    const scope = yield* Scope.make()
    yield* Scope.provide(offscreen.document(parameters), scope)
    const hold = fixture.controls.holdNextClose()
    const closing = yield* Effect.forkChild(offscreen.closeDocument, { startImmediately: true })
    yield* Effect.promise(() => hold.entered)
    yield* Fiber.interrupt(closing)
    const releasing = yield* Effect.forkChild(Scope.close(scope, Exit.void), { startImmediately: true })
    expect(releasing.pollUnsafe()).toBeUndefined()
    hold.release()
    yield* Fiber.join(releasing)
    expect(fixture.controls.closed).toBe(1)
    expect(fixture.controls.documentUrl).toBeUndefined()
  }))

  it.effect("a page that came back under the same URL is closed by the last holder", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const offscreen = make(fixture.api)
    const scope = yield* Scope.make()
    yield* Scope.provide(offscreen.document(parameters), scope)
    fixture.controls.close()
    fixture.controls.open("offscreen.html")
    yield* Scope.close(scope, Exit.void)
    expect(fixture.controls.documentUrl).toBeUndefined()
  }))

  it.effect("release still closes when its lookup fails", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const offscreen = make(fixture.api)
    const scope = yield* Scope.make()
    yield* Scope.provide(offscreen.document(parameters), scope)
    fixture.controls.failNext("getContexts", new Error("lookup failed"))
    yield* Scope.close(scope, Exit.void)
    expect(fixture.controls.documentUrl).toBeUndefined()
  }))

  it.effect("release ignores a failing close and frees the permit", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const offscreen = make(fixture.api)
    const scope = yield* Scope.make()
    yield* Scope.provide(offscreen.document(parameters), scope)
    fixture.controls.failNext("closeDocument", new Error("close failed"))
    yield* Scope.close(scope, Exit.void)
    expect(fixture.controls.documentUrl).toBe(documentUrl)
    expect(yield* offscreen.ensureDocument(parameters)).toBe(false)
    yield* Effect.scoped(offscreen.document(parameters))
    expect(fixture.controls.documentUrl).toBeUndefined()
  }))

  it.effect("an acquisition interrupted mid-creation hands its scope the document to close", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const offscreen = make(fixture.api)
    const hold = fixture.controls.holdNextCreate()
    const user = yield* Effect.forkChild(Effect.scoped(Effect.andThen(offscreen.document(parameters), Effect.never)), { startImmediately: true })
    yield* Effect.promise(() => hold.entered)
    const interrupting = yield* Effect.forkChild(Fiber.interrupt(user), { startImmediately: true })

    // Creation cannot be abandoned half-way, so interruption waits for it.
    expect(user.pollUnsafe()).toBeUndefined()
    expect(interrupting.pollUnsafe()).toBeUndefined()
    hold.release()
    yield* Fiber.join(interrupting)
    expect(Exit.hasInterrupts(yield* Fiber.await(user))).toBe(true)
    expect(fixture.controls.created).toHaveLength(1)
    expect(fixture.controls.closed).toBe(1)
    expect(fixture.controls.documentUrl).toBeUndefined()
  }))

  it.effect("an acquisition interrupted during its lookup holds nothing", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    let enter!: () => void
    const entered = new Promise<void>((resolve) => { enter = resolve })

    const offscreen = make({
      ...fixture.api,
      getContexts: () => {
        enter()

        return new Promise(() => {})
      }
    })

    const scope = yield* Scope.make()
    const user = yield* Effect.forkChild(Scope.provide(offscreen.document(parameters), scope), { startImmediately: true })
    yield* Effect.promise(() => entered)
    yield* Fiber.interrupt(user)
    yield* Scope.close(scope, Exit.void)
    expect(fixture.controls.created).toHaveLength(0)
    expect(fixture.controls.closed).toBe(0)
  }))

  it.effect("an acquisition that completes after its scope closed releases the document itself", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const offscreen = make(fixture.api)
    const hold = fixture.controls.holdNextCreate()
    const scope = yield* Scope.make()
    const user = yield* Effect.forkChild(Scope.provide(offscreen.document(parameters), scope), { startImmediately: true })
    yield* Effect.promise(() => hold.entered)
    yield* Scope.close(scope, Exit.void)
    expect(fixture.controls.documentUrl).toBeUndefined()
    hold.release()
    yield* Fiber.join(user)
    expect(fixture.controls.created).toHaveLength(1)
    expect(fixture.controls.closed).toBe(1)
    expect(fixture.controls.documentUrl).toBeUndefined()
    expect(yield* offscreen.ensureDocument(parameters)).toBe(true)
  }))

  it.effect("an acquisition in an already closed scope opens and closes the document", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const offscreen = make(fixture.api)
    const scope = yield* Scope.make()
    yield* Scope.close(scope, Exit.void)
    yield* Scope.provide(offscreen.document(parameters), scope)
    expect(fixture.controls.created).toHaveLength(1)
    expect(fixture.controls.closed).toBe(1)
  }))

  it.effect("a late acquisition in a closed scope only drops its own holder", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const offscreen = make(fixture.api)
    const keeper = yield* Scope.make()
    yield* Scope.provide(offscreen.document(parameters), keeper)
    const closed = yield* Scope.make()
    yield* Scope.close(closed, Exit.void)
    yield* Scope.provide(offscreen.document(parameters), closed)
    expect(fixture.controls.documentUrl).toBe(documentUrl)
    yield* Scope.close(keeper, Exit.void)
    expect(fixture.controls.documentUrl).toBeUndefined()
  }))

  it.effect("a release waiting for the permit runs after the pending lifecycle call", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const offscreen = make(fixture.api)
    const scope = yield* Scope.make()
    yield* Scope.provide(offscreen.document(parameters), scope)
    const hold = fixture.controls.holdNextCreate()
    yield* offscreen.closeDocument
    const creating = yield* Effect.forkChild(offscreen.createDocument(parameters), { startImmediately: true })
    yield* Effect.promise(() => hold.entered)
    const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void), { startImmediately: true })
    expect(closing.pollUnsafe()).toBeUndefined()
    hold.release()
    yield* Fiber.join(creating)
    yield* Fiber.join(closing)
    // The scope's last holder closes the page now open at its URL.
    expect(fixture.controls.documentUrl).toBeUndefined()
    expect(fixture.controls.closed).toBe(2)
  }))

  it.effect("concurrent scopes on two pages: the second page fails while the first is held", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const offscreen = make(fixture.api)
    yield* Effect.scoped(Effect.gen(function*() {
      yield* offscreen.document(parameters)
      expect(yield* Effect.flip(Effect.scoped(offscreen.document(audio)))).toMatchObject({ operation: "createDocument" })
      expect(fixture.controls.documentUrl).toBe(documentUrl)
    }))
    expect(fixture.controls.documentUrl).toBeUndefined()
  }))

  it.effect("services built from one API keep separate permits and holder counts", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const first = make(fixture.api)
    const second = make(fixture.api)
    const scope = yield* Scope.make()
    yield* Scope.provide(first.document(parameters), scope)
    // The second service does not know about the first service's holder.
    yield* Effect.scoped(second.document(parameters))
    expect(fixture.controls.documentUrl).toBeUndefined()
    yield* Scope.close(scope, Exit.void)
    expect(fixture.controls.closed).toBe(1)
  }))
})

class FakeOffscreen {
  readonly created: Array<CreateParameters> = []
  open = false

  createDocument(details: CreateParameters) {
    this.created.push(details)
    this.open = true

    return Promise.resolve()
  }

  closeDocument() {
    this.open = false

    return Promise.resolve()
  }
}

class FakeOffscreen150 extends FakeOffscreen {
  hasDocument() {
    return Promise.resolve(this.open)
  }
}

const fakeRuntime = (fixture: ReturnType<typeof makeOffscreen>) => ({
  getContexts: (filter: chrome.runtime.ContextFilter) => fixture.api.getContexts(filter),
  getURL: (path: string) => fixture.api.getURL(path)
})

describe("ChromeOffscreen layers", () => {
  it.effect("provides an injected API through layer", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    expect(yield* Effect.flatMap(ChromeOffscreen, (service) => service.ensureDocument(parameters)).pipe(Effect.provide(layer(fixture.api)))).toBe(true)
    expect(yield* Effect.flatMap(ChromeOffscreen, (service) => service.hasDocument).pipe(Effect.provide(fixture.layer))).toBe(true)
  }))

  it.effect("layerLive fails with initialize without a chrome global", () => Effect.gen(function*() {
    expect("chrome" in globalThis).toBe(false)
    const error = yield* Effect.flip(Layer.build(layerLive))
    expect(error).toBeInstanceOf(ChromeOffscreenError)
    expect(error.operation).toBe("initialize")
    expect(String(error.cause)).toContain("chrome.offscreen is unavailable")
  }))

  it.effect.each([
    { name: "offscreen", chrome: { runtime: {} } },
    { name: "runtime", chrome: { offscreen: {} } }
  ])("layerLive fails with initialize without chrome.$name", ({ chrome }) => Effect.gen(function*() {
    vi.stubGlobal("chrome", chrome)
    expect(yield* Effect.flip(ChromeOffscreen.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
  }))

  it.effect("layerLive calls the namespaces as methods and passes hasDocument through (Chrome 150+)", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const offscreen = new FakeOffscreen150()
    vi.stubGlobal("chrome", { offscreen, runtime: fakeRuntime(fixture) })
    const service = yield* ChromeOffscreen.pipe(Effect.provide(layerLive))
    vi.unstubAllGlobals()

    // Built once, the service no longer reads the globals.
    yield* service.createDocument(parameters)
    expect(offscreen.created).toEqual([parameters])
    expect(yield* service.hasDocument).toBe(true)
    yield* service.closeDocument
    expect(yield* service.hasDocument).toBe(false)
    fixture.controls.open("offscreen.html")
    expect(yield* service.ensureDocument(parameters)).toBe(false)
  }))

  it.effect("layerLive types hasDocument as unavailable where Chrome lacks it", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    vi.stubGlobal("chrome", { offscreen: new FakeOffscreen(), runtime: fakeRuntime(fixture) })
    const service = yield* ChromeOffscreen.pipe(Effect.provide(layerLive))
    expect(yield* Effect.flip(service.hasDocument)).toMatchObject({ operation: "hasDocument" })
    expect(yield* service.ensureDocument(parameters)).toBe(true)
  }))

  it.effect("layerLive maps a throwing getter on the global to initialize", () => Effect.gen(function*() {
    const cause = new Error("getter failed")
    vi.stubGlobal("chrome", { get offscreen(): never { throw cause }, runtime: {} })
    expect(yield* Effect.flip(ChromeOffscreen.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize", cause })
  }))
})

describe("makeOffscreen", () => {
  it.effect("reports the open document through getContexts, honouring every filter field", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const query = (filter: chrome.runtime.ContextFilter) => Effect.promise(() => fixture.api.getContexts(filter))
    expect(yield* query({})).toEqual([])
    fixture.controls.open("offscreen.html")
    const [context] = yield* query({})
    expect(context).toEqual({
      contextId: "offscreen-1",
      contextType: "OFFSCREEN_DOCUMENT",
      documentId: "document-1",
      documentOrigin: "chrome-extension://test-extension",
      documentUrl,
      frameId: 0,
      incognito: false,
      tabId: -1,
      windowId: -1
    })

    const misses: ReadonlyArray<chrome.runtime.ContextFilter> = [
      { contextIds: ["other"] },
      { contextTypes: ["TAB"] },
      { documentIds: ["other"] },
      { documentOrigins: ["chrome-extension://other"] },
      { documentUrls: [audioUrl] },
      { frameIds: [1] },
      { tabIds: [1] },
      { windowIds: [1] },
      { incognito: true },
      { contextTypes: [] }
    ]

    for (const filter of misses) expect(yield* query(filter)).toEqual([])

    expect(yield* query({ contextIds: ["offscreen-1"], documentIds: ["document-1"], tabIds: [-1], windowIds: [-1], frameIds: [0], incognito: false })).toHaveLength(1)

    // Results are copies: changing one does not change the document.
    const [copy] = yield* query({})

    if (copy !== undefined) copy.documentUrl = "mutated"

    expect(fixture.controls.documentUrl).toBe(documentUrl)

    fixture.controls.open("audio.html")
    expect(yield* query({})).toMatchObject([{ contextId: "offscreen-2", documentUrl: audioUrl }])
  }))

  it.effect("records every createDocument call, queues failures in order, and holds closes", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const first = new Error("first")
    const second = new Error("second")
    fixture.controls.failNext("createDocument", first)
    fixture.controls.failNext("createDocument", second)
    const outcome = (promise: Promise<void>) => Effect.promise(() => promise.then(() => undefined, (error: Error) => error))
    expect(yield* outcome(fixture.api.createDocument(parameters))).toBe(first)
    expect(yield* outcome(fixture.api.createDocument(parameters))).toBe(second)
    expect(yield* outcome(fixture.api.createDocument(parameters))).toBeUndefined()
    expect(fixture.controls.created).toHaveLength(3)
    expect(fixture.controls.creating).toBe(false)

    const hold = fixture.controls.holdNextClose()
    const closing = fixture.api.closeDocument()
    yield* Effect.promise(() => hold.entered)
    expect(fixture.controls.documentUrl).toBe(documentUrl)
    hold.release()
    yield* Effect.promise(() => closing)
    expect(fixture.controls.documentUrl).toBeUndefined()
    expect(fixture.controls.closed).toBe(1)
    expect(yield* outcome(fixture.api.closeDocument())).toMatchObject({ message: "No current offscreen document." })
  }))

  it.effect("fails hasDocument and getURL on demand, getURL synchronously", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const cause = new Error("no")
    fixture.controls.failNext("getURL", cause)
    expect(() => fixture.api.getURL("/")).toThrow(cause)
    expect(fixture.api.getURL("page.html")).toBe("chrome-extension://test-extension/page.html")
    fixture.controls.failNext("hasDocument", cause)
    expect(yield* Effect.flip(make(fixture.api).hasDocument)).toMatchObject({ operation: "hasDocument", cause })
  }))

  it.effect("reports a held creation as in progress until it is released", () => Effect.gen(function*() {
    const fixture = makeOffscreen()
    const hold = fixture.controls.holdNextCreate()
    const creating = fixture.api.createDocument(parameters)
    yield* Effect.promise(() => hold.entered)
    expect(fixture.controls.creating).toBe(true)
    hold.release()
    yield* Effect.promise(() => creating)
    expect(fixture.controls.creating).toBe(false)
    expect(fixture.controls.documentUrl).toBe(documentUrl)
  }))

  it.effect("overrides replace API members and the layer uses them", () => Effect.gen(function*() {
    const fixture = makeOffscreen({ hasDocument: () => Promise.resolve(true) })
    expect(yield* Effect.flatMap(ChromeOffscreen, (service) => service.hasDocument).pipe(Effect.provide(fixture.layer))).toBe(true)
    expect(fixture.controls.documentUrl).toBeUndefined()
  }))
})
