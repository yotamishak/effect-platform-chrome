import * as ChromeHistory from "../ChromeHistory.js"
import * as TestEvent from "./Event.js"

// Injected failures are raw rejection causes, as Chrome's would be.
/* oxlint-disable anti-slop/no-unknown-parameters */

export type HistoryOperation = "search" | "getVisits" | "addUrl" | "deleteUrl" | "deleteRange" | "deleteAll"

/** A visit recorded through `controls.seed` or `controls.visit`, as browsing or sync would record it. */
export interface HistoryVisit {
  readonly url: string
  /** Milliseconds since the epoch; defaults to the fixture's clock. */
  readonly visitTime?: number
  /** Replaces the page's title; a new page without one gets "". */
  readonly title?: string
  /** Defaults to `"link"`. */
  readonly transition?: ChromeHistory.TransitionType
  /** Defaults to `"0"`, no referrer. */
  readonly referringVisitId?: string
  /** Defaults to true; false simulates a visit synced from another device. */
  readonly isLocal?: boolean
}

interface Visit {
  readonly visitId: number
  readonly visitTime: number
  readonly transition: ChromeHistory.TransitionType
  readonly referringVisitId: string
  readonly isLocal: boolean
}

interface Page {
  readonly id: string
  readonly url: string
  title: string
  visits: Array<Visit>
}

const day = 24 * 60 * 60 * 1000

const defaultMaxResults = 100

/** Transitions Chrome's history search never reports (not main-frame, or keyword-generated). */
const hidden: ReadonlySet<ChromeHistory.TransitionType> = new Set(["auto_subframe", "manual_subframe", "keyword_generated"])

const fail = (message: string): never => { throw new Error(message) }

/** Chrome's canonical spelling of a URL, rejecting what `history` rejects. */
const canonical = (url: string): string => {
  if (!URL.canParse(url)) return fail("Url is invalid.")

  const parsed = new URL(url)

  return parsed.protocol === "isolated-app:" ? fail("Url is invalid.") : parsed.href
}

const words = (text: string): Array<string> => text.toLowerCase().split(/\s+/).filter((word) => word.length > 0)

/** Most recent first, the later-recorded visit first on a tie, as Chrome's visit queries order them. */
const recentFirst = (left: Visit, right: Visit): number => right.visitTime - left.visitTime || right.visitId - left.visitId

const item = (page: Page): ChromeHistory.HistoryItem => ({
  id: page.id,
  url: page.url,
  title: page.title,
  lastVisitTime: page.visits.reduce((latest, visit) => Math.max(latest, visit.visitTime), Number.NEGATIVE_INFINITY),
  visitCount: page.visits.length,
  typedCount: page.visits.filter((visit) => visit.transition === "typed").length
})

const visitItem = (page: Page, visit: Visit): ChromeHistory.VisitItem => ({
  id: page.id,
  visitId: String(visit.visitId),
  visitTime: visit.visitTime,
  referringVisitId: visit.referringVisitId,
  transition: visit.transition,
  isLocal: visit.isLocal
})

/**
 * An in-memory history of pages and their visits, keyed by canonical URL as Chrome keys them.
 * URL arguments that are invalid or `isolated-app:` reject with Chrome's "Url is invalid.";
 * while `controls.setDeletionAllowed(false)` is in effect, the delete calls reject with
 * "Browsing history is not allowed to be deleted." before checking their URL, as under the
 * AllowDeletingBrowserHistory policy.
 *
 * `search` returns one item per page whose most recent visible visit (not a subframe or
 * keyword-generated one) falls in `[startTime, endTime)`, most recent first. Without
 * `startTime` the range starts 24 hours before the fixture's clock, and without `endTime` it
 * ends at the clock, inclusive, so a visit recorded "now" is found; `maxResults` defaults to
 * 100, with 0 or less meaning no limit. Text matching approximates Chrome's: every whitespace-separated word of
 * `text` must appear in the URL or title, ignoring case. Items report every field, with
 * `visitCount` counting every visit and `typedCount` the `"typed"` ones. `getVisits` lists a
 * page's visits oldest first, and an unknown page has none.
 *
 * `addUrl` records a `"link"` visit at the fixture's clock and emits `onVisited`. `deleteUrl`
 * emits `onVisitRemoved` only when the page existed; `deleteRange` removes visits in
 * `[startTime, endTime)` and emits only when it removed one, listing the pages left without
 * visits; `deleteAll` always emits `allHistory`. Events are emitted synchronously before the
 * call resolves, and results are fresh copies. Ids count up from "1" and are never reused.
 * The clock is the wall clock unless `controls.setNow` pins it. Every call can be failed once
 * with `controls.failNext`; pass `overrides` to replace any member.
 */
