import { Layer, Schema } from "effect"
import * as ChromeStorage from "../ChromeStorage.js"
import * as TestEvent from "./Event.js"

// These are deliberately raw Chrome I/O boundaries: messages, stored values and
// callback exceptions are unvalidated until a consumer applies its own schema.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type */

const itemsSchema = Schema.Record(Schema.String, Schema.Unknown)

const cloneItems = (items: ChromeStorage.Items): ChromeStorage.Items =>
  Schema.decodeUnknownSync(itemsSchema)(JSON.parse(JSON.stringify(items)))

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

export type StorageOperation = "get" | "getBytesInUse" | "getKeys" | "set" | "remove" | "clear" | "setAccessLevel"

type Changes = Record<string, chrome.storage.StorageChange>

/** Fresh state for each call. Managed policy can only be changed by controls. */
export const makeStorage = () => {
  const globalEvent = TestEvent.makeEvent<[Changes, ChromeStorage.AreaName]>()
  const failures = new Map<string, Array<unknown>>()

  const check = (area: ChromeStorage.AreaName, operation: StorageOperation) => {
    const queue = failures.get(`${area}:${operation}`)

    if (queue !== undefined && queue.length > 0) throw queue.shift()
  }

  const area = (name: ChromeStorage.AreaName) => {
    const values = new Map<string, unknown>()
    // Chrome's defaults: only session storage starts closed to content scripts.
    let accessLevel: ChromeStorage.AccessLevel = name === "session" ? "TRUSTED_CONTEXTS" : "TRUSTED_AND_UNTRUSTED_CONTEXTS"
    const event = TestEvent.makeEvent<[Changes]>()

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

    const getKeys = async (): Promise<Array<string>> => {
      check(name, "getKeys")

      return Array.from(values.keys())
    }

    const writable = {
      get, getBytesInUse, getKeys, onChanged: event.api,
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
      },
      setAccessLevel: async (options: { readonly accessLevel: ChromeStorage.AccessLevel }): Promise<void> => {
        check(name, "setAccessLevel")
        accessLevel = options.accessLevel
      }
    }
    /* oxlint-enable anti-slop/no-runtime-typeof */

    return {
      writable,
      event: event.controls,
      accessLevel: () => accessLevel,
      seed: (items: ChromeStorage.Items, emit = false) => update(items, true, emit)
    }
  }

  const areas = { local: area("local"), sync: area("sync"), session: area("session"), managed: area("managed") }

  const api = {
    local: areas.local.writable,
    sync: areas.sync.writable,
    session: areas.session.writable,
    managed: {
      get: areas.managed.writable.get,
      getBytesInUse: areas.managed.writable.getBytesInUse,
      getKeys: areas.managed.writable.getKeys,
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
      /** The area's current access level, as last set through `setAccessLevel`. */
      accessLevel: (name: "local" | "sync" | "session") => areas[name].accessLevel(),
      failNext: (name: ChromeStorage.AreaName, operation: StorageOperation, cause: unknown) => {
        const key = `${name}:${operation}`
        const queue = failures.get(key) ?? []
        queue.push(cause)
        failures.set(key, queue)
      }
    }
  }
}
