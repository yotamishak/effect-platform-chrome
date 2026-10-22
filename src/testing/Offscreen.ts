import * as ChromeOffscreen from "../ChromeOffscreen.js"

type Operation = "createDocument" | "closeDocument" | "getContexts"

const matches = <A>(allowed: ReadonlyArray<A> | undefined, value: A | undefined) =>
  allowed === undefined || (value !== undefined && allowed.includes(value))

/**
 * An in-memory `chrome.offscreen` with Chrome's single-document rule: `createDocument`
 * fails while a document is open or still being created, and `closeDocument` fails when
 * none is open. `getContexts` reports the open document as an `OFFSCREEN_DOCUMENT` context.
 */
export const makeOffscreen = (extensionId = "test-extension") => {
  const origin = `chrome-extension://${extensionId}`
  const created: Array<ChromeOffscreen.CreateParameters> = []
  const holds: Array<{ readonly enter: () => void, readonly gate: Promise<void> }> = []
  const failures = new Map<Operation, Array<Error>>()
  let creating = false
  let current: chrome.runtime.ExtensionContext | undefined
  let nextId = 0

  const check = (operation: Operation) => {
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

  const api: ChromeOffscreen.ChromeOffscreenApi = {
    createDocument: async (parameters) => {
      check("createDocument")
      created.push(parameters)

      if (current !== undefined || creating) throw new Error("Only a single offscreen document may be created.")

      creating = true

      const hold = holds.shift()

      try {
        hold?.enter()
        await hold?.gate
      } finally {
        creating = false
      }

      open(parameters.url)
    },
    closeDocument: async () => {
      check("closeDocument")

      if (current === undefined) throw new Error("No current offscreen document.")

      current = undefined
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
    getURL: (path) => resolve(path)
  }

  return {
    api,
    layer: ChromeOffscreen.layer(api),
    controls: {
      /** The open document's absolute URL, if any. */
      get documentUrl() { return current?.documentUrl },
      /** Every `createDocument` call, including failed ones. */
      get created(): ReadonlyArray<ChromeOffscreen.CreateParameters> { return created },
      /** Opens a document as another extension context would, bypassing the API. */
      open,
      /** Closes the document as Chrome or another context would. */
      close: () => { current = undefined },
      /**
       * Holds the next successful `createDocument` pending until the returned function is
       * called; `entered` resolves once that call is pending.
       */
      holdNextCreate: () => {
        let release!: () => void
        let enter!: () => void
        const entered = new Promise<void>((resolve) => { enter = resolve })
        const gate = new Promise<void>((resolve) => { release = resolve })

        holds.push({ enter, gate })

        return { entered, release: () => { release() } }
      },
      failNext: (operation: Operation, cause: Error) => {
        const queue = failures.get(operation) ?? []
        queue.push(cause)
        failures.set(operation, queue)
      }
    }
  }
}
