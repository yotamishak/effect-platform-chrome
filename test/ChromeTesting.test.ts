// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Exit, Fiber, Option, Schema, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import * as ChromeTesting from "../src/ChromeTesting.js"
import { makeEvent, makePortPair, makeStorage, makeTabs } from "../src/ChromeTesting.js"
import * as TestEvent from "../src/testing/Event.js"
import * as TestPort from "../src/testing/Port.js"
import * as TestStorage from "../src/testing/Storage.js"
import * as TestTabs from "../src/testing/Tabs.js"
import * as TestWindows from "../src/testing/Windows.js"
import * as ChromeTabs from "../src/ChromeTabs.js"
import * as ChromeWindows from "../src/ChromeWindows.js"
import * as ChromeStorage from "../src/ChromeStorage.js"
import * as ChromePort from "../src/ChromePort.js"

interface CyclicMessage {
  self?: CyclicMessage
}

describe("ChromeTesting events", () => {
  it("re-exports each per-adapter fixture module unchanged", () => {
    expect(ChromeTesting.makeEvent).toBe(TestEvent.makeEvent)
    expect(ChromeTesting.makeStorage).toBe(TestStorage.makeStorage)
    expect(ChromeTesting.makePortPair).toBe(TestPort.makePortPair)
    expect(ChromeTesting.makeTabs).toBe(TestTabs.makeTabs)
  })

  it.effect("keeps 4096-listener snapshots intact across reentrant removal and thrown callbacks", () => Effect.sync(() => {
    const event = makeEvent<[number]>()
    const seen: Array<[number, number]> = []
    const failure = new Error("outer callback failed")
    const listeners = Array.from({ length: 4096 }, (_, index) => (value: number) => { seen.push([index, value]) })
    let nestedErrors: ReadonlyArray<unknown> = []
    event.api.addListener((value) => {
      if (value === 1) {
        for (const listener of listeners) event.api.removeListener(listener)
        nestedErrors = event.controls.emit(2)
        throw failure
      }
    })

    for (const listener of listeners) event.api.addListener(listener)
    expect(event.controls.emit(1)).toEqual([failure])
    expect(nestedErrors).toEqual([])
    expect(seen).toEqual(Array.from({ length: 4096 }, (_, index) => [index, 1]))
    expect(event.controls.listenerCount).toBe(1)
  }))

  it.effect("deduplicates identity and dispatches snapshots including reentrant emissions", () => Effect.sync(() => {
    const event = makeEvent<[number]>()
    const calls: Array<string> = []
    const late = (value: number) => { calls.push(`late:${value}`) }

    const second = (value: number) => { calls.push(`second:${value}`) }

    const first = (value: number) => {
      calls.push(`first:${value}`)
      event.api.removeListener(second)
      event.api.addListener(late)

      if (value === 1) event.controls.emit(2)
    }

    event.api.addListener(first)
    event.api.addListener(first)
    event.api.addListener(second)
    expect(event.api.hasListener(first)).toBe(true)
    expect(event.api.hasListeners()).toBe(true)
    expect(event.controls.listenerCount).toBe(2)
    expect(event.controls.emit(1)).toEqual([])
    expect(calls).toEqual(["first:1", "first:2", "late:2", "second:1"])
    event.api.removeListener(first)
    event.api.removeListener(late)
    expect(event.api.hasListeners()).toBe(false)
    expect(event.controls.listenerCount).toBe(0)
  }))

  it.effect("continues after exceptions and injects one-shot registration failures", () => Effect.gen(function*() {
    const event = makeEvent<[]>()
    const failure = new Error("listener failed")
    let called = false

    event.controls.failNext("addListener", failure)
    expect(() => event.api.addListener(() => {})).toThrow(failure)
    const gate = event.controls.waitForListener()

    event.api.addListener(() => { throw failure })
    event.api.addListener(() => { called = true })
    yield* Effect.promise(() => gate)
    expect(event.controls.emit()).toEqual([failure])
    expect(called).toBe(true)
    expect(() => event.api.addRules()).toThrow("not simulated")
  }))
})

