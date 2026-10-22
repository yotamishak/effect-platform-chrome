// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Exit, Fiber, Option, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import {
  ChromeSessions, ChromeSessionsError, layer, layerLive, make, MAX_SESSION_RESULTS, sessionIdOf
} from "../src/ChromeSessions.js"
import type { ChromeSessionsApi, Device, Filter, Session } from "../src/ChromeSessions.js"
import { makeEvent } from "../src/ChromeTesting.js"
import { makeSessions } from "../src/testing/Sessions.js"

const closedTab: chrome.tabs.Tab = {
  sessionId: "7", index: 0, windowId: -1, highlighted: false, active: false, pinned: false, incognito: false,
  discarded: false, autoDiscardable: true, groupId: -1, frozen: false, selected: false, lastAccessed: 0
}

const session: Session = { lastModified: 1_700_000_000, tab: closedTab }

const windowSession: Session = {
  lastModified: 1_700_000_100,
  window: { sessionId: "8", focused: false, alwaysOnTop: false, incognito: false, type: "normal", state: "normal", tabs: [closedTab] }
}

const device: Device = { deviceName: "Laptop", sessions: [windowSession] }

/** A makeEvent whose registrations can be awaited by count, so tests never guess scheduler turns. */
const trackedEvent = () => {
  const event = makeEvent<[]>()
  const waiting: Array<{ readonly count: number, readonly resolve: () => void }> = []

  const settle = () => {
    for (const waiter of waiting.filter((candidate) => event.controls.listenerCount >= candidate.count)) {
      waiting.splice(waiting.indexOf(waiter), 1)
      waiter.resolve()
    }
  }

  return {
    api: {
      addListener: (listener: () => void) => {
        event.api.addListener(listener)
        settle()
      },
      removeListener: (listener: () => void) => event.api.removeListener(listener)
    },
    controls: {
      ...event.controls,
      get listenerCount() { return event.controls.listenerCount },
      /** Resolves once at least `count` listeners are registered at the same time. */
      waitForListeners: (count: number): Promise<void> => new Promise((resolve) => {
        waiting.push({ count, resolve })
        settle()
      })
    }
  }
}

const mockApi = () => {
  const onChanged = trackedEvent()

  return {
    api: {
      getRecentlyClosed: vi.fn(async (_filter?: Filter): Promise<Array<Session>> => [session]),
      getDevices: vi.fn(async (_filter?: Filter): Promise<Array<Device>> => [device]),
      restore: vi.fn(async (_sessionId?: string): Promise<Session> => session),
      onChanged: onChanged.api
    } satisfies ChromeSessionsApi,
    onChanged: onChanged.controls
  }
}

type Operation = "getRecentlyClosed" | "getDevices" | "restore"

/** Runs one operation through the service, with or without its optional argument. */
const call = (sessions: ReturnType<typeof make>, operation: Operation, withArgument: boolean): Effect.Effect<void, ChromeSessionsError> => {
  switch (operation) {
    case "getRecentlyClosed": return Effect.asVoid(withArgument ? sessions.getRecentlyClosed({ maxResults: 3 }) : sessions.getRecentlyClosed())
    case "getDevices": return Effect.asVoid(withArgument ? sessions.getDevices({ maxResults: 3 }) : sessions.getDevices())
    case "restore": return Effect.asVoid(withArgument ? sessions.restore("7") : sessions.restore())
  }
}

/** An onChanged source that registers the listener and then throws, as a partly failing registration might. */
const partlyFailingSource = (cause: Error) => {
  const listeners = new Set<() => void>()

  return {
    listeners,
    addListener: (listener: () => void) => {
      listeners.add(listener)

      throw cause
    },
    removeListener: (listener: () => void) => { listeners.delete(listener) }
  }
}

