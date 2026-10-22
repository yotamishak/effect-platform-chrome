import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeCommandsError extends Schema.TaggedError<ChromeCommandsError>()("ChromeCommandsError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** A command invocation: its manifest name and the active tab, when Chrome supplies one. */
export interface CommandEvent {
  readonly command: string
  readonly tab: Option.Option<chrome.tabs.Tab>
}

/** The Promise-based MV3 subset this module needs. */
export interface ChromeCommandsApi {
  getAll(): Promise<Array<chrome.commands.Command>>
  readonly onCommand: EventSource<[command: string, tab?: chrome.tabs.Tab]>
}

export interface ChromeCommandsService {
  /**
   * The manifest's commands with their current shortcuts. A `shortcut` is empty when the
   * user removed it or Chrome could not assign it; each run queries afresh.
   */
  readonly getAll: Effect.Effect<Array<chrome.commands.Command>, ChromeCommandsError>
  /**
   * Observational subscription that cannot wake an MV3 service worker; register wake
   * listeners through `ChromeServiceWorker.listen`. Buffers at most 64 events, dropping
   * the oldest. `_execute_action` opens the popup instead of firing here.
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