describe("ChromeTesting storage", () => {
  it.effect("deduplicates get selectors without losing prototype-like keys or cloning isolation", () => Effect.gen(function*() {
    const fixture = makeStorage()
    const inputValue = { n: 1 }
    const items = Object.fromEntries([["__proto__", inputValue], ["constructor", { n: 2 }], ["toString", { n: 3 }]])
    const pending = fixture.api.local.set(items)
    inputValue.n = 99
    yield* Effect.promise(() => pending)
    const selected = yield* Effect.promise(() => fixture.api.local.get(["__proto__", "constructor", "toString", "__proto__", "constructor"]))
    expect(selected).toEqual(Object.fromEntries([["__proto__", { n: 1 }], ["constructor", { n: 2 }], ["toString", { n: 3 }]]))
    expect(Object.getPrototypeOf(selected)).toBe(Object.prototype)
    const nestedRead = selected["__proto__"]

    if (!Schema.is(Schema.Struct({ n: Schema.Finite }))(nestedRead)) throw new Error("Expected stored object")
    Object.assign(nestedRead, { n: 88 })
    expect(yield* Effect.promise(() => fixture.api.local.get("__proto__"))).toEqual(Object.fromEntries([["__proto__", { n: 1 }]]))
    const defaultValue = { n: 5 }
    const defaults = Object.fromEntries([["missing", { n: 4 }], ["__proto__", defaultValue]])
    const defaultPending = fixture.api.sync.get(defaults)
    defaultValue.n = 77
    const read = yield* Effect.promise(() => defaultPending)
    expect(read).toEqual(Object.fromEntries([["missing", { n: 4 }], ["__proto__", { n: 5 }]]))
    expect(yield* Effect.promise(() => fixture.api.sync.get())).toEqual({})
  }))

  it.effect("isolates fixtures and areas; supports selectors, defaults and managed policy", () => Effect.gen(function*() {
    const fixture = makeStorage()
    const other = makeStorage()

    fixture.controls.seed("managed", { policy: "locked" })
    yield* Effect.promise(() => fixture.api.local.set({ a: 1, b: null }))
    expect(yield* Effect.promise(() => fixture.api.local.get())).toEqual({ a: 1, b: null })
    expect(yield* Effect.promise(() => fixture.api.local.get("a"))).toEqual({ a: 1 })
    expect(yield* Effect.promise(() => fixture.api.local.get(["b", "absent"]))).toEqual({ b: null })
    expect(yield* Effect.promise(() => fixture.api.local.get({ a: 9, missing: "default", b: 2 })))
      .toEqual({ a: 1, b: null, missing: "default" })
    expect(yield* Effect.promise(() => fixture.api.local.get([]))).toEqual({})
    expect(yield* Effect.promise(() => fixture.api.sync.get())).toEqual({})
    expect(yield* Effect.promise(() => other.api.local.get())).toEqual({})
    const storage = ChromeStorage.make(fixture.api)

    expect(yield* storage.managed.get()).toEqual({ policy: "locked" })
    expect(storage.managed).not.toHaveProperty("set")
    expect(fixture.api.managed).not.toHaveProperty("set")
  }))

  it.effect("clones inputs, reads and defaults with JSON serialization and atomic failures", () => Effect.gen(function*() {
    const fixture = makeStorage()
    const input = { nested: { n: 1 }, omitted: undefined, date: new Date("2020-01-01T00:00:00Z") }
    const pending = fixture.api.session.set(input)

    input.nested.n = 9
    yield* Effect.promise(() => pending)
    const read = yield* Effect.promise(() => fixture.api.session.get())

    expect(read).toEqual({ nested: { n: 1 }, date: "2020-01-01T00:00:00.000Z" })
    Object.assign(read, { nested: { n: 4 } })
    expect(yield* Effect.promise(() => fixture.api.session.get("nested"))).toEqual({ nested: { n: 1 } })
    const defaults = { missing: { n: 2 } }
    const defaultRead = yield* Effect.promise(() => fixture.api.session.get(defaults))

    defaults.missing.n = 5
    expect(defaultRead).toEqual({ missing: { n: 2 } })
    const failure = yield* ChromeStorage.make(fixture.api).session.set({ n: 1n }).pipe(Effect.flip)

    expect(failure.operation).toBe("set")
    expect(yield* Effect.promise(() => fixture.api.session.get())).toEqual({
      nested: { n: 1 }, date: "2020-01-01T00:00:00.000Z"
    })
  }))

  it.effect("emits only actual changes, including removal and clear, without exposing backend references", () => Effect.gen(function*() {
    const fixture = makeStorage()
    const changes: Array<ChromeStorage.Change> = []
    const localChanges: Array<ChromeStorage.Change["changes"]> = []

    fixture.api.onChanged.addListener((delta, area) => {
      changes.push({ changes: structuredClone(delta), area })
      Object.assign(delta, { injected: { newValue: 42 } })
      Object.assign(delta["key"]?.newValue ?? {}, { a: 99 })
    })
    fixture.api.local.onChanged.addListener((delta) => {
      localChanges.push(delta)
    })
    yield* Effect.promise(() => fixture.api.local.set({ key: { a: 1, b: 2 }, keep: true }))
    expect(yield* Effect.promise(() => fixture.api.local.get("key"))).toEqual({ key: { a: 1, b: 2 } })
    yield* Effect.promise(() => fixture.api.local.set({ key: { b: 2, a: 1 } }))
    yield* Effect.promise(() => fixture.api.local.remove(["missing", "key", "key"]))
    yield* Effect.promise(() => fixture.api.local.clear())
    yield* Effect.promise(() => fixture.api.local.clear())
    expect(changes).toEqual([
      { area: "local", changes: { key: { newValue: { a: 1, b: 2 } }, keep: { newValue: true } } },
      { area: "local", changes: { key: { oldValue: { a: 1, b: 2 } } } },
      { area: "local", changes: { keep: { oldValue: true } } }
    ])
    expect(localChanges).toEqual(changes.map((change) => change.changes))
    expect(yield* Effect.promise(() => fixture.api.local.get())).toEqual({})
  }))

  it.effect("supports special keys and honest byte approximation with deduplicated selectors", () => Effect.gen(function*() {
    const fixture = makeStorage()
    const items = Object.fromEntries([["__proto__", "safe"], ["é", "字"]])

    yield* Effect.promise(() => fixture.api.sync.set(items))
    expect(yield* Effect.promise(() => fixture.api.sync.get())).toEqual(items)
    expect(yield* Effect.promise(() => fixture.api.sync.getBytesInUse(["é", "é", "missing"]))).toBe(7)
    yield* Effect.promise(() => fixture.api.sync.remove("__proto__"))
    expect(yield* Effect.promise(() => fixture.api.sync.get())).toEqual({ é: "字" })
  }))

  it.effect("provides test layers and area-scoped one-shot failures", () => Effect.gen(function*() {
    const fixture = makeStorage()
    const cause = new Error("injected")

    fixture.controls.failNext("local", "set", cause)
    yield* Effect.gen(function*() {
      const storage = yield* ChromeStorage.ChromeStorage
      const failure = yield* storage.local.set({ x: 1 }).pipe(Effect.flip)

      expect(failure).toMatchObject({ area: "local", operation: "set", cause })
      expect(yield* storage.local.get()).toEqual({})
      yield* storage.local.set({ x: 2 })
      yield* storage.sync.set({ x: 3 })
      expect(yield* storage.local.get()).toEqual({ x: 2 })
    }).pipe(Effect.provide(fixture.layer))
  }))

  it.effect("gates service stream registration and cleans up on completion and interruption", () => Effect.gen(function*() {
    const fixture = makeStorage()
    const storage = ChromeStorage.make(fixture.api)
    const fiber = yield* Effect.forkScoped(Stream.runCollect(Stream.take(storage.managed.onChanged, 1)))

    yield* Effect.promise(() => fixture.controls.onChanged.waitForListener())
    fixture.controls.seed("local", { ignored: true }, true)
    fixture.controls.seed("managed", { policy: true }, true)
    expect(yield* Fiber.join(fiber)).toEqual([{ area: "managed", changes: { policy: { newValue: true } } }])
    expect(fixture.controls.onChanged.listenerCount).toBe(0)
    const waiting = yield* Effect.forkScoped(Stream.runDrain(storage.onChanged))

    yield* Effect.promise(() => fixture.controls.onChanged.waitForListener())
    yield* Fiber.interrupt(waiting)
    expect(fixture.controls.onChanged.listenerCount).toBe(0)
  }))
})

