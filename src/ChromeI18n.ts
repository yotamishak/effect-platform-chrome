import { Context, Effect, Layer, Option, Schema } from "effect"
import { attempter, invoker, liveLayer } from "./internal/api.js"

export class ChromeI18nError extends Schema.TaggedError<ChromeI18nError>()("ChromeI18nError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/**
 * Values for a message's `$1`…`$9` placeholders: one string, or up to 9 strings or numbers
 * (Chrome converts numbers with `String`).
 */
export type Substitutions = string | ReadonlyArray<string | number>

/** `escapeLt` escapes `<` in the message itself (not in substituted values) as `&lt;`. */
export type GetMessageOptions = chrome.i18n.GetMessageOptions

export type DetectedLanguage = chrome.i18n.DetectedLanguage

export type LanguageDetection = chrome.i18n.LanguageDetectionResult

/**
 * The MV3 subset this module needs, which is the whole `chrome.i18n` namespace.
 * `getMessage` and `getUILanguage` are synchronous in Chrome; `getAcceptLanguages` and
 * `detectLanguage` return Promises in MV3 (Chrome 99+).
 */
export interface ChromeI18nApi {
  getMessage(messageName: string, substitutions?: string | Array<string | number>, options?: GetMessageOptions): string | undefined
  getUILanguage(): string
  getAcceptLanguages(): Promise<Array<string>>
  detectLanguage(text: string): Promise<LanguageDetection>
}

export interface ChromeI18nService {
  /**
   * The localized string for a `_locales/<locale>/messages.json` key, looked up
   * ASCII-case-insensitively in the UI locale's catalog and then the `default_locale` one. The
   * reserved names `@@extension_id`, `@@ui_locale` and `@@bidi_*` resolve as well.
   *
   * Chrome answers an unknown key with `""`, which becomes `Option.none()`, so a message
   * that is deliberately empty is indistinguishable from a missing one. Chrome fills `$1`…`$9`
   * from `substitutions` (missing values become empty), turns `$$` into `$` and drops `$`
   * followed by anything else. A call Chrome rejects as malformed (more than 9 substitutions,
   * which Chrome answers with `undefined`) fails with `ChromeI18nError`.
   */
  readonly getMessage: (
    messageName: string,
    substitutions?: Substitutions,
    options?: GetMessageOptions
  ) => Effect.Effect<Option.Option<string>, ChromeI18nError>
  /**
   * The browser UI language, such as `en-US`; read afresh on each run. It is the locale
   * Chrome picked the extension's messages for, not the user's content languages.
   */
  readonly getUILanguage: Effect.Effect<string, ChromeI18nError>
  /** The user's preferred content languages, in preference order; they can differ from the UI locale. */
  readonly getAcceptLanguages: Effect.Effect<Array<string>, ChromeI18nError>
  /**
   * Chrome's CLD3 language detection, with up to three languages and their percentages.
   * Chrome reports no languages (and `isReliable: false`) when it detects none, and never
   * calls a text under 50 UTF-8 bytes reliable.
   */
  readonly detectLanguage: (text: string) => Effect.Effect<LanguageDetection, ChromeI18nError>
}

export class ChromeI18n extends Context.Service<ChromeI18n, ChromeI18nService>()("effect-platform-chrome/ChromeI18n") {}

const toError = (operation: string, cause: unknown) => new ChromeI18nError({ operation, cause })

const invoke = invoker(toError)

const attempt = attempter(toError)

const isList = (substitutions: Substitutions): substitutions is ReadonlyArray<string | number> => Array.isArray(substitutions)

/** Chrome's mutable parameter type; the caller's readonly array is copied, never handed over. */
const toChrome = (substitutions: Substitutions): string | Array<string | number> =>
  isList(substitutions) ? Array.from(substitutions) : substitutions

const malformed = (messageName: string) =>
  new Error(`chrome.i18n.getMessage("${messageName}") returned undefined: Chrome rejected the call as malformed, such as one with more than 9 substitutions`)

const callGetMessage = (
  api: ChromeI18nApi,
  messageName: string,
  substitutions: Substitutions | undefined,
  options: GetMessageOptions | undefined
): string | undefined => {
  const values = substitutions === undefined ? undefined : toChrome(substitutions)

  // `options` is positional, so an absent substitution is passed as `undefined` only then.
  if (options !== undefined) return api.getMessage(messageName, values, options)

  return values === undefined ? api.getMessage(messageName) : api.getMessage(messageName, values)
}

/** Creates the service without reading browser globals. */
export const make = (api: ChromeI18nApi): ChromeI18nService => ChromeI18n.of({
  getMessage: (messageName, substitutions, options) => attempt("getMessage", () => {
    const message = callGetMessage(api, messageName, substitutions, options)

    if (message === undefined) throw malformed(messageName)

    return message === "" ? Option.none() : Option.some(message)
  }),
  getUILanguage: attempt("getUILanguage", () => api.getUILanguage()),
  getAcceptLanguages: invoke("getAcceptLanguages", () => api.getAcceptLanguages()),
  detectLanguage: (text) => invoke("detectLanguage", () => api.detectLanguage(text))
})

export const layer = (api: ChromeI18nApi): Layer.Layer<ChromeI18n> => Layer.succeed(ChromeI18n, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeI18n, ChromeI18nError> = liveLayer(
  ChromeI18n, "i18n", (chrome) => chrome.i18n, make,
  (cause) => new ChromeI18nError({ operation: "initialize", cause })
)
