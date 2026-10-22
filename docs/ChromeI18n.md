# ChromeI18n

Import from `effect-platform-chrome/ChromeI18n`. `ChromeI18n` wraps the whole
`chrome.i18n` namespace, which works in MV3 service workers, extension pages and
content scripts. `make(api)` and `layer(api)` take an injected API; `layerLive` reads
`chrome.i18n` only when it is built and fails with `operation: "initialize"` without it.
Every call is lazy and asks Chrome again on each run. A throw or rejection becomes a
`ChromeI18nError` carrying the Chrome member name as `operation` and the original `cause`.

| Member | Chrome | Result |
| --- | --- | --- |
| `getMessage(name, substitutions?, options?)` | synchronous | `Option<string>`: none for an unknown (or deliberately empty) message |
| `getUILanguage` | synchronous | the browser UI locale, such as `en-US` |
| `getAcceptLanguages` | Promise (Chrome 99+) | the user's content languages, in preference order |
| `detectLanguage(text)` | Promise (Chrome 99+) | CLD3's `LanguageDetection` |

## Messages, as Chrome resolves them

These rules come from Chromium's `MessageBundle`, `I18nHooksDelegate` and
`base::ReplaceStringPlaceholders`, and the `testing/I18n` fixture reproduces them.

- Names are case-insensitive. The UI locale's catalog is searched first, then its parent
  locale's and the `default_locale` one.
- `@@extension_id` always resolves. A localized extension (one with `default_locale`) also
  gets `@@ui_locale` (`en_US`), `@@bidi_dir`, `@@bidi_reversed_dir`, `@@bidi_start_edge`
  and `@@bidi_end_edge`.
- `$name$` placeholders in `messages.json` are replaced by their `content` when the
  extension loads; contents are not rescanned.
- At call time `$1`…`$9` take the matching substitution (numbers through `String`), or
  nothing if there is none. A run of n dollars becomes n − 1, so `$$` is `$` and `$$$1` is
  `$$1`. A `$` followed by anything else, or ending the message, is dropped together with
  the next byte. Chrome works on UTF-8 bytes here, so before a non-ASCII character this
  leaves U+FFFD replacement characters.
- `{ escapeLt: true }` turns `<` into `&lt;` in the message, not in substituted values.
- More than 9 substitutions is a malformed call. Chrome answers it with `undefined`, and
  the service fails with `ChromeI18nError` (`operation: "getMessage"`) rather than
  reporting a missing message.

Substitutions and options are passed to Chrome only when given. A readonly substitution
array is copied on every run, never handed to Chrome.

## Language detection

Chrome asks CLD3 for three languages at most, stops at an undetermined one, drops
transliterated `xx-Latn` results, and never calls a text under 50 UTF-8 bytes reliable.
When nothing is detected the result is `{ isReliable: false, languages: [] }`.

## Testing

`makeI18n(options)` from `effect-platform-chrome/testing/I18n` returns `{ api, layer,
controls }`. It takes `messages` (one parsed `messages.json`, or several from most to least
specific), `uiLanguage`, `acceptLanguages`, `extensionId`, a `detect` stand-in for CLD3 and
`overrides`. The factory throws for a catalog Chrome would refuse to load: an invalid name,
an undefined `$placeholder$`, or a reserved `@@` locale name. `controls.setUILanguage`
also changes `@@ui_locale` and the `@@bidi_*` messages; `controls.failNext(operation, cause)`
fails the next call once. `replacePlaceholders` is Chrome's runtime substitution on its own.
