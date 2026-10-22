// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Exit, Fiber, Schema, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeMessageError, fail, succeed } from "../src/ChromeMessage.js"
import { ChromeRuntime, ChromeRuntimeError, layer, layerLive, make } from "../src/ChromeRuntime.js"
import type { ChromeRuntimeApi, ChromeRuntimeService, JsonValue, MessageListenerArguments } from "../src/ChromeRuntime.js"
import { makePortPair } from "../src/testing/Port.js"
import { gatedEvent } from "./stress/support.js"

/** A gated Chrome-like event whose next registrations can be made to throw, before or after adding. */
const event = <A extends ReadonlyArray<unknown>>() => {
  const base = gatedEvent<A>()
  const failures: Array<{ readonly cause: Error; readonly afterAdding: boolean }> = []

  return {
    ...base,
    addListener: (listener: (...args: A) => void) => {
      const failure = failures.shift()

      if (failure !== undefined && !failure.afterAdding) throw failure.cause
      base.addListener(listener)

      if (failure !== undefined) throw failure.cause
    },
    failNext: (cause: Error, afterAdding: boolean) => { failures.push({ cause, afterAdding }) }
  }
}

/** What the shared stream tests observe of any fake event. */
interface Probe {
  readonly listeners: ReadonlySet<unknown>
  readonly added: ReadonlyArray<unknown>
  readonly removed: ReadonlyArray<unknown>
  readonly registered: (size: number) => Effect.Effect<void>
  readonly failNext: (cause: Error, afterAdding: boolean) => void
}

const context: chrome.runtime.ExtensionContext = {
  contextId: "worker", contextType: "BACKGROUND", frameId: -1, incognito: false, tabId: -1, windowId: -1
}

const manifest: chrome.runtime.Manifest = { manifest_version: 3, name: "Test", version: "1.0.0" }

// SAFETY: a DirectoryEntry is an opaque legacy FileSystem handle the module only passes through.
const directory = { name: "", isDirectory: true } as DirectoryEntry

const fake = () => ({
  id: "extension-id",
  getManifest: vi.fn(() => manifest),
  getURL: vi.fn((path: string) => `chrome-extension://extension-id/${path}`),
  getVersion: vi.fn(() => "1.0.0"),
  sendMessage: vi.fn<ChromeRuntimeApi["sendMessage"]>(async () => ({ ok: true })),
  sendNativeMessage: vi.fn<ChromeRuntimeApi["sendNativeMessage"]>(async () => ({ native: true })),
  getContexts: vi.fn<ChromeRuntimeApi["getContexts"]>(async () => [context]),
  getPackageDirectoryEntry: vi.fn(async () => directory),
  openOptionsPage: vi.fn<ChromeRuntimeApi["openOptionsPage"]>(async () => undefined),
  reload: vi.fn<ChromeRuntimeApi["reload"]>(() => undefined),
  restart: vi.fn<ChromeRuntimeApi["restart"]>(() => undefined),
  restartAfterDelay: vi.fn<ChromeRuntimeApi["restartAfterDelay"]>(async () => undefined),
  setUninstallURL: vi.fn<ChromeRuntimeApi["setUninstallURL"]>(async () => undefined),
  getPlatformInfo: vi.fn<ChromeRuntimeApi["getPlatformInfo"]>(async () => ({ os: "mac", arch: "arm64" })),
  requestUpdateCheck: vi.fn<ChromeRuntimeApi["requestUpdateCheck"]>(async () => ({ status: "update_available", version: "2.0.0" })),
  onInstalled: event<[chrome.runtime.InstalledDetails]>(),
  onStartup: event<[]>(),
  onUpdateAvailable: event<[chrome.runtime.UpdateAvailableDetails]>(),
  onSuspend: event<[]>(),
  onSuspendCanceled: event<[]>(),
  onRestartRequired: event<[`${chrome.runtime.OnRestartRequiredReason}`]>(),
  onEnabled: event<[]>(),
  onMessage: event<MessageListenerArguments>(),
  onMessageExternal: event<MessageListenerArguments>(),
  onUserScriptMessage: event<MessageListenerArguments>(),
  onConnect: event<[chrome.runtime.Port]>(),
  onConnectExternal: event<[chrome.runtime.Port]>(),
  onConnectNative: event<[chrome.runtime.Port]>(),
  onUserScriptConnect: event<[chrome.runtime.Port]>()
})

