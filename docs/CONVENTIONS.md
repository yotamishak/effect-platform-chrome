# Module conventions

Every module that wraps a `chrome.*` namespace follows these rules, so a user who knows one
module knows them all. `ChromeWindows`, `ChromeNotifications` and `ChromeCookies` are the
reference implementations. Modules that are not namespace wrappers (`ChromeServiceWorker`,
`ChromeRpc`, `ChromeMessage`, `ChromeSchemaStorage`, `ChromeKeyValueStore`, `ChromeTesting`)
follow the rules that apply to them.

## Shape

```ts
export class ChromeXError extends Schema.TaggedError<ChromeXError>()("ChromeXError", {
  operation: Schema.String,  // the Chrome member name: "get", "onChanged", "initialize"
  cause: Schema.Defect()     // the rejection or throw, unchanged
}) {}

export interface ChromeXApi { /* the Promise-based subset actually used */ }

export interface ChromeXService { /* the Effect API */ }

export class ChromeX extends Context.Service<ChromeX, ChromeXService>()("effect-platform-chrome/ChromeX") {}

export const make = (api: ChromeXApi): ChromeXService => ChromeX.of({ /* … */ })

export const layer = (api: ChromeXApi): Layer.Layer<ChromeX> => Layer.succeed(ChromeX, make(api))

export const layerLive: Layer.Layer<ChromeX, ChromeXError> = liveLayer(
  ChromeX, "x", (chrome) => chrome.x, make,
  (cause) => new ChromeXError({ operation: "initialize", cause })
)
```

- `layer` always takes an injected API; `layerLive` is always the only live layer. No other
  layer names, no static members on the service class.
- An error may carry extra context fields (`ChromeStorageError.area`), never fewer.
  `operation` is the Chrome member name, including for events (`"onAlarm"`, not
  `"onAlarm.addListener"`), and `"initialize"` for a missing namespace.
- Nothing reads `chrome` at import time; `make` never reads globals.

## Calls

- Promise calls go through `invoker`, synchronous ones through `attempter`
  (`src/internal/api.ts`). No hand-written `Effect.tryPromise` except at a documented boundary
  that the helpers cannot express.
- An operation with no arguments is an `Effect` value (`getAll`), not a zero-argument function.
- An optional argument is passed to Chrome only when given; Chrome validates arguments.
- A result Chrome may leave out (`undefined` or `null`) is an `Option`. An empty list stays a
  list.
- A call Chrome only honours inside a user gesture has a lazy `x` plus `xFromUserGesture`, which
  starts the native call immediately and returns an Effect awaiting its outcome
  (`ChromePermissions.requestFromUserGesture`).
- Callback-only Chrome APIs read `lastError` inside the callback, injected through the Api.

## Events

- The Api types each event as `EventSource<[...args]>` (`src/internal/event.ts`), or a local
  filtered variant for events whose `addListener` takes a filter.
- Service streams come from `observe` / `observeSome`: one listener per consumption, removed
  when the stream's scope closes, a 64-event sliding buffer. They are observational and cannot
  wake an MV3 worker; wake listeners go through `ChromeServiceWorker.listen`.
- An event Chrome lets you filter is a method taking the filter (optional, or required when
  Chrome requires it): `onCreated(filter?)`. An unfilterable event is a `Stream` property.
- A one-argument event emits the argument; a multi-argument event emits an object with named
  fields. An optional tab is `Option<Tab>`.

## Tests and fixtures

- Each module's test file covers: every call mapping its rejection to the typed error with the
  right `operation`; optional arguments omitted; each stream delivering and removing its
  listener when it ends; registration failure as a typed error; `layerLive` failing with
  `"initialize"` without `chrome`.
- Deterministic stress cases (bursts beyond the buffer, subscription churn, concurrent calls,
  interruption mid-operation) live in `test/stress/<Module>.stress.test.ts`.
- A fixture for a stateful API lives in `src/testing/<Name>.ts`, returns
  `{ api, layer, controls }`, takes `overrides`, and is re-exported from `ChromeTesting`.
