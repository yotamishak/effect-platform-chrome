// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Exit, Fiber, Result } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { ChromePermissionsError, make } from "../../src/ChromePermissions.js"
import type { ChromePermissionsApi, ChromePermissionsService, Permissions } from "../../src/ChromePermissions.js"
import { makeEvent } from "../../src/testing/Event.js"
import { burstKeepsNewest, churn, expectPlanned, plannedNative, settle } from "./gesture-trio.support.js"

const origins = (index: number): Permissions => ({ origins: [`https://host-${index}.example/*`] })

/** Recovers the call index a test encoded in the first origin. */
const indexOf = (permissions: Permissions): number => Number(/host-(\d+)\./.exec(permissions.origins?.[0] ?? "")?.[1])

const mockApi = () => ({
  getAll: vi.fn(async (): Promise<Permissions> => ({})),
  contains: vi.fn(async (_permissions: Permissions) => true),
  request: vi.fn(async (_permissions: Permissions) => true),
  remove: vi.fn(async (_permissions: Permissions) => true),
  addHostAccessRequest: vi.fn(async (_request: chrome.permissions.AddHostAccessRequest) => {}),
  removeHostAccessRequest: vi.fn(async (_request: chrome.permissions.RemoveHostAccessRequest) => {}),
  onAdded: makeEvent<[Permissions]>().api,
  onRemoved: makeEvent<[Permissions]>().api
}) satisfies ChromePermissionsApi

type Operation = "contains" | "request" | "requestFromUserGesture" | "remove" | "addHostAccessRequest" | "removeHostAccessRequest"

const operations: ReadonlyArray<Operation> = ["contains", "request", "requestFromUserGesture", "remove", "addHostAccessRequest", "removeHostAccessRequest"]

const run = (service: ChromePermissionsService, operation: Operation, index: number): Effect.Effect<boolean | void, ChromePermissionsError> => {
  switch (operation) {
    case "contains": return service.contains(origins(index))
    case "request": return service.request(origins(index))
    case "requestFromUserGesture": return service.requestFromUserGesture(origins(index))
    case "remove": return service.remove(origins(index))
    case "addHostAccessRequest": return service.addHostAccessRequest({ tabId: index })
    case "removeHostAccessRequest": return service.removeHostAccessRequest({ tabId: index })
  }
}