type Fake = ReturnType<typeof fake>

interface Fired {
  readonly expected: unknown
}

interface StreamCase {
  readonly operation: string
  readonly source: Probe
  readonly stream: Stream.Stream<unknown, ChromeRuntimeError>
  /** Fires the event once, returning what the stream must emit for it. */
  readonly fire: () => Fired
}

const sender: chrome.runtime.MessageSender = { id: "peer-extension", origin: "chrome-extension://peer-extension" }

const streamCases = (api: Fake, service: ChromeRuntimeService): ReadonlyArray<StreamCase> => {
  const port = makePortPair("runtime").left.port
  const respond = vi.fn()

  const message = (source: Fake["onMessage"]) => () => {
    source.emit({ ping: 1 }, sender, respond)

    return { expected: { message: { ping: 1 }, sender } }
  }

  const connection = (source: Fake["onConnect"]) => () => {
    source.emit(port)

    return { expected: port }
  }

  const signal = (source: Fake["onStartup"]) => () => {
    source.emit()

    return { expected: undefined }
  }

  return [
    { operation: "onInstalled", source: api.onInstalled, stream: service.onInstalled, fire: () => {
      api.onInstalled.emit({ reason: "update", previousVersion: "0.9.0" })

      return { expected: { reason: "update", previousVersion: "0.9.0" } }
    } },
    { operation: "onStartup", source: api.onStartup, stream: service.onStartup, fire: signal(api.onStartup) },
    { operation: "onUpdateAvailable", source: api.onUpdateAvailable, stream: service.onUpdateAvailable, fire: () => {
      api.onUpdateAvailable.emit({ version: "2.0.0" })

      return { expected: { version: "2.0.0" } }
    } },
    { operation: "onSuspend", source: api.onSuspend, stream: service.onSuspend, fire: signal(api.onSuspend) },
    { operation: "onSuspendCanceled", source: api.onSuspendCanceled, stream: service.onSuspendCanceled, fire: signal(api.onSuspendCanceled) },
    { operation: "onRestartRequired", source: api.onRestartRequired, stream: service.onRestartRequired, fire: () => {
      api.onRestartRequired.emit("os_update")

      return { expected: "os_update" }
    } },
    { operation: "onEnabled", source: api.onEnabled, stream: service.onEnabled, fire: signal(api.onEnabled) },
    { operation: "onMessage", source: api.onMessage, stream: service.onMessage, fire: message(api.onMessage) },
    { operation: "onMessageExternal", source: api.onMessageExternal, stream: service.onMessageExternal, fire: message(api.onMessageExternal) },
    { operation: "onUserScriptMessage", source: api.onUserScriptMessage, stream: service.onUserScriptMessage, fire: message(api.onUserScriptMessage) },
    { operation: "onConnect", source: api.onConnect, stream: service.onConnect, fire: connection(api.onConnect) },
    { operation: "onConnectExternal", source: api.onConnectExternal, stream: service.onConnectExternal, fire: connection(api.onConnectExternal) },
    { operation: "onConnectNative", source: api.onConnectNative, stream: service.onConnectNative, fire: connection(api.onConnectNative) },
    { operation: "onUserScriptConnect", source: api.onUserScriptConnect, stream: service.onUserScriptConnect, fire: connection(api.onUserScriptConnect) }
  ]
}

/** The mock surface used to make one Chrome call fail. */
interface Failable {
  readonly mock: { readonly calls: ReadonlyArray<unknown>; readonly contexts: ReadonlyArray<unknown> }
  mockRejectedValueOnce(value: Error): void
  mockImplementationOnce(implementation: () => never): void
}

