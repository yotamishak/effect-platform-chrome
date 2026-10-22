import { Context, Effect, Layer, Schema, Stream } from "effect"
import { attempter, invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeOmniboxError extends Schema.TaggedError<ChromeOmniboxError>()("ChromeOmniboxError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/**
 * One dropdown row. `content` (non-empty) is put into the address bar and sent back to the
 * extension when the row is chosen. `description` (non-empty) may use nested `<url>`, `<match>`
 * and `<dim>` markup and must escape the five predefined XML entities to show them as text.
 * `deletable` (Chrome 63+) lets the user remove the row, which emits `onDeleteSuggestion`.
 */
export type SuggestResult = chrome.omnibox.SuggestResult

/** The first dropdown row: a `SuggestResult` without `content`; `description` is non-empty. */
export type DefaultSuggestResult = chrome.omnibox.DefaultSuggestResult

/** Where Chrome recommends showing the result: `currentTab`, `newForegroundTab` or `newBackgroundTab`. */
export type Disposition = `${chrome.omnibox.OnInputEnteredDisposition}`

type NativeSuggest = (suggestResults: Array<SuggestResult>) => void

export interface InputChangedEvent {
  /** The text after the keyword; empty when the user cleared it. */
  readonly text: string
  /**
   * Answers this keystroke with suggestions for the dropdown, through the `suggest` callback
   * Chrome passed with it; a later call replaces the rows, and an empty list clears them.
   * Lazy: nothing reaches Chrome until the Effect runs. Chrome checks the results' types
   * synchronously, and a throw fails with `operation: "suggest"`; it parses the markup
   * afterwards and reports malformed markup only to the console.
   */
  readonly suggest: (suggestResults: ReadonlyArray<SuggestResult>) => Effect.Effect<void, ChromeOmniboxError>
}

export interface InputEnteredEvent {
  readonly text: string
  readonly disposition: Disposition
}

/** The Promise-based MV3 subset this module needs (the Promise form of `setDefaultSuggestion` is Chrome 100+). */
export interface ChromeOmniboxApi {
  setDefaultSuggestion(suggestion: DefaultSuggestResult): Promise<void>
  readonly onInputStarted: EventSource<[]>
  readonly onInputChanged: EventSource<[text: string, suggest: NativeSuggest]>
  readonly onInputEntered: EventSource<[text: string, disposition: Disposition]>
  readonly onInputCancelled: EventSource<[]>
  readonly onDeleteSuggestion: EventSource<[text: string]>
}

/**
 * The streams are observational subscriptions that cannot wake an MV3 service worker. Omnibox
 * input usually arrives at a sleeping worker, so register wake listeners through
 * `ChromeServiceWorker.listen` (see `inputChanged`). Each subscription owns one listener,
 * removed when its scope closes, and buffers at most 64 events, dropping the oldest.
 */
export interface ChromeOmniboxService {
  /**
   * Sets the first dropdown row, shown above any suggestions. Chrome stores it in the
   * extension's preferences, so it outlasts the service worker. Its description may use
   * `<url>`, `<match>` and `<dim>` markup, and Chrome replaces its first `%s` with the current
   * input. An empty description or malformed markup fails.
   */
  readonly setDefaultSuggestion: (suggestion: DefaultSuggestResult) => Effect.Effect<void, ChromeOmniboxError>
  /** The user typed the keyword: once per keyword session, before any `onInputChanged`. */
  readonly onInputStarted: Stream.Stream<void, ChromeOmniboxError>
  /**
   * Each keystroke's text and its `suggest` reply. A lookup may finish after newer input
   * arrived; `Stream.switchMap` interrupts the stale one.
   */
  readonly onInputChanged: Stream.Stream<InputChangedEvent, ChromeOmniboxError>
  /** The user accepted the input; `disposition` is where Chrome recommends showing the result. */
  readonly onInputEntered: Stream.Stream<InputEnteredEvent, ChromeOmniboxError>
  /** The keyword session ended without the user accepting the input. */
  readonly onInputCancelled: Stream.Stream<void, ChromeOmniboxError>
  /** The `content` of a `deletable` suggestion the user removed (Chrome 63+). */
  readonly onDeleteSuggestion: Stream.Stream<string, ChromeOmniboxError>
}

export class ChromeOmnibox extends Context.Service<ChromeOmnibox, ChromeOmniboxService>()("effect-platform-chrome/ChromeOmnibox") {}

const onError = (operation: string, cause: unknown) => new ChromeOmniboxError({ operation, cause })

const invoke = invoker(onError)

const attempt = attempter(onError)

const eventError = (operation: string) => (cause: unknown) => onError(operation, cause)

/**
 * The `onInputChanged` event for Chrome's native `(text, suggest)` arguments, as the stream
 * emits it. Use it in a wake listener so it answers through the same Effect-returning
 * `suggest`: `ChromeServiceWorker.listen(chrome.omnibox.onInputChanged, (text, suggest) =>
 * handle(ChromeOmnibox.inputChanged(text, suggest)))`. Each `suggest` call sends a fresh copy
 * of the results.
 */
export const inputChanged = (text: string, suggest: NativeSuggest): InputChangedEvent => ({
  text,
  suggest: (suggestResults) => attempt("suggest", () => suggest(Array.from(suggestResults)))
})

const inputEntered = (text: string, disposition: Disposition): InputEnteredEvent => ({ text, disposition })

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeOmniboxApi): ChromeOmniboxService => ChromeOmnibox.of({
  setDefaultSuggestion: (suggestion) => invoke("setDefaultSuggestion", () => api.setDefaultSuggestion(suggestion)),
  onInputStarted: observe(() => api.onInputStarted, () => undefined, eventError("onInputStarted")),
  onInputChanged: observe(() => api.onInputChanged, inputChanged, eventError("onInputChanged")),
  onInputEntered: observe(() => api.onInputEntered, inputEntered, eventError("onInputEntered")),
  onInputCancelled: observe(() => api.onInputCancelled, () => undefined, eventError("onInputCancelled")),
  onDeleteSuggestion: observe(() => api.onDeleteSuggestion, (text) => text, eventError("onDeleteSuggestion"))
})

export const layer = (api: ChromeOmniboxApi): Layer.Layer<ChromeOmnibox> => Layer.succeed(ChromeOmnibox, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeOmnibox, ChromeOmniboxError> = liveLayer(
  ChromeOmnibox, "omnibox", (chrome) => chrome.omnibox, make,
  (cause) => new ChromeOmniboxError({ operation: "initialize", cause })
)
