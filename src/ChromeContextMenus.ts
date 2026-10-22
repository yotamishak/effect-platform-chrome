import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeContextMenusError extends Schema.TaggedError<ChromeContextMenusError>()("ChromeContextMenusError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/**
 * A menu item id: the caller's string, or a number Chrome generated. Chrome keeps the two
 * apart, so the string `"1"` and the number `1` name different items.
 */
export type MenuItemId = number | string

/** Where an item appears; `"all"` means every context except `"launcher"`, which only packaged apps may use. */
export type ContextType = `${chrome.contextMenus.ContextType}`

/** `"normal"` (the default), `"checkbox"`, `"radio"` or `"separator"`. */
export type ItemType = `${chrome.contextMenus.ItemType}`

export type CreateProperties = chrome.contextMenus.CreateProperties

/** The fields to change; every field is optional, and fields left out keep their value. */
export type UpdateProperties = Omit<chrome.contextMenus.CreateProperties, "id">

export type OnClickData = chrome.contextMenus.OnClickData

export interface ClickedEvent {
  readonly info: OnClickData
  /** The tab where the click happened; absent outside a tab, such as for platform apps. */
  readonly tab: Option.Option<chrome.tabs.Tab>
}

/**
 * The most top-level items Chrome shows in the extension's action (toolbar icon) menu,
 * mirroring `chrome.contextMenus.ACTION_MENU_TOP_LEVEL_LIMIT`. Chrome ignores the rest
 * without reporting an error.
 */
export const ACTION_MENU_TOP_LEVEL_LIMIT: typeof chrome.contextMenus.ACTION_MENU_TOP_LEVEL_LIMIT = 6

/**
 * The MV3 subset this module needs. `create` has no Promise form: it returns the id at once
 * and reports failure (a duplicate id, an unknown parent) only through `lastError` while its
 * callback runs, so `lastError` is part of this interface rather than read from a global.
 * `update`, `remove` and `removeAll` are Promise-based here; `layerLive` builds them on
 * Chrome's callback forms, so they also work before Chrome 123 added Promise forms.
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
   * Adds a menu item and resolves to its id once Chrome confirms it: the `id` given, or a
   * number Chrome generated. Fails with what Chrome reports, synchronously or through
   * `lastError`: a duplicate id, an unknown or non-`"normal"` parent, a missing title on a
   * non-separator, a `"launcher"` context, an extension that already has 1000 top-level items
   * (which blocks child items too), and, in an extension with a service worker or event page,
   * a missing `id` or any `onclick` (listen to `onClicked` instead). Interrupting the wait does
   * not undo a creation Chrome has already started.
   */
  readonly create: (createProperties: CreateProperties) => Effect.Effect<MenuItemId, ChromeContextMenusError>
  /**
   * Changes the given fields of an item; fails for an unknown id, an empty title on a
   * non-separator, `checked: true` on an item that is not a checkbox or radio, a `"launcher"`
   * context, or an unknown or non-`"normal"` parent. Chrome applies fields one at a time, so a
   * failure can leave earlier fields changed, and it ignores, without failing, a `parentId`
   * that is the item itself or one of its descendants. A moved item becomes its new parent's
   * last child; `parentId` cannot move an item back to the top level.
   */
  readonly update: (id: MenuItemId, updateProperties: UpdateProperties) => Effect.Effect<void, ChromeContextMenusError>
  /** Removes an item and its descendants; fails when no such item exists. */
  readonly remove: (menuItemId: MenuItemId) => Effect.Effect<void, ChromeContextMenusError>
  /** Removes every item this extension added. */
  readonly removeAll: Effect.Effect<void, ChromeContextMenusError>
  /**
   * Creates an item for the life of the current scope and removes it when the scope closes.
   * MV3 menus persist across service-worker restarts, so menus that always exist belong in
   * `runtime.onInstalled` via `create`; this form suits menus owned by a page or session.
   * Interrupting the creation waits for Chrome's confirmation, so an item Chrome created is
   * always removed again. Removal on release is best effort: its failure is ignored (an item
   * already gone, say after `removeAll`), it removes whatever then has the id, and Chrome may
   * stop a worker without running finalizers at all.
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

const createFailure = fail("create")

/**
 * Bridges the callback-only `create`. Chrome runs the callback after `create` returns, but an
 * injected API may run it first, and a failure reading `lastError` must still settle the call.
 */
const createItem = (api: ChromeContextMenusApi, createProperties: CreateProperties) =>
  Effect.callback<MenuItemId, ChromeContextMenusError>((resume) => {
    let id = Option.none<MenuItemId>()
    let confirmed = false

    const callback = () => {
      let lastError: chrome.runtime.LastError | undefined

      try {
        // Chrome only exposes lastError for the duration of this callback.
        lastError = api.lastError
      } catch (cause) {
        resume(Effect.fail(createFailure(cause)))

        return
      }

      if (lastError !== undefined) {
        resume(Effect.fail(createFailure(lastError)))
      } else if (Option.isSome(id)) {
        resume(Effect.succeed(id.value))
      } else {
        confirmed = true
      }
    }

    try {
      const returned = api.create(createProperties, callback)
      id = Option.some(returned)

      if (confirmed) resume(Effect.succeed(returned))
    } catch (cause) {
      resume(Effect.fail(createFailure(cause)))
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

/**
 * Joins `chrome.contextMenus` with a live view of `chrome.runtime.lastError`. `update`, `remove`
 * and `removeAll` use Chrome's callback forms, which every MV3 Chrome has (the Promise forms
 * need Chrome 123), and reject with the `lastError` Chrome reports, unchanged, like `create`.
 */
const fromChrome = (chrome: typeof globalThis.chrome): ChromeContextMenusApi | undefined => {
  // The typings declare both namespaces, but they are absent without the permission or outside extensions.
  const contextMenus: typeof chrome.contextMenus | undefined = chrome.contextMenus
  const runtime: typeof chrome.runtime | undefined = chrome.runtime

  if (contextMenus === undefined || runtime === undefined) return undefined

  /** Settles a callback-form call; Chrome exposes lastError only while the callback runs. */
  const settle = (call: (callback: () => void) => void) => new Promise<void>((resolve, reject) => {
    call(() => {
      try {
        const lastError = runtime.lastError

        if (lastError === undefined) {
          resolve()
        } else {
          // Chrome's lastError object, unchanged, is the cause, as for create.
          reject(lastError)
        }
      } catch (cause) {
        reject(cause)
      }
    })
  })

  return {
    create: (createProperties, callback) => contextMenus.create(createProperties, callback),
    update: (id, updateProperties) => settle((callback) => contextMenus.update(id, updateProperties, callback)),
    remove: (menuItemId) => settle((callback) => contextMenus.remove(menuItemId, callback)),
    removeAll: () => settle((callback) => contextMenus.removeAll(callback)),
    get onClicked() { return contextMenus.onClicked },
    get lastError() { return runtime.lastError }
  }
}

/** The globals are read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeContextMenus, ChromeContextMenusError> = liveLayer(
  ChromeContextMenus, "contextMenus", fromChrome, make,
  (cause) => new ChromeContextMenusError({ operation: "initialize", cause })
)
