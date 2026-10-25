// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Exit, Fiber, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChromeActionError, make } from "../../src/ChromeAction.js"
import type { ChromeActionApi, ChromeActionService, ColorArray } from "../../src/ChromeAction.js"
import { makeAction } from "../../src/testing/Action.js"
import { makeEvent } from "../../src/testing/Event.js"
import type { EventSource } from "../../src/internal/event.js"

/** A small deterministic generator (mulberry32), so every run churns the same way. */
const seeded = (seed: number) => {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <A>(random: () => number, values: ReadonlyArray<A>): A => {
  const value = values[Math.floor(random() * values.length)]

  if (value === undefined) throw new Error("pick needs a non-empty list")

  return value
}

const tab: chrome.tabs.Tab = {
  id: 1, index: 0, windowId: 1, highlighted: false, active: true, pinned: false, incognito: false,
  discarded: false, autoDiscardable: true, groupId: -1, frozen: false, selected: true, lastAccessed: 0
}

const red: ColorArray = [255, 0, 0, 255]

/** A resolvable promise used as an explicit gate. */
const gate = <A = void>() => {
  let open!: (value: A) => void
  const promise = new Promise<A>((resolve) => { open = resolve })

  return { promise, open }
}

/** What either action event emits. */
type ActionEvent = chrome.tabs.Tab | chrome.action.UserSettingsChange

/** An API whose two events are the given sources and whose calls are never reached. */
const eventApi = (
  onClicked: EventSource<[chrome.tabs.Tab]>,
  onUserSettingsChanged: EventSource<[chrome.action.UserSettingsChange]>
): ChromeActionApi => {
  const unused = () => Promise.reject(new Error("not called by event stress"))

  return {
    setBadgeText: unused, getBadgeText: unused, setBadgeBackgroundColor: unused, getBadgeBackgroundColor: unused,
    setIcon: unused, setTitle: unused, getTitle: unused, setPopup: unused, getPopup: unused, enable: unused, disable: unused,
    onClicked, onUserSettingsChanged
  }
}

/** Per-subscription hooks around a shared event, so each subscription can misbehave its own way. */
interface Hooks {
  readonly added: () => void
  onAdd?: () => void
  failBeforeAdd?: Error
  failAfterAdd?: Error
  readonly onRemove?: () => void
}

/** How a churned subscription consumes its stream: one event, a stalled element, or until interrupted. */
const consume = <A, E>(stage: string, stream: Stream.Stream<A, E>, stall: Effect.Effect<A>) => {
  if (stage === "completes") return Stream.runCollect(Stream.take(stream, 1))

  if (stage === "stalled") return Stream.runCollect(Stream.mapEffect(stream, () => stall))

  return Stream.runCollect(stream)
}

const hooked = <Args extends ReadonlyArray<unknown>>(real: EventSource<Args>, hooks: Hooks): EventSource<Args> => ({
  addListener: (listener) => {
    if (hooks.failBeforeAdd !== undefined) throw hooks.failBeforeAdd

    real.addListener(listener)
    hooks.added()
    hooks.onAdd?.()

    if (hooks.failAfterAdd !== undefined) throw hooks.failAfterAdd
  },
  removeListener: (listener) => {
    real.removeListener(listener)
    hooks.onRemove?.()
  }
})

const streams = [
  {
    operation: "onClicked",
    make: () => {
      const event = makeEvent<[chrome.tabs.Tab]>()
      const unused = makeEvent<[chrome.action.UserSettingsChange]>()

      return {
        controls: event.controls,
        emit: (index: number) => event.controls.emit({ ...tab, id: index }),
        stream: (hooks: Hooks): Stream.Stream<ActionEvent, ChromeActionError> =>
          make(eventApi(hooked(event.api, hooks), unused.api)).onClicked,
        plain: (): Stream.Stream<ActionEvent, ChromeActionError> => make(eventApi(event.api, unused.api)).onClicked
      }
    },
    expected: (index: number): ActionEvent => ({ ...tab, id: index })
  },
  {
    operation: "onUserSettingsChanged",
    make: () => {
      const event = makeEvent<[chrome.action.UserSettingsChange]>()
      const unused = makeEvent<[chrome.tabs.Tab]>()

      return {
        controls: event.controls,
        emit: (index: number) => event.controls.emit({ isOnToolbar: index % 3 === 0 }),
        stream: (hooks: Hooks): Stream.Stream<ActionEvent, ChromeActionError> =>
          make(eventApi(unused.api, hooked(event.api, hooks))).onUserSettingsChanged,
        plain: (): Stream.Stream<ActionEvent, ChromeActionError> => make(eventApi(unused.api, event.api)).onUserSettingsChanged
      }
    },
    expected: (index: number): ActionEvent => ({ isOnToolbar: index % 3 === 0 })
  }
] as const

const newest = (expected: (index: number) => ActionEvent, total: number) =>
  Array.from({ length: Math.min(total, 64) }, (_, index) => expected(Math.max(0, total - 64) + index))

describe("ChromeAction event stress", () => {
  it.effect.each(streams)("keeps exactly the newest 64 of a 4,096-event $operation burst during registration", (spec) => Effect.gen(function*() {
    const source = spec.make()
    let removals = 0

    const stream = source.stream({
      added: () => {},
      onAdd: () => { for (let index = 0; index < 4096; index++) source.emit(index) },
      onRemove: () => { removals++ }
    })

    const values = yield* Stream.runCollect(Stream.take(stream, 64))
    expect(values).toEqual(newest(spec.expected, 4096))
    expect(source.controls.listenerCount).toBe(0)
    expect(removals).toBe(1)
  }))

  it.effect.each(streams)("keeps exactly the newest 64 of a 4,096-event $operation burst into a waiting consumer", (spec) => Effect.gen(function*() {
    const source = spec.make()
    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(source.plain(), 64)))
    yield* Effect.promise(() => source.controls.waitForListener())

    for (let index = 0; index < 4096; index++) source.emit(index)

    expect(yield* Fiber.join(fiber)).toEqual(newest(spec.expected, 4096))
    expect(source.controls.listenerCount).toBe(0)
  }))

  it.effect.each(streams)("keeps 128 independent $operation subscriptions each to the newest 64 of 4,096 events", (spec) => Effect.gen(function*() {
    const source = spec.make()
    const registered = gate()
    let added = 0

    const fibers = yield* Effect.forEach(Array.from({ length: 128 }), () => Effect.forkChild(Stream.runCollect(Stream.take(source.stream({
      added: () => {
        added++

        if (added === 128) registered.open()
      }
    }), 64))))

    yield* Effect.promise(() => registered.promise)

    for (let index = 0; index < 4096; index++) source.emit(index)

    const results = yield* Effect.forEach(fibers, Fiber.join)

    for (const values of results) expect(values).toEqual(newest(spec.expected, 4096))

    expect(source.controls.listenerCount).toBe(0)
  }))

  it.effect.each(streams)("churns 512 concurrent $operation subscriptions through interruption at every stage", (spec) => Effect.gen(function*() {
    const random = seeded(spec.operation.length * 7919)
    const source = spec.make()
    const stages = ["unstarted", "registered", "stalled", "midRegistration", "reentrantRelease", "partialFailure", "refused", "completes"] as const
    const hold = gate()
    let adds = 0
    let removes = 0
    let interruptedDuringRegistration = 0

    const subscriptions = yield* Effect.forEach(Array.from({ length: 512 }, (_, index) => index), (index) => Effect.gen(function*() {
      const stage = pick(random, stages)
      const added = gate()
      const cause = new Error(`${stage} ${index}`)
      let self: Fiber.Fiber<ReadonlyArray<ActionEvent>, ChromeActionError> | undefined

      const hooks: Hooks = {
        added: () => {
          adds++
          added.open()
        },
        // Chrome dispatching to the shared event while this listener is being removed.
        onRemove: () => {
          removes++

          if (stage === "reentrantRelease") source.emit(-1)
        }
      }

      // Interruption requested while Chrome is still inside addListener.
      if (stage === "midRegistration") {
        hooks.onAdd = () => {
          if (self === undefined) return

          interruptedDuringRegistration++
          self.interruptUnsafe()
        }
      }

      if (stage === "partialFailure") hooks.failAfterAdd = cause

      if (stage === "refused") hooks.failBeforeAdd = cause

      const consumer = consume(stage, source.stream(hooks), Effect.promise(() => hold.promise).pipe(Effect.as(spec.expected(0))))

      const fiber = yield* Effect.forkChild(consumer)
      self = fiber

      if (stage === "unstarted") yield* Fiber.interrupt(fiber)

      return { stage, fiber, added, cause }
    }))

    const registering = subscriptions.filter(({ stage }) => stage !== "unstarted" && stage !== "refused")
    yield* Effect.promise(() => Promise.all(registering.map(({ added }) => added.promise)))

    for (let index = 0; index < 128; index++) source.emit(index)

    const settling = new Set(["completes", "partialFailure", "refused"])

    // Settle the self-ending subscriptions first: interrupting a reentrantRelease one emits into
    // the shared event, which would otherwise reach completing subscriptions still buffering.
    const ordered = [
      ...subscriptions.filter(({ stage }) => settling.has(stage)),
      ...subscriptions.filter(({ stage }) => !settling.has(stage))
    ]

    for (const { stage, fiber, cause } of ordered) {
      const exit = yield* (settling.has(stage) ? Fiber.await(fiber) : Effect.andThen(Fiber.interrupt(fiber), Fiber.await(fiber)))
      expect(Exit.hasDies(exit)).toBe(false)

      // The 128 events arrived in one synchronous burst, so the buffer slid to the newest 64.
      if (stage === "completes") expect(yield* exit).toEqual([spec.expected(64)])
      else if (stage === "partialFailure" || stage === "refused") {
        const error = yield* Effect.flip(exit)
        expect(error).toBeInstanceOf(ChromeActionError)
        expect(error.operation).toBe(spec.operation)
        expect(error.cause).toBe(cause)
      } else expect(Exit.hasInterrupts(exit)).toBe(true)
    }

    hold.open()
    expect(source.controls.listenerCount).toBe(0)
    // Cleanup is installed before registration, so a refused registration still removes
    // (a no-op in Chrome); every listener that was added is removed exactly once.
    expect(removes).toBe(adds + subscriptions.filter(({ stage }) => stage === "refused").length)
    expect(interruptedDuringRegistration).toBe(subscriptions.filter(({ stage }) => stage === "midRegistration").length)
    expect(new Set(subscriptions.map(({ stage }) => stage))).toEqual(new Set(stages))
  }))
})