interface CallCase {
  readonly operation: string
  readonly mock: Failable
  readonly effect: Effect.Effect<void, ChromeRuntimeError>
}

const promiseCalls = (api: Fake, service: ChromeRuntimeService): ReadonlyArray<CallCase> => [
  { operation: "sendMessage", mock: api.sendMessage, effect: Effect.asVoid(service.sendMessage("message")) },
  { operation: "sendNativeMessage", mock: api.sendNativeMessage, effect: Effect.asVoid(service.sendNativeMessage("com.example.host", { ping: 1 })) },
  { operation: "getContexts", mock: api.getContexts, effect: Effect.asVoid(service.getContexts({})) },
  { operation: "getPackageDirectoryEntry", mock: api.getPackageDirectoryEntry, effect: Effect.asVoid(service.getPackageDirectoryEntry) },
  { operation: "openOptionsPage", mock: api.openOptionsPage, effect: Effect.asVoid(service.openOptionsPage) },
  { operation: "restartAfterDelay", mock: api.restartAfterDelay, effect: Effect.asVoid(service.restartAfterDelay(30)) },
  { operation: "setUninstallURL", mock: api.setUninstallURL, effect: Effect.asVoid(service.setUninstallURL("https://example.com/bye")) },
  { operation: "getPlatformInfo", mock: api.getPlatformInfo, effect: Effect.asVoid(service.getPlatformInfo) },
  { operation: "requestUpdateCheck", mock: api.requestUpdateCheck, effect: Effect.asVoid(service.requestUpdateCheck) }
]

const syncCalls = (api: Fake, service: ChromeRuntimeService): ReadonlyArray<CallCase> => [
  { operation: "getManifest", mock: api.getManifest, effect: Effect.asVoid(service.getManifest) },
  { operation: "getURL", mock: api.getURL, effect: Effect.asVoid(service.getURL("page.html")) },
  { operation: "getVersion", mock: api.getVersion, effect: Effect.asVoid(service.getVersion) },
  { operation: "reload", mock: api.reload, effect: Effect.asVoid(service.reload) },
  { operation: "restart", mock: api.restart, effect: Effect.asVoid(service.restart) }
]

const expectFailure = (error: ChromeRuntimeError, operation: string, cause: unknown) => {
  expect(error).toBeInstanceOf(ChromeRuntimeError)
  expect(error.operation).toBe(operation)
  expect(error.cause).toBe(cause)
}

const resolve = Effect.service(ChromeRuntime)

