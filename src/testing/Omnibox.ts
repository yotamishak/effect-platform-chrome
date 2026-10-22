import * as ChromeOmnibox from "../ChromeOmnibox.js"
import * as TestEvent from "./Event.js"

/**
 * A simulated omnibox keyword session. `controls.change(text)` emits `onInputChanged` and
 * returns the suggestion batches listeners send for that keystroke, in order; the array fills as
 * listeners call `suggest`. `setDefaultSuggestion` records into `controls.defaultSuggestion`.
 * Pass `overrides` to replace any member.
 */
export const makeOmnibox = (overrides: Partial<ChromeOmnibox.ChromeOmniboxApi> = {}) => {
  const started = TestEvent.makeEvent<[]>()
  const changed = TestEvent.makeEvent<[string, (suggestResults: Array<ChromeOmnibox.SuggestResult>) => void]>()
  const entered = TestEvent.makeEvent<[string, ChromeOmnibox.Disposition]>()
  const cancelled = TestEvent.makeEvent<[]>()
  const deleted = TestEvent.makeEvent<[string]>()
  let defaultSuggestion: ChromeOmnibox.DefaultSuggestResult | undefined

  const api: ChromeOmnibox.ChromeOmniboxApi = {
    setDefaultSuggestion: async (suggestion) => { defaultSuggestion = structuredClone(suggestion) },
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
        changed.controls.emit(text, (suggestResults) => { suggestions.push(structuredClone(suggestResults)) })

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
