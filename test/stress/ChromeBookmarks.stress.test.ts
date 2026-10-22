// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Exit, Fiber, Predicate, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChromeBookmarksError, make } from "../../src/ChromeBookmarks.js"
import type {
  BookmarkTreeNode, ChangedEvent, ChildrenReorderedEvent, ChromeBookmarksApi, ChromeBookmarksService, CreatedEvent,
  MoveInfo, MovedEvent, RemoveInfo, RemovedEvent
} from "../../src/ChromeBookmarks.js"
import type { EventSource } from "../../src/internal/event.js"
import * as TestBookmarks from "../../src/testing/Bookmarks.js"

type Fixture = ReturnType<typeof TestBookmarks.makeBookmarks>

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

const below = (random: () => number, bound: number): number => Math.floor(random() * bound)

const pick = <A>(random: () => number, values: ReadonlyArray<A>): A => {
  const value = values[below(random, values.length)]

  if (value === undefined) throw new Error("pick needs a non-empty list")

  return value
}

const titles = (nodes: ReadonlyArray<BookmarkTreeNode>) => nodes.map((node) => node.title)

const range = (length: number): Array<number> => Array.from({ length }, (_, index) => index)

const raise = (cause: Error): never => { throw cause }

/** A resolvable promise used as an explicit gate. */
const gate = <A = void>() => {
  let open: (value: A) => void = () => {}

  const promise = new Promise<A>((resolve) => { open = resolve })

  return { promise, open: (value: A) => open(value) }
}

type EventName = "onCreated" | "onRemoved" | "onChanged" | "onMoved" | "onChildrenReordered" | "onImportBegan" | "onImportEnded"

type Emitted = CreatedEvent | RemovedEvent | ChangedEvent | MovedEvent | ChildrenReorderedEvent | void

/** Rewraps one event source of the API, keeping its arguments. */
type Rewrap = <Args extends ReadonlyArray<unknown>>(source: EventSource<Args>) => EventSource<Args>

interface Spec {
  readonly name: EventName
  readonly emit: (fixture: Fixture, index: number) => void
  readonly expected: (index: number) => Emitted
  readonly rewrap: (fixture: Fixture, rewrap: Rewrap) => ChromeBookmarksApi
}

const sample = (index: number): BookmarkTreeNode => ({ id: String(index), title: `n${index}`, syncing: false })

const specs: ReadonlyArray<Spec> = [
  {
    name: "onCreated",
    emit: (fixture, index) => { fixture.controls.onCreated.emit(String(index), sample(index)) },
    expected: (index) => ({ id: String(index), bookmark: sample(index) }),
    rewrap: (fixture, rewrap) => ({ ...fixture.api, onCreated: rewrap(fixture.api.onCreated) })
  },
  {
    name: "onRemoved",
    emit: (fixture, index) => { fixture.controls.onRemoved.emit(String(index), { parentId: "2", index, node: sample(index) }) },
    expected: (index) => ({ id: String(index), parentId: "2", index, node: sample(index) }),
    rewrap: (fixture, rewrap) => ({ ...fixture.api, onRemoved: rewrap(fixture.api.onRemoved) })
  },
  {
    name: "onChanged",
    emit: (fixture, index) => { fixture.controls.onChanged.emit(String(index), { title: `t${index}`, url: `https://${index}.example/` }) },
    expected: (index) => ({ id: String(index), title: `t${index}`, url: `https://${index}.example/` }),
    rewrap: (fixture, rewrap) => ({ ...fixture.api, onChanged: rewrap(fixture.api.onChanged) })
  },
  {
    name: "onMoved",
    emit: (fixture, index) => { fixture.controls.onMoved.emit(String(index), { parentId: "1", index, oldParentId: "2", oldIndex: index + 1 }) },
    expected: (index) => ({ id: String(index), parentId: "1", index, oldParentId: "2", oldIndex: index + 1 }),
    rewrap: (fixture, rewrap) => ({ ...fixture.api, onMoved: rewrap(fixture.api.onMoved) })
  },
  {
    name: "onChildrenReordered",
    emit: (fixture, index) => { fixture.controls.onChildrenReordered.emit(String(index), { childIds: [String(index), String(index + 1)] }) },
    expected: (index) => ({ id: String(index), childIds: [String(index), String(index + 1)] }),
    rewrap: (fixture, rewrap) => ({ ...fixture.api, onChildrenReordered: rewrap(fixture.api.onChildrenReordered) })
  },
  {
    name: "onImportBegan",
    emit: (fixture) => { fixture.controls.onImportBegan.emit() },
    expected: () => undefined,
    rewrap: (fixture, rewrap) => ({ ...fixture.api, onImportBegan: rewrap(fixture.api.onImportBegan) })
  },
  {
    name: "onImportEnded",
    emit: (fixture) => { fixture.controls.onImportEnded.emit() },
    expected: () => undefined,
    rewrap: (fixture, rewrap) => ({ ...fixture.api, onImportEnded: rewrap(fixture.api.onImportEnded) })
  }
]

