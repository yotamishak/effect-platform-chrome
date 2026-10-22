import type { NativePort, Ownership } from "../ChromePort.js"

/** What a link forwards from the native port while it is open. */
export interface Handlers {
  // Native port messages are an untrusted I/O boundary; each owner validates its own frames.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  readonly onMessage: (message: unknown) => void
  /**
   * Chrome reported the disconnect. The link is already closed; `lastError` is the value
   * snapshotted inside the native callback, the only time Chrome exposes it. The owner
   * detaches the listeners, so it decides whether a removal failure may escape.
   */
  readonly onDisconnect: (lastError: chrome.runtime.LastError | undefined) => void
}

/**
 * The native half of a port wrapper, shared by ChromePort and ChromeRpc: listener
 * registration and rollback, the open/closed gate for native callbacks, and an owned-only,
 * at-most-once native disconnect. Owners compose these into their own buffering and errors.
 */
export interface Link {
  readonly isOpen: () => boolean
  /** Stops forwarding native callbacks. Returns whether the link was still open. */
  readonly close: () => boolean
  /** Removes both listeners, attempting the second even when the first removal throws. */
  readonly detach: () => void
  /** Disconnects an owned native port at most once, even if that attempt throws; borrowed ports never. */
  readonly disconnect: () => void
  /**
   * Adds the disconnect listener, then the message listener unless Chrome already reported
   * the disconnect. On failure it closes, detaches and disconnects (best-effort) and rethrows.
   */
  readonly register: () => void
}

/** Creates an unregistered link; callbacks may use it once `register` runs. */
export const make = (
  native: NativePort,
  ownership: Ownership,
  lastError: () => chrome.runtime.LastError | undefined,
  handlers: Handlers
): Link => {
  let open = true
  let disconnectAttempted = false

  const onMessage: Handlers["onMessage"] = (message) => {
    if (open) handlers.onMessage(message)
  }

  const onDisconnect = () => {
    // Chrome only exposes lastError for the duration of this callback.
    const reported = lastError()

    if (!open) return
    open = false
    handlers.onDisconnect(reported)
  }

  const close = () => {
    const wasOpen = open
    open = false

    return wasOpen
  }

  const detach = () => {
    // Attempt both removals even if a host API unexpectedly throws.
    try { native.onMessage.removeListener(onMessage) } finally {
      native.onDisconnect.removeListener(onDisconnect)
    }
  }

  const disconnect = () => {
    if (ownership !== "owned" || disconnectAttempted) return
    disconnectAttempted = true
    native.disconnect()
  }

  const register = () => {
    try {
      native.onDisconnect.addListener(onDisconnect)

      if (open) native.onMessage.addListener(onMessage)
    } catch (cause) {
      open = false

      try { detach() } catch { /* Preserve the registration failure. */ }

      try { disconnect() } catch { /* Preserve the registration failure. */ }

      throw cause
    }

    // A host may report the disconnect before inserting the listener it was registering.
    if (!open) {
      try { detach() } catch { /* The owner already received the disconnect. */ }
    }
  }

  return { isOpen: () => open, close, detach, disconnect, register }
}
