import * as ChromePort from "../ChromePort.js"
import * as TestEvent from "./Event.js"

// These are deliberately raw Chrome I/O boundaries: messages, stored values and
// callback exceptions are unvalidated until a consumer applies its own schema.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns */

const cloneMessage = (message: unknown): unknown => {
  const encoded = JSON.stringify(message)

  if (encoded === undefined) throw new TypeError("Message must be JSON serializable")

  return JSON.parse(encoded)
}

export interface PortPairOptions {
  /**
   * The `sender` of the right endpoint, the side Chrome would pass to `onConnect`. The left
   * endpoint, the connecting side, never has one, as in Chrome.
   */
  readonly sender?: chrome.runtime.MessageSender
}

/** A single two-endpoint connection, with manually flushed FIFO delivery. */
export const makePortPair = (name = "", options: PortPairOptions = {}) => {
  const tasks: Array<() => void> = []
  let connected = true

  const endpoint = (sender: chrome.runtime.MessageSender | undefined) => {
    const message = TestEvent.makeEvent<[unknown, chrome.runtime.Port]>()
    const disconnect = TestEvent.makeEvent<[chrome.runtime.Port]>()
    let lastError: chrome.runtime.LastError | undefined
    const failures = new Map<"postMessage" | "disconnect" | "connect", Array<unknown>>()

    const check = (operation: "postMessage" | "disconnect" | "connect") => {
      const queue = failures.get(operation)

      if (queue !== undefined && queue.length > 0) throw queue.shift()
    }

    const native: chrome.runtime.Port = {
      name,
      onMessage: message.api,
      onDisconnect: disconnect.api,
      postMessage: (value: unknown) => {
        check("postMessage")

        if (!connected) throw new Error("Port is disconnected")

        const cloned = cloneMessage(value)
        const peer = native === left.port ? right : left
        tasks.push(() => { if (connected) peer.events.message.emit(cloned, peer.port) })
      },
      disconnect: () => {
        check("disconnect")

        if (!connected) return
        connected = false

        const peer = native === left.port ? right : left
        tasks.push(() => { peer.notifyDisconnect() })
      }
    }

    // Chrome leaves `sender` out entirely on the connecting side.
    if (sender !== undefined) native.sender = sender

    const api: ChromePort.ChromePortApi = {
      get lastError() { return lastError },
      connect: () => {
        check("connect")

        if (!connected) throw new Error("Pair is disconnected; create a new fixture")

        return native
      }
    }

    return {
      port: native,
      api,
      layer: ChromePort.layer(api),
      events: { message: message.controls, disconnect: disconnect.controls },
      notifyDisconnect: (error?: string) => {
        lastError = error === undefined ? undefined : { message: error }

        try { disconnect.controls.emit(native) } finally { lastError = undefined }
      },
      failNext: (operation: "postMessage" | "disconnect" | "connect", cause: unknown) => {
        const queue = failures.get(operation) ?? []
        queue.push(cause)
        failures.set(operation, queue)
      }
    }
  }

  const left = endpoint(undefined)

  const right = endpoint(options.sender)

  return {
    left: { port: left.port, api: left.api, layer: left.layer },
    right: { port: right.port, api: right.api, layer: right.layer },
    controls: {
      left: { ...left.events, failNext: left.failNext },
      right: { ...right.events, failNext: right.failNext },
      get connected() { return connected },
      get pendingCount() { return tasks.length },
      flushOne: (): boolean => {
        const task = tasks.shift()

        if (task === undefined) return false
        task()

        return true
      },
      /** Drains only the current snapshot; reentrant posts await another flush. */
      flush: () => { for (const task of tasks.splice(0)) task() },
      disconnect: (error?: string) => {
        if (!connected) return
        connected = false
        tasks.push(() => { left.notifyDisconnect(error) })
        tasks.push(() => { right.notifyDisconnect(error) })
      }
    }
  }
}
