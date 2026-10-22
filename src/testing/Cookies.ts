import * as ChromeCookies from "../ChromeCookies.js"
import * as TestEvent from "./Event.js"

// Injected failures are raw rejection causes, as Chrome's would be.
/* oxlint-disable anti-slop/no-unknown-parameters */

export type CookiesOperation = "get" | "getAll" | "set" | "remove" | "getAllCookieStores"

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
const partitionMatches = (cookie: ChromeCookies.Cookie, filter: chrome.cookies.CookiePartitionKey | undefined): boolean => {
  if (filter === undefined) return cookie.partitionKey === undefined

  if (filter.topLevelSite === undefined) return true

  return cookie.partitionKey?.topLevelSite === filter.topLevelSite
    && (filter.hasCrossSiteAncestor === undefined || (cookie.partitionKey.hasCrossSiteAncestor ?? false) === filter.hasCrossSiteAncestor)
}

/**
 * An in-memory cookie jar keyed like Chrome's (store, name, domain, path, partition).
 * `set` derives a host-only cookie from the URL unless `domain` is given, defaults the
 * path to the URL's directory, and returns null for a domain the URL cannot set or a
 * secure cookie on an insecure URL; overwriting reports the old cookie removed with
 * cause `"overwrite"` before the new one. `get` returns the longest-path match, earliest
 * created first. Expiry is not simulated; `controls.drop` emits expiry or eviction.
 * Every call can be failed once with `controls.failNext`; pass `overrides` to replace
 * any member.
 */
export const makeCookies = (overrides: Partial<ChromeCookies.ChromeCookiesApi> = {}) => {
  const jar = new Map<string, ChromeCookies.Cookie>()
  const changed = TestEvent.makeEvent<[chrome.cookies.CookieChangeInfo]>()
  const failures = new Map<CookiesOperation, Array<unknown>>()
  let stores: Array<ChromeCookies.CookieStore> = [{ id: defaultStoreId, tabIds: [] }]

  const check = (operation: CookiesOperation) => {
    const queue = failures.get(operation)

    if (queue !== undefined && queue.length > 0) throw queue.shift()
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

  const build = (details: chrome.cookies.SetDetails): ChromeCookies.Cookie | null => {
    const url = new URL(details.url)
    const secure = details.secure ?? false

    if (secure && url.protocol !== "https:") return null

    const domain = details.domain === undefined ? url.hostname : `.${bareDomain(details.domain)}`
    const hostOnly = details.domain === undefined

    const cookie: ChromeCookies.Cookie = {
      name: details.name ?? "", value: details.value ?? "", domain, hostOnly,
      path: details.path ?? defaultPath(url.pathname), secure, httpOnly: details.httpOnly ?? false,
      sameSite: details.sameSite ?? "unspecified", session: details.expirationDate === undefined,
      storeId: details.storeId ?? defaultStoreId
    }

    if (!domainMatches(cookie, url.hostname)) return null

    if (details.expirationDate !== undefined) cookie.expirationDate = details.expirationDate

    if (details.partitionKey !== undefined) cookie.partitionKey = structuredClone(details.partitionKey)

    return cookie
  }

  /** Cookies a request to `details.url` would send with this name, longest path first. */
  const addressed = (details: chrome.cookies.CookieDetails): Array<ChromeCookies.Cookie> => {
    const url = new URL(details.url)
    const storeId = details.storeId ?? defaultStoreId

    return Array.from(jar.values())
      .filter((cookie) => cookie.name === details.name && cookie.storeId === storeId
        && urlMatches(cookie, url) && partitionMatches(cookie, details.partitionKey))
      .sort((left, right) => right.path.length - left.path.length)
  }

  const filtered = (filter: chrome.cookies.GetAllDetails): Array<ChromeCookies.Cookie> => {
    const url = filter.url === undefined ? undefined : new URL(filter.url)
    const domain = filter.domain === undefined ? undefined : bareDomain(filter.domain)
    const storeId = filter.storeId ?? defaultStoreId

    return Array.from(jar.values()).filter((cookie) =>
      cookie.storeId === storeId
      && partitionMatches(cookie, filter.partitionKey)
      && (url === undefined || urlMatches(cookie, url))
      && (domain === undefined || bareDomain(cookie.domain) === domain || bareDomain(cookie.domain).endsWith(`.${domain}`))
      && (filter.name === undefined || cookie.name === filter.name)
      && (filter.path === undefined || cookie.path === filter.path)
      && (filter.secure === undefined || cookie.secure === filter.secure)
      && (filter.session === undefined || cookie.session === filter.session))
  }

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
      const cookie = build(details)

      if (cookie === null) return null

      store(cookie, true)

      return structuredClone(cookie)
    },
    remove: async (details) => {
      check("remove")
      const [first] = addressed(details)

      if (first !== undefined) {
        jar.delete(keyOf(first))
        emit(first, true, "explicit")
      }

      const removed: chrome.cookies.CookieDetails = { url: details.url, name: details.name, storeId: details.storeId ?? defaultStoreId }

      if (details.partitionKey !== undefined) removed.partitionKey = structuredClone(details.partitionKey)

      return removed
    },
    getAllCookieStores: async () => {
      check("getAllCookieStores")

      return structuredClone(stores)
    },
    onChanged: changed.api,
    ...overrides
  }

  return {
    api,
    layer: ChromeCookies.layer(api),
    controls: {
      onChanged: changed.controls,
      /** Stores a cookie as `set` would, without emitting; returns it, or null if refused. */
      seed: (details: chrome.cookies.SetDetails): ChromeCookies.Cookie | null => {
        const cookie = build(details)

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
      /** Replaces what `getAllCookieStores` reports, such as an incognito store with its tabs. */
      setStores: (next: ReadonlyArray<ChromeCookies.CookieStore>) => { stores = structuredClone(Array.from(next)) },
      failNext: (operation: CookiesOperation, cause: unknown) => {
        const queue = failures.get(operation) ?? []
        queue.push(cause)
        failures.set(operation, queue)
      }
    }
  }
}