export const makeHistory = (overrides: Partial<ChromeHistory.ChromeHistoryApi> = {}) => {
  const pages = new Map<string, Page>()
  const visited = TestEvent.makeEvent<[ChromeHistory.HistoryItem]>()
  const removed = TestEvent.makeEvent<[chrome.history.RemovedResult]>()
  const failures = new Map<HistoryOperation, Array<unknown>>()
  let pinned: number | undefined
  let deletionAllowed = true
  let nextPageId = 1
  let nextVisitId = 1

  const now = (): number => pinned ?? Date.now()

  const check = (operation: HistoryOperation) => {
    const queue = failures.get(operation)

    if (queue !== undefined && queue.length > 0) throw queue.shift()
  }

  const checkDeletion = () => {
    if (!deletionAllowed) fail("Browsing history is not allowed to be deleted.")
  }

  const record = (details: HistoryVisit): Page => {
    const url = canonical(details.url)
    const page = pages.get(url) ?? { id: String(nextPageId++), url, title: "", visits: [] }

    if (details.title !== undefined) page.title = details.title

    page.visits.push({
      visitId: nextVisitId++,
      visitTime: details.visitTime ?? now(),
      transition: details.transition ?? "link",
      referringVisitId: details.referringVisitId ?? "0",
      isLocal: details.isLocal ?? true
    })
    pages.set(url, page)

    return page
  }

  const emitRemoved = (allHistory: boolean, urls: Array<string>) => {
    removed.controls.emit({ allHistory, urls })
  }

  const api: ChromeHistory.ChromeHistoryApi = {
    search: async (query) => {
      check("search")
      const clock = now()
      const start = query.startTime ?? clock - day
      const { endTime } = query
      // Chrome's clock has moved on by the time it searches, so an open range keeps visits made "now".
      const beforeEnd = (time: number) => endTime === undefined ? time <= clock : time < endTime
      const limit = query.maxResults ?? defaultMaxResults
      const terms = words(query.text)

      const matches = Array.from(pages.values()).flatMap((page) => {
        const haystack = `${page.url} ${page.title}`.toLowerCase()

        if (!terms.every((term) => haystack.includes(term))) return []

        let latest: Visit | undefined

        for (const visit of page.visits) {
          if (hidden.has(visit.transition) || visit.visitTime < start || !beforeEnd(visit.visitTime)) continue

          if (latest === undefined || recentFirst(visit, latest) < 0) latest = visit
        }

        return latest === undefined ? [] : [{ page, latest }]
      }).sort((left, right) => recentFirst(left.latest, right.latest))

      return (limit > 0 ? matches.slice(0, limit) : matches).map(({ page }) => item(page))
    },
    getVisits: async (details) => {
      check("getVisits")
      const page = pages.get(canonical(details.url))

      return page === undefined ? [] : Array.from(page.visits).sort((left, right) => recentFirst(right, left)).map((visit) => visitItem(page, visit))
    },
    addUrl: async (details) => {
      check("addUrl")
      visited.controls.emit(item(record({ url: details.url })))
    },
    deleteUrl: async (details) => {
      check("deleteUrl")
      checkDeletion()
      const url = canonical(details.url)

      if (pages.delete(url)) emitRemoved(false, [url])
    },
    deleteRange: async (range) => {
      check("deleteRange")
      checkDeletion()
      const purged: Array<string> = []
      let count = 0

      for (const page of Array.from(pages.values())) {
        const kept = page.visits.filter((visit) => visit.visitTime < range.startTime || visit.visitTime >= range.endTime)
        count += page.visits.length - kept.length
        page.visits = kept

        if (kept.length === 0) {
          pages.delete(page.url)
          purged.push(page.url)
        }
      }

      if (count > 0) emitRemoved(false, purged)
    },
    deleteAll: async () => {
      check("deleteAll")
      checkDeletion()
      pages.clear()
      emitRemoved(true, [])
    },
    onVisited: visited.api,
    onVisitRemoved: removed.api,
    ...overrides
  }

  return {
    api,
    layer: ChromeHistory.layer(api),
    controls: {
      onVisited: visited.controls,
      onVisitRemoved: removed.controls,
      /** Records a visit without emitting, as history that predates the test; returns the page. */
      seed: (details: HistoryVisit): ChromeHistory.HistoryItem => item(record(details)),
      /** Records a visit as browsing would, emitting `onVisited`; returns the page. */
      visit: (details: HistoryVisit): ChromeHistory.HistoryItem => {
        const page = item(record(details))
        visited.controls.emit(structuredClone(page))

        return page
      },
      /** A snapshot of every page, in the order each was first visited. */
      pages: (): Array<ChromeHistory.HistoryItem> => Array.from(pages.values(), item),
      /** Pins the clock that `addUrl`, unspecified visit times and the default search range use; undefined restores the wall clock. */
      setNow: (time: number | undefined) => { pinned = time },
      /** Simulates the AllowDeletingBrowserHistory policy. */
      setDeletionAllowed: (allowed: boolean) => { deletionAllowed = allowed },
      failNext: (operation: HistoryOperation, cause: unknown) => {
        const queue = failures.get(operation) ?? []
        queue.push(cause)
        failures.set(operation, queue)
      }
    }
  }
}
