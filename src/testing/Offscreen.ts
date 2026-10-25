import * as ChromeOffscreen from "../ChromeOffscreen.js"

/** The fixture calls `failNext` can make throw. */
export type OffscreenOperation = "createDocument" | "closeDocument" | "hasDocument" | "getContexts" | "getURL"

/** A pending fixture call: `entered` resolves once it is pending, `release` lets it finish. */
export interface OffscreenHold {
  readonly entered: Promise<void>
  readonly release: () => void
}

interface Gate {
  readonly enter: () => void
  readonly gate: Promise<void>
}

const matches = <A>(allowed: ReadonlyArray<A> | undefined, value: A | undefined) =>
  allowed === undefined || (value !== undefined && allowed.includes(value))

const makeGate = (queue: Array<Gate>): OffscreenHold => {
  let release!: () => void
  let enter!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })

  queue.push({ enter, gate })

  return { entered, release: () => { release() } }
}

/**
 * An in-memory `chrome.offscreen` with Chrome's single-document rule and error messages:
 * `createDocument` fails for a page outside the extension, without a reason, and while a
 * document is open or still loading. As in Chrome, a loading document already exists for
 * `hasDocument` (Chrome 150+) and `closeDocument`; closing it rejects the pending
 * `createDocument` with "Offscreen document closed before fully loading.". `getContexts`
 * reports only a loaded document, as an `OFFSCREEN_DOCUMENT` context honouring every
 * `ContextFilter` field. `getURL` resolves against `chrome-extension://<extensionId>/`.
 * Pass `overrides` to replace any API member, for example `{ hasDocument: undefined }` for
 * Chrome before 150.
 */
export const makeOffscreen = (
  overrides: Partial<ChromeOffscreen.ChromeOffscreenApi> = {},
  extensionId = "test-extension"
) => {
  const origin = `chrome-extension://${extensionId}`
  const created: Array<ChromeOffscreen.CreateParameters> = []
  const createHolds: Array<Gate> = []
  const closeHolds: Array<Gate> = []
  const failures = new Map<OffscreenOperation, Array<Error>>()
  // Aborts the pending creation while a document is loading.
  let loading: (() => void) | undefined
  let closes = 0
  let current: chrome.runtime.ExtensionContext | undefined
  let nextId = 0

  const check = (operation: OffscreenOperation) => {
    const queue = failures.get(operation)

    if (queue !== undefined && queue.length > 0) throw queue.shift()
  }

  const resolve = (path: string) => new URL(path, `${origin}/`).href

  const open = (url: string) => {
    nextId += 1

    current = {
      contextId: `offscreen-${nextId}`,
      contextType: "OFFSCREEN_DOCUMENT",
      documentId: `document-${nextId}`,
      documentOrigin: origin,
      documentUrl: resolve(url),
      frameId: 0,
      incognito: false,
      tabId: -1,
      windowId: -1
    }
  }

  /** Closes the open or loading document, reporting whether there was one. */
  const discard = () => {
    const abort = loading
    const existed = current !== undefined || abort !== undefined

    current = undefined
    loading = undefined
    abort?.()

    return existed
  }

  const pass = async (queue: Array<Gate>) => {
    const hold = queue.shift()

    hold?.enter()
    await hold?.gate
  }

  const api: ChromeOffscreen.ChromeOffscreenApi = {
    createDocument: async (parameters) => {
      created.push(parameters)
      check("createDocument")

      // URL#origin is "null" for chrome-extension: in Node, so compare the prefix.
      if (!resolve(parameters.url).startsWith(`${origin}/`)) throw new Error("Invalid URL.")

      if (parameters.reasons.length === 0) throw new Error("A `reason` must be provided.")

      if (current !== undefined || loading !== undefined) throw new Error("Only a single offscreen document may be created.")

      let abort!: () => void
      const closed = new Promise<"closed">((settle) => { abort = () => { settle("closed") } })
      loading = abort
      const outcome = await Promise.race([pass(createHolds).then(() => "loaded" as const), closed])

      if (outcome === "closed") throw new Error("Offscreen document closed before fully loading.")

      loading = undefined
      open(parameters.url)
    },
    closeDocument: async () => {
      check("closeDocument")

      if (current === undefined && loading === undefined) throw new Error("No current offscreen document.")

      await pass(closeHolds)

      if (discard()) closes += 1
    },
    hasDocument: async () => {
      check("hasDocument")

      return current !== undefined || loading !== undefined
    },
    getContexts: async (filter) => {
      check("getContexts")

      const context = current

      if (context === undefined) return []

      const selected = matches(filter.contextIds, context.contextId) &&
        matches(filter.contextTypes, context.contextType) &&
        matches(filter.documentIds, context.documentId) &&
        matches(filter.documentOrigins, context.documentOrigin) &&
        matches(filter.documentUrls, context.documentUrl) &&
        matches(filter.frameIds, context.frameId) &&
        matches(filter.tabIds, context.tabId) &&
        matches(filter.windowIds, context.windowId) &&
        (filter.incognito === undefined || filter.incognito === context.incognito)

      return selected ? [{ ...context }] : []
    },
    getURL: (path) => {
      check("getURL")

      return resolve(path)
    },
    ...overrides
  }

  return {
    api,
    layer: ChromeOffscreen.layer(api),
    controls: {
      /** The loaded document's absolute URL, if any. */
      get documentUrl() { return current?.documentUrl },
      /** Whether a document is loading: a `createDocument` call is pending. */
      get creating() { return loading !== undefined },
      /** Every `createDocument` call, including failed ones. */
      get created(): ReadonlyArray<ChromeOffscreen.CreateParameters> { return created },
      /** How many documents `closeDocument` has closed. */
      get closed() { return closes },
      /** Opens a document as another extension context would, bypassing the API. */
      open,
      /**
       * Closes the open or loading document as Chrome or another context would, bypassing
       * the API; a pending `createDocument` then rejects.
       */
      close: () => { discard() },
      /**
       * Holds the next `createDocument` that passes Chrome's checks pending until the
       * returned `release` is called; `entered` resolves once that call is pending.
       */
      holdNextCreate: () => makeGate(createHolds),
      /** Holds the next `closeDocument` that finds a document, like `holdNextCreate`. */
      holdNextClose: () => makeGate(closeHolds),
      /** Makes the next call to `operation` throw `cause`; queued causes apply in order. */
      failNext: (operation: OffscreenOperation, cause: Error) => {
        const queue = failures.get(operation) ?? []
        queue.push(cause)
        failures.set(operation, queue)
      }
    }
  }
}