const streamOf = (bookmarks: ChromeBookmarksService, name: EventName): Stream.Stream<Emitted, ChromeBookmarksError> => bookmarks[name]

/** The newest 64 of `total` events, in emission order. */
const newest = (spec: Spec, total: number) => range(64).map((offset) => spec.expected(total - 64 + offset))

/** Per-subscription behaviour around a shared event, so each subscription can misbehave its own way. */
interface Hooks {
  readonly onAdd: () => void
  readonly onRemove: () => void
  readonly failBeforeAdd: Error | undefined
  readonly failAfterAdd: Error | undefined
}

const hooked = (hooks: Hooks): Rewrap => (source) => ({
  addListener: (listener) => {
    if (hooks.failBeforeAdd !== undefined) throw hooks.failBeforeAdd

    source.addListener(listener)
    hooks.onAdd()

    if (hooks.failAfterAdd !== undefined) throw hooks.failAfterAdd
  },
  removeListener: (listener) => {
    source.removeListener(listener)
    hooks.onRemove()
  }
})

const quiet: Hooks = { onAdd: () => {}, onRemove: () => {}, failBeforeAdd: undefined, failAfterAdd: undefined }

describe("ChromeBookmarks event stress", () => {
  it.effect.each(specs)("keeps exactly the newest 64 of a 4,096-event $name burst, then delivers the next one", (spec) => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const drained = gate()
    let seen = 0

    const stream = streamOf(make(fixture.api), spec.name).pipe(Stream.tap(() => Effect.sync(() => {
      seen++

      if (seen === 64) drained.open()
    })))

    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(stream, 65)))
    yield* Effect.promise(() => fixture.controls[spec.name].waitForListener())

    for (let index = 0; index < 4096; index++) spec.emit(fixture, index)

    yield* Effect.promise(() => drained.promise)
    spec.emit(fixture, 4096)
    expect(yield* Fiber.join(fiber)).toEqual([...newest(spec, 4096), spec.expected(4096)])
    expect(fixture.controls[spec.name].listenerCount).toBe(0)
  }))

  it.effect.each(specs)("keeps exactly the newest 64 of a 4,096-event $name burst fired during registration", (spec) => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    let removals = 0

    const api = spec.rewrap(fixture, hooked({
      ...quiet,
      onAdd: () => { for (let index = 0; index < 4096; index++) spec.emit(fixture, index) },
      onRemove: () => { removals++ }
    }))

    expect(yield* Stream.runCollect(Stream.take(streamOf(make(api), spec.name), 64))).toEqual(newest(spec, 4096))
    expect(fixture.controls[spec.name].listenerCount).toBe(0)
    expect(removals).toBe(1)
  }))

  it.effect.each(specs)("keeps 128 independent $name subscriptions each to the newest 64 of 4,096 events", (spec) => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const registered = gate()
    let added = 0

    const api = spec.rewrap(fixture, hooked({
      ...quiet,
      onAdd: () => {
        added++

        if (added === 128) registered.open()
      }
    }))

    const bookmarks = make(api)
    const fibers = yield* Effect.forEach(range(128), () => Effect.forkChild(Stream.runCollect(Stream.take(streamOf(bookmarks, spec.name), 64))))
    yield* Effect.promise(() => registered.promise)
    expect(fixture.controls[spec.name].listenerCount).toBe(128)

    for (let index = 0; index < 4096; index++) spec.emit(fixture, index)

    for (const values of yield* Effect.forEach(fibers, Fiber.join)) expect(values).toEqual(newest(spec, 4096))

    expect(fixture.controls[spec.name].listenerCount).toBe(0)
  }))

  it.effect.each(specs)("churns 512 concurrent $name subscriptions through interruption at every stage", (spec) => Effect.gen(function*() {
    const random = seeded(spec.name.length * 7919 + 512)
    const fixture = TestBookmarks.makeBookmarks()

    const stages = [
      "unstarted", "registered", "midRegistration", "stalled", "reentrantRelease", "partialFailure", "refused", "unreadable", "completes"
    ] as const

    const hold = gate()
    let adds = 0
    let removes = 0
    let interruptedDuringRegistration = 0

    const subscriptions = yield* Effect.forEach(range(512), (index) => Effect.gen(function*() {
      // The first subscriptions cover every stage; the rest are drawn from the seeded generator.
      const stage = stages[index] ?? pick(random, stages)
      const added = gate()
      const cause = new Error(`${stage} ${index}`)
      let self: Fiber.Fiber<Array<Emitted>, ChromeBookmarksError> | undefined

      const api = stage === "unreadable"
        ? Object.defineProperty({ ...fixture.api }, spec.name, { get: () => raise(cause) })
        : spec.rewrap(fixture, hooked({
          onAdd: () => {
            adds++
            added.open()

            // Interruption requested while Chrome is still inside addListener.
            if (stage === "midRegistration" && self !== undefined) {
              interruptedDuringRegistration++
              self.interruptUnsafe()
            }
          },
          // Chrome dispatching to the shared event while this listener is being removed.
          onRemove: () => {
            removes++

            if (stage === "reentrantRelease") spec.emit(fixture, -1)
          },
          failBeforeAdd: stage === "refused" ? cause : undefined,
          failAfterAdd: stage === "partialFailure" ? cause : undefined
        }))

      const stream = streamOf(make(api), spec.name)

      const consume = (): Effect.Effect<Array<Emitted>, ChromeBookmarksError> => {
        if (stage === "completes") return Stream.runCollect(Stream.take(stream, 1))

        // Stuck downstream on its first event while the rest of the burst stays buffered.
        if (stage === "stalled") {
          return Stream.runCollect(Stream.mapEffect(stream, (value) => Effect.as(Effect.promise(() => hold.promise), value)))
        }

        return Stream.runCollect(stream)
      }

      const consumer = consume()

      const fiber = yield* Effect.forkChild(consumer)
      self = fiber

      if (stage === "unstarted") yield* Fiber.interrupt(fiber)

      return { stage, fiber, added, cause }
    }))

    const registering = subscriptions.filter(({ stage }) => stage !== "unstarted" && stage !== "refused" && stage !== "unreadable")
    yield* Effect.promise(() => Promise.all(registering.map(({ added }) => added.promise)))

    for (let index = 0; index < 128; index++) spec.emit(fixture, index)

    const settling: ReadonlySet<string> = new Set(["completes", "partialFailure", "refused", "unreadable"])

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
      else if (stage === "partialFailure" || stage === "refused" || stage === "unreadable") {
        const error = yield* Effect.flip(exit)
        expect(error).toBeInstanceOf(ChromeBookmarksError)
        expect(error.operation).toBe(spec.name)
        expect(error.cause).toBe(cause)
      } else expect(Exit.hasInterrupts(exit)).toBe(true)
    }

    hold.open()
    expect(fixture.controls[spec.name].listenerCount).toBe(0)
    // Cleanup is installed before registration, so a refused registration still removes
    // (a no-op in Chrome); every listener that was added is removed exactly once.
    expect(removes).toBe(adds + subscriptions.filter(({ stage }) => stage === "refused").length)
    expect(interruptedDuringRegistration).toBe(subscriptions.filter(({ stage }) => stage === "midRegistration").length)
    expect(new Set(subscriptions.map(({ stage }) => stage))).toEqual(new Set(stages))
  }))

  it.effect("keeps the newest 64 of 4,096 real creations and the whole tree", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)
    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(bookmarks.onCreated, 64)))
    yield* Effect.promise(() => fixture.controls.onCreated.waitForListener())
    // Each creation emits synchronously inside the Chrome call, so these 4,096 are one burst.
    const created = range(4096).map((index) => fixture.api.create({ title: `b${index}`, url: `https://b${index}.example/` }))
    const nodes = yield* Effect.promise(() => Promise.all(created))
    const events = yield* Fiber.join(fiber)
    expect(events.map(({ id }) => id)).toEqual(nodes.slice(-64).map(({ id }) => id))
    expect(events.map(({ bookmark }) => bookmark.index)).toEqual(range(64).map((offset) => 4096 - 64 + offset))
    expect(fixture.controls.onCreated.listenerCount).toBe(0)
    expect((yield* bookmarks.getChildren("2")).map(({ id }) => id)).toEqual(nodes.map(({ id }) => id))
  }))

  it.effect("lets an import session's 4,096 creations overflow while onImportEnded still arrives", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)
    const began = yield* Effect.forkChild(Stream.runCollect(Stream.take(bookmarks.onImportBegan, 1)))
    const ended = yield* Effect.forkChild(Stream.runCollect(Stream.take(bookmarks.onImportEnded, 1)))
    const created = yield* Effect.forkChild(Stream.runCollect(Stream.take(bookmarks.onCreated, 64)))
    yield* Effect.promise(() => fixture.controls.onImportBegan.waitForListener())
    yield* Effect.promise(() => fixture.controls.onImportEnded.waitForListener())
    yield* Effect.promise(() => fixture.controls.onCreated.waitForListener())
    fixture.controls.onImportBegan.emit()
    const imported = yield* Effect.promise(() => Promise.all(range(4096).map((index) => fixture.api.create({ title: `i${index}` }))))
    fixture.controls.onImportEnded.emit()
    expect(yield* Fiber.join(began)).toEqual([undefined])
    expect(yield* Fiber.join(ended)).toEqual([undefined])
    expect((yield* Fiber.join(created)).map(({ id }) => id)).toEqual(imported.slice(-64).map(({ id }) => id))
    expect(yield* bookmarks.getChildren("2")).toHaveLength(4096)
    expect(specs.every(({ name }) => fixture.controls[name].listenerCount === 0)).toBe(true)
  }))
})

