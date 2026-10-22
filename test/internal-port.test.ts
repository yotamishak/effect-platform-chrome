// The pinned Effect v4 test integration is intentionally unstable and test-only.
/* oxlint-disable effecttsgo/unstable-api-usage */
import { describe, expect, it, vi } from "@effect/vitest"
import * as PortLink from "../src/internal/port.js"
import { makeEvent } from "../src/ChromeTesting.js"
import type { NativePort, Ownership } from "../src/ChromePort.js"

const fixture = (ownership: Ownership = "owned") => {
  const message = makeEvent<[unknown, NativePort]>()
  const disconnects = makeEvent<[NativePort]>()
  const disconnect = vi.fn<() => void>()
  let lastError: chrome.runtime.LastError | undefined
  const received: Array<unknown> = []
  const reported: Array<chrome.runtime.LastError | undefined> = []

  const native: NativePort = {
    name: "link", postMessage: vi.fn(), disconnect, onMessage: message.api, onDisconnect: disconnects.api
  }

  const link = PortLink.make(native, ownership, () => lastError, {
    onMessage: (value) => { received.push(value) },
    onDisconnect: (error) => { reported.push(error) }
  })

  return {
    native, link, message, disconnects, disconnect, received, reported,
    listenerCount: () => message.controls.listenerCount + disconnects.controls.listenerCount,
    close: (error?: string) => {
      lastError = error === undefined ? undefined : { message: error }

      try { disconnects.controls.emit(native) } finally { lastError = undefined }
    }
  }
}

describe("internal/port", () => {
  it("forwards messages only while open and reports one disconnect with its snapshotted lastError", () => {
    const f = fixture()
    f.message.controls.emit("before registration", f.native)
    f.link.register()
    f.message.controls.emit("open", f.native)
    f.close("host error")
    f.close()
    f.message.controls.emit("after disconnect", f.native)

    expect(f.received).toEqual(["open"])
    expect(f.reported).toEqual([{ message: "host error" }])
    expect(f.link.isOpen()).toBe(false)
    // The owner detaches; a reported disconnect is never answered with a native disconnect.
    expect(f.listenerCount()).toBe(2)
    expect(f.disconnect).not.toHaveBeenCalled()
  })

  it("close gates callbacks and reports whether the link was open", () => {
    const f = fixture()
    f.link.register()

    expect(f.link.close()).toBe(true)
    expect(f.link.close()).toBe(false)
    f.message.controls.emit("closed", f.native)
    f.close()
    expect(f.received).toEqual([])
    expect(f.reported).toEqual([])
  })

  it("detach attempts both removals when the first throws", () => {
    const f = fixture()
    const cause = new Error("message removal failed")
    f.link.register()
    f.message.controls.failNext("removeListener", cause)

    expect(() => f.link.detach()).toThrow(cause)
    expect(f.disconnects.controls.listenerCount).toBe(0)
  })

  it.each(["owned", "borrowed"] as const)("disconnects a %s port at most once, even when it throws", (ownership) => {
    const f = fixture(ownership)
    f.disconnect.mockImplementation(() => { throw new Error("disconnect failed") })

    if (ownership === "owned") expect(() => f.link.disconnect()).toThrow("disconnect failed")
    else f.link.disconnect()

    f.link.disconnect()
    expect(f.disconnect).toHaveBeenCalledTimes(ownership === "owned" ? 1 : 0)
  })

  it.each(["owned", "borrowed"] as const)("rolls back a partial registration of a %s port and rethrows", (ownership) => {
    for (const event of ["onMessage", "onDisconnect"] as const) {
      const f = fixture(ownership)
      const cause = new Error(`${event} failed after inserting`)

      if (event === "onMessage") {
        const add = f.native.onMessage.addListener.bind(f.native.onMessage)

        vi.spyOn(f.native.onMessage, "addListener").mockImplementation((listener) => {
          add(listener)
          throw cause
        })
      } else {
        const add = f.native.onDisconnect.addListener.bind(f.native.onDisconnect)

        vi.spyOn(f.native.onDisconnect, "addListener").mockImplementation((listener) => {
          add(listener)
          throw cause
        })
      }

      expect(() => f.link.register()).toThrow(cause)
      expect(f.link.isOpen()).toBe(false)
      expect(f.listenerCount()).toBe(0)
      expect(f.disconnect).toHaveBeenCalledTimes(ownership === "owned" ? 1 : 0)
      f.link.disconnect()
      expect(f.disconnect).toHaveBeenCalledTimes(ownership === "owned" ? 1 : 0)
    }
  })

  it("removes a listener inserted after the disconnect it reported during registration", () => {
    const f = fixture()
    const add = f.native.onDisconnect.addListener.bind(f.native.onDisconnect)
    const addMessage = vi.spyOn(f.native.onMessage, "addListener")

    vi.spyOn(f.native.onDisconnect, "addListener").mockImplementation((listener) => {
      listener(f.native)
      add(listener)
    })

    f.link.register()
    expect(f.reported).toEqual([undefined])
    expect(addMessage).not.toHaveBeenCalled()
    expect(f.listenerCount()).toBe(0)
    expect(f.disconnect).not.toHaveBeenCalled()
  })
})