describe("ChromeTesting port pair", () => {
  it.effect("serializes before queueing and never mutates message inputs", () => Effect.sync(() => {
    const fixture = makePortPair()
    const received: Array<unknown> = []
    fixture.right.port.onMessage.addListener((message) => { received.push(message) })
    const input = { nested: { n: 1 }, omitted: undefined }
    fixture.left.port.postMessage(input)
    expect(input).toEqual({ nested: { n: 1 }, omitted: undefined })
    input.nested.n = 2
    const cyclic: CyclicMessage = {}
    cyclic.self = cyclic

    for (const value of [undefined, 1n, cyclic]) {
      expect(() => fixture.left.port.postMessage(value)).toThrow()
      expect(fixture.controls.pendingCount).toBe(1)
    }

    fixture.controls.flush()
    expect(received).toEqual([{ nested: { n: 1 } }])
    expect(input).toEqual({ nested: { n: 2 }, omitted: undefined })
  }))

  it.effect("delivers 8192 FIFO messages bidirectionally and drops 4096 queued messages at midqueue disconnect", () => Effect.sync(() => {
    const fixture = makePortPair()
    const left: Array<number> = []
    const right: Array<number> = []
    fixture.left.port.onMessage.addListener((message: number) => { left.push(message) })
    fixture.right.port.onMessage.addListener((message: number) => { right.push(message) })

    for (let index = 0; index < 4096; index++) {
      fixture.left.port.postMessage(index)
      fixture.right.port.postMessage(index)
    }

    expect(fixture.controls.pendingCount).toBe(8192)
    fixture.controls.flush()
    expect(left).toEqual(Array.from({ length: 4096 }, (_, index) => index))
    expect(right).toEqual(left)
    let disconnects = 0
    fixture.right.port.onDisconnect.addListener(() => { disconnects++ })
    fixture.right.port.onMessage.addListener(() => { fixture.left.port.disconnect() })

    for (let index = 0; index < 4097; index++) fixture.left.port.postMessage(index)
    expect(fixture.controls.flushOne()).toBe(true)
    fixture.right.port.disconnect()
    fixture.controls.disconnect("must not overwrite native disconnect")
    fixture.controls.flush()
    expect(right).toHaveLength(4097)
    expect(disconnects).toBe(1)
    expect(fixture.controls.pendingCount).toBe(0)
    expect(fixture.controls.flushOne()).toBe(false)
  }))

  it.effect("preserves callback lastError across throwing and reentrant listeners", () => Effect.sync(() => {
    const fixture = makePortPair()
    const errors: Array<string | undefined> = []
    const failure = new Error("disconnect listener failed")
    fixture.left.port.onDisconnect.addListener(() => {
      errors.push(fixture.left.api.lastError?.message)
      fixture.left.port.disconnect()
      fixture.controls.disconnect("replacement")
      fixture.controls.flush()
      errors.push(fixture.left.api.lastError?.message)
      throw failure
    })
    fixture.left.port.onDisconnect.addListener(() => { errors.push(fixture.left.api.lastError?.message) })
    fixture.right.port.onDisconnect.addListener(() => { errors.push(fixture.right.api.lastError?.message) })
    fixture.controls.disconnect("native failure")
    fixture.controls.flush()
    expect(errors).toEqual(Array.from({ length: 4 }, () => "native failure"))
    expect(fixture.left.api.lastError).toBeUndefined()
    expect(fixture.right.api.lastError).toBeUndefined()
  }))

  it.effect("defers cloned FIFO delivery and leaves reentrant posts for the next flush", () => Effect.sync(() => {
    const fixture = makePortPair("pair")
    const received: Array<unknown> = []
    const replies: Array<unknown> = []

    fixture.right.port.onMessage.addListener((message) => {
      received.push(message)
      fixture.right.port.postMessage("reply")
    })
    fixture.left.port.onMessage.addListener((message) => { replies.push(message) })
    const value = { n: 1 }

    fixture.left.port.postMessage(value)
    value.n = 9
    fixture.left.port.postMessage(2)
    expect(received).toEqual([])
    fixture.controls.flush()
    expect(received).toEqual([{ n: 1 }, 2])
    expect(replies).toEqual([])
    expect(fixture.controls.pendingCount).toBe(2)
    fixture.controls.flush()
    expect(replies).toEqual(["reply", "reply"])
    expect(fixture.controls.flushOne()).toBe(false)
  }))

  it.effect("native disconnect notifies only the peer once and discards undelivered messages", () => Effect.sync(() => {
    const fixture = makePortPair()
    let left = 0
    let right = 0
    let messages = 0

    fixture.left.port.onDisconnect.addListener(() => { left++ })
    fixture.right.port.onDisconnect.addListener(() => { right++ })
    fixture.right.port.onMessage.addListener(() => { messages++ })
    fixture.left.port.postMessage("pending")
    fixture.left.port.disconnect()
    fixture.left.port.disconnect()
    expect(fixture.controls.connected).toBe(false)
    expect(() => fixture.right.port.postMessage(1)).toThrow("disconnected")
    fixture.controls.flush()
    expect([left, right, messages]).toEqual([0, 1, 0])
  }))

  it.effect("scopes lastError to disconnect callbacks and supports service failure/cleanup", () => Effect.gen(function*() {
    const fixture = makePortPair("test")
    let observed: string | undefined

    fixture.right.port.onDisconnect.addListener(() => { observed = fixture.right.api.lastError?.message })
    yield* Effect.scoped(Effect.gen(function*() {
      const port = yield* ChromePort.make(fixture.left.api).connect()

      expect(port.name).toBe("test")
      expect(fixture.controls.left.message.listenerCount).toBe(1)
      const cause = new Error("send failure")

      fixture.controls.left.failNext("postMessage", cause)
      expect(yield* port.send(1).pipe(Effect.flip)).toMatchObject({ operation: "send", cause })
      fixture.controls.disconnect("lost")
      fixture.controls.flush()
      expect(fixture.left.api.lastError).toBeUndefined()
      expect(fixture.right.api.lastError).toBeUndefined()
      expect(observed).toBe("lost")
      expect(yield* Stream.runDrain(port.messages).pipe(Effect.flip)).toMatchObject({ operation: "disconnect", message: "lost" })
    }))
    expect(fixture.controls.left.message.listenerCount).toBe(0)
    expect(fixture.controls.left.disconnect.listenerCount).toBe(0)
  }))

  it.effect("service adoption receives messages and owned scope cleanup disconnects the peer", () => Effect.gen(function*() {
    const fixture = makePortPair()

    yield* Effect.scoped(Effect.gen(function*() {
      const port = yield* ChromePort.make(fixture.right.api).adopt(fixture.right.port, "owned")

      fixture.left.port.postMessage("one")
      fixture.left.port.postMessage("two")
      fixture.controls.flush()
      expect(yield* Stream.runCollect(Stream.take(port.messages, 2))).toEqual(["one", "two"])
    }))
    expect(fixture.controls.right.message.listenerCount).toBe(0)
    expect(fixture.controls.right.disconnect.listenerCount).toBe(0)
    expect(fixture.controls.connected).toBe(false)
    fixture.controls.flush()
  }))

  it.effect("records storage access levels from Chrome's defaults", () => Effect.gen(function*() {
    const fixture = makeStorage()
    expect(fixture.controls.accessLevel("local")).toBe("TRUSTED_AND_UNTRUSTED_CONTEXTS")
    expect(fixture.controls.accessLevel("session")).toBe("TRUSTED_CONTEXTS")
    const storage = yield* ChromeStorage.ChromeStorage.pipe(Effect.provide(fixture.layer))
    yield* storage.local.setAccessLevel("TRUSTED_CONTEXTS")
    expect(fixture.controls.accessLevel("local")).toBe("TRUSTED_CONTEXTS")
    fixture.controls.failNext("session", "setAccessLevel", new Error("denied"))
    expect(yield* Effect.flip(storage.session.setAccessLevel("TRUSTED_CONTEXTS"))).toMatchObject({ operation: "setAccessLevel" })
  }))
})

