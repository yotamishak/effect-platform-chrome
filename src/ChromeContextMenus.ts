import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeContextMenusError extends Schema.TaggedError<ChromeContextMenusError>()("ChromeContextMenusError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** A menu item id: the caller's string, or a number Chrome generated. */
export type MenuItemId = number | string

export type CreateProperties = chrome.contextMenus.CreateProperties

export type UpdateProperties = Omit<chrome.contextMenus.CreateProperties, "id">

export type OnClickData = chrome.contextMenus.OnClickData

export interface ClickedEvent {
  readonly info: OnClickData
  /** The tab where the click happened; absent outside a tab, such as for platform apps. */
  readonly tab: Option.Option<chrome.tabs.Tab>
}

/**
 * The MV3 subset this module needs. `create` has no Promise form: it returns the id at once
 * and reports failure (a duplicate id, an unknown parent) only through `lastError` while its
 * callback runs, so `lastError` is part of this interface rather than read from a global.
 */
export interface ChromeContextMenusApi {
  create(createProperties: CreateProperties, callback: () => void): MenuItemId
  update(id: MenuItemId, updateProperties: UpdateProperties): Promise<void>
  remove(menuItemId: MenuItemId): Promise<void>
  removeAll(): Promise<void>
  readonly onClicked: EventSource<[info: OnClickData, tab?: chrome.tabs.Tab]>
  /** `chrome.runtime.lastError`, read inside `create`'s callback. */
  readonly lastError: chrome.runtime.LastError | undefined
}

export interface ChromeContextMenusService {
  /**
   * Adds a menu item and resolves to its id once Chrome confirms it, failing when Chrome
   * reports an error such as a duplicate id. Interrupting the wait does not undo a creation
   * Chrome has already started.
   */
  readonly create: (createProperties: CreateProperties) => Effect.Effect<MenuItemId, ChromeContextMenusError>
  readonly update: (id: MenuItemId, updateProperties: UpdateProperties) => Effect.Effect<void, ChromeContextMenusError>
  /** Removes an item and its children; fails when no such item exists. */
  readonly remove: (menuItemId: MenuItemId) => Effect.Effect<void, ChromeContextMenusError>
  /** Removes every item this extension added. */
  readonly removeAll: Effect.Effect<void, ChromeContextMenusError>
  /**
   * Creates an item for the life of the current scope and removes it when the scope closes.
   * MV3 menus persist across service-worker restarts, so menus that always exist belong in
   * `runtime.onInstalled` via `create`; this form suits menus owned by a page or session.
   * Removal on release is best effort: an item already gone (say, after `removeAll`) is ignored,
   * and Chrome may stop a worker without running finalizers at all.
   */
  readonly item: (createProperties: CreateProperties) => Effect.Effect<MenuItemId, ChromeContextMenusError, Scope.Scope>
  /**
   * An observational subscription that cannot wake an MV3 service worker; register the wake
   * listener through `ChromeServiceWorker.listen(chrome.contextMenus.onClicked, ...)`. Buffers
   * at most 64 events, dropping the oldest.
   */
  readonly onClicked: Stream.Stream<ClickedEvent, ChromeContextMenusError>
}

export class ChromeContextMenus extends Context.Service<ChromeContextMenus, ChromeContextMenusService>()(
  "effect-platform-chrome/ChromeContextMenus"
) {}

const fail = (operation: string) => (cause: unknown) => new ChromeContextMenusError({ operation, cause })

const invoke = invoker((operation, cause) => new ChromeContextMenusError({ operation, cause }))

/** Bridges the callback-only `create`, whose callback may in principle run before it returns. */
const createItem = (api: ChromeContextMenusApi, createProperties: CreateProperties) =>
  Effect.callback<MenuItemId, ChromeContextMenusError>((resume) => {
    let id = Option.none<MenuItemId>()
    let confirmed = false

    try {
      const returned = api.create(createProperties, () => {
        // Chrome only exposes lastError for the duration of this callback.
        const lastError = api.lastError

        if (lastError !== undefined) {
          resume(Effect.fail(fail("create")(lastError)))
        } else if (Option.isSome(id)) {
          resume(Effect.succeed(id.value))
        } else {
          confirmed = true
        }
      })

      id = Option.some(returned)

      if (confirmed) resume(Effect.succeed(returned))
    } catch (cause) {
      resume(Effect.fail(fail("create")(cause)))
    }
  })

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeContextMenusApi): ChromeContextMenusService => {
  const create = (createProperties: CreateProperties) => createItem(api, createProperties)
  const remove = (menuItemId: MenuItemId) => invoke("remove", () => api.remove(menuItemId))

  return ChromeContextMenus.of({
    create,
    update: (id, updateProperties) => invoke("update", () => api.update(id, updateProperties)),
    remove,
    removeAll: invoke("removeAll", () => api.removeAll()),
    item: (createProperties) => Effect.acquireRelease(create(createProperties), (id) => Effect.ignore(remove(id))),
    onClicked: observe(
      () => api.onClicked,
      (info, tab) => ({ info, tab: Option.fromNullishOr(tab) }),
      fail("onClicked")
    )
  })
}

export const layer = (api: ChromeContextMenusApi): Layer.Layer<ChromeContextMenus> =>
  Layer.succeed(ChromeContextMenus, make(api))

/** Joins `chrome.contextMenus` with a live view of `chrome.runtime.lastError`. */
const fromChrome = (chrome: typeof globalThis.chrome): ChromeContextMenusApi | undefined => {
  // The typings declare both namespaces, but they are absent without the permission or outside extensions.
  const contextMenus: typeof chrome.contextMenus | undefined = chrome.contextMenus
  const runtime: typeof chrome.runtime | undefined = chrome.runtime

  if (contextMenus === undefined || runtime === undefined) return undefined

  return {
    create: (createProperties, callback) => contextMenus.create(createProperties, callback),
    update: (id, updateProperties) => contextMenus.update(id, updateProperties),
    remove: (menuItemId) => contextMenus.remove(menuItemId),
    removeAll: () => contextMenus.removeAll(),
    onClicked: contextMenus.onClicked,
    get lastError() { return runtime.lastError }
  }
}

/** The globals are read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeContextMenus, ChromeContextMenusError> = liveLayer(
  ChromeContextMenus, "contextMenus", fromChrome, make,
  (cause) => new ChromeContextMenusError({ operation: "initialize", cause })
)