type Mode = "ok" | "okLate" | "reject" | "rejectLate" | "throw"

const modes: ReadonlyArray<Mode> = ["ok", "okLate", "reject", "rejectLate", "throw"]

/** Every result a bookmarks call can produce. */
type CallResult = Array<BookmarkTreeNode> | BookmarkTreeNode | void

/** The list id of a `get` call, which this module always passes as a list. */
const firstId = (idOrIdList: string | [string, ...Array<string>]): string =>
  Predicate.isString(idOrIdList) ? idOrIdList : idOrIdList[0]

/** The words of a `search` call, given as a string or as an object's `query`. */
const queryText = (query: string | chrome.bookmarks.SearchQuery): string => Predicate.isString(query) ? query : query.query ?? ""

/**
 * Each call encodes its index in its arguments, so the mock knows that call's planned outcome
 * whatever order the concurrent calls reach it in. `getTree` has no arguments; its outcomes
 * are planned in arrival order and checked as a whole. Late outcomes settle only once every
 * call has reached the mock.
 */
const plannedApi = (total: number, plan: ReadonlyMap<string, Mode>) => {
  const causes = new Map<string, Error>()
  const everyCallArrived = gate()
  let arrivals = 0
  let treeCalls = 0

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

  const api: ChromeBookmarksApi = {
    ...TestBookmarks.makeBookmarks().api,
    get: (idOrIdList) => settle(`get:${firstId(idOrIdList)}`, [sample(Number(firstId(idOrIdList)))]),
    getChildren: (id) => settle(`getChildren:${id}`, [sample(Number(id))]),
    getRecent: (numberOfItems) => settle(`getRecent:${numberOfItems - 1}`, [sample(numberOfItems - 1)]),
    getTree: () => {
      treeCalls++

      return settle(`getTree:${treeCalls}`, [])
    },
    getSubTree: (id) => settle(`getSubTree:${id}`, [sample(Number(id))]),
    search: (query) => settle(`search:${queryText(query)}`, [sample(Number(queryText(query)))]),
    create: (details) => settle(`create:${details.title}`, sample(Number(details.title))),
    move: (id) => settle(`move:${id}`, sample(Number(id))),
    update: (id) => settle(`update:${id}`, sample(Number(id))),
    remove: (id) => settle(`remove:${id}`, undefined),
    removeTree: (id) => settle(`removeTree:${id}`, undefined)
  }

  return { api, causes }
}