describe("ChromeTesting tabs", () => {
  it.effect("keeps tabs in memory and emits their events", () => Effect.gen(function*() {
    const fixture = makeTabs()
    const tabs = yield* ChromeTabs.ChromeTabs.pipe(Effect.provide(fixture.layer))
    const removed = yield* Effect.forkScoped(Stream.runCollect(Stream.take(tabs.onRemoved, 1)))
    yield* Effect.promise(() => fixture.controls.onRemoved.waitForListener())
    const created = yield* tabs.create({ url: "https://app.example/", active: false })
    const seeded = fixture.controls.seed({ url: "https://other.example/", windowId: 2 })
    expect(created.id).not.toBe(seeded.id)
    expect((yield* tabs.query({ windowId: 2 })).map((tab) => tab.id)).toEqual([seeded.id])
    expect((yield* tabs.query({ url: "https://app.example/" })).map((tab) => tab.id)).toEqual([created.id])
    yield* tabs.update(created.id, { url: "https://app.example/next", active: true })
    expect(yield* tabs.get(created.id ?? -1)).toMatchObject({ url: "https://app.example/next", active: true })
    yield* tabs.remove(created.id ?? -1)
    expect((yield* Fiber.join(removed))[0]?.tabId).toBe(created.id)
    expect(yield* Effect.flip(tabs.get(created.id ?? -1))).toMatchObject({ operation: "get" })
    expect(Exit.isFailure(yield* Effect.exit(tabs.sendMessage(seeded.id ?? -1, "hello")))).toBe(true)
  }))

  it.effect("hands out port pairs and accepts member overrides", () => Effect.gen(function*() {
    let gets = 0

    const fixture = makeTabs({
      get: async (tabId) => {
        gets++

        return { ...fixture.controls.tab(tabId), id: tabId, index: 0, windowId: 1, highlighted: false, active: true, pinned: false, incognito: false, discarded: false, autoDiscardable: true, groupId: -1, frozen: false, selected: true, lastAccessed: 0, url: "about:blank" }
      }
    })

    const tabs = yield* ChromeTabs.ChromeTabs.pipe(Effect.provide(fixture.layer))
    expect((yield* tabs.get(4)).url).toBe("about:blank")
    expect(gets).toBe(1)
    const port = yield* tabs.connect(4, { name: "example-frame", frameId: 1 })
    expect(port.name).toBe("example-frame")
    expect(fixture.controls.connections).toHaveLength(1)
    expect(fixture.controls.connections[0]).toMatchObject({ tabId: 4, connectInfo: { name: "example-frame", frameId: 1 } })
    expect(yield* tabs.captureVisibleTab(1)).toBe("data:image/jpeg;base64,")
  }))
})

