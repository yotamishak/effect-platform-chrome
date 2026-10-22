import * as ChromeI18n from "../ChromeI18n.js"

// Injected failures are raw throw and rejection causes, as Chrome's would be.
/* oxlint-disable anti-slop/no-unknown-parameters */

export type I18nOperation = "getMessage" | "getUILanguage" | "getAcceptLanguages" | "detectLanguage"

/** A named placeholder of a `messages.json` entry; `$name$` in the message becomes `content`. */
export interface MessagePlaceholder {
  readonly content: string
  readonly example?: string
}

/** One `messages.json` entry, in the file's own shape. */
export interface MessageEntry {
  readonly message: string
  readonly description?: string
  readonly placeholders?: Readonly<Record<string, MessagePlaceholder>>
}

/** The parsed contents of one `_locales/<locale>/messages.json`. */
export type MessageCatalog = Readonly<Record<string, MessageEntry>>

export interface I18nOptions {
  /**
   * The extension's catalogs: the UI locale's alone, or several from most to least
   * specific (`en_GB`, `en`, then `default_locale`), the first one defining a name winning.
   * Leaving it out models an extension without `default_locale`, which has no messages.
   */
  readonly messages?: MessageCatalog | ReadonlyArray<MessageCatalog>
  /** What `getUILanguage` reports, `en-US` by default. */
  readonly uiLanguage?: string
  /** What `getAcceptLanguages` reports, `["en-US", "en"]` by default. */
  readonly acceptLanguages?: ReadonlyArray<string>
  /** What `@@extension_id` resolves to. */
  readonly extensionId?: string
  /** Stands in for CLD3 and reports no languages by default. */
  readonly detect?: (text: string) => ChromeI18n.LanguageDetection
  /** Replaces any member of the simulated API. */
  readonly overrides?: Partial<ChromeI18n.ChromeI18nApi>
}

const reservedLocaleNames = ["@@ui_locale", "@@bidi_dir", "@@bidi_reversed_dir", "@@bidi_start_edge", "@@bidi_end_edge"]

/** Languages whose default script runs right to left, approximating ICU's locale direction. */
const rightToLeft = new Set(["ar", "ckb", "dv", "fa", "he", "iw", "ks", "lrc", "mzn", "ps", "sd", "syr", "ug", "ur", "yi"])

const rightToLeftScripts = new Set(["arab", "hebr", "nkoo", "rohg", "syrc", "thaa"])

const isRightToLeft = (locale: string): boolean => {
  const [language = "", ...subtags] = locale.toLowerCase().split(/[-_]/)
  const script = subtags.find((subtag) => subtag.length === 4)

  return script === undefined ? rightToLeft.has(language) : rightToLeftScripts.has(script)
}

/** Chrome's message and placeholder names: ASCII letters, digits, `_` and `@`. */
const isValidName = (name: string) => /^[A-Za-z0-9_@]+$/.test(name)

/**
 * `base::ToLowerASCII`: only A-Z fold, so a name such as `\u212Aey` (a Kelvin sign, which
 * `toLowerCase` turns into `k`) matches no message, as in Chrome.
 */
const toLowerAscii = (name: string) => name.replace(/[A-Z]+/g, (letters) => letters.toLowerCase())

/**
 * A parsed JSON object's entries in `base::Value::Dict` order, which is sorted by key bytes
 * whatever the file's order. Keys that fold to the same name resolve to the last spelling.
 */
const chromeEntries = <A>(record: Readonly<Record<string, A>>): Array<[string, A]> =>
  Object.entries(record).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)

/**
 * Chrome's load-time `$name$` resolution (`MessageBundle::ReplaceVariables`): a delimited
 * valid name must be a defined placeholder, contents are inserted verbatim and not rescanned,
 * and a `$` pair around anything else is left alone.
 */
