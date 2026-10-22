import * as ChromeOmnibox from "../ChromeOmnibox.js"
import * as TestEvent from "./Event.js"

const entity = /^&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/

const tag = /^<(\/?)([A-Za-z_][\w.-]*)(?:\s[^<>]*?)?(\/?)>/

/** The first reason `description` is not well-formed XML markup, if any. */
const markupError = (description: string): string | undefined => {
  const open: Array<string> = []
  let index = 0

  while (index < description.length) {
    const rest = description.slice(index)

    if (rest.startsWith("&")) {
      const match = entity.exec(rest)

      if (match === null) return `Unescaped "&" at ${index}`
      index += match[0].length
    } else if (rest.startsWith("<")) {
      const match = tag.exec(rest)

      if (match === null) return `Malformed tag at ${index}`
      const [text, closing = "", name = "", selfClosing = ""] = match

      if (closing !== "" && selfClosing !== "") return `Malformed tag at ${index}`

      if (closing !== "") {
        if (open.pop() !== name) return `Unexpected </${name}> at ${index}`
      } else if (selfClosing === "") {
        open.push(name)
      }

      index += text.length
    } else {
      index += 1
    }
  }

  const unclosed = open.at(-1)

  return unclosed === undefined ? undefined : `Unclosed <${unclosed}>`
}

/** Chrome's synchronous argument check for one suggestion row. */
const checkSuggestResult = (result: ChromeOmnibox.SuggestResult, index: number) => {
  if (result.content.length === 0) throw new TypeError(`suggestResults[${index}].content must not be empty`)

  if (result.description.length === 0) throw new TypeError(`suggestResults[${index}].description must not be empty`)
}

/**
 * A simulated omnibox keyword session. `controls.change(text)` emits `onInputChanged` and
 * returns the suggestion batches listeners send for that keystroke, in order; the array fills as
 * listeners call `suggest`, including late calls. Like Chrome, `suggest` throws a `TypeError` for
 * an empty `content` or `description` (recording nothing), and `setDefaultSuggestion` rejects an
 * empty description or markup that is not well-formed: unbalanced tags, a stray `<` or `&`, or
 * an unknown entity (comments, CDATA and processing instructions count as a stray `<`).
 * Accepted values are recorded as copies; `controls.defaultSuggestion` holds the last default
 * suggestion. Pass `overrides` to replace any member.
 */
export const makeOmnibox = (overrides: Partial<ChromeOmnibox.ChromeOmniboxApi> = {}) => {
  const started = TestEvent.makeEvent<[]>()
  const changed = TestEvent.makeEvent<[string, (suggestResults: Array<ChromeOmnibox.SuggestResult>) => void]>()
  const entered = TestEvent.makeEvent<[string, ChromeOmnibox.Disposition]>()
  const cancelled = TestEvent.makeEvent<[]>()
  const deleted = TestEvent.makeEvent<[string]>()
  let defaultSuggestion: ChromeOmnibox.DefaultSuggestResult | undefined

  const api: ChromeOmnibox.ChromeOmniboxApi = {
    setDefaultSuggestion: async (suggestion) => {
      if (suggestion.description.length === 0) throw new Error("suggestion.description must not be empty")
      const error = markupError(suggestion.description)

      if (error !== undefined) throw new Error(`Invalid description markup: ${error}`)
      defaultSuggestion = structuredClone(suggestion)
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