describe("ChromeSessions", () => {
  it("mirrors chrome.sessions.MAX_SESSION_RESULTS", () => {
    expect(MAX_SESSION_RESULTS).toBe(25)
  })

  it("finds the id restore takes for tab and window sessions", () => {
    expect(sessionIdOf(session)).toEqual(Option.some("7"))
    expect(sessionIdOf(windowSession)).toEqual(Option.some("8"))
    expect(sessionIdOf({ lastModified: 0 })).toEqual(Option.none())
    expect(sessionIdOf({ lastModified: 0, tab: { ...closedTab, sessionId: undefined } })).toEqual(Option.none())
  })

  it.effect("touches no API member until an effect or stream runs", () => Effect.gen(function*() {
    const mock = mockApi()
    const { api } = mock
    const accessed: Array<string> = []

    const watched: ChromeSessionsApi = {
      get getRecentlyClosed() {
        accessed.push("getRecentlyClosed")

        return api.getRecentlyClosed
      },
      get getDevices() {
        accessed.push("getDevices")

        return api.getDevices
      },
      get restore() {
        accessed.push("restore")

        return api.restore
      },
      get onChanged() {
        accessed.push("onChanged")

        return api.onChanged
      }
    }

    const sessions = make(watched)
    const effects = [sessions.getRecentlyClosed(), sessions.getDevices({ maxResults: 1 }), sessions.restore("7")]
    const stream = Stream.take(sessions.onChanged, 1)
    expect(accessed).toEqual([])
    expect(api.getRecentlyClosed).not.toHaveBeenCalled()
    expect(api.getDevices).not.toHaveBeenCalled()
    expect(api.restore).not.toHaveBeenCalled()
    yield* Effect.all(effects)
    expect(accessed).toEqual(["getRecentlyClosed", "getDevices", "restore"])
    const fiber = yield* Effect.forkScoped(Stream.runDrain(stream))
    yield* Effect.promise(() => mock.onChanged.waitForListener())
    expect(accessed).toEqual(["getRecentlyClosed", "getDevices", "restore", "onChanged"])
    mock.onChanged.emit()
    yield* Fiber.join(fiber)
  }))

  it.effect("passes the filter and session id only when given, unchanged", () => Effect.gen(function*() {
    const { api } = mockApi()
    const sessions = make(api)
    const filter: Filter = { maxResults: 0 }
    const empty: Filter = {}
    yield* sessions.getRecentlyClosed()
    yield* sessions.getRecentlyClosed(undefined)
    yield* sessions.getRecentlyClosed(filter)
    yield* sessions.getRecentlyClosed(empty)
    yield* sessions.getDevices()
    yield* sessions.getDevices(undefined)
    yield* sessions.getDevices({ maxResults: MAX_SESSION_RESULTS })
    yield* sessions.restore()
    yield* sessions.restore(undefined)
    yield* sessions.restore("")
    yield* sessions.restore("device-tag.12")
    expect(api.getRecentlyClosed.mock.calls).toEqual([[], [], [{ maxResults: 0 }], [{}]])
    expect(api.getRecentlyClosed.mock.calls[2]?.[0]).toBe(filter)
    expect(api.getRecentlyClosed.mock.calls[3]?.[0]).toBe(empty)
    expect(api.getDevices.mock.calls).toEqual([[], [], [{ maxResults: 25 }]])
    expect(api.restore.mock.calls).toEqual([[], [], [""], ["device-tag.12"]])
  }))

  it.effect("returns Chrome's results unchanged, keeping empty lists as lists", () => Effect.gen(function*() {
    const { api } = mockApi()
    const sessions = make(api)
    const closed = [session, windowSession]
    const devices = [device, { deviceName: "Phone", sessions: [] }]
    api.getRecentlyClosed.mockResolvedValueOnce(closed).mockResolvedValueOnce([])
    api.getDevices.mockResolvedValueOnce(devices).mockResolvedValueOnce([])
    api.restore.mockResolvedValueOnce(windowSession)
    expect(yield* sessions.getRecentlyClosed()).toBe(closed)
    expect(yield* sessions.getRecentlyClosed()).toEqual([])
    expect(yield* sessions.getDevices()).toBe(devices)
    expect(yield* sessions.getDevices()).toEqual([])
    expect(yield* sessions.restore("8")).toBe(windowSession)
  }))

  it.effect("calls Chrome again each time an effect runs", () => Effect.gen(function*() {
    const { api } = mockApi()
    const restore = make(api).restore("7")
    yield* restore
    yield* restore
    yield* restore
    expect(api.restore.mock.calls).toEqual([["7"], ["7"], ["7"]])
  }))

  it.effect.each(["getRecentlyClosed", "getDevices", "restore"] as const)(
    "types rejections and synchronous throws from %s with the method's name", (operation) => Effect.gen(function*() {
      for (const synchronous of [false, true]) {
        for (const withArgument of [false, true]) {
          for (const cause of [new Error(`Invalid session id: "7".`), "a string", undefined]) {
            const { api } = mockApi()

            const fail = () => {
              if (synchronous) throw cause

              return Promise.reject(cause)
            }

            api[operation].mockImplementationOnce(fail)
            const error = yield* Effect.flip(call(make(api), operation, withArgument))
            expect(error).toBeInstanceOf(ChromeSessionsError)
            expect(error._tag).toBe("ChromeSessionsError")
            expect(error.operation).toBe(operation)
            expect(error.cause).toBe(cause)
            expect(api[operation]).toHaveBeenCalledTimes(1)
          }
        }
      }
    })
  )

  it.effect("fails recoverably, so callers can catch the error by tag", () => Effect.gen(function*() {
    const { api } = mockApi()
    api.restore.mockRejectedValueOnce(new Error("There are no recently closed sessions."))

    const outcome = yield* make(api).restore().pipe(
      Effect.as("restored"),
      Effect.catchTag("ChromeSessionsError", (error) => Effect.succeed(`caught ${error.operation}`))
    )

    expect(outcome).toBe("caught restore")
  }))

  it.effect("emits one value per change and removes its listener when the stream ends", () => Effect.gen(function*() {
    const mock = mockApi()
    const addListener = vi.spyOn(mock.api.onChanged, "addListener")
    const removeListener = vi.spyOn(mock.api.onChanged, "removeListener")
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(make(mock.api).onChanged, 3)))
    yield* Effect.promise(() => mock.onChanged.waitForListener())
    expect(mock.onChanged.listenerCount).toBe(1)
    mock.onChanged.emit()
    mock.onChanged.emit()
    mock.onChanged.emit()
    expect(yield* Fiber.join(fiber)).toEqual([undefined, undefined, undefined])
    expect(mock.onChanged.listenerCount).toBe(0)
    expect(addListener).toHaveBeenCalledTimes(1)
    expect(removeListener).toHaveBeenCalledExactlyOnceWith(addListener.mock.calls[0]?.[0])
  }))

  it.effect("gives each consumption its own listener and can run again after ending", () => Effect.gen(function*() {
    const mock = mockApi()
    const sessions = make(mock.api)
    const first = yield* Effect.forkScoped(Stream.runCollect(Stream.take(sessions.onChanged, 2)))
    const second = yield* Effect.forkScoped(Stream.runCollect(Stream.take(sessions.onChanged, 2)))
    yield* Effect.promise(() => mock.onChanged.waitForListeners(2))
    mock.onChanged.emit()
    mock.onChanged.emit()
    expect(yield* Fiber.join(first)).toHaveLength(2)
    expect(yield* Fiber.join(second)).toHaveLength(2)
    expect(mock.onChanged.listenerCount).toBe(0)

    const again = yield* Effect.forkScoped(Stream.runCollect(Stream.take(sessions.onChanged, 1)))
    yield* Effect.promise(() => mock.onChanged.waitForListener())
    mock.onChanged.emit()
    expect(yield* Fiber.join(again)).toEqual([undefined])
    expect(mock.onChanged.listenerCount).toBe(0)
  }))

  it.effect("removes the listener when interrupted, with or without buffered changes", () => Effect.gen(function*() {
    for (const buffered of [0, 1, 64, 65]) {
      const mock = mockApi()
      const fiber = yield* Effect.forkScoped(Stream.runDrain(make(mock.api).onChanged.pipe(Stream.mapEffect(() => Effect.never))))
      yield* Effect.promise(() => mock.onChanged.waitForListener())

      for (let index = 0; index < buffered; index++) mock.onChanged.emit()

      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(mock.onChanged.listenerCount).toBe(0)
    }
  }))

  it.effect("keeps only the newest 64 changes while the consumer falls behind", () => Effect.gen(function*() {
    const mock = mockApi()
    const fiber = yield* Effect.forkScoped(Stream.runHead(Stream.chunks(make(mock.api).onChanged)))
    yield* Effect.promise(() => mock.onChanged.waitForListener())

    for (let index = 0; index < 100; index++) mock.onChanged.emit()

    expect(Option.map(yield* Fiber.join(fiber), (chunk) => chunk.length)).toEqual(Option.some(64))
    expect(mock.onChanged.listenerCount).toBe(0)
  }))

  it.effect("ignores a late call to a listener Chrome has already removed", () => Effect.gen(function*() {
    const listeners: Array<() => void> = []
    let registered!: () => void
    const added = new Promise<void>((resolve) => { registered = resolve })

    // Keeps the listener after removal, as a dispatch already in flight in Chrome would.
    const source = {
      addListener: (listener: () => void) => {
        listeners.push(listener)
        registered()
      },
      removeListener: vi.fn((_listener: () => void) => undefined)
    }

    const { api } = mockApi()
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(make({ ...api, onChanged: source }).onChanged, 1)))
    yield* Effect.promise(() => added)
    listeners[0]?.()
    expect(yield* Fiber.join(fiber)).toEqual([undefined])
    expect(source.removeListener).toHaveBeenCalledExactlyOnceWith(listeners[0])
    expect(() => listeners[0]?.()).not.toThrow()
  }))

  it.effect("looks the event up only when a consumption starts", () => Effect.gen(function*() {
    const mock = mockApi()
    let lookups = 0

    const api: ChromeSessionsApi = {
      ...mock.api,
      get onChanged() {
        lookups++

        return mock.api.onChanged
      }
    }

    const stream = make(api).onChanged
    expect(lookups).toBe(0)

    for (const expected of [1, 2]) {
      const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(stream, 1)))
      yield* Effect.promise(() => mock.onChanged.waitForListener())
      mock.onChanged.emit()
      yield* Fiber.join(fiber)
      expect(lookups).toBe(expected)
    }
  }))

  it.effect("types a failing lookup, registration or partial registration as onChanged, leaving no listener", () => Effect.gen(function*() {
    const cause = new Error("event unavailable")
    const lookup = mockApi()

    const throwingLookup: ChromeSessionsApi = {
      ...lookup.api,
      get onChanged(): ChromeSessionsApi["onChanged"] { throw cause }
    }

    const lookupError = yield* Effect.flip(Stream.runDrain(make(throwingLookup).onChanged))
    expect(lookupError).toBeInstanceOf(ChromeSessionsError)
    expect(lookupError).toMatchObject({ operation: "onChanged", cause })

    const registration = mockApi()
    registration.onChanged.failNext("addListener", cause)
    expect(yield* Effect.flip(Stream.runDrain(make(registration.api).onChanged))).toMatchObject({ operation: "onChanged", cause })
    expect(registration.onChanged.listenerCount).toBe(0)

    const partial = partlyFailingSource(cause)
    const partialError = yield* Effect.flip(Stream.runDrain(make({ ...mockApi().api, onChanged: partial }).onChanged))
    expect(partialError).toMatchObject({ operation: "onChanged", cause })
    expect(partial.listeners.size).toBe(0)
  }))

  it.effect("provides an injected API through layer", () => Effect.gen(function*() {
    const { api } = mockApi()
    expect(yield* Effect.flatMap(ChromeSessions, (sessions) => sessions.restore()).pipe(Effect.provide(layer(api)))).toBe(session)
    expect(api.restore).toHaveBeenCalledExactlyOnceWith()
  }))

  it.effect("fails layerLive with initialize when chrome or chrome.sessions is missing", () => Effect.gen(function*() {
    for (const global of [undefined, {}, { sessions: undefined }]) {
      vi.stubGlobal("chrome", global)
      const error = yield* Effect.flip(ChromeSessions.pipe(Effect.provide(layerLive)))
      expect(error).toBeInstanceOf(ChromeSessionsError)
      expect(error.operation).toBe("initialize")
      expect(String(error.cause)).toContain("chrome.sessions is unavailable in this context")
    }
  }))

  it.effect("reads chrome.sessions each time layerLive builds", () => Effect.gen(function*() {
    const first = mockApi()
    const second = mockApi()
    vi.stubGlobal("chrome", { sessions: first.api })
    expect(yield* Effect.flatMap(ChromeSessions, (sessions) => sessions.getDevices()).pipe(Effect.provide(layerLive))).toEqual([device])
    vi.stubGlobal("chrome", { sessions: second.api })
    yield* Effect.flatMap(ChromeSessions, (sessions) => sessions.getRecentlyClosed({ maxResults: 2 })).pipe(Effect.provide(layerLive))
    expect(first.api.getDevices).toHaveBeenCalledTimes(1)
    expect(first.api.getRecentlyClosed).not.toHaveBeenCalled()
    expect(second.api.getRecentlyClosed).toHaveBeenCalledExactlyOnceWith({ maxResults: 2 })
  }))
})

