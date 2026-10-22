// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Cause, Effect, Exit, Fiber, Option, Result, Schema, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChromeMessageError, Response, fail, succeed } from "../../src/ChromeMessage.js"
import { ChromeRuntimeError, make } from "../../src/ChromeRuntime.js"
import type { ChromeRuntimeApi, ChromeRuntimeService, MessageListenerArguments } from "../../src/ChromeRuntime.js"
import { makePortPair } from "../../src/testing/Port.js"
import { burst, expectOperations, gatedEvent, labelled, newest, pendingCalls, pendingCount } from "./support.js"
import type { Labelled } from "./support.js"

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32), so failures replay exactly. */
const seeded = (seed: number) => {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

/** The result failed with a ChromeRuntimeError for `operation`. */
const expectRuntimeFailure = <A, E>(result: Result.Result<A, E>, operation: string) => {
  expect(Result.isFailure(result)).toBe(true)

  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(ChromeRuntimeError)
    expect(result.failure).toMatchObject({ operation })
  }
}

const context = (index: number): chrome.runtime.ExtensionContext => ({
  contextId: `context-${index}`, contextType: "TAB", frameId: 0, incognito: false, tabId: index, windowId: 1
})

// SAFETY: a DirectoryEntry is an opaque legacy FileSystem handle the module only passes through.
const directory = { name: "", isDirectory: true } as DirectoryEntry

const sender = (index: number): chrome.runtime.MessageSender => ({ id: `extension-${index}` })

const ports = Array.from({ length: burst }, (_, index) => makePortPair(`port-${index}`).left.port)

const makeEvents = () => ({
  onInstalled: gatedEvent<[details: chrome.runtime.InstalledDetails]>(),
  onStartup: gatedEvent<[]>(),
  onUpdateAvailable: gatedEvent<[details: chrome.runtime.UpdateAvailableDetails]>(),
  onSuspend: gatedEvent<[]>(),
  onSuspendCanceled: gatedEvent<[]>(),
  onRestartRequired: gatedEvent<[reason: `${chrome.runtime.OnRestartRequiredReason}`]>(),
  onEnabled: gatedEvent<[]>(),
  onMessage: gatedEvent<MessageListenerArguments>(),
  onMessageExternal: gatedEvent<MessageListenerArguments>(),
  onUserScriptMessage: gatedEvent<MessageListenerArguments>(),
  onConnect: gatedEvent<[port: chrome.runtime.Port]>(),
  onConnectExternal: gatedEvent<[port: chrome.runtime.Port]>(),
  onConnectNative: gatedEvent<[port: chrome.runtime.Port]>(),
  onUserScriptConnect: gatedEvent<[port: chrome.runtime.Port]>()
})

type Events = ReturnType<typeof makeEvents>

type EventName = keyof Events

const eventNames: ReadonlyArray<EventName> = [
  "onInstalled", "onStartup", "onUpdateAvailable", "onSuspend", "onSuspendCanceled", "onRestartRequired", "onEnabled",
  "onMessage", "onMessageExternal", "onUserScriptMessage", "onConnect", "onConnectExternal", "onConnectNative",
  "onUserScriptConnect"
]

const reasons = ["app_update", "os_update", "periodic"] as const

/**
 * Fires event `name` with a payload derived from `index`, returning the key the stream
 * value must report for it; signal events carry no payload, so their key is constant.
 */
const fire = (events: Events, name: EventName, index: number): string => {
  switch (name) {
    case "onInstalled": {
      events.onInstalled.emit({ reason: "update", previousVersion: `${index}` })

      return `${index}`
    }

    case "onUpdateAvailable": {
      events.onUpdateAvailable.emit({ version: `${index}` })

      return `${index}`
    }

    case "onRestartRequired": {
      events.onRestartRequired.emit(reasons[index % reasons.length]!)

      return reasons[index % reasons.length]!
    }

    case "onMessage":
    case "onMessageExternal":
    case "onUserScriptMessage": {
      events[name].emit(`message-${index}`, sender(index), () => {})

      return `message-${index}|extension-${index}`
    }

    case "onConnect":
    case "onConnectExternal":
    case "onConnectNative":
    case "onUserScriptConnect": {
      events[name].emit(ports[index % ports.length]!)

      return `port-${index % ports.length}`
    }

    case "onStartup":
    case "onSuspend":
    case "onSuspendCanceled":
    case "onEnabled": {
      events[name].emit()

      return "signal"
    }
  }
}

