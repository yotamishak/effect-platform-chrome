import * as ChromeIdle from "../ChromeIdle.js"
import * as TestEvent from "./Event.js"

// Injected failures and collected listener exceptions are raw Chrome causes.
/* oxlint-disable anti-slop/no-unknown-parameters */

export type IdleOperation = "queryState" | "setDetectionInterval" | "getAutoLockDelay"

export interface IdleOptions {
  /** Seconds since the last user input when the fixture starts (default 0). */
  readonly idleTime?: number
  /** Whether the screen starts locked (default false). */
  readonly locked?: boolean
  /** The extension's starting detection interval (default 60, Chrome's default). */
  readonly detectionInterval?: number
  /** What `getAutoLockDelay` reports (default 0, as on every platform but ChromeOS). */
  readonly autoLockDelay?: number
  /** Replaces any member of the simulated API. */
  readonly overrides?: Partial<ChromeIdle.ChromeIdleApi>
}

/** Chrome's floor for both intervals, from the extension API schema. */
export const minimumInterval = 15

/** Chrome's cap for both intervals (four hours); larger values are treated as this. */
export const maximumInterval = 4 * 60 * 60

/** Mirrors Chrome's argument validation for an `integer` parameter with `minimum: 15`, then its clamp. */
const validInterval = (signature: string, parameter: string, value: number): number => {
  const fail = (reason: string) =>
    new TypeError(`Error in invocation of idle.${signature}: Error at parameter '${parameter}': ${reason}`)

  // Chrome's bindings take only int32 values as integers: not NaN, infinities, -0 or fractions.
  if (!Number.isInteger(value) || Object.is(value, -0) || value < -(2 ** 31) || value >= 2 ** 31) {
    throw fail("Invalid type: expected integer, found number.")
  }

  if (value < minimumInterval) throw fail(`Value must be at least ${minimumInterval}.`)

  return Math.min(value, maximumInterval)
}

const validDetectionInterval = (value: number): number =>
  validInterval("setDetectionInterval(integer intervalInSeconds)", "intervalInSeconds", value)

const validSeconds =(name: string, seconds: number): number => {
  if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError(`${name} must be a finite number of seconds >= 0, got ${seconds}`)

  return seconds
}

/**
 * An in-memory `chrome.idle`. The machine's state is the idle time (seconds since the last
 * input) and whether the screen is locked; `queryState(n)` reports `"locked"` when locked,
 * else `"idle"` once the idle time reaches `n`, else `"active"`, as Chrome does. Both
 * intervals are validated like Chrome's bindings (a synchronous `TypeError` for anything
 * but an integer of at least 15) and capped at four hours.
 *
 * `onStateChanged` follows Chrome's sampling: Chrome keeps the extension's last sampled
 * state, starting at `"active"`, samples it at the detection interval about once a second
 * only while the extension has a listener, and fires when a sample differs from it. A
 * subscription made while the machine is already idle or locked therefore opens with that
 * state, and changes made while no listener exists surface at the next sample. Here a
 * sample runs after every change made while a listener exists, including
 * `setDetectionInterval`, and on `controls.poll()`, Chrome's next tick; adding a listener
 * never samples by itself, as Chrome never calls a listener while it is being added.
 * Emissions triggered from inside a listener are queued behind the current one, so every
 * listener sees states in order. Controls return the exceptions listeners threw. Time
 * never passes on its own: `controls.elapse` moves it, and nothing locks automatically.
 * Each operation can be failed once with `controls.failNext` (`setDetectionInterval`
 * throws, the others reject).
 */
