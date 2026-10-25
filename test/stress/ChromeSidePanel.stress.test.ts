// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Exit, Fiber, Result } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromeSidePanelError, make } from "../../src/ChromeSidePanel.js"
import type { ChromeSidePanelApi, ChromeSidePanelService } from "../../src/ChromeSidePanel.js"
import { makeEvent } from "../../src/testing/Event.js"
import { burstKeepsNewest, churn, expectPlanned, plannedNative, settle } from "./gesture-trio.support.js"

const info = (index: number): chrome.sidePanel.PanelOpenedInfo => ({ path: `panel-${index}.html`, tabId: index, windowId: 1 })

const mockApi = () => ({
  setOptions: vi.fn(async (_options: chrome.sidePanel.PanelOptions) => {}),
  getOptions: vi.fn(async (options: chrome.sidePanel.GetPanelOptions): Promise<chrome.sidePanel.PanelOptions> => ({ ...options })),
  setPanelBehavior: vi.fn(async (_behavior: chrome.sidePanel.PanelBehavior) => {}),
  getPanelBehavior: vi.fn(async (): Promise<chrome.sidePanel.PanelBehavior> => ({})),
  open: vi.fn(async (_options: chrome.sidePanel.OpenOptions) => {}),
  close: vi.fn(async (_options: chrome.sidePanel.CloseOptions) => {}),
  getLayout: vi.fn(async (): Promise<chrome.sidePanel.PanelLayout> => ({ side: "left" })),
  onOpened: makeEvent<[chrome.sidePanel.PanelOpenedInfo]>().api,
  onClosed: makeEvent<[chrome.sidePanel.PanelClosedInfo]>().api
}) satisfies ChromeSidePanelApi

type Operation = "setOptions" | "getOptions" | "setPanelBehavior" | "open" | "openFromUserGesture" | "close"

const operations: ReadonlyArray<Operation> = ["setOptions", "getOptions", "setPanelBehavior", "open", "openFromUserGesture", "close"]

/** Runs call `index` of one operation, encoding the index in the tab id. */
const run = (panel: ChromeSidePanelService, operation: Operation, index: number): Effect.Effect<unknown, ChromeSidePanelError> => {
  switch (operation) {
    case "setOptions": return panel.setOptions({ tabId: index, path: `tab-${index}.html` })
    case "getOptions": return panel.getOptions({ tabId: index })
    case "setPanelBehavior": return panel.setPanelBehavior({ openPanelOnActionClick: index % 2 === 0 })
    case "open": return panel.open({ tabId: index })
    case "openFromUserGesture": return panel.openFromUserGesture({ tabId: index })
    case "close": return panel.close({ tabId: index })
  }
}