describe("makeSessions", () => {
  it.effect("starts with nothing closed, no devices, and nothing to restore", () => Effect.gen(function*() {
    const fixture = makeSessions()
    const sessions = yield* ChromeSessions.pipe(Effect.provide(fixture.layer))
    expect(yield* sessions.getRecentlyClosed()).toEqual([])
    expect(yield* sessions.getDevices()).toEqual([])
    const error = yield* Effect.flip(sessions.restore())
    expect(error).toMatchObject({ operation: "restore" })
    expect(String(error.cause)).toContain("There are no recently closed sessions.")
    expect(fixture.controls.onChanged.listenerCount).toBe(0)
  }))

  it.effect("records closed tabs and windows most recent first, as Chrome reports them", () => Effect.gen(function*() {
    const fixture = makeSessions()
    const sessions = make(fixture.api)
    fixture.controls.setTime(1_700_000_000)
    const tab = fixture.controls.closeTab({ id: 99, url: "https://example.com/", title: "Example", pinned: true })
    fixture.controls.setTime(1_700_000_005)
    const window = fixture.controls.closeWindow({ id: 12, state: "maximized" }, [{ url: "https://a.test/" }, { url: "https://b.test/" }])
    expect(tab).toEqual({
      lastModified: 1_700_000_000,
      tab: {
        sessionId: "1", index: 0, windowId: -1, highlighted: false, active: false, pinned: true, incognito: false, discarded: false,
        autoDiscardable: true, groupId: -1, frozen: false, selected: false, lastAccessed: 0, url: "https://example.com/", title: "Example"
      }
    })
    expect(tab.tab?.id).toBeUndefined()
    expect(window.lastModified).toBe(1_700_000_005)
    expect(window.window).toMatchObject({ sessionId: "2", focused: false, incognito: false, type: "normal", state: "maximized" })
    expect(window.window?.id).toBeUndefined()
    expect(window.window?.tabs?.map((closed) => [closed.sessionId, closed.index, closed.active, closed.url])).toEqual([
      ["3", 0, true, "https://a.test/"],
      ["4", 1, false, "https://b.test/"]
    ])
    expect(yield* sessions.getRecentlyClosed()).toEqual([window, tab])
    expect(fixture.controls.recentlyClosed()).toEqual([window, tab])
    expect(() => fixture.controls.closeWindow({}, [])).toThrow("A closed window has at least one tab")
  }))

  it.effect("keeps Chrome's newest 25 entries and honours maxResults", () => Effect.gen(function*() {
    const fixture = makeSessions()
    const sessions = make(fixture.api)

    for (let index = 0; index < 30; index++) fixture.controls.closeTab({ title: `tab ${index}` })

    const titles = (list: ReadonlyArray<Session>) => list.map((entry) => entry.tab?.title)
    const newest = Array.from({ length: 25 }, (_, index) => `tab ${29 - index}`)
    expect(titles(yield* sessions.getRecentlyClosed())).toEqual(newest)
    expect(titles(yield* sessions.getRecentlyClosed({}))).toEqual(newest)
    expect(titles(yield* sessions.getRecentlyClosed({ maxResults: 25 }))).toEqual(newest)
    expect(titles(yield* sessions.getRecentlyClosed({ maxResults: 3 }))).toEqual(newest.slice(0, 3))
    expect(yield* sessions.getRecentlyClosed({ maxResults: 0 })).toEqual([])
  }))

  it.effect("refuses an invalid maxResults synchronously, as Chrome's bindings do", () => Effect.gen(function*() {
    const fixture = makeSessions()
    const sessions = make(fixture.api)

    for (const maxResults of [26, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => fixture.api.getRecentlyClosed({ maxResults })).toThrow(TypeError)
      expect(() => fixture.api.getDevices({ maxResults })).toThrow(TypeError)
      const closed = yield* Effect.flip(sessions.getRecentlyClosed({ maxResults }))
      const devices = yield* Effect.flip(sessions.getDevices({ maxResults }))
      expect(closed).toMatchObject({ operation: "getRecentlyClosed" })
      expect(String(closed.cause)).toContain("maxResults")
      expect(devices).toMatchObject({ operation: "getDevices" })
    }
  }))

  it.effect("restores the most recent entry as a live tab, firing onChanged twice", () => Effect.gen(function*() {
    const fixture = makeSessions()
    const sessions = make(fixture.api)
    fixture.controls.closeTab({ title: "older" })
    fixture.controls.closeTab({ title: "newer", url: "https://newer.test/" })
    fixture.controls.setTime(1_800_000_000)
    const changes = yield* Effect.forkScoped(Stream.runCollect(Stream.take(sessions.onChanged, 2)))
    yield* Effect.promise(() => fixture.controls.onChanged.waitForListener())
    const restored = yield* sessions.restore()
    expect(yield* Fiber.join(changes)).toHaveLength(2)
    expect(restored.lastModified).toBe(1_800_000_000)
    expect(restored.tab).toMatchObject({ id: 1, title: "newer", url: "https://newer.test/" })
    expect(restored.tab?.sessionId).toBeUndefined()
    expect(restored.window).toBeUndefined()
    expect((yield* sessions.getRecentlyClosed()).map((entry) => entry.tab?.title)).toEqual(["older"])
  }))

  it.effect("restores a whole window or one of its tabs by session id", () => Effect.gen(function*() {
    const fixture = makeSessions()
    const sessions = make(fixture.api)
    const window = fixture.controls.closeWindow({}, [{ title: "a" }, { title: "b" }, { title: "c" }])
    const [a, b, c] = window.window?.tabs ?? []
    const emissions = vi.fn()
    fixture.api.onChanged.addListener(emissions)
    fixture.controls.setTime(1_900_000_000)

    const single = yield* sessions.restore(b?.sessionId ?? "")
    expect(single.tab).toMatchObject({ id: 1, title: "b" })
    expect(single.tab?.sessionId).toBeUndefined()
    expect(single.lastModified).toBe(1_900_000_000)
    expect(window.lastModified).toBe(0)
    expect(emissions).toHaveBeenCalledTimes(1)
    expect((yield* sessions.getRecentlyClosed())[0]?.window?.tabs?.map((tab) => tab.title)).toEqual(["a", "c"])

    yield* sessions.restore(a?.sessionId ?? "")
    expect(emissions).toHaveBeenCalledTimes(2)
    yield* sessions.restore(c?.sessionId ?? "")
    expect(emissions).toHaveBeenCalledTimes(4)
    expect(yield* sessions.getRecentlyClosed()).toEqual([])

    const whole = fixture.controls.closeWindow({ type: "popup" }, [{ title: "x" }, { title: "y" }])
    const reopened = yield* sessions.restore(whole.window?.sessionId ?? "")
    expect(reopened.window).toMatchObject({ id: 4, type: "popup" })
    expect(reopened.window?.sessionId).toBeUndefined()
    expect(reopened.window?.tabs?.map((tab) => [tab.id, tab.windowId, tab.sessionId, tab.title])).toEqual([
      [5, 4, undefined, "x"],
      [6, 4, undefined, "y"]
    ])
    expect(emissions).toHaveBeenCalledTimes(7)
    expect(yield* sessions.getRecentlyClosed()).toEqual([])
    fixture.api.onChanged.removeListener(emissions)
  }))

  it.effect("rejects unknown, malformed and already restored ids with Chrome's message", () => Effect.gen(function*() {
    const fixture = makeSessions()
    const sessions = make(fixture.api)
    const tab = fixture.controls.closeTab()
    yield* sessions.restore(tab.tab?.sessionId ?? "")

    for (const sessionId of [tab.tab?.sessionId ?? "", "999", "", "abc", "tag.", ".5", "tag.5"]) {
      const error = yield* Effect.flip(sessions.restore(sessionId))
      expect(error).toMatchObject({ operation: "restore" })
      expect(String(error.cause)).toContain(`Invalid session id: "${sessionId}".`)
    }

    expect(yield* sessions.getRecentlyClosed()).toEqual([])
  }))

  it.effect("lists synced devices, limiting each device's sessions, and restores them without changing anything", () => Effect.gen(function*() {
    const fixture = makeSessions()
    const sessions = make(fixture.api)
    const emissions = vi.fn()
    fixture.api.onChanged.addListener(emissions)

    const windows: Array<Session> = Array.from({ length: 30 }, (_, index) => ({
      lastModified: 1000 - index,
      window: {
        sessionId: `phone.${index}`, focused: false, alwaysOnTop: false, incognito: false,
        tabs: [{ ...closedTab, sessionId: `phone.${100 + index}`, title: `tab ${index}` }]
      }
    }))

    fixture.controls.setDevices([{ deviceName: "Phone", sessions: windows }, { deviceName: "Tablet", sessions: [] }])
    const all = yield* sessions.getDevices()
    expect(all.map((entry) => [entry.deviceName, entry.sessions.length])).toEqual([["Phone", 25], ["Tablet", 0]])
    expect((yield* sessions.getDevices({ maxResults: 2 })).map((entry) => entry.sessions.map((window) => window.window?.sessionId))).toEqual([
      ["phone.0", "phone.1"],
      []
    ])

    const restoredWindow = yield* sessions.restore("phone.1")
    expect(restoredWindow.window?.sessionId).toBeUndefined()
    expect(restoredWindow.window?.tabs?.[0]).toMatchObject({ title: "tab 1", windowId: restoredWindow.window?.id })
    const restoredTab = yield* sessions.restore("phone.102")
    expect(restoredTab.tab).toMatchObject({ title: "tab 2" })
    expect(restoredTab.tab?.id).toEqual(expect.any(Number))
    expect(yield* sessions.getDevices()).toEqual(all)
    expect(yield* sessions.getRecentlyClosed()).toEqual([])
    expect(emissions).not.toHaveBeenCalled()
    fixture.api.onChanged.removeListener(emissions)
  }))

  it.effect("returns copies, so callers cannot change the fixture's state", () => Effect.gen(function*() {
    const fixture = makeSessions()
    const sessions = make(fixture.api)
    const devices: Array<Device> = [{ deviceName: "Laptop", sessions: [windowSession] }]
    fixture.controls.setDevices(devices)
    devices[0]?.sessions.splice(0)
    const recorded = fixture.controls.closeTab({ title: "kept" })

    if (recorded.tab !== undefined) recorded.tab.title = "changed"

    const listed = yield* sessions.getRecentlyClosed()
    listed.splice(0)
    fixture.controls.recentlyClosed().splice(0)
    const listedDevices = yield* sessions.getDevices()
    listedDevices[0]?.sessions.splice(0)
    expect((yield* sessions.getRecentlyClosed()).map((entry) => entry.tab?.title)).toEqual(["kept"])
    expect((yield* sessions.getDevices())[0]?.sessions).toEqual([windowSession])
  }))

  it.effect("fires onChanged on every close, eviction included, and on clear", () => Effect.gen(function*() {
    const fixture = makeSessions()
    const emissions = vi.fn()
    fixture.api.onChanged.addListener(emissions)

    for (let index = 0; index < 26; index++) fixture.controls.closeTab()

    expect(emissions).toHaveBeenCalledTimes(26)
    fixture.controls.clear()
    expect(emissions).toHaveBeenCalledTimes(27)
    expect(yield* make(fixture.api).getRecentlyClosed()).toEqual([])
    fixture.controls.setDevices([device])
    expect(emissions).toHaveBeenCalledTimes(27)
    fixture.api.onChanged.removeListener(emissions)
  }))

  it.effect("replaces members through overrides, keeping the rest", () => Effect.gen(function*() {
    const cause = new Error("Can not restore sessions in incognito mode.")
    const fixture = makeSessions({ restore: () => Promise.reject(cause) })
    fixture.controls.closeTab()
    const sessions = yield* ChromeSessions.pipe(Effect.provide(fixture.layer))
    expect(yield* Effect.flip(sessions.restore())).toMatchObject({ operation: "restore", cause })
    expect(yield* sessions.getRecentlyClosed()).toHaveLength(1)
  }))
})
