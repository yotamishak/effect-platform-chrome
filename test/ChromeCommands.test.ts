// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Cause, Deferred, Effect, Exit, Fiber, Option, Stream } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeCommands, ChromeCommandsError, layer, layerLive, make } from "../src/ChromeCommands.js"
import type { ChromeCommandsApi, CommandEvent } from "../src/ChromeCommands.js"
import { makeEvent } from "../src/testing/Event.js"
import { makeCommands } from "../src/testing/Commands.js"

const tab: chrome.tabs.Tab = {
  id: 7, index: 0, windowId: 1, highlighted: false, active: true, pinned: false, incognito: false,
  discarded: false, autoDiscardable: true, groupId: -1, frozen: false, selected: true, lastAccessed: 0
}

const commands: ReadonlyArray<chrome.commands.Command> = [
  { name: "_execute_action", description: "", shortcut: "Ctrl+Shift+E" },
  { name: "toggle-reader", description: "Toggle reader mode", shortcut: "Ctrl+Shift+Y" },
  { name: "capture", description: "Capture the page", shortcut: "" }
]

/**
 * A fresh API per test: `getAll` resolves a copy, the event's listener calls are spied, and
 * `waitForListeners(n)` resolves once `n` listeners are registered at the same time.
 */
const mockApi = () => {
  const onCommand = makeEvent<[string, chrome.tabs.Tab?]>()
  const waiters: Array<{ readonly count: number, readonly resolve: () => void }> = []

  const source = {
    addListener: vi.fn((listener: (command: string, tab?: chrome.tabs.Tab) => void) => {
      onCommand.api.addListener(listener)

      for (const waiter of waiters.filter(({ count }) => onCommand.controls.listenerCount >= count)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve()
      }
    }),
    removeListener: vi.fn(onCommand.api.removeListener)
  }

  const api = {
    getAll: vi.fn(async (): Promise<Array<chrome.commands.Command>> => structuredClone([...commands])),
    onCommand: source
  } satisfies ChromeCommandsApi

  const waitForListeners = (count: number) => Effect.promise(() => onCommand.controls.listenerCount >= count
    ? Promise.resolve()
    : new Promise<void>((resolve) => { waiters.push({ count, resolve }) }))

  return { api, source, event: onCommand.api, onCommand: onCommand.controls, waitForListeners }
}

const collect = (count: number, stream: Stream.Stream<CommandEvent, ChromeCommandsError>) =>
  Effect.forkScoped(Stream.runCollect(Stream.take(stream, count)))

describe("ChromeCommands.getAll", () => {
  it.effect("is lazy and queries the commands afresh, with no arguments, on each run", () => Effect.gen(function*() {
    const { api } = mockApi()
    const getAll = make(api).getAll
    expect(api.getAll).not.toHaveBeenCalled()
    expect(yield* getAll).toEqual(commands)
    api.getAll.mockResolvedValueOnce([{ ...commands[1], shortcut: "Alt+R" }])
    expect(yield* getAll).toEqual([{ ...commands[1], shortcut: "Alt+R" }])
    expect(api.getAll.mock.calls).toEqual([[], []])
  }))

  it.effect("keeps an empty list a list and passes partial commands through unchanged", () => Effect.gen(function*() {
    const { api } = mockApi()
    const result: Array<chrome.commands.Command> = [{}, { name: "only-name" }, { shortcut: "" }]
    api.getAll.mockResolvedValueOnce([])
    api.getAll.mockResolvedValueOnce(result)
    const getAll = make(api).getAll
    expect(yield* getAll).toEqual([])
    expect(yield* getAll).toBe(result)
  }))

  it.effect.each([
    ["an Error", new Error("commands unavailable")],
    ["a string", "Extension context invalidated."],
    ["undefined", undefined]
  ] as const)("types a rejection and a synchronous throw of %s as getAll", (_label, cause) => Effect.gen(function*() {
    for (const synchronous of [false, true]) {
      const { api } = mockApi()

      if (synchronous) {
        api.getAll.mockImplementationOnce(() => { throw cause })
      } else {
        api.getAll.mockImplementationOnce(() => Promise.reject(cause))
      }

      const error = yield* Effect.flip(make(api).getAll)
      expect(error).toBeInstanceOf(ChromeCommandsError)
      expect(error._tag).toBe("ChromeCommandsError")
      expect(error.operation).toBe("getAll")
      expect(error.cause).toBe(cause)
      expect(yield* make(api).getAll).toEqual(commands)
    }
  }))
})