/** Every operation, invoked for call `index` with the index in its arguments. */
const operations: ReadonlyArray<{
  readonly operation: string
  readonly run: (bookmarks: ChromeBookmarksService, index: number) => Effect.Effect<CallResult, ChromeBookmarksError>
  readonly expected: (index: number) => CallResult
}> = [
  { operation: "get", run: (bookmarks, index) => bookmarks.get(String(index)), expected: (index) => [sample(index)] },
  { operation: "getChildren", run: (bookmarks, index) => bookmarks.getChildren(String(index)), expected: (index) => [sample(index)] },
  { operation: "getRecent", run: (bookmarks, index) => bookmarks.getRecent(index + 1), expected: (index) => [sample(index)] },
  { operation: "getTree", run: (bookmarks) => bookmarks.getTree, expected: () => [] },
  { operation: "getSubTree", run: (bookmarks, index) => bookmarks.getSubTree(String(index)), expected: (index) => [sample(index)] },
  { operation: "search", run: (bookmarks, index) => bookmarks.search(String(index)), expected: (index) => [sample(index)] },
  { operation: "create", run: (bookmarks, index) => bookmarks.create({ title: String(index) }), expected: (index) => sample(index) },
  { operation: "move", run: (bookmarks, index) => bookmarks.move(String(index), { index: 0 }), expected: (index) => sample(index) },
  { operation: "update", run: (bookmarks, index) => bookmarks.update(String(index), { title: "x" }), expected: (index) => sample(index) },
  { operation: "remove", run: (bookmarks, index) => bookmarks.remove(String(index)), expected: () => undefined },
  { operation: "removeTree", run: (bookmarks, index) => bookmarks.removeTree(String(index)), expected: () => undefined }
]

