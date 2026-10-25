// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Exit, Layer, ManagedRuntime } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import type { Mock } from "vitest"
import { listen, listenPort, listenReply, start } from "../src/ChromeServiceWorker.js"
import type { ChromeEvent, FilteredChromeEvent, MessageListener, Response } from "../src/ChromeServiceWorker.js"

const event = <Listener>(): ChromeEvent<Listener> & { listeners: Set<Listener> } => {
  const listeners = new Set<Listener>()

  return {
    listeners,
    addListener: (listener) => { listeners.add(listener) },
    removeListener: (listener) => { listeners.delete(listener) }
  }
}

const setup = () => {
  const onMessage = event<MessageListener>()
  const onStartup = event<() => void>()
  const onInstalled = event<(details: chrome.runtime.InstalledDetails) => void>()
  const onConnect = event<(port: chrome.runtime.Port) => void>()
  const onAlarm = event<(alarm: chrome.alarms.Alarm) => void>()
  // SAFETY: handlers in this suite only read tab.id; no other native Tab fields are consumed.
  const sender: chrome.runtime.MessageSender = { id: "sender", tab: { id: 42 } as chrome.tabs.Tab }

  const send = (message: unknown, response = vi.fn<(value: Response) => void>()) => {
    const listener = [...onMessage.listeners][0]!

    return { claimed: listener(message, sender, response), response }
  }

  return { chrome: { runtime: { onMessage, onStartup, onInstalled, onConnect }, alarms: { onAlarm } }, sender, send }
}

interface UrlFilter { readonly url: ReadonlyArray<{ readonly hostEquals: string }> }

/** Like Chrome's webNavigation events, the filter is optional; every addListener call is recorded. */
interface RecordedEvent<Listener> {
  addListener(listener: Listener, filter?: UrlFilter): void
  removeListener(listener: Listener): void
  readonly listeners: Set<Listener>
  readonly calls: Array<ReadonlyArray<Listener | UrlFilter | undefined>>
}

const filteredEvent = <Listener>(): RecordedEvent<Listener> => {
  const calls: Array<ReadonlyArray<Listener | UrlFilter | undefined>> = []
  const listeners = new Set<Listener>()

  return {
    listeners,
    calls,
    addListener: (...args) => {
      calls.push(args)
      listeners.add(args[0])
    },
    removeListener: (listener) => { listeners.delete(listener) }
  }
}

interface RequestFilter { readonly urls: ReadonlyArray<string> }

/** Like Chrome's webRequest events, addListener takes extra arguments; every call is recorded in full. */
const recordingEvent = <Listener, Options extends ReadonlyArray<unknown>>() => {
  const calls: Array<ReadonlyArray<Listener | Options[number]>> = []
  const listeners = new Set<Listener>()

  return {
    listeners,
    calls,
    addListener: (listener: Listener, ...options: Options) => {
      calls.push([listener, ...options])
      listeners.add(listener)
    },
    removeListener: (listener: Listener) => { listeners.delete(listener) }
  }
}

const gate = () => {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })

  return { effect: Effect.promise(() => promise), release }
}

const defaults = {
  selectMessage: (message: unknown) => message === "ours",
  onMessage: () => Effect.succeed("answer")
}

