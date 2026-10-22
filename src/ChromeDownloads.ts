import { Context, Deferred, Effect, Exit, Layer, Option, Queue, Schema, Stream } from "effect"
import { attempter, invoker, liveLayer } from "./internal/api.js"
import { bufferSize, observe, type EventSource } from "./internal/event.js"
import { starter } from "./internal/gesture.js"

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

/** One `onDeterminingFilename` event. */
export interface DeterminingFilename {
  readonly item: DownloadItem
  /**
   * Answers Chrome with a filename (relative to the downloads folder), or with no argument
   * to keep the default. Only the first accepted answer takes effect; later calls succeed and
   * do nothing. A suggestion Chrome throws on fails with the typed error and leaves the event
   * unanswered, so it can be answered again.
   */
  readonly suggest: (suggestion?: FilenameSuggestion) => Effect.Effect<void, ChromeDownloadsError>
}

/**
 * The Promise-based MV3 subset this module needs. `setUiOptions` is Chrome 105+ and optional,
 * so older browsers and injected APIs without it still fit; calling it when absent fails with
 * the typed error. The deprecated `setShelfEnabled` is left out in favour of `setUiOptions`.
 */
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
  readonly setUiOptions?: (options: chrome.downloads.UiOptions) => Promise<void>
  acceptDanger(downloadId: number): Promise<void>
  readonly onCreated: EventSource<[downloadItem: DownloadItem]>
  readonly onChanged: EventSource<[downloadDelta: DownloadDelta]>
  readonly onErased: EventSource<[downloadId: number]>
  readonly onDeterminingFilename: EventSource<[downloadItem: DownloadItem, suggest: SuggestCallback]>
}

export interface ChromeDownloadsService {
  /**
   * Starts a download and resolves to its id. A `filename` is relative to the downloads
   * folder; Chrome rejects absolute paths and `..`. Every call here needs the `downloads`
   * permission.
   */
  readonly download: (options: DownloadOptions) => Effect.Effect<number, ChromeDownloadsError>
  /**
   * Matching downloads; `{}` lists them (up to `limit`, 1000 by default, 0 for all). Erased
   * downloads are not found.
   */
  readonly search: (query: DownloadQuery) => Effect.Effect<Array<DownloadItem>, ChromeDownloadsError>
  /** Pauses an in-progress download; Chrome rejects one that is not active. */
  readonly pause: (downloadId: number) => Effect.Effect<void, ChromeDownloadsError>
  /** Resumes a paused or resumable interrupted download; Chrome rejects one that cannot resume. */
  readonly resume: (downloadId: number) => Effect.Effect<void, ChromeDownloadsError>
  /** Cancels a download; resolves once it is cancelled, complete, interrupted or gone. */
  readonly cancel: (downloadId: number) => Effect.Effect<void, ChromeDownloadsError>
  /** Forgets matching downloads without deleting their files, resolving to the erased ids. */
  readonly erase: (query: DownloadQuery) => Effect.Effect<Array<number>, ChromeDownloadsError>
  /** Deletes a completed download's file, keeping it in the download list. */
  readonly removeFile: (downloadId: number) => Effect.Effect<void, ChromeDownloadsError>
  /**
   * Opens a completed download; needs the `downloads.open` permission. Chrome only honours it
   * inside a user gesture. Lazy: composing it inside a handler does not call Chrome, so prefer
   * `openFromUserGesture` there. Chrome returns a Promise from it since Chrome 123; earlier
   * builds return nothing, which fails here with a `TypeError` cause.
   */
  readonly open: (downloadId: number) => Effect.Effect<void, ChromeDownloadsError>
  /**
   * The user-gesture bridge for `open`: calls Chrome NOW, on the caller's synchronous stack,
   * and returns an Effect observing that one call. Running it again replays the outcome.
   */
  readonly openFromUserGesture: (downloadId: number) => Effect.Effect<void, ChromeDownloadsError>
  /**
   * Shows the download's file in the system file manager. Chrome reports no outcome: an
   * unknown id is only logged by Chrome, and only a synchronous throw becomes the error.
   */
  readonly show: (downloadId: number) => Effect.Effect<void, ChromeDownloadsError>
  /** Shows the default downloads folder in the system file manager. */
  readonly showDefaultFolder: Effect.Effect<void, ChromeDownloadsError>
  /**
   * A data URL of the file's icon (`size` 16 or 32, default 32), None when Chrome resolves
   * without one. Chrome rejects while the filename is undetermined or no icon can be found.
   */
  readonly getFileIcon: (
    downloadId: number,
    options?: chrome.downloads.GetFileIconOptions
  ) => Effect.Effect<Option.Option<string>, ChromeDownloadsError>
  /**
   * Shows or hides Chrome's download UI for this profile (Chrome 105+); needs the
   * `downloads.ui` permission. Chrome rejects enabling it while another extension disables it.
   */
  readonly setUiOptions: (options: chrome.downloads.UiOptions) => Effect.Effect<void, ChromeDownloadsError>
  /**
   * Prompts the user to keep a dangerous in-progress download, resolving when the prompt
   * closes; it never accepts by itself. Chrome needs a visible extension page (tab, window or
   * popup) and a user action, so prefer `acceptDangerFromUserGesture` in handlers.
   */
  readonly acceptDanger: (downloadId: number) => Effect.Effect<void, ChromeDownloadsError>
  /**
   * The user-gesture bridge for `acceptDanger`: calls Chrome NOW, on the caller's synchronous
   * stack, and returns an Effect observing that one prompt. Running it again replays the outcome.
   */
  readonly acceptDangerFromUserGesture: (downloadId: number) => Effect.Effect<void, ChromeDownloadsError>
  /**
   * Resolves to the download once it is `complete`, at once if it already is, and fails with
   * `DownloadInterruptedError` if it is `interrupted` or becomes so while waiting. The
   * `onChanged` listener is added before the current state is read, so a transition in between
   * is not missed. A paused or unaccepted dangerous download keeps it waiting. An unknown (or
   * erased) id fails with operation `"search"`; a listener registration failure with
   * `"onChanged"`. Waiting does not keep an MV3 service worker alive: for long downloads,
   * persist the id and react to `downloads.onChanged` through ChromeServiceWorker instead.
   */
  readonly waitForComplete: (downloadId: number) => Effect.Effect<DownloadItem, ChromeDownloadsError | DownloadInterruptedError>
  /**
   * Observational subscriptions that cannot wake an MV3 service worker; register wake
   * listeners through ChromeServiceWorker. Each buffers at most 64 events, dropping the oldest.
   */
  readonly onCreated: Stream.Stream<DownloadItem, ChromeDownloadsError>
  /** Changed fields of a download (never `bytesReceived` or `estimatedEndTime`). */
  readonly onChanged: Stream.Stream<DownloadDelta, ChromeDownloadsError>
  /** Ids of downloads erased from the list. */
  readonly onErased: Stream.Stream<number, ChromeDownloadsError>
  /**
   * Lets this extension choose download filenames, a weak fit for an observational stream.
   * While the stream runs, Chrome holds every download until each event's `suggest` is run,
   * so consume promptly and always suggest. An event the 64-event buffer drops is answered
   * with Chrome's default name at once; events still unanswered when the stream ends,
   * including ones taken but never answered, are answered with the default name then. Chrome
   * allows one listener per extension across all its contexts, so run one such stream at a
   * time; when several extensions suggest, Chrome picks one by install order.
   * ChromeServiceWorker's `listen` cannot answer asynchronously, so a worker woken for a
   * download keeps Chrome's default name.
   */
  readonly onDeterminingFilename: Stream.Stream<DeterminingFilename, ChromeDownloadsError>
}

