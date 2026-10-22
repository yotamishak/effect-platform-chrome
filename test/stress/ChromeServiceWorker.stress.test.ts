// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Exit, Layer, ManagedRuntime } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { listen, listenPort, listenReply, start } from "../../src/ChromeServiceWorker.js"
import type { Listener, MessageListener, Response, WorkerError } from "../../src/ChromeServiceWorker.js"

// start owns an independent ManagedRuntime, so these tests await its Promise lifecycle
// (ready, dispose) and native callbacks through explicit Promise gates, never sleeps.

/** A deterministic 32-bit generator (mulberry32), so every run churns the same way. */
const seeded = (seed: number) => {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <A>(random: () => number, values: ReadonlyArray<A>): A => {
  const value = values[Math.floor(random() * values.length)]

  if (value === undefined) throw new Error("pick from an empty list")

  return value
}

/** A mock event counting every listener added and removed. */
const event = <Listener>() => {
  const listeners = new Set<Listener>()
  let added = 0
  let removed = 0

  return {
    listeners,
    get added() { return added },
    get removed() { return removed },
    addListener: (listener: Listener) => {
      added++
      listeners.add(listener)
    },
    removeListener: (listener: Listener) => {
      if (listeners.delete(listener)) removed++
    },
    /** The only registered listener, captured so it can still be called after removal. */
    only: (): Listener => {
      const [listener, ...rest] = [...listeners]

      if (listener === undefined || rest.length > 0) throw new Error(`expected one listener, found ${listeners.size}`)

      return listener
    }
  }
}

/** A gate opened from plain callbacks and awaited from any runtime. */
const gate = () => {
  let open!: () => void
  const promise = new Promise<void>((resolve) => { open = resolve })

  return { wait: Effect.promise(() => promise), promise, open }
}

/** Counts ticks; `reach(count)` completes once that many happened, woken by the ticks themselves. */
const tally = () => {
  let ticks = 0
  const waiting: Array<{ readonly count: number; readonly resolve: () => void }> = []

  return {
    get ticks() { return ticks },
    tick: () => {
      ticks++

      for (const waiter of waiting.filter((each) => each.count <= ticks)) {
        waiting.splice(waiting.indexOf(waiter), 1)
        waiter.resolve()
      }
    },
    reach: (count: number) => Effect.promise(() => new Promise<void>((resolve) => {
      if (ticks >= count) resolve()
      else waiting.push({ count, resolve })
    }))
  }
}

const errors = () => {
  const seen: Array<WorkerError> = []

  return { seen, onError: (error: WorkerError) => { seen.push(error) }, count: (code: WorkerError["code"]) => seen.filter((error) => error.code === code).length }
}

type Sender = chrome.runtime.MessageSender

type ReplyListener = (message: string, sender: Sender, sendResponse: (response: Response) => void) => boolean

const runtimeEvents = () => ({
  onMessage: event<MessageListener>(),
  onConnect: event<(port: chrome.runtime.Port) => void>(),
  onInstalled: event<(details: chrome.runtime.InstalledDetails) => void>(),
  onStartup: event<() => void>()
})

const sender: Sender = { id: "stress" }

const overflow: WorkerError = { code: "Overflow", message: "Startup queue is full" }

const disposed: WorkerError = { code: "Disposed", message: "Service worker disposed" }

const port = (name: string) => {
  let disconnects = 0

  return {
    name,
    get disconnects() { return disconnects },
    disconnect: () => { disconnects++ }
  }
}

type MockPort = ReturnType<typeof port>

describe("ChromeServiceWorker stress", () => {
  it.effect("keeps exactly the oldest 64 of a 4,096-event startup burst, in order, then removes the listener", () => Effect.gen(function*() {
    const runtime = runtimeEvents()
    const tick = event<(value: number) => void>()
    const replies = event<ReplyListener>()
    const initialized = gate()
    const reported = errors()
    const seen: Array<number> = []
    const answered: Array<string> = []
    const handled = tally()

    const worker = start({ chrome: { runtime }, layer: Layer.empty, initialize: initialized.wait, onError: reported.onError,
      listeners: [
        listen(tick, (value) => Effect.sync(() => {
          seen.push(value)
          handled.tick()
        })),
        listenReply(replies, { handler: (message) => Effect.sync(() => {
          handled.tick()

          return message
        }) })
      ] })

    const emit = tick.only()
    const ask = replies.only()
    const responses: Array<Array<Response>> = []

    for (let index = 0; index < 4096; index++) emit(index)

    for (let index = 0; index < 4096; index++) {
      const calls: Array<Response> = []
      responses.push(calls)
      expect(ask(`m${index}`, sender, (response) => { calls.push(response) })).toBe(true)
    }

    // The worker shares one 64-slot queue: the first 64 ticks fill it, so every reply and
    // the remaining 4,032 ticks overflow at once, each answered or reported exactly once.
    expect(reported.count("Overflow")).toBe(4032)
    expect(responses.every((calls) => calls.length === 1 && calls[0]!.ok === false)).toBe(true)
    expect(responses.every((calls) => JSON.stringify(calls[0]) === JSON.stringify({ ok: false, error: overflow }))).toBe(true)

    initialized.open()
    expect(Exit.isSuccess(yield* Effect.promise(() => worker.ready))).toBe(true)

    // After initialization nothing is queued: a second burst all runs, in emission order.
    for (let index = 0; index < 64; index++) {
      ask(`late${index}`, sender, (response) => { if (response.ok) answered.push(String(response.value)) })
    }

    yield* handled.reach(128)
    expect(seen).toEqual(Array.from({ length: 64 }, (_, index) => index))
    yield* Effect.promise(() => worker.dispose())
    expect(answered).toEqual(Array.from({ length: 64 }, (_, index) => `late${index}`))
    expect(tick.listeners.size + replies.listeners.size).toBe(0)
    expect([tick.removed, replies.removed]).toEqual([1, 1])

    // The captured native listeners outlive removal; late calls are refused, never run.
    emit(-1)
    const late: Array<Response> = []
    expect(ask("after", sender, (response) => { late.push(response) })).toBe(true)
    expect(late).toEqual([{ ok: false, error: disposed }])
    expect(seen).toHaveLength(64)
    expect(handled.ticks).toBe(128)
  }))

  it.effect("runs a 4,096-event burst after initialization exactly once each, in order", () => Effect.gen(function*() {
    const runtime = runtimeEvents()
    const tick = event<(value: number) => void>()
    const seen: Array<number> = []
    const handled = tally()

    const worker = start({ chrome: { runtime }, layer: Layer.empty,
      listeners: [listen(tick, (value) => Effect.sync(() => {
        seen.push(value)
        handled.tick()
      }))] })

    yield* Effect.promise(() => worker.ready)
    const emit = tick.only()

    for (let index = 0; index < 4096; index++) emit(index)
    yield* handled.reach(4096)
    expect(seen).toEqual(Array.from({ length: 4096 }, (_, index) => index))
    yield* Effect.promise(() => worker.dispose())
    expect(tick.listeners.size).toBe(0)
  }))

  it.effect("churns 512 registrations with unregistration and disposal at every stage, ending with zero listeners", () => Effect.gen(function*() {
    const random = seeded(512)
    const runtime = runtimeEvents()
    const initialized = gate()
    const blocked = gate()
    const reported = errors()
    const stages = ["before-event", "after-queued-event", "after-ready-event", "blocked-at-dispose", "kept"] as const
    const kinds = ["listen", "reply", "port"] as const
    const started = tally()
    const finalized = tally()
    const worker = start({ chrome: { runtime }, layer: Layer.empty, initialize: initialized.wait, maxPending: 512, onError: reported.onError })

    const entries = Array.from({ length: 512 }, (_, index) => {
      const stage = pick(random, stages)
      const kind = pick(random, kinds)
      const source = event<(value: string, sender: Sender, reply: (response: Response) => void) => void>()
      const ports = event<(port: MockPort) => void>()
      const finished = { started: 0, completed: 0, finalized: 0 }

      const body = (value: string) => Effect.sync(() => {
        finished.started++
        started.tick()
      }).pipe(
        Effect.andThen(stage === "blocked-at-dispose" ? blocked.wait : Effect.void),
        Effect.andThen(Effect.sync(() => { finished.completed++ })),
        Effect.ensuring(Effect.sync(() => {
          finished.finalized++
          finalized.tick()
        })),
        Effect.as(value)
      )

      const builders: Record<typeof kind, () => Listener<never, never>> = {
        listen: () => listen(source, (value) => body(value)),
        reply: () => listenReply(source, { handler: (value) => body(value) }),
        port: () => listenPort(ports, (native) => body(native.name))
      }

      const listener = builders[kind]()

      const unregister = worker.register(listener)
      const responses: Array<Response> = []
      const opened: Array<MockPort> = []
      const native = kind === "port" ? undefined : source.only()
      const nativePort = kind === "port" ? ports.only() : undefined

      const fire = () => {
        if (nativePort !== undefined) {
          const opening = port(`port${index}`)
          opened.push(opening)
          nativePort(opening)
        } else native!(`event${index}`, sender, (response) => { responses.push(response) })
      }

      return { index, stage, kind, source, ports, finished, unregister, responses, opened, fire }
    })

    for (const entry of entries) {
      if (entry.stage === "before-event") entry.unregister()
      else if (entry.stage === "after-queued-event") {
        entry.fire()
        entry.unregister()
      }
    }

    initialized.open()
    yield* Effect.promise(() => worker.ready)

    for (const entry of entries) {
      if (entry.stage === "after-ready-event") {
        entry.fire()
        entry.unregister()
        entry.unregister()
      } else if (entry.stage === "blocked-at-dispose") entry.fire()
    }

    // Every accepted handler has started before disposal interrupts the blocked ones.
    const accepted = entries.filter((entry) => entry.stage !== "before-event" && entry.stage !== "kept")
    yield* started.reach(accepted.length)
    // Blocked handlers cannot finish before disposal, so this counts only the others.
    yield* finalized.reach(accepted.filter((entry) => entry.stage !== "blocked-at-dispose").length)
    yield* Effect.promise(() => worker.dispose())
    blocked.open()

    for (const entry of entries) {
      expect(entry.source.listeners.size + entry.ports.listeners.size).toBe(0)
      expect(entry.source.added + entry.ports.added).toBe(1)
      expect(entry.source.removed + entry.ports.removed).toBe(1)

      const fired = entry.stage !== "before-event" && entry.stage !== "kept"
      expect(entry.finished.started).toBe(fired ? 1 : 0)
      expect(entry.finished.finalized).toBe(fired ? 1 : 0)
      expect(entry.finished.completed).toBe(fired && entry.stage !== "blocked-at-dispose" ? 1 : 0)

      if (entry.kind === "reply" && fired) {
        expect(entry.responses).toEqual([entry.stage === "blocked-at-dispose"
          ? { ok: false, error: disposed }
          : { ok: true, value: `event${entry.index}` }])
      } else expect(entry.responses).toEqual([])

      // Started handlers own their ports; none was rejected here.
      expect(entry.opened.map((opened) => opened.disconnects)).toEqual(entry.opened.map(() => 0))
    }

    expect(reported.count("Overflow")).toBe(0)
  }))

  it.effect("starts and disposes 512 workers at every lifecycle stage, releasing each scoped layer once", () => Effect.gen(function*() {
    const random = seeded(4096)
    const stages = ["before-microtask", "mid-acquire", "after-ready", "active-handlers", "failed-initialization"] as const

    const workers = Array.from({ length: 512 }, (_, index) => {
      const stage = pick(random, stages)
      const runtime = runtimeEvents()
      const onAlarm = event<(alarm: chrome.alarms.Alarm) => void>()
      const acquire = gate()
      const acquiring = gate()
      const handlerGate = gate()
      const counts = { acquired: 0, released: 0, handled: 0, interrupted: 0 }
      const handled = tally()
      const answered = tally()
      const reported = errors()

      const layer = Layer.effectDiscard(Effect.acquireRelease(
        (stage === "mid-acquire" ? Effect.sync(acquiring.open).pipe(Effect.andThen(acquire.wait)) : Effect.void).pipe(Effect.andThen(Effect.sync(() => { counts.acquired++ }))),
        () => Effect.sync(() => { counts.released++ })
      ))

      const worker = start({
        chrome: { runtime, alarms: { onAlarm } }, layer, onError: reported.onError, maxPending: 4,
        initialize: stage === "failed-initialization" ? Effect.fail(`worker ${index}`) : Effect.void,
        selectMessage: () => true,
        onMessage: () => Effect.sync(() => {
          counts.handled++
          handled.tick()
        }).pipe(
          Effect.andThen(stage === "active-handlers" ? handlerGate.wait : Effect.void),
          Effect.onInterrupt(() => Effect.sync(() => { counts.interrupted++ }))
        ),
        onConnect: () => Effect.void,
        onInstalled: () => Effect.void,
        onStartup: () => Effect.void,
        onAlarm: () => Effect.void
      })

      const responses: Array<Response> = []
      const message = runtime.onMessage.only()

      const send = () => message("ping", sender, (response) => {
        responses.push(response)
        answered.tick()
      })

      // Disposed in the same synchronous turn as start, before its initialization microtask.
      const early = stage === "before-microtask" ? (send(), worker.dispose()) : undefined

      return { index, stage, early, runtime, onAlarm, acquire, acquiring, counts, handled, answered, worker, responses, send, reported }
    })

    const settle = (entry: typeof workers[number]) => Effect.gen(function*() {
      if (entry.early !== undefined) return yield* Effect.promise(() => entry.early!)

      if (entry.stage === "mid-acquire") {
        entry.send()
        yield* entry.acquiring.wait
        // The layer's acquisition is uninterruptible: disposal waits for it, then releases.
        const disposal = entry.worker.dispose()
        entry.acquire.open()

        return yield* Effect.promise(() => disposal)
      }

      yield* Effect.promise(() => entry.worker.ready)
      entry.send()
      entry.send()

      if (entry.stage === "active-handlers") yield* entry.handled.reach(2)
      else if (entry.stage === "after-ready") yield* entry.answered.reach(2)

      return yield* Effect.promise(() => entry.worker.dispose())
    })

    yield* Effect.forEach(workers, settle, { concurrency: "unbounded", discard: true })

    for (const entry of workers) {
      const total = Object.values(entry.runtime).reduce((sum, each) => sum + each.listeners.size, entry.onAlarm.listeners.size)
      expect(total).toBe(0)
      const exit = yield* Effect.promise(() => entry.worker.ready)
      expect(Exit.isSuccess(exit)).toBe(entry.stage === "after-ready" || entry.stage === "active-handlers")
      expect(entry.counts.released).toBe(entry.counts.acquired)
      expect(entry.counts.acquired).toBe(entry.stage === "before-microtask" ? 0 : 1)

      if (entry.stage === "after-ready") {
        expect(entry.responses).toEqual([{ ok: true, value: undefined }, { ok: true, value: undefined }])
      } else if (entry.stage === "failed-initialization") {
        expect(entry.responses).toEqual(Array.from({ length: 2 }, () => ({ ok: false, error: {
          code: "InitializationFailed", message: expect.stringContaining(`worker ${entry.index}`)
        } })))
      } else {
        expect(entry.responses).toEqual(Array.from({ length: entry.stage === "active-handlers" ? 2 : 1 }, () => ({
          ok: false, error: disposed
        })))
      }

      expect(entry.counts.interrupted).toBe(entry.stage === "active-handlers" ? 2 : 0)
    }
  }))

  it.effect("settles 2,048 concurrent replies with interleaved failures and throws, each exactly once", () => Effect.gen(function*() {
    const random = seeded(1024)
    const runtime = runtimeEvents()
    const external = event<ReplyListener>()
    const released = gate()
    const reported = errors()
    const outcomes = ["value", "fail", "die", "throw", "reject", "interrupt"] as const
    const plan = new Map<string, typeof outcomes[number]>()

    const handle = (message: string) => {
      const outcome = plan.get(message)

      if (outcome === "throw") throw new Error(`throw ${message}`)

      return released.wait.pipe(Effect.andThen(() => {
        if (outcome === "fail") return Effect.fail(`fail ${message}`)

        if (outcome === "die") return Effect.die(`die ${message}`)

        if (outcome === "reject") return Effect.promise(() => Promise.reject(new Error(`reject ${message}`)))

        if (outcome === "interrupt") return Effect.interrupt

        return Effect.succeed(message)
      }))
    }

    const worker = start({ chrome: { runtime }, layer: Layer.empty, onError: reported.onError,
      selectMessage: () => true,
      onMessage: (message) => handle(String(message)),
      listeners: [listenReply(external, { handler: handle })] })

    yield* Effect.promise(() => worker.ready)
    const message = runtime.onMessage.only()
    const ask = external.only()
    const calls = tally()

    const requests = Array.from({ length: 2048 }, (_, index) => {
      const id = `${index % 2 === 0 ? "message" : "external"}${index}`
      const outcome = pick(random, outcomes)
      plan.set(id, outcome)
      const brokenChannel = index % 32 === 0
      const responses: Array<Response> = []

      const respond = (response: Response) => {
        responses.push(response)
        calls.tick()

        if (brokenChannel && responses.length === 1) throw new Error(`closed ${id}`)
      }

      const claimed = index % 2 === 0 ? message(id, sender, respond) : ask(id, sender, respond)

      return { id, outcome, brokenChannel, responses, claimed }
    })

    // Each call is answered once, plus once more when its first, successful answer throws.
    const extraCalls = requests.filter((request) => request.brokenChannel && request.outcome === "value").length
    const expectedCalls = 2048 + extraCalls
    released.open()
    yield* calls.reach(expectedCalls)

    yield* Effect.promise(() => worker.dispose())

    for (const request of requests) {
      expect(request.claimed).toBe(true)
      const [first, second, ...rest] = request.responses
      expect(rest).toEqual([])

      if (request.outcome === "value") {
        expect(first).toEqual({ ok: true, value: request.id })
        expect(second).toEqual(request.brokenChannel
          ? { ok: false, error: { code: "HandlerFailed", message: `Error: closed ${request.id}` } }
          : undefined)
      } else {
        expect(second).toBeUndefined()
        expect(first).toEqual({ ok: false, error: {
          code: "HandlerFailed",
          message: request.outcome === "interrupt" ? expect.any(String) : expect.stringContaining(`${request.outcome} ${request.id}`)
        } })
      }
    }

    expect(calls.ticks).toBe(expectedCalls)
    // Each broken channel reports its one failed delivery; the fallback answer then succeeds.
    expect(reported.count("HandlerFailed")).toBe(requests.filter((request) => request.brokenChannel).length)
    expect(reported.seen).toHaveLength(reported.count("HandlerFailed"))
  }))

  it.effect("rolls back 1,024 listeners when the last one cannot be added, and when the first can", () => Effect.gen(function*() {
    for (const failAt of [0, 511, 1023]) {
      const runtime = runtimeEvents()
      const sources = Array.from({ length: 1024 }, () => event<(value: number, reply: (response: Response) => void) => void>())

      const failing = sources[failAt]!
      const add = failing.addListener
      failing.addListener = (listener) => {
        add(listener)
        throw new Error(`cannot add ${failAt}`)
      }

      const borrowed = ManagedRuntime.make(Layer.empty)

      expect(() => start({ chrome: { runtime }, runtime: borrowed, onStartup: () => Effect.void,
        listeners: sources.map((source, index) => index % 2 === 0
          ? listen(source, () => Effect.void)
          : listenReply(source, { handler: () => Effect.void }))
      })).toThrow(`cannot add ${failAt}`)

      expect(sources.reduce((sum, source) => sum + source.listeners.size, runtime.onStartup.listeners.size)).toBe(0)
      expect(sources.slice(failAt + 1).every((source) => source.added === 0)).toBe(true)
      expect(yield* Effect.promise(() => borrowed.runPromise(Effect.succeed("usable")))).toBe("usable")
      yield* Effect.promise(() => borrowed.dispose())
    }
  }))

  it.effect("disposes once under 256 reentrant disposals from answers, removals and registrations", () => Effect.gen(function*() {
    const runtime = runtimeEvents()
    const replies = event<ReplyListener>()
    const removeListener = replies.removeListener
    let reentered = 0

    const worker = start({ chrome: { runtime }, layer: Layer.empty, maxPending: 256,
      listeners: [listenReply(replies, { handler: (message) => Effect.succeed(message) })] })

    replies.removeListener = (listener) => {
      reentered++
      void worker.dispose()
      removeListener(listener)
    }

    const ask = replies.only()
    const responses: Array<Response> = []
    const disposals: Array<Promise<void>> = []

    for (let index = 0; index < 256; index++) {
      ask(`m${index}`, sender, (response) => {
        responses.push(response)
        disposals.push(worker.dispose())
      })
    }

    yield* Effect.promise(() => worker.ready)
    yield* Effect.promise(() => Promise.all(disposals))
    // The first answer disposes synchronously; the other 255 queued channels learn of it.
    expect(responses[0]).toEqual({ ok: true, value: "m0" })
    expect(responses.slice(1)).toEqual(Array.from({ length: 255 }, () => ({ ok: false, error: disposed })))
    expect(new Set(disposals).size).toBe(1)
    expect(reentered).toBe(1)
    expect(replies.listeners.size).toBe(0)
    const late = event<() => void>()
    expect(() => worker.register(late, () => Effect.void)).toThrow("disposed")
    expect(late.listeners.size).toBe(0)
  }))

  it.effect("waits for a layer release blocked mid-dispose and answers events arriving meanwhile as disposed", () => Effect.gen(function*() {
    const runtime = runtimeEvents()
    const ports = event<(native: MockPort) => void>()
    const releasing = gate()
    const releaseStarted = gate()
    let released = 0

    const worker = start({ chrome: { runtime }, selectMessage: () => true, onMessage: () => Effect.succeed("unreachable"),
      layer: Layer.effectDiscard(Effect.acquireRelease(Effect.void, () => Effect.sync(releaseStarted.open).pipe(
        Effect.andThen(releasing.wait),
        Effect.andThen(Effect.sync(() => { released++ }))
      ))),
      listeners: [listenPort(ports, () => Effect.void)] })

    yield* Effect.promise(() => worker.ready)
    const message = runtime.onMessage.only()
    const open = ports.only()
    let settled = false
    const disposal = worker.dispose().then(() => { settled = true })
    yield* releaseStarted.wait
    const responses: Array<Response> = []
    const late = Array.from({ length: 128 }, (_, index) => port(`late${index}`))

    for (const each of late) {
      message("late", sender, (response) => { responses.push(response) })
      open(each)
    }

    expect(settled).toBe(false)
    releasing.open()
    yield* Effect.promise(() => disposal)
    expect(released).toBe(1)
    expect(responses).toEqual(Array.from({ length: 128 }, () => ({ ok: false, error: disposed })))
    expect(late.every((each) => each.disconnects === 1)).toBe(true)
    expect(runtime.onMessage.listeners.size + ports.listeners.size).toBe(0)
  }))

  it.effect("disconnects every port of a 4,096-connection startup burst that overflows the queue", () => Effect.gen(function*() {
    const runtime = runtimeEvents()
    const initialized = gate()
    const reported = errors()
    const served: Array<string> = []
    const handled = tally()

    const worker = start({ chrome: { runtime }, layer: Layer.empty, initialize: initialized.wait, onError: reported.onError,
      onConnect: (native) => Effect.sync(() => {
        served.push(native.name)
        handled.tick()
      }) })

    const connect = runtime.onConnect.only()
    const opened = Array.from({ length: 4096 }, (_, index) => port(`p${index}`))

    for (const each of opened) {
      // SAFETY: the worker only calls disconnect, and the handler reads only name.
      connect(each as MockPort & chrome.runtime.Port)
    }

    expect(opened.slice(64).every((each) => each.disconnects === 1)).toBe(true)
    expect(opened.slice(0, 64).every((each) => each.disconnects === 0)).toBe(true)
    expect(reported.count("Overflow")).toBe(4032)
    initialized.open()
    yield* handled.reach(64)
    expect(served).toEqual(opened.slice(0, 64).map((each) => each.name))
    yield* Effect.promise(() => worker.dispose())
    expect(runtime.onConnect.listeners.size).toBe(0)
  }))
})