describe("ChromeCommands.onCommand", () => {
  it.effect("reads the event only when a run starts, once per run", () => Effect.gen(function*() {
    const mock = mockApi()
    let reads = 0

    const api: ChromeCommandsApi = {
      getAll: mock.api.getAll,
      get onCommand() {
        reads++

        return mock.source
      }
    }

    const stream = make(api).onCommand
    expect(reads).toBe(0)

    for (const run of [1, 2]) {
      const fiber = yield* collect(1, stream)
      yield* Effect.promise(() => mock.onCommand.waitForListener())
      expect(reads).toBe(run)
      mock.onCommand.emit("capture")
      expect(yield* Fiber.join(fiber)).toEqual([{ command: "capture", tab: Option.none() }])
    }

    expect(mock.source.addListener).toHaveBeenCalledTimes(2)
  }))

  it.effect("emits commands in order with the tab as an Option, identical to Chrome's", () => Effect.gen(function*() {
    const mock = mockApi()
    const fiber = yield* collect(4, make(mock.api).onCommand)
    yield* Effect.promise(() => mock.onCommand.waitForListener())
    expect(mock.source.addListener.mock.calls[0]).toHaveLength(1)
    mock.onCommand.emit("toggle-reader", tab)
    mock.onCommand.emit("capture")
    mock.onCommand.emit("capture", undefined)
    mock.onCommand.emit("", tab)
    const events = yield* Fiber.join(fiber)
    expect(events).toEqual([
      { command: "toggle-reader", tab: Option.some(tab) },
      { command: "capture", tab: Option.none() },
      { command: "capture", tab: Option.none() },
      { command: "", tab: Option.some(tab) }
    ])
    expect(Option.getOrThrow(events[0]?.tab ?? Option.none())).toBe(tab)
    expect(mock.onCommand.listenerCount).toBe(0)
  }))

  it.effect("maps a null tab from a native binding to None", () => Effect.gen(function*() {
    const mock = mockApi()
    const fiber = yield* collect(2, make(mock.api).onCommand)
    yield* Effect.promise(() => mock.onCommand.waitForListener())
    // SAFETY: Chrome's schema marks `tab` optional; this simulates a native binding passing null.
    mock.onCommand.emit("capture", null as never)
    mock.onCommand.emit("capture", tab)
    expect(yield* Fiber.join(fiber)).toEqual([{ command: "capture", tab: Option.none() }, { command: "capture", tab: Option.some(tab) }])
  }))

  it.effect("ignores events emitted before a run and after it ends", () => Effect.gen(function*() {
    const mock = mockApi()
    const stream = make(mock.api).onCommand
    expect(mock.onCommand.emit("early")).toEqual([])
    const fiber = yield* collect(1, stream)
    yield* Effect.promise(() => mock.onCommand.waitForListener())
    mock.onCommand.emit("first")
    mock.onCommand.emit("second")
    expect(yield* Fiber.join(fiber)).toEqual([{ command: "first", tab: Option.none() }])
    expect(mock.onCommand.listenerCount).toBe(0)
    expect(mock.onCommand.emit("late")).toEqual([])
  }))

  it.effect("gives every run its own listener and removes exactly the one it added", () => Effect.gen(function*() {
    const mock = mockApi()
    const stream = make(mock.api).onCommand
    const short = yield* collect(1, stream)
    const long = yield* collect(2, stream)
    yield* mock.waitForListeners(2)
    expect(mock.onCommand.listenerCount).toBe(2)
    mock.onCommand.emit("a", tab)
    expect(yield* Fiber.join(short)).toEqual([{ command: "a", tab: Option.some(tab) }])
    expect(mock.onCommand.listenerCount).toBe(1)
    mock.onCommand.emit("b")
    expect(yield* Fiber.join(long)).toEqual([{ command: "a", tab: Option.some(tab) }, { command: "b", tab: Option.none() }])
    const added = mock.source.addListener.mock.calls.map(([listener]) => listener)
    const removed = mock.source.removeListener.mock.calls.map(([listener]) => listener)
    expect(new Set(added).size).toBe(2)
    expect(removed).toHaveLength(2)
    expect(new Set(removed)).toEqual(new Set(added))
  }))

  it.effect("removes its listener when interrupted while waiting or while a consumer is busy", () => Effect.gen(function*() {
    const mock = mockApi()
    const stream = make(mock.api).onCommand
    const waiting = yield* Effect.forkScoped(Stream.runDrain(stream))
    yield* Effect.promise(() => mock.onCommand.waitForListener())
    yield* Fiber.interrupt(waiting)
    expect(Exit.hasInterrupts(yield* Fiber.await(waiting))).toBe(true)
    expect(mock.onCommand.listenerCount).toBe(0)

    const entered = yield* Deferred.make<void>()
    const never = yield* Deferred.make<void>()
    const blocked = Stream.mapEffect(stream, () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(never))))
    const busy = yield* Effect.forkScoped(Stream.runDrain(blocked))
    yield* Effect.promise(() => mock.onCommand.waitForListener())
    mock.onCommand.emit("a")
    yield* Deferred.await(entered)
    mock.onCommand.emit("b")
    yield* Fiber.interrupt(busy)
    expect(mock.onCommand.listenerCount).toBe(0)
    expect(mock.source.removeListener).toHaveBeenCalledTimes(2)
    expect(mock.onCommand.emit("c")).toEqual([])
  }))

  it.effect("removes its listener when the consumer fails downstream", () => Effect.gen(function*() {
    const mock = mockApi()
    const failure = new ChromeCommandsError({ operation: "consumer", cause: "downstream" })
    const fiber = yield* Effect.forkScoped(Stream.runDrain(Stream.mapEffect(make(mock.api).onCommand, () => Effect.fail(failure))))
    yield* Effect.promise(() => mock.onCommand.waitForListener())
    mock.onCommand.emit("capture")
    expect(yield* Effect.flip(Fiber.join(fiber))).toBe(failure)
    expect(mock.onCommand.listenerCount).toBe(0)
  }))

  it.effect("types a listener registration throw and removes the half-registered listener", () => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("listener unavailable")
    mock.onCommand.failNext("addListener", cause)
    const error = yield* Effect.flip(Stream.runDrain(make(mock.api).onCommand))
    expect(error).toBeInstanceOf(ChromeCommandsError)
    expect(error).toMatchObject({ operation: "onCommand", cause })
    expect(mock.source.removeListener).toHaveBeenCalledExactlyOnceWith(mock.source.addListener.mock.calls[0]?.[0])
    expect(mock.onCommand.listenerCount).toBe(0)

    const partial = mockApi()
    partial.source.addListener.mockImplementationOnce((listener) => {
      // The listener is registered, and even called, before the registration throws.
      partial.event.addListener(listener)
      listener("registered-then-threw")
      throw cause
    })
    expect(yield* Effect.flip(Stream.runDrain(make(partial.api).onCommand))).toMatchObject({ operation: "onCommand", cause })
    expect(partial.source.removeListener).toHaveBeenCalledExactlyOnceWith(partial.source.addListener.mock.calls[0]?.[0])
    expect(partial.onCommand.listenerCount).toBe(0)
    expect(partial.onCommand.emit("after")).toEqual([])
  }))

  it.effect("types a throwing event getter without touching any listener", () => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("'commands.onCommand' is not available in this context")

    const api: ChromeCommandsApi = {
      getAll: mock.api.getAll,
      get onCommand(): ChromeCommandsApi["onCommand"] { throw cause }
    }

    const error = yield* Effect.flip(Stream.runDrain(make(api).onCommand))
    expect(error).toBeInstanceOf(ChromeCommandsError)
    expect(error).toMatchObject({ operation: "onCommand", cause })
    expect(mock.source.addListener).not.toHaveBeenCalled()
    expect(mock.source.removeListener).not.toHaveBeenCalled()
  }))

  it.effect("surfaces a removeListener throw as a defect and leaves the stale listener inert", () => Effect.gen(function*() {
    const mock = mockApi()
    const cause = new Error("removal failed")
    const fiber = yield* Effect.forkScoped(Stream.runCollect(make(mock.api).onCommand))
    yield* Effect.promise(() => mock.onCommand.waitForListener())
    mock.onCommand.failNext("removeListener", cause)
    yield* Fiber.interrupt(fiber)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toBe(cause)
    expect(mock.onCommand.listenerCount).toBe(1)
    expect(mock.onCommand.emit("after")).toEqual([])
  }))
})

