import * as ChromeNotifications from "../ChromeNotifications.js"
import * as TestEvent from "./Event.js"

type Options = ChromeNotifications.NotificationOptions

type CreateOptions = ChromeNotifications.NotificationCreateOptions

/** The messages Chrome rejects notification calls with. */
export const notificationErrors = {
  /** Every call but `getPermissionLevel` while the user has turned notifications off. */
  denied: "Unknown error.",
  missingRequired: "Some of the required properties are missing: type, iconUrl, title and message.",
  lowPriority: "Low-priority notifications are deprecated on this platform.",
  progressType: "The progress value should not be specified for non-progress notification",
  progressRange: "The progress value should range from 0 to 100",
  itemsType: "List items provided for notification type != list",
  imageType: "Image resource provided for notification type != image",
  idTooLong: "The notification's ID should be 500 characters or less"
} as const

/**
 * The message Chrome's bindings throw synchronously for a `priority` or `progress` that is not
 * an integer, without the leading invocation signature.
 */
export const notificationIntegerError = (property: "priority" | "progress"): string =>
  `Error at parameter 'options': Error at property '${property}': Invalid type: expected integer, found number.`

/** Chrome's longest notification id, counted in UTF-8 bytes. */
const maxIdBytes = 500

/** Chrome shows at most this many buttons and ignores the rest. */
const maxButtons = 2

const encoder = new TextEncoder()

const reject = (message: string): never => {
  throw new Error(message)
}

/** A detached copy without absent fields, as Chrome receives options. */
const present = <O extends Options>(options: O): O => {
  const copy = structuredClone(options)

  for (const [key, value] of Object.entries(copy)) {
    if (value === undefined) Reflect.deleteProperty(copy, key)
  }

  if (copy.buttons !== undefined && copy.buttons.length > maxButtons) copy.buttons = copy.buttons.slice(0, maxButtons)

  return copy
}

/** Chrome's bindings check argument types before the call starts, throwing synchronously. */
const checkIntegers = (options: Options) => {
  for (const property of ["priority", "progress"] as const) {
    const value = options[property]

    if (value !== undefined && !Number.isInteger(value)) throw new TypeError(notificationIntegerError(property))
  }
}

const checkPriority = (options: Options) => {
  if (options.priority !== undefined && options.priority < 0) reject(notificationErrors.lowPriority)
}

const checkProgress = (template: Options["type"], options: Options) => {
  if (options.progress === undefined) return

  if (template !== "progress") reject(notificationErrors.progressType)

  if (options.progress < 0 || options.progress > 100) reject(notificationErrors.progressRange)
}

const hasItems = (options: Options): boolean => options.items !== undefined && options.items.length > 0

/** Orders ids by code point, as Chrome's sorted UTF-8 id set does. */
const byCodePoint = (left: string, right: string): number => {
  const a = Array.from(left, (char) => char.codePointAt(0) ?? 0)
  const b = Array.from(right, (char) => char.codePointAt(0) ?? 0)

  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)

    if (difference !== 0) return difference
  }

  return a.length - b.length
}

/**
 * In-memory notifications with Chrome's checks, as observed in Chromium's implementation.
 *
 * - `create` shows a notification, replacing one with the same id in place without
 *   `onClosed`, and generates `notification-<n>` (skipping ids in use) when the id is missing
 *   or empty, where Chrome generates a UUID. It rejects with Chrome's messages
 *   (`notificationErrors`) a missing required field, a negative priority (as Chrome does
 *   outside ChromeOS), `progress` outside 0 to 100 or on another template, a `"list"`
 *   without `items` or `items` elsewhere, an `"image"` without `imageUrl` or `imageUrl`
 *   elsewhere, and an id over 500 UTF-8 bytes. Image URLs are not loaded.
 * - `update` resolves false for an unknown id; otherwise it checks the given fields against
 *   the resulting template, changing nothing when they are rejected, and merges them (empty
 *   `items` are ignored, as in Chrome).
 * - `clear` removes a showing notification and fires `onClosed` with `byUser` false, as
 *   Chrome's own notification center does.
 * - `getAll` lists showing ids sorted like Chrome's (integer-like ids first, as in any object).
 * - Absent (`undefined`) fields are dropped and buttons past the second are ignored, as
 *   Chrome does. A `priority` or `progress` that is not an integer makes `create` and
 *   `update` throw a `TypeError` synchronously (`notificationIntegerError`), as Chrome's
 *   bindings do; other argument types are left to TypeScript.
 * - The permission level starts as "granted". While it is "denied", every call except
 *   `getPermissionLevel` rejects with "Unknown error.", as Chrome does.
 *
 * User actions are simulated through `controls`, which return the exceptions thrown by
 * listeners. Pass `overrides` to replace any API member; `controls` keep acting on the
 * in-memory state.
 */
