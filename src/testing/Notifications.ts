import * as ChromeNotifications from "../ChromeNotifications.js"
import * as TestEvent from "./Event.js"

type Options = chrome.notifications.NotificationOptions

/**
 * In-memory notifications. `create` stores (or replaces) one, generating `notification-<n>`
 * when the id is missing or empty; `update` merges fields into a showing one; `clear`
 * removes one and fires onClosed with `byUser` false; `getAll` lists the showing ids. The
 * permission level starts as "granted" and only changes through `controls`; it does not
 * gate `create`. User actions are simulated through `controls`, which return the
 * exceptions thrown by listeners. Pass `overrides` to replace any API member.
 */
export const makeNotifications = (overrides: Partial<ChromeNotifications.ChromeNotificationsApi> = {}) => {
  const notifications = new Map<string, Options>()
  const clicked = TestEvent.makeEvent<[string]>()
  const buttonClicked = TestEvent.makeEvent<[string, number]>()
  const closed = TestEvent.makeEvent<[string, boolean]>()
  const permissionLevelChanged = TestEvent.makeEvent<[ChromeNotifications.PermissionLevel]>()
  let permissionLevel: ChromeNotifications.PermissionLevel = "granted"
  let nextId = 1

  const show = (notificationId: string, options: chrome.notifications.NotificationCreateOptions): string => {
    const id = notificationId === "" ? `notification-${nextId++}` : notificationId
    notifications.set(id, structuredClone(options))

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

  const create: ChromeNotifications.ChromeNotificationsApi["create"] = async (
    ...args: [string, chrome.notifications.NotificationCreateOptions] | [chrome.notifications.NotificationCreateOptions]
  ) => args.length === 1 ? show("", args[0]) : show(args[0], args[1])

  const api: ChromeNotifications.ChromeNotificationsApi = {
    create,
    update: async (notificationId, options) => {
      const notification = notifications.get(notificationId)

      if (notification === undefined) return false

      notifications.set(notificationId, { ...notification, ...structuredClone(options) })

      return true
    },
    clear: async (notificationId) => {
      if (!notifications.has(notificationId)) return false

      close(notificationId, false)

      return true
    },
    getAll: async () => Object.fromEntries(Array.from(notifications.keys(), (id) => [id, true] as const)),
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
      /** The showing notification's current options, if any. */
      notification: (notificationId: string): Options | undefined => notifications.get(notificationId),
      /** The user clicks the body of a showing notification; it stays open, as in Chrome. */
      click: (notificationId: string): ReadonlyArray<unknown> => {
        find(notificationId)

        return clicked.controls.emit(notificationId)
      },
      /** The user presses one of the notification's `buttons`, by zero-based index. */
      clickButton: (notificationId: string, buttonIndex: number): ReadonlyArray<unknown> => {
        const buttons = find(notificationId).buttons ?? []

        if (buttonIndex < 0 || buttonIndex >= buttons.length) {
          throw new Error(`Notification ${notificationId} has no button ${buttonIndex}`)
        }

        return buttonClicked.controls.emit(notificationId, buttonIndex)
      },
      /** The notification closes: dismissed by the user by default, or by the system. */
      close: (notificationId: string, byUser = true): ReadonlyArray<unknown> => {
        find(notificationId)

        return close(notificationId, byUser)
      },
      /** Changes the permission level, firing onPermissionLevelChanged when it differs. */
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
