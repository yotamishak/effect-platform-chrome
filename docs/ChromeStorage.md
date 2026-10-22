# ChromeStorage

Typed access to `chrome.storage` in Manifest V3: the writable `local`, `sync` and `session`
areas, read-only `managed` policy, and change streams.

```ts
import { Effect, Stream } from "effect"
import { ChromeStorage } from "effect-platform-chrome"

const program = Effect.gen(function*() {
  const storage = yield* ChromeStorage.ChromeStorage
  yield* storage.local.setAccessLevel("TRUSTED_CONTEXTS")
  yield* storage.local.set({ theme: "dark" })
  const { theme } = yield* storage.local.get({ theme: "light" })
  const keys = yield* storage.local.getKeys
  return { theme, keys }
}).pipe(Effect.provide(ChromeStorage.layerLive))
```

## Calls

| Member | Areas | Notes |
| --- | --- | --- |
| `get(keys?)` | all | No argument reads the whole area (Chrome is called without one). A string or array selects keys; an object supplies defaults; `null` is passed through. |
| `getBytesInUse(keys?)` | all | No argument measures the whole area. |
| `getKeys` | all | Chrome 130+. Earlier browsers fail with `operation: "getKeys"`; fall back to `get()`. |
| `set(items)` | writable | Fails beyond the area's quota with Chrome's message. |
| `remove(keys)` | writable | |
| `clear` | writable | |
| `setAccessLevel(level)` | writable | Chrome 102+. `session` defaults to `"TRUSTED_CONTEXTS"`, the others to all contexts. |

Every failure is a `ChromeStorageError` with the Chrome member name as `operation`, the
`area` it used, and Chrome's rejection or throw, unchanged, as `cause`. A missing namespace
fails `layerLive` with `operation: "initialize"` and `area: "all"`; a missing area (such as
`session` before Chrome 102) fails each call on it instead.

`limits` mirrors Chrome's quota constants (`limits.sync.QUOTA_BYTES_PER_ITEM` and so on).
`local.QUOTA_BYTES` does not apply with the `unlimitedStorage` permission.

## Changes

`storage.onChanged` streams every area's changes as `{ area, changes }`; `storage.local.onChanged`
and the other area streams filter the same global event, so other areas' changes never take a
buffer slot. Each consumption owns one listener, added when it starts and removed when it ends,
fails or is interrupted, and keeps at most 64 pending changes (`changeBufferSize`), dropping the
oldest: re-read storage when a complete snapshot matters. These streams are observational and
cannot wake an MV3 worker; register wake listeners through `ChromeServiceWorker`.

`changeEvent` is the raw global event for code that must add a listener synchronously before
an Effect starts (ChromeSchemaStorage); its caller removes what it adds.

## Testing

`ChromeTesting.makeStorage(overrides?)` is an in-memory implementation; see
[ChromeTesting](ChromeTesting.md). Overrides replace members per area, and a member given as
`undefined` is removed, so `makeStorage({ local: { getKeys: undefined } })` behaves like Chrome
before 130.