export class ChromeDownloads extends Context.Service<ChromeDownloads, ChromeDownloadsService>()(
  "effect-platform-chrome/ChromeDownloads"
) {}

const onError = (operation: string, cause: unknown) => new ChromeDownloadsError({ operation, cause })

const fail = (operation: string) => (cause: unknown) => onError(operation, cause)

const invoke = invoker(onError)

const attempt = attempter(onError)

const start = starter(onError)

/** An `onDeterminingFilename` event this subscription has not answered yet. */
interface Pending {
  readonly event: DeterminingFilename
  /** Answers with Chrome's default name, unless already answered. Never throws. */
  readonly keepDefault: () => void
}

/**
 * `onDeterminingFilename` as a stream. It cannot use `observe`, because every event it drops
 * must still be answered: Chrome holds a download until its `suggest` runs. Each listener
 * returns `true`, telling Chrome it suggests asynchronously. The buffer is the same 64-event
 * sliding buffer; `undelivered` mirrors it (plus events taken but not yet emitted), so the
 * event a full buffer drops on each offer is known and answered with the default name at
 * once. When the stream ends, every event still unanswered gets the default name.
 */
const determiningFilename = (
  getSource: () => EventSource<[downloadItem: DownloadItem, suggest: SuggestCallback]>
): Stream.Stream<DeterminingFilename, ChromeDownloadsError> => Stream.suspend(() => {
  const unanswered = new Set<Pending>()
  // Offered to the buffer and not yet emitted, oldest first; the buffer holds a suffix.
  const undelivered: Array<Pending> = []

  const pending = (item: DownloadItem, suggest: SuggestCallback): Pending => {
    let answered = false

    const answer = (suggestion: FilenameSuggestion | undefined) => {
      if (answered) return

      // Chrome may throw on an invalid suggestion; the event then stays unanswered.
      if (suggestion === undefined) suggest()
      else suggest(suggestion)

      answered = true
      unanswered.delete(entry)
    }

    const entry: Pending = {
      event: { item, suggest: (suggestion) => attempt("suggest", () => answer(suggestion)) },
      keepDefault: () => {
        try {
          answer(undefined)
        } catch {
          // Chrome already settled or dropped this download; nothing is left to answer.
          answered = true
          unanswered.delete(entry)
        }
      }
    }

    unanswered.add(entry)

    return entry
  }

  return Stream.callback<Pending, ChromeDownloadsError>((queue) => {
    let active = true

    // Chrome's typings declare a void listener, but it reads `true` as "will suggest later".
    const listener = (item: DownloadItem, suggest: SuggestCallback): boolean => {
      const entry = pending(item, suggest)

      if (!active) {
        entry.keepDefault()

        return true
      }

      const held = Queue.sizeUnsafe(queue)

      if (!Queue.offerUnsafe(queue, entry)) {
        entry.keepDefault()

        return true
      }

      if (held >= bufferSize) {
        // The sliding buffer just dropped its oldest event, which no consumer will see.
        const [dropped] = undelivered.splice(undelivered.length - held, 1)
        dropped?.keepDefault()
      }

      undelivered.push(entry)

      return true
    }

    return Effect.gen(function*() {
      const source = yield* Effect.try({ try: getSource, catch: fail("onDeterminingFilename") })

      // Install cleanup before registration, which may partially succeed then throw.
      yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => {
        active = false

        try {
          source.removeListener(listener)
        } finally {
          undelivered.length = 0

          for (const entry of Array.from(unanswered)) entry.keepDefault()
        }
      }))
      yield* Effect.try({ try: () => source.addListener(listener), catch: fail("onDeterminingFilename") })
    })
  }, { bufferSize, strategy: "sliding" }).pipe(Stream.map((entry) => {
    const index = undelivered.indexOf(entry)

    if (index !== -1) undelivered.splice(index, 1)

    return entry.event
  }))
})