/** One kind of call left pending in Chrome until a test answers it. */
interface PendingRunner {
  readonly operation: string
  readonly run: (index: number) => Effect.Effect<CallResult, ChromeBookmarksError>
}

const isFailing = (mode: Mode): boolean => mode === "reject" || mode === "rejectLate" || mode === "throw"

describe("ChromeBookmarks call stress", () => {
  it.effect("types 1,100 concurrent calls with interleaved rejections, late rejections and throws", () => Effect.gen(function*() {
    const random = seeded(1100)

    const calls = range(1100).map((index) => {
      const entry = operations[index % operations.length]

      if (entry === undefined) throw new Error("no operation")

      return { index, ...entry, mode: pick(random, modes) }
    })

    const plan = new Map<string, Mode>()
    const treeModes: Array<Mode> = []

    for (const call of calls) {
      if (call.operation === "getTree") {
        treeModes.push(call.mode)
        plan.set(`getTree:${treeModes.length}`, call.mode)
      } else plan.set(`${call.operation}:${call.index}`, call.mode)
    }

    const { api, causes } = plannedApi(calls.length, plan)
    const bookmarks = make(api)
    const exits = yield* Effect.forEach(calls, (call) => Effect.exit(call.run(bookmarks, call.index)), { concurrency: "unbounded" })
    const treeCauses = new Set<unknown>()
    let treeFailures = 0

    for (const [position, exit] of exits.entries()) {
      const call = calls[position]

      if (call === undefined) throw new Error("missing call")

      expect(Exit.hasDies(exit)).toBe(false)
      expect(Exit.hasInterrupts(exit)).toBe(false)

      if (call.operation === "getTree") {
        if (Exit.isFailure(exit)) {
          treeFailures++
          const error = yield* Effect.flip(exit)
          expect(error).toBeInstanceOf(ChromeBookmarksError)
          expect(error.operation).toBe("getTree")
          treeCauses.add(error.cause)
        } else expect(exit).toEqual(Exit.succeed([]))

        continue
      }

      expect(Exit.isFailure(exit)).toBe(isFailing(call.mode))

      if (isFailing(call.mode)) {
        const error = yield* Effect.flip(exit)
        expect(error).toBeInstanceOf(ChromeBookmarksError)
        expect(error.operation).toBe(call.operation)
        expect(error.cause).toBe(causes.get(`${call.operation}:${call.index}`))
      } else expect(yield* exit).toEqual(call.expected(call.index))
    }

    const plannedTreeFailures = treeModes.flatMap((mode, position) => isFailing(mode) ? [causes.get(`getTree:${position + 1}`)] : [])
    expect(treeFailures).toBe(plannedTreeFailures.length)
    expect(treeCauses).toEqual(new Set(plannedTreeFailures))
    expect(new Set(calls.map(({ mode }) => mode))).toEqual(new Set(modes))
  }))

  it.effect("interrupts 1,024 in-flight calls cleanly while the rest settle after Chrome answers", () => Effect.gen(function*() {
    const arrived = gate()
    const answer = gate()
    let arrivals = 0

    const pending = <A>(index: number, value: A): Promise<A> => {
      arrivals++

      if (arrivals === 2048) arrived.open()

      return answer.promise.then(() => index % 3 === 0 ? Promise.reject(new Error(`late ${index}`)) : value)
    }

    const api: ChromeBookmarksApi = {
      ...TestBookmarks.makeBookmarks().api,
      getChildren: (id) => pending(Number(id), [sample(Number(id))]),
      create: (details) => pending(Number(details.title), sample(Number(details.title))),
      removeTree: (id) => pending(Number(id), undefined)
    }

    const bookmarks = make(api)

    const runners: ReadonlyArray<PendingRunner> = [
      { operation: "getChildren", run: (index) => bookmarks.getChildren(String(index)) },
      { operation: "create", run: (index) => bookmarks.create({ title: String(index) }) },
      { operation: "removeTree", run: (index) => bookmarks.removeTree(String(index)) }
    ]

    const calls = range(2048).map((index) => {
      const runner = runners[index % runners.length]

      if (runner === undefined) throw new Error("no runner")

      return { index, operation: runner.operation, effect: runner.run(index) }
    })

    const fibers = yield* Effect.forEach(calls, ({ effect }) => Effect.forkChild(Effect.exit(effect)))
    yield* Effect.promise(() => arrived.promise)
    // Interrupt every other call while Chrome has not answered any of them.
    yield* Effect.forEach(fibers.filter((_, index) => index % 2 === 0), Fiber.interrupt, { concurrency: "unbounded" })
    answer.open()

    for (const [index, fiber] of fibers.entries()) {
      const call = calls[index]

      if (call === undefined) throw new Error("missing call")

      const outer = yield* Fiber.await(fiber)

      if (index % 2 === 0) {
        expect(Exit.hasInterrupts(outer)).toBe(true)

        continue
      }

      const exit = yield* outer
      expect(Exit.hasDies(exit)).toBe(false)

      if (index % 3 === 0) {
        const error = yield* Effect.flip(exit)
        expect(error).toBeInstanceOf(ChromeBookmarksError)
        expect(error).toMatchObject({ operation: call.operation, cause: new Error(`late ${index}`) })
      } else expect(Exit.isSuccess(exit)).toBe(true)
    }
  }))
})

