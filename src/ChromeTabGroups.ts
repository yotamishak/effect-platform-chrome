import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeTabGroupsError extends Schema.TaggedError<ChromeTabGroupsError>()("ChromeTabGroupsError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** The `groupId` of a tab that belongs to no group (`chrome.tabGroups.TAB_GROUP_ID_NONE`). */
export const TAB_GROUP_ID_NONE: -1 = -1

export type Color = `${chrome.tabGroups.Color}`

/**
 * A tab group as Chrome reports it. `shared` is reported from Chrome 137 and absent before.
 * Chrome reports an untitled group with an empty `title`.
 */
export interface TabGroup extends Omit<chrome.tabGroups.TabGroup, "shared"> {
  /** Whether the group is shared; absent before Chrome 137. */
  shared?: boolean
}

type GroupEvent = EventSource<[group: TabGroup]>

/** The Promise-based MV3 subset this module needs (Chrome 90+). */
export interface ChromeTabGroupsApi {
  get(groupId: number): Promise<TabGroup>
  query(queryInfo: chrome.tabGroups.QueryInfo): Promise<Array<TabGroup>>
  update(groupId: number, updateProperties: chrome.tabGroups.UpdateProperties): Promise<TabGroup | undefined>
  move(groupId: number, moveProperties: chrome.tabGroups.MoveProperties): Promise<TabGroup | undefined>
  readonly onCreated: GroupEvent
  readonly onUpdated: GroupEvent
  readonly onRemoved: GroupEvent
  readonly onMoved: GroupEvent
}

/**
 * Tab groups are created and filled through ChromeTabs.group and emptied through
 * ChromeTabs.ungroup; a group without tabs is deleted. Group ids are unique within a browser
 * session. Chrome validates every argument: a negative `groupId`, an `index` below -1 or a
 * `windowId` below -2 fails before anything changes.
 */
export interface ChromeTabGroupsService {
  /** The group with this id; fails with `No group with id: <id>.` when there is none. */
  readonly get: (groupId: number) => Effect.Effect<TabGroup, ChromeTabGroupsError>
  /**
   * Groups in every window the extension can see (incognito ones only when allowed), the most
   * recently active window first, keeping those that match every given field; `{}` matches all.
   * Within a window Chrome lists groups in the order they joined it (created there or moved in
   * from another window), not in tab-strip order; sort by their tabs' indices when that order
   * matters. `title` is a pattern where `*` matches any run of characters, `?` matches zero or
   * one character and `\` makes the next character literal. `windowId` may be -2
   * (`WINDOW_ID_CURRENT`); `shared` needs Chrome 137+. Fails with `No current window`, whatever
   * the `windowId`, while no browser window is open (a service worker can outlive them).
   */
  readonly query: (queryInfo: chrome.tabGroups.QueryInfo) => Effect.Effect<Array<TabGroup>, ChromeTabGroupsError>
  /**
   * Changes a group's title, color or collapsed state; properties left out keep their values.
   * Chrome declares the resulting group optional, so a missing one is None. Like `move`, fails
   * with `Tabs cannot be edited right now (user may be dragging a tab).` during a tab drag.
   */
  readonly update: (
    groupId: number,
    updateProperties: chrome.tabGroups.UpdateProperties
  ) => Effect.Effect<Option.Option<TabGroup>, ChromeTabGroupsError>
  /**
   * Moves a group and its tabs to tab index `index` (-1 or past the end for the end), within
   * its window or into another normal window (`windowId`, -2 for the current one). Fails when
   * the index is inside another group or among pinned tabs. Chrome declares the resulting
   * group optional, so a missing one is None.
   */
  readonly move: (
    groupId: number,
    moveProperties: chrome.tabGroups.MoveProperties
  ) => Effect.Effect<Option.Option<TabGroup>, ChromeTabGroupsError>
  /**
   * Observational subscriptions that cannot wake an MV3 service worker; register wake
   * listeners through ChromeServiceWorker. Each buffers at most 64 events, dropping the oldest.
   * A group moved into another window is reported as created there.
   */
  readonly onCreated: Stream.Stream<TabGroup, ChromeTabGroupsError>
  /** Groups whose title, color or collapsed state was set, and groups moved in from another window. */
  readonly onUpdated: Stream.Stream<TabGroup, ChromeTabGroupsError>
  /** Groups closed directly by the user, emptied of tabs, or moved out to another window. */
  readonly onRemoved: Stream.Stream<TabGroup, ChromeTabGroupsError>
  /** Groups moved within a window; moves between windows are reported as removal and creation. */
  readonly onMoved: Stream.Stream<TabGroup, ChromeTabGroupsError>
}

export class ChromeTabGroups extends Context.Service<ChromeTabGroups, ChromeTabGroupsService>()(
  "effect-platform-chrome/ChromeTabGroups"
) {}

const invoke = invoker((operation, cause) => new ChromeTabGroupsError({ operation, cause }))

const groupEvents = (operation: string, getSource: () => GroupEvent): Stream.Stream<TabGroup, ChromeTabGroupsError> =>
  observe(getSource, (group) => group, (cause) => new ChromeTabGroupsError({ operation, cause }))

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeTabGroupsApi): ChromeTabGroupsService => ChromeTabGroups.of({
  get: (groupId) => invoke("get", () => api.get(groupId)),
  query: (queryInfo) => invoke("query", () => api.query(queryInfo)),
  update: (groupId, updateProperties) => invoke("update", () => api.update(groupId, updateProperties)).pipe(
    Effect.map(Option.fromNullishOr)
  ),
  move: (groupId, moveProperties) => invoke("move", () => api.move(groupId, moveProperties)).pipe(
    Effect.map(Option.fromNullishOr)
  ),
  onCreated: groupEvents("onCreated", () => api.onCreated),
  onUpdated: groupEvents("onUpdated", () => api.onUpdated),
  onRemoved: groupEvents("onRemoved", () => api.onRemoved),
  onMoved: groupEvents("onMoved", () => api.onMoved)
})

export const layer = (api: ChromeTabGroupsApi): Layer.Layer<ChromeTabGroups> => Layer.succeed(ChromeTabGroups, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeTabGroups, ChromeTabGroupsError> = liveLayer(
  ChromeTabGroups, "tabGroups", (chrome) => chrome.tabGroups, make,
  (cause) => new ChromeTabGroupsError({ operation: "initialize", cause })
)
