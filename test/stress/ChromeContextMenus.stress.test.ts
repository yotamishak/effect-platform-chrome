// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Cause, Deferred, Effect, Exit, Fiber, Option, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChromeContextMenusError, make } from "../../src/ChromeContextMenus.js"
import type { ChromeContextMenusApi, ClickedEvent, MenuItemId, OnClickData } from "../../src/ChromeContextMenus.js"
import { makeContextMenus } from "../../src/testing/ContextMenus.js"

type Listener = (info: OnClickData, tab?: chrome.tabs.Tab) => void

type Source = ChromeContextMenusApi["onClicked"]

const range = (length: number) => Array.from({ length }, (_, index) => index)

/** mulberry32: a small seeded generator, so every run interleaves the same way. */
const seeded = (seed: number) => {
  let state = seed

  return () => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

const shuffle = <A>(values: ReadonlyArray<A>, next: () => number): Array<A> => {
  const shuffled = [...values]

  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = Math.floor(next() * (index + 1))
    const at = shuffled[index]
    const swap = shuffled[other]

    if (at !== undefined && swap !== undefined) {
      shuffled[index] = swap
      shuffled[other] = at
    }
  }

  return shuffled
}

/**
 * A native Promise gate opened once `count` reaches `target`. Waiting on it resumes the test
 * fiber in a later microtask, never inside the Chrome call or callback that opened it.
 */
const countdown = (target: number) => {
  let open!: () => void
  const opened = new Promise<void>((resolve) => { open = resolve })
  let count = 0

  if (target === 0) open()

  return {
    tick: () => {
      count++

      if (count === target) open()
    },
    get count() { return count },
    reached: Effect.promise(() => opened)
  }
}

/** Wraps an event, recording every listener added and removed, with an optional hook after adding. */
const recording = (base: Source, afterAdd: (listener: Listener) => void = () => {}) => {
  const added: Array<Listener> = []
  const removed: Array<Listener> = []

  const source: Source = {
    addListener: (listener) => {
      base.addListener(listener)
      added.push(listener)
      afterAdd(listener)
    },
    removeListener: (listener) => {
      base.removeListener(listener)
      removed.push(listener)
    }
  }

  return { source, added, removed }
}

/** Every listener a recording added was removed exactly once. */
const expectBalanced = (record: { readonly added: ReadonlyArray<Listener>; readonly removed: ReadonlyArray<Listener> }) => {
  expect(record.removed).toHaveLength(record.added.length)
  expect(new Set(record.removed)).toEqual(new Set(record.added))
}

/**
 * Checks the typed error an exit failed with by class, operation and cause. `toEqual` alone would
 * not do: it skips an Error's non-enumerable `cause`.
 */
const expectTypedFailure = (exit: Exit.Exit<unknown, unknown>, operation: string, cause: unknown) => {
  const error = Option.getOrUndefined(Exit.findErrorOption(exit))
  expect(error).toBeInstanceOf(ChromeContextMenusError)

  if (!(error instanceof ChromeContextMenusError)) return

  expect(error.operation).toBe(operation)

  if (cause instanceof Error) {
    expect(error.cause).toBe(cause)
  } else {
    expect(error.cause).toEqual(cause)
  }
}

const menuIds = (clicks: ReadonlyArray<ClickedEvent>) => clicks.map((click) => click.info.menuItemId)

/** A fixture with `parent` and `count` children named `item-<index>`, created directly through the fake. */
const populated = (count: number) => {
  const fake = makeContextMenus()
  fake.api.create({ id: "parent", title: "Parent" }, () => {})

  for (const index of range(count)) fake.api.create({ id: `item-${index}`, parentId: "parent", title: `Item ${index}` }, () => {})

  return fake
}

