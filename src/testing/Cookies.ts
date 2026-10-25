import * as ChromeCookies from "../ChromeCookies.js"
import * as TestEvent from "./Event.js"

// Injected failures are raw rejection causes, as Chrome's would be.
/* oxlint-disable anti-slop/no-unknown-parameters */

export type CookiesOperation = "get" | "getAll" | "set" | "remove" | "getAllCookieStores" | "getPartitionKey"

/** A frame `getPartitionKey` can resolve: by tab and frame id (0 is the main frame), or by document id. */
export interface CookieFrame {
  readonly tabId: number
  readonly frameId: number
  readonly documentId?: string
}

const defaultStoreId = "0"

/** Chrome's identity for a cookie: two cookies differing in any of these coexist. */
const keyOf = (cookie: ChromeCookies.Cookie): string => JSON.stringify([
  cookie.storeId, cookie.name, cookie.domain, cookie.path,
  cookie.partitionKey === undefined ? null : [cookie.partitionKey.topLevelSite ?? null, cookie.partitionKey.hasCrossSiteAncestor ?? false]
])

const bareDomain = (domain: string): string => domain.replace(/^\./, "")

const domainMatches = (cookie: ChromeCookies.Cookie, host: string): boolean => {
  const domain = bareDomain(cookie.domain)

  return host === domain || (!cookie.hostOnly && host.endsWith(`.${domain}`))
}