type Mode = "ok" | "okLate" | "reject" | "rejectLate" | "throw"

const modes: ReadonlyArray<Mode> = ["ok", "okLate", "reject", "rejectLate", "throw"]

/**
 * Each call encodes its index in its arguments, so the mock knows that call's planned outcome
 * whatever order the concurrent calls reach it in. `getUserSettings` has no arguments; its
 * outcomes are planned in arrival order and checked as a set. Late outcomes settle only once
 * every call has reached the mock.
 */
const plannedApi = (total: number, plan: Map<string, Mode>) => {
  const causes = new Map<string, Error>()
  const everyCallArrived = gate()
  let arrivals = 0
  let settingsCalls = 0

  const settle = <A>(key: string, value: A): Promise<A> => {
    arrivals++

    if (arrivals === total) everyCallArrived.open()

    const mode = plan.get(key) ?? "ok"
    const cause = new Error(`${key} ${mode}`)
    causes.set(key, cause)

    switch (mode) {
      case "ok": return Promise.resolve(value)
      case "okLate": return everyCallArrived.promise.then(() => value)
      case "reject": return Promise.reject(cause)
      case "rejectLate": return everyCallArrived.promise.then(() => Promise.reject(cause))
      case "throw": throw cause
    }
  }

  const api: ChromeActionApi = {
    setBadgeText: ({ text }) => settle(`setBadgeText:${text}`, undefined),
    getBadgeText: ({ tabId }) => settle(`getBadgeText:${tabId}`, `${tabId}`),
    setBadgeBackgroundColor: ({ tabId }) => settle(`setBadgeBackgroundColor:${tabId}`, undefined),
    getBadgeBackgroundColor: ({ tabId }) => settle(`getBadgeBackgroundColor:${tabId}`, red),
    setBadgeTextColor: ({ tabId }) => settle(`setBadgeTextColor:${tabId}`, undefined),
    getBadgeTextColor: ({ tabId }) => settle(`getBadgeTextColor:${tabId}`, red),
    setIcon: ({ tabId }) => settle(`setIcon:${tabId}`, undefined),
    setTitle: ({ title }) => settle(`setTitle:${title}`, undefined),
    getTitle: ({ tabId }) => settle(`getTitle:${tabId}`, `${tabId}`),
    setPopup: ({ popup }) => settle(`setPopup:${popup}`, undefined),
    getPopup: ({ tabId }) => settle(`getPopup:${tabId}`, `${tabId}`),
    enable: (tabId) => settle(`enable:${tabId}`, undefined),
    disable: (tabId) => settle(`disable:${tabId}`, undefined),
    isEnabled: (tabId) => settle(`isEnabled:${tabId}`, true),
    openPopup: (options) => settle(`openPopup:${options?.windowId}`, undefined),
    getUserSettings: () => {
      settingsCalls++

      return settle(`getUserSettings:${settingsCalls}`, { isOnToolbar: true })
    },
    onClicked: makeEvent<[chrome.tabs.Tab]>().api,
    onUserSettingsChanged: makeEvent<[chrome.action.UserSettingsChange]>().api
  }

  return { api, causes }
}

