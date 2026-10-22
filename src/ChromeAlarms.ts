import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

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
  readonly onAlarm: EventSource<[alarm: Alarm]>
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
  /** The named alarm, or the unnamed one when `name` is omitted; None when no such alarm exists. */
  get(name?: string): Effect.Effect<Option.Option<Alarm>, ChromeAlarmsError>
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

const invoke = invoker((operation, cause) => new ChromeAlarmsError({ operation, cause }))

/** Creates the service without reading browser globals or registering listeners. */
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
    return invoke("create", () => {
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
    get: (name) => invoke("get", () => name === undefined ? api.get() : api.get(name)).pipe(
      Effect.map(Option.fromNullishOr)
    ),
    getAll: invoke("getAll", () => api.getAll()),
    clear: (name) => invoke("clear", () => name === undefined ? api.clear() : api.clear(name)),
    clearAll: invoke("clearAll", () => api.clearAll()),
    onAlarm: observe(() => api.onAlarm, (alarm) => alarm,
      (cause) => new ChromeAlarmsError({ operation: "onAlarm", cause }))
  })
}

export const layer = (api: ChromeAlarmsApi): Layer.Layer<ChromeAlarms> => Layer.succeed(ChromeAlarms, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeAlarms, ChromeAlarmsError> = liveLayer(
  ChromeAlarms, "alarms", (chrome) => chrome.alarms, make,
  (cause) => new ChromeAlarmsError({ operation: "initialize", cause })
)
