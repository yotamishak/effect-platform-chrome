import * as ChromeOmnibox from "../ChromeOmnibox.js"
import * as TestEvent from "./Event.js"

const reference = /^&(?:amp|lt|gt|quot|apos|#(\d+)|#x([\da-fA-F]+));/

const tagStart = /^<(\/?)([A-Za-z_][\w.-]*)/

const attribute = /^\s+([A-Za-z_][\w.-]*)\s*=\s*(?:"([^<"]*)"|'([^<']*)')/

const closingEnd = /^\s*>/

const openingEnd = /^\s*(\/?)>/

/** How far one markup token reaches, or why it is not well-formed. */
type Scan = { readonly length: number } | { readonly error: string }

/** XML 1.0's `Char` production: the code points a character reference may name. */
const isXmlChar = (code: number) => code === 0x9 || code === 0xa || code === 0xd
  || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff)

/**
 * A literal UTF-16 unit XML rejects. Lone surrogates pass: Chrome turns them into U+FFFD when
 * it converts the string to UTF-8, before parsing.
 */
const isForbiddenUnit = (unit: number) => (unit < 0x20 && unit !== 0x9 && unit !== 0xa && unit !== 0xd)
  || unit === 0xfffe || unit === 0xffff

/** A predefined entity, or a character reference naming an XML character. */
const scanReference = (rest: string, index: number): Scan => {
  const match = reference.exec(rest)

  if (match === null) return { error: `Unescaped "&" at ${index}` }
  const [text, decimal, hex] = match

  if (decimal === undefined && hex === undefined) return { length: text.length }
  const code = decimal === undefined ? Number.parseInt(hex ?? "", 16) : Number(decimal)

  return isXmlChar(code) ? { length: text.length } : { error: `Invalid character reference ${text} at ${index}` }
}

/** Every `&` in an attribute value must start a valid reference. */
const valueError = (value: string, index: number): string | undefined => {
  for (let offset = value.indexOf("&"); offset !== -1; offset = value.indexOf("&", offset + 1)) {
    const scan = scanReference(value.slice(offset), index + offset)

    if ("error" in scan) return scan.error
  }

  return undefined
}

/** A start, end or empty-element tag; a start tag may carry quoted, distinct attributes. */
const scanTag = (rest: string, index: number, open: Array<string>): Scan => {
  const malformed = { error: `Malformed tag at ${index}` }
  const start = tagStart.exec(rest)

  if (start === null) return malformed
  const [head, closing, name = ""] = start

  if (closing === "/") {
    const end = closingEnd.exec(rest.slice(head.length))

    if (end === null) return malformed

    if (open.pop() !== name) return { error: `Unexpected </${name}> at ${index}` }

    return { length: head.length + end[0].length }
  }

  const names = new Set<string>()
  let length = head.length

  for (let match = attribute.exec(rest.slice(length)); match !== null; match = attribute.exec(rest.slice(length))) {
    const [text, attributeName = "", double, single] = match

    if (names.has(attributeName)) return { error: `Duplicate attribute ${attributeName} at ${index}` }
    names.add(attributeName)
    const error = valueError(double ?? single ?? "", index + length)

    if (error !== undefined) return { error }
    length += text.length
  }

  const end = openingEnd.exec(rest.slice(length))

  if (end === null) return malformed

  if (end[1] !== "/") open.push(name)

  return { length: length + end[0].length }
}

/** One token of character data or markup at the start of `rest`. */
const scanToken = (rest: string, index: number, open: Array<string>): Scan => {
  if (rest.startsWith("&")) return scanReference(rest, index)

  if (rest.startsWith("<")) return scanTag(rest, index, open)

  if (rest.startsWith("]]>")) return { error: `Unescaped "]]>" at ${index}` }
  const unit = rest.charCodeAt(0)

  return isForbiddenUnit(unit) ? { error: `Invalid character U+${unit.toString(16).toUpperCase()} at ${index}` } : { length: 1 }
}

/** The first reason `description` is not well-formed XML element content, if any. */
const markupError = (description: string): string | undefined => {
  const open: Array<string> = []
  let index = 0

  while (index < description.length) {
    const scan = scanToken(description.slice(index), index, open)

    if ("error" in scan) return scan.error
    index += scan.length
  }

  const unclosed = open.at(-1)

  return unclosed === undefined ? undefined : `Unclosed <${unclosed}>`
}