/** Every operation, invoked for call `index` with the index in its arguments. */
const operations: ReadonlyArray<readonly [string, (action: ChromeActionService, index: number) => Effect.Effect<void | string | boolean | ColorArray | chrome.action.UserSettings, ChromeActionError>]> = [
  ["setBadgeText", (action, index) => action.setBadgeText({ text: `${index}` })],
  ["getBadgeText", (action, index) => action.getBadgeText({ tabId: index })],
  ["setBadgeBackgroundColor", (action, index) => action.setBadgeBackgroundColor({ color: red, tabId: index })],
  ["getBadgeBackgroundColor", (action, index) => action.getBadgeBackgroundColor({ tabId: index })],
  ["setBadgeTextColor", (action, index) => action.setBadgeTextColor({ color: red, tabId: index })],
  ["getBadgeTextColor", (action, index) => action.getBadgeTextColor({ tabId: index })],
  ["setIcon", (action, index) => action.setIcon({ path: "icon.png", tabId: index })],
  ["setTitle", (action, index) => action.setTitle({ title: `${index}` })],
  ["getTitle", (action, index) => action.getTitle({ tabId: index })],
  ["setPopup", (action, index) => action.setPopup({ popup: `${index}` })],
  ["getPopup", (action, index) => action.getPopup({ tabId: index })],
  ["enable", (action, index) => action.enable(index)],
  ["disable", (action, index) => action.disable(index)],
  ["isEnabled", (action, index) => action.isEnabled(index)],
  ["openPopup", (action, index) => action.openPopup({ windowId: index })],
  ["getUserSettings", (action) => action.getUserSettings]
]

