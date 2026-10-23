# ChromeOffscreen

Import from `effect-platform-chrome/ChromeOffscreen`. `ChromeOffscreen` is an Effect v4
service over `chrome.offscreen`. `make(api)` and `layer(api)` take an injectable
Promise-based subset; `layerLive` reads `chrome.offscreen` and `chrome.runtime` only when
built, failing with `operation: "initialize"` where either namespace is missing. Requires
the `"offscreen"` manifest permission and Chrome 116+ (for `runtime.getContexts`);
`hasDocument` needs Chrome 150+.

An MV3 service worker has no DOM. An offscreen document is a hidden extension page that
lends it one, for DOM parsing, clipboard access, audio playback, `getUserMedia`, and the
other `chrome.offscreen.Reason` values. Only `chrome.runtime` messaging is available inside
it; talk to it with `ChromeRuntime` or `ChromePort`. `chrome.offscreen` has no events.

| Member | Behaviour |
| --- | --- |
| `createDocument(parameters)` | Plain `offscreen.createDocument`; resolves once the page has finished its initial load. Fails while any offscreen document is open or still loading. |
| `closeDocument` | Plain `offscreen.closeDocument` (an `Effect` value). Fails when none exists; closes a document that is still loading, whose `createDocument` then fails. |
| `hasDocument` | Chrome 150+: whether any offscreen document exists, open or still loading, whatever its URL. Fails with `operation: "hasDocument"` in older Chrome. |
| `ensureDocument(parameters)` | Creates the document unless it is already open; resolves to whether this call created it. An open page is reused as it is, whatever its reasons. |
| `document(parameters)` | Scoped `ensureDocument`: the last overlapping scope to close closes the document. |

Failures are `ChromeOffscreenError` with the Chrome call as `operation`
(`createDocument`, `closeDocument`, `hasDocument`, `getContexts`, `getURL`) and the
original `cause`, whether Chrome rejected or threw synchronously. `getURL` also covers a
`url` that does not resolve against the extension root; that fails before any Chrome call.

## One document per extension

Chrome allows a single offscreen document per extension at a time (in split incognito
mode, one per profile). A second `createDocument`, even for the same URL, rejects while
one is open **or still being created**. Every offscreen task in an extension therefore
shares one page: give it one URL that handles every message your extension sends it,
rather than one page per feature.

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

- `url` must be a static HTML page packaged in **this extension**, relative to its root
  (`"offscreen.html"`, `"/offscreen.html"` and the absolute `chrome-extension://<id>/...`
  form all name the same page). Chrome rejects anything else; web URLs and other
  extensions' pages are not allowed. A query string makes a different page URL. List the
  page as an HTML entrypoint in your bundler so it ships in the build.
- `reasons` (`ChromeOffscreen.Reason`) declares which capabilities the document needs.
  Pick the narrowest ones that are true; Chrome closes `AUDIO_PLAYBACK` documents after
  about 30 seconds without audio, and sets no lifetime for the other reasons. Chrome
  rejects an empty list, so the type requires at least one reason; readonly (`as const`)
  parameters are accepted. The reasons are fixed at creation: `ensureDocument` reuses an
  open page without comparing them.
- `justification` is a human-readable explanation Chrome may show the user. Make it
  specific to what your extension does.

The parameters reach Chrome unchanged; Chrome validates them.

## Why `ensureDocument` is serialised

The usual pattern is check-then-create: ask `runtime.getContexts` for an
`OFFSCREEN_DOCUMENT` context at the document's URL, and create one only if none is found.
Two concurrent callers can both see "absent" and both call `createDocument`; the second
then rejects. `ensureDocument` holds a one-permit semaphore owned by the service across
the lookup and the creation, so callers sharing the service create the document once and
the rest observe it as open. `createDocument`, `closeDocument`, `document` and its release
take the same permit, so lifecycle changes from one service never interleave.
`hasDocument` is a plain query and does not wait for the permit. A failed lookup or
creation releases the permit; the next caller retries from scratch.