/** RFC 6265 path-match. */
const pathMatches = (cookiePath: string, requestPath: string): boolean =>
  requestPath === cookiePath
  || (requestPath.startsWith(cookiePath) && (cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/"))

/** RFC 6265 default-path: the URL path up to, not including, its last slash. */
const defaultPath = (pathname: string): string => {
  const last = pathname.lastIndexOf("/")

  return last <= 0 ? "/" : pathname.slice(0, last)
}

const urlMatches = (cookie: ChromeCookies.Cookie, url: URL): boolean =>
  domainMatches(cookie, url.hostname) && pathMatches(cookie.path, url.pathname) && (!cookie.secure || url.protocol === "https:")

/**
 * Chrome's partition filter: omitted means unpartitioned cookies only, `{}` means every
 * partition, and a `topLevelSite` selects that partition.
 */
const partitionMatches = (cookie: ChromeCookies.Cookie, filter: ChromeCookies.CookiePartitionKey | undefined): boolean => {
  if (filter === undefined) return cookie.partitionKey === undefined

  if (filter.topLevelSite === undefined) return true

  return cookie.partitionKey?.topLevelSite === filter.topLevelSite
    && (filter.hasCrossSiteAncestor === undefined || (cookie.partitionKey.hasCrossSiteAncestor ?? false) === filter.hasCrossSiteAncestor)
}

/** Longest path first, then earliest created, as Chrome orders `get` and `getAll`. */
const byPath = (cookies: Array<ChromeCookies.Cookie>): Array<ChromeCookies.Cookie> =>
  cookies.sort((left, right) => right.path.length - left.path.length)

/**
 * An in-memory cookie jar keyed like Chrome's (store, name, domain, path, partition), with
 * Chrome's errors: an unparsable URL rejects with `Invalid url: "…".`, a store missing from
 * `getAllCookieStores` with `Invalid cookie store id: "…".`, and a cookie `set` cannot store
 * (a domain the URL cannot set, a secure or partitioned cookie on an insecure URL or
 * without `secure`) with `Failed to parse or set cookie named "…".`.
 *
 * `set` derives a host-only cookie from the URL unless `domain` is given and defaults the
 * path to the URL's directory; overwriting reports the old cookie removed with cause
 * `"overwrite"` before the new one, and a past `expirationDate` deletes the existing
 * cookie with cause `"expired_overwrite"` and resolves `undefined`. `get` and `getAll`
 * order longest path first, then earliest created; `get` resolves `null` when nothing
 * matches. `remove` deletes every same-named cookie a request to the URL would send and
 * resolves the normalized details. Time-based expiry is not simulated; `controls.drop`
 * emits expiry or eviction. `getPartitionKey` resolves frames added with
 * `controls.addFrame` and rejects for unknown ones. Every call can be failed once with
 * `controls.failNext`; pass `overrides` to replace any member.
 */
export const makeCookies = (overrides: Partial<ChromeCookies.ChromeCookiesApi> = {}) => {
  const jar = new Map<string, ChromeCookies.Cookie>()
  const changed = TestEvent.makeEvent<[chrome.cookies.CookieChangeInfo]>()
  const failures = new Map<CookiesOperation, Array<unknown>>()
  const frames: Array<readonly [CookieFrame, ChromeCookies.CookiePartitionKey]> = []
  let stores: Array<ChromeCookies.CookieStore> = [{ id: defaultStoreId, tabIds: [] }]

  const check = (operation: CookiesOperation) => {
    const queue = failures.get(operation)

    if (queue !== undefined && queue.length > 0) throw queue.shift()
  }

  const parseUrl = (url: string): URL => {
    if (!URL.canParse(url)) throw new Error(`Invalid url: "${url}".`)

    return new URL(url)
  }

  const storeOf = (storeId: string | undefined): string => {
    const id = storeId ?? defaultStoreId

    if (!stores.some((each) => each.id === id)) throw new Error(`Invalid cookie store id: "${id}".`)

    return id
  }

  const emit = (cookie: ChromeCookies.Cookie, removed: boolean, cause: ChromeCookies.ChangeCause) => {
    changed.controls.emit({ cookie: structuredClone(cookie), removed, cause })
  }

  const store = (cookie: ChromeCookies.Cookie, notify: boolean) => {
    const key = keyOf(cookie)
    const previous = jar.get(key)

    if (previous !== undefined && notify) emit(previous, true, "overwrite")

    // Map.set keeps an overwritten key's position, so creation order survives overwrites.
    jar.set(key, cookie)

    if (notify) emit(cookie, false, "explicit")
  }

  /** The cookie `details` describes, or null when Chrome would refuse to set it. */
  const build = (details: chrome.cookies.SetDetails, url: URL, storeId: string): ChromeCookies.Cookie | null => {
    const secure = details.secure ?? false
    const partitioned = details.partitionKey?.topLevelSite !== undefined

    if (secure && url.protocol !== "https:") return null

    if (partitioned && !secure) return null

    const domain = details.domain === undefined ? url.hostname : `.${bareDomain(details.domain)}`
    const hostOnly = details.domain === undefined

    const cookie: ChromeCookies.Cookie = {
      name: details.name ?? "", value: details.value ?? "", domain, hostOnly,
      path: details.path ?? defaultPath(url.pathname), secure, httpOnly: details.httpOnly ?? false,
      sameSite: details.sameSite ?? "unspecified", session: details.expirationDate === undefined, storeId
    }

    if (!domainMatches(cookie, url.hostname)) return null

    if (details.expirationDate !== undefined) cookie.expirationDate = details.expirationDate

    if (partitioned && details.partitionKey !== undefined) cookie.partitionKey = structuredClone(details.partitionKey)

    return cookie
  }

  /** Cookies a request to `details.url` would send with this name, longest path first. */
  const addressed = (details: ChromeCookies.CookieDetails): Array<ChromeCookies.Cookie> => {
    const url = parseUrl(details.url)
    const storeId = storeOf(details.storeId)

    return byPath(Array.from(jar.values()).filter((cookie) => cookie.name === details.name && cookie.storeId === storeId
      && urlMatches(cookie, url) && partitionMatches(cookie, details.partitionKey)))
  }

  const filtered = (filter: chrome.cookies.GetAllDetails): Array<ChromeCookies.Cookie> => {
    const url = filter.url === undefined ? undefined : parseUrl(filter.url)
    const domain = filter.domain === undefined ? undefined : bareDomain(filter.domain)
    const storeId = storeOf(filter.storeId)

    return byPath(Array.from(jar.values()).filter((cookie) =>
      cookie.storeId === storeId
      && partitionMatches(cookie, filter.partitionKey)
      && (url === undefined || urlMatches(cookie, url))
      && (domain === undefined || bareDomain(cookie.domain) === domain || bareDomain(cookie.domain).endsWith(`.${domain}`))
      && (filter.name === undefined || cookie.name === filter.name)
      && (filter.path === undefined || cookie.path === filter.path)
      && (filter.secure === undefined || cookie.secure === filter.secure)
      && (filter.session === undefined || cookie.session === filter.session)))
  }

  const frameMatches = (frame: CookieFrame, details: ChromeCookies.FrameDetails): boolean =>
    (details.documentId === undefined || frame.documentId === details.documentId)
    && (details.tabId === undefined || frame.tabId === details.tabId)
    && (details.frameId === undefined ? details.documentId !== undefined || frame.frameId === 0 : frame.frameId === details.frameId)

  const api: ChromeCookies.ChromeCookiesApi = {
    get: async (details) => {
      check("get")
      const [first] = addressed(details)

      return first === undefined ? null : structuredClone(first)
    },
    getAll: async (details) => {
      check("getAll")

      return structuredClone(filtered(details))
    },
    set: async (details) => {
      check("set")
      const url = parseUrl(details.url)
      const cookie = build(details, url, storeOf(details.storeId))

      if (cookie === null) throw new Error(`Failed to parse or set cookie named "${details.name ?? ""}".`)

      if (cookie.expirationDate !== undefined && cookie.expirationDate * 1000 <= Date.now()) {
        const key = keyOf(cookie)
        const previous = jar.get(key)

        if (previous !== undefined) {
          jar.delete(key)
          emit(previous, true, "expired_overwrite")
        }

        return undefined
      }

      store(cookie, true)

      return structuredClone(cookie)
    },
    remove: async (details) => {
      check("remove")

      for (const cookie of addressed(details)) {
        jar.delete(keyOf(cookie))
        emit(cookie, true, "explicit")
      }

      const removed: ChromeCookies.CookieDetails = { url: parseUrl(details.url).href, name: details.name, storeId: storeOf(details.storeId) }

      if (details.partitionKey !== undefined) removed.partitionKey = structuredClone(details.partitionKey)

      return removed
    },
    getAllCookieStores: async () => {
      check("getAllCookieStores")

      return structuredClone(stores)
    },
    getPartitionKey: async (details) => {
      check("getPartitionKey")

      if (details.tabId === undefined && details.documentId === undefined) throw new Error("Either tabId or documentId must be given.")

      const found = frames.find(([frame]) => frameMatches(frame, details))

      if (found === undefined) throw new Error(`No frame matches ${JSON.stringify(details)}.`)

      return { partitionKey: structuredClone(found[1]) }
    },
    onChanged: changed.api,
    ...overrides
  }

  return {
    api,
    layer: ChromeCookies.layer(api),
    controls: {
      onChanged: changed.controls,
      /**
       * Stores a cookie as `set` would, without emitting or checking its expiry; returns
       * it, or null if `set` would refuse it. Throws Chrome's error for an invalid URL or store.
       */
      seed: (details: chrome.cookies.SetDetails): ChromeCookies.Cookie | null => {
        const cookie = build(details, parseUrl(details.url), storeOf(details.storeId))

        if (cookie !== null) store(cookie, false)

        return cookie === null ? null : structuredClone(cookie)
      },
      /** A snapshot of every cookie in every store and partition, in creation order. */
      cookies: (): Array<ChromeCookies.Cookie> => structuredClone(Array.from(jar.values())),
      /** Removes a stored cookie as Chrome's expiry or eviction would, emitting that cause. */
      drop: (cookie: ChromeCookies.Cookie, cause: "expired" | "evicted"): boolean => {
        const key = keyOf(cookie)
        const stored = jar.get(key)

        if (stored === undefined) return false

        jar.delete(key)
        emit(stored, true, cause)

        return true
      },
      /** Replaces the stores `getAllCookieStores` reports and the other calls accept, such as an incognito store with its tabs. */
      setStores: (next: ReadonlyArray<ChromeCookies.CookieStore>) => { stores = structuredClone(Array.from(next)) },
      /** Makes `getPartitionKey` resolve `partitionKey` for this frame; the first added match wins. */
      addFrame: (frame: CookieFrame, partitionKey: ChromeCookies.CookiePartitionKey) => {
        frames.push([structuredClone(frame), structuredClone(partitionKey)])
      },
      failNext: (operation: CookiesOperation, cause: unknown) => {
        const queue = failures.get(operation) ?? []
        queue.push(cause)
        failures.set(operation, queue)
      }
    }
  }
}
