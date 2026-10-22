import { Context, Effect, Layer, Schema, Stream } from "effect"
import { attempter, invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeOmniboxError extends Schema.TaggedError<ChromeOmniboxError>()("ChromeOmniboxError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

export type SuggestResult = chrome.omnibox.SuggestResult

export type DefaultSuggestResult = chrome.omnibox.DefaultSuggestResult

/** Where the user asked to open the result: `currentTab`, `newForegroundTab` or `newBackgroundTab`. */
export type Disposition = `${chrome.omnibox.OnInputEnteredDisposition}`

type NativeSuggest = (suggestResults: Array<SuggestResult>) => void

export interface InputChangedEvent {
  readonly text: string
  /** Answers this keystroke with suggestions for the dropdown, through Chrome's `suggest` callback. */
  readonly suggest: (suggestResults: ReadonlyArray<SuggestResult>) => Effect.Effect<void, ChromeOmniboxError>
}

export interface InputEnteredEvent {
  readonly text: string
  readonly disposition: Disposition
}

/** The Promise-based MV3 subset this module needs. */
export interface ChromeOmniboxApi {
  setDefaultSuggestion(suggestion: DefaultSuggestResult): Promise<void>
  readonly onInputStarted: EventSource<[]>
  readonly onInputChanged: EventSource<[text: string, suggest: NativeSuggest]>
  readonly onInputEntered: EventSource<[text: string, disposition: Disposition]>
  readonly onInputCancelled: EventSource<[]>
  readonly onDeleteSuggestion: EventSource<[text: string]>
}

export interface ChromeOmniboxService {
  /** Sets the first dropdown row, shown above any suggestions; its description may use `<match>`, `<dim>` and `<url>` markup. */
  readonly setDefaultSuggestion: (suggestion: DefaultSuggestResult) => Effect.Effect<void, ChromeOmniboxError>
  /**
   * Observational subscriptions that cannot wake an MV3 service worker. Omnibox input usually
   * arrives at a sleeping worker, so register wake listeners through `ChromeServiceWorker.listen`
   * (for example on `chrome.omnibox.onInputChanged`). Each subscription buffers at most 64
   * events, dropping the oldest. `onInputStarted` fires once per keyword session, before any
   * `onInputChanged`.
   */
  readonly onInputStarted: Stream.Stream<void, ChromeOmniboxError>
  /**
   * Each keystroke's text and its `suggest` reply. A lookup may finish after newer input
   * arrived; `Stream.switchMap` interrupts the stale one.
   */
  readonly onInputChanged: Stream.Stream<InputChangedEvent, ChromeOmniboxError>
  readonly onInputEntered: Stream.Stream<InputEnteredEvent, ChromeOmniboxError>
  /** The session ended without the user accepting input. */
  readonly onInputCancelled: Stream.Stream<void, ChromeOmniboxError>
  /** The text (`content`) of a `deletable` suggestion the user removed. */
  readonly onDeleteSuggestion: Stream.Stream<string, ChromeOmniboxError>
}

export class ChromeOmnibox extends Context.Service<ChromeOmnibox, ChromeOmniboxService>()("effect-platform-chrome/ChromeOmnibox") {}

const onError = (operation: string, cause: unknown) => new ChromeOmniboxError({ operation, cause })

const invoke = invoker(onError)

const attempt = attempter(onError)

const eventError = (operation: string) => (cause: unknown) => onError(operation, cause)

const inputChanged = (text: string, suggest: NativeSuggest): InputChangedEvent => ({
  text,
  suggest: (suggestResults) => attempt("suggest", () => suggest(Array.from(suggestResults)))
})

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeOmniboxApi): ChromeOmniboxService => ChromeOmnibox.of({
  setDefaultSuggestion: (suggestion) => invoke("setDefaultSuggestion", () => api.setDefaultSuggestion(suggestion)),
  onInputStarted: observe(() => api.onInputStarted, () => undefined, eventError("onInputStarted")),
  onInputChanged: observe(() => api.onInputChanged, inputChanged, eventError("onInputChanged")),
  onInputEntered: observe(() => api.onInputEntered, (text, disposition) => ({ text, disposition }), eventError("onInputEntered")),
  onInputCancelled: observe(() => api.onInputCancelled, () => undefined, eventError("onInputCancelled")),
  onDeleteSuggestion: observe(() => api.onDeleteSuggestion, (text) => text, eventError("onDeleteSuggestion"))
})

export const layer = (api: ChromeOmniboxApi): Layer.Layer<ChromeOmnibox> => Layer.succeed(ChromeOmnibox, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeOmnibox, ChromeOmniboxError> = liveLayer(
  ChromeOmnibox, "omnibox", (chrome) => chrome.omnibox, make,
  (cause) => new ChromeOmniboxError({ operation: "initialize", cause })
)