The semaphore covers one service instance in one JavaScript context. Another extension
context (a popup, or a second service instance) can still create the document between the
lookup and the creation. When `createDocument` fails, `ensureDocument` looks again and
treats a document now open at the same URL as success, so that race is also absorbed. A
creation that the other context has started is not visible to `getContexts` until its
page commits; `ensureDocument` then fails with `createDocument`'s error, and a retry once
it has loaded finds the document. After the page commits, `getContexts` lists it although
it may still be loading, so an `ensureDocument` that found another context's document can
resolve before the page's message listeners exist; have the page announce that it is
ready if several contexts create it. A document this service created has always finished
its initial load. Build the service once (one layer) per context so every caller shares
the permit.

Chrome closes a document that another context closes while it loads, and one whose page
fails to load; the pending `createDocument` then fails ("Offscreen document closed before
fully loading.", "Page failed to load."), as does an `ensureDocument` or `document`
relying on it, without leaving a holder behind.

`chrome.offscreen.hasDocument` would avoid the URL lookup, but only exists from Chrome
150, and it cannot tell which page is open. `getContexts` works from Chrome 116 and
matches on `documentUrls`, so this module resolves `url` to its absolute
`chrome-extension://<id>/...` form with `runtime.getURL` before the lookup.

## Interruption

Chrome cannot cancel a `createDocument` or `closeDocument` call it has started.
Interrupting `createDocument`, `closeDocument` or `ensureDocument` therefore stops the
wait at once and releases the permit, but the Chrome call keeps running; the service's
next lifecycle call waits for it to settle before it looks or acts, so it never collides
with the abandoned call (an `ensureDocument` after an interrupted creation finds the
document instead of failing). Interrupting a caller still waiting for the permit, or
looking up the document, leaves nothing behind.

`document` is a resource acquisition: once Chrome is creating the document for it, the
acquisition finishes before the interruption takes effect, so its scope always owns what
it created and closes it.

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

Overlapping `document` scopes on one service count holders per page URL; only the last
release for that URL closes the document, whoever created it (including a plain
`ensureDocument`). Release first checks that a document is still open at the scope's URL,
so it leaves alone a different page that replaced it in the meantime (if that check
fails, it closes anyway, since it cannot rule the document out). Release ignores close
failures, such as Chrome having already closed the document. A scope that closes while
its acquisition is still running releases the document as soon as the acquisition
completes. Use `ensureDocument` without a scope for a long-lived document, and close it
yourself when done.

A service worker can be stopped at any time, and Chrome does not run Effect finalizers
then. An offscreen document can outlive the worker that created it; on the next start,
`ensureDocument` finds and reuses it instead of failing.

## Testing

`makeOffscreen(overrides?, extensionId?)` from `effect-platform-chrome/testing/Offscreen`
is an in-memory API with Chrome's single-document rule and error messages; it rejects
pages outside the extension and an empty `reasons` list. As in Chrome, a document still
loading exists for `hasDocument` and `closeDocument` (closing it rejects the pending
`createDocument`) but not for `getContexts`, which honours every `ContextFilter` field. `overrides` replace
API members (`{ hasDocument: undefined }` models Chrome before 150). Its `controls` expose
the loaded document's URL, whether a creation is pending, every `createDocument` call, the
number of closes, `open`/`close` to simulate another context or Chrome (`close` also
closes a loading document), `failNext` for
any call (queued in order; `getURL` throws synchronously), and `holdNextCreate` /
`holdNextClose` to keep a call pending while concurrent callers queue.

Deterministic stress cases live in `test/stress/ChromeOffscreen.stress.test.ts`: thousands
of concurrent calls with interleaved rejections and throws, scoped documents interrupted at
every stage, seeded races with interruption while Chrome works, competing contexts,
documents Chrome closes while loading or after, and long create/close runs.