/** Chrome's schema check: an argument object may own only the properties its type declares. */
const checkProperties = (keys: ReadonlyArray<string>, declared: ReadonlyArray<string>, path: string) => {
  for (const key of keys) {
    if (!declared.includes(key)) throw new TypeError(`${path}: Unexpected property: '${key}'.`)
  }
}

/** Chrome's synchronous argument check for one suggestion row. */
const checkSuggestResult = (result: ChromeOmnibox.SuggestResult, index: number) => {
  checkProperties(Object.keys(result), ["content", "description", "deletable"], `suggestResults[${index}]`)

  if (result.content.length === 0) throw new TypeError(`suggestResults[${index}].content must not be empty`)

  if (result.description.length === 0) throw new TypeError(`suggestResults[${index}].description must not be empty`)
}

/**
 * A simulated omnibox keyword session. `controls.change(text)` emits `onInputChanged` and
 * returns the suggestion batches listeners send for that keystroke, in order; the array fills as
 * listeners call `suggest`, including late calls. Like Chrome's schema check, `suggest` and
 * `setDefaultSuggestion` throw a `TypeError` synchronously for a property the type does not
 * declare, and `suggest` throws one for an empty `content` or `description` (recording nothing).
 * `setDefaultSuggestion` rejects an empty description or markup that is not well-formed:
 * unbalanced tags, a stray `<` or `&`, an unknown entity, a reference to a character XML
 * forbids, a control character, `]]>`, or an unquoted or repeated attribute (comments, CDATA
 * and processing instructions count as a stray `<`). Accepted values are recorded as copies;
 * `controls.defaultSuggestion` holds the last default suggestion. Pass `overrides` to replace
 * any member.
 */
export const makeOmnibox = (overrides: Partial<ChromeOmnibox.ChromeOmniboxApi> = {}) => {
  const started = TestEvent.makeEvent<[]>()
  const changed = TestEvent.makeEvent<[string, (suggestResults: Array<ChromeOmnibox.SuggestResult>) => void]>()
  const entered = TestEvent.makeEvent<[string, ChromeOmnibox.Disposition]>()
  const cancelled = TestEvent.makeEvent<[]>()
  const deleted = TestEvent.makeEvent<[string]>()
  let defaultSuggestion: ChromeOmnibox.DefaultSuggestResult | undefined

  const parseDefaultSuggestion = async (suggestion: ChromeOmnibox.DefaultSuggestResult) => {
    if (suggestion.description.length === 0) throw new Error("suggestion.description must not be empty")
    const error = markupError(suggestion.description)

    if (error !== undefined) throw new Error(`Invalid description markup: ${error}`)
    defaultSuggestion = structuredClone(suggestion)
  }

  const api: ChromeOmnibox.ChromeOmniboxApi = {
    setDefaultSuggestion: (suggestion) => {
      checkProperties(Object.keys(suggestion), ["description"], "suggestion")

      return parseDefaultSuggestion(suggestion)
    },
    onInputStarted: started.api,
    onInputChanged: changed.api,
    onInputEntered: entered.api,
    onInputCancelled: cancelled.api,
    onDeleteSuggestion: deleted.api,
    ...overrides
  }

  return {
    api,
    layer: ChromeOmnibox.layer(api),
    controls: {
      get defaultSuggestion() { return defaultSuggestion },
      /** Emits `onInputChanged`; the returned array collects each `suggest` call's results. */
      change: (text: string): ReadonlyArray<ReadonlyArray<ChromeOmnibox.SuggestResult>> => {
        const suggestions: Array<ReadonlyArray<ChromeOmnibox.SuggestResult>> = []

        changed.controls.emit(text, (suggestResults) => {
          suggestResults.forEach(checkSuggestResult)
          suggestions.push(structuredClone(suggestResults))
        })

        return suggestions
      },
      onInputStarted: started.controls,
      onInputChanged: changed.controls,
      onInputEntered: entered.controls,
      onInputCancelled: cancelled.controls,
      onDeleteSuggestion: deleted.controls
    }
  }
}