describe("ChromeAction call stress", () => {
  it.effect("types 1,152 concurrent calls with interleaved rejections, late rejections and throws", () => Effect.gen(function*() {
    const random = seeded(1152)

    const calls = Array.from({ length: 1152 }, (_, index) => {
      const entry = operations[index % operations.length]

      if (entry === undefined) throw new Error("no operation")

      return { index, operation: entry[0], run: entry[1], mode: pick(random, modes) }
    })

    const plan = new Map<string, Mode>()
    const settingsModes: Array<Mode> = []

    for (const call of calls) {
      if (call.operation === "getUserSettings") {
        settingsModes.push(call.mode)
        plan.set(`getUserSettings:${settingsModes.length}`, call.mode)
      } else plan.set(`${call.operation}:${call.index}`, call.mode)
    }

    const { api, causes } = plannedApi(calls.length, plan)
    const action = make(api)
    const exits = yield* Effect.forEach(calls, (call) => Effect.exit(call.run(action, call.index)), { concurrency: "unbounded" })
    const settingsCauses = new Set<unknown>()
    let settingsFailures = 0

    for (const [position, exit] of exits.entries()) {
      const call = calls[position]

      if (call === undefined) throw new Error("missing call")

      expect(Exit.hasDies(exit)).toBe(false)
      expect(Exit.hasInterrupts(exit)).toBe(false)

      if (call.operation === "getUserSettings") {
        if (Exit.isFailure(exit)) {
          settingsFailures++
          const error = yield* Effect.flip(exit)
          expect(error).toBeInstanceOf(ChromeActionError)
          expect(error.operation).toBe("getUserSettings")
          settingsCauses.add(error.cause)
        } else expect(exit).toEqual(Exit.succeed({ isOnToolbar: true }))

        continue
      }

      const failing = call.mode === "reject" || call.mode === "rejectLate" || call.mode === "throw"
      expect(Exit.isFailure(exit)).toBe(failing)

      if (failing) {
        const error = yield* Effect.flip(exit)
        expect(error).toBeInstanceOf(ChromeActionError)
        expect(error.operation).toBe(call.operation)
        expect(error.cause).toBe(causes.get(`${call.operation}:${call.index}`))
      }
    }

    const plannedFailures = settingsModes.filter((mode) => mode !== "ok" && mode !== "okLate").length
    expect(settingsFailures).toBe(plannedFailures)
    expect(settingsCauses.size).toBe(plannedFailures)

    for (const cause of settingsCauses) {
      expect([...causes.entries()].some(([key, value]) => key.startsWith("getUserSettings:") && value === cause)).toBe(true)
    }

    expect(new Set(calls.map(({ mode }) => mode))).toEqual(new Set(modes))
  }))

  it.effect("fails 1,024 concurrent calls to members a Chrome 88 browser lacks, all typed", () => Effect.gen(function*() {
    const chrome88 = eventApi(makeEvent<[chrome.tabs.Tab]>().api, makeEvent<[chrome.action.UserSettingsChange]>().api)
    const action = make(chrome88)

    const gatedCalls = [
      ["setBadgeTextColor", action.setBadgeTextColor({ color: red })],
      ["getBadgeTextColor", action.getBadgeTextColor()],
      ["isEnabled", action.isEnabled(1)],
      ["openPopup", action.openPopup()]
    ] as const

    const errors = yield* Effect.forEach(Array.from({ length: 1024 }, (_, index) => index), (index) => {
      const entry = gatedCalls[index % gatedCalls.length]

      if (entry === undefined) return Effect.die(new Error("no call"))

      return Effect.map(Effect.flip(entry[1]), (error) => [entry[0], error] as const)
    }, { concurrency: "unbounded" })

    for (const [operation, error] of errors) {
      expect(error.operation).toBe(operation)
      expect(error.cause).toMatchObject({ message: `chrome.action.${operation} is unavailable in this browser` })
    }

    expect(errors).toHaveLength(1024)
  }))

  it.effect("abandons 512 interrupted in-flight calls whose Promises settle afterwards", () => Effect.gen(function*() {
    const pending: Array<{ readonly resolve: () => void, readonly reject: (cause: Error) => void }> = []
    const waiters = new Map<number, () => void>()

    const reached = (count: number) => new Promise<void>((resolve) => {
      if (pending.length >= count) resolve()
      else waiters.set(count, resolve)
    })

    const base = eventApi(makeEvent<[chrome.tabs.Tab]>().api, makeEvent<[chrome.action.UserSettingsChange]>().api)

    const api: ChromeActionApi = {
      ...base,
      setTitle: () => new Promise<void>((resolve, reject) => {
        pending.push({ resolve, reject })
        waiters.get(pending.length)?.()
      })
    }

    const action = make(api)

    const fibers = yield* Effect.forEach(Array.from({ length: 512 }, (_, index) => index), (index) =>
      Effect.forkChild(action.setTitle({ title: `${index}` })))

    yield* Effect.promise(() => reached(512))
    yield* Fiber.interruptAll(fibers)

    for (const [index, call] of pending.entries()) {
      if (index % 2 === 0) call.resolve()
      else call.reject(new Error(`late ${index}`))
    }

    for (const fiber of fibers) expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)

    // A call after the abandoned ones still settles with its own outcome.
    const after = yield* Effect.forkChild(Effect.flip(action.setTitle({ title: "after" })))
    yield* Effect.promise(() => reached(513))
    const cause = new Error("after")
    pending[512]?.reject(cause)
    expect(yield* Fiber.join(after)).toMatchObject({ operation: "setTitle", cause })
  }))
})

