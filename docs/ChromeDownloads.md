# ChromeDownloads

Import from `effect-platform-chrome/ChromeDownloads`. `make(api)` and `layer(api)` take an
injectable Promise-based `chrome.downloads` subset; `layerLive` reads the global only when
built and fails with `operation: "initialize"` without it. Every call needs the
`"downloads"` permission; `open` also needs `"downloads.open"` and `setUiOptions`
`"downloads.ui"`.

- `download`, `search`, `pause`, `resume`, `cancel`, `erase`, `removeFile`, `open`,
  `getFileIcon`, `setUiOptions` and `acceptDanger` are lazy Effects over Chrome's Promises.
  `show(downloadId)` and the `showDefaultFolder` Effect value wrap Chrome's synchronous
  calls; Chrome reports no outcome for them beyond a synchronous throw.
- `getFileIcon(downloadId, options?)` passes `options` only when given and resolves to an
  `Option`: None when Chrome resolves without an icon.
- `setUiOptions` is Chrome 105+ and optional in `ChromeDownloadsApi`; without it, calling it
  fails with a typed error. The deprecated `setShelfEnabled` is not wrapped.
- Rejections and synchronous throws become `ChromeDownloadsError` with the Chrome member
  name as `operation` and the original `cause`.

## User gestures

Chrome only honours `open` inside a user gesture, and shows `acceptDanger`'s prompt only from
a visible extension page in response to a user action. The lazy `open` / `acceptDanger` do
not call Chrome when composed, so an async step before they run can lose the gesture.
`openFromUserGesture(downloadId)` and `acceptDangerFromUserGesture(downloadId)` are the
imperative bridges shared with `ChromePermissions.requestFromUserGesture`: they call Chrome
synchronously when invoked and return an Effect observing that one call. Running it again
replays the outcome; interruption stops waiting but cannot cancel Chrome's call; a
rejection is handled even if the Effect never runs.

```ts
import { Effect } from "effect"
import * as ChromeDownloads from "effect-platform-chrome/ChromeDownloads"

const downloads = ChromeDownloads.make(chrome.downloads)
const button = document.querySelector<HTMLButtonElement>("#open-report")!

button.addEventListener("click", () => {
  const outcome = downloads.openFromUserGesture(Number(button.dataset.downloadId))
  Effect.runFork(outcome.pipe(Effect.catch((error) => Effect.logError(error))))
})
```

## waitForComplete

`waitForComplete(downloadId)` resolves to the download once it is `complete` (at once if it
already is) and fails with `DownloadInterruptedError` (`downloadId`, Chrome's `reason`) if it
is `interrupted` or becomes so. It adds its `onChanged` listener before reading the current
state, so a transition in between is not missed, and removes it when it finishes, fails or
is interrupted. When a delta reports the interruption without a reason, the reason is read
from the item. A paused or unaccepted dangerous download keeps it waiting. An unknown or
erased id fails with `operation: "search"`; a failing listener registration with
`operation: "onChanged"`. Waiting does not keep an MV3 worker alive: for long downloads,
persist the id and react to `downloads.onChanged` through `ChromeServiceWorker`.

## Events

`onCreated`, `onChanged` (changed fields only; never `bytesReceived` or `estimatedEndTime`)
and `onErased` are observational streams: one listener per consumption, removed when it
ends, fails or is interrupted, with a 64-event sliding buffer. They cannot wake an MV3 worker.

`onDeterminingFilename` emits `{ item, suggest }` and returns `true` to Chrome, which then
holds the download until `suggest` runs:

- `suggest(suggestion?)` answers once, as Chrome requires. Once the event is answered, by
  an earlier `suggest` or by the default name the stream gives when it ends, a call fails
  with `operation: "suggest"` without calling Chrome, so a late suggestion never vanishes
  silently. Suggest inside the stream: `Stream.runHead` ends the stream, so suggesting on
  the event it returns fails. A suggestion Chrome throws on fails the same way and leaves
  the event unanswered, so it can be answered again.
- An event the 64-event buffer drops is answered with Chrome's default name at once, so no
  download waits on an event no consumer will see.
- When the stream ends, fails or is interrupted, every event still unanswered (including
  ones taken but never answered) is answered with the default name.
- Chrome allows one listener per extension across all its contexts: run one such stream at
  a time. `ChromeServiceWorker.listen` cannot answer asynchronously, so a worker woken for a
  download keeps Chrome's default name.

## Stress coverage

`test/stress/ChromeDownloads.stress.test.ts` covers, without a browser: a 4096-event burst
per event leaving exactly the newest 64 in order and no listener (for
`onDeterminingFilename`, the 4032 dropped downloads are answered with the default name
before the first delivery, and every download is answered exactly once); 512 concurrent
subscriptions per event stopped at seeded stages, ending with zero listeners; 1024
filename events answered by racing pairs, each download answered once with its own name
and the losing `suggest` of each pair failing typed;
1560 concurrent calls across every operation and both gesture bridges with seeded
rejections and throws settled in shuffled order, each typed; 1024 concurrent
`showDefaultFolder` runs; 1024 concurrent `waitForComplete` waiters settled in shuffled
order (complete, interrupted with and without a reason, already settled, unknown,
cancelled); 512 waiters interrupted before starting, mid-search or while waiting; and a
10,000-item search population.