describe("ChromePermissions stress", () => {
  it.effect.each(["onAdded", "onRemoved"] as const)("keeps exactly the newest 64 of a 4096-event %s burst", (event) =>
    burstKeepsNewest({
      count: 4096,
      stream: (source) => make({ ...mockApi(), [event]: source })[event],
      args: (index): [Permissions] => [origins(index)],
      project: (value) => value,
      expected: origins
    }))

  it.effect.each(["onAdded", "onRemoved"] as const)("churns 512 %s subscriptions through every stage to zero listeners", (event) =>
    churn({
      subscriptions: 512,
      seed: event === "onAdded" ? 11 : 12,
      operation: event,
      stream: (source) => make({ ...mockApi(), [event]: source })[event],
      args: (index): [Permissions] => [origins(index)],
      check: (value, index) => expect(value).toEqual(origins(index))
    }))

  it.effect("settles 1536 concurrent calls with interleaved rejections and throws, each typed", () => Effect.gen(function*() {
    const count = 1536
    const native = plannedNative(count, 21)
    const api = mockApi()
    api.contains.mockImplementation((permissions) => native.native(indexOf(permissions), true))
    api.request.mockImplementation((permissions) => native.native(indexOf(permissions), true))
    api.remove.mockImplementation((permissions) => native.native(indexOf(permissions), true))
    api.addHostAccessRequest.mockImplementation((request) => native.native(request.tabId ?? -1, undefined))
    api.removeHostAccessRequest.mockImplementation((request) => native.native(request.tabId ?? -1, undefined))
    const service = make(api)
    const operationOf = (index: number): Operation => operations[index % operations.length] ?? "contains"

    const fiber = yield* Effect.forkChild(Effect.forEach(
      Array.from({ length: count }, (_, index) => index),
      (index) => settle(run(service, operationOf(index), index)),
      { concurrency: "unbounded" }
    ))

    yield* native.started
    native.release()
    const results = yield* Fiber.join(fiber)
    expect(native.calls).toBe(count)

    results.forEach((settled, index) => {
      const operation = operationOf(index)
      expectPlanned(settled, native.plan[index], {
        operation: operation === "requestFromUserGesture" ? "request" : operation,
        cause: native.causes[index],
        errorClass: ChromePermissionsError
      })

      if (Result.isSuccess(settled)) expect(settled.success).toBe(operation.endsWith("HostAccessRequest") ? undefined : true)
    })
    expect(new Set(native.plan)).toEqual(new Set(["resolve", "reject", "throw"]))
  }))

  it.effect("settles 1024 concurrent getAll runs, matching every planned outcome once", () => Effect.gen(function*() {
    const count = 1024
    const native = plannedNative(count, 22)
    const api = mockApi()
    let next = 0
    api.getAll.mockImplementation(() => native.native(next++, origins(0)))
    const service = make(api)
    const fiber = yield* Effect.forkChild(Effect.forEach(Array.from({ length: count }), () => settle(service.getAll), { concurrency: "unbounded" }))
    yield* native.started
    native.release()
    const results = yield* Fiber.join(fiber)
    const failures = results.flatMap((settled) => Result.isFailure(settled) ? [settled.failure] : [])
    expect(results.filter(Result.isSuccess)).toHaveLength(native.plan.filter((outcome) => outcome === "resolve").length)

    for (const error of failures) {
      expect(error).toBeInstanceOf(ChromePermissionsError)
      expect(error.operation).toBe("getAll")
    }

    const expected = native.causes.filter((_, index) => native.plan[index] !== "resolve")
    expect(new Set(failures.map((error) => error.cause))).toEqual(new Set(expected))
    expect(failures).toHaveLength(expected.length)
  }))

  it.effect("replays one gesture outcome to 4096 concurrent observers with a single native request", () => Effect.gen(function*() {
    const api = mockApi()
    let grant!: (granted: boolean) => void
    api.request.mockImplementation(() => new Promise<boolean>((resolve) => { grant = resolve }))
    const outcome = make(api).requestFromUserGesture(origins(1))
    const observers = yield* Effect.forkChild(Effect.forEach(Array.from({ length: 4096 }), () => outcome, { concurrency: "unbounded" }))
    yield* Effect.yieldNow
    grant(false)
    expect(yield* Fiber.join(observers)).toEqual(Array.from({ length: 4096 }, () => false))
    expect(api.request).toHaveBeenCalledOnce()
  }))

  it.effect("interrupts 1024 gesture waits mid-flight without losing any late outcome", () => Effect.gen(function*() {
    const count = 1024
    const native = plannedNative(count, 23)
    const api = mockApi()
    api.request.mockImplementation((permissions) => native.native(indexOf(permissions), true))
    const service = make(api)
    const outcomes = Array.from({ length: count }, (_, index) => service.requestFromUserGesture(origins(index)))
    expect(native.calls).toBe(count)
    const waiting = yield* Effect.forEach(outcomes, (outcome) => Effect.forkChild(outcome))
    yield* Effect.yieldNow
    yield* Effect.forEach(waiting, (fiber, index) => index % 2 === 0 ? Fiber.interrupt(fiber) : Effect.void, { discard: true })
    native.release()
    const exits = yield* Effect.forEach(waiting, Fiber.await)

    exits.forEach((exit, index) => {
      if (index % 2 === 0) expect(Exit.hasInterrupts(exit) || native.plan[index] === "throw").toBe(true)
    })

    const replayed = yield* Effect.forEach(outcomes, settle)

    replayed.forEach((settled, index) => {
      expectPlanned(settled, native.plan[index], { operation: "request", cause: native.causes[index], errorClass: ChromePermissionsError })
    })
    expect(api.request).toHaveBeenCalledTimes(count)
  }))
})
