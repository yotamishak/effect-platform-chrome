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

/**
 * Chrome's key order: its stores are `std::map` / `base::Value::Dict`, ordered by UTF-8
 * bytes, which is code point order (unlike UTF-16 `sort`, which puts an emoji before U+FFFD).
 */
const compareKeys = (left: string, right: string): number => {
  let i = 0
  let j = 0

  while (i < left.length && j < right.length) {
    const a = left.codePointAt(i) ?? 0
    const b = right.codePointAt(j) ?? 0

    if (a !== b) return a - b
    i += a > 0xffff ? 2 : 1
    j += b > 0xffff ? 2 : 1
  }

  return (left.length - i) - (right.length - j)
}

/** A record in Chrome's key order; `fromEntries` defines own keys, `__proto__` included. */
const sortedRecord = <A>(entries: Iterable<readonly [string, A]>) =>
  Object.fromEntries(Array.from(entries).sort(([a], [b]) => compareKeys(a, b)))

const encoder = new TextEncoder()

/** What Chrome counts for an item: its key plus its JSON, in UTF-8 bytes. */
const itemBytes = (key: string, value: unknown): number =>
  encoder.encode(key).length + encoder.encode(JSON.stringify(value)).length

/** Chrome's quota messages, as `SettingsStorageQuotaEnforcer` words them. */
const quotaExceeded = (resource: "kQuotaBytes" | "kQuotaBytesPerItem" | "kMaxItems") =>
  new Error(`Resource::${resource} quota exceeded`)

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
  /** Lifts `local`'s `QUOTA_BYTES`, like the manifest's `unlimitedStorage` permission. */
  readonly unlimitedStorage?: boolean
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
 * Like Chrome, it lists keys in UTF-8 order, delivers one change at a time (the area's
 * event, then the global one; a write made by a listener is delivered after the current
 * change), and rejects writes beyond `ChromeStorage.limits`, approximating each item as its
 * key plus its JSON; sync's write-rate limits are not simulated. Every call, overridden
 * members included, can be failed once with `controls.failNext`; `overrides` replace or
 * remove any area member, or replace the global `onChanged` event.
 */
