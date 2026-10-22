// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { describe, expect, it, vi } from "@effect/vitest"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, SchemaTransformation, Stream } from "effect"
import { ChromeStorage, ChromeStorageError, make as makeStorage } from "../src/ChromeStorage.js"
import type { AreaName, Items } from "../src/ChromeStorage.js"
import { ChromeSchemaStorage, ChromeSchemaStorageError, layer, layerLive, make, storageKey } from "../src/ChromeSchemaStorage.js"
import type { EntryError, EntryOptions } from "../src/ChromeSchemaStorage.js"

const fixture = () => {
  type Listener = Parameters<typeof chrome.storage.onChanged.addListener>[0]

  const listeners = new Set<Listener>()

  const events = {
    addListener: vi.fn((listener: Listener) => { listeners.add(listener) }),
    removeListener: vi.fn((listener: Listener) => { listeners.delete(listener) })
  }

  const area = () => {
    const data: Items = {}

    return {
      data,
      get: vi.fn(async (): Promise<Items> => ({ ...data })),
      set: vi.fn(async (items: Items) => {
        const json = Schema.decodeSync(Schema.fromJsonString(Schema.JsonObject))(JSON.stringify(items))
        Object.assign(data, json)
      }),
      remove: vi.fn(async (keys: string | Array<string>) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]
      }),
      clear: vi.fn(async () => {}),
      getBytesInUse: vi.fn(async () => 0)
    }
  }

  const api = { local: area(), sync: area(), session: area(), managed: area(), onChanged: events }
  const storage = makeStorage(api)

  return {
    api,
    service: make(storage),
    storage,
    listeners,
    emit: (key: string, change: chrome.storage.StorageChange, changedArea: chrome.storage.AreaName = "local") => {
      for (const listener of listeners) listener({ [key]: change }, changedArea)
    }
  }
}

const options = {
  namespace: "settings",
  key: "theme",
  area: "local",
  version: 1,
  schema: Schema.String
} satisfies EntryOptions<typeof Schema.String>

class MigrationFailure extends Schema.TaggedError<MigrationFailure>()("MigrationFailure", { message: Schema.String }) {}

const gate = () => {
  let open!: () => void
  const promise = new Promise<void>((resolve) => { open = resolve })

  return { promise, open: () => open() }
}

const EVENT_BURST = 20_000

const SUBSCRIBERS = 256

const WRITER_RACES = 64

