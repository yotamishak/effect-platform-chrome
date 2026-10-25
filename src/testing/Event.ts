// Listener arguments and collected listener exceptions are raw Chrome callback values.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns */

export interface EventApi<Args extends ReadonlyArray<unknown>> {
  readonly addListener: (listener: (...args: Args) => void) => void
  readonly removeListener: (listener: (...args: Args) => void) => void
  readonly hasListener: (listener: (...args: Args) => void) => boolean
  readonly hasListeners: () => boolean
  /** Declarative rules are not supported on these simulated events. */
  readonly addRules: () => never
  readonly removeRules: () => never
  readonly getRules: () => never
}

/** Synchronous, insertion-ordered dispatch with a listener snapshot per emission.
 * Exceptions are returned, not thrown; later listeners still run. Recursive
 * emissions take a new snapshot. Listener identity is deduplicated.
 */
export const makeEvent = <Args extends ReadonlyArray<unknown>>() => {
  const listeners = new Set<(...args: Args) => void>()
  const waiting: Array<() => void> = []
  const failures = new Map<"addListener" | "removeListener", Array<unknown>>()

  const check = (operation: "addListener" | "removeListener") => {
    const queue = failures.get(operation)

    if (queue !== undefined && queue.length > 0) throw queue.shift()
  }

  const unsupported = (): never => { throw new Error("Declarative event rules are not simulated") }

  const api: EventApi<Args> = {
    addListener: (listener) => {
      check("addListener")
      listeners.add(listener)

      for (const resolve of waiting.splice(0)) resolve()
    },
    removeListener: (listener) => {
      check("removeListener")
      listeners.delete(listener)
    },
    hasListener: (listener) => listeners.has(listener),
    hasListeners: () => listeners.size > 0,
    addRules: unsupported,
    removeRules: unsupported,
    getRules: unsupported
  }

  return {
    api,
    controls: {
      get listenerCount() { return listeners.size },
      waitForListener: (): Promise<void> => listeners.size > 0
        ? Promise.resolve()
        : new Promise((resolve) => { waiting.push(resolve) }),
      failNext: (operation: "addListener" | "removeListener", cause: unknown) => {
        const queue = failures.get(operation) ?? []
        queue.push(cause)
        failures.set(operation, queue)
      },
      emit: (...args: Args): ReadonlyArray<unknown> => {
        const errors: Array<unknown> = []

        for (const listener of Array.from(listeners)) {
          try { listener(...args) } catch (cause) { errors.push(cause) }
        }

        return errors
      }
    }
  }
}