export const makeIdle = (options: IdleOptions = {}) => {
  const stateChanged = TestEvent.makeEvent<[ChromeIdle.IdleState]>()
  const failures = new Map<IdleOperation, Array<unknown>>()
  const pending: Array<ChromeIdle.IdleState> = []
  let idleTime = validSeconds("idleTime", options.idleTime ?? 0)
  let locked = options.locked ?? false
  let detectionInterval = validDetectionInterval(options.detectionInterval ?? 60)
  let autoLockDelay = validSeconds("autoLockDelay", options.autoLockDelay ?? 0)
  let dispatching = false

  const check = (operation: IdleOperation) => {
    const queue = failures.get(operation)

    if (queue !== undefined && queue.length > 0) throw queue.shift()
  }

  const stateAt = (threshold: number): ChromeIdle.IdleState =>
    locked ? "locked" : idleTime >= threshold ? "idle" : "active"

  // Chrome's per-extension record of the last sampled state starts "active".
  let reported: ChromeIdle.IdleState = "active"

  /**
   * Samples at the detection interval while a listener exists, as Chrome's polling does,
   * and dispatches a change, in order, without nesting.
   */
  const evaluate = (): ReadonlyArray<unknown> => {
    if (stateChanged.controls.listenerCount === 0) return []

    const next = stateAt(detectionInterval)

    if (next === reported) return []

    reported = next
    pending.push(next)

    if (dispatching) return []

    dispatching = true
    const errors: Array<unknown> = []

    try {
      for (let state = pending.shift(); state !== undefined; state = pending.shift()) {
        errors.push(...stateChanged.controls.emit(state))
      }
    } finally {
      dispatching = false
    }

    return errors
  }

  const api: ChromeIdle.ChromeIdleApi = {
    // Not async: Chrome validates arguments synchronously, before returning a Promise.
    queryState: (detectionIntervalInSeconds) => {
      const threshold = validInterval(
        "queryState(integer detectionIntervalInSeconds, optional function callback)",
        "detectionIntervalInSeconds",
        detectionIntervalInSeconds
      )

      try {
        check("queryState")
      } catch (cause) {
        return Promise.reject(cause)
      }

      return Promise.resolve(stateAt(threshold))
    },
    setDetectionInterval: (intervalInSeconds) => {
      const interval = validDetectionInterval(intervalInSeconds)

      check("setDetectionInterval")
      detectionInterval = interval
      evaluate()
    },
    getAutoLockDelay: async () => {
      check("getAutoLockDelay")

      return autoLockDelay
    },
    onStateChanged: stateChanged.api,
    ...options.overrides
  }

  return {
    api,
    layer: ChromeIdle.layer(api),
    controls: {
      /**
       * The state Chrome last sampled at the detection interval, which `onStateChanged` last
       * reported: `"active"` until the first sample, and stale while no listener exists.
       */
      get state(): ChromeIdle.IdleState { return reported },
      /** The extension's current detection interval, after Chrome's cap. */
      get detectionInterval(): number { return detectionInterval },
      /** Seconds since the last user input. */
      get idleTime(): number { return idleTime },
      get locked(): boolean { return locked },
      get autoLockDelay(): number { return autoLockDelay },
      /** No input arrives for `seconds` more seconds. */
      elapse: (seconds: number): ReadonlyArray<unknown> => {
        idleTime += validSeconds("seconds", seconds)

        return evaluate()
      },
      /** Chrome's next once-a-second sample, firing a change if a listener exists; nothing else changes. */
      poll: (): ReadonlyArray<unknown> => evaluate(),
      /** The user generates input, resetting the idle time; input alone does not unlock the screen. */
      input: (): ReadonlyArray<unknown> => {
        idleTime = 0

        return evaluate()
      },
      /** The screen locks or the screensaver starts. */
      lock: (): ReadonlyArray<unknown> => {
        locked = true

        return evaluate()
      },
      /** The user unlocks the screen, which counts as input. */
      unlock: (): ReadonlyArray<unknown> => {
        locked = false
        idleTime = 0

        return evaluate()
      },
      /** Changes what `getAutoLockDelay` reports; it does not lock the screen by itself. */
      setAutoLockDelay: (seconds: number) => {
        autoLockDelay = validSeconds("autoLockDelay", seconds)
      },
      /** The next call of `operation` fails with `cause`, before any change. */
      failNext: (operation: IdleOperation, cause: unknown) => {
        const queue = failures.get(operation) ?? []
        queue.push(cause)
        failures.set(operation, queue)
      },
      onStateChanged: stateChanged.controls
    }
  }
}
