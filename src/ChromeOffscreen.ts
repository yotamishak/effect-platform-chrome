import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import type { Scope } from "effect"
import { attempter, invoker, liveLayer } from "./internal/api.js"

export class ChromeOffscreenError extends Schema.TaggedError<ChromeOffscreenError>()("ChromeOffscreenError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** The document's page (relative to the extension root), reasons, and justification. */
export type CreateParameters = chrome.offscreen.CreateParameters

/**
 * The Promise-based MV3 subset this module needs. `getContexts` and `getURL` come from
 * `chrome.runtime`; they find an open document, since `offscreen.hasDocument` exists only
 * in recent Chrome releases.
 */
export interface ChromeOffscreenApi {
  createDocument(parameters: CreateParameters): Promise<void>
  closeDocument(): Promise<void>
  getContexts(filter: chrome.runtime.ContextFilter): Promise<Array<chrome.runtime.ExtensionContext>>
  getURL(path: string): string
}

export interface ChromeOffscreenService {
  /**
   * Creates the offscreen document. Chrome allows one per extension, so this fails while
   * any offscreen document is open; prefer `ensureDocument`.
   */
  readonly createDocument: (parameters: CreateParameters) => Effect.Effect<void, ChromeOffscreenError>
  /** Closes the open offscreen document; fails when none is open. */
  readonly closeDocument: Effect.Effect<void, ChromeOffscreenError>
  /**
   * Creates the document at `parameters.url` unless it is already open, resolving to
   * whether this call created it. Calls on one service are serialised, so concurrent
   * callers create it once. If creation still fails because another extension context
   * created the same document meanwhile, that counts as already open. Fails while an
   * offscreen document with a different URL is open: close that one first.
   */
  readonly ensureDocument: (parameters: CreateParameters) => Effect.Effect<boolean, ChromeOffscreenError>
  /**
   * A scoped `ensureDocument`. Overlapping scopes on one service share the document, and
   * the last of them to close closes it, whoever created it. Close failures (for example,
   * the document was already closed) are ignored.
   */
  readonly document: (parameters: CreateParameters) => Effect.Effect<void, ChromeOffscreenError, Scope.Scope>
}

export class ChromeOffscreen extends Context.Service<ChromeOffscreen, ChromeOffscreenService>()(
  "effect-platform-chrome/ChromeOffscreen"
) {}

const invoke = invoker((operation, cause) => new ChromeOffscreenError({ operation, cause }))

const attempt = attempter((operation, cause) => new ChromeOffscreenError({ operation, cause }))

/** Creates the service without reading browser globals. Each service serialises its own lifecycle calls. */
export const make = (api: ChromeOffscreenApi): ChromeOffscreenService => {
  // One permit: Chrome's single-document rule makes check-then-create a critical section.
  const lock = Semaphore.makeUnsafe(1)
  let holders = 0

  const create = (parameters: CreateParameters) => invoke("createDocument", () => api.createDocument(parameters))

  const close = invoke("closeDocument", () => api.closeDocument())

  // getContexts reports absolute URLs; resolve the page the way Chrome resolves createDocument's.
  const isOpen = (url: string) => Effect.gen(function*() {
    const documentUrl = yield* attempt("getURL", () => new URL(url, api.getURL("/")).href)

    const contexts = yield* invoke("getContexts", () => api.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [documentUrl]
    }))

    return contexts.length > 0
  })

  const ensure = (parameters: CreateParameters) => Effect.gen(function*() {
    if (yield* isOpen(parameters.url)) return false

    return yield* create(parameters).pipe(
      Effect.as(true),
      Effect.catch((error) => isOpen(parameters.url).pipe(
        Effect.mapError(() => error),
        Effect.flatMap((open) => open ? Effect.succeed(false) : Effect.fail(error))
      ))
    )
  })

  const release = Effect.suspend(() => {
    holders -= 1

    return holders === 0 ? Effect.ignore(close) : Effect.void
  })

  return ChromeOffscreen.of({
    createDocument: (parameters) => lock.withPermit(create(parameters)),
    closeDocument: lock.withPermit(close),
    ensureDocument: (parameters) => lock.withPermit(ensure(parameters)),
    document: (parameters) => Effect.acquireRelease(
      lock.withPermit(ensure(parameters).pipe(Effect.tap(() => Effect.sync(() => { holders += 1 })))),
      () => lock.withPermit(release)
    ).pipe(Effect.asVoid)
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
      getContexts: (filter) => runtime.getContexts(filter),
      getURL: (path) => runtime.getURL(path)
    }
  },
  make,
  (cause) => new ChromeOffscreenError({ operation: "initialize", cause })
)