describe("ChromeSchemaStorage", () => {
  it.effect.each([false, true])("preserves a concurrent writer over suspended migrations with writeBack=%s", (writeBack) => Effect.gen(function*() {
    const f = fixture()
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let migrations = 0

    const entry = f.service.entry({ ...options, migrations: [{ from: 0, run: (payload) => Effect.gen(function*() {
      migrations++

      if (migrations === WRITER_RACES) yield* Deferred.succeed(started, undefined)
      yield* Deferred.await(release)

      return payload
    }) }] })

    f.api.local.data[entry.storageKey] = { version: 0, payload: "snapshot" }
    const readers = yield* Effect.forEach(Array.from({ length: WRITER_RACES }), () => Effect.forkScoped(entry.get({ writeBack })))
    yield* Deferred.await(started)
    yield* entry.set("concurrent writer")
    yield* Deferred.succeed(release, undefined)
    const results = yield* Effect.forEach(readers, Fiber.join)
    expect(results).toEqual(Array.from({ length: WRITER_RACES }, () => Option.some("snapshot")))
    // Write-back re-reads before writing and leaves the newer envelope in place.
    expect(f.api.local.data[entry.storageKey]).toEqual({ version: 1, payload: "concurrent writer" })
    expect(f.api.local.set).toHaveBeenCalledOnce()
    expect(f.api.local.get).toHaveBeenCalledTimes(writeBack ? WRITER_RACES * 2 : WRITER_RACES)
  }))

  it.effect("coalesces 20,000 events during blocked migration and ignores superseded corruption", () => Effect.gen(function*() {
    const f = fixture()
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const initial = yield* Deferred.make<void>()

    const migrate = vi.fn(() => Effect.gen(function*() {
      yield* Deferred.succeed(started, undefined)
      yield* Deferred.await(release)

      return "obsolete"
    }))

    const entry = f.service.entry({ ...options, migrations: [{ from: 0, run: migrate }] })
    const values: Array<Option.Option<string>> = []

    const fiber = yield* Effect.forkScoped(Stream.runDrain(Stream.take(Stream.tap(entry.observe, (value) => Effect.gen(function*() {
      values.push(value)
      yield* Deferred.succeed(initial, undefined)
    })), 2)))

    yield* Deferred.await(initial)
    f.emit(entry.storageKey, { newValue: { version: 0, payload: "old" } })
    yield* Deferred.await(started)

    for (let index = 0; index < EVENT_BURST; index++) {
      f.emit(entry.storageKey, { newValue: index % 2 === 0 ? { version: 99, payload: undefined } : { version: 1, payload: String(index) } })
    }

    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(fiber)
    expect(values).toEqual([Option.none(), Option.some(String(EVENT_BURST - 1))])
    expect(migrate).toHaveBeenCalledOnce()
    expect(f.listeners.size).toBe(0)
    expect(f.api.local.set).not.toHaveBeenCalled()
  }))

  it.effect("cancels 128 of 256 subscribers during blocked initial reads and delivers latest state to survivors", () => Effect.gen(function*() {
    const f = fixture()
    const allReading = gate()
    const release = gate()
    const entry = f.service.entry(options)
    let reads = 0
    f.api.local.get.mockImplementation(async () => {
      reads++

      if (reads === SUBSCRIBERS) allReading.open()
      await release.promise

      return { [entry.storageKey]: { version: 1, payload: "obsolete" } }
    })
    const fibers = yield* Effect.forEach(Array.from({ length: SUBSCRIBERS }), () => Effect.forkScoped(Stream.runCollect(Stream.take(entry.observe, 1))))
    yield* Effect.promise(() => allReading.promise)
    expect(f.listeners.size).toBe(SUBSCRIBERS)
    yield* Effect.forEach(fibers.slice(0, SUBSCRIBERS / 2), Fiber.interrupt)
    expect(f.listeners.size).toBe(SUBSCRIBERS / 2)

    for (let index = 0; index < 256; index++) f.emit(entry.storageKey, { newValue: { version: 1, payload: String(index) } })
    release.open()
    const results = yield* Effect.forEach(fibers.slice(SUBSCRIBERS / 2), Fiber.join)
    expect(results).toEqual(Array.from({ length: SUBSCRIBERS / 2 }, () => [Option.some("255")]))
    expect(f.listeners.size).toBe(0)
    expect(f.api.onChanged.removeListener).toHaveBeenCalledTimes(SUBSCRIBERS)
  }))

  it.effect("cleans partially registered listeners and exposes throwing removal as a defect", () => Effect.gen(function*() {
    const f = fixture()
    const entry = f.service.entry(options)
    const registrationCause = new Error("registered then failed")
    f.api.onChanged.addListener.mockImplementationOnce((listener) => {
      f.listeners.add(listener)
      throw registrationCause
    })
    expect(yield* Effect.flip(Stream.runDrain(entry.observe))).toMatchObject({ operation: "onChanged", cause: registrationCause })
    expect(f.listeners.size).toBe(0)
    expect(f.api.local.get).not.toHaveBeenCalled()
    const removalCause = new Error("removed then failed")
    f.api.onChanged.removeListener.mockImplementationOnce((listener) => {
      f.listeners.delete(listener)
      throw removalCause
    })
    const exit = yield* Effect.exit(Stream.runCollect(Stream.take(entry.observe, 1)))
    expect(Exit.isFailure(exit)).toBe(true)

    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(removalCause)
    expect(f.listeners.size).toBe(0)
  }))

  it.effect("rejects circular migration encodings and lossy defaults without persisting either", () => Effect.gen(function*() {
    const f = fixture()
    const circular: { [key: string]: Schema.Json } = {}
    circular.self = circular
    const migrated = f.service.entry({ ...options, schema: Schema.Unknown, migrations: [{ from: 0, run: () => Effect.succeed(circular) }] })
    f.api.local.data[migrated.storageKey] = { version: 0, payload: "old" }
    expect(yield* Effect.flip(migrated.get({ writeBack: true }))).toMatchObject({ reason: "json" })
    yield* migrated.remove
    const defaulted = f.service.entry({ ...options, schema: Schema.Unknown, defaultValue: () => Effect.succeed({ omitted: undefined }) })
    expect(yield* Effect.flip(defaulted.get({ writeBack: true }))).toMatchObject({ reason: "json" })
    expect(yield* Effect.flip(Stream.runDrain(defaulted.observe))).toMatchObject({ reason: "json" })
    expect(f.listeners.size).toBe(0)
    expect(f.api.local.set).not.toHaveBeenCalled()
  }))

  it.effect("interrupts blocked migrations without writes or leaked listeners", () => Effect.gen(function*() {
    const f = fixture()
    const started = yield* Deferred.make<void>()
    const finalized = yield* Deferred.make<void>()

    const entry = f.service.entry({ ...options, migrations: [{ from: 0, run: () => Effect.gen(function*() {
      yield* Deferred.succeed(started, undefined)

      return yield* Effect.never
    }).pipe(Effect.ensuring(Deferred.succeed(finalized, undefined))) }] })

    f.api.local.data[entry.storageKey] = { version: 0, payload: "old" }
    const fiber = yield* Effect.forkScoped(Stream.runDrain(entry.observe))
    yield* Deferred.await(started)
    yield* Fiber.interrupt(fiber)
    yield* Deferred.await(finalized)
    expect(f.listeners.size).toBe(0)
    expect(f.api.local.set).not.toHaveBeenCalled()
    expect(f.api.local.data[entry.storageKey]).toEqual({ version: 0, payload: "old" })
  }))

  it.effect("preserves default failure identity in observation and prevents managed default side effects", () => Effect.gen(function*() {
    const f = fixture()
    const failure = new MigrationFailure({ message: "default unavailable" })
    const defaultValue = vi.fn(() => Effect.fail(failure))
    const entry = f.service.entry({ ...options, defaultValue })
    expect(yield* Effect.flip(Stream.runDrain(entry.observe))).toBe(failure)
    expect(f.listeners.size).toBe(0)
    const managed = f.service.entry({ ...options, area: "managed", defaultValue })
    expect(yield* Effect.flip(managed.get({ writeBack: true }))).toMatchObject({ reason: "readOnly" })
    expect(yield* Effect.flip(managed.set("invalid managed write"))).toMatchObject({ reason: "readOnly" })
    expect(yield* Effect.flip(managed.remove)).toMatchObject({ reason: "readOnly" })
    expect(defaultValue).toHaveBeenCalledOnce()
    expect(f.api.managed.get).not.toHaveBeenCalled()
    expect(f.api.managed.set).not.toHaveBeenCalled()
    expect(f.api.managed.remove).not.toHaveBeenCalled()
  }))

  it.effect("round-trips large Unicode and escaped strings without treating JS length as a byte quota", () => Effect.gen(function*() {
    const f = fixture()
    const entry = f.service.entry({ ...options, namespace: "🌍\u0000\ud800", key: "\"\\\n" })
    const value = "🌍é\u0000\ud800\"\\\n".repeat(8192)
    expect(new TextEncoder().encode(value).length).toBeGreaterThan(value.length)
    yield* entry.set(value)
    expect(yield* entry.get()).toEqual(Option.some(value))
    expect(f.api.local.data[entry.storageKey]).toEqual({ version: 1, payload: value })
    expect(f.api.local.getBytesInUse).not.toHaveBeenCalled()
  }))

  it.effect.each([new Set([1]), /pattern/, new Uint8Array([1]), Object(1), Object("text"), Symbol("value"), () => 1])("rejects raw exotic stored payload %# before schema decoding or defaults", (payload) => Effect.gen(function*() {
    const f = fixture()
    const defaultValue = vi.fn(() => Effect.succeed("fallback"))
    const entry = f.service.entry({ ...options, defaultValue })
    f.api.local.data[entry.storageKey] = { version: 1, payload }
    expect(yield* Effect.flip(entry.get({ writeBack: true }))).toMatchObject({ reason: "json" })
    expect(defaultValue).not.toHaveBeenCalled()
    expect(f.api.local.set).not.toHaveBeenCalled()
  }))
  it.effect("composes with the injected ChromeStorage layer without a global", () => {
    const f = fixture()

    return Effect.gen(function*() {
      const service = yield* ChromeSchemaStorage
      const entry = service.entry(options)
      expect(yield* entry.get()).toEqual(Option.none())
      yield* entry.set("dark")
      expect(yield* entry.get()).toEqual(Option.some("dark"))
      expect(f.api.local.data[entry.storageKey]).toEqual({ version: 1, payload: "dark" })
      yield* entry.remove
      expect(yield* entry.get()).toEqual(Option.none())
    }).pipe(Effect.provide(layer.pipe(Layer.provide(Layer.succeed(ChromeStorage, f.storage)))))
  })

  it.effect("defaults only missing entries, creates fresh values, and never persists defaults", () => Effect.gen(function*() {
    const f = fixture()
    const defaultValue = vi.fn(() => Effect.sync(() => ({ values: ["fresh"] })))
    const entry = f.service.entry({ ...options, schema: Schema.Struct({ values: Schema.Array(Schema.String) }), defaultValue })
    const first = Option.getOrThrow(yield* entry.get())
    const second = Option.getOrThrow(yield* entry.get())
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    expect(first.values).not.toBe(second.values)
    expect(defaultValue).toHaveBeenCalledTimes(2)
    expect(f.api.local.set).not.toHaveBeenCalled()
    f.api.local.data[entry.storageKey] = { version: 1, payload: { values: 123 } }
    expect(yield* Effect.flip(entry.get())).toBeInstanceOf(Schema.SchemaError)
    expect(defaultValue).toHaveBeenCalledTimes(2)
    f.api.local.data[entry.storageKey] = undefined
    expect(yield* Effect.flip(entry.get())).toMatchObject({ reason: "envelope" })
    expect(defaultValue).toHaveBeenCalledTimes(2)
  }))

  it.effect("isolates namespaces, tuple separators, empty keys, and areas", () => Effect.gen(function*() {
    const f = fixture()
    const first = f.service.entry({ ...options, namespace: "a:b", key: "c" })
    const second = f.service.entry({ ...options, namespace: "a", key: "b:c" })
    const empty = f.service.entry({ ...options, namespace: "", key: "" })
    const sync = f.service.entry({ ...options, namespace: "a:b", key: "c", area: "sync" })
    yield* first.set("first")
    yield* second.set("second")
    yield* empty.set("empty")
    yield* sync.set("sync")
    expect(yield* first.get()).toEqual(Option.some("first"))
    expect(yield* second.get()).toEqual(Option.some("second"))
    expect(yield* empty.get()).toEqual(Option.some("empty"))
    expect(yield* sync.get()).toEqual(Option.some("sync"))
    expect(storageKey("__proto__", "🌍")).toBe('["__proto__","🌍"]')
  }))

  it.effect("encodes transformed schemas across an actual JSON round-trip", () => Effect.gen(function*() {
    const f = fixture()
    const entry = f.service.entry({ ...options, schema: Schema.DateFromString })
    const date = new Date("2026-10-13T00:00:00.000Z")
    yield* entry.set(date)
    expect(f.api.local.data[entry.storageKey]).toEqual({ version: 1, payload: date.toISOString() })
    expect(yield* entry.get()).toEqual(Option.some(date))
  }))

  it.effect("validates writes and defaults and preserves typed default failures", () => Effect.gen(function*() {
    const f = fixture()
    const schema = Schema.String.check(Schema.isMinLength(1))
    const entry = f.service.entry({ ...options, schema, defaultValue: () => Effect.succeed("") })
    expect(yield* Effect.flip(entry.set(""))).toBeInstanceOf(Schema.SchemaError)
    expect(yield* Effect.flip(entry.get())).toBeInstanceOf(Schema.SchemaError)
    const failure = new MigrationFailure({ message: "default failed" })
    const failing = f.service.entry({ ...options, defaultValue: () => Effect.fail(failure) })
    expect(yield* Effect.flip(failing.get())).toBe(failure)
    expect(f.api.local.set).not.toHaveBeenCalled()
  }))

  it.effect.each([
    undefined, NaN, Infinity, -0, 1n, new Date(), new Map(), { missing: undefined },
    [undefined], Array(2), Object.assign([1], { extra: 2 }), { toJSON: () => "changed" },
    { [Symbol("hidden")]: "omitted" }, Object.defineProperty({}, "hidden", { value: 1 }),
    Object.defineProperty({}, "value", { get: () => 1, enumerable: true })
  ])("rejects lossy JSON encoding %# without calling Chrome set", (payload) => Effect.gen(function*() {
    const f = fixture()
    const entry = f.service.entry({ ...options, schema: Schema.Unknown })
    expect(yield* Effect.flip(entry.set(payload))).toMatchObject({ reason: "json" })
    expect(f.api.local.set).not.toHaveBeenCalled()
  }))

  it.effect("rejects cyclic payloads and accepts shared references and null prototypes", () => Effect.gen(function*() {
    const f = fixture()
    const entry = f.service.entry({ ...options, schema: Schema.Unknown })
    const cyclic: Items = {}
    cyclic.self = cyclic
    expect(yield* Effect.flip(entry.set(cyclic))).toMatchObject({ reason: "json" })
    const child = { value: 1 }
    yield* entry.set({ a: child, b: child })
    const plain = { value: "safe" }
    Object.setPrototypeOf(plain, null)
    yield* entry.set(plain)
    expect(yield* entry.get()).toEqual(Option.some({ value: "safe" }))
    f.api.local.data[entry.storageKey] = { version: 1, payload: cyclic }
    expect(yield* Effect.flip(entry.get())).toMatchObject({ reason: "json" })
  }))

  it.effect("migrates every step asynchronously and writes only on explicit validated write-back", () => Effect.gen(function*() {
    const f = fixture()
    const started = yield* Deferred.make<void>()
    const proceed = yield* Deferred.make<void>()

    const entry = f.service.entry({
      ...options,
      version: 2,
      migrations: [
        { from: 0, run: (raw) => Effect.gen(function*() {
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(proceed)

          return yield* Schema.decodeUnknownEffect(Schema.String)(raw)
        }) },
        { from: 1, run: (raw) => Effect.map(Schema.decodeUnknownEffect(Schema.String)(raw), (value) => value.toUpperCase()) }
      ]
    })

    f.api.local.data[entry.storageKey] = { version: 0, payload: "dark" }
    const read = yield* Effect.forkScoped(entry.get({ writeBack: true }))
    yield* Deferred.await(started)
    expect(f.api.local.set).not.toHaveBeenCalled()
    yield* Deferred.succeed(proceed, undefined)
    expect(yield* Fiber.join(read)).toEqual(Option.some("DARK"))
    expect(f.api.local.set).toHaveBeenCalledOnce()
    expect(f.api.local.data[entry.storageKey]).toEqual({ version: 2, payload: "DARK" })
    f.api.local.data[entry.storageKey] = { version: 0, payload: "light" }
    expect(yield* entry.get()).toEqual(Option.some("LIGHT"))
    expect(f.api.local.set).toHaveBeenCalledOnce()
    expect(f.api.local.data[entry.storageKey]).toEqual({ version: 0, payload: "light" })
  }))

  it.effect("does not persist failed migrations, invalid final schemas, or future versions", () => Effect.gen(function*() {
    const f = fixture()
    const failure = new MigrationFailure({ message: "Migration unavailable" })
    const failing = f.service.entry({ ...options, migrations: [{ from: 0, run: () => Effect.fail(failure) }] })
    f.api.local.data[failing.storageKey] = { version: 0, payload: "old" }
    expect(yield* Effect.flip(failing.get({ writeBack: true }))).toBe(failure)
    const invalid = f.service.entry({ ...options, migrations: [{ from: 0, run: () => Effect.succeed(42) }] })
    expect(yield* Effect.flip(invalid.get({ writeBack: true }))).toBeInstanceOf(Schema.SchemaError)
    const incomplete = f.service.entry(options)
    expect(yield* Effect.flip(incomplete.get({ writeBack: true }))).toMatchObject({ reason: "migration" })
    f.api.local.data[failing.storageKey] = { version: 2, payload: "new" }
    expect(yield* Effect.flip(failing.get({ writeBack: true }))).toMatchObject({ reason: "futureVersion" })
    expect(f.api.local.set).not.toHaveBeenCalled()
  }))

  it.effect("validates versions and rejects malformed envelopes", () => Effect.gen(function*() {
    const f = fixture()

    for (const version of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(yield* Effect.flip(f.service.entry({ ...options, version }).get())).toMatchObject({ reason: "configuration" })
    }

    const duplicate = f.service.entry({ ...options, migrations: [
      { from: 0, run: Effect.succeed }, { from: 0, run: Effect.succeed }
    ] })

    expect(yield* Effect.flip(duplicate.get())).toMatchObject({ reason: "configuration" })
    const entry = f.service.entry(options)

    for (const raw of [null, "unwrapped", {}, { version: 1 }, { version: -1, payload: "dark" }, { version: 0.5, payload: "dark" }]) {
      f.api.local.data[entry.storageKey] = raw
      expect(yield* Effect.flip(entry.get())).toMatchObject({ reason: "envelope" })
    }
  }))

  it.effect("preserves Chrome write/read/remove failures and does not report a successful migration write", () => Effect.gen(function*() {
    const f = fixture()
    const cause = new Error("quota")
    const entry = f.service.entry({ ...options, migrations: [{ from: 0, run: Effect.succeed }] })
    f.api.local.set.mockRejectedValue(cause)
    expect(yield* Effect.flip(entry.set("dark"))).toMatchObject({ operation: "set", cause })
    f.api.local.data[entry.storageKey] = { version: 0, payload: "dark" }
    expect(yield* Effect.flip(entry.get({ writeBack: true }))).toMatchObject({ operation: "set", cause })
    expect(f.api.local.data[entry.storageKey]).toEqual({ version: 0, payload: "dark" })
    f.api.local.get.mockRejectedValue(cause)
    expect(yield* Effect.flip(entry.get())).toMatchObject({ operation: "get", cause })
    f.api.local.remove.mockRejectedValue(cause)
    expect(yield* Effect.flip(entry.remove)).toMatchObject({ operation: "remove", cause })
  }))

  it.effect("managed reads migrate in memory, but writes and write-back are prohibited", () => Effect.gen(function*() {
    const f = fixture()
    const entry = f.service.entry({ ...options, area: "managed", migrations: [{ from: 0, run: Effect.succeed }] })
    f.api.managed.data[entry.storageKey] = { version: 0, payload: "policy" }
    expect(yield* entry.get()).toEqual(Option.some("policy"))
    expect(yield* Effect.flip(entry.get({ writeBack: true }))).toMatchObject({ reason: "readOnly" })
    expect(yield* Effect.flip(entry.set("dark"))).toMatchObject({ reason: "readOnly" })
    expect(yield* Effect.flip(entry.remove)).toMatchObject({ reason: "readOnly" })
    expect(f.api.managed.set).not.toHaveBeenCalled()
  }))

  it.effect("preserves schema decode/encode service requirements and migration/default services", () => {
    class Suffix extends Context.Service<Suffix, { readonly suffix: string }>()("test/schema-storage/Suffix") {}

    const transformation = SchemaTransformation.transformEffect({
      decode: (value: string) => Effect.map(Suffix, ({ suffix }) => value + suffix),
      encode: (value: string) => Effect.map(Suffix, ({ suffix }) => value.slice(0, -suffix.length))
    })

    const schema = Schema.String.pipe(Schema.decodeTo(Schema.String, transformation))
    const f = fixture()

    const entry = f.service.entry({ ...options, schema,
      defaultValue: () => Effect.map(Suffix, ({ suffix }) => "default" + suffix),
      migrations: [{ from: 0, run: (raw) => Effect.as(Suffix, raw) }]
    })

    const get: Effect.Effect<Option.Option<string>, EntryError, Suffix> = entry.get()
    const set: Effect.Effect<void, EntryError, Suffix> = entry.set("dark!")

    return Effect.gen(function*() {
      expect(yield* get).toEqual(Option.some("default!"))
      yield* set
      expect(yield* get).toEqual(Option.some("dark!"))
      f.api.local.data[entry.storageKey] = { version: 0, payload: "old" }
      expect(yield* entry.get({ writeBack: true })).toEqual(Option.some("old!"))
    }).pipe(Effect.provideService(Suffix, { suffix: "!" }))
  })

  it.effect.each([false, true])("suppresses stale initial reads including stale errors=%s", (staleError) => Effect.gen(function*() {
    const f = fixture()
    const readStarted = gate()
    const release = gate()
    const entry = f.service.entry(options)
    f.api.local.get.mockImplementationOnce(async () => {
      expect(f.listeners.size).toBe(1)
      readStarted.open()
      await release.promise

      if (staleError) throw new Error("stale read failed")

      return { [entry.storageKey]: { version: 1, payload: "stale" } }
    })
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(entry.observe, 1)))
    yield* Effect.promise(() => readStarted.promise)
    f.emit(entry.storageKey, { newValue: { version: 1, payload: "newest" } })
    release.open()
    expect(yield* Fiber.join(fiber)).toEqual([Option.some("newest")])
    expect(f.listeners.size).toBe(0)
  }))

  it.effect("handles reentrant registration churn and isolates area and namespace events", () => Effect.gen(function*() {
    const f = fixture()
    const entry = f.service.entry(options)
    f.api.onChanged.addListener.mockImplementationOnce((listener) => {
      f.listeners.add(listener)
      f.emit(entry.storageKey, { newValue: { version: 1, payload: "wrong area" } }, "sync")
      f.emit(storageKey("other", "theme"), { newValue: { version: 1, payload: "wrong key" } })

      for (let index = 0; index < 1000; index++) {
        f.emit(entry.storageKey, { newValue: { version: 1, payload: String(index) } })
      }
    })
    expect(yield* Stream.runCollect(Stream.take(entry.observe, 1))).toEqual([Option.some("999")])
    expect(f.listeners.size).toBe(0)
    expect(f.api.local.set).not.toHaveBeenCalled()
  }))

  it.effect("decodes updates, defaults on deletion, and cleans up independent subscriptions", () => Effect.gen(function*() {
    const f = fixture()
    const entry = f.service.entry({ ...options, defaultValue: () => Effect.succeed("default") })
    const initial = yield* Deferred.make<void>()
    const updated = yield* Deferred.make<void>()
    const collected: Array<Option.Option<string>> = []

    const stream = Stream.tap(entry.observe, (value) => Effect.gen(function*() {
      collected.push(value)

      if (collected.length === 1) yield* Deferred.succeed(initial, undefined)

      if (collected.length === 2) yield* Deferred.succeed(updated, undefined)
    }))

    const fiber = yield* Effect.forkScoped(Stream.runDrain(Stream.take(stream, 3)))
    yield* Deferred.await(initial)
    f.emit(entry.storageKey, { newValue: { version: 1, payload: "dark" } })
    yield* Deferred.await(updated)
    f.emit(entry.storageKey, { oldValue: { version: 1, payload: "dark" } })
    yield* Fiber.join(fiber)
    expect(collected).toEqual([Option.some("default"), Option.some("dark"), Option.some("default")])
    expect(f.listeners.size).toBe(0)
    expect(f.api.local.set).not.toHaveBeenCalled()

    const ready = gate()
    f.api.onChanged.addListener.mockImplementation((listener) => {
      f.listeners.add(listener)

      if (f.listeners.size === 2) ready.open()
    })
    const first = yield* Effect.forkScoped(Stream.runDrain(entry.observe))
    const second = yield* Effect.forkScoped(Stream.runDrain(entry.observe))
    yield* Effect.promise(() => ready.promise)
    yield* Fiber.interrupt(first)
    expect(f.listeners.size).toBe(1)
    yield* Fiber.interrupt(second)
    expect(f.listeners.size).toBe(0)
  }))

  it.effect("terminates on current invalid events and cleans up after read and registration failures", () => Effect.gen(function*() {
    const f = fixture()
    const entry = f.service.entry(options)
    const initial = yield* Deferred.make<void>()
    const fiber = yield* Effect.forkScoped(Stream.runDrain(Stream.tap(entry.observe, () => Deferred.succeed(initial, undefined))).pipe(Effect.flip))
    yield* Deferred.await(initial)
    f.emit(entry.storageKey, { newValue: { version: 1, payload: 42 } })
    expect(yield* Fiber.join(fiber)).toBeInstanceOf(Schema.SchemaError)
    expect(f.listeners.size).toBe(0)
    f.api.local.get.mockRejectedValueOnce(new Error("read failed"))
    expect(yield* Effect.flip(Stream.runDrain(entry.observe))).toMatchObject({ operation: "get" })
    expect(f.listeners.size).toBe(0)
    f.api.onChanged.addListener.mockImplementationOnce(() => { throw new Error("register failed") })
    expect(yield* Effect.flip(Stream.runDrain(entry.observe))).toMatchObject({ operation: "onChanged" })
    expect(f.listeners.size).toBe(0)
  }))

  it.effect("observes migrations in memory and emits None for deletion without a default", () => Effect.gen(function*() {
    const f = fixture()
    const entry = f.service.entry({ ...options, migrations: [{ from: 0, run: Effect.succeed }] })
    f.api.local.data[entry.storageKey] = { version: 0, payload: "old" }
    const initial = yield* Deferred.make<void>()
    const values: Array<Option.Option<string>> = []

    const fiber = yield* Effect.forkScoped(Stream.runDrain(Stream.take(Stream.tap(entry.observe, (value) => Effect.gen(function*() {
      values.push(value)
      yield* Deferred.succeed(initial, undefined)
    })), 2)))

    yield* Deferred.await(initial)
    f.emit(entry.storageKey, { oldValue: { version: 0, payload: "old" } })
    yield* Fiber.join(fiber)
    expect(values).toEqual([Option.some("old"), Option.none()])
    expect(f.api.local.set).not.toHaveBeenCalled()
    expect(f.listeners.size).toBe(0)
  }))

  it.effect("reports a future-version event rather than replacing it with a default", () => Effect.gen(function*() {
    const f = fixture()
    const initial = yield* Deferred.make<void>()
    const defaultValue = vi.fn(() => Effect.succeed("default"))
    const entry = f.service.entry({ ...options, defaultValue })
    const fiber = yield* Effect.forkScoped(Stream.runDrain(Stream.tap(entry.observe, () => Deferred.succeed(initial, undefined))).pipe(Effect.flip))
    yield* Deferred.await(initial)
    f.emit(entry.storageKey, { newValue: { version: 2, payload: "future" } })
    expect(yield* Fiber.join(fiber)).toMatchObject({ reason: "futureVersion" })
    expect(defaultValue).toHaveBeenCalledOnce()
    expect(f.listeners.size).toBe(0)
  }))

  it.effect("drops superseded asynchronous decode failures and never writes observed migrations", () => Effect.gen(function*() {
    const f = fixture()
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()

    const entry = f.service.entry({ ...options, migrations: [{ from: 0, run: () => Effect.gen(function*() {
      yield* Deferred.succeed(started, undefined)
      yield* Deferred.await(release)

      return yield* new MigrationFailure({ message: "superseded migration failed" })
    }) }] })

    const initial = yield* Deferred.make<void>()
    const values: Array<Option.Option<string>> = []

    const fiber = yield* Effect.forkScoped(Stream.runDrain(Stream.take(Stream.tap(entry.observe, (value) => Effect.gen(function*() {
      values.push(value)
      yield* Deferred.succeed(initial, undefined)
    })), 2)))

    yield* Deferred.await(initial)
    f.emit(entry.storageKey, { newValue: { version: 0, payload: "old" } })
    yield* Deferred.await(started)
    f.emit(entry.storageKey, { newValue: { version: 1, payload: "new" } })
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(fiber)
    expect(values).toEqual([Option.none(), Option.some("new")])
    expect(f.api.local.set).not.toHaveBeenCalled()
    expect(f.listeners.size).toBe(0)
  }))
})

