import * as ChromeSessions from "../ChromeSessions.js"
import * as TestEvent from "./Event.js"

type Tab = chrome.tabs.Tab

type Window = chrome.windows.Window

const WINDOW_ID_NONE = -1

/** Chrome keeps this many recently closed entries (`TabRestoreService::kMaxEntries`). */
const maxEntries = ChromeSessions.MAX_SESSION_RESULTS

const closedTab = (sessionId: string, index: number, properties: Partial<Tab>): Tab => {
  const { id: _liveId, ...rest } = properties

  return {
    index, windowId: WINDOW_ID_NONE, highlighted: false, active: false, pinned: false, incognito: false,
    discarded: false, autoDiscardable: true, groupId: -1, frozen: false, selected: false, lastAccessed: 0,
    ...rest,
    sessionId
  }
}

/** Throws synchronously, as Chrome's argument validation does before the call starts. */
const limitOf = (operation: string, filter: ChromeSessions.Filter | undefined): number => {
  const maxResults = filter?.maxResults

  if (maxResults === undefined) return ChromeSessions.MAX_SESSION_RESULTS

  if (!Number.isInteger(maxResults) || maxResults < 0 || maxResults > ChromeSessions.MAX_SESSION_RESULTS) {
    throw new TypeError(
      `Error in invocation of sessions.${operation}(optional sessions.Filter filter): ` +
      `Error at parameter 'filter': Error at property 'maxResults': ` +
      `Value must be an integer from 0 to ${ChromeSessions.MAX_SESSION_RESULTS}, found ${maxResults}.`
    )
  }

  return maxResults
}

const invalidSessionId = (sessionId: string) => new Error(`Invalid session id: "${sessionId}".`)

/**
 * Chrome's recently closed list and synced devices, in memory. `controls.closeTab` and
 * `controls.closeWindow` record entries most recent first, keep the newest 25 as Chrome does,
 * and fire `onChanged`; closed tabs carry a numeric `sessionId` and no `id`, closed windows list
 * their tabs, each with its own `sessionId`. `lastModified` is `controls.setTime`'s value, in
 * seconds (0 until set). `getRecentlyClosed` honours `maxResults`; `getDevices` returns
 * `controls.setDevices`' devices, each limited to `maxResults` sessions. An invalid
 * `maxResults` throws synchronously, as Chrome's bindings do.
 *
 * `restore` reopens the most recent entry, or the entry, or one tab of a closed window, with the
 * given id: the restored tab or window gets a fresh live `id` (and its tabs that `windowId`),
 * loses its `sessionId`, and comes back with `lastModified` set to the current time. A restored
 * entry leaves the list, as does a window whose last tab is restored. As in Chrome, removing
 * the entry fires `onChanged` and the finished restore fires it again, so restoring a whole entry
 * fires it twice and restoring one tab of a window that keeps other tabs fires it once.
 * Ids containing a `.` name a device's window or tab, which restores without changing the
 * device list or firing `onChanged`. Failures reject with Chrome's messages: "There are no
 * recently closed sessions." and `Invalid session id: "<id>".`. Pass `overrides` to replace any
 * member.
 */
