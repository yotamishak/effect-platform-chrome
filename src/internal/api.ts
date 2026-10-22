import { Effect, Layer } from "effect"
import type { Context } from "effect"

/** Runs a Promise-based Chrome call, mapping a rejection or synchronous throw to `onError`. */
export const invoker = <E>(onError: (operation: string, cause: unknown) => E) =>
  <A>(operation: string, run: () => Promise<A>): Effect.Effect<A, E> => Effect.tryPromise({
    try: run,
    catch: (cause) => onError(operation, cause)
  })

/** Runs a synchronous Chrome call, mapping a throw to `onError`. */
export const attempter = <E>(onError: (operation: string, cause: unknown) => E) =>
  <A>(operation: string, run: () => A): Effect.Effect<A, E> => Effect.try({
    try: run,
    catch: (cause) => onError(operation, cause)
  })

/**
 * A layer that reads `chrome.<name>` when it is built, never at import time, and fails with
 * `onError(cause)` (operation "initialize" by convention) when the namespace is missing.
 */
export const liveLayer = <I, S, Api, E>(
  service: Context.Key<I, S>,
  name: string,
  read: (chrome: typeof globalThis.chrome) => Api | undefined,
  make: (api: Api) => S,
  onError: (cause: unknown) => E
): Layer.Layer<I, E> => Layer.effect(service, Effect.try({
  try: () => {
    const api = typeof chrome === "undefined" ? undefined : read(chrome)

    if (api === undefined) {
      throw new Error(`chrome.${name} is unavailable in this context`)
    }

    return make(api)
  },
  catch: onError
}))
