import { Option, Schema } from "effect"
import * as ChromeManagement from "../ChromeManagement.js"
import * as TestEvent from "./Event.js"

type ExtensionInfo = ChromeManagement.ExtensionInfo

type DisabledReason = NonNullable<ExtensionInfo["disabledReason"]>

/** What a confirmation dialog does: accept, cancel, or wait for `controls.answerDialog`. */
export type DialogAnswer = "accept" | "cancel" | "hold"

/** The dialogs the simulated Chrome shows. */
export type DialogKind = "uninstall" | "reEnable" | "createAppShortcut"

export interface PendingDialog {
  readonly kind: DialogKind
  /** The item the dialog is about. */
  readonly id: string
}

export interface ManagementOptions {
  /** The calling extension's entry; fields left out take `extensionInfo`'s defaults. */
  readonly self?: Partial<ExtensionInfo>
  /** Other installed items, in install order. */
  readonly installed?: ReadonlyArray<ExtensionInfo>
  /**
   * Whether the extension holds the "management" permission (default true). Without it the
   * gated members are absent, as in Chrome: only `getSelf`, `getPermissionWarningsByManifest`
   * and `uninstallSelf` remain.
   */
  readonly permission?: boolean
  /** The manifest's `replacement_web_app` URL; `installReplacementWebApp` exists only when given. */
  readonly replacementWebApp?: string
  /** The warning shown for each permission or host pattern; unlisted ones show none. */
  readonly warnings?: ReadonlyMap<string, string>
  /** Replaces any member of the simulated API. */
  readonly overrides?: Partial<ChromeManagement.ChromeManagementApi>
}

const appTypes: ReadonlySet<ExtensionInfo["type"]> = new Set(["hosted_app", "packaged_app", "legacy_packaged_app"])

const alphabet = "abcdefghijklmnop"

/** A 32-letter id in Chrome's a–p alphabet, distinct for each non-negative integer. */
export const extensionId = (index: number): string => {
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError(`extensionId needs a non-negative integer, got ${index}`)

  return Array.from(index.toString(16).padStart(32, "0"), (digit) => alphabet.charAt(Number.parseInt(digit, 16))).join("")
}

/**
 * A complete entry for an enabled, normally installed extension with `properties` applied.
 * `shortName` follows `name`, and `isApp` follows `type`, unless given.
 */
export const extensionInfo = (id: string, properties: Partial<ExtensionInfo> = {}): ExtensionInfo => {
  const name = properties.name ?? "Extension"
  const type = properties.type ?? "extension"

  return {
    id, name, shortName: name, description: "", version: "1.0.0", enabled: true, mayDisable: true,
    installType: "normal", type, offlineEnabled: false, optionsUrl: "", permissions: [], hostPermissions: [],
    isApp: appTypes.has(type),
    ...properties
  }
}

const fail = (message: string): never => { throw new Error(message) }

const noExtension = (id: string): never => fail(`Failed to find extension with id ${id}.`)

const cannotModify = (id: string): never => fail(`Extension ${id} cannot be modified by user.`)

const notAnApp = (id: string): never => fail(`Extension ${id} is not an App.`)

const contextInvalidated = "Extension context invalidated."

/** The manifest fields the warnings model reads; Chrome requires name, version and manifest_version. */
const Manifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  manifest_version: Schema.Finite,
  permissions: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  host_permissions: Schema.optionalKey(Schema.Array(Schema.Unknown))
})

const isDictionary = Schema.is(Schema.Record(Schema.String, Schema.Unknown))

const isString = Schema.is(Schema.String)

const enabledCopy = (info: ExtensionInfo): ExtensionInfo => {
  const next = { ...info, enabled: true }
  delete next.disabledReason
  delete next.mayEnable

  return next
}

const disabledCopy = (info: ExtensionInfo, reason: DisabledReason): ExtensionInfo => ({
  ...info, enabled: false, disabledReason: reason, mayEnable: info.mayEnable ?? true
})