const modes = ["reject", "throw"] as const

/** A native call that rejects, or throws synchronously as Chrome does for invalid arguments. */
const failing = (mode: typeof modes[number], cause: Error) => mode === "reject"
  ? () => Promise.reject(cause)
  : () => { throw cause }

describe("ChromeSchemaStorage calls and errors", () => {
  it.effect.each(modes)("maps a Chrome %s in every storage call to ChromeStorageError with its area and operation", (mode) => Effect.gen(function*() {
    const f = fixture()
    const entry = f.service.entry({ ...options, area: "sync" })
    const getCause = new Error("get")
    f.api.sync.get.mockImplementationOnce(failing(mode, getCause))
    expect(yield* Effect.flip(entry.get())).toEqual(new ChromeStorageError({ area: "sync", operation: "get", cause: getCause }))
    const setCause = new Error("set")
    f.api.sync.set.mockImplementationOnce(failing(mode, setCause))
    expect(yield* Effect.flip(entry.set("dark"))).toEqual(new ChromeStorageError({ area: "sync", operation: "set", cause: setCause }))
    const removeCause = new Error("remove")
    f.api.sync.remove.mockImplementationOnce(failing(mode, removeCause))
    expect(yield* Effect.flip(entry.remove)).toEqual(new ChromeStorageError({ area: "sync", operation: "remove", cause: removeCause }))
    const observeCause = new Error("observe get")
    f.api.sync.get.mockImplementationOnce(failing(mode, observeCause))
    expect(yield* Effect.flip(Stream.runDrain(entry.observe))).toEqual(new ChromeStorageError({ area: "sync", operation: "get", cause: observeCause }))
    expect(f.listeners.size).toBe(0)
  }))

  it.effect.each(modes)("maps a write-back re-read or write %s to its Chrome operation and leaves the stored envelope", (mode) => Effect.gen(function*() {
    const f = fixture()
    const entry = f.service.entry({ ...options, migrations: [{ from: 0, run: Effect.succeed }] })
    f.api.local.data[entry.storageKey] = { version: 0, payload: "old" }
    const reread = new Error("re-read")
    f.api.local.get.mockImplementationOnce(async () => ({ ...f.api.local.data }))
    f.api.local.get.mockImplementationOnce(failing(mode, reread))
    expect(yield* Effect.flip(entry.get({ writeBack: true }))).toEqual(new ChromeStorageError({ area: "local", operation: "get", cause: reread }))
    const write = new Error("write")
    f.api.local.set.mockImplementationOnce(failing(mode, write))
    expect(yield* Effect.flip(entry.get({ writeBack: true }))).toEqual(new ChromeStorageError({ area: "local", operation: "set", cause: write }))
    expect(f.api.local.data[entry.storageKey]).toEqual({ version: 0, payload: "old" })
  }))

  it.effect("types a throwing listener registration as onChanged for its area and never reads", () => Effect.gen(function*() {
    const f = fixture()
    const cause = new Error("register")
    f.api.onChanged.addListener.mockImplementationOnce(() => { throw cause })
    expect(yield* Effect.flip(Stream.runDrain(f.service.entry({ ...options, area: "session" }).observe)))
      .toEqual(new ChromeStorageError({ area: "session", operation: "onChanged", cause }))
    expect(f.api.session.get).not.toHaveBeenCalled()
    expect(f.api.onChanged.removeListener).toHaveBeenCalledOnce()
  }))

  it.effect("names the entry member that failed in ChromeSchemaStorageError", () => Effect.gen(function*() {
    const f = fixture()
    const managed = f.service.entry({ ...options, area: "managed" })
    expect(yield* Effect.flip(managed.set("dark"))).toEqual(new ChromeSchemaStorageError({ operation: "set", key: managed.storageKey, reason: "readOnly", cause: "Managed storage is read-only" }))
    expect(yield* Effect.flip(managed.remove)).toMatchObject({ operation: "remove", reason: "readOnly" })
    expect(yield* Effect.flip(managed.get({ writeBack: true }))).toMatchObject({ operation: "get", reason: "readOnly" })
    const entry = f.service.entry({ ...options, schema: Schema.Unknown })
    f.api.local.data[entry.storageKey] = { version: 2, payload: "future" }
    expect(yield* Effect.flip(entry.get())).toMatchObject({ operation: "get", reason: "futureVersion" })
    expect(yield* Effect.flip(Stream.runDrain(entry.observe))).toMatchObject({ operation: "observe", reason: "futureVersion" })
    expect(yield* Effect.flip(entry.set(NaN))).toMatchObject({ operation: "set", reason: "json" })
    const unconfigured = f.service.entry({ ...options, version: -1 })
    expect(yield* Effect.flip(unconfigured.remove)).toMatchObject({ operation: "remove", reason: "configuration" })
    expect(yield* Effect.flip(unconfigured.set("dark"))).toMatchObject({ operation: "set", reason: "configuration" })
    expect(f.listeners.size).toBe(0)
  }))

  it.effect("rejects an unknown area as configuration before touching storage or registering", () => Effect.gen(function*() {
    const f = fixture()
    // SAFETY: deliberately bypasses AreaName to model an untyped JavaScript caller.
    const unknownArea = "changeEvent" as AreaName
    const entry = f.service.entry({ ...options, area: unknownArea })

    for (const effect of [entry.get(), entry.set("dark"), entry.remove, Stream.runDrain(entry.observe)]) {
      expect(yield* Effect.flip(effect)).toMatchObject({ reason: "configuration" })
    }

    expect(f.api.onChanged.addListener).not.toHaveBeenCalled()
  }))

  it.effect("fails observation configuration before registering a listener", () => Effect.gen(function*() {
    const f = fixture()
    const entry = f.service.entry({ ...options, migrations: [{ from: 1, run: Effect.succeed }] })
    expect(yield* Effect.flip(Stream.runDrain(entry.observe))).toMatchObject({ operation: "observe", reason: "configuration" })
    expect(f.api.onChanged.addListener).not.toHaveBeenCalled()
    expect(f.api.local.get).not.toHaveBeenCalled()
  }))

  it.effect("skips the initial read when a change arrives during registration", () => Effect.gen(function*() {
    const f = fixture()
    const entry = f.service.entry(options)
    f.api.onChanged.addListener.mockImplementationOnce((listener) => {
      f.listeners.add(listener)
      listener({ [entry.storageKey]: { newValue: { version: 1, payload: "during registration" } } }, "local")
    })
    expect(yield* Stream.runCollect(Stream.take(entry.observe, 1))).toEqual([Option.some("during registration")])
    expect(f.api.local.get).not.toHaveBeenCalled()
    expect(f.listeners.size).toBe(0)
  }))

  it.effect("passes only the physical key to every storage call", () => Effect.gen(function*() {
    const f = fixture()
    const entry = f.service.entry(options)
    yield* entry.set("dark")
    yield* entry.get()
    yield* entry.remove
    expect(f.api.local.set).toHaveBeenCalledExactlyOnceWith({ [entry.storageKey]: { version: 1, payload: "dark" } })
    expect(f.api.local.get).toHaveBeenCalledExactlyOnceWith(entry.storageKey)
    expect(f.api.local.remove).toHaveBeenCalledExactlyOnceWith(entry.storageKey)
  }))
})