export const makeNotifications = (overrides: Partial<ChromeNotifications.ChromeNotificationsApi> = {}) => {
  const notifications = new Map<string, Options>()
  const clicked = TestEvent.makeEvent<[string]>()
  const buttonClicked = TestEvent.makeEvent<[string, number]>()
  const closed = TestEvent.makeEvent<[string, boolean]>()
  const permissionLevelChanged = TestEvent.makeEvent<[ChromeNotifications.PermissionLevel]>()
  let permissionLevel: ChromeNotifications.PermissionLevel = "granted"
  let nextId = 1

  const allowed = () => {
    if (permissionLevel === "denied") reject(notificationErrors.denied)
  }

  const generateId = (): string => {
    let id = `notification-${nextId++}`

    while (notifications.has(id)) id = `notification-${nextId++}`

    return id
  }

  const show = (notificationId: string, given: CreateOptions): string => {
    allowed()
    const options = present(given)

    // Chromium checks presence only; an empty string is a present field.
    if (options.type === undefined || options.iconUrl === undefined || options.title === undefined || options.message === undefined) {
      reject(notificationErrors.missingRequired)
    }

    checkPriority(options)

    if ((options.imageUrl !== undefined) !== (options.type === "image")) reject(notificationErrors.imageType)

    if (hasItems(options) !== (options.type === "list")) reject(notificationErrors.itemsType)
    checkProgress(options.type, options)

    const id = notificationId === "" ? generateId() : notificationId

    if (encoder.encode(id).length > maxIdBytes) reject(notificationErrors.idTooLong)

    notifications.set(id, options)

    return id
  }

  const find = (notificationId: string): Options => {
    const notification = notifications.get(notificationId)

    if (notification === undefined) throw new Error(`No notification is showing with id ${notificationId}`)

    return notification
  }

  const close = (notificationId: string, byUser: boolean) => {
    notifications.delete(notificationId)

    return closed.controls.emit(notificationId, byUser)
  }

  const showLater = async (notificationId: string, given: CreateOptions): Promise<string> => show(notificationId, given)

  const create: ChromeNotifications.ChromeNotificationsApi["create"] = (
    ...args: [string, CreateOptions] | [CreateOptions]
  ) => {
    const [notificationId, given] = args.length === 1 ? ["", args[0]] : args

    checkIntegers(given)

    return showLater(notificationId, given)
  }

  const change = async (notificationId: string, given: Options): Promise<boolean> => {
    allowed()
    const notification = notifications.get(notificationId)

    if (notification === undefined) return false

    const options = present(given)
    const template = options.type ?? notification.type

    checkPriority(options)

    if (options.imageUrl !== undefined && template !== "image") reject(notificationErrors.imageType)
    checkProgress(template, options)

    if (hasItems(options) && template !== "list") reject(notificationErrors.itemsType)

    if (options.items !== undefined && options.items.length === 0) delete options.items

    notifications.set(notificationId, { ...notification, ...options })

    return true
  }

  const api: ChromeNotifications.ChromeNotificationsApi = {
    create,
    update: (notificationId, given) => {
      checkIntegers(given)

      return change(notificationId, given)
    },
    clear: async (notificationId) => {
      allowed()

      if (!notifications.has(notificationId)) return false

      close(notificationId, false)

      return true
    },
    getAll: async () => {
      allowed()

      return Object.fromEntries(Array.from(notifications.keys()).sort(byCodePoint).map((id) => [id, true] as const))
    },
    getPermissionLevel: async () => permissionLevel,
    onClicked: clicked.api,
    onButtonClicked: buttonClicked.api,
    onClosed: closed.api,
    onPermissionLevelChanged: permissionLevelChanged.api,
    ...overrides
  }

  return {
    api,
    layer: ChromeNotifications.layer(api),
    controls: {
      /** A copy of the showing notification's current options, if any. */
      notification: (notificationId: string): Options | undefined => {
        const notification = notifications.get(notificationId)

        return notification === undefined ? undefined : structuredClone(notification)
      },
      /** The current permission level. */
      get permissionLevel(): ChromeNotifications.PermissionLevel { return permissionLevel },
      /** The user clicks the body of a showing notification; it stays open, as in Chrome. */
      click: (notificationId: string): ReadonlyArray<unknown> => {
        find(notificationId)

        return clicked.controls.emit(notificationId)
      },
      /** The user presses one of the notification's shown buttons, by zero-based index. */
      clickButton: (notificationId: string, buttonIndex: number): ReadonlyArray<unknown> => {
        const buttons = find(notificationId).buttons ?? []

        if (!Number.isInteger(buttonIndex) || buttonIndex < 0 || buttonIndex >= buttons.length) {
          throw new Error(`Notification ${notificationId} has no button ${buttonIndex}`)
        }

        return buttonClicked.controls.emit(notificationId, buttonIndex)
      },
      /** The notification closes: dismissed by the user by default, or by the system. */
      close: (notificationId: string, byUser = true): ReadonlyArray<unknown> => {
        find(notificationId)

        return close(notificationId, byUser)
      },
      /**
       * Changes the permission level, firing onPermissionLevelChanged when it differs. Showing
       * notifications stay; while denied, the API refuses calls.
       */
      setPermissionLevel: (level: ChromeNotifications.PermissionLevel): ReadonlyArray<unknown> => {
        if (level === permissionLevel) return []

        permissionLevel = level

        return permissionLevelChanged.controls.emit(level)
      },
      onClicked: clicked.controls,
      onButtonClicked: buttonClicked.controls,
      onClosed: closed.controls,
      onPermissionLevelChanged: permissionLevelChanged.controls
    }
  }
}