describe("ChromeTesting tab strip", () => {
  it.effect("orders tabs per window and emits move, detach and attach events", () => Effect.gen(function*() {
    const fixture = makeTabs()
    const tabs = yield* ChromeTabs.ChromeTabs.pipe(Effect.provide(fixture.layer))
    const first = fixture.controls.seed().id ?? -1
    const second = fixture.controls.seed().id ?? -1
    const third = fixture.controls.seed().id ?? -1
    const other = fixture.controls.seed({ windowId: 2 }).id ?? -1
    const inserted = (yield* tabs.create({ windowId: 2, index: 0 })).id ?? -1
    expect((yield* tabs.query({ windowId: 2 })).map((tab) => [tab.id, tab.index])).toEqual([[inserted, 0], [other, 1]])
    const moved = yield* Effect.forkScoped(Stream.runCollect(Stream.take(tabs.onMoved, 1)))
    const detached = yield* Effect.forkScoped(Stream.runCollect(Stream.take(tabs.onDetached, 1)))
    const attached = yield* Effect.forkScoped(Stream.runCollect(Stream.take(tabs.onAttached, 1)))
    yield* Effect.promise(() => Promise.all([
      fixture.controls.onMoved.waitForListener(), fixture.controls.onDetached.waitForListener(), fixture.controls.onAttached.waitForListener()
    ]))
    expect((yield* tabs.move(first, { index: -1 })).map((tab) => tab.index)).toEqual([2])
    expect((yield* tabs.move([second], { index: 1, windowId: 2 })).map((tab) => [tab.windowId, tab.index])).toEqual([[2, 1]])
    expect(yield* Effect.all([Fiber.join(moved), Fiber.join(detached), Fiber.join(attached)])).toEqual([
      [{ tabId: first, moveInfo: { windowId: 1, fromIndex: 0, toIndex: 2 } }],
      [{ tabId: second, detachInfo: { oldWindowId: 1, oldPosition: 0 } }],
      [{ tabId: second, attachInfo: { newWindowId: 2, newPosition: 1 } }]
    ])
    expect((yield* tabs.query({ windowId: 1 })).map((tab) => [tab.id, tab.index])).toEqual([[third, 0], [first, 1]])
    expect((yield* tabs.query({ windowId: 2 })).map((tab) => tab.id)).toEqual([inserted, second, other])
    yield* tabs.remove(inserted)
    expect((yield* tabs.query({ windowId: 2 })).map((tab) => tab.index)).toEqual([0, 1])
    expect(fixture.controls.onMoved.listenerCount + fixture.controls.onAttached.listenerCount).toBe(0)
  }))

  it.effect("duplicates, reloads, discards and groups tabs, emitting their updates", () => Effect.gen(function*() {
    const fixture = makeTabs()
    const tabs = yield* ChromeTabs.ChromeTabs.pipe(Effect.provide(fixture.layer))
    const original = fixture.controls.seed({ url: "https://app.example/", pinned: true }).id ?? -1
    const updates = yield* Effect.forkScoped(Stream.runCollect(Stream.take(tabs.onUpdated, 6)))
    yield* Effect.promise(() => fixture.controls.onUpdated.waitForListener())
    const copy = Option.getOrThrow(yield* tabs.duplicate(original))
    const copyId = copy.id ?? -1
    expect(copy).toMatchObject({ url: "https://app.example/", pinned: true, index: 1, active: true })
    expect(copyId).not.toBe(original)
    yield* tabs.reload(original, { bypassCache: true })
    expect(yield* tabs.discard(original)).toEqual(Option.some(expect.objectContaining({ id: original, discarded: true })))
    expect(yield* tabs.discard(original)).toEqual(Option.some(expect.objectContaining({ discarded: true })))
    const groupId = yield* tabs.group({ tabIds: [original, copyId] })
    expect(yield* tabs.group({ tabIds: original, groupId })).toBe(groupId)
    expect((yield* tabs.query({ groupId })).map((tab) => tab.id)).toEqual([original, copyId])
    yield* tabs.ungroup(original)
    expect((yield* Fiber.join(updates)).map((update) => update.changeInfo)).toEqual([
      { status: "loading" }, { status: "complete" }, { discarded: true }, { groupId }, { groupId }, { groupId: -1 }
    ])
    expect(fixture.controls.tab(original)).toMatchObject({ groupId: -1, status: "complete", discarded: true })
    expect(yield* Effect.flip(tabs.group({ tabIds: original, groupId: 99 }))).toMatchObject({ operation: "group" })
    yield* tabs.ungroup(copyId)
    expect(yield* Effect.flip(tabs.group({ tabIds: original, groupId }))).toMatchObject({ operation: "group" })
    expect(yield* Effect.flip(tabs.discard())).toMatchObject({ operation: "discard" })
  }))

  it.effect("keeps zoom per tab and rejects history navigation", () => Effect.gen(function*() {
    const fixture = makeTabs()
    const tabs = yield* ChromeTabs.ChromeTabs.pipe(Effect.provide(fixture.layer))
    const background = fixture.controls.seed({ active: false }).id ?? -1
    const active = fixture.controls.seed().id ?? -1
    const zoomed = yield* Effect.forkScoped(Stream.runCollect(Stream.take(tabs.onZoomChange, 2)))
    yield* Effect.promise(() => fixture.controls.onZoomChange.waitForListener())
    yield* tabs.setZoom(background, 2)
    yield* tabs.setZoom(background, 2)
    yield* tabs.setZoom(undefined, 1.5)
    expect([yield* tabs.getZoom(background), yield* tabs.getZoom()]).toEqual([2, 1.5])
    expect((yield* Fiber.join(zoomed)).map((change) => [change.tabId, change.oldZoomFactor, change.newZoomFactor])).toEqual([
      [background, 1, 2], [active, 1, 1.5]
    ])
    yield* tabs.setZoom(background, 0)
    expect(yield* tabs.getZoom(background)).toBe(1)
    yield* tabs.setZoomSettings(background, { mode: "manual" })
    expect(yield* tabs.getZoomSettings(background)).toEqual({ mode: "manual", scope: "per-origin", defaultZoomFactor: 1 })
    expect(yield* tabs.getZoomSettings()).toEqual({ mode: "automatic", scope: "per-origin", defaultZoomFactor: 1 })
    expect(yield* tabs.detectLanguage(background)).toBe("und")
    expect(yield* Effect.flip(tabs.goBack(background))).toMatchObject({ operation: "goBack" })
    expect(yield* Effect.flip(tabs.goForward())).toMatchObject({ operation: "goForward" })
    expect(yield* Effect.flip(tabs.getZoom(99))).toMatchObject({ operation: "getZoom" })
  }))
})