describe("ChromeSidePanel stress", () => {
  it.effect.each(["onOpened", "onClosed"] as const)("keeps exactly the newest 64 of a 4096-event %s burst", (event) =>
    burstKeepsNewest({
      count: 4096,
      stream: (source) => make({ ...mockApi(), [event]: source })[event],
      args: (index): [chrome.sidePanel.PanelOpenedInfo] => [info(index)],
      project: (value) => value,
      expected: info
    }))

  it.effect.each(["onOpened", "onClosed"] as const)("churns 512 %s subscriptions through every stage to zero listeners", (event) =>
    churn({
      subscriptions: 512,
      seed: event === "onOpened" ? 31 : 32,
      operation: event,
      stream: (source) => make({ ...mockApi(), [event]: source })[event],
      args: (index): [chrome.sidePanel.PanelOpenedInfo] => [info(index)],
      check: (value, index) => expect(value).toEqual(info(index))
    }))

  it.effect("settles 1536 concurrent calls with interleaved rejections and throws, each typed", () => Effect.gen(function*() {
    const count = 1536
    const native = plannedNative(count, 41)
    const api = mockApi()
    const behaviors = new Map<chrome.sidePanel.PanelBehavior, number>()
    api.setOptions.mockImplementation((options) => native.native(options.tabId ?? -1, undefined))
    api.getOptions.mockImplementation((options) => native.native(options.tabId ?? -1, { ...options, enabled: true }))
    api.setPanelBehavior.mockImplementation((behavior) => native.native(behaviors.get(behavior) ?? -1, undefined))
    api.open.mockImplementation((options) => native.native(options.tabId ?? -1, undefined))
    api.close.mockImplementation((options) => native.native(options.tabId ?? -1, undefined))
    const panel = make(api)
    const operationOf = (index: number): Operation => operations[index % operations.length] ?? "open"

    // setPanelBehavior has no id field, so each call's behavior object maps back to its index.
    const runIndexed = (index: number) => {
      const operation = operationOf(index)

      if (operation !== "setPanelBehavior") return run(panel, operation, index)

      const behavior = { openPanelOnActionClick: index % 2 === 0 }
      behaviors.set(behavior, index)

      return panel.setPanelBehavior(behavior)
    }

    const fiber = yield* Effect.forkChild(Effect.forEach(
      Array.from({ length: count }, (_, index) => index),
      (index) => settle(runIndexed(index)),
      { concurrency: "unbounded" }
    ))

    yield* native.started
    native.release()
    const results = yield* Fiber.join(fiber)

    results.forEach((settled, index) => {
      const operation = operationOf(index)
      expectPlanned(settled, native.plan[index], {
        operation: operation === "openFromUserGesture" ? "open" : operation,
        cause: native.causes[index],
        errorClass: ChromeSidePanelError
      })

      if (Result.isSuccess(settled) && operation === "getOptions") expect(settled.success).toEqual({ tabId: index, enabled: true })
    })
    expect(native.calls).toBe(count)
  }))

  it.effect.each(["getPanelBehavior", "getLayout"] as const)("settles 1024 concurrent %s runs, matching every planned outcome once", (operation) =>
    Effect.gen(function*() {
      const count = 1024
      const native = plannedNative(count, operation === "getLayout" ? 42 : 43)
      const api = mockApi()
      let next = 0
      api.getPanelBehavior.mockImplementation(() => native.native(next++, {}))
      api.getLayout.mockImplementation(() => native.native(next++, { side: "left" }))
      const panel = make(api)
      const effect = operation === "getLayout" ? Effect.asVoid(panel.getLayout) : Effect.asVoid(panel.getPanelBehavior)
      const fiber = yield* Effect.forkChild(Effect.forEach(Array.from({ length: count }), () => settle(effect), { concurrency: "unbounded" }))
      yield* native.started
      native.release()
      const results = yield* Fiber.join(fiber)
      const failures = results.flatMap((settled) => Result.isFailure(settled) ? [settled.failure] : [])
      const expected = native.causes.filter((_, index) => native.plan[index] !== "resolve")
      expect(failures.every((error) => error instanceof ChromeSidePanelError && error.operation === operation)).toBe(true)
      expect(new Set(failures.map((error) => error.cause))).toEqual(new Set(expected))
      expect(failures).toHaveLength(expected.length)
    }))

  it.effect("starts 1024 gesture opens in one handler and settles them out of order", () => Effect.gen(function*() {
    const count = 1024
    const native = plannedNative(count, 44)
    const api = mockApi()
    api.open.mockImplementation((options) => native.native(options.tabId ?? -1, undefined))
    const panel = make(api)
    const outcomes = Array.from({ length: count }, (_, index) => panel.openFromUserGesture({ tabId: index }))
    expect(native.calls).toBe(count)
    const waiting = yield* Effect.forEach(outcomes, (outcome) => Effect.forkChild(outcome))
    yield* Effect.yieldNow
    yield* Effect.forEach(waiting.filter((_, index) => index % 3 === 0), Fiber.interrupt, { discard: true })
    native.release()
    const exits = yield* Effect.forEach(waiting, Fiber.await)
    expect(exits.filter((exit, index) => index % 3 === 0 && Exit.hasInterrupts(exit)).length).toBeGreaterThan(0)
    const replayed = yield* Effect.forEach(outcomes, settle)

    replayed.forEach((settled, index) => {
      expectPlanned(settled, native.plan[index], { operation: "open", cause: native.causes[index], errorClass: ChromeSidePanelError })
    })
    expect(api.open).toHaveBeenCalledTimes(count)
  }))

  it.effect("types 1024 concurrent calls to members an older browser lacks", () => Effect.gen(function*() {
    const { open: _open, close: _close, getLayout: _getLayout, onOpened: _onOpened, onClosed: _onClosed, ...older } = mockApi()
    const panel = make(older)

    const errors = yield* Effect.forEach(Array.from({ length: 1024 }, (_, index) => index), (index) => {
      const kinds = [
        ["open", panel.open({ tabId: index })],
        ["open", panel.openFromUserGesture({ tabId: index })],
        ["close", panel.close({ tabId: index })],
        ["getLayout", Effect.asVoid(panel.getLayout)]
      ] as const

      const [operation, effect] = kinds[index % kinds.length] ?? kinds[0]

      return Effect.map(Effect.flip(effect), (error) => [operation, error] as const)
    }, { concurrency: "unbounded" })

    for (const [operation, error] of errors) {
      expect(error).toBeInstanceOf(ChromeSidePanelError)
      expect(error.operation).toBe(operation)
    }
  }))
})