/**
 * An in-memory `chrome.management`. It holds the calling extension (first) and the other
 * installed items, and returns copies, so callers cannot change its state.
 *
 * Calls fail with Chrome's messages where Chrome would: unknown ids, items the user may not
 * modify (`mayDisable: false` for any change, `mayEnable: false` for enabling), app-only
 * calls on non-apps, launch types outside `availableLaunchTypes`, non-http(s) URLs, empty
 * titles, and gesture-only calls made outside `controls.withUserGesture`. Chrome's gesture
 * requirements are modelled exactly: `uninstall` of another item (always), `uninstallSelf`
 * with `showConfirmDialog`, `setEnabled` re-enabling an item disabled for
 * "permissions_increase", `setLaunchType`, `createAppShortcut`, `generateAppForLink` and
 * `installReplacementWebApp`. A gesture lasts only while `withUserGesture`'s callback runs
 * synchronously, so only calls started inside it count.
 *
 * Uninstall, re-enable and shortcut dialogs follow `controls.answerDialogs` (accepting by
 * default); "hold" queues them until `controls.answerDialog`. An accepted dialog acts on the
 * item's state at that moment, so an item removed meanwhile fails as unknown.
 *
 * Changes emit `onInstalled`, `onUninstalled`, `onEnabled` and `onDisabled` with the new
 * entry; setting an item to its current state changes nothing and emits nothing.
 * `uninstallSelf` (and `uninstall` of the extension's own id) removes the extension and,
 * unlike Chrome, resolves; afterwards every call rejects with "Extension context
 * invalidated." `getPermissionWarningsByManifest` parses strict JSON and reports one warning
 * per listed permission and host pattern found in `warnings`, in manifest order (Chrome's
 * merging of overlapping warnings is not modelled). Launched apps, created shortcuts and
 * replacement web app launches are recorded in `controls`.
 */