const resolvePlaceholders = (key: string, entry: MessageEntry): string => {
  const placeholders = new Map<string, string>()

  for (const [name, placeholder] of chromeEntries(entry.placeholders ?? {})) {
    if (!isValidName(name)) throw new Error(`Name of a key "${name}" is invalid. Only ASCII [a-z], [A-Z], [0-9] and "_" are allowed.`)

    placeholders.set(toLowerAscii(name), placeholder.content)
  }

  let message = entry.message
  let index = 0

  for (;;) {
    const begin = message.indexOf("$", index)

    if (begin === -1 || begin + 1 >= message.length) return message

    const end = message.indexOf("$", begin + 1)

    if (end === -1) return message

    const name = message.slice(begin + 1, end)
    index = begin + 1

    if (!isValidName(name)) continue

    const content = placeholders.get(toLowerAscii(name))

    if (content === undefined) throw new Error(`Variable $${name}$ used but not defined (message "${key}").`)

    message = `${message.slice(0, begin)}${content}${message.slice(end + 1)}`
    index = begin + content.length
  }
}

const utf8 = new TextEncoder()

const fromUtf8 = new TextDecoder()

const dollar = 0x24

/**
 * Chrome's runtime substitution (`base::ReplaceStringPlaceholders`), ported byte for byte
 * over UTF-8 as Chrome runs it: `$1`…`$9` take the matching value or nothing, a run of n > 1
 * dollars becomes n - 1 (so `$$$1` is `$$1`), and a `$` followed by any other byte, or ending
 * the message, is dropped with that byte. Before a non-ASCII character that leaves its
 * continuation bytes, which decode to U+FFFD replacement characters, as in Chrome.
 */
export const replacePlaceholders = (message: string, substitutions: ReadonlyArray<string>): string => {
  const bytes = utf8.encode(message)
  const values = substitutions.map((value) => utf8.encode(value))
  const formatted: Array<number> = []

  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index] ?? 0

    if (byte !== dollar) {
      formatted.push(byte)
      continue
    }

    if (index + 1 === bytes.length) continue

    index++

    if (bytes[index] === dollar) {
      while (index < bytes.length && bytes[index] === dollar) {
        formatted.push(dollar)
        index++
      }

      index--
      continue
    }

    const digit = (bytes[index] ?? 0) - 0x31

    // A loop rather than a spread, which would overflow the stack for a megabyte value.
    if (digit >= 0 && digit < 9) for (const valueByte of values[digit] ?? []) formatted.push(valueByte)
  }

  return fromUtf8.decode(Uint8Array.from(formatted))
}

/**
 * `MessageBundle::Init`: catalogs from `default_locale` up to the most specific one, each
 * in sorted key order, every entry overwriting the name it folds to.
 */
const loadCatalogs = (catalogs: ReadonlyArray<MessageCatalog>): Map<string, string> => {
  const dictionary = new Map<string, string>()

  for (const catalog of Array.from(catalogs).reverse()) {
    for (const [key, entry] of chromeEntries(catalog)) {
      if (!isValidName(key)) throw new Error(`Name of a key "${key}" is invalid. Only ASCII [a-z], [A-Z], [0-9] and "_" are allowed.`)

      const name = toLowerAscii(key)

      if (reservedLocaleNames.includes(name)) throw new Error(`Reserved key "${name}" found.`)

      dictionary.set(name, resolvePlaceholders(key, entry))
    }
  }

  return dictionary
}

/**
 * An in-memory `chrome.i18n` with Chrome's message semantics, taken from its source:
 * catalogs are validated as Chrome validates them when loading an extension (the factory
 * throws for an invalid name, an undefined `$placeholder$` or a reserved `@@` name);
 * names fold ASCII case only, and spellings colliding within a catalog resolve in Chrome's
 * sorted key order; an unknown name answers `""`; `@@extension_id` always
 * resolves and a localized extension also gets `@@ui_locale` and the `@@bidi_*` names from
 * the UI language. `getMessage` answers `undefined` for more than 9 substitutions, applies
 * `escapeLt` to the message before substitution, and substitutes like Chrome
 * (`replacePlaceholders`). `detectLanguage` post-processes `options.detect` like Chrome:
 * at most its first three languages, stopping at `und`, dropping transliterated `-Latn`
 * ones, and reliable only for a text of at least 50 UTF-8 bytes with a language detected.
 * Every call can be failed once with `controls.failNext`.
 */
