# ChromeOmnibox

Import from `effect-platform-chrome/ChromeOmnibox`. `ChromeOmnibox` is an Effect v4
service over `chrome.omnibox`; `make(api)` and `layer(api)` accept an injected API, and
`layerLive` reads the global only when built. The manifest declares a keyword rather than
a permission: `"omnibox": { "keyword": "docs" }`.

- `setDefaultSuggestion({ description })` sets the first dropdown row. Chrome replaces the
  first `%s` in the description with the current input and keeps the suggestion in the
  extension's preferences, so it outlasts the worker. An empty description or malformed
  markup fails.
- `onInputStarted` and `onInputCancelled` emit `void`; `onInputEntered` emits
  `{ text, disposition }`; `onDeleteSuggestion` emits the deleted suggestion's `content`.
- `onInputChanged` emits `{ text, suggest }`. `suggest(results)` is a lazy Effect that calls
  the `suggest` callback Chrome passed with that keystroke, so every reply goes to the
  input it answers; each run sends a fresh copy, and an empty list clears the rows. Chrome
  checks the rows' types synchronously (`content` and `description` must be non-empty), and
  a throw fails with `operation: "suggest"`. It parses the markup later and reports malformed
  markup only to the console.
- Suggestion `description`s may use nested `<url>`, `<match>` and `<dim>` markup and must
  escape `&`, `<`, `>`, `"` and `'` to show them as text. `deletable: true` lets the user remove
  a row, which emits `onDeleteSuggestion`.
- Failures are `ChromeOmniboxError` with the call or event name as `operation` and the
  original `cause`; `"initialize"` when the global is missing.

Lookups can finish out of order. `Stream.switchMap` interrupts the lookup for older input
when newer input arrives:

```ts
omnibox.onInputChanged.pipe(
  Stream.switchMap(({ text, suggest }) => Stream.fromEffect(
    Effect.flatMap(searchDocs(text), (results) => suggest(results))
  )),
  Stream.runDrain
)
```

## Waking the worker

These streams are observational: their listeners exist only while a stream runs and cannot
wake a stopped MV3 worker, which is where keyword input usually arrives. Register wake
listeners synchronously at startup with `ChromeServiceWorker.listen`, for example
`ChromeServiceWorker.listen(chrome.omnibox.onInputEntered, (text, disposition) => ...)`.
A wake handler for `onInputChanged` receives Chrome's native `(text, suggest)` arguments;
`ChromeOmnibox.inputChanged(text, suggest)` turns them into the same `{ text, suggest }` the
stream emits:

```ts
ChromeServiceWorker.listen(chrome.omnibox.onInputChanged, (text, suggest) =>
  answer(ChromeOmnibox.inputChanged(text, suggest))
)
```

Each stream subscription buffers at most 64 events, dropping the oldest.

## Testing

`effect-platform-chrome/testing/Omnibox` exports `makeOmnibox()`. `controls.change(text)`
emits `onInputChanged` and returns an array that collects (copies of) each batch listeners
pass to `suggest`, including late replies; `controls.defaultSuggestion` holds the last
accepted `setDefaultSuggestion` value. Like Chrome, the fixture's `suggest` throws a
`TypeError` for an empty `content` or `description`, and `setDefaultSuggestion` rejects an
empty description or markup that is not well-formed (unbalanced tags, a stray `<` or `&`, an
unknown entity). Pass overrides to replace any API member.