describe("ChromeSchemaStorage write-back races", () => {
  /** A v0 → v1 migration that signals `started` and waits for `release`. */
  const blocked = (started: Deferred.Deferred<void>, release: Deferred.Deferred<void>) =>
    [{ from: 0, run: (payload: Schema.Json) => Effect.as(Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(release)), payload) }]

  it.effect("writes back when the stored envelope still equals the migrated snapshot", () => Effect.gen(function*() {
    const f = fixture()
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const schema = Schema.Struct({ nested: Schema.Array(Schema.String) })
    const entry = f.service.entry({ ...options, schema, migrations: blocked(started, release) })
    f.api.local.data[entry.storageKey] = { version: 0, payload: { nested: ["old"] } }
    const read = yield* Effect.forkScoped(entry.get({ writeBack: true }))
    yield* Deferred.await(started)
    // An identical envelope rewritten by another context is not a conflicting change.
    f.api.local.data[entry.storageKey] = { version: 0, payload: { nested: ["old"] } }
    yield* Deferred.succeed(release, undefined)
    expect(yield* Fiber.join(read)).toEqual(Option.some({ nested: ["old"] }))
    expect(f.api.local.data[entry.storageKey]).toEqual({ version: 1, payload: { nested: ["old"] } })
    expect(f.api.local.set).toHaveBeenCalledOnce()
  }))

  it.effect("does not resurrect an entry removed while its migration ran", () => Effect.gen(function*() {
    const f = fixture()
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const entry = f.service.entry({ ...options, migrations: blocked(started, release) })
    f.api.local.data[entry.storageKey] = { version: 0, payload: "old" }
    const read = yield* Effect.forkScoped(entry.get({ writeBack: true }))
    yield* Deferred.await(started)
    yield* entry.remove
    yield* Deferred.succeed(release, undefined)
    expect(yield* Fiber.join(read)).toEqual(Option.some("old"))
    expect(Object.hasOwn(f.api.local.data, entry.storageKey)).toBe(false)
    expect(f.api.local.set).not.toHaveBeenCalled()
  }))

  it.effect.each([
    { version: 0, payload: "other old" },
    { version: 1, payload: "current" },
    { version: 5, payload: "future" },
    "corrupted",
    { version: 0, payload: NaN }
  ])("leaves a concurrently replaced envelope %# in place", (replacement) => Effect.gen(function*() {
    const f = fixture()
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const entry = f.service.entry({ ...options, migrations: blocked(started, release) })
    f.api.local.data[entry.storageKey] = { version: 0, payload: "old" }
    const read = yield* Effect.forkScoped(entry.get({ writeBack: true }))
    yield* Deferred.await(started)
    f.api.local.data[entry.storageKey] = replacement
    yield* Deferred.succeed(release, undefined)
    expect(yield* Fiber.join(read)).toEqual(Option.some("old"))
    expect(f.api.local.data[entry.storageKey]).toBe(replacement)
    expect(f.api.local.set).not.toHaveBeenCalled()
  }))

  it.effect("interrupting write-back during its re-read writes nothing", () => Effect.gen(function*() {
    const f = fixture()
    const entry = f.service.entry({ ...options, migrations: [{ from: 0, run: Effect.succeed }] })
    f.api.local.data[entry.storageKey] = { version: 0, payload: "old" }
    const reading = gate()
    const reread = gate()
    f.api.local.get.mockImplementationOnce(async () => ({ ...f.api.local.data }))
    f.api.local.get.mockImplementationOnce(async () => {
      reading.open()
      await reread.promise

      return { ...f.api.local.data }
    })
    const read = yield* Effect.forkScoped(entry.get({ writeBack: true }))
    yield* Effect.promise(() => reading.promise)
    yield* Fiber.interrupt(read)
    reread.open()
    expect(f.api.local.set).not.toHaveBeenCalled()
    expect(f.api.local.data[entry.storageKey]).toEqual({ version: 0, payload: "old" })
  }))
})