export const makeI18n = (options: I18nOptions = {}) => {
  const catalogs = options.messages === undefined ? undefined : Array.isArray(options.messages) ? options.messages : [options.messages]
  const dictionary = loadCatalogs(catalogs ?? [])
  const extensionId = options.extensionId ?? "abcdefghijklmnopabcdefghijklmnop"
  const detect = options.detect ?? (() => ({ isReliable: false, languages: [] }))
  const failures = new Map<I18nOperation, Array<unknown>>()
  let uiLanguage = options.uiLanguage ?? "en-US"
  let acceptLanguages = Array.from(options.acceptLanguages ?? ["en-US", "en"])

  const check = (operation: I18nOperation) => {
    const queue = failures.get(operation)

    if (queue !== undefined && queue.length > 0) throw queue.shift()
  }

  const reserved = (name: string): string | undefined => {
    if (name === "@@extension_id") return extensionId

    if (catalogs === undefined) return undefined

    const rtl = isRightToLeft(uiLanguage)

    switch (name) {
      case "@@ui_locale": return uiLanguage.replaceAll("-", "_")
      case "@@bidi_dir": return rtl ? "rtl" : "ltr"
      case "@@bidi_reversed_dir": return rtl ? "ltr" : "rtl"
      case "@@bidi_start_edge": return rtl ? "right" : "left"
      case "@@bidi_end_edge": return rtl ? "left" : "right"
      default: return undefined
    }
  }

  const api: ChromeI18n.ChromeI18nApi = {
    getMessage: (messageName, substitutions, getMessageOptions) => {
      check("getMessage")
      const name = toLowerAscii(messageName)
      const message = reserved(name) ?? dictionary.get(name) ?? ""
      let values: Array<string> = []

      if (Array.isArray(substitutions)) {
        if (substitutions.length > 9) return undefined

        values = substitutions.map(String)
      } else if (substitutions !== undefined) {
        values = [substitutions]
      }

      const escaped = getMessageOptions?.escapeLt === true ? message.replaceAll("<", "&lt;") : message

      return replacePlaceholders(escaped, values)
    },
    getUILanguage: () => {
      check("getUILanguage")

      return uiLanguage
    },
    getAcceptLanguages: async () => {
      check("getAcceptLanguages")

      return Array.from(acceptLanguages)
    },
    detectLanguage: async (text) => {
      check("detectLanguage")
      const detected = detect(text)
      const languages: Array<ChromeI18n.DetectedLanguage> = []

      for (const { language, percentage } of detected.languages.slice(0, 3)) {
        if (language === "und") break

        if (!language.toLowerCase().endsWith("-latn")) languages.push({ language, percentage })
      }

      const isReliable = detected.isReliable && languages.length > 0 && utf8.encode(text).length >= 50

      return { isReliable, languages }
    },
    ...options.overrides
  }

  return {
    api,
    layer: ChromeI18n.layer(api),
    controls: {
      /** Changes the UI language, and with it `@@ui_locale` and the `@@bidi_*` messages. */
      setUILanguage: (language: string) => { uiLanguage = language },
      setAcceptLanguages: (languages: ReadonlyArray<string>) => { acceptLanguages = Array.from(languages) },
      /** The resolved message for a name, as Chrome stores it after loading the catalogs. */
      message: (name: string): string | undefined => dictionary.get(toLowerAscii(name)),
      /** Fails the next call of `operation` with `cause`: a throw, or a rejection for the Promise calls. */
      failNext: (operation: I18nOperation, cause: unknown) => {
        const queue = failures.get(operation) ?? []
        queue.push(cause)
        failures.set(operation, queue)
      }
    }
  }
}
