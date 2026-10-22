import * as ChromeCommands from "../ChromeCommands.js"
import * as TestEvent from "./Event.js"

/** Commands Chrome reserves for the extension's action; they never dispatch `onCommand`. */
const reserved: ReadonlySet<string> = new Set(["_execute_action", "_execute_browser_action", "_execute_page_action"])

/** The outcome of a simulated key press. */
export interface CommandPress {
  /** Whether `onCommand` fired: false for reserved action commands and unbound ones. */
  readonly dispatched: boolean
  /** Exceptions thrown by listeners, in listener order; later listeners still ran. */
  readonly errors: ReadonlyArray<unknown>
}

/**
 * In-memory manifest commands. `getAll` resolves a fresh copy of the commands in their
 * declared order, so callers never share state with the fixture or each other. Like Chrome,
 * it reports a missing `description` or `shortcut` as `""`.
 * `controls.setShortcut` simulates the user editing a shortcut at
 * `chrome://extensions/shortcuts` (an empty string unbinds it). `controls.press(name, tab?)`
 * simulates the shortcut: like Chrome it fires `onCommand` only for a command that has a
 * shortcut and is not one of the reserved `_execute_*` action commands. Both throw for a
 * command the fixture does not declare, and the constructor throws for duplicate names, so
 * a typo fails the test instead of passing silently. Pass `overrides` to replace any member.
 */
export const makeCommands = (
  initial: ReadonlyArray<chrome.commands.Command> = [],
  overrides: Partial<ChromeCommands.ChromeCommandsApi> = {}
) => {
  // Commands hold only strings, so a shallow copy fully isolates each snapshot.
  const copy = (command: chrome.commands.Command): chrome.commands.Command => ({ ...command })
  // Chrome always reports both strings, "" when the manifest gives no description or the
  // command has no active shortcut, so a missing one is declared as "".
  const commands = initial.map((command) => ({ ...command, description: command.description ?? "", shortcut: command.shortcut ?? "" }))
  const byName = new Map<string, chrome.commands.Command>()

  for (const command of commands) {
    if (command.name === undefined) continue

    if (byName.has(command.name)) throw new Error(`Duplicate command name: ${command.name}`)

    byName.set(command.name, command)
  }

  const onCommand = TestEvent.makeEvent<[string, chrome.tabs.Tab?]>()

  const find = (name: string): chrome.commands.Command => {
    const command = byName.get(name)

    if (command === undefined) throw new Error(`No command named ${name} is declared`)

    return command
  }

  const api: ChromeCommands.ChromeCommandsApi = {
    getAll: async () => commands.map(copy),
    onCommand: onCommand.api,
    ...overrides
  }

  return {
    api,
    layer: ChromeCommands.layer(api),
    controls: {
      /** A copy of the declared commands as `getAll` would report them now. */
      get commands(): Array<chrome.commands.Command> { return commands.map(copy) },
      /** Sets the command's shortcut; an empty string unbinds it. */
      setShortcut: (name: string, shortcut: string): void => {
        find(name).shortcut = shortcut
      },
      /** Presses the command's shortcut with an optional active tab, cloned per press. */
      press: (name: string, tab?: chrome.tabs.Tab): CommandPress => {
        const command = find(name)

        if (reserved.has(name) || command.shortcut === "") {
          return { dispatched: false, errors: [] }
        }

        const errors = tab === undefined
          ? onCommand.controls.emit(name)
          : onCommand.controls.emit(name, structuredClone(tab))

        return { dispatched: true, errors }
      },
      /** The raw event, for emitting what a real press could not produce. */
      onCommand: onCommand.controls
    }
  }
}
