# ChromeMessage

The reply envelope for one-off `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`
messages. It is not a namespace wrapper: it has no service, layer or Chrome calls, only the
shape both sides agree on.

```ts
type Response<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: { readonly code: ErrorCode; readonly message: string } }
```

`ErrorCode` is one of `InitializationFailed`, `HandlerFailed`, `Overflow` and `Disposed`, the
codes `ChromeServiceWorker.start` answers with when it cannot produce a value.

## Answering

`ChromeServiceWorker.start` wraps every `onMessage` handler result in the envelope. A content
script or page answering by hand builds it with `succeed` / `fail`:

```ts
import * as ChromeMessage from "effect-platform-chrome/ChromeMessage"

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  respond(ChromeMessage.succeed({ title: document.title }))
})
```

`fail(error)` copies exactly `code` and `message` out of `error`. Any value with those two
fields works: an `Error` subclass with a `code` keeps its message, which JSON would otherwise
drop because an `Error`'s `message` is not enumerable, and a received `ChromeMessageError` is
relayed without its `_tag`. Other keys are never sent.

The value travels as it is given, so a sender decoding with a transforming schema (for
example `Schema.FiniteFromString`) expects its encoded form.
`Schema.encodeEffect(ChromeMessage.Response(value))` encodes a whole envelope with the value
schema.

Chrome serializes messages as JSON. What JSON cannot represent arrives changed: a `Date` as
its ISO string, `NaN` and `Infinity` as `null`, a `Map` as `{}`, and a property whose value is
`undefined` not at all. The value schema decodes what arrives, not what was sent.

## Decoding

`decodeResponse(value)(reply)` is an Effect that succeeds with the decoded value, fails with
`ChromeMessageError` (`code`, `message`) on a failure envelope, and with `SchemaError` when the
reply is not an envelope of that value schema. `ChromeRuntime.request` sends and decodes in one
step. A value that fails its schema is reported at its place in the reply (`at ["value"][...]`).

- A reply that is no envelope at all fails with `SchemaError`: `null`, which Chrome sends for a
  bare `sendResponse()` or a listener that answers `undefined`, as well as `undefined`.
- A handler returning `Effect.void` sends `{ ok: true, value: undefined }`, which arrives as
  `{ ok: true }`. Both `decodeResponse` and the `Response(value)` schema read the missing
  `value` as `undefined` and hand it to the value schema: `Schema.Void`, `Schema.Undefined` and
  `Schema.Unknown` accept it, `Schema.Number` fails at `["value"]`.
- Keys the envelope does not define are ignored; `ok` alone decides which branch applies, so a
  failure envelope's stray `value` is never decoded.
- Decoding is lazy: it happens when the Effect runs, every time it runs. A value schema's
  decoding services and asynchronous transformations work as with any schema, including
  interruption.
