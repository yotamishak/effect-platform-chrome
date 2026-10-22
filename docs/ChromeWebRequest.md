# ChromeWebRequest

Import from `effect-platform-chrome/ChromeWebRequest`. `ChromeWebRequest` is an Effect v4
service over `chrome.webRequest`; `make(api)` and `layer(api)` accept an injectable
subset, and `layerLive` reads the global only when built (failing with
`operation: "initialize"` when it is missing). Every failure is a `ChromeWebRequestError`
carrying the Chrome member name as `operation` (`"onCompleted"`, `"handlerBehaviorChanged"`)
and the original `cause`.

In Manifest V3 only policy-installed extensions may block requests through webRequest.
This module therefore **observes** requests, and blocks or rewrites nothing; use
`ChromeDeclarativeNetRequest` for that. The one MV3 exception, answering an
authentication challenge, is `answerAuthRequired`.

## Lifecycle streams

Each filterable event is a method taking Chrome's required `RequestFilter` and optional
extra-info flags, and returning a `Stream` of Chrome's details:

| Stream | Fired | Extra-info flags |
| --- | --- | --- |
| `onBeforeRequest` | before a request starts | `requestBody`, `extraHeaders` |
| `onBeforeSendHeaders` | before its headers are sent | `requestHeaders`, `extraHeaders` |
| `onSendHeaders` | after its headers are sent | `requestHeaders`, `extraHeaders` |
| `onHeadersReceived` | when response headers arrive | `responseHeaders`, `extraHeaders`, `securityInfo` and `securityInfoRawDer` (Chrome 144+) |
| `onAuthRequired` | when the server asks for credentials | `responseHeaders`, `extraHeaders` |
| `onBeforeRedirect` | before a server redirect is followed | `responseHeaders`, `extraHeaders` |
| `onResponseStarted` | when the first body byte arrives | `responseHeaders`, `extraHeaders` |
| `onCompleted` | when the request succeeds | `responseHeaders`, `extraHeaders` |
| `onErrorOccurred` | when it fails | `extraHeaders` |

A request ends with `onCompleted` or `onErrorOccurred`; a redirect loops back to
`onBeforeRequest` with the same `requestId`. `file:` URLs report only `onBeforeRequest`,
`onResponseStarted`, `onCompleted` and `onErrorOccurred`, and requests served from the
in-memory cache report nothing. `onActionIgnored` (a `Stream` property, since Chrome takes
no filter for it) reports modifications Chrome dropped in favour of another extension's.

```ts
import { Effect, Stream } from "effect"
import * as ChromeWebRequest from "effect-platform-chrome/ChromeWebRequest"

const logFailures = Effect.gen(function*() {
  const webRequest = yield* ChromeWebRequest.ChromeWebRequest
  yield* webRequest.onErrorOccurred({ urls: ["https://api.example.com/*"], types: ["xmlhttprequest"] }).pipe(
    Stream.runForEach((details) => Effect.logWarning(`${details.method} ${details.url}: ${details.error}`))
  )
})
```

- An empty `urls` list matches every URL the extension can see; `types`, `tabId` and
  `windowId` narrow it further. Events arrive only for URLs (and, for subresources,
  initiators) covered by the extension's host permissions.
- Flags are passed to Chrome only when given. Chrome rejects a malformed filter or an
  unknown flag synchronously, which fails the stream with a typed error; it only logs an
  invalid URL pattern or a missing permission to the extension console, and the stream
  then receives nothing.
- Streams are observational: each consumption owns one listener, removed when its scope
  closes, buffering at most 64 events and dropping the oldest. They cannot wake an MV3
  service worker; register wake listeners synchronously with `ChromeServiceWorker.listen`
  (which passes the filter but no extra-info flags).

## Answering authentication

`answerAuthRequired(filter, answer, extraInfoSpec?)` registers an `"asyncBlocking"`
onAuthRequired listener for the life of the current scope. It needs the
`"webRequestAuthProvider"` permission; without it Chrome logs an error and never calls
`answer`.

```ts
import { Effect } from "effect"
import * as ChromeWebRequest from "effect-platform-chrome/ChromeWebRequest"

const attempts = new Map<string, number>()

const proxyCredentials = Effect.gen(function*() {
  const webRequest = yield* ChromeWebRequest.ChromeWebRequest
  yield* webRequest.answerAuthRequired({ urls: ["<all_urls>"] }, (details) => Effect.sync(() => {
    const attempt = (attempts.get(details.requestId) ?? 0) + 1
    attempts.set(details.requestId, attempt)

    // Rejected credentials raise a new challenge for the same request: stop after one retry.
    return details.isProxy && attempt <= 2 ? { authCredentials: { username: "user", password: "secret" } } : {}
  }))
  yield* Effect.never
}).pipe(Effect.scoped)
```

Each challenge runs `answer` in its own fiber with the caller's services and is answered
exactly once:

| `answer` | Chrome receives |
| --- | --- |
| succeeds with `{ authCredentials }` | the credentials, retried by Chrome |
| succeeds with `{ cancel: true }` | a cancelled request |
| succeeds with `{}` | no action: Chrome shows its own prompt or fails the request |
| dies, is interrupted, or throws while building its Effect | no action |
| is still running when the scope closes | no action |

`answer` has no error channel, so handle failures inside it. Challenges Chrome delivers
while the listener is being removed are answered with no action at once. Only the fields
the answer sets are passed to Chrome.

## handlerBehaviorChanged

`handlerBehaviorChanged` (an Effect value) flushes Chrome's in-memory cache after
listeners started treating requests differently, so cached requests reach them again. It
is expensive: Chrome allows 20 calls per sustained 10 minutes
(`MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES`) and only warns about more. Adding or
removing listeners does not need it. It returns a Promise from Chrome 116; earlier
versions fail with a typed error.

## Testing

`effect-platform-chrome/testing/WebRequest` exports `makeWebRequest(options?, overrides?)`,
returning `{ api, layer, controls }`:

- Listeners are matched like Chrome's: match patterns via `matchesUrlPattern` (`<all_urls>`,
  the `*` scheme for http and https, `*.host` subdomain wildcards, ports, and glob paths
  including the query), `types`, `tabId`, and `windowId` (place tabs in windows with
  `controls.setTabWindow`). `matchesRequestFilter` and `parseUrlPattern` are exported too.
- Each listener receives its own copy of the details, without the optional fields its
  flags did not ask for (`requestBody`, `requestHeaders`, `responseHeaders`,
  `securityInfo`, and certificate bytes without `"securityInfoRawDer"`).
- `addListener` throws for a malformed filter or a flag the event does not accept, and
  logs to `controls.consoleErrors` instead of registering for an invalid URL pattern or a
  blocking registration without permission (only onAuthRequired may block, and only with
  `options.authProvider`, the default).
- `controls.request({ url, redirects?, response?, error?, ... })` drives a request through
  its lifecycle in Chrome's order, following redirects with Fetch's method rules;
  `controls.<event>.emit(details)` delivers single events; and
  `controls.onAuthRequired.challenge(details)` resolves with each `"asyncBlocking"`
  listener's answer (`{}` for a listener that throws or is removed first).
- `controls.listenerErrors` collects exceptions thrown by listeners, and
  `controls.handlerBehaviorChangedCalls` counts flushes.
