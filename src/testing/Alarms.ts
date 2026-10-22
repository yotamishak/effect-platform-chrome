import * as ChromeAlarms from "../ChromeAlarms.js"
import * as TestEvent from "./Event.js"

/** Chrome's per-extension cap on active alarms. */
const maxAlarms = 500

/** Chrome's limit on an alarm name, in UTF-8 bytes. */
const maxNameBytes = 1024

const minute = 60_000

const nameBytes = new TextEncoder()

type CreateArgs = [info: ChromeAlarms.AlarmCreateInfo] | [name: string | undefined, info: ChromeAlarms.AlarmCreateInfo]

/**
 * In-memory alarms on a virtual clock that starts at 0 and only moves through
 * `controls.advance`. `create` validates like Chrome (a name given both as an argument and
 * in `info`, both `when` and `delayInMinutes`, no schedule at all, a name over 1,024 UTF-8
 * bytes, and a 501st alarm all reject with Chrome's messages; the cap applies even when
 * replacing) and replaces an alarm of the same name, moving it last. Names default to the
 * empty string, `persistAcrossSessions` to true, and `periodInMinutes` is present only when
 * given. The fixture behaves like an unpacked extension: no 30-second minimum. `advance` is
 * one Chrome poll: due alarms fire once each, newest first as Chrome does, one-shot alarms are
 * removed, and repeating ones move to their first slot after the new time on their original
 * grid. `clearAll` resolves `true`. Pass `overrides` to replace any API member.
 */
export const makeAlarms = (overrides: Partial<ChromeAlarms.ChromeAlarmsApi> = {}) => {
  const alarms = new Map<string, ChromeAlarms.Alarm>()
  const onAlarm = TestEvent.makeEvent<[ChromeAlarms.Alarm]>()
  let now = 0

  const schedule = (args: CreateArgs): void => {
    const name = args.length === 1 ? undefined : args[0]
    const info = args.length === 1 ? args[0] : args[1]

    if (name !== undefined && info.name !== undefined) {
      throw new Error("Cannot set alarm name in both separate argument and object form.")
    }

    if (alarms.size >= maxAlarms) throw new Error(`An extension cannot have more than ${maxAlarms} active alarms.`)

    if (info.delayInMinutes !== undefined && info.when !== undefined) {
      throw new Error("Cannot set both when and delayInMinutes.")
    }

    const delay = info.delayInMinutes ?? info.periodInMinutes

    if (info.when === undefined && delay === undefined) {
      throw new Error("Must set at least one of when, delayInMinutes, or periodInMinutes.")
    }

    const alarmName = name ?? info.name ?? ""
    const size = nameBytes.encode(alarmName).length

    if (size > maxNameBytes) {
      throw new Error(`Alarm name size is ${size} bytes which exceeds the limit of ${maxNameBytes} bytes.`)
    }

    const alarm: ChromeAlarms.Alarm = {
      name: alarmName,
      scheduledTime: info.when ?? now + (delay ?? 0) * minute,
      persistAcrossSessions: info.persistAcrossSessions ?? true
    }

    if (info.periodInMinutes !== undefined) alarm.periodInMinutes = info.periodInMinutes

    alarms.delete(alarmName)
    alarms.set(alarmName, alarm)
  }

  const create: ChromeAlarms.ChromeAlarmsApi["create"] = async (...args: CreateArgs) => { schedule(args) }

  const api: ChromeAlarms.ChromeAlarmsApi = {
    create,
    get: async (name = "") => {
      const alarm = alarms.get(name)

      return alarm === undefined ? undefined : structuredClone(alarm)
    },
    getAll: async () => Array.from(alarms.values(), (alarm) => structuredClone(alarm)),
    clear: async (name = "") => alarms.delete(name),
    clearAll: async () => {
      alarms.clear()

      return true
    },
    onAlarm: onAlarm.api,
    ...overrides
  }

  return {
    api,
    layer: ChromeAlarms.layer(api),
    controls: {
      /** The virtual time in milliseconds. */
      get now() { return now },
      /** The stored alarm, if any; a copy, so changing it changes nothing. */
      alarm: (name = ""): ChromeAlarms.Alarm | undefined => {
        const alarm = alarms.get(name)

        return alarm === undefined ? undefined : structuredClone(alarm)
      },
      /**
       * Moves the clock forward by `milliseconds` and fires every due alarm once, as one Chrome
       * poll does after a wake. Returns the exceptions thrown by listeners.
       */
      advance: (milliseconds: number): ReadonlyArray<unknown> => {
        if (Number.isNaN(milliseconds) || milliseconds < 0) throw new Error(`Cannot move the clock by ${milliseconds} ms`)

        now += milliseconds
        const due = Array.from(alarms.values()).filter((alarm) => alarm.scheduledTime <= now).reverse()
        const errors: Array<unknown> = []

        for (const alarm of due) {
          // A listener may already have cleared or replaced it.
          if (alarms.get(alarm.name) !== alarm) continue

          const period = alarm.periodInMinutes ?? 0

          if (period > 0) {
            const span = period * minute
            const elapsed = Math.floor((now - alarm.scheduledTime) / span)
            alarms.set(alarm.name, { ...alarm, scheduledTime: alarm.scheduledTime + span * (elapsed + 1) })
          } else {
            alarms.delete(alarm.name)
          }

          errors.push(...onAlarm.controls.emit(structuredClone(alarm)))
        }

        return errors
      },
      /** The browser restarts: alarms created with `persistAcrossSessions: false` are gone. */
      restart: () => {
        for (const alarm of Array.from(alarms.values())) {
          if (!alarm.persistAcrossSessions) alarms.delete(alarm.name)
        }
      },
      onAlarm: onAlarm.controls
    }
  }
}
