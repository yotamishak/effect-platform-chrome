import { Effect, Option, Queue, Stream } from "effect"

/** The listener half of a Chrome event; injected test events fit it as well. */
export interface EventSource<Args extends ReadonlyArray<unknown>> {
  addListener(listener: (...args: Args) => void): void
  removeListener(listener: (...args: Args) => void): void
}

/** Pending events each subscription retains before dropping the oldest. */
export const bufferSize = 64

/**
 * Like `observe`, keeping only the events `select` maps to some value. Skipped events
 * never take a buffer slot.
 */
export const observeSome = <Args extends ReadonlyArray<unknown>, A, E>(
  getSource: () => EventSource<Args>,
  select: (...args: Args) => Option.Option<A>,
  onError: (cause: unknown) => E,
  capacity = bufferSize
): Stream.Stream<A, E> => Stream.callback<A, E>((queue) => {
  let active = true

  const listener = (...args: Args) => {
    if (!active) return
    const selected = select(...args)

    if (Option.isSome(selected)) Queue.offerUnsafe(queue, selected.value)
  }

  return Effect.gen(function*() {
    const source = yield* Effect.try({ try: getSource, catch: onError })

    // Install cleanup before registration, which may partially succeed then throw.
    yield* Effect.acquireRelease(
      Effect.succeed(listener),
      () => Effect.sync(() => {
        active = false
        source.removeListener(listener)
      })
    )
    // The stream's own interrupt finalizer can run the release above while this fiber is
    // suspended here; adding afterwards would leave a listener nobody removes.
    yield* Effect.try({
      try: () => {
        if (active) source.addListener(listener)
      },
      catch: onError
    })
  })
}, { bufferSize: capacity, strategy: "sliding" })

/**
 * An observational stream over a Chrome event. Each consumption owns one listener,
 * looked up and added when the stream starts and removed when its scope closes, including
 * on interruption. The buffer holds `capacity` events and drops the oldest on overflow,
 * because Chrome callbacks cannot be backpressured. Such listeners exist only while the
 * stream runs, so they cannot wake an MV3 service worker; wake listeners belong in
 * ChromeServiceWorker.
 */
export const observe = <Args extends ReadonlyArray<unknown>, A, E>(
  getSource: () => EventSource<Args>,
  project: (...args: Args) => A,
  onError: (cause: unknown) => E,
  capacity = bufferSize
): Stream.Stream<A, E> => observeSome(getSource, (...args: Args) => Option.some(project(...args)), onError, capacity)