describe("ChromeSchemaStorage layerLive", () => {
  it.effect("fails with initialize without chrome.storage and builds over a fake global", () => Effect.gen(function*() {
    const missing = yield* Effect.flip(ChromeSchemaStorage.pipe(Effect.provide(layerLive)))
    expect(missing).toBeInstanceOf(ChromeStorageError)
    expect(missing).toMatchObject({ operation: "initialize", area: "all" })
    vi.stubGlobal("chrome", {})
    expect(yield* Effect.flip(ChromeSchemaStorage.pipe(Effect.provide(layerLive)))).toMatchObject({ operation: "initialize" })
    const f = fixture()
    vi.stubGlobal("chrome", { storage: f.api })

    const value = yield* Effect.gen(function*() {
      const entry = (yield* ChromeSchemaStorage).entry(options)
      yield* entry.set("live")

      return yield* entry.get()
    }).pipe(Effect.provide(layerLive))

    expect(value).toEqual(Option.some("live"))
    expect(f.api.local.data[storageKey("settings", "theme")]).toEqual({ version: 1, payload: "live" })
  }))

  it("constructs ChromeSchemaStorageError with operation, key, reason and cause", () => {
    const error = new ChromeSchemaStorageError({ operation: "get", key: "k", reason: "json", cause: "c" })
    expect(error._tag).toBe("ChromeSchemaStorageError")
    expect(error).toMatchObject({ operation: "get", key: "k", reason: "json", cause: "c" })
  })
})
