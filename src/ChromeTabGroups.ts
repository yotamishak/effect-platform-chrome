import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeTabGroupsError extends Schema.TaggedError<ChromeTabGroupsError>()("ChromeTabGroupsError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

export type TabGroup = chrome.tabGroups.TabGroup

type GroupEvent = EventSource<[group: TabGroup]>

/** The Promise-based MV3 subset this module needs. */
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
 * ChromeTabs.ungroup; a group without tabs is deleted.
 */
export interface ChromeTabGroupsService {
  readonly get: (groupId: number) => Effect.Effect<TabGroup, ChromeTabGroupsError>
  readonly query: (queryInfo: chrome.tabGroups.QueryInfo) => Effect.Effect<Array<TabGroup>, ChromeTabGroupsError>
  /** Changes a group's title, color or collapsed state; None when Chrome reports no group. */
  readonly update: (
    groupId: number,
    updateProperties: chrome.tabGroups.UpdateProperties
  ) => Effect.Effect<Option.Option<TabGroup>, ChromeTabGroupsError>
  /**
   * Moves a group and its tabs to `index` (-1 for the end), optionally into another normal
   * window; None when Chrome reports no group.
   */
  readonly move: (
    groupId: number,
    moveProperties: chrome.tabGroups.MoveProperties
  ) => Effect.Effect<Option.Option<TabGroup>, ChromeTabGroupsError>
  /**
   * Observational subscriptions that cannot wake an MV3 service worker; register wake
   * listeners through ChromeServiceWorker. Each buffers at most 64 events, dropping the oldest.
   */
  readonly onCreated: Stream.Stream<TabGroup, ChromeTabGroupsError>
  readonly onUpdated: Stream.Stream<TabGroup, ChromeTabGroupsError>
  /** Groups closed directly by the user or emptied of tabs. */
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