describe("ChromeCommands layers", () => {
  it.effect("provides an injected API through layer", () => Effect.gen(function*() {
    const { api } = mockApi()
    const service = yield* ChromeCommands.pipe(Effect.provide(layer(api)))
    expect(yield* service.getAll).toEqual(commands)
    expect(api.getAll).toHaveBeenCalledTimes(1)
  }))

  it.effect.each([
    ["no chrome global", undefined],
    ["chrome without commands", {}],
    ["chrome with commands undefined", { commands: undefined }]
  ] as const)("fails layerLive with initialize given %s", (_label, global) => Effect.gen(function*() {
    vi.stubGlobal("chrome", global)
    const error = yield* Effect.flip(ChromeCommands.pipe(Effect.provide(layerLive)))
    expect(error).toBeInstanceOf(ChromeCommandsError)
    expect(error.operation).toBe("initialize")
    expect(error.cause).toBeInstanceOf(Error)
    expect(String(error.cause)).toContain("chrome.commands is unavailable")
  }))

  it.effect("reads the global each time layerLive builds, never at import", () => Effect.gen(function*() {
    expect(Reflect.has(globalThis, "chrome")).toBe(false)
    const first = mockApi()
    vi.stubGlobal("chrome", { commands: first.api })
    const service = yield* ChromeCommands.pipe(Effect.provide(layerLive))
    const fiber = yield* collect(1, service.onCommand)
    yield* Effect.promise(() => first.onCommand.waitForListener())
    first.onCommand.emit("capture", tab)
    expect(yield* Fiber.join(fiber)).toEqual([{ command: "capture", tab: Option.some(tab) }])

    const second = mockApi()
    second.api.getAll.mockResolvedValueOnce([])
    vi.stubGlobal("chrome", { commands: second.api })
    expect(yield* Effect.flatMap(ChromeCommands, (each) => each.getAll).pipe(Effect.provide(layerLive))).toEqual([])
    expect(yield* service.getAll).toEqual(commands)
    expect(first.api.getAll).toHaveBeenCalledTimes(1)
    expect(second.api.getAll).toHaveBeenCalledTimes(1)
  }))

  it.effect("fails a composed program in the typed channel without calling Chrome", () => Effect.gen(function*() {
    const { api } = mockApi()
    vi.stubGlobal("chrome", { runtime: { commands: api } })
    const program = Effect.flatMap(ChromeCommands, (each) => each.getAll)
    const error = yield* Effect.flip(program.pipe(Effect.provide(layerLive)))
    expect(error).toBeInstanceOf(ChromeCommandsError)
    expect(error.operation).toBe("initialize")
    expect(api.getAll).not.toHaveBeenCalled()
  }))
})