export const makeSessions = (overrides: Partial<ChromeSessions.ChromeSessionsApi> = {}) => {
  const entries: Array<ChromeSessions.Session> = []
  let devices: Array<ChromeSessions.Device> = []
  const changed = TestEvent.makeEvent<[]>()
  let now = 0
  let nextSessionId = 1
  let nextLiveId = 1

  const record = (session: ChromeSessions.Session): ChromeSessions.Session => {
    entries.unshift(session)
    entries.splice(maxEntries)
    changed.controls.emit()

    return structuredClone(session)
  }

  const liveTab = (tab: Tab, windowId?: number): Tab => {
    const { sessionId: _sessionId, ...rest } = tab
    const restored: Tab = { ...rest, id: nextLiveId++ }

    if (windowId !== undefined) restored.windowId = windowId

    return restored
  }

  const liveWindow = (window: Window): Window => {
    const { sessionId: _sessionId, tabs, ...rest } = window
    const id = nextLiveId++
    const restored: Window = { ...rest, id }

    if (tabs !== undefined) restored.tabs = tabs.map((tab) => liveTab(tab, id))

    return restored
  }

  const restored = (session: ChromeSessions.Session): ChromeSessions.Session => {
    const result: ChromeSessions.Session = { lastModified: now }

    if (session.tab !== undefined) result.tab = liveTab(structuredClone(session.tab))

    if (session.window !== undefined) result.window = liveWindow(structuredClone(session.window))

    return result
  }

  /** Removes an entry as Chrome's `RemoveEntryById` does, which notifies on its own. */
  const remove = (position: number) => {
    entries.splice(position, 1)
    changed.controls.emit()
  }

  /** Chrome notifies again once any restore completes. */
  const finish = (session: ChromeSessions.Session): ChromeSessions.Session => {
    changed.controls.emit()

    return restored(session)
  }

  const restoreLocal = (sessionId: string): ChromeSessions.Session => {
    for (const [position, entry] of entries.entries()) {
      if (entry.tab?.sessionId === sessionId || entry.window?.sessionId === sessionId) {
        remove(position)

        return finish(entry)
      }

      const tabs = entry.window?.tabs ?? []
      const tabPosition = tabs.findIndex((tab) => tab.sessionId === sessionId)

      if (tabPosition !== -1) {
        const [tab] = tabs.splice(tabPosition, 1)

        if (tabs.length === 0) remove(position)

        return finish({ lastModified: now, tab })
      }
    }

    throw invalidSessionId(sessionId)
  }

  const restoreForeign = (sessionId: string): ChromeSessions.Session => {
    for (const device of devices) {
      for (const session of device.sessions) {
        if (session.window?.sessionId === sessionId || session.tab?.sessionId === sessionId) return restored(session)

        const tab = session.window?.tabs?.find((candidate) => candidate.sessionId === sessionId)

        if (tab !== undefined) return restored({ lastModified: now, tab })
      }
    }

    throw invalidSessionId(sessionId)
  }

  const restore = (sessionId: string | undefined): ChromeSessions.Session => {
    if (sessionId === undefined) {
      const latest = entries[0]

      if (latest === undefined) throw new Error("There are no recently closed sessions.")

      remove(0)

      return finish(latest)
    }

    if (/^\d+$/.test(sessionId)) return restoreLocal(sessionId)

    if (/^.+\.\d+$/.test(sessionId)) return restoreForeign(sessionId)

    throw invalidSessionId(sessionId)
  }

  const api: ChromeSessions.ChromeSessionsApi = {
    getRecentlyClosed: (filter) => {
      const limit = limitOf("getRecentlyClosed", filter)

      return Promise.resolve(structuredClone(entries.slice(0, limit)))
    },
    getDevices: (filter) => {
      const limit = limitOf("getDevices", filter)

      return Promise.resolve(devices.map((device) => ({ ...structuredClone(device), sessions: structuredClone(device.sessions.slice(0, limit)) })))
    },
    restore: async (sessionId) => restore(sessionId),
    onChanged: changed.api,
    ...overrides
  }

  return {
    api,
    layer: ChromeSessions.layer(api),
    controls: {
      /** Records a closed tab as the most recent entry and fires `onChanged`; returns its entry. */
      closeTab: (properties: Partial<Tab> = {}): ChromeSessions.Session =>
        record({ lastModified: now, tab: closedTab(String(nextSessionId++), 0, properties) }),
      /**
       * Records a closed window with its tabs (at least one; one blank tab by default) as the most
       * recent entry and fires `onChanged`; returns its entry. The first tab is active unless a tab
       * says otherwise.
       */
      closeWindow: (properties: Partial<Window> = {}, tabs: ReadonlyArray<Partial<Tab>> = [{}]): ChromeSessions.Session => {
        if (tabs.length === 0) throw new Error("A closed window has at least one tab")

        const { id: _liveId, tabs: _tabs, ...rest } = properties

        const window: Window = {
          focused: false, alwaysOnTop: false, incognito: false, type: "normal", state: "normal",
          ...rest,
          sessionId: String(nextSessionId++),
          tabs: tabs.map((tab, index) => closedTab(String(nextSessionId++), index, { active: index === 0, ...tab }))
        }

        return record({ lastModified: now, window })
      },
      /** Empties the recently closed list, as clearing browsing history does, and fires `onChanged`. */
      clear: (): void => {
        entries.splice(0)
        changed.controls.emit()
      },
      /** A snapshot of the recently closed list, most recent first. */
      recentlyClosed: (): Array<ChromeSessions.Session> => structuredClone(entries),
      /** Replaces the synced devices; Chrome reports no event for this. */
      setDevices: (next: ReadonlyArray<ChromeSessions.Device>): void => { devices = structuredClone(Array.from(next)) },
      /** Sets the clock, in seconds since the epoch, used for new entries and restore results. */
      setTime: (seconds: number): void => { now = seconds },
      onChanged: changed.controls
    }
  }
}
