# ChromeOmnibox

Import from `effect-platform-chrome/ChromeOmnibox`. `ChromeOmnibox` is an Effect v4
service over `chrome.omnibox`; `make(api)` and `layer(api)` accept an injected API, and
`layerLive` reads the global only when built. The manifest declares a keyword rather than
a permission: `"omnibox": { "keyword": "docs" }`.

- `setDefaultSuggestion({ description })` sets the first dropdown row.
- `onInputStarted` and `onInputCancelled` emit `void`; `onInputEntered` emits
  `{ text, disposition }`; `onDeleteSuggestion` emits the deleted suggestion's `content`.
- `onInputChanged` emits `{ text, suggest }`. `suggest(results)` is an Effect that calls
  the `suggest` callback Chrome passed with that keystroke, so every reply goes to the
  input it answers. A throwing callback fails with `operation: "suggest"`.
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
A wake handler for `onInputChanged` receives Chrome's native `suggest` callback directly.
Each stream subscription buffers at most 64 events, dropping the oldest.

## Testing

`effect-platform-chrome/testing/Omnibox` exports `makeOmnibox()`. `controls.change(text)`
emits `onInputChanged` and returns an array that collects each batch listeners pass to
`suggest`; `controls.defaultSuggestion` holds the last `setDefaultSuggestion` value.