describe("makeAction stress", () => {
  it.effect("keeps 10,000 tab overrides apart and drops exactly the closed half", () => Effect.gen(function*() {
    const fixture = makeAction({ title: "Default", popup: "popup.html" })
    const action = make(fixture.api)
    const tabIds = Array.from({ length: 10_000 }, (_, index) => index)

    yield* Effect.forEach(tabIds, (tabId) => Effect.all([
      action.setBadgeText({ text: `${tabId % 1000}`, tabId }),
      action.setTitle({ title: `tab ${tabId}`, tabId }),
      action.setBadgeBackgroundColor({ color: [tabId % 256, 0, 0, 255], tabId }),
      tabId % 3 === 0 ? action.disable(tabId) : Effect.void,
      tabId % 5 === 0 ? action.setPopup({ popup: "", tabId }) : Effect.void
    ]), { concurrency: "unbounded", discard: true })

    for (const tabId of tabIds) if (tabId % 2 === 1) fixture.controls.closeTab(tabId)

    yield* action.setBadgeText({ text: "D" })

    const checks = yield* Effect.forEach(tabIds, (tabId) => Effect.exit(Effect.all([
      action.getBadgeText({ tabId }), action.getTitle({ tabId }), action.getBadgeBackgroundColor({ tabId }),
      action.isEnabled(tabId), action.getPopup({ tabId })
    ])), { concurrency: "unbounded" })

    for (const [tabId, exit] of checks.entries()) {
      if (tabId % 2 === 1) {
        const error = yield* Effect.flip(exit)
        expect(error.cause).toMatchObject({ message: `No tab with id: ${tabId}.` })
        expect(fixture.controls.state(tabId)).toEqual(fixture.controls.state())
        continue
      }

      expect(exit).toEqual(Exit.succeed([
        `${tabId % 1000}`, `tab ${tabId}`, [tabId % 256, 0, 0, 255], tabId % 3 !== 0,
        tabId % 5 === 0 ? "" : "chrome-extension://test-extension/popup.html"
      ]))
    }

    expect(yield* action.getBadgeText({ tabId: 10_001 })).toBe("D")
  }))

  it.effect("orders 4,096 racing setters on one tab against a close by the order Chrome receives them", () => Effect.gen(function*() {
    const random = seeded(4096)
    const closeAt = 1000 + Math.floor(random() * 2000)
    const received: Array<{ readonly index: number, readonly open: boolean }> = []
    let closed = false
    const base = makeAction()

    const fixture = makeAction({}, {
      setBadgeText: async (details) => {
        const index = Number(details.text)

        if (received.length === closeAt) {
          base.controls.closeTab(5)
          closed = true
        }

        received.push({ index, open: !closed })

        return base.api.setBadgeText(details)
      },
      getBadgeText: (details) => base.api.getBadgeText(details)
    })

    const action = make(fixture.api)

    const exits = yield* Effect.forEach(Array.from({ length: 4096 }, (_, index) => index), (index) =>
      Effect.exit(action.setBadgeText({ text: `${index}`, tabId: 5 })), { concurrency: "unbounded" })

    const outcome = new Map(received.map(({ index, open }) => [index, open]))
    expect(outcome.size).toBe(4096)

    for (const [index, exit] of exits.entries()) {
      if (outcome.get(index) === true) expect(exit).toEqual(Exit.void)
      else expect((yield* Effect.flip(exit)).cause).toMatchObject({ message: "No tab with id: 5." })
    }

    expect(received.filter(({ open }) => open)).toHaveLength(closeAt)
    expect(yield* Effect.flip(action.getBadgeText({ tabId: 5 }))).toMatchObject({ operation: "getBadgeText" })
    expect(base.controls.state(5).badgeText).toBe("")
  }))

  it.effect("keeps the last of 4,096 concurrent badge writes Chrome receives for one tab", () => Effect.gen(function*() {
    const received: Array<string> = []
    const base = makeAction()

    const fixture = makeAction({}, {
      setBadgeText: async (details) => {
        received.push(details.text ?? "")

        return base.api.setBadgeText(details)
      },
      getBadgeText: (details) => base.api.getBadgeText(details)
    })

    const action = make(fixture.api)
    yield* Effect.forEach(Array.from({ length: 4096 }, (_, index) => index), (index) =>
      action.setBadgeText({ text: `${index}`, tabId: 9 }), { concurrency: "unbounded", discard: true })
    expect(new Set(received).size).toBe(4096)
    expect(yield* action.getBadgeText({ tabId: 9 })).toBe(received.at(-1))
  }))

  it.effect("decides 2,048 concurrent openPopup calls by the active tab's popup when each arrives", () => Effect.gen(function*() {
    const random = seeded(2048)
    const base = makeAction()
    const service = make(base.api)
    const expectOpen = new Map<number | undefined, boolean>()
    yield* service.setPopup({ popup: "", tabId: 2 })
    yield* service.setPopup({ popup: "popup.html" })

    const fixture = makeAction({}, {
      openPopup: (options) => {
        // Tab 1 inherits the default popup; tab 2 removed its own.
        const active = random() < 0.5 ? 1 : 2
        base.controls.activateTab(active)
        expectOpen.set(options?.windowId, active === 1)

        if (base.api.openPopup === undefined) throw new Error("the fixture always has openPopup")

        return base.api.openPopup(options)
      }
    })

    const action = make(fixture.api)

    const exits = yield* Effect.forEach(Array.from({ length: 2048 }, (_, index) => index), (index) =>
      Effect.exit(action.openPopup({ windowId: index })), { concurrency: "unbounded" })

    const opened = base.controls.openedPopups.map((options) => options?.windowId)

    expect(expectOpen.size).toBe(2048)

    for (const [windowId, exit] of exits.entries()) {
      if (expectOpen.get(windowId) === true) expect(Exit.isSuccess(exit)).toBe(true)
      else expect((yield* Effect.flip(exit)).cause).toMatchObject({ message: "Extension does not have a popup on the active tab." })
    }

    const expectedOpen = [...expectOpen.entries()].flatMap(([windowId, open]) => open ? [windowId] : [])
    expect(opened).toHaveLength(expectedOpen.length)
    expect(new Set(opened)).toEqual(new Set(expectedOpen))
    expect(opened.length).toBeGreaterThan(0)
    expect(opened.length).toBeLessThan(2048)
  }))

  it.effect("decides 2,048 openPopup calls racing 2,048 enable and disable calls by the state each one meets", () => Effect.gen(function*() {
    const random = seeded(4242)
    const base = makeAction({ popup: "popup.html" })
    base.controls.activateTab(3)
    const received: Array<{ readonly kind: "toggle", readonly enabled: boolean } | { readonly kind: "open", readonly windowId: number }> = []

    const fixture = makeAction({}, {
      enable: (tabId) => {
        received.push({ kind: "toggle", enabled: true })

        return base.api.enable(tabId)
      },
      disable: (tabId) => {
        received.push({ kind: "toggle", enabled: false })

        return base.api.disable(tabId)
      },
      openPopup: (options) => {
        received.push({ kind: "open", windowId: options?.windowId ?? -1 })

        if (base.api.openPopup === undefined) throw new Error("the fixture always has openPopup")

        return base.api.openPopup(options)
      }
    })

    const action = make(fixture.api)

    const operations = Array.from({ length: 4096 }, (_, index) => {
      if (index % 2 === 0) return action.openPopup({ windowId: index })

      return random() < 0.5 ? action.enable(3) : action.disable(3)
    })

    const exits = yield* Effect.forEach(operations, Effect.exit, { concurrency: "unbounded" })
    const expectOpen = new Map<number, boolean>()
    let enabled = true

    for (const entry of received) {
      if (entry.kind === "toggle") enabled = entry.enabled
      else expectOpen.set(entry.windowId, enabled)
    }

    expect(received).toHaveLength(4096)
    expect(expectOpen.size).toBe(2048)

    for (const [index, exit] of exits.entries()) {
      if (index % 2 === 1) expect(exit).toEqual(Exit.void)
      else if (expectOpen.get(index) === true) expect(exit).toEqual(Exit.void)
      else expect((yield* Effect.flip(exit)).cause).toMatchObject({ message: "Extension does not have a popup on the active tab." })
    }

    const opened = base.controls.openedPopups.map((options) => options?.windowId)
    expect(opened).toEqual([...expectOpen.entries()].flatMap(([windowId, open]) => open ? [windowId] : []))
    expect(opened.length).toBeGreaterThan(0)
    expect(opened.length).toBeLessThan(2048)
    expect(yield* action.isEnabled(3)).toBe(enabled)
  }))

  it.effect("delivers 4,096 simulated clicks to 64 subscribers, each keeping the newest 64", () => Effect.gen(function*() {
    const fixture = makeAction()
    const registered = gate()
    let subscribers = 0
    const original = fixture.api.onClicked

    const counting: ChromeActionApi = {
      ...fixture.api,
      onClicked: {
        addListener: (listener) => {
          original.addListener(listener)
          subscribers++

          if (subscribers === 64) registered.open()
        },
        removeListener: (listener) => original.removeListener(listener)
      }
    }

    const fibers = yield* Effect.forEach(Array.from({ length: 64 }), () =>
      Effect.forkChild(Stream.runCollect(Stream.take(make(counting).onClicked, 64))))

    yield* Effect.promise(() => registered.promise)

    for (let index = 0; index < 4096; index++) expect(fixture.controls.click({ ...tab, id: index })).toBe("clicked")

    for (const fiber of fibers) {
      expect((yield* Fiber.join(fiber)).map(({ id }) => id)).toEqual(Array.from({ length: 64 }, (_, index) => 4032 + index))
    }

    expect(fixture.controls.onClicked.listenerCount).toBe(0)
  }))
})