/** The stream for `name`, its values reduced to the key `fire` returned. */
const keyed = (service: ChromeRuntimeService, name: EventName): Stream.Stream<string, ChromeRuntimeError> => {
  switch (name) {
    case "onInstalled": return Stream.map(service.onInstalled, (details) => details.previousVersion ?? "")
    case "onUpdateAvailable": return Stream.map(service.onUpdateAvailable, (details) => details.version)
    case "onRestartRequired": return service.onRestartRequired
    case "onMessage":
    case "onMessageExternal":
    case "onUserScriptMessage":
      return Stream.map(service[name], ({ message, sender }) => `${String(message)}|${sender.id ?? ""}`)
    case "onConnect":
    case "onConnectExternal":
    case "onConnectNative":
    case "onUserScriptConnect":
      return Stream.map(service[name], (port) => port.name)
    case "onStartup":
    case "onSuspend":
    case "onSuspendCanceled":
    case "onEnabled":
      return Stream.map(service[name], () => "signal")
  }
}

const fixture = (throwEvery?: number) => {
  const pending = pendingCalls(throwEvery)
  const events = makeEvents()

  const api: ChromeRuntimeApi = {
    id: "extension-id",
    getManifest: () => ({ manifest_version: 3, name: "Stress", version: "1.0.0" }),
    getURL: (path) => `chrome-extension://extension-id/${path}`,
    getVersion: () => "1.0.0",
    sendMessage: () => pending.call("sendMessage").then(() => succeed("reply")),
    sendNativeMessage: () => pending.call("sendNativeMessage").then(() => ({ native: true })),
    getContexts: () => pending.call("getContexts").then(() => [context(0)]),
    getPackageDirectoryEntry: () => pending.call("getPackageDirectoryEntry").then(() => directory),
    openOptionsPage: () => pending.call("openOptionsPage"),
    reload: () => {},
    restart: () => {},
    restartAfterDelay: () => pending.call("restartAfterDelay"),
    setUninstallURL: () => pending.call("setUninstallURL"),
    getPlatformInfo: () => pending.call("getPlatformInfo").then(() => ({ os: "mac", arch: "arm64" })),
    requestUpdateCheck: () => pending.call("requestUpdateCheck").then(() => ({ status: "no_update" })),
    ...events
  }

  return { api, events, pending, service: make(api) }
}

/** The calls of every Promise-based operation, labelled with the operation a failure must report. */
const promiseOperations = (service: ChromeRuntimeService): ReadonlyArray<(index: number) => Effect.Effect<Labelled<ChromeRuntimeError | ChromeMessageError>>> => [
  (index) => labelled("sendMessage", service.sendMessage({ index })),
  (index) => labelled("sendMessage", service.sendMessageSchema(Schema.Finite, Response(Schema.String), index)),
  (index) => labelled("sendMessage", service.request(Schema.Finite, Schema.String, index)),
  (index) => labelled("sendNativeMessage", service.sendNativeMessage("com.example.host", { index })),
  () => labelled("getContexts", service.getContexts({})),
  () => labelled("getPackageDirectoryEntry", service.getPackageDirectoryEntry),
  () => labelled("openOptionsPage", service.openOptionsPage),
  (index) => labelled("restartAfterDelay", service.restartAfterDelay(index)),
  (index) => labelled("setUninstallURL", service.setUninstallURL(`https://example.com/${index}`)),
  () => labelled("getPlatformInfo", service.getPlatformInfo),
  () => labelled("requestUpdateCheck", service.requestUpdateCheck)
]

