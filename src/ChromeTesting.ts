import { Layer, Schema } from "effect"
import * as ChromeStorage from "./ChromeStorage.js"
import * as ChromePort from "./ChromePort.js"

// These are deliberately raw Chrome I/O boundaries: messages, stored values and
// callback exceptions are unvalidated until a consumer applies its own schema.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type */

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

const itemsSchema = Schema.Record(Schema.String, Schema.Unknown)

const cloneItems = (items: ChromeStorage.Items): ChromeStorage.Items =>
  Schema.decodeUnknownSync(itemsSchema)(JSON.parse(JSON.stringify(items)))

const cloneMessage = (message: unknown): unknown => {
  const encoded = JSON.stringify(message)

  if (encoded === undefined) throw new TypeError("Message must be JSON serializable")

  return JSON.parse(encoded)
}

const equal = (left: unknown, right: unknown): boolean => {
  if (left === right) return true

  // JSON values are already serialized here; this only selects recursive equality.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false

  if (Array.isArray(left) !== Array.isArray(right)) return false

  const a = Object.entries(left)
  const b = Object.entries(right)

  return a.length === b.length && a.every(([key, value]) =>
    b.some(([otherKey, otherValue]) => key === otherKey && equal(value, otherValue)))
}

export type StorageOperation = "get" | "getBytesInUse" | "set" | "remove" | "clear"

type Changes = Record<string, chrome.storage.StorageChange>

/** Fresh state for each call. Managed policy can only be changed by controls. */
export const makeStorage = () => {
  const globalEvent = makeEvent<[Changes, ChromeStorage.AreaName]>()
  const failures = new Map<string, Array<unknown>>()

  const check = (area: ChromeStorage.AreaName, operation: StorageOperation) => {
    const queue = failures.get(`${area}:${operation}`)

    if (queue !== undefined && queue.length > 0) throw queue.shift()
  }

  const area = (name: ChromeStorage.AreaName) => {
    const values = new Map<string, unknown>()
    const event = makeEvent<[Changes]>()

    const notify = (changes: Changes) => {
      if (Object.keys(changes).length === 0) return

      // Separate payloads prevent a global listener mutating the per-area event.
      const localChanges = structuredClone(changes)
      globalEvent.controls.emit(changes, name)
      event.controls.emit(localChanges)
    }

    const update = (items: ChromeStorage.Items, replace: boolean, emit: boolean) => {
      // Serialize before changing state: failed serialization is atomic.
      const incoming = cloneItems(items)
      const changes: Changes = {}

      if (replace) {
        for (const [key, oldValue] of values) {
          if (!Object.hasOwn(incoming, key)) {
            Object.defineProperty(changes, key, { value: { oldValue }, enumerable: true })
            values.delete(key)
          }
        }
      }

      for (const [key, newValue] of Object.entries(incoming)) {
        const present = values.has(key)
        const oldValue = values.get(key)

        if (!present || !equal(oldValue, newValue)) {
          Object.defineProperty(changes, key, {
            value: present ? { oldValue, newValue } : { newValue }, enumerable: true
          })
          values.set(key, newValue)
        }
      }

      if (emit) notify(structuredClone(changes))
    }

    const get = async (keys: ChromeStorage.GetKeys = null): Promise<ChromeStorage.Items> => {
      check(name, "get")
      // Chrome's typed key-selector union requires string/object discrimination.
      /* oxlint-disable anti-slop/no-runtime-typeof */

      const selected = keys === null ? Array.from(values.keys())
        : typeof keys === "string" ? [keys]
        : Array.isArray(keys) ? keys : Object.keys(keys)

      const result: ChromeStorage.Items = {}

      for (const key of new Set(selected)) {
        if (values.has(key)) {
          Object.defineProperty(result, key, { value: values.get(key), enumerable: true })
        } else if (keys !== null && typeof keys === "object" && !Array.isArray(keys)) {
          Object.defineProperty(result, key, { value: keys[key], enumerable: true })
        }
      }

      return cloneItems(result)
    }

    const getBytesInUse = async (keys: ChromeStorage.Keys = null): Promise<number> => {
      check(name, "getBytesInUse")
      const selected = keys === null ? Array.from(values.keys()) : typeof keys === "string" ? [keys] : keys
      const encoder = new TextEncoder()
      let bytes = 0

      for (const key of new Set(selected)) {
        if (values.has(key)) bytes += encoder.encode(key).length + encoder.encode(JSON.stringify(values.get(key))).length
      }

      return bytes
    }

    const writable = {
      get, getBytesInUse, onChanged: event.api,
      set: async (items: ChromeStorage.Items): Promise<void> => {
        check(name, "set")
        update(items, false, true)
      },
      remove: async (keys: string | Array<string>): Promise<void> => {
        check(name, "remove")
        const changes: Changes = {}

        for (const key of new Set(typeof keys === "string" ? [keys] : keys)) {
          if (values.has(key)) {
            Object.defineProperty(changes, key, { value: { oldValue: values.get(key) }, enumerable: true })
            values.delete(key)
          }
        }

        notify(structuredClone(changes))
      },
      clear: async (): Promise<void> => {
        check(name, "clear")
        update({}, true, true)
      }
    }
    /* oxlint-enable anti-slop/no-runtime-typeof */

    return { writable, event: event.controls, seed: (items: ChromeStorage.Items, emit = false) => update(items, true, emit) }
  }

  const areas = { local: area("local"), sync: area("sync"), session: area("session"), managed: area("managed") }

  const api = {
    local: areas.local.writable,
    sync: areas.sync.writable,
    session: areas.session.writable,
    managed: {
      get: areas.managed.writable.get,
      getBytesInUse: areas.managed.writable.getBytesInUse,
      onChanged: areas.managed.writable.onChanged
    },
    onChanged: globalEvent.api
  }

  // Assignment checks the structural boundary without narrowing fixture extras.
  const storageApi: ChromeStorage.StorageApi = api

  return {
    api,
    layer: Layer.succeed(ChromeStorage.ChromeStorage, ChromeStorage.make(storageApi)),
    controls: {
      onChanged: globalEvent.controls,
      areas: {
        local: areas.local.event, sync: areas.sync.event,
        session: areas.session.event, managed: areas.managed.event
      },
      seed: (name: ChromeStorage.AreaName, items: ChromeStorage.Items, emit = false) => areas[name].seed(items, emit),
      failNext: (name: ChromeStorage.AreaName, operation: StorageOperation, cause: unknown) => {
        const key = `${name}:${operation}`
        const queue = failures.get(key) ?? []
        queue.push(cause)
        failures.set(key, queue)
      }
    }
  }
}