describe("testing/Commands", () => {
  it.effect("reports declared commands in order as copies isolated from callers and the input", () => Effect.gen(function*() {
    const input = structuredClone([...commands])
    const fixture = makeCommands(input)
    input[1] = { name: "mutated" }
    const service = yield* ChromeCommands.pipe(Effect.provide(fixture.layer))
    const first = yield* service.getAll
    expect(first).toEqual(commands)
    first.splice(0)
    const second = yield* service.getAll
    expect(second).toEqual(commands)
    expect(second).not.toBe(first)
    const snapshot = fixture.controls.commands
    snapshot[0] = {}
    expect(fixture.controls.commands).toEqual(commands)
    expect(yield* make(makeCommands().api).getAll).toEqual([])
  }))

  it.effect("updates shortcuts seen by later getAll runs", () => Effect.gen(function*() {
    const fixture = makeCommands(commands)
    const getAll = make(fixture.api).getAll
    fixture.controls.setShortcut("capture", "Alt+Shift+C")
    fixture.controls.setShortcut("toggle-reader", "")
    expect((yield* getAll).map((command) => command.shortcut)).toEqual(["Ctrl+Shift+E", "", "Alt+Shift+C"])
  }))

  it.effect("dispatches presses only for bound, unreserved commands, cloning the tab", () => Effect.gen(function*() {
    const fixture = makeCommands([...commands, { name: "_execute_browser_action", shortcut: "Alt+B" }, { name: "unset" }])
    const fiber = yield* collect(2, make(fixture.api).onCommand)
    yield* Effect.promise(() => fixture.controls.onCommand.waitForListener())
    expect(fixture.controls.press("_execute_action", tab)).toEqual({ dispatched: false, errors: [] })
    expect(fixture.controls.press("_execute_browser_action")).toEqual({ dispatched: false, errors: [] })
    expect(fixture.controls.press("capture")).toEqual({ dispatched: false, errors: [] })
    expect(fixture.controls.press("unset")).toEqual({ dispatched: false, errors: [] })
    expect(fixture.controls.press("toggle-reader", tab)).toEqual({ dispatched: true, errors: [] })
    fixture.controls.setShortcut("capture", "Alt+C")
    expect(fixture.controls.press("capture")).toEqual({ dispatched: true, errors: [] })
    const events = yield* Fiber.join(fiber)
    expect(events).toEqual([
      { command: "toggle-reader", tab: Option.some(tab) },
      { command: "capture", tab: Option.none() }
    ])
    expect(Option.getOrThrow(events[0]?.tab ?? Option.none())).not.toBe(tab)
  }))

  it.effect("returns listener exceptions from a press after running every listener", () => Effect.gen(function*() {
    const fixture = makeCommands(commands)
    const failure = new Error("listener failed")
    const seen: Array<string> = []
    fixture.api.onCommand.addListener(() => { throw failure })
    fixture.api.onCommand.addListener((command) => { seen.push(command) })
    expect(fixture.controls.press("toggle-reader")).toEqual({ dispatched: true, errors: [failure] })
    expect(seen).toEqual(["toggle-reader"])
    yield* Effect.void
  }))

  it.effect("rejects unknown and duplicate command names and applies overrides", () => Effect.gen(function*() {
    const fixture = makeCommands(commands)
    expect(() => fixture.controls.press("missing")).toThrow("No command named missing is declared")
    expect(() => fixture.controls.setShortcut("missing", "Alt+M")).toThrow("No command named missing is declared")
    expect(() => makeCommands([{ name: "twice" }, { name: "twice" }])).toThrow("Duplicate command name: twice")
    expect(makeCommands([{}, {}]).controls.commands).toEqual([{}, {}])
    const cause = new Error("overridden")
    const overridden = makeCommands(commands, { getAll: () => Promise.reject(cause) })
    expect(yield* Effect.flip(make(overridden.api).getAll)).toMatchObject({ operation: "getAll", cause })
  }))
})