describe("ChromeRuntime", () => {
  describe("calls", () => {
    it.effect("run lazily, pass arguments through and keep the API receiver", () => Effect.gen(function*() {
      const api = fake()
      const service = make(api)
      const calls = [...promiseCalls(api, service), ...syncCalls(api, service)]

      for (const { mock } of calls) expect(mock.mock.calls).toHaveLength(0)

      expect(yield* service.id).toBe("extension-id")
      expect(yield* service.getManifest).toBe(manifest)
      expect(yield* service.getURL("page.html")).toBe("chrome-extension://extension-id/page.html")
      expect(yield* service.getVersion).toBe("1.0.0")
      expect(yield* service.sendNativeMessage("com.example.host", { ping: 1, nested: [true, null] })).toEqual({ native: true })
      expect(api.sendNativeMessage).toHaveBeenCalledExactlyOnceWith("com.example.host", { ping: 1, nested: [true, null] })
      const filter: chrome.runtime.ContextFilter = { contextTypes: ["BACKGROUND"], tabIds: [-1] }
      expect(yield* service.getContexts(filter)).toEqual([context])
      expect(api.getContexts).toHaveBeenCalledExactlyOnceWith(filter)
      expect(yield* service.getPackageDirectoryEntry).toBe(directory)
      yield* service.openOptionsPage
      yield* service.reload
      yield* service.restart
      yield* service.restartAfterDelay(-1)
      expect(api.restartAfterDelay).toHaveBeenCalledExactlyOnceWith(-1)
      yield* service.setUninstallURL("")
      expect(api.setUninstallURL).toHaveBeenCalledExactlyOnceWith("")
      expect(yield* service.getPlatformInfo).toEqual({ os: "mac", arch: "arm64" })
      expect(yield* service.requestUpdateCheck).toEqual({ status: "update_available", version: "2.0.0" })
      expect(yield* service.sendMessage("hello")).toEqual({ ok: true })

      for (const { operation, mock } of calls) {
        expect(mock.mock.calls, operation).toHaveLength(1)
        expect(mock.mock.contexts[0], operation).toBe(api)
      }

      // Effect values re-run the native call each time they run.
      yield* service.openOptionsPage
      expect(api.openOptionsPage).toHaveBeenCalledTimes(2)
    }))

    it.effect("map every Promise call's rejection and synchronous throw to its operation", () => Effect.gen(function*() {
      const api = fake()

      for (const { operation, mock, effect } of promiseCalls(api, make(api))) {
        const rejected = new Error(`${operation} rejected`)
        mock.mockRejectedValueOnce(rejected)
        expectFailure(yield* Effect.flip(effect), operation, rejected)

        const thrown = new Error(`${operation} threw`)
        mock.mockImplementationOnce(() => { throw thrown })
        expectFailure(yield* Effect.flip(effect), operation, thrown)
      }
    }))

    it.effect("map every synchronous call's throw to its operation", () => Effect.gen(function*() {
      const api = fake()

      for (const { operation, mock, effect } of syncCalls(api, make(api))) {
        const thrown = new Error(`${operation} threw`)
        mock.mockImplementationOnce(() => { throw thrown })
        expectFailure(yield* Effect.flip(effect), operation, thrown)
      }

      const thrown = new Error("Extension context invalidated.")
      Object.defineProperty(api, "id", { get: () => { throw thrown } })
      expectFailure(yield* Effect.flip(make(api).id), "id", thrown)
    }))

    it.effect("fails id with the typed error once Chrome invalidates the context", () => Effect.gen(function*() {
      const { id: _id, ...rest } = fake()
      const error = yield* Effect.flip(make({ ...rest, id: undefined }).id)
      expect(error).toBeInstanceOf(ChromeRuntimeError)
      expect(error.operation).toBe("id")
      expect(String(error.cause)).toContain("chrome.runtime.id is unavailable")
    }))

    it.effect("fails version- and context-gated calls with the typed error when Chrome lacks them", () => Effect.gen(function*() {
      const { getVersion: _version, getPackageDirectoryEntry: _entry, ...rest } = fake()
      const service = make(rest)

      for (const [operation, effect] of [
        ["getVersion", Effect.asVoid(service.getVersion)],
        ["getPackageDirectoryEntry", Effect.asVoid(service.getPackageDirectoryEntry)]
      ] as const) {
        const error = yield* Effect.flip(effect)
        expect(error).toBeInstanceOf(ChromeRuntimeError)
        expect(error.operation).toBe(operation)
        expect(String(error.cause)).toContain(`chrome.runtime.${operation} is unavailable`)
      }
    }))
  })

  it.effect("fails with the typed error, not a hang or defect, when an older Chrome returns no Promise", () => Effect.gen(function*() {
    const api = fake()

    // A callback-only Chrome method called without a callback returns undefined, which the
    // Promise-typed Api cannot express.
    for (const member of ["getPackageDirectoryEntry", "getContexts"]) Object.defineProperty(api, member, { value: () => undefined })

    const service = make(api)

    for (const [operation, effect] of [
      ["getPackageDirectoryEntry", Effect.asVoid(service.getPackageDirectoryEntry)],
      ["getContexts", Effect.asVoid(service.getContexts({}))]
    ] as const) {
      const exit = yield* Effect.exit(effect)
      expect(Exit.hasDies(exit), operation).toBe(false)
      expect((yield* Effect.flip(effect)).operation).toBe(operation)
    }
  }))

  describe("sendMessage", () => {
    it.effect("passes the extension id and options only when given, never in an ambiguous two-argument form", () => Effect.gen(function*() {
      const api = fake()
      const service = make(api)
      const options: chrome.runtime.MessageOptions = { includeTlsChannelId: true }

      yield* service.sendMessage("hello")
      expect(api.sendMessage).toHaveBeenLastCalledWith("hello")
      expect(api.sendMessage.mock.lastCall).toHaveLength(1)

      yield* service.sendMessage({ ping: 1 }, { extensionId: "other-extension" })
      expect(api.sendMessage.mock.lastCall).toEqual(["other-extension", { ping: 1 }])

      // Two arguments would bind a string message to the extension id, so the id is explicit.
      yield* service.sendMessage("hello", { options })
      expect(api.sendMessage.mock.lastCall).toEqual([undefined, "hello", options])

      yield* service.sendMessage({ ping: 2 }, { extensionId: "other-extension", options })
      expect(api.sendMessage.mock.lastCall).toEqual(["other-extension", { ping: 2 }, options])

      yield* service.sendMessage(null, {})
      expect(api.sendMessage.mock.lastCall).toEqual([null])
      expect(api.sendMessage.mock.contexts.every((receiver) => receiver === api)).toBe(true)
    }))

    it.effect("never lets Chrome take a function message for its response callback and misroute the extension id", () => Effect.gen(function*() {
      const delivered: Array<{ readonly target: unknown; readonly message: unknown }> = []

      // Chrome's argument massaging (messaging_util.cc MassageSendMessageArguments): a
      // trailing function is the response callback, which switches the call to callback
      // mode (no Promise), and the remaining arguments are re-read by count.
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- emulates Chrome's untyped native argument parsing
      const sendMessage = (...args: Array<unknown>): Promise<string> | undefined => {
        const rest = [...args]
        const callback = rest.at(-1) instanceof Function ? rest.pop() : undefined
        const [first, second] = rest

        if (rest.length === 0) throw new TypeError("No matching signature.")

        const idFirst = rest.length === 3 || (rest.length === 2 && Schema.is(Schema.NullishOr(Schema.String))(first))
        delivered.push(idFirst ? { target: first, message: second } : { target: null, message: first })

        return callback === undefined ? Promise.resolve("reply") : undefined
      }

      const api = fake()
      // The native method's callback mode returns no Promise, which the Promise-typed Api cannot express.
      Object.defineProperty(api, "sendMessage", { value: sendMessage })
      const service = make(api)
      const handler = () => "not a message"

      for (const options of [undefined, { extensionId: "peer" }, { options: {} }, { extensionId: "peer", options: {} }]) {
        const error = yield* Effect.flip(Effect.asVoid(service.sendMessage(handler, options)))
        expect(error).toBeInstanceOf(ChromeRuntimeError)
        expect(error.operation).toBe("sendMessage")
      }

      expect(delivered).toEqual([])
      expect(yield* service.sendMessage("hello", { extensionId: "peer" })).toBe("reply")
      expect(delivered).toEqual([{ target: "peer", message: "hello" }])
    }))

    it.effect("returns the unvalidated reply, including no reply", () => Effect.gen(function*() {
      const api = fake()
      api.sendMessage.mockResolvedValueOnce(undefined)
      expect(yield* make(api).sendMessage("hello")).toBeUndefined()
    }))

    it.effect("sendMessageSchema encodes before sending and decodes the reply", () => Effect.gen(function*() {
      const api = fake()
      const service = make(api)
      const request = Schema.Struct({ ping: Schema.FiniteFromString })
      const response = Schema.Struct({ pong: Schema.FiniteFromString })

      for (let index = 0; index < 64; index++) {
        api.sendMessage.mockResolvedValueOnce({ pong: String(index + 1) })
        expect(yield* service.sendMessageSchema(request, response, { ping: index }, { extensionId: "peer" })).toEqual({ pong: index + 1 })
        expect(api.sendMessage.mock.lastCall).toEqual(["peer", { ping: String(index) }])
      }

      api.sendMessage.mockResolvedValueOnce({ pong: "not numeric" })
      const decodeFailure = yield* Effect.flip(service.sendMessageSchema(request, response, { ping: 0 }))
      expect(decodeFailure.operation).toBe("sendMessage.decodeResponse")
      expect(decodeFailure.cause).toBeInstanceOf(Schema.SchemaError)

      api.sendMessage.mockClear()
      const finite = Schema.Struct({ ping: Schema.Finite })
      const encodeFailure = yield* Effect.flip(service.sendMessageSchema(finite, response, { ping: Number.NaN }))
      expect(encodeFailure.operation).toBe("sendMessage.encodeRequest")
      expect(encodeFailure.cause).toBeInstanceOf(Schema.SchemaError)
      expect(api.sendMessage).not.toHaveBeenCalled()

      const cause = new Error("Could not establish connection. Receiving end does not exist.")
      api.sendMessage.mockRejectedValueOnce(cause)
      expectFailure(yield* Effect.flip(service.sendMessageSchema(request, response, { ping: 1 })), "sendMessage", cause)
      api.sendMessage.mockImplementationOnce(() => { throw cause })
      expectFailure(yield* Effect.flip(service.sendMessageSchema(request, response, { ping: 1 })), "sendMessage", cause)
    }))

    it.effect("request encodes the message and unwraps the reply envelope", () => Effect.gen(function*() {
      const api = fake()
      const service = make(api)
      const request = Schema.Struct({ ping: Schema.FiniteFromString })
      const value = Schema.Struct({ pong: Schema.FiniteFromString })

      api.sendMessage.mockResolvedValueOnce(succeed({ pong: "2" }))
      expect(yield* service.request(request, value, { ping: 1 })).toEqual({ pong: 2 })
      expect(api.sendMessage.mock.lastCall).toEqual([{ ping: "1" }])

      api.sendMessage.mockResolvedValueOnce(fail({ code: "Overflow", message: "Startup queue is full" }))
      const failure = yield* Effect.flip(service.request(request, value, { ping: 1 }))
      expect(failure).toBeInstanceOf(ChromeMessageError)
      expect(failure).toMatchObject({ code: "Overflow", message: "Startup queue is full" })

      for (const reply of [{ pong: "2" }, succeed({ pong: "x" }), undefined]) {
        api.sendMessage.mockResolvedValueOnce(reply)
        const invalid = yield* Effect.flip(service.request(request, value, { ping: 1 }))
        expect(invalid).toBeInstanceOf(ChromeRuntimeError)
        expect(invalid).toMatchObject({ operation: "sendMessage.decodeResponse" })
      }

      const cause = new Error("disconnected")
      api.sendMessage.mockRejectedValueOnce(cause)
      expect(yield* Effect.flip(service.request(request, value, { ping: 1 }))).toMatchObject({ operation: "sendMessage", cause })
    }))

    it.effect("request decodes a void reply after Chrome's JSON serialization drops its undefined value", () => Effect.gen(function*() {
      const api = fake()
      const service = make(api)
      // Chrome serializes replies as JSON, so `{ ok: true, value: undefined }` arrives as `{ ok: true }`.
      const viaChrome = <A>(reply: A): JsonValue => JSON.parse(JSON.stringify(reply))

      for (const value of [Schema.Void, Schema.Undefined, Schema.UndefinedOr(Schema.String), Schema.Unknown] as const) {
        api.sendMessage.mockResolvedValueOnce(viaChrome(succeed(undefined)))
        expect(yield* service.request(Schema.String, value, "ping")).toBeUndefined()
      }

      // A value schema that does not accept undefined still rejects the empty envelope.
      api.sendMessage.mockResolvedValueOnce(viaChrome(succeed(undefined)))
      expect(yield* Effect.flip(service.request(Schema.String, Schema.String, "ping")))
        .toMatchObject({ operation: "sendMessage.decodeResponse" })

      // Failure envelopes and non-envelopes are not mistaken for a void success.
      for (const reply of [{ ok: false }, {}, [], "ok", null, { ok: "true" }]) {
        api.sendMessage.mockResolvedValueOnce(reply)
        expect(yield* Effect.flip(service.request(Schema.String, Schema.Void, "ping")), JSON.stringify(reply))
          .toMatchObject({ operation: "sendMessage.decodeResponse" })
      }

      api.sendMessage.mockResolvedValueOnce(viaChrome(fail({ code: "HandlerFailed", message: "boom" })))
      expect(yield* Effect.flip(service.request(Schema.String, Schema.Void, "ping"))).toBeInstanceOf(ChromeMessageError)
    }))
  })

  describe("events", () => {
    it.effect("register nothing until consumed", () => Effect.sync(() => {
      const api = fake()
      const service = make(api)

      for (const { source } of streamCases(api, service)) expect(source.added).toHaveLength(0)
    }))

    it.effect("deliver each event and remove the listener when consumption ends", () => Effect.gen(function*() {
      const api = fake()

      for (const { operation, source, stream, fire } of streamCases(api, make(api))) {
        const consumer = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 2)))
        yield* source.registered(1)
        const first = fire().expected
        const second = fire().expected
        expect(yield* Fiber.join(consumer), operation).toEqual([first, second])
        expect(source.listeners.size, operation).toBe(0)
        expect(source.removed, operation).toEqual(source.added)
        expect(source.added, operation).toHaveLength(1)
      }
    }))

    it.effect("remove the listener when the consumer is interrupted", () => Effect.gen(function*() {
      const api = fake()

      for (const { operation, source, stream, fire } of streamCases(api, make(api))) {
        const consumer = yield* Effect.forkScoped(Stream.runDrain(stream))
        yield* source.registered(1)
        fire()
        yield* Fiber.interrupt(consumer)
        expect(Exit.hasInterrupts(yield* Fiber.await(consumer)), operation).toBe(true)
        expect(source.listeners.size, operation).toBe(0)
        expect(source.removed, operation).toEqual(source.added)
      }
    }))

    it.effect("type registration failures and roll back partial registrations", () => Effect.gen(function*() {
      const api = fake()

      for (const { operation, source, stream } of streamCases(api, make(api))) {
        for (const afterAdding of [false, true]) {
          const cause = new Error(`${operation} registration failed`)
          source.failNext(cause, afterAdding)
          expectFailure(yield* Effect.flip(Stream.runDrain(stream)), operation, cause)
          expect(source.listeners.size, operation).toBe(0)
        }

        expect(source.added, operation).toHaveLength(1)
        expect(source.removed, operation).toHaveLength(2)
      }
    }))

    it.effect("fail with the typed error, not a defect, when the context lacks an event", () => Effect.gen(function*() {
      const {
        onEnabled: _enabled, onUserScriptMessage: _message, onConnectNative: _native, onUserScriptConnect: _connect, ...rest
      } = fake()

      const service = make(rest)

      for (const [operation, drain] of [
        ["onEnabled", Stream.runDrain(service.onEnabled)],
        ["onUserScriptMessage", Stream.runDrain(service.onUserScriptMessage)],
        ["onConnectNative", Stream.runDrain(service.onConnectNative)],
        ["onUserScriptConnect", Stream.runDrain(service.onUserScriptConnect)]
      ] as const) {
        const exit = yield* Effect.exit(drain)
        expect(Exit.isFailure(exit) && !Exit.hasDies(exit), operation).toBe(true)
        const error = yield* Effect.flip(drain)
        expect(error.operation).toBe(operation)
        expect(String(error.cause)).toContain(`chrome.runtime.${operation} is unavailable`)
      }
    }))

    it.effect("message listeners never claim the response channel", () => Effect.gen(function*() {
      const api = fake()
      const service = make(api)
      const respond = vi.fn()

      for (const [source, stream] of [
        [api.onMessage, service.onMessage],
        [api.onMessageExternal, service.onMessageExternal],
        [api.onUserScriptMessage, service.onUserScriptMessage]
      ] as const) {
        const consumer = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 1)))
        yield* source.registered(1)
        const [listener] = source.listeners
        expect(listener?.("message", sender, respond)).toBeUndefined()
        expect(yield* Fiber.join(consumer)).toEqual([{ message: "message", sender }])
      }

      expect(respond).not.toHaveBeenCalled()
    }))

    it.effect("gives concurrent subscribers independent 64-event buffers", () => Effect.gen(function*() {
      const api = fake()
      const service = make(api)

      const consumers = yield* Effect.forEach(Array.from({ length: 16 }), () =>
        Effect.forkScoped(Stream.runCollect(Stream.take(service.onInstalled, 64))))

      yield* api.onInstalled.registered(16)

      for (let index = 0; index < 100; index++) api.onInstalled.emit({ reason: "update", previousVersion: String(index) })

      for (const values of yield* Effect.forEach(consumers, Fiber.join)) {
        expect(values.map((details) => details.previousVersion)).toEqual(Array.from({ length: 64 }, (_, index) => String(36 + index)))
      }

      expect(api.onInstalled.listeners.size).toBe(0)
      expect(api.onInstalled.removed).toHaveLength(16)
    }))
  })

  describe("layers", () => {
    it.effect("imports safely without chrome and fails layerLive with initialize", () => Effect.gen(function*() {
      vi.stubGlobal("chrome", undefined)
      const imported = yield* Effect.promise(() => import("../src/ChromeRuntime.js"))
      expect(imported.layerLive).toBe(layerLive)

      const missing = yield* Effect.flip(Effect.provide(resolve, layerLive))
      expect(missing).toBeInstanceOf(ChromeRuntimeError)
      expect(missing.operation).toBe("initialize")

      vi.stubGlobal("chrome", {})
      expect((yield* Effect.flip(Effect.provide(resolve, layerLive))).operation).toBe("initialize")
    }))

    it.effect("builds layerLive from a fake global, reading it only when built", () => Effect.gen(function*() {
      const api = fake()
      vi.stubGlobal("chrome", { runtime: api })

      const program = Effect.gen(function*() {
        const service = yield* ChromeRuntime

        return [yield* service.id, yield* service.getVersion] as const
      })

      expect(yield* Effect.provide(program, layerLive)).toEqual(["extension-id", "1.0.0"])
    }))

    it.effect("fails with typed errors in a content-script runtime that lacks most members", () => Effect.gen(function*() {
      const api = fake()
      vi.stubGlobal("chrome", {
        runtime: {
          id: api.id, getManifest: api.getManifest, getURL: api.getURL, sendMessage: api.sendMessage,
          onMessage: api.onMessage, onConnect: api.onConnect
        }
      })
      const service = yield* Effect.provide(resolve, layerLive)
      expect(yield* service.sendMessage("hello")).toEqual({ ok: true })

      for (const [operation, effect] of [
        ["getContexts", Effect.asVoid(service.getContexts({}))],
        ["openOptionsPage", service.openOptionsPage],
        ["restart", service.restart],
        ["onInstalled", Stream.runDrain(service.onInstalled)],
        ["onStartup", Stream.runDrain(service.onStartup)],
        ["onMessageExternal", Stream.runDrain(service.onMessageExternal)]
      ] as const) {
        const exit = yield* Effect.exit(effect)
        expect(Exit.hasDies(exit), operation).toBe(false)
        expect((yield* Effect.flip(effect)).operation).toBe(operation)
      }
    }))

    it.effect("provides an injected API through layer without a global", () => Effect.gen(function*() {
      vi.stubGlobal("chrome", undefined)
      const api = fake()
      const service = yield* Effect.provide(resolve, layer(api))
      expect(yield* service.getPlatformInfo).toEqual({ os: "mac", arch: "arm64" })
    }))
  })
})
