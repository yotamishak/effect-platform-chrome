// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Exit, Layer, ManagedRuntime } from "effect"
import { describe, expect, it, vi } from "@effect/vitest"
import { start } from "../src/ChromeServiceWorker.js"
import type { ChromeEvent, MessageListener, Response } from "../src/ChromeServiceWorker.js"

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
    api.send("ours", vi.fn(() => { throw new Error("closed channel") }))

    for (const listener of api.chrome.runtime.onStartup.listeners) listener()
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(3))
    await worker.dispose()
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
})