/** Replays raw move events on a model of the folders, checking each against the model. */
const replayMoves = (model: Map<string, Array<string>>, moves: ReadonlyArray<readonly [string, MoveInfo]>) => {
  for (const [id, info] of moves) {
    const from = model.get(info.oldParentId) ?? []
    expect(from[info.oldIndex]).toBe(id)
    from.splice(info.oldIndex, 1)
    const to = model.get(info.parentId) ?? []
    expect(info.index).toBeLessThanOrEqual(to.length)
    to.splice(info.index, 0, id)
    model.set(info.parentId, to)
  }
}

const childIds = (fixture: Fixture, folderId: string): Array<string> =>
  (fixture.controls.node(folderId)?.children ?? []).map(({ id }) => id)

/** Every node with its parent and index consistent, counted without recursion. */
const checkTree = (root: BookmarkTreeNode): number => {
  let count = 0
  const pending = [root]

  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    count++

    for (const [index, child] of (next.children ?? []).entries()) {
      expect(child.parentId).toBe(next.id)
      expect(child.index).toBe(index)
      pending.push(child)
    }
  }

  return count
}

const padded = (value: number) => String(value).padStart(3, "0")

describe("ChromeBookmarks fixture stress", () => {
  it.effect("holds 10,100 nodes created concurrently, consistent for every read and removed folder by folder", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)

    const folders = yield* Effect.forEach(range(100), (folder) => Effect.gen(function*() {
      const created = yield* bookmarks.create({ parentId: TestBookmarks.bookmarksBarId, title: `F${padded(folder)}` })
      yield* Effect.forEach(range(100), (item) => bookmarks.create({
        parentId: created.id, title: `F${padded(folder)} I${padded(item)}`, url: `https://f${padded(folder)}.example/i${padded(item)}`
      }), { concurrency: "unbounded" })

      return created
    }), { concurrency: "unbounded" })

    expect(fixture.controls.size).toBe(4 + 100 + 10_000)
    const [root] = yield* bookmarks.getTree
    expect(root === undefined ? 0 : checkTree(root)).toBe(fixture.controls.size)
    expect(titles(yield* bookmarks.getChildren(TestBookmarks.bookmarksBarId))).toHaveLength(100)
    expect(titles(yield* bookmarks.search("f007 i042"))).toEqual(["F007 I042"])
    expect(yield* bookmarks.search("i042")).toHaveLength(100)
    expect(yield* bookmarks.search("f007")).toHaveLength(101)
    expect(titles(yield* bookmarks.search({ url: "https://F099.example/i099" }))).toEqual(["F099 I099"])
    expect(titles(yield* bookmarks.search({ title: "F050" }))).toEqual(["F050"])
    const recent = yield* bookmarks.getRecent(20_000)
    expect(recent).toHaveLength(10_000)
    expect(recent.every((node) => node.url !== undefined)).toBe(true)

    for (const [index, node] of recent.slice(1).entries()) expect(node.dateAdded ?? 0).toBeLessThanOrEqual(recent[index]?.dateAdded ?? 0)

    expect(yield* bookmarks.getRecent(5)).toEqual(recent.slice(0, 5))
    const removals: Array<RemoveInfo> = []
    fixture.api.onRemoved.addListener((_, info) => { removals.push(info) })
    yield* Effect.forEach(folders, (folder) => bookmarks.removeTree(folder.id), { concurrency: "unbounded" })
    expect(removals).toHaveLength(100)
    expect(removals.reduce((total, { node }) => total + (node.children?.length ?? 0), 0)).toBe(10_000)
    expect(fixture.controls.size).toBe(4)
    expect(yield* bookmarks.search({})).toEqual([])
    expect(yield* bookmarks.getRecent(1)).toEqual([])
  }))

  it.effect("handles a 20,000-folder chain without recursion limits", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)
    const chain: Array<BookmarkTreeNode> = []

    for (let depth = 0; depth < 20_000; depth++) {
      chain.push(yield* bookmarks.create({ parentId: chain.at(-1)?.id ?? TestBookmarks.otherBookmarksId, title: `d${depth}` }))
    }

    const top = chain[0]
    const bottom = chain.at(-1)

    if (top === undefined || bottom === undefined) throw new Error("empty chain")

    const [subTree] = yield* bookmarks.getSubTree(top.id)
    expect(subTree === undefined ? 0 : checkTree(subTree)).toBe(20_000)
    expect(yield* Effect.flip(bookmarks.move(top.id, { parentId: bottom.id }))).toMatchObject({
      operation: "move", cause: new Error("Can't move a folder to itself or its descendant.")
    })
    expect(yield* bookmarks.move(bottom.id, { parentId: TestBookmarks.mobileBookmarksId })).toMatchObject({ parentId: "3", index: 0 })
    expect(yield* Effect.flip(bookmarks.remove(top.id))).toMatchObject({ operation: "remove" })
    const removed = yield* Effect.forkChild(Stream.runCollect(Stream.take(bookmarks.onRemoved, 1)))
    yield* Effect.promise(() => fixture.controls.onRemoved.waitForListener())
    yield* bookmarks.removeTree(top.id)
    const [removal] = yield* Fiber.join(removed)
    expect(removal === undefined ? 0 : checkTree(removal.node)).toBe(19_999)
    expect(fixture.controls.size).toBe(5)
  }))

  it.effect("keeps a folder a permutation through 1,024 racing same-folder moves", () => Effect.gen(function*() {
    const random = seeded(64)
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)
    const nodes = yield* Effect.forEach(range(64), (index) => bookmarks.create({ title: `m${index}`, url: `https://m${index}.example/` }))
    const moves: Array<readonly [string, MoveInfo]> = []
    fixture.api.onMoved.addListener((id, info) => { moves.push([id, info]) })
    const plan = range(1024).map(() => ({ id: pick(random, nodes).id, index: below(random, 65) }))
    const results = yield* Effect.forEach(plan, ({ id, index }) => bookmarks.move(id, { index }), { concurrency: "unbounded" })
    expect(results.every((node) => node.parentId === "2" && (node.index ?? -1) >= 0 && (node.index ?? 64) < 64)).toBe(true)
    // Moving to a node's own index or the next one is a no-op that fires nothing.
    expect(moves.length).toBeLessThan(1024)
    expect(moves.length).toBeGreaterThan(900)
    const model = new Map([["2", nodes.map(({ id }) => id)]])
    replayMoves(model, moves)
    const final = childIds(fixture, "2")
    expect(final).toEqual(model.get("2"))
    expect(new Set(final)).toEqual(new Set(nodes.map(({ id }) => id)))
  }))

  it.effect("conserves every node through 1,024 racing cross-folder moves", () => Effect.gen(function*() {
    const random = seeded(1024)
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)
    const folders = [TestBookmarks.bookmarksBarId, TestBookmarks.otherBookmarksId, TestBookmarks.mobileBookmarksId]
    const nodes = yield* Effect.forEach(range(96), (index) => bookmarks.create({ parentId: pick(random, folders), title: `x${index}` }))
    const model = new Map(folders.map((folder) => [folder, childIds(fixture, folder)] as const))
    const moves: Array<readonly [string, MoveInfo]> = []
    fixture.api.onMoved.addListener((id, info) => { moves.push([id, info]) })

    yield* Effect.forEach(range(1024), () => {
      const id = pick(random, nodes).id
      const parentId = pick(random, folders)

      return random() < 0.5 ? bookmarks.move(id, { parentId, index: 0 }) : bookmarks.move(id, { parentId })
    }, { concurrency: "unbounded" })

    replayMoves(model, moves)

    for (const folder of folders) expect(childIds(fixture, folder)).toEqual(model.get(folder))

    expect(folders.flatMap((folder) => childIds(fixture, folder)).sort()).toEqual(nodes.map(({ id }) => id).sort())
  }))

  it.effect("orders 1,024 racing creations at index 0 exactly as their events report", () => Effect.gen(function*() {
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)
    const events: Array<CreatedEvent> = []
    fixture.api.onCreated.addListener((id, bookmark) => { events.push({ id, bookmark }) })
    const nodes = yield* Effect.forEach(range(1024), (index) => bookmarks.create({ index: 0, title: `c${index}` }), { concurrency: "unbounded" })
    expect(events).toHaveLength(1024)
    expect(events.every(({ bookmark }) => bookmark.index === 0 && bookmark.parentId === "2")).toBe(true)
    expect(nodes.every(({ index }) => index === 0)).toBe(true)
    expect(childIds(fixture, "2")).toEqual(events.map(({ id }) => id).reverse())
    expect(new Set(events.map(({ id }) => id)).size).toBe(1024)
  }))

  it.effect("resolves 512 update/remove races on the same nodes one way or the other, typed", () => Effect.gen(function*() {
    const random = seeded(512)
    const fixture = TestBookmarks.makeBookmarks()
    const bookmarks = make(fixture.api)
    const nodes = yield* Effect.forEach(range(512), (index) => bookmarks.create({ title: `r${index}`, url: `https://r${index}.example/` }))
    const log: Array<string> = []
    fixture.api.onChanged.addListener((id) => { log.push(`changed:${id}`) })
    fixture.api.onRemoved.addListener((id) => { log.push(`removed:${id}`) })

    const outcomes = yield* Effect.forEach(nodes, (node) => {
      const update = Effect.exit(bookmarks.update(node.id, { title: `renamed ${node.id}` }))
      const remove = Effect.exit(bookmarks.remove(node.id))

      return random() < 0.5
        ? Effect.all([update, remove], { concurrency: "unbounded" })
        : Effect.map(Effect.all([remove, update], { concurrency: "unbounded" }), ([removed, updated]) => [updated, removed] as const)
    }, { concurrency: "unbounded" })

    let updatedFirst = 0

    for (const [position, [updated, removed]] of outcomes.entries()) {
      const id = nodes[position]?.id ?? ""
      expect(Exit.isSuccess(removed)).toBe(true)
      const changedAt = log.indexOf(`changed:${id}`)
      const removedAt = log.indexOf(`removed:${id}`)
      expect(removedAt).toBeGreaterThanOrEqual(0)

      if (Exit.isSuccess(updated)) {
        updatedFirst++
        expect(changedAt).toBeGreaterThanOrEqual(0)
        expect(changedAt).toBeLessThan(removedAt)
      } else {
        expect(changedAt).toBe(-1)
        expect(yield* Effect.flip(updated)).toMatchObject({ operation: "update", cause: new Error("Can't find bookmark for id.") })
      }
    }

    expect(updatedFirst).toBeGreaterThan(0)
    expect(updatedFirst).toBeLessThan(512)
    expect(fixture.controls.size).toBe(4)
  }))
})
