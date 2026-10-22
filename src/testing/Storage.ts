import { Schema } from "effect"
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
  const b = new Map(Object.entries(right))

  return a.length === b.size && a.every(([key, value]) => b.has(key) && equal(value, b.get(key)))
}

export type StorageOperation = "get" | "getBytesInUse" | "getKeys" | "set" | "remove" | "clear" | "setAccessLevel"

type Changes = ChromeStorage.Changes

/**
 * Replacements for one area's members. A member given as `undefined` is removed, so
 * `{ getKeys: undefined }` behaves like Chrome before 130 and `{ setAccessLevel: undefined }`
 * like Chrome before 102.
 */
export type AreaOverrides<Api> = { readonly [K in keyof Api]?: Api[K] | undefined }

export interface StorageOverrides {
  readonly local?: AreaOverrides<ChromeStorage.StorageAreaApi>
  readonly sync?: AreaOverrides<ChromeStorage.StorageAreaApi>
  readonly session?: AreaOverrides<ChromeStorage.StorageAreaApi>
  readonly managed?: AreaOverrides<ChromeStorage.ManagedAreaApi>
  /** Replaces the global event; the fixture's writes then emit only on `controls.onChanged`. */
  readonly onChanged?: ChromeStorage.ChromeStorageApi["onChanged"]
}

/** An area as the fixture exposes it: its Api members plus the per-area `onChanged` event. */
export type FixtureArea<Api> = Api & { readonly onChanged: TestEvent.EventApi<[Changes]> }

/** An area under construction, before its optional members are added. */
type Building<Area> = { -readonly [K in keyof Area]: Area[K] }

/** The override for `key` when one is given, `undefined` included; otherwise `fallback`. */
const member = <Api, K extends keyof Api>(overrides: AreaOverrides<Api>, key: K, fallback: Api[K]): Api[K] | undefined =>
  Object.hasOwn(overrides, key) ? overrides[key] : fallback

/**
 * An in-memory `chrome.storage` with fresh state for each call: `local`, `sync` and
 * `session` are writable, while `managed` policy changes only through `controls.seed`.
 * Every call can be failed once with `controls.failNext`; `overrides` replace or remove
 * any area member, or replace the global `onChanged` event.
 */
export const makeStorage = (overrides: StorageOverrides = {}) => {
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

    // Chrome's typed key-selector union requires string/object discrimination.
    /* oxlint-disable anti-slop/no-runtime-typeof */
    const get = async (keys: ChromeStorage.GetKeys | undefined = null): Promise<ChromeStorage.Items> => {
      check(name, "get")

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

    const getBytesInUse = async (keys: ChromeStorage.Keys | undefined = null): Promise<number> => {
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

  const writableArea = (name: "local" | "sync" | "session"): FixtureArea<ChromeStorage.StorageAreaApi> => {
    const base = areas[name].writable
    const override = overrides[name] ?? {}
    const getKeys = member(override, "getKeys", base.getKeys)
    const setAccessLevel = member(override, "setAccessLevel", base.setAccessLevel)

    const result: Building<FixtureArea<ChromeStorage.StorageAreaApi>> = {
      get: override.get ?? base.get,
      getBytesInUse: override.getBytesInUse ?? base.getBytesInUse,
      set: override.set ?? base.set,
      remove: override.remove ?? base.remove,
      clear: override.clear ?? base.clear,
      onChanged: base.onChanged
    }

    // Version-gated members stay absent when removed, as on older Chrome.
    if (getKeys !== undefined) result.getKeys = getKeys

    if (setAccessLevel !== undefined) result.setAccessLevel = setAccessLevel

    return result
  }

  const managedArea = (): FixtureArea<ChromeStorage.ManagedAreaApi> => {
    const base = areas.managed.writable
    const override = overrides.managed ?? {}
    const getKeys = member(override, "getKeys", base.getKeys)

    const result: Building<FixtureArea<ChromeStorage.ManagedAreaApi>> = {
      get: override.get ?? base.get,
      getBytesInUse: override.getBytesInUse ?? base.getBytesInUse,
      onChanged: base.onChanged
    }

    if (getKeys !== undefined) result.getKeys = getKeys

    return result
  }

  const api = {
    local: writableArea("local"),
    sync: writableArea("sync"),
    session: writableArea("session"),
    managed: managedArea(),
    onChanged: overrides.onChanged ?? globalEvent.api
  }

  // Assignment checks the structural boundary without narrowing fixture extras.
  const storageApi: ChromeStorage.ChromeStorageApi = api

  return {
    api,
    layer: ChromeStorage.layer(storageApi),
    controls: {
      onChanged: globalEvent.controls,
      areas: {
        local: areas.local.event, sync: areas.sync.event,
        session: areas.session.event, managed: areas.managed.event
      },
      /** Replaces the whole area, managed policy included; emits the changes when `emit` is true. */
      seed: (name: ChromeStorage.AreaName, items: ChromeStorage.Items, emit = false) => areas[name].seed(items, emit),
      /** The area's current access level, as last set through `setAccessLevel`. */
      accessLevel: (name: "local" | "sync" | "session") => areas[name].accessLevel(),
      /** Rejects the area's next `operation` call with `cause`, before any mutation. */
      failNext: (name: ChromeStorage.AreaName, operation: StorageOperation, cause: unknown) => {
        const key = `${name}:${operation}`
        const queue = failures.get(key) ?? []
        queue.push(cause)
        failures.set(key, queue)
      }
    }
  }
}
