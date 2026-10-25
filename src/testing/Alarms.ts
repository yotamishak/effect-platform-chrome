import * as ChromeAlarms from "../ChromeAlarms.js"
import * as TestEvent from "./Event.js"

/** Chrome's per-extension cap on active alarms. */
const maxAlarms = 500

/** Chrome's limit on an alarm name, in UTF-8 bytes. */
const maxNameBytes = 1024

const minute = 60_000

/**
 * Chrome's minimum time between an extension's firing polls: `kDevDelayMinimum` for an
 * unpacked extension, and from Chrome 153 `kMV3ReleaseDelayMinimum` for a packed MV3 one.
 */
const granularity = 1_000

const nameBytes = new TextEncoder()

/** Chrome 157+'s own equality: re-creating an alarm equal in all of these is a no-op. */
const identical = (left: ChromeAlarms.Alarm, right: ChromeAlarms.Alarm): boolean =>
  left.name === right.name && left.scheduledTime === right.scheduledTime &&
  left.periodInMinutes === right.periodInMinutes && left.persistAcrossSessions === right.persistAcrossSessions

type CreateArgs = [info: ChromeAlarms.AlarmCreateInfo] | [name: string | undefined, info: ChromeAlarms.AlarmCreateInfo]

/**
 * In-memory alarms on a virtual clock that starts at 0 and only moves through
 * `controls.advance`. `create` validates like Chrome (a name given both as an argument and
 * in `info`, both `when` and `delayInMinutes`, no schedule at all, a name over 1,024 UTF-8
 * bytes, and a 501st alarm all reject with Chrome's messages; the cap applies even when
 * replacing) and replaces an alarm of the same name, moving it last. Names default to the
 * empty string, `persistAcrossSessions` to true, and `periodInMinutes` is present only when
 * given. Re-creating an alarm identical in name, scheduled time, period and persistence is a
 * no-op that keeps its place, as from Chrome 157 (earlier versions replace it, moving it last).
 * The fixture behaves like an unpacked extension, or any MV3 extension from Chrome 153: polls
 * that fire come at least one second apart. `advance` moves the clock and makes the poll Chrome
 * would make at the new time. Within a second of the last poll that fired an alarm there is
 * none, and due alarms wait for a later `advance`. Otherwise every due alarm is updated first
 * (one-shot alarms removed, repeating ones moved to their first slot after the new time on
 * their original grid, a zero period left due so it fires on every poll), then each fires
 * once, newest first as Chrome does. Listeners therefore see the polled state, and an alarm
 * they create or clear affects only later polls. `clearAll` resolves `true`. Pass `overrides`
 * to replace any API member.
 */
export const makeAlarms = (overrides: Partial<ChromeAlarms.ChromeAlarmsApi> = {}) => {
  const alarms = new Map<string, ChromeAlarms.Alarm>()
  const onAlarm = TestEvent.makeEvent<[ChromeAlarms.Alarm]>()
  let now = 0
  /** When a poll last fired an alarm; Chrome keeps it in memory only. */
  let lastPoll: number | undefined

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

    const existing = alarms.get(alarmName)

    // Chrome 157+ leaves an identical alarm untouched, keeping its place.
    if (existing !== undefined && identical(existing, alarm)) return

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
       * Moves the clock forward by `milliseconds` and, unless a poll fired an alarm less than a
       * second ago, fires every due alarm once, as one Chrome poll does after a wake. Returns
       * the exceptions thrown by listeners.
       */
      advance: (milliseconds: number): ReadonlyArray<unknown> => {
        if (!Number.isFinite(milliseconds) || milliseconds < 0) {
          throw new Error(`Cannot move the clock by ${milliseconds} ms`)
        }

        now += milliseconds

        // Chrome skips the extension until its minimum granularity has passed.
        if (lastPoll !== undefined && lastPoll + granularity > now) return []

        const due = Array.from(alarms.values()).filter((alarm) => alarm.scheduledTime <= now).reverse()

        // Only a poll that fires an alarm starts the wait, as in Chrome.
        if (due.length > 0) lastPoll = now

        // Chrome updates every due alarm in the browser before any listener runs, so the
        // listeners see the polled state and cannot affect this poll.
        for (const alarm of due) {
          if (alarm.periodInMinutes === undefined) {
            alarms.delete(alarm.name)
          } else if (alarm.periodInMinutes !== 0) {
            // Chrome truncates the missed periods; a zero period keeps the alarm due.
            const span = alarm.periodInMinutes * minute
            const missed = Math.trunc((now - alarm.scheduledTime) / span)
            alarms.set(alarm.name, { ...alarm, scheduledTime: alarm.scheduledTime + span * (missed + 1) })
          }
        }

        return due.flatMap((alarm) => onAlarm.controls.emit(structuredClone(alarm)))
      },
      /**
       * The browser restarts: alarms created with `persistAcrossSessions: false` are gone, and
       * so is the time of the last poll.
       */
      restart: () => {
        lastPoll = undefined

        for (const alarm of Array.from(alarms.values())) {
          if (!alarm.persistAcrossSessions) alarms.delete(alarm.name)
        }
      },
      onAlarm: onAlarm.controls
    }
  }
}
