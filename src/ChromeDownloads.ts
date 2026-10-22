import { Context, Deferred, Effect, Layer, Option, Schema, Stream } from "effect"
import { attempter, invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeDownloadsError extends Schema.TaggedError<ChromeDownloadsError>()("ChromeDownloadsError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** `waitForComplete` saw the download stop in the `interrupted` state. */
export class DownloadInterruptedError extends Schema.TaggedError<DownloadInterruptedError>()("DownloadInterruptedError", {
  downloadId: Schema.Finite,
  /** Chrome's `InterruptReason`, such as `NETWORK_FAILED` or `USER_CANCELED`, when it reported one. */
  reason: Schema.UndefinedOr(Schema.String)
}) {}

export type DownloadItem = chrome.downloads.DownloadItem

export type DownloadDelta = chrome.downloads.DownloadDelta

export type DownloadQuery = chrome.downloads.DownloadQuery

export type DownloadOptions = chrome.downloads.DownloadOptions

export type FilenameSuggestion = chrome.downloads.FilenameSuggestion

/** Chrome's `suggest` callback for `onDeterminingFilename`; calling it with no argument keeps the default name. */
export type SuggestCallback = (suggestion?: FilenameSuggestion) => void

type FilenameEvent = EventSource<[downloadItem: DownloadItem, suggest: SuggestCallback]>

/** One `onDeterminingFilename` event. */
export interface DeterminingFilename {
  readonly item: DownloadItem
  /**
   * Answers Chrome with a filename (relative to the downloads folder), or with no argument
   * to keep the default. Only the first call takes effect; later calls succeed and do nothing.
   */
  readonly suggest: (suggestion?: FilenameSuggestion) => Effect.Effect<void, ChromeDownloadsError>
}

/** The Promise-based MV3 subset this module needs. */
export interface ChromeDownloadsApi {
  download(options: DownloadOptions): Promise<number>
  search(query: DownloadQuery): Promise<Array<DownloadItem>>
  pause(downloadId: number): Promise<void>
  resume(downloadId: number): Promise<void>
  cancel(downloadId: number): Promise<void>
  erase(query: DownloadQuery): Promise<Array<number>>
  removeFile(downloadId: number): Promise<void>
  open(downloadId: number): Promise<void>
  show(downloadId: number): void
  showDefaultFolder(): void
  getFileIcon(downloadId: number, options?: chrome.downloads.GetFileIconOptions): Promise<string | undefined>
  setUiOptions(options: chrome.downloads.UiOptions): Promise<void>
  acceptDanger(downloadId: number): Promise<void>
  readonly onCreated: EventSource<[downloadItem: DownloadItem]>
  readonly onChanged: EventSource<[downloadDelta: DownloadDelta]>
  readonly onErased: EventSource<[downloadId: number]>
  readonly onDeterminingFilename: FilenameEvent
}

export interface ChromeDownloadsService {
  /** Starts a download and resolves to its id. Requires the `downloads` permission, as does every call here. */
  readonly download: (options: DownloadOptions) => Effect.Effect<number, ChromeDownloadsError>
  /** Matching downloads; `{}` lists them all. Erased downloads are not found. */
  readonly search: (query: DownloadQuery) => Effect.Effect<Array<DownloadItem>, ChromeDownloadsError>
  readonly pause: (downloadId: number) => Effect.Effect<void, ChromeDownloadsError>
  readonly resume: (downloadId: number) => Effect.Effect<void, ChromeDownloadsError>
  readonly cancel: (downloadId: number) => Effect.Effect<void, ChromeDownloadsError>
  /** Forgets matching downloads without deleting their files, resolving to the erased ids. */
  readonly erase: (query: DownloadQuery) => Effect.Effect<Array<number>, ChromeDownloadsError>
  /** Deletes a completed download's file, keeping it in the download list. */
  readonly removeFile: (downloadId: number) => Effect.Effect<void, ChromeDownloadsError>
  /** Opens a completed download; needs the `downloads.open` permission and a user gesture. */
  readonly open: (downloadId: number) => Effect.Effect<void, ChromeDownloadsError>
  /** Shows the download's file in the system file manager. */
  readonly show: (downloadId: number) => Effect.Effect<void, ChromeDownloadsError>
  readonly showDefaultFolder: Effect.Effect<void, ChromeDownloadsError>
  /** A data URL of the file's icon; none when Chrome has none for it. */
  readonly getFileIcon: (
    downloadId: number,
    options?: chrome.downloads.GetFileIconOptions
  ) => Effect.Effect<Option.Option<string>, ChromeDownloadsError>
  /** Shows or hides Chrome's download UI for this profile; needs the `downloads.ui` permission. */
  readonly setUiOptions: (options: chrome.downloads.UiOptions) => Effect.Effect<void, ChromeDownloadsError>
  /** Prompts the user to keep a dangerous download; needs a user gesture. */
  readonly acceptDanger: (downloadId: number) => Effect.Effect<void, ChromeDownloadsError>
  /**
   * Resolves to the download once it is `complete`, at once if it already is, and fails with
   * `DownloadInterruptedError` if it is or becomes `interrupted`. The `onChanged` listener is
   * added before the current state is read, so a transition in between is not missed.
   * Waiting does not keep an MV3 service worker alive: for long downloads, persist the id and
   * react to `downloads.onChanged` through ChromeServiceWorker instead.
   */
  readonly waitForComplete: (downloadId: number) => Effect.Effect<DownloadItem, ChromeDownloadsError | DownloadInterruptedError>
  /**
   * Observational subscriptions that cannot wake an MV3 service worker; register wake
   * listeners through ChromeServiceWorker. Each buffers at most 64 events, dropping the oldest.
   */
  readonly onCreated: Stream.Stream<DownloadItem, ChromeDownloadsError>
  readonly onChanged: Stream.Stream<DownloadDelta, ChromeDownloadsError>
  readonly onErased: Stream.Stream<number, ChromeDownloadsError>
  /**
   * Lets this extension choose download filenames, a weak fit for an observational stream.
   * While the stream runs, Chrome holds every download until each event's `suggest` is run,
   * so consume promptly and always suggest. Events that overflow the 64-event buffer, or are
   * still unanswered when the stream ends, are answered with Chrome's default name when it
   * ends. Only one extension listener should choose filenames: when several extensions
   * suggest, Chrome picks one by install order. ChromeServiceWorker's `listen` cannot answer
   * asynchronously, so a worker woken for a download keeps Chrome's default name.
   */
  readonly onDeterminingFilename: Stream.Stream<DeterminingFilename, ChromeDownloadsError>
}

export class ChromeDownloads extends Context.Service<ChromeDownloads, ChromeDownloadsService>()(
  "effect-platform-chrome/ChromeDownloads"
) {}

const fail = (operation: string) => (cause: unknown) => new ChromeDownloadsError({ operation, cause })

const invoke = invoker((operation, cause) => new ChromeDownloadsError({ operation, cause }))

const attempt = attempter((operation, cause) => new ChromeDownloadsError({ operation, cause }))

type FilenameListener = (downloadItem: DownloadItem, suggest: SuggestCallback) => void

/**
 * Wraps `onDeterminingFilename` so each listener returns `true`, telling Chrome it will
 * suggest asynchronously, receives a once-only `suggest`, and has its unanswered events
 * answered with the default name when it is removed.
 */
const answering = (source: FilenameEvent): FilenameEvent => {
  const listeners = new Map<FilenameListener, { readonly wrapped: FilenameListener, readonly pending: Set<SuggestCallback> }>()

  return {
    addListener: (listener) => {
      const pending = new Set<SuggestCallback>()

      // Chrome's typings declare a void listener, but it reads `true` as "will suggest later".
      const wrapped = (item: DownloadItem, suggest: SuggestCallback) => {
        const answer: SuggestCallback = (...suggestion) => {
          if (pending.delete(answer)) suggest(...suggestion)
        }

        pending.add(answer)
        listener(item, answer)

        return true
      }

      listeners.set(listener, { wrapped, pending })
      source.addListener(wrapped)
    },
    removeListener: (listener) => {
      const entry = listeners.get(listener)

      if (entry === undefined) return
      listeners.delete(listener)

      try {
        source.removeListener(entry.wrapped)
      } finally {
        for (const answer of Array.from(entry.pending)) {
          try { answer() } catch { /* Chrome already settled or dropped this download. */ }
        }
      }
    }
  }
}

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeDownloadsApi): ChromeDownloadsService => {
  const search = (query: DownloadQuery) => invoke("search", () => api.search(query))

  const find = (downloadId: number) => search({ id: downloadId }).pipe(
    Effect.flatMap((items) => Effect.fromOption(Option.fromNullishOr(items[0]))),
    Effect.catchTag("NoSuchElementError", () => Effect.fail(new ChromeDownloadsError({
      operation: "waitForComplete",
      cause: new Error(`No download with id: ${downloadId}.`)
    })))
  )

  const waitForComplete = (downloadId: number) => Effect.scoped(Effect.gen(function*() {
    const transition = yield* Deferred.make<void, DownloadInterruptedError>()

    const listener = (delta: DownloadDelta) => {
      if (delta.id !== downloadId) return
      const state = delta.state?.current

      if (state === "complete") Deferred.doneUnsafe(transition, Effect.void)

      if (state === "interrupted") {
        Deferred.doneUnsafe(transition, Effect.fail(new DownloadInterruptedError({ downloadId, reason: delta.error?.current })))
      }
    }

    const source = yield* Effect.try({ try: () => api.onChanged, catch: fail("waitForComplete") })

    // Install cleanup before registration, which may partially succeed then throw.
    yield* Effect.acquireRelease(Effect.succeed(listener), () => Effect.sync(() => source.removeListener(listener)))
    yield* Effect.try({ try: () => source.addListener(listener), catch: fail("waitForComplete") })

    const current = yield* find(downloadId)

    if (current.state === "complete") return current

    if (current.state === "interrupted") {
      return yield* new DownloadInterruptedError({ downloadId, reason: current.error })
    }

    yield* Deferred.await(transition)

    return yield* find(downloadId)
  }))

  return ChromeDownloads.of({
    download: (options) => invoke("download", () => api.download(options)),
    search,
    pause: (downloadId) => invoke("pause", () => api.pause(downloadId)),
    resume: (downloadId) => invoke("resume", () => api.resume(downloadId)),
    cancel: (downloadId) => invoke("cancel", () => api.cancel(downloadId)),
    erase: (query) => invoke("erase", () => api.erase(query)),
    removeFile: (downloadId) => invoke("removeFile", () => api.removeFile(downloadId)),
    open: (downloadId) => invoke("open", () => api.open(downloadId)),
    show: (downloadId) => attempt("show", () => api.show(downloadId)),
    showDefaultFolder: attempt("showDefaultFolder", () => api.showDefaultFolder()),
    getFileIcon: (downloadId, options) => invoke("getFileIcon", () => options === undefined
      ? api.getFileIcon(downloadId)
      : api.getFileIcon(downloadId, options)).pipe(Effect.map(Option.fromNullishOr)),
    setUiOptions: (options) => invoke("setUiOptions", () => api.setUiOptions(options)),
    acceptDanger: (downloadId) => invoke("acceptDanger", () => api.acceptDanger(downloadId)),
    waitForComplete,
    onCreated: observe(() => api.onCreated, (item) => item, fail("onCreated")),
    onChanged: observe(() => api.onChanged, (delta) => delta, fail("onChanged")),
    onErased: observe(() => api.onErased, (downloadId) => downloadId, fail("onErased")),
    onDeterminingFilename: observe(
      () => answering(api.onDeterminingFilename),
      (item, suggest): DeterminingFilename => ({
        item,
        suggest: (suggestion) => attempt("suggest", () => suggestion === undefined ? suggest() : suggest(suggestion))
      }),
      fail("onDeterminingFilename")
    )
  })
}

export const layer = (api: ChromeDownloadsApi): Layer.Layer<ChromeDownloads> => Layer.succeed(ChromeDownloads, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeDownloads, ChromeDownloadsError> = liveLayer(
  ChromeDownloads, "downloads", (chrome) => chrome.downloads, make,
  (cause) => new ChromeDownloadsError({ operation: "initialize", cause })
)