type Settled =
  | { readonly state: "complete" }
  | { readonly state: "interrupted", readonly reason: string | undefined }

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeDownloadsApi): ChromeDownloadsService => {
  const search = (query: DownloadQuery) => invoke("search", () => api.search(query))

  const find = (downloadId: number) => Effect.flatMap(search({ id: downloadId }), (items) => {
    const item = items.find((candidate) => candidate.id === downloadId)

    return item === undefined
      ? Effect.fail(onError("search", new Error(`No download with id: ${downloadId}.`)))
      : Effect.succeed(item)
  })

  const waitForComplete = (downloadId: number) => Effect.scoped(Effect.gen(function*() {
    const settled = yield* Deferred.make<Settled>()

    const listener = (delta: DownloadDelta) => {
      if (delta.id !== downloadId) return
      const state = delta.state?.current

      if (state === "complete") Deferred.doneUnsafe(settled, Exit.succeed({ state }))
      else if (state === "interrupted") Deferred.doneUnsafe(settled, Exit.succeed({ state, reason: delta.error?.current }))
    }

    const source = yield* Effect.try({ try: () => api.onChanged, catch: fail("onChanged") })

    // Install cleanup before registration, which may partially succeed then throw.
    yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => source.removeListener(listener)))
    yield* Effect.try({ try: () => source.addListener(listener), catch: fail("onChanged") })

    const current = yield* find(downloadId)

    if (current.state === "complete") return current

    if (current.state === "interrupted") {
      return yield* new DownloadInterruptedError({ downloadId, reason: current.error })
    }

    const outcome = yield* Deferred.await(settled)

    if (outcome.state === "interrupted") {
      // A delta may carry the state without the reason; the item then has it.
      const reason = outcome.reason ?? (yield* find(downloadId).pipe(
        Effect.map((item) => item.error),
        Effect.orElseSucceed(() => undefined)
      ))

      return yield* new DownloadInterruptedError({ downloadId, reason })
    }

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
    openFromUserGesture: (downloadId) => start("open", () => api.open(downloadId)),
    show: (downloadId) => attempt("show", () => api.show(downloadId)),
    showDefaultFolder: attempt("showDefaultFolder", () => api.showDefaultFolder()),
    getFileIcon: (downloadId, options) => invoke("getFileIcon", () => options === undefined
      ? api.getFileIcon(downloadId)
      : api.getFileIcon(downloadId, options)).pipe(Effect.map(Option.fromNullishOr)),
    setUiOptions: (options) => invoke("setUiOptions", () => api.setUiOptions === undefined
      ? Promise.reject(new Error("downloads.setUiOptions is unavailable"))
      : api.setUiOptions(options)),
    acceptDanger: (downloadId) => invoke("acceptDanger", () => api.acceptDanger(downloadId)),
    acceptDangerFromUserGesture: (downloadId) => start("acceptDanger", () => api.acceptDanger(downloadId)),
    waitForComplete,
    onCreated: observe(() => api.onCreated, (item) => item, fail("onCreated")),
    onChanged: observe(() => api.onChanged, (delta) => delta, fail("onChanged")),
    onErased: observe(() => api.onErased, (downloadId) => downloadId, fail("onErased")),
    onDeterminingFilename: determiningFilename(() => api.onDeterminingFilename)
  })
}

export const layer = (api: ChromeDownloadsApi): Layer.Layer<ChromeDownloads> => Layer.succeed(ChromeDownloads, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeDownloads, ChromeDownloadsError> = liveLayer(
  ChromeDownloads, "downloads", (chrome) => chrome.downloads, make,
  (cause) => new ChromeDownloadsError({ operation: "initialize", cause })
)