/** A single two-endpoint connection, with manually flushed FIFO delivery. */
export const makePortPair = (name = "") => {
  const tasks: Array<() => void> = []
  let connected = true

  const endpoint = () => {
    const message = makeEvent<[unknown, chrome.runtime.Port]>()
    const disconnect = makeEvent<[chrome.runtime.Port]>()
    let lastError: chrome.runtime.LastError | undefined
    const failures = new Map<"postMessage" | "disconnect" | "connect", Array<unknown>>()

    const check = (operation: "postMessage" | "disconnect" | "connect") => {
      const queue = failures.get(operation)

      if (queue !== undefined && queue.length > 0) throw queue.shift()
    }

    const native: chrome.runtime.Port = {
      name,
      onMessage: message.api,
      onDisconnect: disconnect.api,
      postMessage: (value: unknown) => {
        check("postMessage")

        if (!connected) throw new Error("Port is disconnected")

        const cloned = cloneMessage(value)
        const peer = native === left.port ? right : left
        tasks.push(() => { if (connected) peer.events.message.emit(cloned, peer.port) })
      },
      disconnect: () => {
        check("disconnect")

        if (!connected) return
        connected = false

        const peer = native === left.port ? right : left
        tasks.push(() => { peer.notifyDisconnect() })
      }
    }

    const api: ChromePort.RuntimeApi = {
      get lastError() { return lastError },
      connect: () => {
        check("connect")

        if (!connected) throw new Error("Pair is disconnected; create a new fixture")

        return native
      }
    }

    return {
      port: native,
      api,
      layer: ChromePort.ChromePort.layer(api),
      events: { message: message.controls, disconnect: disconnect.controls },
      notifyDisconnect: (error?: string) => {
        lastError = error === undefined ? undefined : { message: error }

        try { disconnect.controls.emit(native) } finally { lastError = undefined }
      },
      failNext: (operation: "postMessage" | "disconnect" | "connect", cause: unknown) => {
        const queue = failures.get(operation) ?? []
        queue.push(cause)
        failures.set(operation, queue)
      }
    }
  }

  const left = endpoint()

  const right = endpoint()

  return {
    left: { port: left.port, api: left.api, layer: left.layer },
    right: { port: right.port, api: right.api, layer: right.layer },
    controls: {
      left: { ...left.events, failNext: left.failNext },
      right: { ...right.events, failNext: right.failNext },
      get connected() { return connected },
      get pendingCount() { return tasks.length },
      flushOne: (): boolean => {
        const task = tasks.shift()

        if (task === undefined) return false
        task()

        return true
      },
      /** Drains only the current snapshot; reentrant posts await another flush. */
      flush: () => { for (const task of tasks.splice(0)) task() },
      disconnect: (error?: string) => {
        if (!connected) return
        connected = false
        tasks.push(() => { left.notifyDisconnect(error) })
        tasks.push(() => { right.notifyDisconnect(error) })
      }
    }
  }
}