export const makeStorage = (overrides: StorageOverrides = {}) => {
  const globalEvent = TestEvent.makeEvent<[Changes, ChromeStorage.AreaName]>()
  const failures = new Map<string, Array<unknown>>()
  const deliveries: Array<() => void> = []
  let delivering = false

  const check = (area: ChromeStorage.AreaName, operation: StorageOperation) => {
    const queue = failures.get(`${area}:${operation}`)

    if (queue !== undefined && queue.length > 0) throw queue.shift()
  }

  /** Chrome dispatches changes asynchronously and in order; a nested write waits its turn. */
  const deliver = (delivery: () => void) => {
    deliveries.push(delivery)

    if (delivering) return
    delivering = true

    try {
      for (let next = deliveries.shift(); next !== undefined; next = deliveries.shift()) next()
    } finally {
      delivering = false
    }
  }

  /** An overriding member that still honours `controls.failNext`, as a rejection. */
  const guarded = <Args extends ReadonlyArray<unknown>, A>(
    area: ChromeStorage.AreaName,
    operation: StorageOperation,
    run: (...args: Args) => Promise<A>
  ) => (...args: Args): Promise<A> => {
    const queue = failures.get(`${area}:${operation}`)

    // A rejection with the injected cause, unchanged, as the base members reject.
    return queue !== undefined && queue.length > 0 ? Promise.reject(queue.shift()) : run(...args)
  }

  const area = (name: ChromeStorage.AreaName) => {
    const values = new Map<string, unknown>()
    // Each stored item's size, kept with its value so quota checks and measuring stay cheap.
    const sizes = new Map<string, number>()

    const store = (key: string, value: unknown) => {
      values.set(key, value)
      sizes.set(key, itemBytes(key, value))
    }

    const drop = (key: string) => {
      values.delete(key)
      sizes.delete(key)
    }

    // Chrome's defaults: only session storage starts closed to content scripts.
    let accessLevel: ChromeStorage.AccessLevel = name === "session" ? "TRUSTED_CONTEXTS" : "TRUSTED_AND_UNTRUSTED_CONTEXTS"
    const event = TestEvent.makeEvent<[Changes]>()

    const notify = (changes: Changes) => {
      if (Object.keys(changes).length === 0) return

      // Separate payloads prevent a global listener mutating the per-area event.
      const localChanges = structuredClone(changes)

      deliver(() => {
        event.controls.emit(localChanges)
        globalEvent.controls.emit(changes, name)
      })
    }

    /** Fails a write beyond the area's quota, as Chrome does before storing anything. */
    const enforceQuota = (incoming: ChromeStorage.Items) => {
      if (name === "managed" || (name === "local" && overrides.unlimitedStorage === true)) return

      let total = 0
      let count = sizes.size

      for (const size of sizes.values()) total += size

      for (const [key, value] of Object.entries(sortedRecord(Object.entries(incoming)))) {
        const size = itemBytes(key, value)
        const previous = sizes.get(key)
        total += size - (previous ?? 0)

        if (previous === undefined) count++

        if (name === "sync" && size > ChromeStorage.limits.sync.QUOTA_BYTES_PER_ITEM) throw quotaExceeded("kQuotaBytesPerItem")
      }

      // Session storage refuses a write that reaches its quota, not only one that passes it.
      if (name === "session") {
        if (total >= ChromeStorage.limits.session.QUOTA_BYTES) throw new Error("Session storage quota bytes exceeded. Values were not stored.")

        return
      }

      if (total > ChromeStorage.limits[name].QUOTA_BYTES) throw quotaExceeded("kQuotaBytes")

      if (name === "sync" && count > ChromeStorage.limits.sync.MAX_ITEMS) throw quotaExceeded("kMaxItems")
    }

    const update = (items: ChromeStorage.Items, replace: boolean, emit: boolean, enforce: boolean) => {
      // Serialize and check quota before changing state: a failed write is atomic.
      const incoming = cloneItems(items)

      if (enforce) enforceQuota(incoming)
      const changes = new Map<string, ChromeStorage.StorageChange>()

      if (replace) {
        for (const [key, oldValue] of values) {
          if (!Object.hasOwn(incoming, key)) {
            changes.set(key, { oldValue })
            drop(key)
          }
        }
      }

      for (const [key, newValue] of Object.entries(incoming)) {
        const present = values.has(key)
        const oldValue = values.get(key)

        if (!present || !equal(oldValue, newValue)) {
          changes.set(key, present ? { oldValue, newValue } : { newValue })
          store(key, newValue)
        }
      }

      if (emit) notify(structuredClone(sortedRecord(changes)))
    }

    // Chrome's typed key-selector union requires string/object discrimination.
    /* oxlint-disable anti-slop/no-runtime-typeof */
    const get = async (keys: ChromeStorage.GetKeys | undefined = null): Promise<ChromeStorage.Items> => {
      check(name, "get")

      const selected = keys === null ? Array.from(values.keys())
        : typeof keys === "string" ? [keys]
        : Array.isArray(keys) ? keys : Object.keys(keys)

      const result = new Map<string, unknown>()

      for (const key of new Set(selected)) {
        if (values.has(key)) {
          result.set(key, values.get(key))
        } else if (keys !== null && typeof keys === "object" && !Array.isArray(keys)) {
          result.set(key, keys[key])
        }
      }

      return cloneItems(sortedRecord(result))
    }

    const getBytesInUse = async (keys: ChromeStorage.Keys | undefined = null): Promise<number> => {
      check(name, "getBytesInUse")
      const selected = keys === null ? Array.from(values.keys()) : typeof keys === "string" ? [keys] : keys
      let bytes = 0

      for (const key of new Set(selected)) {
        bytes += sizes.get(key) ?? 0
      }

      return bytes
    }

    const getKeys = async (): Promise<Array<string>> => {
      check(name, "getKeys")

      return Array.from(values.keys()).sort(compareKeys)
    }

    const writable = {
      get, getBytesInUse, getKeys, onChanged: event.api,
      set: async (items: ChromeStorage.Items): Promise<void> => {
        check(name, "set")
        update(items, false, true, true)
      },
      remove: async (keys: string | Array<string>): Promise<void> => {
        check(name, "remove")
        const changes = new Map<string, ChromeStorage.StorageChange>()

        for (const key of new Set(typeof keys === "string" ? [keys] : keys)) {
          if (values.has(key)) {
            changes.set(key, { oldValue: values.get(key) })
            drop(key)
          }
        }

        notify(structuredClone(sortedRecord(changes)))
      },
      clear: async (): Promise<void> => {
        check(name, "clear")
        update({}, true, true, false)
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
      seed: (items: ChromeStorage.Items, emit = false) => update(items, true, emit, false)
    }
  }

  const areas = { local: area("local"), sync: area("sync"), session: area("session"), managed: area("managed") }

  /** The overriding member, guarded by `failNext`, when one is given; otherwise the base member. */
  const pick = <Args extends ReadonlyArray<unknown>, A>(
    name: ChromeStorage.AreaName,
    operation: StorageOperation,
    override: ((...args: Args) => Promise<A>) | undefined,
    base: (...args: Args) => Promise<A>
  ) => override === undefined ? base : guarded(name, operation, override)

  const writableArea = (name: "local" | "sync" | "session"): FixtureArea<ChromeStorage.StorageAreaApi> => {
    const base = areas[name].writable
    const override = overrides[name] ?? {}
    const getKeys = member(override, "getKeys", base.getKeys)
    const setAccessLevel = member(override, "setAccessLevel", base.setAccessLevel)

    const result: Building<FixtureArea<ChromeStorage.StorageAreaApi>> = {
      get: pick(name, "get", override.get, base.get),
      getBytesInUse: pick(name, "getBytesInUse", override.getBytesInUse, base.getBytesInUse),
      set: pick(name, "set", override.set, base.set),
      remove: pick(name, "remove", override.remove, base.remove),
      clear: pick(name, "clear", override.clear, base.clear),
      onChanged: base.onChanged
    }

    // Version-gated members stay absent when removed, as on older Chrome.
    if (getKeys !== undefined) result.getKeys = pick(name, "getKeys", getKeys, base.getKeys)

    if (setAccessLevel !== undefined) result.setAccessLevel = pick(name, "setAccessLevel", setAccessLevel, base.setAccessLevel)

    return result
  }

  const managedArea = (): FixtureArea<ChromeStorage.ManagedAreaApi> => {
    const base = areas.managed.writable
    const override = overrides.managed ?? {}
    const getKeys = member(override, "getKeys", base.getKeys)
    const setAccessLevel = member(override, "setAccessLevel", base.setAccessLevel)

    const result: Building<FixtureArea<ChromeStorage.ManagedAreaApi>> = {
      get: pick("managed", "get", override.get, base.get),
      getBytesInUse: pick("managed", "getBytesInUse", override.getBytesInUse, base.getBytesInUse),
      onChanged: base.onChanged
    }

    if (getKeys !== undefined) result.getKeys = pick("managed", "getKeys", getKeys, base.getKeys)

    if (setAccessLevel !== undefined) result.setAccessLevel = pick("managed", "setAccessLevel", setAccessLevel, base.setAccessLevel)

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
      /**
       * Replaces the whole area, managed policy included, without quota checks; emits the
       * changes when `emit` is true.
       */
      seed: (name: ChromeStorage.AreaName, items: ChromeStorage.Items, emit = false) => areas[name].seed(items, emit),
      /** The area's current access level, as last set through `setAccessLevel`. */
      accessLevel: (name: ChromeStorage.AreaName) => areas[name].accessLevel(),
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