describe("ChromeRuntime stress", () => {
  it.effect("keeps exactly the newest 64 of a 4,096-event burst on every event, in order, then removes the listener", () => Effect.gen(function*() {
    const { service, events } = fixture()

    for (const name of eventNames) {
      const consumer = yield* Effect.forkScoped(Stream.runCollect(Stream.take(keyed(service, name), 64)))
      yield* events[name].registered(1)

      const keys = Array.from({ length: burst }, (_, index) => fire(events, name, index))

      expect(yield* Fiber.join(consumer), name).toEqual(newest(burst).map((index) => keys[index]))
      expect(events[name].listeners.size, name).toBe(0)
      expect(events[name].added, name).toHaveLength(1)
      expect(events[name].removed, name).toEqual(events[name].added)
    }
  }))

  it.effect("churns 512 concurrent subscriptions with interruption at every stage and leaves no listener", () => Effect.gen(function*() {
    const { api, service, events } = fixture()
    const cause = new Error("registration failed")

    // Registration adds the listener, then throws: the stream must still remove it.
    const partial: ChromeRuntimeApi = { ...api }

    for (const name of eventNames) {
      Object.defineProperty(partial, name, {
        value: {
          addListener: (listener: never) => {
            events[name].addListener(listener)

            throw cause
          },
          removeListener: (listener: never) => events[name].removeListener(listener)
        }
      })
    }

    // Looking the event up throws, as reading a member of an invalidated context does.
    const lookup: ChromeRuntimeApi = { ...api }

    for (const name of eventNames) Object.defineProperty(lookup, name, { get: () => { throw cause } })

    const partialService = make(partial)
    const lookupService = make(lookup)
    const stages = 6

    for (let round = 0; round < 4; round++) {
      const forked: Array<{ readonly stage: number; readonly name: EventName; readonly fiber: Fiber.Fiber<void, ChromeRuntimeError> }> = []

      for (let index = 0; index < 512; index++) {
        const name = eventNames[index % eventNames.length]!
        const stage = Math.floor(index / eventNames.length) % stages
        const stream = keyed(service, name)

        switch (stage) {
          case 0: {
            // Interrupted before it ever starts: it must not register at all.
            const fiber = yield* Effect.forkChild(Stream.runDrain(stream))
            yield* Fiber.interrupt(fiber)
            forked.push({ stage, name, fiber })
            break
          }

          case 1: {
            forked.push({ stage, name, fiber: yield* Effect.forkChild(Stream.runDrain(stream)) })
            break
          }

          case 2: {
            // Stuck on its first element while the buffer fills behind it.
            forked.push({ stage, name, fiber: yield* Effect.forkChild(Stream.runForEach(stream, () => Effect.never)) })
            break
          }

          case 3: {
            forked.push({ stage, name, fiber: yield* Effect.forkChild(Stream.runDrain(Stream.take(stream, 1))) })
            break
          }

          case 4: {
            forked.push({ stage, name, fiber: yield* Effect.forkChild(Stream.runDrain(keyed(partialService, name))) })
            break
          }

          default: {
            forked.push({ stage, name, fiber: yield* Effect.forkChild(Stream.runDrain(keyed(lookupService, name))) })
          }
        }
      }

      for (const { stage, name, fiber } of forked) {
        if (stage === 0) expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)

        if (stage >= 4) {
          const exit = yield* Fiber.await(fiber)
          expect(Exit.hasDies(exit)).toBe(false)
          expect(Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined)
            .toMatchObject({ operation: name, cause })
        }
      }

      for (const name of eventNames) {
        yield* events[name].registered(forked.filter((entry) => entry.name === name && entry.stage >= 1 && entry.stage <= 3).length)
      }

      for (let index = 0; index < 128; index++) {
        for (const name of eventNames) fire(events, name, index)
      }

      for (const { stage, fiber } of forked) {
        if (stage === 3) expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)
      }

      yield* Effect.forEach([...forked].reverse(), ({ fiber }) => Fiber.interrupt(fiber), { concurrency: "unbounded" })

      for (const { stage, fiber } of forked) {
        if (stage === 1 || stage === 2) expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
      }

      for (const name of eventNames) expect(events[name].listeners.size, name).toBe(0)
    }

    for (const name of eventNames) {
      // Stages 1 to 4 register; stage 0 never starts and stage 5 never finds the event.
      const registering = Array.from({ length: 512 }, (_, index) => index)
        .filter((index) => eventNames[index % eventNames.length] === name)
        .filter((index) => {
          const stage = Math.floor(index / eventNames.length) % stages

          return stage >= 1 && stage <= 4
        }).length

      expect(events[name].added, name).toHaveLength(registering * 4)
      expect(events[name].removed, name).toHaveLength(events[name].added.length)
      expect(new Set<object>(events[name].removed), name).toEqual(new Set<object>(events[name].added))
    }
  }))

  it.effect("settles 2,048 concurrent Promise calls with interleaved rejections and throws, each naming its operation", () => Effect.gen(function*() {
    const { service, pending } = fixture()
    const operations = promiseOperations(service)
    const calls = Array.from({ length: 2048 }, (_, index) => operations[index % operations.length]!(index))
    const fiber = yield* Effect.forkChild(Effect.all(calls, { concurrency: "unbounded" }))

    yield* pending.arrived(pendingCount(2048))
    const rejected = pending.settleInterleaved()
    const results = yield* Fiber.join(fiber)

    expectOperations(results, new Map([...pending.thrown, ...rejected]), ChromeRuntimeError)
    expect(results.filter(({ result }) => Result.isSuccess(result))).toHaveLength(2048 - pending.thrown.size - rejected.size)
  }))

  it.effect("runs 1,024 concurrent synchronous calls with seeded throws, each naming its operation", () => Effect.gen(function*() {
    const { api } = fixture()
    const random = seeded(0x5eed)
    const thrown = new Map<Error, string>()

    const maybeThrow = (operation: string) => {
      if (random() < 0.3) {
        const cause = new Error(`${operation} threw`)
        thrown.set(cause, operation)

        throw cause
      }
    }

    const flaky: ChromeRuntimeApi = {
      ...api,
      getManifest: () => {
        maybeThrow("getManifest")

        return api.getManifest()
      },
      getURL: (path) => {
        maybeThrow("getURL")

        return api.getURL(path)
      },
      getVersion: () => {
        maybeThrow("getVersion")

        return "1.0.0"
      },
      reload: () => maybeThrow("reload"),
      restart: () => maybeThrow("restart")
    }

    Object.defineProperty(flaky, "id", {
      get: () => {
        maybeThrow("id")

        return "extension-id"
      }
    })

    const service = make(flaky)

    const operations = [
      () => labelled("id", service.id),
      () => labelled("getManifest", service.getManifest),
      (index: number) => labelled("getURL", service.getURL(`page-${index}.html`)),
      () => labelled("getVersion", service.getVersion),
      () => labelled("reload", service.reload),
      () => labelled("restart", service.restart)
    ]

    const results = yield* Effect.all(
      Array.from({ length: 1024 }, (_, index) => operations[index % operations.length]!(index)),
      { concurrency: "unbounded" }
    )

    expect(thrown.size).toBeGreaterThan(200)
    expectOperations(results, thrown, ChromeRuntimeError)
  }))

  it.effect("interrupts 512 in-flight calls of every operation and tolerates their late settlement", () => Effect.gen(function*() {
    const { service, pending } = fixture(0)
    const operations = promiseOperations(service)
    const fibers = yield* Effect.forEach(Array.from({ length: 512 }), (_, index) => Effect.forkChild(operations[index % operations.length]!(index)))

    yield* pending.arrived(512)
    yield* Effect.forEach(fibers, Fiber.interrupt, { concurrency: "unbounded" })
    pending.settleInterleaved()

    const exits = yield* Effect.forEach(fibers, Fiber.await)
    expect(exits.every((exit) => Exit.hasInterrupts(exit))).toBe(true)

    const after = yield* Effect.forkChild(service.request(Schema.Finite, Schema.String, 1))
    yield* pending.arrived(513)
    pending.calls[512]!.resolve()
    expect(yield* Fiber.join(after)).toBe("reply")
  }))

  it.effect("runs 1,024 concurrent schema exchanges: invalid requests never reach Chrome, every reply keeps its outcome", () => Effect.gen(function*() {
    const { api } = fixture()
    const request = Schema.Struct({ index: Schema.FiniteFromString })
    const Sent = Schema.Struct({ index: Schema.String })
    const sent: Array<string> = []

    const exchange: ChromeRuntimeApi = {
      ...api,
      // Chrome's overloads also pass an extension id first; this call never does.
      sendMessage: async (message: typeof Sent.Type | string | null | undefined) => {
        if (!Schema.is(Sent)(message)) throw new Error("sendMessage received an unexpected first argument")

        sent.push(message.index)
        const index = Number(message.index)

        switch (index % 4) {
          case 0: return succeed(`value-${index}`)
          case 1: return fail({ code: "HandlerFailed", message: `failed-${index}` })
          case 2: return { malformed: index }
          default: throw new Error(`rejected-${index}`)
        }
      }
    }

    const service = make(exchange)

    const results = yield* Effect.all(Array.from({ length: 1024 }, (_, index) =>
      Effect.result(service.request(request, Schema.String, { index: index % 5 === 4 ? Number.NaN : index }))), { concurrency: "unbounded" })

    for (const [index, result] of results.entries()) {
      if (index % 5 === 4) {
        expectRuntimeFailure(result, "sendMessage.encodeRequest")
        continue
      }

      switch (index % 4) {
        case 0: {
          expect(result).toEqual(Result.succeed(`value-${index}`))
          break
        }

        case 1: {
          expect(Result.isFailure(result) && result.failure).toEqual(new ChromeMessageError({ code: "HandlerFailed", message: `failed-${index}` }))
          break
        }

        case 2: {
          expectRuntimeFailure(result, "sendMessage.decodeResponse")
          break
        }

        default: {
          expectRuntimeFailure(result, "sendMessage")
        }
      }
    }

    expect([...sent].sort((left, right) => Number(left) - Number(right)))
      .toEqual(Array.from({ length: 1024 }, (_, index) => index).filter((index) => index % 5 !== 4).map(String))
  }))

  it.effect("256 subscribers racing a live message stream each see an ordered, duplicate-free run ending at the sentinel", () => Effect.gen(function*() {
    const { service, events } = fixture()
    const sentinel = -1

    const subscribers = yield* Effect.forEach(Array.from({ length: 256 }), () => Effect.forkChild(
      service.onMessage.pipe(
        Stream.map(({ message }) => Number(message)),
        Stream.takeUntil((value) => value === sentinel),
        Stream.runCollect
      )
    ))

    // Subscribers register while the events flow, each starting wherever it joined.
    for (let index = 0; index < 1024; index++) {
      events.onMessage.emit(`${index}`, sender(index), () => {})

      if (index % 8 === 7) yield* Effect.yieldNow
    }

    yield* events.onMessage.registered(256)
    events.onMessage.emit(`${sentinel}`, sender(sentinel), () => {})

    for (const values of yield* Effect.forEach(subscribers, Fiber.join)) {
      expect(values.at(-1)).toBe(sentinel)
      const run = values.slice(0, -1)
      expect(run.every((value, index) => index === 0 || value > run[index - 1]!)).toBe(true)
    }

    expect(events.onMessage.listeners.size).toBe(0)
    expect(events.onMessage.removed).toHaveLength(256)
  }))

  it.effect("returns a 10,000-context getContexts result unchanged", () => Effect.gen(function*() {
    const { api } = fixture()
    const contexts = Array.from({ length: 10000 }, (_, index) => context(index))
    const service = make({ ...api, getContexts: async () => contexts })
    expect(yield* service.getContexts({ contextTypes: ["TAB"] })).toBe(contexts)
  }))
})
