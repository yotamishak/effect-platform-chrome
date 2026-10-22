import { Context, Effect, Layer, Schema, Scope, Semaphore } from "effect"
import { attempter, invoker, liveLayer } from "./internal/api.js"

export class ChromeOffscreenError extends Schema.TaggedError<ChromeOffscreenError>()("ChromeOffscreenError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** The document's page (relative to the extension root), reasons, and justification. */
export type CreateParameters = chrome.offscreen.CreateParameters

/** Why the extension needs the document; Chrome may close it once the reason lapses. */
export type Reason = `${chrome.offscreen.Reason}`

/**
 * The Promise-based MV3 subset this module needs. `getContexts` and `getURL` come from
 * `chrome.runtime` (Chrome 116+); they find the open document by URL. `hasDocument` exists
 * from Chrome 150 only, so it is optional, and calling it where it is absent fails with the
 * typed error.
 */
export interface ChromeOffscreenApi {
  createDocument(parameters: CreateParameters): Promise<void>
  closeDocument(): Promise<void>
  readonly hasDocument?: (() => Promise<boolean>) | undefined
  getContexts(filter: chrome.runtime.ContextFilter): Promise<Array<chrome.runtime.ExtensionContext>>
  getURL(path: string): string
}

/**
 * Interrupting a lifecycle call stops the wait, not Chrome: the call keeps running, and the
 * service's next lifecycle call waits for it to settle before acting.
 */
export interface ChromeOffscreenService {
  /**
   * Creates the offscreen document, resolving once its page has finished its initial load.
   * Chrome allows one per extension (per profile in split incognito mode), so this fails
   * while any offscreen document is open or still loading; prefer `ensureDocument`.
   */
  readonly createDocument: (parameters: CreateParameters) => Effect.Effect<void, ChromeOffscreenError>
  /** Closes the open offscreen document; fails when none is open. */
  readonly closeDocument: Effect.Effect<void, ChromeOffscreenError>
  /**
   * Chrome 150+: whether this extension has an open offscreen document, whatever its URL.
   * Fails with operation `"hasDocument"` in older Chrome; `ensureDocument` does not need it.
   */
  readonly hasDocument: Effect.Effect<boolean, ChromeOffscreenError>
  /**
   * Creates the document at `parameters.url` unless it is already open, resolving to
   * whether this call created it. Calls on one service are serialised, so concurrent
   * callers create it once. If creation still fails because another extension context
   * created the same document meanwhile, that counts as already open. Fails while an
   * offscreen document with a different URL is open (close that one first), or while
   * another context's creation is still loading. A `url` that does not resolve against
   * the extension root fails with operation `"getURL"` before Chrome is called.
   */
  readonly ensureDocument: (parameters: CreateParameters) => Effect.Effect<boolean, ChromeOffscreenError>
  /**
   * A scoped `ensureDocument`. Overlapping scopes on one service share the document, and
   * the last of them to close closes it, whoever created it, provided the document open
   * then is still at this URL. Close failures (for example, the document was already
   * closed) are ignored. Once Chrome has started creating the document, acquisition is
   * not interruptible, so an interrupted acquisition still hands its scope the document
   * to close.
   */
  readonly document: (parameters: CreateParameters) => Effect.Effect<void, ChromeOffscreenError, Scope.Scope>
}

export class ChromeOffscreen extends Context.Service<ChromeOffscreen, ChromeOffscreenService>()(
  "effect-platform-chrome/ChromeOffscreen"
) {}

const invoke = invoker((operation, cause) => new ChromeOffscreenError({ operation, cause }))

const attempt = attempter((operation, cause) => new ChromeOffscreenError({ operation, cause }))

const unavailable = (operation: string) => new Error(`offscreen.${operation} is unavailable before Chrome 150`)

/** What one `document` acquisition holds: the URL it counted a holder for, if any. */
interface Lease {
  url: string | undefined
  closed: boolean
}

/**
 * Creates the service without reading browser globals. Each service serialises its own
 * lifecycle calls (`createDocument`, `closeDocument`, `ensureDocument`, `document` and its
 * release) with one permit.
 */
export const make = (api: ChromeOffscreenApi): ChromeOffscreenService => {
  // One permit: Chrome's single-document rule makes check-then-create a critical section.
  const lock = Semaphore.makeUnsafe(1)
  // Live `document` holders per absolute document URL.
  const holders = new Map<string, number>()
  // Settles when the last create or close call started under the lock does. A caller
  // interrupted while Chrome works releases the lock at once; the next holder waits here.
  let pending: Promise<void> | undefined

  const track = <A>(run: () => Promise<A>) => () => {
    const promise = run()
    const settled = promise.then(() => undefined, () => undefined)

    pending = settled

    return promise
  }

  const settle = Effect.suspend(() => {
    const current = pending

    if (current === undefined) return Effect.void

    return Effect.promise(() => current).pipe(Effect.tap(() => Effect.sync(() => {
      if (pending === current) pending = undefined
    })))
  })

  const create = (parameters: CreateParameters) =>
    invoke("createDocument", track(() => api.createDocument(parameters)))

  const close = invoke("closeDocument", track(() => api.closeDocument()))

  // getContexts reports absolute URLs; resolve the page the way Chrome resolves createDocument's.
  const resolve = (url: string) => attempt("getURL", () => new URL(url, api.getURL("/")).href)

  const isOpen = (documentUrl: string) => invoke("getContexts", () => api.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl]
  })).pipe(Effect.map((contexts) => contexts.length > 0))

  /**
   * Runs under the lock. With `hold`, finding the document counts a holder, and creating
   * it does so atomically with Chrome's call: neither may be lost to interruption.
   */
  const ensure = (parameters: CreateParameters, hold?: (documentUrl: string) => Effect.Effect<void>) =>
    Effect.gen(function*() {
      yield* settle
      const documentUrl = yield* resolve(parameters.url)
      const held = hold === undefined ? Effect.void : Effect.uninterruptible(hold(documentUrl))

      if (yield* isOpen(documentUrl)) return yield* Effect.as(held, false)

      const created = create(parameters).pipe(Effect.andThen(held))

      return yield* (hold === undefined ? created : Effect.uninterruptible(created)).pipe(
        Effect.as(true),
        Effect.catch((error) => isOpen(documentUrl).pipe(
          Effect.mapError(() => error),
          Effect.flatMap((open) => open ? Effect.as(held, false) : Effect.fail(error))
        ))
      )
    })

  const count = (documentUrl: string) => Effect.sync(() => {
    holders.set(documentUrl, (holders.get(documentUrl) ?? 0) + 1)
  })

  // Runs under the lock. A failed lookup cannot rule the document out, so it still closes.
  const release = (documentUrl: string) => Effect.gen(function*() {
    yield* settle
    const remaining = (holders.get(documentUrl) ?? 0) - 1

    if (remaining > 0) {
      holders.set(documentUrl, remaining)

      return
    }

    holders.delete(documentUrl)

    if (yield* Effect.orElseSucceed(isOpen(documentUrl), () => true)) yield* Effect.ignore(close)
  })

  const document = (parameters: CreateParameters) => Effect.gen(function*() {
    const scope = yield* Effect.scope
    const lease: Lease = { url: undefined, closed: false }

    // The finalizer releases a holder counted before the scope closed; an acquisition that
    // completes after the scope closed releases its holder itself, still under the lock.
    yield* Scope.addFinalizer(scope, Effect.suspend(() => {
      const documentUrl = lease.url

      lease.closed = true
      lease.url = undefined

      return documentUrl === undefined ? Effect.void : lock.withPermit(release(documentUrl))
    }))

    yield* lock.withPermit(ensure(parameters, (documentUrl) => Effect.andThen(
      count(documentUrl),
      Effect.suspend(() => {
        if (lease.closed) return release(documentUrl)

        lease.url = documentUrl

        return Effect.void
      })
    )))
  })

  return ChromeOffscreen.of({
    createDocument: (parameters) => lock.withPermit(Effect.andThen(settle, create(parameters))),
    closeDocument: lock.withPermit(Effect.andThen(settle, close)),
    hasDocument: invoke("hasDocument", () => api.hasDocument === undefined
      ? Promise.reject(unavailable("hasDocument"))
      : api.hasDocument()),
    ensureDocument: (parameters) => lock.withPermit(ensure(parameters)),
    document
  })
}

export const layer = (api: ChromeOffscreenApi): Layer.Layer<ChromeOffscreen> => Layer.succeed(ChromeOffscreen, make(api))

/** The globals are read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeOffscreen, ChromeOffscreenError> = liveLayer(
  ChromeOffscreen, "offscreen",
  (chrome): ChromeOffscreenApi | undefined => {
    const { offscreen, runtime } = chrome

    if (offscreen === undefined || runtime === undefined) return undefined

    return {
      createDocument: (parameters) => offscreen.createDocument(parameters),
      closeDocument: () => offscreen.closeDocument(),
      hasDocument: "hasDocument" in offscreen ? () => offscreen.hasDocument() : undefined,
      getContexts: (filter) => runtime.getContexts(filter),
      getURL: (path) => runtime.getURL(path)
    }
  },
  make,
  (cause) => new ChromeOffscreenError({ operation: "initialize", cause })
)
