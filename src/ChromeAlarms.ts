import { Context, Effect, Layer, Queue, Schema, Stream } from "effect"

export type Alarm = chrome.alarms.Alarm

export type AlarmCreateInfo = chrome.alarms.AlarmCreateInfo

/** The Promise-based MV3 API subset needed by this service. */
export interface ChromeAlarmsApi {
  create(info: AlarmCreateInfo): Promise<void>
  create(name: undefined, info: AlarmCreateInfo): Promise<void>
  create<T extends AlarmCreateInfo>(
    name: string,
    info: T & (T extends { name: string } ? never : unknown)
  ): Promise<void>
  get(name?: string): Promise<Alarm | undefined>
  getAll(): Promise<Array<Alarm>>
  clear(name?: string): Promise<boolean>
  clearAll(): Promise<boolean>
  readonly onAlarm: {
    addListener(listener: (alarm: Alarm) => void): void
    removeListener(listener: (alarm: Alarm) => void): void
  }
}

export class ChromeAlarmsError extends Schema.TaggedError<ChromeAlarmsError>()("ChromeAlarmsError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

export interface ChromeAlarmsService {
  create(info: AlarmCreateInfo): Effect.Effect<void, ChromeAlarmsError>
  create(name: undefined, info: AlarmCreateInfo): Effect.Effect<void, ChromeAlarmsError>
  create<T extends AlarmCreateInfo>(
    name: string,
    info: T & (T extends { name: string } ? never : unknown)
  ): Effect.Effect<void, ChromeAlarmsError>
  get(name?: string): Effect.Effect<Alarm | undefined, ChromeAlarmsError>
  readonly getAll: Effect.Effect<Array<Alarm>, ChromeAlarmsError>
  clear(name?: string): Effect.Effect<boolean, ChromeAlarmsError>
  readonly clearAll: Effect.Effect<boolean, ChromeAlarmsError>
  /**
   * Observational only: each running subscription owns a listener, removed when
   * its scope closes. A bounded sliding buffer retains the newest 64 events,
   * dropping the oldest on overflow; Chrome callbacks cannot be backpressured.
   * This does not register a synchronous MV3 wake handler. Register those
   * separately through ChromeServiceWorker at service-worker module evaluation.
   */
  readonly onAlarm: Stream.Stream<Alarm, ChromeAlarmsError>
}

export class ChromeAlarms extends Context.Service<ChromeAlarms, ChromeAlarmsService>()(
  "effect-platform-chrome/ChromeAlarms"
) {}

const operation = <A>(name: string, run: () => Promise<A>): Effect.Effect<A, ChromeAlarmsError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ChromeAlarmsError({ operation: name, cause })
  })

/** Creates an injectable implementation without reading browser globals. */
export const make = (api: ChromeAlarmsApi): ChromeAlarmsService => {
  function create(info: AlarmCreateInfo): Effect.Effect<void, ChromeAlarmsError>
  function create(name: undefined, info: AlarmCreateInfo): Effect.Effect<void, ChromeAlarmsError>
  function create<T extends AlarmCreateInfo>(
    name: string,
    info: T & (T extends { name: string } ? never : unknown)
  ): Effect.Effect<void, ChromeAlarmsError>
  function create(
    nameOrInfo: string | undefined | AlarmCreateInfo,
    info?: AlarmCreateInfo
  ): Effect.Effect<void, ChromeAlarmsError> {
    return operation("create", () => {
      // Already typed by the public overloads; this dispatches Chrome's object/name overloads.
      // oxlint-disable-next-line anti-slop/no-runtime-typeof
      if (typeof nameOrInfo === "object") return api.create(nameOrInfo)

      // The public overloads guarantee that the second argument is present.
      if (nameOrInfo === undefined) return api.create(undefined, info!)

      return api.create(nameOrInfo, info!)
    })
  }

  return ChromeAlarms.of({
    create,
    get: (name) => operation("get", () => api.get(name)),
    getAll: operation("getAll", () => api.getAll()),
    clear: (name) => operation("clear", () => api.clear(name)),
    clearAll: operation("clearAll", () => api.clearAll()),
    onAlarm: Stream.callback<Alarm, ChromeAlarmsError>((queue) => Effect.gen(function*() {
      const listener = (alarm: Alarm): void => { Queue.offerUnsafe(queue, alarm) }

      // Install cleanup before registration, which may partially succeed then throw.
      yield* Effect.acquireRelease(
        Effect.succeed(listener),
        () => Effect.sync(() => api.onAlarm.removeListener(listener))
      )
      yield* Effect.try({
        try: () => api.onAlarm.addListener(listener),
        catch: (cause) => new ChromeAlarmsError({ operation: "onAlarm.addListener", cause })
      })
    }),
    { bufferSize: 64, strategy: "sliding" })
  })
}

/** Resolves chrome.alarms only when the layer is built, never at import time. */
export const layer: Layer.Layer<ChromeAlarms, ChromeAlarmsError> = Layer.effect(
  ChromeAlarms,
  Effect.try({
    try: () => {
      if (typeof chrome === "undefined" || chrome.alarms === undefined) {
        throw new Error("chrome.alarms is unavailable")
      }

      return make(chrome.alarms)
    },
    catch: (cause) => new ChromeAlarmsError({ operation: "initialize", cause })
  })
)
