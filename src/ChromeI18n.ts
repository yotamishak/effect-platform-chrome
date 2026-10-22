import { Context, Effect, Layer, Option, Schema } from "effect"
import { attempter, invoker, liveLayer } from "./internal/api.js"

export class ChromeI18nError extends Schema.TaggedError<ChromeI18nError>()("ChromeI18nError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

export type Substitutions = string | ReadonlyArray<string | number>

export type LanguageDetection = chrome.i18n.LanguageDetectionResult

/** The MV3 subset this module needs; `getMessage` and `getUILanguage` are synchronous in Chrome. */
export interface ChromeI18nApi {
  getMessage(messageName: string, substitutions?: string | Array<string | number>, options?: chrome.i18n.GetMessageOptions): string | undefined
  getUILanguage(): string
  getAcceptLanguages(): Promise<Array<string>>
  detectLanguage(text: string): Promise<LanguageDetection>
}

export interface ChromeI18nService {
  /**
   * The localized string for a `_locales/<locale>/messages.json` key, with up to 9
   * substitutions. Chrome answers an unknown key with `""` (and a malformed call with
   * `undefined`); both become `Option.none()`, so a message that is deliberately empty
   * is indistinguishable from a missing one.
   */
  readonly getMessage: (
    messageName: string,
    substitutions?: Substitutions,
    options?: chrome.i18n.GetMessageOptions
  ) => Effect.Effect<Option.Option<string>, ChromeI18nError>
  /** The browser UI locale, such as `en-US`; read afresh on each run. */
  readonly getUILanguage: Effect.Effect<string, ChromeI18nError>
  /** The user's preferred content languages, which can differ from the UI locale. */
  readonly getAcceptLanguages: Effect.Effect<Array<string>, ChromeI18nError>
  /** Chrome's CLD language detection, with up to three languages and their percentages. */
  readonly detectLanguage: (text: string) => Effect.Effect<LanguageDetection, ChromeI18nError>
}

export class ChromeI18n extends Context.Service<ChromeI18n, ChromeI18nService>()("effect-platform-chrome/ChromeI18n") {}

const toError = (operation: string, cause: unknown) => new ChromeI18nError({ operation, cause })

const invoke = invoker(toError)

const attempt = attempter(toError)

/** Creates the service without reading browser globals. */
export const make = (api: ChromeI18nApi): ChromeI18nService => ChromeI18n.of({
  getMessage: (messageName, substitutions, options) => attempt("getMessage", () => {
    // Chrome treats a lone string substitution exactly like a one-element array.
    const values = substitutions === undefined ? undefined : [substitutions].flat()

    if (options !== undefined) return api.getMessage(messageName, values, options)

    return values === undefined ? api.getMessage(messageName) : api.getMessage(messageName, values)
  }).pipe(Effect.map((message) => message === undefined || message === "" ? Option.none() : Option.some(message))),
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