describe("ChromeTesting windows", () => {
  it.effect("tracks focus across create, update and remove", () => Effect.gen(function*() {
    const fixture = TestWindows.makeWindows()
    const windows = yield* ChromeWindows.ChromeWindows.pipe(Effect.provide(fixture.layer))
    const focusChanges = yield* Effect.forkScoped(Stream.runCollect(Stream.take(windows.onFocusChanged(), 5)))
    yield* Effect.promise(() => fixture.controls.onFocusChanged.waitForListener())
    const first = Option.getOrThrow(yield* windows.create()).id ?? -1
    const popup = Option.getOrThrow(yield* windows.create({ type: "popup", width: 400 }))
    const second = popup.id ?? -1
    const background = Option.getOrThrow(yield* windows.create({ focused: false })).id ?? -1
    expect(popup).toMatchObject({ type: "popup", width: 400, focused: true })
    expect((yield* windows.get(first)).focused).toBe(false)
    expect(fixture.controls.focused).toBe(second)
    yield* windows.focus(first)
    yield* windows.remove(first)
    expect(fixture.controls.focused).toBe(second)
    expect((yield* windows.getLastFocused()).id).toBe(second)
    expect((yield* windows.getCurrent()).id).toBe(second)
    yield* windows.update(second, { focused: false })
    expect(yield* Fiber.join(focusChanges)).toEqual([first, second, first, second, -1])
    expect(fixture.controls.focused).toBe(-1)
    expect((yield* windows.getLastFocused()).id).toBe(second)
    expect((yield* windows.getAll()).map((window) => window.id)).toEqual([second, background])
    expect((yield* windows.getAll({ windowTypes: ["normal"] })).map((window) => window.id)).toEqual([background])
    expect(yield* Effect.flip(windows.get(first))).toMatchObject({ operation: "get" })
    expect(yield* Effect.flip(windows.remove(first))).toMatchObject({ operation: "remove" })
  }))

  it.effect("honours window-type filters on events and queries", () => Effect.gen(function*() {
    const fixture = TestWindows.makeWindows()
    const unfiltered: Array<number> = []
    const devtools: Array<number> = []
    const popupsRemoved: Array<number> = []
    const recordUnfiltered = (window: chrome.windows.Window) => { unfiltered.push(window.id ?? -1) }

    fixture.api.onCreated.addListener(recordUnfiltered)
    fixture.api.onCreated.addListener((window) => { devtools.push(window.id ?? -1) }, { windowTypes: ["devtools"] })
    fixture.api.onRemoved.addListener((windowId) => { popupsRemoved.push(windowId) }, { windowTypes: ["popup"] })
    const normal = fixture.controls.seed().id ?? -1
    const tools = fixture.controls.seed({ type: "devtools", focused: true }).id ?? -1
    const popup = (yield* Effect.promise(() => fixture.api.create({ type: "popup", focused: false })))?.id ?? -1
    yield* Effect.promise(() => fixture.api.remove(normal))
    yield* Effect.promise(() => fixture.api.remove(popup))
    expect(unfiltered).toEqual([normal, popup])
    expect(devtools).toEqual([tools])
    expect(popupsRemoved).toEqual([popup])
    fixture.api.onCreated.removeListener(recordUnfiltered)
    expect(fixture.controls.onCreated.listenerCount).toBe(1)
    const windows = yield* ChromeWindows.ChromeWindows.pipe(Effect.provide(fixture.layer))
    expect(yield* Effect.flip(windows.get(tools))).toMatchObject({ operation: "get" })
    expect((yield* windows.get(tools, { windowTypes: ["devtools"] })).id).toBe(tools)
    expect(yield* Effect.flip(windows.getLastFocused())).toMatchObject({ operation: "getLastFocused" })
    expect((yield* windows.getLastFocused({ windowTypes: ["devtools"] })).id).toBe(tools)
  }))

  it.effect("streams filtered creations and bounds changes through the service", () => Effect.gen(function*() {
    const fixture = TestWindows.makeWindows()
    const windows = yield* ChromeWindows.ChromeWindows.pipe(Effect.provide(fixture.layer))
    const popups = yield* Effect.forkScoped(Stream.runCollect(Stream.take(windows.onCreated({ windowTypes: ["popup"] }), 1)))
    yield* Effect.promise(() => fixture.controls.onCreated.waitForListener())
    const bounds = yield* Effect.forkScoped(Stream.runCollect(Stream.take(windows.onBoundsChanged, 1)))
    yield* Effect.promise(() => fixture.controls.onBoundsChanged.waitForListener())
    const normal = Option.getOrThrow(yield* windows.create()).id ?? -1
    const popup = Option.getOrThrow(yield* windows.create({ type: "popup" })).id ?? -1
    yield* windows.update(normal, { state: "maximized" })
    yield* windows.update(normal, { width: 1280, left: 10 })
    expect((yield* Fiber.join(popups)).map((window) => window.id)).toEqual([popup])
    expect(yield* Fiber.join(bounds)).toEqual([expect.objectContaining({ id: normal, left: 10, width: 1280, state: "maximized" })])
    expect(fixture.controls.onCreated.listenerCount + fixture.controls.onBoundsChanged.listenerCount).toBe(0)
  }))

  it.effect("accepts member overrides", () => Effect.gen(function*() {
    const fixture = TestWindows.makeWindows({ create: async () => undefined })
    const windows = yield* ChromeWindows.ChromeWindows.pipe(Effect.provide(fixture.layer))
    expect(yield* windows.create({ incognito: true })).toEqual(Option.none())
    expect(yield* windows.getAll()).toEqual([])
  }))
})
