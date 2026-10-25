import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeCommandsError extends Schema.TaggedError<ChromeCommandsError>()("ChromeCommandsError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/**
 * A command invocation: its manifest name and the tab that was active when the shortcut was
 * pressed. `tab` is None when Chrome supplies none, as for a global shortcut pressed while no
 * Chrome window is focused.
 */
export interface CommandEvent {
  readonly command: string
  readonly tab: Option.Option<chrome.tabs.Tab>
}

/** The Promise-based MV3 surface of `chrome.commands`: `getAll` and `onCommand` are all of it. */
export interface ChromeCommandsApi {
  getAll(): Promise<Array<chrome.commands.Command>>
  readonly onCommand: EventSource<[command: string, tab?: chrome.tabs.Tab]>
}

export interface ChromeCommandsService {
  /**
   * The manifest's commands with their current shortcuts, in Chrome's order; each run queries
   * afresh, so a shortcut the user changed at `chrome://extensions/shortcuts` shows up on the
   * next run. A `shortcut` is empty when the command has none: it declared no
   * `suggested_key`, the user removed it, or Chrome could not assign it. Every field of a
   * `Command` is optional in Chrome's schema. Since Chrome 110 the list includes
   * `_execute_action` when the manifest declares it.
   */
  readonly getAll: Effect.Effect<Array<chrome.commands.Command>, ChromeCommandsError>
  /**
   * Activations of the extension's commands through their keyboard shortcuts. Observational:
   * each run adds its own listener and removes it when the stream ends, so it cannot wake an
   * MV3 service worker; register wake listeners through `ChromeServiceWorker.listen`. Buffers
   * at most 64 events, dropping the oldest. The reserved `_execute_action` command never
   * fires here: Chrome triggers the action instead (its popup, or `action.onClicked`).
   */
  readonly onCommand: Stream.Stream<CommandEvent, ChromeCommandsError>
}

export class ChromeCommands extends Context.Service<ChromeCommands, ChromeCommandsService>()("effect-platform-chrome/ChromeCommands") {}

const invoke = invoker((operation, cause) => new ChromeCommandsError({ operation, cause }))

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeCommandsApi): ChromeCommandsService => ChromeCommands.of({
  getAll: invoke("getAll", () => api.getAll()),
  onCommand: observe(
    () => api.onCommand,
    (command, tab) => ({ command, tab: Option.fromNullishOr(tab) }),
    (cause) => new ChromeCommandsError({ operation: "onCommand", cause })
  )
})

export const layer = (api: ChromeCommandsApi): Layer.Layer<ChromeCommands> => Layer.succeed(ChromeCommands, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeCommands, ChromeCommandsError> = liveLayer(
  ChromeCommands, "commands", (chrome) => chrome.commands, make,
  (cause) => new ChromeCommandsError({ operation: "initialize", cause })
)
