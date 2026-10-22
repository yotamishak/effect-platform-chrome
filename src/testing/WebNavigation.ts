import * as ChromeWebNavigation from "../ChromeWebNavigation.js"
import * as TestEvent from "./Event.js"

/** Keys Chrome supports but this fixture cannot evaluate faithfully (RE2 and CIDR matching). */
const unsupportedKeys = ["urlMatches", "originAndPathMatches", "cidrBlocks"] as const

const hostname = (value: string): string => value.startsWith(".") ? value : `.${value}`

const conditionMatches = (condition: chrome.events.UrlFilter, url: URL): boolean => {
  // Chrome compares hosts with an implicit leading dot, so "example.com" equals ".example.com".
  const host = `.${url.hostname}`
  const withoutFragment = new URL(url.href)
  withoutFragment.hash = ""
  const full = withoutFragment.href
  const query = url.search.slice(1)

  const checks: ReadonlyArray<readonly [string | undefined, (value: string) => boolean]> = [
    [condition.hostEquals, (value) => host === hostname(value)],
    [condition.hostPrefix, (value) => host.startsWith(hostname(value))],
    [condition.hostSuffix, (value) => host.endsWith(value)],
    [condition.hostContains, (value) => host.includes(value)],
    [condition.urlEquals, (value) => full === value],
    [condition.urlPrefix, (value) => full.startsWith(value)],
    [condition.urlSuffix, (value) => full.endsWith(value)],
    [condition.urlContains, (value) => full.includes(value)],
    [condition.pathEquals, (value) => url.pathname === value],
    [condition.pathPrefix, (value) => url.pathname.startsWith(value)],
    [condition.pathSuffix, (value) => url.pathname.endsWith(value)],
    [condition.pathContains, (value) => url.pathname.includes(value)],
    [condition.queryEquals, (value) => query === value],
    [condition.queryPrefix, (value) => query.startsWith(value)],
    [condition.querySuffix, (value) => query.endsWith(value)],
    [condition.queryContains, (value) => query.includes(value)]
  ]

  return checks.every(([value, check]) => value === undefined || check(value))
}

/**
 * Whether Chrome would deliver an event for `url` to a listener registered with `filter`.
 * A filter matches when any `url` condition does, and a condition when all its keys do; no
 * filter, or an empty condition list, matches everything. Honoured keys: `hostEquals`,
 * `hostPrefix`, `hostSuffix`, `hostContains` (hosts carry Chrome's implicit leading dot),
 * `urlEquals`, `urlPrefix`, `urlSuffix`, `urlContains` (fragment removed, default port
 * dropped), and the `path*` and `query*` families. `schemes` and `ports` are ignored, as
 * Chrome ignores them for webNavigation. URLs that do not parse match no condition.
 */
export const matchesNavigationFilter = (filter: ChromeWebNavigation.NavigationFilter | undefined, url: string): boolean => {
  if (filter === undefined || filter.url.length === 0) return true

  if (!URL.canParse(url)) return false

  const parsed = new URL(url)

  return filter.url.some((condition) => conditionMatches(condition, parsed))
}

const assertSupported = (filter: ChromeWebNavigation.NavigationFilter | undefined) => {
  for (const condition of filter?.url ?? []) {
    for (const key of unsupportedKeys) {
      if (condition[key] !== undefined) throw new Error(`UrlFilter.${key} is not simulated by the webNavigation fixture`)
    }
  }
}

/**
 * A filterable event over `makeEvent`: each listener is registered with its filter and
 * receives only events whose URL matches it. Filters using `urlMatches`,
 * `originAndPathMatches` or `cidrBlocks` throw from `addListener` rather than misbehave.
 */
const makeFilterableEvent = <Details extends { readonly url: string }>() => {
  const event = TestEvent.makeEvent<[Details]>()
  const registered = new Map<(details: Details) => void, (details: Details) => void>()
  const filters: Array<ChromeWebNavigation.NavigationFilter | undefined> = []

  const api: ChromeWebNavigation.FilterableEvent<[Details]> = {
    addListener: (listener, filter) => {
      assertSupported(filter)

      if (registered.has(listener)) return

      const filtered = (details: Details) => {
        if (matchesNavigationFilter(filter, details.url)) listener(details)
      }

      event.api.addListener(filtered)
      registered.set(listener, filtered)
      filters.push(filter)
    },
    removeListener: (listener) => {
      const filtered = registered.get(listener)

      if (filtered === undefined) return

      event.api.removeListener(filtered)
      registered.delete(listener)
    }
  }

  return {
    api,
    controls: {
      ...event.controls,
      /** Every filter passed to `addListener`, in order; `undefined` when none was given. */
      filters
    }
  }
}

