# ChromeCommands

Import from `effect-platform-chrome/ChromeCommands`. `ChromeCommands` is an Effect v4
service over `chrome.commands`; `make(api)` and `layer(api)` accept an injected API, and
`layerLive` reads the global only when built. Commands are declared in the manifest rather
than through a permission:

```json
"commands": {
  "_execute_action": { "suggested_key": { "default": "Ctrl+Shift+E" } },
  "toggle-reader": { "suggested_key": { "default": "Ctrl+Shift+Y" }, "description": "Toggle reader mode" }
}
```

- `getAll` is an Effect value that resolves the declared commands with their current
  shortcuts, queried afresh on every run. `shortcut` is `""` when a command has no active
  shortcut: no `suggested_key`, removed by the user at `chrome://extensions/shortcuts`, or
  not assignable. Since Chrome 110 the list includes `_execute_action`.
- `onCommand` emits `{ command, tab }` for each shortcut press. `tab` is an
  `Option<chrome.tabs.Tab>`: None when Chrome supplies no tab, as for a global command
  pressed while no Chrome window is focused.
- `_execute_action` never reaches `onCommand`: Chrome opens the action's popup, or fires
  `action.onClicked` when there is none.
- Failures are `ChromeCommandsError` with `operation` set to `"getAll"`, `"onCommand"`
  (the event could not be read or its listener could not be added), or `"initialize"` when
  the global is missing, and the original `cause`.

An extension declares at most four suggested shortcuts; the user can bind the rest. To
tell the user which commands still need a shortcut:

```ts
const unbound = Effect.map(commands.getAll, (all) =>
  all.filter((command) => command.name !== "_execute_action" && command.shortcut === ""))
```

## Waking the worker

`onCommand` is observational: its listener exists only while the stream runs, so it cannot
wake a stopped MV3 worker, which is where shortcut presses usually arrive. Pass a wake
listener in `ChromeServiceWorker.start`'s `listeners` option, so it is installed
synchronously at worker startup:
`ChromeServiceWorker.listen(chrome.commands.onCommand, (command, tab) => handleCommand(command, tab))`,
where the handler returns an Effect. Each stream subscription buffers at most 64 events,
dropping the oldest.

## Testing

`effect-platform-chrome/testing/Commands` exports `makeCommands(commands, overrides)`.
`getAll` resolves a fresh copy of the declared commands in order; like Chrome, it reports a
command declared without a `description` or `shortcut` with `""` for each.
`controls.setShortcut(name, shortcut)` simulates the user editing a shortcut (an empty
string unbinds it). `controls.press(name, tab?)` simulates the key press and returns
`{ dispatched, errors }`: like Chrome, it fires `onCommand` only for a bound command that is
not one of the reserved `_execute_*` action commands, and `errors` holds what listeners
threw. Both controls throw for an undeclared command name, and `makeCommands` throws for
duplicate names. `controls.onCommand` emits raw events directly.
