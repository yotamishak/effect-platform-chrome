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
  /**
   * Resolves to `true`, or to nothing where Chrome's `ApiAlarmsClearAllReturnUndefined`
   * feature is on; it carries no information either way.
   */
  clearAll(): Promise<boolean | undefined>
  readonly onAlarm: EventSource<[alarm: Alarm]>
}

export class ChromeAlarmsError extends Schema.TaggedError<ChromeAlarmsError>()("ChromeAlarmsError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

export interface ChromeAlarmsService {
  /**
   * Schedules an alarm, replacing any alarm of the same name (the empty string when no name
   * is given). The name goes either in the first argument or, from Chrome 152, in
   * `info.name`; Chrome rejects both at once. `persistAcrossSessions` is Chrome 150+ and
   * defaults to true. The first firing comes from exactly one of `when` or `delayInMinutes`,
   * or from `periodInMinutes` when neither is set. Chrome fails the call when the extension
   * already has 500 alarms (even when this one would replace one of them) or the name exceeds
   * 1,024 bytes. Packed extensions fire at most every 30 seconds; shorter delays only warn.
   * Re-creating an identical alarm (same name, scheduled time, period and persistence) leaves
   * it in place. Any present `periodInMinutes` repeats, and `0` keeps the alarm due so it
   * fires on every poll: omit the field for a one-shot alarm. Interrupting the Effect does not
   * cancel a create Chrome has already started.
   */
  create(info: AlarmCreateInfo): Effect.Effect<void, ChromeAlarmsError>
  create(name: undefined, info: AlarmCreateInfo): Effect.Effect<void, ChromeAlarmsError>
  create<T extends AlarmCreateInfo>(
    name: string,
    info: T & (T extends { name: string } ? never : unknown)
  ): Effect.Effect<void, ChromeAlarmsError>
  /** The named alarm, or the unnamed one when `name` is omitted; None when no such alarm exists. */
  get(name?: string): Effect.Effect<Option.Option<Alarm>, ChromeAlarmsError>
  /** Every alarm of this extension; empty when there are none. */
  readonly getAll: Effect.Effect<Array<Alarm>, ChromeAlarmsError>
  /** Whether the named alarm (the unnamed one when `name` is omitted) existed and is now cleared. */
  clear(name?: string): Effect.Effect<boolean, ChromeAlarmsError>
  /** Clears every alarm of this extension. */
  readonly clearAll: Effect.Effect<void, ChromeAlarmsError>
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
    ...args: [info: AlarmCreateInfo] | [name: string | undefined, info: AlarmCreateInfo]
  ): Effect.Effect<void, ChromeAlarmsError> {
    // Forward exactly the arity the caller used: Chrome distinguishes `create(info)` from
    // `create(undefined, info)` only by its own argument matching.
    return invoke("create", () => {
      if (args.length === 1) return api.create(args[0])

      const [name, info] = args

      return name === undefined ? api.create(undefined, info) : api.create(name, info)
    })
  }

  return ChromeAlarms.of({
    create,
    get: (name) => invoke("get", () => name === undefined ? api.get() : api.get(name)).pipe(
      Effect.map(Option.fromNullishOr)
    ),
    getAll: invoke("getAll", () => api.getAll()),
    clear: (name) => invoke("clear", () => name === undefined ? api.clear() : api.clear(name)),
    clearAll: Effect.asVoid(invoke("clearAll", () => api.clearAll())),
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
