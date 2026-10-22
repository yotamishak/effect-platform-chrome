# ChromeOffscreen

Import from `effect-platform-chrome/ChromeOffscreen`. `ChromeOffscreen` is an Effect v4
service over `chrome.offscreen`. `make(api)` and `layer(api)` take an injectable
Promise-based subset; `layerLive` reads `chrome.offscreen` and `chrome.runtime` only when
built, failing with `operation: "initialize"` where the namespace is missing. Requires the
`"offscreen"` manifest permission and Chrome 116+ (for `runtime.getContexts`).

An MV3 service worker has no DOM. An offscreen document is a hidden extension page that
lends it one, for DOM parsing, clipboard access, audio playback, `getUserMedia`, and the
other `chrome.offscreen.Reason` values. Only `chrome.runtime` messaging is available inside
it; talk to it with `ChromeRuntime` or `ChromePort`.

| Member | Behaviour |
| --- | --- |
| `createDocument(parameters)` | Plain `offscreen.createDocument`. Fails while any offscreen document is open. |
| `closeDocument` | Plain `offscreen.closeDocument`. Fails when none is open. |
| `ensureDocument(parameters)` | Creates the document unless it is already open; resolves to whether this call created it. |
| `document(parameters)` | Scoped `ensureDocument`: the last overlapping scope to close closes the document. |

Failures are `ChromeOffscreenError` with the Chrome call as `operation`
(`createDocument`, `closeDocument`, `getContexts`, `getURL`) and the original `cause`.

## One document per extension

Chrome allows a single offscreen document per extension profile at a time. A second
`createDocument`, even for the same URL, rejects while one is open **or still being
created**. Every offscreen task in an extension therefore shares one page: give it one
URL that handles every message your extension sends it, rather than one page per feature.

`ensureDocument` fails when an offscreen document with a *different* URL is open, because
creating a second one is impossible; `closeDocument` first if you must switch pages.

## Parameters

```ts
const parameters: ChromeOffscreen.CreateParameters = {
  url: "offscreen.html",
  reasons: ["DOM_PARSER"],
  justification: "Parse HTML fetched by the service worker"
}
```

- `url` must be a page packaged in **this extension**, relative to its root
  (`"offscreen.html"` or `"/offscreen.html"`). Chrome resolves it against the extension
  origin and rejects anything else; web URLs and other extensions' pages are not allowed.
  List the page as an HTML entrypoint in your bundler so it ships in the build.
- `reasons` declares which capabilities the document needs. Pick the narrowest ones
  that are true; Chrome may close documents whose reason no longer applies (for example,
  `AUDIO_PLAYBACK` documents close after about 30 seconds without audio).
- `justification` is a human-readable explanation Chrome may show the user. Make it
  specific to what your extension does.

## Why `ensureDocument` is serialised

The usual pattern is check-then-create: ask `runtime.getContexts` for an
`OFFSCREEN_DOCUMENT` context at the document's URL, and create one only if none is found.
Two concurrent callers can both see "absent" and both call `createDocument`; the second
then rejects. `ensureDocument` holds a one-permit semaphore owned by the service across
the lookup and the creation, so callers sharing the service create the document once and
the rest observe it as open. `createDocument`, `closeDocument` and `document` take the same
permit, so lifecycle changes from one service never interleave. A failed lookup or creation
releases the permit; the next caller retries from scratch.

The semaphore covers one service instance in one JavaScript context. Another extension
context (a popup, or a second service instance) can still create the document between the
lookup and the creation. When `createDocument` fails, `ensureDocument` looks again and
treats a document now open at the same URL as success, so that race is also absorbed.
Build the service once (one layer) per context so every caller shares the permit.

`chrome.offscreen.hasDocument` would avoid the URL lookup, but only exists in recent
Chrome releases, and it cannot tell which page is open. `getContexts` works from Chrome
116 and matches on `documentUrls`, so this module resolves `url` to its absolute
`chrome-extension://<id>/...` form with `runtime.getURL` before the lookup.

## Scoped documents

```ts
import { Effect } from "effect"
import * as ChromeOffscreen from "effect-platform-chrome/ChromeOffscreen"

const parseHtml = (html: string) => Effect.scoped(Effect.gen(function*() {
  const offscreen = yield* ChromeOffscreen.ChromeOffscreen
  yield* offscreen.document(parameters)
  // ...send `html` to the document with ChromeRuntime and await the reply
}))
```

Overlapping `document` scopes on one service count holders; only the last release closes
the document, whoever created it (including a plain `ensureDocument`). Release ignores
close failures, such as Chrome having already closed the document. Use `ensureDocument`
without a scope for a long-lived document, and close it yourself when done.

A service worker can be stopped at any time, and Chrome does not run Effect finalizers
then. An offscreen document can outlive the worker that created it; on the next start,
`ensureDocument` finds and reuses it instead of failing.

## Testing

`makeOffscreen()` from `effect-platform-chrome/testing/Offscreen` is an in-memory API
with Chrome's single-document rule. Its `controls` expose the open document URL, every
`createDocument` call, `open`/`close` to simulate another context, `failNext`, and
`holdNextCreate` to keep a creation pending while concurrent callers queue.