describe("ChromeContextMenus stress", () => {
  describe("onClicked bursts", () => {
    it.effect.each([1, 63, 64, 65, 4096])("keeps exactly the newest of %i clicks made during registration, then removes the listener", (count) =>
      Effect.gen(function*() {
        const fake = populated(count)

        const record = recording(fake.api.onClicked, () => {
          for (const index of range(count)) fake.controls.click(`item-${index}`)
        })

        const menus = make({ ...fake.api, onClicked: record.source })
        const kept = Math.min(count, 64)
        const clicks = yield* Stream.runCollect(Stream.take(menus.onClicked, kept))
        expect(menuIds(clicks)).toEqual(range(kept).map((index) => `item-${count - kept + index}`))
        expect(clicks.every((click) => click.info.parentMenuItemId === "parent" && Option.isNone(click.tab))).toBe(true)
        expect(fake.controls.onClicked.listenerCount).toBe(0)
        expectBalanced(record)
      }))

    it.effect("drops all but the newest 64 of 4096 clicks while the consumer waits, delivering later clicks next", () => Effect.gen(function*() {
      const fake = populated(4096)
      const menus = make(fake.api)
      const delivered = countdown(64)
      const consumer = yield* Effect.forkChild(Stream.runCollect(Stream.take(Stream.tap(menus.onClicked, () => Effect.sync(delivered.tick)), 65)))
      yield* Effect.promise(() => fake.controls.onClicked.waitForListener())

      for (const index of range(4096)) fake.controls.click(`item-${index}`)

      yield* delivered.reached
      fake.controls.click("parent", { selectionText: "after the burst" })
      const clicks = yield* Fiber.join(consumer)
      expect(menuIds(clicks)).toEqual([...range(64).map((index) => `item-${4032 + index}`), "parent"])
      expect(clicks[64]?.info.selectionText).toBe("after the burst")
      expect(fake.controls.onClicked.listenerCount).toBe(0)
    }))

    it.effect("gives 128 concurrent subscribers independent buffers of the newest 64 of 4096 clicks", () => Effect.gen(function*() {
      const fake = populated(4096)
      const registered = countdown(128)
      const record = recording(fake.api.onClicked, registered.tick)
      const menus = make({ ...fake.api, onClicked: record.source })
      const subscribers = yield* Effect.forEach(range(128), () => Effect.forkChild(Stream.runCollect(Stream.take(menus.onClicked, 64))))
      yield* registered.reached

      for (const index of range(4096)) fake.controls.click(`item-${index}`)

      const results = yield* Fiber.joinAll(subscribers)
      const newest = range(64).map((index) => `item-${4032 + index}`)

      for (const clicks of results) expect(menuIds(clicks)).toEqual(newest)

      expect(fake.controls.onClicked.listenerCount).toBe(0)
      expectBalanced(record)
    }))

    it.effect("keeps clicks in order across 64 alternating bursts and drains", () => Effect.gen(function*() {
      const fake = populated(256)
      const menus = make(fake.api)
      const rounds = 64
      const delivered = range(rounds).map(() => countdown(64))
      let seen = 0

      const consumer = yield* Effect.forkChild(Stream.runCollect(Stream.take(Stream.tap(menus.onClicked, () => Effect.sync(() => {
        delivered[Math.floor(seen / 64)]?.tick()
        seen++
      })), rounds * 64)))

      yield* Effect.promise(() => fake.controls.onClicked.waitForListener())

      for (const round of range(rounds)) {
        for (const index of range(256)) fake.controls.click(`item-${index}`, { frameId: round })

        yield* delivered[round]?.reached ?? Effect.void
      }

      const clicks = yield* Fiber.join(consumer)

      for (const round of range(rounds)) {
        const slice = clicks.slice(round * 64, round * 64 + 64)
        expect(menuIds(slice)).toEqual(range(64).map((index) => `item-${192 + index}`))
        expect(slice.every((click) => click.info.frameId === round)).toBe(true)
      }

      expect(fake.controls.onClicked.listenerCount).toBe(0)
    }))
  })

  describe("subscription churn", () => {
    it.effect("ends 512 subscriptions interrupted, completed or failed at every stage with zero listeners", () => Effect.gen(function*() {
      const fake = makeContextMenus()
      fake.api.create({ id: "a", title: "A" }, () => {})
      const stages = 7
      const perStage = range(stages).map((stage) => range(512).filter((index) => index % stages === stage).length)
      const registered = range(stages).map((stage) => countdown(stage === 0 ? 0 : perStage[stage] ?? 0))
      const blockedFirst = countdown(perStage[2] ?? 0)
      const blockedSecond = countdown(perStage[3] ?? 0)
      const registrationFailure = new Error("listener registration failed after adding")
      const handlerFailure = new Error("handler failed")

      const records = range(stages).map((stage) => recording(fake.api.onClicked, () => {
        registered[stage]?.tick()

        // Stage 6 registers partially: the listener is added, then registration throws.
        if (stage === 6) throw registrationFailure
      }))

      const services = records.map((record) => make({ ...fake.api, onClicked: record.source }))

      const subscription = (stage: number): Effect.Effect<unknown, ChromeContextMenusError> => {
        const clicks = services[stage]?.onClicked ?? Stream.empty

        switch (stage) {
          case 2:
            return Stream.runForEach(clicks, () => Effect.andThen(Effect.sync(blockedFirst.tick), Effect.never))
          case 3: {
            let seen = 0

            return Stream.runForEach(clicks, () => seen++ === 0 ? Effect.void : Effect.andThen(Effect.sync(blockedSecond.tick), Effect.never))
          }

          case 4:
            return Stream.runCollect(Stream.take(clicks, 1))
          case 5:
            return Effect.exit(Stream.runForEach(clicks, () => Effect.fail(handlerFailure)))
          case 6:
            return Effect.exit(Stream.runDrain(clicks))
          default:
            return Stream.runDrain(clicks)
        }
      }

      const fibers: Array<{ readonly stage: number; readonly fiber: Fiber.Fiber<unknown, ChromeContextMenusError> }> = []

      for (const index of range(512)) {
        const stage = index % stages
        const fiber = yield* Effect.forkChild(subscription(stage))

        // Stage 0: interrupted as soon as it is forked, before or during its registration.
        if (stage === 0) yield* Fiber.interrupt(fiber)

        fibers.push({ stage, fiber })
      }

      for (const gate of registered) yield* gate.reached

      fake.controls.click("a")
      fake.controls.click("a")
      yield* blockedFirst.reached
      yield* blockedSecond.reached
      const interrupted = fibers.flatMap(({ stage, fiber }) => stage <= 3 ? [fiber] : [])
      yield* Fiber.interruptAll(interrupted)

      for (const { stage, fiber } of fibers) {
        const exit = yield* Fiber.await(fiber)

        if (stage <= 3) {
          expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        } else if (stage === 4) {
          expect(exit).toEqual(Exit.succeed([{ info: { menuItemId: "a", editable: false }, tab: Option.none() }]))
        } else if (stage === 5) {
          const inner = Exit.isSuccess(exit) ? exit.value : undefined
          expect(Exit.isExit(inner) && Option.getOrUndefined(Exit.findErrorOption(inner))).toBe(handlerFailure)
        } else {
          const inner = Exit.isSuccess(exit) ? exit.value : undefined
          expect(Exit.isExit(inner)).toBe(true)

          if (Exit.isExit(inner)) expectTypedFailure(inner, "onClicked", registrationFailure)
        }
      }

      expect(fake.controls.onClicked.listenerCount).toBe(0)

      for (const record of records) expectBalanced(record)

      expect(records.slice(1).map((record) => record.added.length)).toEqual(perStage.slice(1))
    }))

    it.effect("survives 2048 sequential subscribe, click and interrupt cycles without leaking listeners", () => Effect.gen(function*() {
      const fake = makeContextMenus()
      fake.api.create({ id: "a", title: "A" }, () => {})
      const record = recording(fake.api.onClicked)
      const menus = make({ ...fake.api, onClicked: record.source })
      const next = seeded(2048)

      for (const cycle of range(2048)) {
        const fiber = yield* Effect.forkChild(Stream.runDrain(menus.onClicked))

        if (next() < 0.5) {
          yield* Effect.promise(() => fake.controls.onClicked.waitForListener())

          for (const _ of range(cycle % 130)) fake.controls.click("a")
        }

        yield* Fiber.interrupt(fiber)
        expect(fake.controls.onClicked.listenerCount).toBe(0)
      }

      expectBalanced(record)
    }))
  })

  describe("concurrent calls", () => {
    type Operation = "create" | "update" | "remove" | "removeAll"

    type Outcome = "ok" | "reject" | "throw" | "lastError" | "early" | "earlyLastError" | "lastErrorThrows"

    const outcomes: Record<Operation, ReadonlyArray<Outcome>> = {
      create: ["ok", "throw", "lastError", "early", "earlyLastError", "lastErrorThrows"],
      update: ["ok", "reject", "throw"],
      remove: ["ok", "reject", "throw"],
      removeAll: ["ok", "reject", "throw"]
    }

    it.effect("settles 2048 concurrent calls released in seeded order, each with its own result or typed error", () => Effect.gen(function*() {
      const next = seeded(1024)
      const operations: ReadonlyArray<Operation> = ["create", "update", "remove", "removeAll"]

      const plans = range(2048).map((index) => {
        const operation = operations[Math.floor(next() * operations.length)] ?? "create"
        const choices = outcomes[operation]
        const outcome = choices[Math.floor(next() * choices.length)] ?? "ok"

        return { index, operation, outcome, cause: new Error(`call ${index} failed`), lastError: { message: `call ${index} lastError` } }
      })

      const invoked = countdown(plans.length)
      const pending: Array<() => void> = []
      let lastError: chrome.runtime.LastError | undefined
      let lastErrorFails: unknown

      const runCallback = (callback: () => void, error: chrome.runtime.LastError | undefined, failure?: Error) => {
        lastError = error
        lastErrorFails = failure

        try { callback() } finally {
          lastError = undefined
          lastErrorFails = undefined
        }
      }

      const effectFor = (plan: (typeof plans)[number]) => {
        const id = `call-${plan.index}`

        const promised = () => {
          invoked.tick()

          if (plan.outcome === "throw") throw plan.cause

          return new Promise<void>((resolve, reject) => {
            pending.push(() => plan.outcome === "reject" ? reject(plan.cause) : resolve())
          })
        }

        const api: ChromeContextMenusApi = {
          create: (_properties, callback) => {
            invoked.tick()

            switch (plan.outcome) {
              case "throw":
                throw plan.cause
              case "early":
                runCallback(callback, undefined)
                break
              case "earlyLastError":
                runCallback(callback, plan.lastError)
                break
              default:
                pending.push(() => runCallback(
                  callback,
                  plan.outcome === "lastError" ? plan.lastError : undefined,
                  plan.outcome === "lastErrorThrows" ? plan.cause : undefined
                ))
            }

            return id
          },
          update: promised,
          remove: promised,
          removeAll: promised,
          onClicked: makeContextMenus().api.onClicked,
          get lastError() {
            if (lastErrorFails !== undefined) throw lastErrorFails

            return lastError
          }
        }

        const menus = make(api)

        const effects: Record<Operation, Effect.Effect<MenuItemId | void, ChromeContextMenusError>> = {
          create: menus.create({ id, title: id }),
          update: menus.update(id, { title: id }),
          remove: menus.remove(id),
          removeAll: menus.removeAll
        }

        return effects[plan.operation]
      }

      const all = yield* Effect.forkChild(Effect.forEach(plans, (plan) => Effect.exit(effectFor(plan)), { concurrency: "unbounded" }))
      yield* invoked.reached

      for (const release of shuffle(pending, next)) release()

      const exits = yield* Fiber.join(all)
      const tally = new Map<string, number>()

      for (const plan of plans) {
        const exit = exits[plan.index]
        const key = `${plan.operation}:${plan.outcome}`
        tally.set(key, (tally.get(key) ?? 0) + 1)

        if (plan.outcome === "ok" || plan.outcome === "early") {
          expect(exit).toEqual(Exit.succeed(plan.operation === "create" ? `call-${plan.index}` : undefined))
        } else {
          const error = exit === undefined ? Option.none() : Exit.findErrorOption(exit)
          expect(Option.isSome(error)).toBe(true)
          const value = Option.getOrUndefined(error)
          expect(value).toBeInstanceOf(ChromeContextMenusError)
          expect(value?.operation).toBe(plan.operation)
          expect(value?.cause).toBe(plan.outcome === "lastError" || plan.outcome === "earlyLastError" ? plan.lastError : plan.cause)
        }
      }

      // Every operation/outcome pair occurred, so the interleaving exercised each path.
      expect(tally.size).toBe(15)
    }))

    it.effect("lets exactly one of 1024 concurrent creates claim each of 64 ids", () => Effect.gen(function*() {
      const fake = makeContextMenus()
      const menus = make(fake.api)
      const next = seeded(64)
      const requests = range(1024).map((index) => ({ index, id: `id-${Math.floor(next() * 64)}` }))
      const exits = yield* Effect.forEach(requests, ({ id, index }) => Effect.exit(menus.create({ id, title: `${index}` })), { concurrency: "unbounded" })
      const winners = new Map<string, number>()

      for (const [position, exit] of exits.entries()) {
        const request = requests[position]

        if (request === undefined) continue

        if (Exit.isSuccess(exit)) {
          expect(winners.has(request.id)).toBe(false)
          winners.set(request.id, request.index)
        } else {
          expectTypedFailure(exit, "create", { message: `Cannot create item with duplicate id ${request.id}` })
        }
      }

      expect(winners.size).toBe(new Set(requests.map((request) => request.id)).size)

      for (const [id, index] of winners) {
        expect(fake.controls.item(id)?.properties.title).toBe(`${index}`)
        expect(requests.find((request) => request.id === id)?.index).toBe(index)
      }
    }))

    it.effect("admits exactly 1000 of 1100 concurrent top-level creates, then removes them all concurrently", () => Effect.gen(function*() {
      const fake = makeContextMenus()
      const menus = make(fake.api)
      const exits = yield* Effect.forEach(range(1100), (index) => Effect.exit(menus.create({ id: `top-${index}`, title: "Top" })), { concurrency: "unbounded" })
      expect(exits.filter(Exit.isSuccess)).toHaveLength(1000)
      expect(exits.slice(1000).map((exit) => Exit.findErrorOption(exit).pipe(Option.map((error) => error.cause)))).toEqual(
        range(100).map(() => Option.some({ message: "An extension can create a maximum of 1000 menu items." }))
      )
      yield* Effect.forEach(range(1000), (index) => menus.remove(`top-${index}`), { concurrency: "unbounded", discard: true })
      expect(fake.controls.items()).toEqual([])
      expect(fake.controls.children()).toEqual([])
    }))

    it.effect("updates 4096 children concurrently and removes the whole subtree in one call", () => Effect.gen(function*() {
      const fake = populated(4096)
      const menus = make(fake.api)
      yield* Effect.forEach(range(4096), (index) => menus.update(`item-${index}`, { title: `Renamed ${index}`, enabled: index % 2 === 0 }), {
        concurrency: "unbounded", discard: true
      })
      expect(fake.controls.children("parent")).toEqual(range(4096).map((index) => `item-${index}`))
      expect(fake.controls.item("item-4095")?.properties).toEqual({ title: "Renamed 4095", enabled: false })
      yield* menus.remove("parent")
      expect(fake.controls.items()).toEqual([])
      const missing = yield* Effect.forEach(range(64), (index) => Effect.flip(menus.update(`item-${index}`, { title: "Gone" })), { concurrency: "unbounded" })
      expect(missing.every((error) => error.operation === "update")).toBe(true)
    }))
  })

  describe("scoped items", () => {
    /** The fixture with `create` callbacks held until released, replaying the lastError Chrome set. */
    const heldFixture = (target: number) => {
      const fake = makeContextMenus()
      const held: Array<() => void> = []
      const heldRemoves: Array<() => void> = []
      const created = countdown(target)
      const removing = countdown(target)
      const removed: Array<MenuItemId> = []
      let replayed: chrome.runtime.LastError | undefined
      let holdRemoves = false

      const api: ChromeContextMenusApi = {
        ...fake.api,
        create: (properties, callback) => fake.api.create(properties, () => {
          const error = fake.api.lastError
          held.push(() => {
            replayed = error

            try { callback() } finally { replayed = undefined }
          })
          created.tick()
        }),
        remove: (menuItemId) => {
          removed.push(menuItemId)

          if (!holdRemoves) return fake.api.remove(menuItemId)

          return new Promise<void>((resolve, reject) => {
            heldRemoves.push(() => { fake.api.remove(menuItemId).then(resolve, reject) })
            removing.tick()
          })
        },
        get lastError() { return replayed }
      }

      return {
        fake, api, held, heldRemoves, created, removing, removed,
        holdRemoves: () => { holdRemoves = true }
      }
    }

    it.effect("removes every item whose creation Chrome confirmed after 256 interruptions mid-acquire", () => Effect.gen(function*() {
      const setup = heldFixture(256)
      const menus = make(setup.api)

      for (const index of range(64)) setup.fake.api.create({ id: `item-${index * 4}`, title: "Pre-existing" }, () => {})

      const fibers = yield* Effect.forEach(range(256), (index) => Effect.forkChild(Effect.scoped(Effect.andThen(
        menus.item({ id: `item-${index}`, title: "Scoped" }),
        Effect.never
      ))))

      yield* setup.created.reached

      for (const fiber of fibers) fiber.interruptUnsafe()

      expect(fibers.every((fiber) => fiber.pollUnsafe() === undefined)).toBe(true)

      for (const release of shuffle(setup.held, seeded(256))) release()

      for (const [index, fiber] of fibers.entries()) {
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)

        if (index % 4 === 0) {
          expectTypedFailure(exit, "create", { message: `Cannot create item with duplicate id item-${index}` })
        } else if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
      }

      expect(new Set(setup.removed)).toEqual(new Set(range(256).flatMap((index) => index % 4 === 0 ? [] : [`item-${index}`])))
      expect(setup.removed).toHaveLength(192)
      expect(setup.fake.controls.items().map((item) => item.id)).toEqual(range(64).map((index) => `item-${index * 4}`))
    }))

    it.effect("finishes 256 pending releases despite interruption mid-release, ignoring items already gone", () => Effect.gen(function*() {
      const setup = heldFixture(256)
      const menus = make(setup.api)
      const acquired = countdown(256)
      const close = Deferred.makeUnsafe<void>()

      const fibers = yield* Effect.forEach(range(256), (index) => Effect.forkChild(Effect.scoped(Effect.gen(function*() {
        yield* menus.item({ id: `item-${index}`, title: "Scoped" })
        acquired.tick()
        yield* Deferred.await(close)
      }))))

      yield* setup.created.reached

      for (const release of setup.held.splice(0)) release()

      yield* acquired.reached
      setup.holdRemoves()
      yield* Deferred.succeed(close, undefined)
      yield* setup.removing.reached

      for (const fiber of fibers) fiber.interruptUnsafe()

      expect(fibers.every((fiber) => fiber.pollUnsafe() === undefined)).toBe(true)

      for (const index of range(256).filter((each) => each % 3 === 0)) yield* Effect.promise(() => setup.fake.api.remove(`item-${index}`))

      for (const release of shuffle(setup.heldRemoves, seeded(3))) release()

      for (const fiber of fibers) {
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      }

      expect(setup.removed).toHaveLength(256)
      expect(setup.fake.controls.items()).toEqual([])
    }))

    it.effect("lets one of 16 racing scopes own each of 16 ids and leaves nothing behind", () => Effect.gen(function*() {
      const fake = makeContextMenus()
      const menus = make(fake.api)
      const close = Deferred.makeUnsafe<void>()
      const owners = countdown(16)

      const fibers = yield* Effect.forEach(range(256), (index) => Effect.forkChild(Effect.exit(Effect.scoped(Effect.gen(function*() {
        const id = yield* menus.item({ id: `shared-${index % 16}`, title: `${index}` })
        owners.tick()
        yield* Deferred.await(close)

        return id
      })))))

      yield* owners.reached
      expect(fake.controls.items()).toHaveLength(16)
      yield* Deferred.succeed(close, undefined)
      const exits = yield* Fiber.joinAll(fibers)
      const owned = exits.flatMap((exit) => Exit.isSuccess(exit) ? [exit.value] : [])
      expect(owned).toHaveLength(16)
      expect(new Set(owned)).toEqual(new Set(range(16).map((index) => `shared-${index}`)))
      expect(exits.filter(Exit.isFailure).every((exit) => Option.getOrUndefined(Exit.findErrorOption(exit))?.operation === "create")).toBe(true)
      expect(fake.controls.items()).toEqual([])
    }))

    it.effect("closes 256 scopes racing removeAll without a failure or a leftover item", () => Effect.gen(function*() {
      const fake = makeContextMenus()
      const menus = make(fake.api)
      const close = Deferred.makeUnsafe<void>()
      const acquired = countdown(256)

      const fibers = yield* Effect.forEach(range(256), (index) => Effect.forkChild(Effect.scoped(Effect.gen(function*() {
        yield* menus.item({ id: `item-${index}`, title: "Scoped" })
        acquired.tick()
        yield* Deferred.await(close)
      }))))

      yield* acquired.reached
      const clearing = yield* Effect.forkChild(Effect.forEach(range(8), () => menus.removeAll, { concurrency: "unbounded", discard: true }))
      yield* Deferred.succeed(close, undefined)
      yield* Fiber.join(clearing)
      yield* Fiber.joinAll(fibers)
      expect(fake.controls.items()).toEqual([])
    }))
  })

  describe("fixture extremes", () => {
    it.effect("keeps exactly one checked radio across 1024 seeded clicks in a 1024-item run", () => Effect.gen(function*() {
      const fake = makeContextMenus()
      const menus = make(fake.api)
      yield* menus.create({ id: "parent", title: "Parent" })
      yield* Effect.forEach(range(1024), (index) => menus.create({ id: `radio-${index}`, parentId: "parent", type: "radio", title: `${index}` }), {
        discard: true
      })
      const next = seeded(1024)
      let previous: MenuItemId = "radio-0"

      for (const _ of range(1024)) {
        const id = `radio-${Math.floor(next() * 1024)}`
        expect(fake.controls.click(id)).toEqual([])
        expect(fake.controls.item(previous)?.properties.checked).toBe(previous === id)
        expect(fake.controls.item(id)?.properties.checked).toBe(true)
        previous = id
      }

      const checked = fake.controls.children("parent").filter((id) => fake.controls.item(id)?.properties.checked === true)
      expect(checked).toEqual([previous])
    }))

    it.effect("removes a 2048-deep chain and re-parents within it without recursion limits", () => Effect.gen(function*() {
      const fake = makeContextMenus()
      const menus = make(fake.api)
      yield* menus.create({ id: "level-0", title: "Level 0" })

      for (const depth of range(2047)) yield* menus.create({ id: `level-${depth + 1}`, parentId: `level-${depth}`, title: "Level" })

      yield* menus.update("level-0", { parentId: "level-2047" })
      expect(fake.controls.item("level-0")?.parentId).toBeUndefined()
      yield* menus.update("level-2047", { parentId: "level-0" })
      expect(fake.controls.children("level-0")).toEqual(["level-1", "level-2047"])
      yield* menus.remove("level-1")
      expect(fake.controls.items().map((item) => item.id)).toEqual(["level-0", "level-2047"])
      yield* menus.remove("level-0")
      expect(fake.controls.items()).toEqual([])
    }))
  })
})