/** Options for a simulated cross-document navigation. */
export interface NavigateOptions {
  readonly frameId?: number
  readonly transitionType?: ChromeWebNavigation.Navigation["transitionType"]
  readonly transitionQualifiers?: ChromeWebNavigation.Navigation["transitionQualifiers"]
}

/**
 * In-memory frames per tab and filter-aware webNavigation events. Seed frames with
 * `controls.addFrame`, then drive `navigate` (onBeforeNavigate, onCommitted,
 * onDOMContentLoaded, onCompleted) or `failNavigation` (onBeforeNavigate, onErrorOccurred).
 * Each listener receives only events matching its filter; see `matchesNavigationFilter` for
 * the honoured UrlFilter keys. Timestamps come from a counter, not the wall clock, and
 * document ids are `document-<n>`. Pass `overrides` to replace any API member.
 */
export const makeWebNavigation = (overrides: Partial<ChromeWebNavigation.ChromeWebNavigationApi> = {}) => {
  const tabs = new Map<number, Map<number, ChromeWebNavigation.Frame>>()
  const beforeNavigate = makeFilterableEvent<ChromeWebNavigation.NavigationStart>()
  const committed = makeFilterableEvent<ChromeWebNavigation.Navigation>()
  const domContentLoaded = makeFilterableEvent<ChromeWebNavigation.DocumentLoad>()
  const completed = makeFilterableEvent<ChromeWebNavigation.DocumentLoad>()
  const errorOccurred = makeFilterableEvent<ChromeWebNavigation.NavigationFailure>()
  const createdNavigationTarget = makeFilterableEvent<ChromeWebNavigation.NavigationTarget>()
  const referenceFragmentUpdated = makeFilterableEvent<ChromeWebNavigation.Navigation>()
  const historyStateUpdated = makeFilterableEvent<ChromeWebNavigation.Navigation>()
  const tabReplaced = TestEvent.makeEvent<[ChromeWebNavigation.TabReplacement]>()
  let clock = 0
  let documents = 0

  const nextDocument = () => `document-${++documents}`

  const frameOf = (tabId: number, frameId: number): ChromeWebNavigation.Frame => {
    const frame = tabs.get(tabId)?.get(frameId)

    if (frame === undefined) throw new Error(`No frame ${frameId} in tab ${tabId}; add it with controls.addFrame first.`)

    return frame
  }

  const addFrame = (tabId: number, properties: Partial<ChromeWebNavigation.Frame> = {}): ChromeWebNavigation.Frame => {
    const frameId = properties.frameId ?? 0

    const frame: ChromeWebNavigation.Frame = {
      frameId,
      parentFrameId: frameId === 0 ? -1 : 0,
      processId: 1,
      url: "about:blank",
      documentId: nextDocument(),
      documentLifecycle: "active",
      errorOccurred: false,
      frameType: frameId === 0 ? "outermost_frame" : "sub_frame",
      ...properties
    }

    const frames = tabs.get(tabId) ?? new Map<number, ChromeWebNavigation.Frame>()
    frames.set(frameId, frame)
    tabs.set(tabId, frames)

    return structuredClone(frame)
  }

  const start = (tabId: number, frame: ChromeWebNavigation.Frame, url: string): ChromeWebNavigation.NavigationStart => {
    const details: ChromeWebNavigation.NavigationStart = {
      tabId, frameId: frame.frameId, parentFrameId: frame.parentFrameId, url, timeStamp: ++clock,
      // Chrome reports no renderer process before the navigation commits.
      processId: -1, documentLifecycle: frame.documentLifecycle, frameType: frame.frameType
    }

    if (frame.parentDocumentId !== undefined) details.parentDocumentId = frame.parentDocumentId

    beforeNavigate.controls.emit(details)

    return details
  }

  const document = (tabId: number, frame: ChromeWebNavigation.Frame): ChromeWebNavigation.DocumentLoad => {
    const details: ChromeWebNavigation.DocumentLoad = {
      tabId, frameId: frame.frameId, parentFrameId: frame.parentFrameId, url: frame.url, timeStamp: ++clock,
      processId: frame.processId, documentId: frame.documentId, documentLifecycle: frame.documentLifecycle,
      frameType: frame.frameType
    }

    if (frame.parentDocumentId !== undefined) details.parentDocumentId = frame.parentDocumentId

    return details
  }

  const api: ChromeWebNavigation.ChromeWebNavigationApi = {
    getAllFrames: async ({ tabId }) => {
      const frames = tabs.get(tabId)

      return frames === undefined ? null : Array.from(frames.values(), (frame) => structuredClone(frame))
    },
    getFrame: async (details) => {
      // A document id is validated against any tab and frame ids given alongside it.
      const frame = details.documentId === undefined
        ? tabs.get(details.tabId ?? -1)?.get(details.frameId ?? -1)
        : Array.from(tabs, ([tabId, frames]) => Array.from(frames.values()).filter((frame) =>
          frame.documentId === details.documentId
          && (details.tabId === undefined || details.tabId === tabId)
          && (details.frameId === undefined || details.frameId === frame.frameId))).flat()[0]

      if (frame === undefined) return null

      const { frameId: _frameId, processId: _processId, ...info } = structuredClone(frame)

      return info
    },
    onBeforeNavigate: beforeNavigate.api,
    onCommitted: committed.api,
    onDOMContentLoaded: domContentLoaded.api,
    onCompleted: completed.api,
    onErrorOccurred: errorOccurred.api,
    onCreatedNavigationTarget: createdNavigationTarget.api,
    onReferenceFragmentUpdated: referenceFragmentUpdated.api,
    onHistoryStateUpdated: historyStateUpdated.api,
    onTabReplaced: tabReplaced.api,
    ...overrides
  }

  return {
    api,
    layer: ChromeWebNavigation.layer(api),
    controls: {
      /** Adds or replaces a frame (top frame by default) and returns it. */
      addFrame,
      frame: (tabId: number, frameId = 0): ChromeWebNavigation.Frame | undefined => tabs.get(tabId)?.get(frameId),
      /** Forgets a closed tab's frames; `getAllFrames` then resolves to null, as Chrome does. */
      removeTab: (tabId: number) => { tabs.delete(tabId) },
      /**
       * Navigates a frame to a new document, emitting onBeforeNavigate, onCommitted,
       * onDOMContentLoaded and onCompleted in order. A tab's missing top frame is created;
       * subframes must be added first. Returns the committed details.
       */
      navigate: (tabId: number, url: string, options: NavigateOptions = {}): ChromeWebNavigation.Navigation => {
        const frameId = options.frameId ?? 0

        if (frameId === 0 && tabs.get(tabId)?.get(0) === undefined) addFrame(tabId)

        const current = frameOf(tabId, frameId)
        start(tabId, current, url)
        current.url = url
        current.documentId = nextDocument()
        current.errorOccurred = false

        const navigation: ChromeWebNavigation.Navigation = {
          ...document(tabId, current),
          transitionType: options.transitionType ?? (frameId === 0 ? "link" : "auto_subframe"),
          transitionQualifiers: options.transitionQualifiers ?? []
        }

        committed.controls.emit(navigation)
        domContentLoaded.controls.emit(document(tabId, current))
        completed.controls.emit(document(tabId, current))

        return navigation
      },
      /**
       * Emits onBeforeNavigate then onErrorOccurred for a navigation that never commits.
       * The frame keeps its URL and document, and `errorOccurred` becomes true.
       */
      failNavigation: (tabId: number, url: string, error = "net::ERR_FAILED", frameId = 0): ChromeWebNavigation.NavigationFailure => {
        const current = frameOf(tabId, frameId)
        start(tabId, current, url)
        current.errorOccurred = true

        const failure: ChromeWebNavigation.NavigationFailure = { ...document(tabId, current), url, error }
        errorOccurred.controls.emit(failure)

        return failure
      },
      /** Moves the replaced tab's frames to `tabId` and emits onTabReplaced. */
      replaceTab: (replacedTabId: number, tabId: number): ChromeWebNavigation.TabReplacement => {
        const frames = tabs.get(replacedTabId)
        tabs.delete(replacedTabId)

        if (frames !== undefined) tabs.set(tabId, frames)

        const replacement = { replacedTabId, tabId, timeStamp: ++clock }
        tabReplaced.controls.emit(replacement)

        return replacement
      },
      onBeforeNavigate: beforeNavigate.controls,
      onCommitted: committed.controls,
      onDOMContentLoaded: domContentLoaded.controls,
      onCompleted: completed.controls,
      onErrorOccurred: errorOccurred.controls,
      onCreatedNavigationTarget: createdNavigationTarget.controls,
      onReferenceFragmentUpdated: referenceFragmentUpdated.controls,
      onHistoryStateUpdated: historyStateUpdated.controls,
      onTabReplaced: tabReplaced.controls
    }
  }
}