describe("ChromeServiceWorker", () => {
  // start owns an independent ManagedRuntime. Most tests deliberately exercise its
  // synchronous Chrome callbacks and Promise lifecycle with ordinary async tests.
  it("imports safely without chrome globals", async () => {
    expect(globalThis.chrome).toBeUndefined()
    expect((await import("../src/ChromeServiceWorker.js")).start).toBeTypeOf("function")
  })

  it("registers all listeners synchronously before even synchronous layer work", async () => {
    const api = setup()
    const hydrated = gate()
    const handled = vi.fn()

    const layer = Layer.effectDiscard(Effect.gen(function*() {
      expect(api.chrome.runtime.onMessage.listeners.size).toBe(1)
      expect(api.chrome.runtime.onConnect.listeners.size).toBe(1)
      expect(api.chrome.runtime.onInstalled.listeners.size).toBe(1)
      expect(api.chrome.runtime.onStartup.listeners.size).toBe(1)
      expect(api.chrome.alarms.onAlarm.listeners.size).toBe(1)
      yield* hydrated.effect
    }))

    const worker = start({
      ...defaults, ...api, layer,
      onMessage: (message, sender) => Effect.sync(() => {
        handled(message, sender)

        return "answer"
      }),
      onConnect: () => Effect.void,
      onInstalled: () => Effect.void,
      onStartup: () => Effect.sync(() => handled("startup")),
      onAlarm: () => Effect.void
    })

    expect(api.chrome.runtime.onMessage.listeners.size).toBe(1)
    const { claimed, response } = api.send("ours")

    for (const listener of api.chrome.runtime.onStartup.listeners) listener()
    expect(claimed).toBe(true)
    await Promise.resolve()
    expect(handled).not.toHaveBeenCalled()
    expect(response).not.toHaveBeenCalled()
    hydrated.release()
    expect(Exit.isSuccess(await worker.ready)).toBe(true)
    await vi.waitFor(() => expect(response).toHaveBeenCalledWith({ ok: true, value: "answer" }))
    expect(handled).toHaveBeenCalledWith("ours", api.sender)
    expect(handled).toHaveBeenCalledWith("startup")
    await worker.dispose()
  })

  it("also gates on an explicit initialization effect and declines unrelated messages", async () => {
    const api = setup()
    const initialized = gate()
    const worker = start({ ...defaults, ...api, layer: Layer.empty, initialize: initialized.effect })
    const unrelated = api.send({ anotherProtocol: true })
    expect(unrelated.claimed).toBe(false)
    expect(unrelated.response).not.toHaveBeenCalled()
    const matched = api.send("ours")
    expect(matched.claimed).toBe(true)
    await Promise.resolve()
    expect(matched.response).not.toHaveBeenCalled()
    initialized.release()
    await worker.ready
    await vi.waitFor(() => expect(matched.response).toHaveBeenCalledTimes(1))
    await worker.dispose()
  })

  it.each(["layer", "initialize"] as const)("routes %s initialization failure to queued and subsequent messages", async (source) => {
    const api = setup()
    const onError = vi.fn()
    const onMessage = vi.fn(() => Effect.succeed("unreachable"))
    const failure = Effect.fail("hydration failed")

    const worker = start({
      ...defaults, ...api, onError, onMessage,
      layer: source === "layer" ? Layer.effectDiscard(failure) : Layer.empty,
      initialize: source === "initialize" ? failure : Effect.void
    })

    const queued = api.send("ours")
    expect(Exit.isFailure(await worker.ready)).toBe(true)
    const later = api.send("ours")

    for (const response of [queued.response, later.response]) {
      expect(response).toHaveBeenCalledWith({ ok: false, error: {
        code: "InitializationFailed", message: expect.stringContaining("hydration failed")
      } })
    }

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onMessage).not.toHaveBeenCalled()
    await worker.dispose()
  })

  it("reports bounded startup overflow without dropping matched response channels", async () => {
    const api = setup()
    const initialized = gate()
    const onError = vi.fn()

    const worker = start({ ...defaults, ...api, layer: Layer.empty, initialize: initialized.effect,
      maxPending: 1, onError, onStartup: () => Effect.void })

    const accepted = api.send("ours")
    const overflow = api.send("ours")
    expect(overflow.claimed).toBe(true)
    expect(overflow.response).toHaveBeenCalledWith({ ok: false, error: {
      code: "Overflow", message: "Startup queue is full"
    } })

    for (const listener of api.chrome.runtime.onStartup.listeners) listener()
    expect(onError).toHaveBeenCalledWith({ code: "Overflow", message: "Startup queue is full" })
    initialized.release()
    await worker.ready
    await vi.waitFor(() => expect(accepted.response).toHaveBeenCalledWith({ ok: true, value: "answer" }))
    await worker.dispose()
  })

  it("routes effect failures and thrown handler construction to response envelopes", async () => {
    for (const handler of [() => Effect.fail("bad request"), () => { throw new Error("bad request") }]) {
      const api = setup()
      const worker = start({ ...defaults, ...api, layer: Layer.empty, onMessage: handler })
      await worker.ready
      const result = api.send("ours")
      await vi.waitFor(() => expect(result.response).toHaveBeenCalledWith({ ok: false, error: {
        code: "HandlerFailed", message: expect.stringContaining("bad request")
      } }))
      await worker.dispose()
    }
  })

  it("supervises selector, response callback, and event failures", async () => {
    const api = setup()
    const onError = vi.fn()

    const worker = start({ ...defaults, ...api, layer: Layer.empty, onError,
      selectMessage: (message) => {
        if (message === "throw") throw new Error("selector")

        return true
      },
      onStartup: () => Effect.fail("event") })

    expect(api.send("throw").claimed).toBe(false)
    await worker.ready
    const closed = api.send("ours", vi.fn(() => { throw new Error("closed channel") }))

    for (const listener of api.chrome.runtime.onStartup.listeners) listener()
    // The selector, both delivery attempts on the closed channel, and the event.
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(4))
    expect(closed.response.mock.calls).toEqual([
      [{ ok: true, value: "answer" }],
      [{ ok: false, error: { code: "HandlerFailed", message: "Error: closed channel" } }]
    ])
    await worker.dispose()
  })

  it("answers a value Chrome cannot deliver with a HandlerFailed envelope, exactly once", async () => {
    const api = setup()
    const onError = vi.fn()
    const worker = start({ ...defaults, ...api, layer: Layer.empty, onError, onMessage: () => Effect.succeed(1n) })
    await worker.ready
    let calls = 0

    const response = vi.fn((value: Response) => {
      calls++

      if (calls === 1) throw new TypeError(`Could not serialize ${JSON.stringify(value.ok)}`)
    })

    api.send("ours", response)
    await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(2))
    expect(response).toHaveBeenLastCalledWith({ ok: false, error: {
      code: "HandlerFailed", message: "TypeError: Could not serialize true"
    } })
    expect(onError).toHaveBeenCalledExactlyOnceWith({ code: "HandlerFailed", message: "TypeError: Could not serialize true" })
    await worker.dispose()
    expect(response).toHaveBeenCalledTimes(2)
  })

  it("refuses a worker without exactly one of layer and runtime before registering anything", async () => {
    const api = setup()
    const runtime = ManagedRuntime.make(Layer.empty)
    // SAFETY: deliberately bypasses the layer/runtime union, as an untyped JavaScript caller would.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions
    const neither = { ...defaults, ...api } as unknown as Parameters<typeof start>[0]
    // SAFETY: as above, giving both.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions
    const both = { ...defaults, ...api, layer: Layer.empty, runtime } as unknown as Parameters<typeof start>[0]
    expect(() => start(neither)).toThrow(new TypeError("Exactly one of layer or runtime must be given"))
    expect(() => start(both)).toThrow(new TypeError("Exactly one of layer or runtime must be given"))
    expect(api.chrome.runtime.onMessage.listeners.size).toBe(0)
    expect(await runtime.runPromise(Effect.succeed(42))).toBe(42)
    await runtime.dispose()
  })

  it("disposes before initialization, drains pending responses, and removes generic listeners", async () => {
    const api = setup()
    const initialize = vi.fn()
    const worker = start({ ...defaults, ...api, layer: Layer.empty, initialize: Effect.sync(initialize) })
    const extra = event<(value: number) => void>()
    const unregister = worker.register(extra, () => Effect.void)
    expect(extra.listeners.size).toBe(1)
    unregister()
    unregister()
    expect(extra.listeners.size).toBe(0)
    worker.register(extra, () => Effect.void)
    const queued = api.send("ours")
    const disposal = worker.dispose()
    expect(worker.dispose()).toBe(disposal)
    await disposal
    expect(Exit.isFailure(await worker.ready)).toBe(true)
    expect(initialize).not.toHaveBeenCalled()
    expect(queued.response).toHaveBeenCalledWith({ ok: false, error: {
      code: "Disposed", message: "Service worker disposed"
    } })
    expect(api.chrome.runtime.onMessage.listeners.size).toBe(0)
    expect(extra.listeners.size).toBe(0)
  })

  it("interrupts active handlers, finalizes owned layers, and preserves borrowed runtimes", async () => {
    const api = setup()
    const finalized = vi.fn()
    const interrupted = vi.fn()

    const worker = start({ ...defaults, ...api,
      layer: Layer.effectDiscard(Effect.acquireRelease(Effect.void, () => Effect.sync(finalized))),
      onMessage: () => Effect.never.pipe(Effect.ensuring(Effect.sync(interrupted))) })

    await worker.ready
    const result = api.send("ours")
    await worker.dispose()
    expect(interrupted).toHaveBeenCalledTimes(1)
    expect(finalized).toHaveBeenCalledTimes(1)
    expect(result.response).toHaveBeenCalledWith({ ok: false, error: {
      code: "Disposed", message: "Service worker disposed"
    } })
    const runtime = ManagedRuntime.make(Layer.empty)
    const dispose = vi.spyOn(runtime, "dispose")
    const borrowed = start({ ...defaults, ...setup(), runtime })
    await borrowed.ready
    await borrowed.dispose()
    expect(dispose).not.toHaveBeenCalled()
    expect(await runtime.runPromise(Effect.succeed(42))).toBe(42)
    await runtime.dispose()
  })

  it("interrupts initialization without launching queued handlers", async () => {
    const api = setup()
    const onMessage = vi.fn(() => Effect.void)
    const worker = start({ ...defaults, ...api, layer: Layer.empty, initialize: Effect.never, onMessage })
    const result = api.send("ours")
    await Promise.resolve()
    await worker.dispose()
    expect(Exit.isFailure(await worker.ready)).toBe(true)
    expect(onMessage).not.toHaveBeenCalled()
    expect(result.response).toHaveBeenCalledTimes(1)
  })

  it.each([0, 1, 256])("enforces the exact startup capacity %i across a 1024-message burst", async (maxPending) => {
    const api = setup()
    const initialized = gate()
    const handled = vi.fn(() => Effect.succeed("answer"))

    const worker = start({ ...defaults, ...api, layer: Layer.empty, initialize: initialized.effect,
      maxPending, onMessage: handled })

    const messages = Array.from({ length: 1024 }, () => api.send("ours"))

    for (const [index, message] of messages.entries()) {
      expect(message.claimed).toBe(true)

      if (index < maxPending) expect(message.response).not.toHaveBeenCalled()
      else expect(message.response).toHaveBeenCalledWith({ ok: false, error: {
        code: "Overflow", message: "Startup queue is full"
      } })
    }

    initialized.release()
    await worker.ready
    await worker.dispose()
    expect(handled).toHaveBeenCalledTimes(maxPending)

    for (const [index, message] of messages.entries()) {
      expect(message.response).toHaveBeenCalledTimes(1)

      if (index < maxPending) expect(message.response).toHaveBeenCalledWith({ ok: true, value: "answer" })
    }
  })

  it("fails hundreds of queued channels once when initialization defects", async () => {
    const api = setup()
    const initialized = gate()
    const onError = vi.fn()
    const onMessage = vi.fn(() => Effect.void)

    const worker = start({ ...defaults, ...api, layer: Layer.empty, maxPending: 512, onError, onMessage,
      initialize: initialized.effect.pipe(Effect.andThen(Effect.die("initialization defect"))) })

    const messages = Array.from({ length: 512 }, () => api.send("ours"))
    initialized.release()
    expect(Exit.isFailure(await worker.ready)).toBe(true)
    messages.push(api.send("ours"))

    for (const message of messages) {
      expect(message.response).toHaveBeenCalledTimes(1)
      expect(message.response).toHaveBeenCalledWith({ ok: false, error: {
        code: "InitializationFailed", message: expect.stringContaining("initialization defect")
      } })
    }

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onMessage).not.toHaveBeenCalled()
    await worker.dispose()
  })

  it("settles concurrent success, defects, and rejected promises once without cross-talk", async () => {
    const api = setup()
    const released = gate()

    const worker = start({ ...api, layer: Layer.empty, selectMessage: () => true,
      onMessage: (message) => released.effect.pipe(Effect.andThen(() => {
        if (message === "defect") return Effect.die("handler defect")

        if (message === "rejection") return Effect.promise(() => Promise.reject(new Error("handler rejection")))

        return Effect.succeed(message)
      })) })

    await worker.ready

    const inputs = Array.from({ length: 300 }, (_, index) => {
      if (index % 3 === 0) return "defect"

      if (index % 3 === 1) return "rejection"

      return index
    })

    const messages = inputs.map((input) => api.send(input))
    released.release()
    await vi.waitFor(() => {
      for (const message of messages) expect(message.response).toHaveBeenCalledTimes(1)
    })
    await worker.dispose()

    for (const [index, message] of messages.entries()) {
      expect(message.response).toHaveBeenCalledTimes(1)
      const input = inputs[index]

      if (input === "defect" || input === "rejection") {
        expect(message.response).toHaveBeenCalledWith({ ok: false, error: {
          code: "HandlerFailed", message: expect.stringContaining(`handler ${input}`)
        } })
      } else expect(message.response).toHaveBeenCalledWith({ ok: true, value: input })
    }
  })

  it("interrupts 300 active handlers and leaves a borrowed runtime operational", async () => {
    const api = setup()
    const runtime = ManagedRuntime.make(Layer.empty)
    const started = vi.fn()
    const finalized = vi.fn()

    const worker = start({ ...defaults, ...api, runtime,
      onMessage: () => Effect.sync(started).pipe(Effect.andThen(Effect.never),
        Effect.ensuring(Effect.sync(finalized))) })

    await worker.ready
    const messages = Array.from({ length: 300 }, () => api.send("ours"))
    expect(started).toHaveBeenCalledTimes(300)
    await worker.dispose()
    expect(finalized).toHaveBeenCalledTimes(300)

    for (const message of messages) {
      expect(message.response).toHaveBeenCalledTimes(1)
      expect(message.response).toHaveBeenCalledWith({ ok: false, error: {
        code: "Disposed", message: "Service worker disposed"
      } })
    }

    expect(await runtime.runPromise(Effect.succeed("still usable"))).toBe("still usable")
    await runtime.dispose()
  })

  it("handles disposal reentered by response and removal callbacks, and rejects late messages", async () => {
    const api = setup()
    const worker = start({ ...defaults, ...api, layer: Layer.empty })
    const listener = [...api.chrome.runtime.onMessage.listeners][0]!

    const removals = vi.spyOn(api.chrome.runtime.onMessage, "removeListener").mockImplementation((removed) => {
      void worker.dispose()
      api.chrome.runtime.onMessage.listeners.delete(removed)
    })

    const response = vi.fn(() => { void worker.dispose() })
    api.send("ours", response)
    api.send("ours", response)
    await worker.ready
    await worker.dispose()
    expect(response).toHaveBeenCalledTimes(2)
    expect(response).toHaveBeenNthCalledWith(1, { ok: true, value: "answer" })
    expect(response).toHaveBeenNthCalledWith(2, { ok: false, error: {
      code: "Disposed", message: "Service worker disposed"
    } })
    expect(removals).toHaveBeenCalledTimes(1)
    const late = vi.fn()
    expect(listener("ours", api.sender, late)).toBe(true)
    expect(late).toHaveBeenCalledTimes(1)
    expect(late).toHaveBeenCalledWith({ ok: false, error: {
      code: "Disposed", message: "Service worker disposed"
    } })
  })

  it("unregisters generic events idempotently while preserving already accepted work", async () => {
    const api = setup()
    const initialized = gate()
    const worker = start({ ...defaults, ...api, layer: Layer.empty, initialize: initialized.effect })
    const extra = event<(value: number) => void>()
    const handled = vi.fn()
    const remove = vi.spyOn(extra, "removeListener")
    const unregister = worker.register(extra, (value) => Effect.sync(() => handled(value)))
    const captured = [...extra.listeners][0]!
    captured(1)
    unregister()
    unregister()
    captured(2)
    initialized.release()
    await worker.ready
    expect(handled.mock.calls).toEqual([[1]])
    await worker.dispose()
    captured(3)
    expect(handled.mock.calls).toEqual([[1]])
    expect(remove).toHaveBeenCalledTimes(1)
    expect(() => worker.register(extra, () => Effect.void)).toThrow("disposed")
  })

  it.each(["onConnect", "onInstalled", "onStartup", "onAlarm"] as const)(
    "rejects a configured but unavailable %s and cleans up prior listeners", async (name) => {
      const onMessage = event<MessageListener>()
      const runtime = ManagedRuntime.make(Layer.empty)
      expect(() => start({ ...defaults, chrome: { runtime: { onMessage } }, runtime,
        [name]: () => Effect.void })).toThrow(`Configured ${name} event is unavailable`)
      expect(onMessage.listeners.size).toBe(0)
      expect(await runtime.runPromise(Effect.succeed(42))).toBe(42)
      await runtime.dispose()
    }
  )

  it("cleans up partial registration failures even when a previous removal throws", async () => {
    const api = setup()
    const runtime = ManagedRuntime.make(Layer.empty)

    const firstRemove = vi.spyOn(api.chrome.runtime.onMessage, "removeListener").mockImplementation((listener) => {
      api.chrome.runtime.onMessage.listeners.delete(listener)
      throw new Error("removal failure")
    })

    const failedRemove = vi.spyOn(api.chrome.runtime.onStartup, "removeListener")
    vi.spyOn(api.chrome.runtime.onStartup, "addListener").mockImplementation((listener) => {
      api.chrome.runtime.onStartup.listeners.add(listener)
      throw new Error("registration failure")
    })
    expect(() => start({ ...defaults, ...api, runtime, onStartup: () => Effect.void })).toThrow("registration failure")
    expect(firstRemove).toHaveBeenCalledTimes(1)
    expect(failedRemove).toHaveBeenCalledTimes(1)
    expect(api.chrome.runtime.onMessage.listeners.size).toBe(0)
    expect(api.chrome.runtime.onStartup.listeners.size).toBe(0)
    expect(await runtime.runPromise(Effect.succeed(42))).toBe(42)
    await runtime.dispose()
  })

  it("does not leak a listener when its registration synchronously disposes the worker", async () => {
    const api = setup()
    const worker = start({ ...defaults, ...api, layer: Layer.empty })
    await worker.ready
    const extra = event<() => void>()
    vi.spyOn(extra, "addListener").mockImplementation((listener) => {
      extra.listeners.add(listener)
      void worker.dispose()
    })
    expect(() => worker.register(extra, () => Effect.void)).toThrow("disposed")
    await worker.dispose()
    expect(extra.listeners.size).toBe(0)
  })

  it("settles channels accepted by a reentrant registration before a later registration fails", async () => {
    const api = setup()
    const runtime = ManagedRuntime.make(Layer.empty)
    const response = vi.fn()

    vi.spyOn(api.chrome.runtime.onMessage, "addListener").mockImplementation((listener) => {
      api.chrome.runtime.onMessage.listeners.add(listener)
      expect(listener("ours", api.sender, response)).toBe(true)
    })
    vi.spyOn(api.chrome.runtime.onStartup, "addListener").mockImplementation(() => {
      throw new Error("registration failure")
    })
    expect(() => start({ ...defaults, ...api, runtime, onStartup: () => Effect.void })).toThrow("registration failure")
    expect(response).toHaveBeenCalledTimes(1)
    expect(response).toHaveBeenCalledWith({ ok: false, error: {
      code: "Disposed", message: "Service worker disposed"
    } })
    await runtime.dispose()
  })

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid capacity %s before registering any listeners", (maxPending) => {
      const api = setup()
      expect(() => start({ ...defaults, ...api, layer: Layer.empty, maxPending })).toThrow(RangeError)
      expect(api.chrome.runtime.onMessage.listeners.size).toBe(0)
    }
  )

  it("shares startup capacity between generic events and message response channels", async () => {
    const api = setup()
    const initialized = gate()
    const handled = vi.fn()
    const onError = vi.fn()

    const worker = start({ ...defaults, ...api, layer: Layer.empty, initialize: initialized.effect,
      maxPending: 1, onError })

    const extra = event<(value: number) => void>()
    worker.register(extra, (value) => Effect.sync(() => handled(value)))
    const captured = [...extra.listeners][0]!
    captured(42)
    const message = api.send("ours")
    captured(43)
    expect(message.response).toHaveBeenCalledWith({ ok: false, error: {
      code: "Overflow", message: "Startup queue is full"
    } })
    expect(onError).toHaveBeenCalledWith({ code: "Overflow", message: "Startup queue is full" })
    initialized.release()
    await worker.ready
    expect(handled.mock.calls).toEqual([[42]])
    await worker.dispose()
    expect(message.response).toHaveBeenCalledTimes(1)
  })

  it("contains throwing selector observers and does not consume startup capacity", async () => {
    const api = setup()

    const worker = start({ ...defaults, ...api, layer: Layer.empty, maxPending: 1,
      selectMessage: (message) => {
        if (message === "throw") throw new Error("selector failure")

        return message === "ours"
      },
      onError: () => { throw new Error("observer failure") } })

    const declined = Array.from({ length: 300 }, () => api.send("throw"))
    const accepted = api.send("ours")
    await worker.ready
    await worker.dispose()

    for (const message of declined) {
      expect(message.claimed).toBe(false)
      expect(message.response).not.toHaveBeenCalled()
    }

    expect(accepted.response).toHaveBeenCalledTimes(1)
    expect(accepted.response).toHaveBeenCalledWith({ ok: true, value: "answer" })
  })

  it.effect.each(["before microtask", "during initialization"] as const)(
    "drains 256 channels exactly once when disposed %s", (phase) => Effect.gen(function*() {
      const api = setup()
      const entered = gate()
      const started = vi.fn(() => entered.release())
      const onMessage = vi.fn(() => Effect.void)

      const worker = yield* Effect.acquireRelease(
        Effect.sync(() => start({ ...defaults, ...api, layer: Layer.empty, maxPending: 256, onMessage,
          initialize: Effect.sync(started).pipe(Effect.andThen(Effect.never)) })),
        (worker) => Effect.promise(() => worker.dispose())
      )

      const messages = Array.from({ length: 256 }, () => api.send("ours"))

      // Acquisition is synchronous: the first phase still disposes before start's
      // initialization microtask. The test scope also disposes on assertion failure.
      if (phase === "during initialization") yield* entered.effect
      yield* Effect.promise(() => worker.dispose())
      expect(Exit.isFailure(yield* Effect.promise(() => worker.ready))).toBe(true)

      expect(started).toHaveBeenCalledTimes(phase === "before microtask" ? 0 : 1)
      expect(onMessage).not.toHaveBeenCalled()

      for (const message of messages) {
        expect(message.response).toHaveBeenCalledTimes(1)
        expect(message.response).toHaveBeenCalledWith({ ok: false, error: {
          code: "Disposed", message: "Service worker disposed"
        } })
      }
    })
  )

  it("continues disposal after native removal errors and supervises late generic events", async () => {
    const api = setup()
    const onError = vi.fn()
    const finalized = vi.fn()

    const worker = start({ ...defaults, ...api, onError,
      layer: Layer.effectDiscard(Effect.acquireRelease(Effect.void, () => Effect.sync(finalized))),
      onStartup: () => Effect.void })

    await worker.ready
    const captured = [...api.chrome.runtime.onStartup.listeners][0]!
    vi.spyOn(api.chrome.runtime.onMessage, "removeListener").mockImplementation(() => {
      throw new Error("native removal failed")
    })
    await worker.dispose()
    expect(api.chrome.runtime.onStartup.listeners.size).toBe(0)
    expect(finalized).toHaveBeenCalledTimes(1)
    captured()
    expect(onError).toHaveBeenCalledWith({ code: "HandlerFailed", message: expect.stringContaining("native removal failed") })
    expect(onError).toHaveBeenCalledWith({ code: "Disposed", message: "Service worker disposed" })
  })

  it("installs no message listener when the worker answers only ports", async () => {
    const api = setup()
    const worker = start({ chrome: api.chrome, layer: Layer.empty, onConnect: () => Effect.void })
    expect(api.chrome.runtime.onMessage.listeners.size).toBe(0)
    expect(api.chrome.runtime.onConnect.listeners.size).toBe(1)
    await worker.dispose()
  })

  it("refuses a message selector without a handler", () => {
    const api = setup()
    expect(() => start({ chrome: api.chrome, layer: Layer.empty, selectMessage: () => true })).toThrow(
      "selectMessage and onMessage must be configured together"
    )
    expect(api.chrome.runtime.onMessage.listeners.size).toBe(0)
  })

  describe("listeners", () => {
    it("installs listen() entries with the named ones, before initialization, passing filters only when given", async () => {
      const api = setup()
      const clicked = event<(tab: chrome.tabs.Tab) => void>()
      const committed = filteredEvent<(details: { readonly url: string }) => void>()
      const unfiltered = filteredEvent<(details: { readonly url: string }) => void>()
      const hydrated = gate()
      const seen: Array<string> = []
      const filter: UrlFilter = { url: [{ hostEquals: "example.com" }] }

      const layer = Layer.effectDiscard(Effect.gen(function*() {
        expect(clicked.listeners.size).toBe(1)
        expect(committed.listeners.size).toBe(1)
        yield* hydrated.effect
      }))

      const worker = start({
        ...api, layer,
        listeners: [
          listen(clicked, (tab) => Effect.sync(() => { seen.push(`clicked ${tab.id}`) })),
          listen(committed, (details) => Effect.sync(() => { seen.push(`committed ${details.url}`) }), filter),
          listen(unfiltered, () => Effect.void)
        ]
      })

      expect(committed.calls).toEqual([[expect.any(Function), filter]])
      expect(unfiltered.calls).toEqual([[expect.any(Function)]])

      // SAFETY: the handler only reads tab.id.
      const tab = { id: 7 } as chrome.tabs.Tab

      for (const listener of clicked.listeners) listener(tab)

      for (const listener of committed.listeners) listener({ url: "https://example.com/" })

      expect(seen).toEqual([])

      hydrated.release()
      await worker.ready
      await vi.waitFor(() => expect(seen).toEqual(["clicked 7", "committed https://example.com/"]))
      await worker.dispose()
      expect(clicked.listeners.size + committed.listeners.size + unfiltered.listeners.size).toBe(0)
    })

    it("accepts Chrome's own filtered events, with and without a filter", () => {
      const listeners = (onCommitted: typeof chrome.webNavigation.onCommitted) => [
        listen(onCommitted, (details) => Effect.sync(() => details.url)),
        listen(onCommitted, (details) => Effect.sync(() => details.url), { url: [{ hostEquals: "example.com" }] })
      ]

      const required: FilteredChromeEvent<(url: string) => void, UrlFilter> = { addListener: () => {}, removeListener: () => {} }

      expect(listeners).toBeTypeOf("function")
      expect(listen(required, () => Effect.void, { url: [] })).toHaveProperty("attach")
    })

    it("rolls back every listener when one cannot be added", () => {
      const api = setup()
      const first = event<() => void>()

      const failing: ChromeEvent<() => void> = {
        addListener: () => { throw new Error("no such event") },
        removeListener: () => {}
      }

      expect(() => start({
        ...api, layer: Layer.empty,
        onStartup: () => Effect.void,
        listeners: [listen(first, () => Effect.void), listen(failing, () => Effect.void)]
      })).toThrow("no such event")

      expect(first.listeners.size).toBe(0)
      expect(api.chrome.runtime.onStartup.listeners.size).toBe(0)
    })

    it("registers a filtered event after start and reports handler failures", async () => {
      const api = setup()
      const onError = vi.fn()
      const worker = start({ ...api, layer: Layer.empty, onError })
      const committed = filteredEvent<(url: string) => void>()
      const filter: UrlFilter = { url: [{ hostEquals: "example.com" }] }
      const unregister = worker.register(committed, (url) => Effect.fail(`failed ${url}`), filter)

      expect(committed.calls).toEqual([[expect.any(Function), filter]])

      await worker.ready

      for (const listener of committed.listeners) listener("https://example.com/")
      await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "HandlerFailed" })))

      unregister()
      expect(committed.listeners.size).toBe(0)
      await worker.dispose()
    })

    it("passes every extra addListener argument exactly as given, at start and through register", async () => {
      const api = setup()
      const onCompleted = recordingEvent<(details: { readonly url: string }) => void, [RequestFilter, ReadonlyArray<string>?]>()
      const filter: RequestFilter = { urls: ["https://example.com/*"] }
      const worker = start({ ...api, layer: Layer.empty, listeners: [listen(onCompleted, () => Effect.void, filter, ["responseHeaders"])] })
      worker.register(onCompleted, () => Effect.void, filter)
      worker.register(onCompleted, () => Effect.void, filter, ["extraHeaders"])
      expect(onCompleted.calls).toEqual([
        [expect.any(Function), filter, ["responseHeaders"]],
        [expect.any(Function), filter],
        [expect.any(Function), filter, ["extraHeaders"]]
      ])
      await worker.dispose()
      expect(onCompleted.listeners.size).toBe(0)
    })

    it("types Chrome's own events: required filters, extraInfoSpec, reply callbacks and ports", () => {
      const listeners = (chromeApi: typeof chrome) => [
        listen(chromeApi.webRequest.onCompleted, (details) => Effect.sync(() => details.statusCode),
          { urls: ["<all_urls>"] }, ["responseHeaders"]),
        // @ts-expect-error webRequest events require a RequestFilter.
        listen(chromeApi.webRequest.onCompleted, () => Effect.void),
        // @ts-expect-error runtime.onStartup takes no filter.
        listen(chromeApi.runtime.onStartup, () => Effect.void, { url: [] }),
        listenReply(chromeApi.runtime.onMessageExternal, {
          select: (_message, sender) => sender.id === "trusted",
          handler: (message, sender) => Effect.succeed({ message, from: sender.id })
        }),
        listenReply(chromeApi.runtime.onUserScriptMessage, { handler: (message: unknown) => Effect.succeed(message) }),
        listenReply(chromeApi.downloads.onDeterminingFilename, {
          handler: (item) => Effect.succeed(`renamed/${item.filename}`),
          reply: (response) => response.ok ? { filename: response.value, conflictAction: "uniquify" as const } : undefined
        }),
        listenReply(chromeApi.webRequest.onAuthRequired, {
          handler: (details) => Effect.succeed(details.isProxy),
          reply: (response): chrome.webRequest.BlockingResponse => response.ok && response.value ? { cancel: true } : {}
        }, { urls: ["<all_urls>"] }, ["asyncBlocking"]),
        // @ts-expect-error suggest takes a FilenameSuggestion, not the envelope.
        listenReply(chromeApi.downloads.onDeterminingFilename, { handler: (item) => Effect.succeed(item.filename) }),
        // @ts-expect-error a handler cannot declare more arguments than the event gives.
        listenReply(chromeApi.runtime.onMessageExternal, { handler: (_message: unknown, _sender: chrome.runtime.MessageSender, extra: number) => Effect.succeed(extra) }),
        listenPort(chromeApi.runtime.onConnectExternal, (port) => Effect.sync(() => port.name)),
        listenPort(chromeApi.runtime.onUserScriptConnect, (port) => Effect.sync(() => port.sender))
      ]

      expect(listeners).toBeTypeOf("function")
    })
  })

  describe("listenReply", () => {
    type Sender = chrome.runtime.MessageSender

    const external = () => event<(message: unknown, sender: Sender, sendResponse: (response?: Response) => void) => boolean>()

    type ExternalListener = (message: unknown, sender: Sender, sendResponse: (response?: Response) => void) => boolean

    const deliverTo = (listener: ExternalListener, message: unknown, sendResponse = vi.fn<(response?: Response) => void>()) =>
      ({ claimed: listener(message, { id: "other" }, sendResponse), sendResponse })

    const deliver = (target: ReturnType<typeof external>, message: unknown, sendResponse?: Mock<(response?: Response) => void>) =>
      deliverTo([...target.listeners][0]!, message, sendResponse)

    it("claims selected events, answers each once after initialization, and declines the rest", async () => {
      const onMessageExternal = external()
      const initialized = gate()
      const onError = vi.fn()
      const handled = vi.fn()

      const worker = start({ ...setup(), layer: Layer.empty, initialize: initialized.effect, onError, listeners: [
        listenReply(onMessageExternal, {
          select: (message, sender) => {
            if (message === "throw") throw new Error("selector failure")

            return sender.id === "other" && message !== "ignored"
          },
          handler: (message, sender) => Effect.sync(() => {
            handled(message)

            return `${String(message)} from ${sender.id}`
          })
        })
      ] })

      const accepted = deliver(onMessageExternal, "hello")
      const ignored = deliver(onMessageExternal, "ignored")
      const thrown = deliver(onMessageExternal, "throw")
      expect([accepted.claimed, ignored.claimed, thrown.claimed]).toEqual([true, false, false])
      expect(accepted.sendResponse).not.toHaveBeenCalled()
      expect(onError).toHaveBeenCalledExactlyOnceWith({ code: "HandlerFailed", message: "Error: selector failure" })
      initialized.release()
      await worker.ready
      await vi.waitFor(() => expect(accepted.sendResponse).toHaveBeenCalledWith({ ok: true, value: "hello from other" }))
      await worker.dispose()
      expect(accepted.sendResponse).toHaveBeenCalledTimes(1)
      expect(ignored.sendResponse).not.toHaveBeenCalled()
      expect(thrown.sendResponse).not.toHaveBeenCalled()
      expect(handled.mock.calls).toEqual([["hello"]])
      expect(onMessageExternal.listeners.size).toBe(0)
    })

    it("answers handler failures, defects and construction throws as HandlerFailed envelopes", async () => {
      const onMessageExternal = external()
      const onError = vi.fn()

      const worker = start({ ...setup(), layer: Layer.empty, onError, listeners: [
        listenReply(onMessageExternal, {
          handler: (message) => {
            if (message === "throw") throw new Error("construction")

            return message === "fail" ? Effect.fail("typed") : Effect.die("defect")
          }
        })
      ] })

      await worker.ready
      const results = ["fail", "defect", "throw"].map((message) => deliver(onMessageExternal, message))
      await vi.waitFor(() => { for (const result of results) expect(result.sendResponse).toHaveBeenCalledTimes(1) })

      for (const [index, expected] of ["typed", "defect", "construction"].entries()) {
        expect(results[index]!.sendResponse).toHaveBeenCalledWith({ ok: false, error: {
          code: "HandlerFailed", message: expect.stringContaining(expected)
        } })
      }

      expect(onError).not.toHaveBeenCalled()
      await worker.dispose()
    })

    it.each(["Overflow", "InitializationFailed", "Disposed"] as const)("answers %s without running the handler", async (code) => {
      const onMessageExternal = external()
      const initialized = gate()
      const handler = vi.fn(() => Effect.succeed("unreachable"))
      const onError = vi.fn()

      const worker = start({ ...setup(), layer: Layer.empty, onError, maxPending: 0,
        initialize: code === "InitializationFailed" ? Effect.fail("boom") : initialized.effect,
        listeners: [listenReply(onMessageExternal, { handler })] })

      const listener = [...onMessageExternal.listeners][0]!

      if (code === "InitializationFailed") await worker.ready

      if (code === "Disposed") await worker.dispose()
      const result = deliverTo(listener, "late")
      expect(result.claimed).toBe(true)
      expect(result.sendResponse).toHaveBeenCalledExactlyOnceWith({ ok: false, error: {
        code, message: code === "InitializationFailed" ? expect.stringContaining("boom") : expect.any(String)
      } })
      expect(handler).not.toHaveBeenCalled()
      await worker.dispose()
    })

    it("builds the native answer with reply, calling the callback with no argument for undefined", async () => {
      const onDeterminingFilename = event<
        (item: { readonly filename: string }, suggest: (suggestion?: { readonly filename: string }) => void) => boolean
      >()

      const replies = vi.fn((response: Response<string>) => response.ok ? { filename: response.value } : undefined)

      const worker = start({ ...setup(), layer: Layer.empty, listeners: [
        listenReply(onDeterminingFilename, {
          handler: (item) => item.filename === "bad" ? Effect.fail("rejected") : Effect.succeed(`renamed/${item.filename}`),
          reply: replies
        })
      ] })

      await worker.ready
      const listener = [...onDeterminingFilename.listeners][0]!
      const good = vi.fn<(suggestion?: { readonly filename: string }) => void>()
      const bad = vi.fn<(suggestion?: { readonly filename: string }) => void>()
      expect(listener({ filename: "a.txt" }, good)).toBe(true)
      expect(listener({ filename: "bad" }, bad)).toBe(true)
      await vi.waitFor(() => expect(good.mock.calls.length + bad.mock.calls.length).toBe(2))
      expect(good.mock.calls).toEqual([[{ filename: "renamed/a.txt" }]])
      expect(bad.mock.calls).toEqual([[]])
      expect(replies).toHaveBeenCalledWith({ ok: false, error: { code: "HandlerFailed", message: expect.stringContaining("rejected") } })
      await worker.dispose()
    })

    it("reports an answer that cannot be built or delivered and answers a success once more as a failure", async () => {
      const onMessageExternal = external()
      const onError = vi.fn()
      let failBuild = true

      const worker = start({ ...setup(), layer: Layer.empty, onError, listeners: [
        listenReply(onMessageExternal, {
          handler: (message) => message === "fail" ? Effect.fail("handler") : Effect.succeed(message),
          reply: (response) => {
            if (response.ok && failBuild) {
              failBuild = false
              throw new Error("cannot build")
            }

            return response
          }
        })
      ] })

      await worker.ready
      const built = deliver(onMessageExternal, "value")
      const closed = deliver(onMessageExternal, "fail", vi.fn(() => { throw new Error("closed") }))
      const missing = [...onMessageExternal.listeners][0]!

      // Chrome always passes the callback; without one, the failure is reported, not thrown.
      // SAFETY: deliberately omits the native callback to exercise the defensive path.
      expect((missing as (...args: ReadonlyArray<unknown>) => boolean)("orphan", { id: "other" })).toBe(true)
      await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(4))
      expect(built.sendResponse.mock.calls).toEqual([[{ ok: false, error: { code: "HandlerFailed", message: "Error: cannot build" } }]])
      expect(closed.sendResponse).toHaveBeenCalledTimes(1)
      expect(onError).toHaveBeenCalledWith({ code: "HandlerFailed", message: "Error: cannot build" })
      expect(onError).toHaveBeenCalledWith({ code: "HandlerFailed", message: "Error: closed" })
      expect(onError).toHaveBeenCalledWith({ code: "HandlerFailed", message: expect.stringContaining("TypeError") })
      await worker.dispose()
    })

    it("stops claiming once unregistered but still answers events it already claimed", async () => {
      const onMessageExternal = external()
      const initialized = gate()
      const worker = start({ ...setup(), layer: Layer.empty, initialize: initialized.effect })
      const unregister = worker.register(listenReply(onMessageExternal, { handler: (message) => Effect.succeed(message) }))
      const listener = [...onMessageExternal.listeners][0]!
      const accepted = deliver(onMessageExternal, "before")
      unregister()
      unregister()
      expect(onMessageExternal.listeners.size).toBe(0)
      const late = vi.fn()
      expect(listener("after", { id: "other" }, late)).toBe(false)
      initialized.release()
      await worker.ready
      await vi.waitFor(() => expect(accepted.sendResponse).toHaveBeenCalledWith({ ok: true, value: "before" }))
      await worker.dispose()
      expect(late).not.toHaveBeenCalled()
    })
  })

  describe("ports", () => {
    const port = (name: string) => {
      const disconnect = vi.fn()

      // SAFETY: the worker only calls disconnect, and handlers here read only name.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions
      return { native: { name, disconnect } as unknown as chrome.runtime.Port, disconnect }
    }

    it.each(["Overflow", "InitializationFailed", "Disposed"] as const)(
      "disconnects an onConnect port whose handler never starts (%s)", async (code) => {
        const api = setup()
        const onError = vi.fn()
        const onConnect = vi.fn(() => Effect.void)

        const worker = start({ chrome: api.chrome, layer: Layer.empty, onError, onConnect, maxPending: 0,
          initialize: code === "InitializationFailed" ? Effect.fail("boom") : Effect.never })

        const listener = [...api.chrome.runtime.onConnect.listeners][0]!

        if (code === "InitializationFailed") await worker.ready

        if (code === "Disposed") await worker.dispose()
        const rejected = port("rejected")
        listener(rejected.native)
        expect(rejected.disconnect).toHaveBeenCalledTimes(1)
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code }))
        expect(onConnect).not.toHaveBeenCalled()
        await worker.dispose()
      }
    )

    it("leaves a started handler's port open and reports a failing disconnect", async () => {
      const api = setup()
      const onError = vi.fn()
      const onConnectExternal = event<(port: chrome.runtime.Port) => void>()
      const handled = vi.fn()

      const worker = start({ chrome: api.chrome, layer: Layer.empty, onError, maxPending: 0,
        initialize: Effect.never,
        listeners: [listenPort(onConnectExternal, (native) => Effect.sync(() => handled(native.name)))] })

      const failing = port("failing")
      failing.disconnect.mockImplementation(() => { throw new Error("already gone") })

      for (const listener of onConnectExternal.listeners) listener(failing.native)
      expect(onError).toHaveBeenCalledWith({ code: "Overflow", message: "Startup queue is full" })
      expect(onError).toHaveBeenCalledWith({ code: "HandlerFailed", message: "Error: already gone" })
      await worker.dispose()

      const ready = start({ chrome: api.chrome, layer: Layer.empty,
        listeners: [listenPort(onConnectExternal, (native) => Effect.sync(() => handled(native.name)))] })

      await ready.ready
      const accepted = port("accepted")

      for (const listener of onConnectExternal.listeners) listener(accepted.native)
      await vi.waitFor(() => expect(handled).toHaveBeenCalledWith("accepted"))
      await ready.dispose()
      expect(accepted.disconnect).not.toHaveBeenCalled()
      expect(onConnectExternal.listeners.size).toBe(0)
    })
  })
})