export const makeManagement = (options: ManagementOptions = {}) => {
  const self = extensionInfo(options.self?.id ?? extensionId(0), options.self)
  const items = new Map<string, ExtensionInfo>([[self.id, self]])
  const warnings = options.warnings ?? new Map<string, string>()
  const installed = TestEvent.makeEvent<[ExtensionInfo]>()
  const uninstalled = TestEvent.makeEvent<[string]>()
  const enabled = TestEvent.makeEvent<[ExtensionInfo]>()
  const disabled = TestEvent.makeEvent<[ExtensionInfo]>()
  const pending: Array<PendingDialog & { readonly settle: (accepted: boolean) => void }> = []
  const launches: Array<string> = []
  const shortcuts: Array<string> = []
  const replacementLaunches: Array<string> = []
  let answer: DialogAnswer = "accept"
  let gesture = false
  let selfUninstalled = false
  let generated = 0

  for (const info of options.installed ?? []) {
    if (items.has(info.id)) throw new Error(`makeManagement: duplicate installed id ${info.id}`)

    items.set(info.id, structuredClone(info))
  }

  /** Reads the gesture flag and fails once the extension uninstalled itself. */
  const enter = (): boolean => {
    if (selfUninstalled) fail(contextInvalidated)

    return gesture
  }

  const find = (id: string): ExtensionInfo => items.get(id) ?? noExtension(id)

  const findApp = (id: string): ExtensionInfo => {
    const item = find(id)

    return appTypes.has(item.type) ? item : notAnApp(id)
  }

  const dialog = (kind: DialogKind, id: string): Promise<boolean> => {
    if (answer !== "hold") return Promise.resolve(answer === "accept")

    return new Promise((resolve) => { pending.push({ kind, id, settle: resolve }) })
  }

  const warningsFor = (entries: ReadonlyArray<unknown>): Array<string> => entries.flatMap((entry) => {
    const warning = isString(entry) ? warnings.get(entry) : undefined

    return warning === undefined ? [] : [warning]
  })

  const store = (info: ExtensionInfo): ExtensionInfo => {
    items.set(info.id, info)

    return structuredClone(info)
  }

  const changeEnabled = (item: ExtensionInfo, enable: boolean, reason: DisabledReason): ReadonlyArray<unknown> => {
    if (item.enabled === enable) return []

    return enable
      ? enabled.controls.emit(store(enabledCopy(item)))
      : disabled.controls.emit(store(disabledCopy(item, reason)))
  }

  const remove = (id: string): ReadonlyArray<unknown> => {
    find(id)
    items.delete(id)

    if (id !== self.id) return uninstalled.controls.emit(id)

    selfUninstalled = true

    return []
  }

  const uninstallItem = async (id: string, showConfirmDialog: boolean, userGesture: boolean): Promise<void> => {
    const item = find(id)

    if (!item.mayDisable) cannotModify(id)

    if (showConfirmDialog) {
      if (!userGesture) fail("chrome.management.uninstall requires a user gesture.")

      if (!(await dialog("uninstall", id))) fail(`Extension ${id} uninstall canceled by user.`)
    }

    remove(id)
  }

  const required: ChromeManagement.ChromeManagementApi = {
    getSelf: async () => {
      enter()

      return structuredClone(find(self.id))
    },
    getPermissionWarningsByManifest: async (manifestStr) => {
      enter()
      const parsed: unknown = JSON.parse(manifestStr)

      if (!isDictionary(parsed) || Array.isArray(parsed)) fail("Failed to parse manifest.")

      const manifest = Schema.decodeUnknownOption(Manifest)(parsed)

      if (Option.isNone(manifest)) return fail("Failed to create extension from manifest.")

      return [...warningsFor(manifest.value.permissions ?? []), ...warningsFor(manifest.value.host_permissions ?? [])]
    },
    uninstallSelf: async (uninstallOptions) => {
      const userGesture = enter()

      await uninstallItem(self.id, uninstallOptions?.showConfirmDialog ?? false, userGesture)
    }
  }

  const gated: ChromeManagement.ChromeManagementApi = {
    ...required,
    getAll: async () => {
      enter()

      return Array.from(items.values(), (info) => structuredClone(info))
    },
    get: async (id) => {
      enter()

      return structuredClone(find(id))
    },
    getPermissionWarningsById: async (id) => {
      enter()
      const item = find(id)

      return [...warningsFor(item.permissions), ...warningsFor(item.hostPermissions)]
    },
    setEnabled: async (id, enable) => {
      const userGesture = enter()
      const item = find(id)

      if (!item.mayDisable || (enable && item.mayEnable === false)) cannotModify(id)

      if (item.enabled === enable) return

      if (enable && item.disabledReason === "permissions_increase") {
        if (!userGesture) fail("Re-enabling an extension disabled due to permissions increase requires a user gesture.")

        if (!(await dialog("reEnable", id))) fail("The user did not accept the re-enable dialog.")
      }

      changeEnabled(find(id), enable, "unknown")
    },
    uninstall: async (id, uninstallOptions) => {
      const userGesture = enter()

      // Chrome forces the dialog for every item but the caller's own.
      await uninstallItem(id, id !== self.id || (uninstallOptions?.showConfirmDialog ?? false), userGesture)
    },
    launchApp: async (id) => {
      enter()
      findApp(id)
      launches.push(id)
    },
    setLaunchType: async (id, launchType) => {
      if (!enter()) fail("chrome.management.setLaunchType requires a user gesture.")

      const app = findApp(id)

      if (!(app.availableLaunchTypes ?? []).includes(launchType)) fail("The launch type is not available for this app.")

      store({ ...app, launchType })
    },
    createAppShortcut: async (id) => {
      if (!enter()) fail("chrome.management.createAppShortcut requires a user gesture.")

      findApp(id)

      if (!(await dialog("createAppShortcut", id))) fail("App shortcuts creation canceled by user.")

      findApp(id)
      shortcuts.push(id)
    },
    generateAppForLink: async (url, title) => {
      if (!enter()) fail("chrome.management.generateAppForLink requires a user gesture.")

      const parsed = URL.parse(url)

      if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) fail(`The URL "${url}" is invalid.`)

      if (title === "") fail("The title can not be empty.")

      generated++

      const app = extensionInfo(extensionId(0x10000 + generated), {
        name: title, type: "hosted_app", appLaunchUrl: url, launchType: "OPEN_AS_WINDOW",
        availableLaunchTypes: ["OPEN_AS_REGULAR_TAB", "OPEN_AS_WINDOW"], offlineEnabled: true
      })

      const result = store(app)
      installed.controls.emit(structuredClone(app))

      return result
    },
    onInstalled: installed.api,
    onUninstalled: uninstalled.api,
    onEnabled: enabled.api,
    onDisabled: disabled.api
  }

  const members = options.permission === false ? required : gated
  const replacementWebApp = options.replacementWebApp

  const api: ChromeManagement.ChromeManagementApi = replacementWebApp === undefined
    ? { ...members, ...options.overrides }
    : {
      ...members,
      installReplacementWebApp: async () => {
        if (!enter()) fail("chrome.management.installReplacementWebApp requires a user gesture.")

        replacementLaunches.push(replacementWebApp)
      },
      ...options.overrides
    }

  return {
    api,
    layer: ChromeManagement.layer(api),
    controls: {
      /** The calling extension's current entry, if it is still installed. */
      get self(): ExtensionInfo | undefined { return structuredClone(items.get(self.id)) },
      /** An installed item's current entry. */
      item: (id: string): ExtensionInfo | undefined => structuredClone(items.get(id)),
      /** The ids of every installed item, the extension itself first. */
      get ids(): ReadonlyArray<string> { return Array.from(items.keys()) },
      /** Whether the extension uninstalled itself; every call then rejects. */
      get selfUninstalled(): boolean { return selfUninstalled },
      /**
       * Runs `run` as a user gesture: calls it makes synchronously see one, as Chrome's
       * do inside a click handler. Calls made after it returns do not.
       */
      withUserGesture: <A>(run: () => A): A => {
        const previous = gesture
        gesture = true

        try {
          return run()
        } finally {
          gesture = previous
        }
      },
      /** How later dialogs answer; dialogs already held stay pending. */
      answerDialogs: (next: DialogAnswer): void => { answer = next },
      /** Dialogs waiting under "hold", oldest first. */
      get pendingDialogs(): ReadonlyArray<PendingDialog> { return pending.map(({ kind, id }) => ({ kind, id })) },
      /** Answers the oldest held dialog; throws when none is pending. */
      answerDialog: (accepted: boolean): PendingDialog => {
        const next = pending.shift()

        if (next === undefined) throw new Error("No dialog is pending")

        next.settle(accepted)

        return { kind: next.kind, id: next.id }
      },
      /** Installs (or updates) an item outside the API, emitting onInstalled. */
      install: (info: ExtensionInfo): ReadonlyArray<unknown> => {
        items.set(info.id, structuredClone(info))

        return installed.controls.emit(structuredClone(info))
      },
      /** The user removes an item in chrome://extensions, emitting onUninstalled. */
      uninstall: (id: string): ReadonlyArray<unknown> => remove(id),
      /** The user or Chrome enables or disables an item, with the reason Chrome reports. */
      setEnabled: (id: string, enable: boolean, reason: DisabledReason = "unknown"): ReadonlyArray<unknown> =>
        changeEnabled(find(id), enable, reason),
      /** App ids passed to `launchApp`, in order. */
      get launches(): ReadonlyArray<string> { return Array.from(launches) },
      /** App ids whose shortcut dialog was accepted, in order. */
      get shortcuts(): ReadonlyArray<string> { return Array.from(shortcuts) },
      /** The replacement web app URL, once per `installReplacementWebApp`. */
      get replacementWebAppLaunches(): ReadonlyArray<string> { return Array.from(replacementLaunches) },
      onInstalled: installed.controls,
      onUninstalled: uninstalled.controls,
      onEnabled: enabled.controls,
      onDisabled: disabled.controls
    }
  }
}
