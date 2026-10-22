import { Deferred, Effect, Result } from "effect"
import { expect } from "@effect/vitest"

/** Events in one burst: far beyond the 64-event subscription buffer. */
export const burst = 4096

/** The newest events a sliding 64-event buffer keeps from a burst of `count`. */
export const newest = (count: number, kept = 64): Array<number> =>
  Array.from({ length: kept }, (_, index) => count - kept + index)

/**
 * A Chrome-like event recording every registration, with an explicit gate that completes
 * once `size` listeners are registered at the same time, instead of sleeping.
 */
export const gatedEvent = <Args extends ReadonlyArray<unknown>>() => {
  type Listener = (...args: Args) => void

  const listeners = new Set<Listener>()
  const added: Array<Listener> = []
  const removed: Array<Listener> = []
  const gates: Array<{ readonly size: number; readonly deferred: Deferred.Deferred<void> }> = []

  const open = () => {
    for (const gate of gates.splice(0)) {
      if (listeners.size >= gate.size) Deferred.doneUnsafe(gate.deferred, Effect.void)
      else gates.push(gate)
    }
  }

  return {
    listeners,
    added,
    removed,
    addListener: (listener: Listener) => {
      listeners.add(listener)
      added.push(listener)
      open()
    },
    removeListener: (listener: Listener) => {
      listeners.delete(listener)
      removed.push(listener)
    },
    /** Synchronous dispatch over a snapshot, as Chrome does. */
    emit: (...args: Args) => {
      for (const listener of Array.from(listeners)) listener(...args)
    },
    /** Completes once at least `size` listeners are registered simultaneously. */
    registered: (size: number): Effect.Effect<void> => Effect.suspend(() => {
      if (listeners.size >= size) return Effect.void
      const deferred = Deferred.makeUnsafe<void>()
      gates.push({ size, deferred })

      return Deferred.await(deferred)
    })
  }
}

export interface PendingCall {
  readonly operation: string
  readonly resolve: () => void
  readonly reject: (cause: Error) => void
}

/**
 * Native calls that stay pending until the test settles them, so concurrent calls can be
 * resolved and rejected in a chosen interleaving once all of them have arrived. Every
 * `throwEvery`-th arrival (none when 0) throws synchronously instead, as a Chrome argument
 * error does.
 */
export const pendingCalls = (throwEvery = 7) => {
  const calls: Array<PendingCall> = []
  const thrown = new Map<Error, string>()
  const gates: Array<{ readonly size: number; readonly deferred: Deferred.Deferred<void> }> = []
  let arrivals = 0

  return {
    calls,
    /** Synchronously thrown causes, with the operation that threw each. */
    thrown,
    /** Waits for the test to settle this call; throws synchronously on every `throwEvery`-th arrival. */
    call: (operation: string): Promise<void> => {
      const arrival = arrivals++

      if (throwEvery > 0 && arrival % throwEvery === 0) {
        const cause = new Error(`${operation} threw synchronously`)
        thrown.set(cause, operation)

        throw cause
      }

      return new Promise<void>((resolve, reject) => {
        calls.push({ operation, resolve, reject })

        for (const gate of gates.splice(0)) {
          if (calls.length >= gate.size) Deferred.doneUnsafe(gate.deferred, Effect.void)
          else gates.push(gate)
        }
      })
    },
    /** Completes once at least `size` calls are pending. */
    arrived: (size: number): Effect.Effect<void> => Effect.suspend(() => {
      if (calls.length >= size) return Effect.void
      const deferred = Deferred.makeUnsafe<void>()
      gates.push({ size, deferred })

      return Deferred.await(deferred)
    }),
    /**
     * Settles every pending call newest first, rejecting every other one. Returns each
     * rejection cause with the operation it belongs to.
     */
    settleInterleaved: (): Map<Error, string> => {
      const rejected = new Map<Error, string>()

      for (let index = calls.length - 1; index >= 0; index--) {
        const call = calls[index]!

        if (index % 2 === 0) {
          const cause = new Error(`${call.operation} rejected`)
          rejected.set(cause, call.operation)
          call.reject(cause)
        } else {
          call.resolve()
        }
      }

      return rejected
    }
  }
}

export interface Labelled<E> {
  readonly operation: string
  readonly result: Result.Result<void, E>
}

/** Runs `effect`, keeping whether it failed with the operation the caller expects it to report. */
export const labelled = <A, E>(operation: string, effect: Effect.Effect<A, E>): Effect.Effect<Labelled<E>> =>
  Effect.map(Effect.result(Effect.asVoid(effect)), (result) => ({ operation, result }))

/**
 * Every failure is a typed error for exactly one injected cause, naming the operation that
 * cause was injected into; every injected cause surfaces exactly once.
 */
export const expectOperations = <E, T extends { readonly operation: string; readonly cause: unknown }>(
  results: ReadonlyArray<Labelled<E>>,
  injected: ReadonlyMap<Error, string>,
  errorType: abstract new (...args: never) => T,
  /** How a failure names its operation; modules with extra context fields include them. */
  reported: (error: T) => string = (error) => error.operation
) => {
  const seen = new Set<Error>()

  for (const { operation, result } of results) {
    if (Result.isFailure(result)) {
      const failure = result.failure
      expect(failure).toBeInstanceOf(errorType)

      if (failure instanceof errorType) {
        expect(reported(failure)).toBe(operation)
        expect(failure.cause).toBeInstanceOf(Error)

        if (failure.cause instanceof Error) {
          expect(injected.get(failure.cause)).toBe(operation)
          seen.add(failure.cause)
        }
      }
    }
  }

  expect(seen.size).toBe(injected.size)
  expect(results.filter(({ result }) => Result.isFailure(result))).toHaveLength(injected.size)
}

/** How many of `total` arrivals stay pending when every `throwEvery`-th one throws. */
export const pendingCount = (total: number, throwEvery = 7): number =>
  throwEvery > 0 ? total - Math.ceil(total / throwEvery) : total
