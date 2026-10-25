import * as ChromeWebRequest from "../ChromeWebRequest.js"
import * as TestEvent from "./Event.js"

/** Schemes whose requests webRequest reports, which `<all_urls>` matches. */
const reportedSchemes: ReadonlySet<string> = new Set(["http", "https", "ws", "wss", "ftp", "file", "urn", "chrome-extension"])

/** Schemes a match pattern may name explicitly; `*` stands for http and https only. */
const patternSchemes: ReadonlySet<string> = new Set(["*", ...reportedSchemes])

const defaultPorts: ReadonlyMap<string, string> = new Map([["http", "80"], ["https", "443"], ["ws", "80"], ["wss", "443"], ["ftp", "21"]])

/** A parsed Chrome match pattern. */
export interface UrlPattern {
  readonly all: boolean
  readonly scheme: string
  /** The host, without its `*.` prefix when `subdomains` is set; empty for any host. */
  readonly host: string
  readonly subdomains: boolean
  /** A port, or `*` for any. */
  readonly port: string
  readonly path: string
}

/** A parsed pattern, or Chrome's reason for rejecting it. */
export type ParsedUrlPattern =
  | { readonly valid: true, readonly pattern: UrlPattern }
  | { readonly valid: false, readonly error: string }

const valid = (pattern: UrlPattern): ParsedUrlPattern => ({ valid: true, pattern })

const invalidPattern = (error: string): ParsedUrlPattern => ({ valid: false, error })

const canonicalHost = (host: string): string => host.toLowerCase().replace(/\.+$/, "")

/**
 * Parses a Chrome match pattern, or returns Chrome's reason for rejecting it:
 * `<all_urls>`, or `scheme://host[:port]/path` where the scheme is `*` or a reported scheme,
 * the host is `*`, `*.domain` or a literal host (ignored for `file`), and the path is
 * required and may contain `*` wildcards.
 */
export const parseUrlPattern = (pattern: string): ParsedUrlPattern => {
  if (pattern === "<all_urls>") return valid({ all: true, scheme: "*", host: "", subdomains: true, port: "*", path: "/*" })

  const separator = pattern.indexOf("://")

  if (separator === -1) return invalidPattern("Missing scheme separator.")

  const scheme = pattern.slice(0, separator).toLowerCase()

  if (!patternSchemes.has(scheme)) return invalidPattern("Invalid scheme.")

  const rest = pattern.slice(separator + 3)
  const slash = rest.indexOf("/")

  if (slash === -1) return invalidPattern("Empty path.")

  const path = rest.slice(slash)

  if (scheme === "file") return valid({ all: false, scheme, host: "", subdomains: true, port: "*", path })

  const authority = rest.slice(0, slash)
  // An IPv6 literal keeps its colons inside brackets; the port follows the last colon outside them.
  const colon = authority.lastIndexOf(":")
  const hasPort = colon !== -1 && colon > authority.lastIndexOf("]")
  const rawHost = hasPort ? authority.slice(0, colon) : authority
  const port = hasPort ? authority.slice(colon + 1) : "*"

  if (rawHost === "") return invalidPattern("Host can not be empty.")

  if (port !== "*" && !(/^\d{1,5}$/.test(port) && Number(port) < 65536)) return invalidPattern("Invalid port.")

  if (rawHost === "*") return valid({ all: false, scheme, host: "", subdomains: true, port, path })

  const subdomains = rawHost.startsWith("*.")
  const host = canonicalHost(subdomains ? rawHost.slice(2) : rawHost)

  if (host.includes("*")) return invalidPattern("Invalid host wildcard.")

  return valid({ all: false, scheme, host, subdomains, port, path })
}

/** Glob matching with `*` as the only wildcard, the way Chrome matches pattern paths. */
const globMatches = (glob: string, value: string): boolean => {
  const parts = glob.split("*")
  const first = parts[0] ?? ""
  const last = parts.at(-1) ?? ""

  if (parts.length === 1) return glob === value

  if (!value.startsWith(first) || value.length < first.length + last.length || !value.endsWith(last)) return false

  let index = first.length
  const end = value.length - last.length

  for (const part of parts.slice(1, -1)) {
    const found = value.indexOf(part, index)

    if (found === -1 || found + part.length > end) return false

    index = found + part.length
  }

  return true
}

const pathMatches = (glob: string, path: string): boolean => {
  // A pattern ending in "/*" also matches the path without that suffix.
  const matches = (candidateGlob: string, candidate: string) => globMatches(candidateGlob, candidate)
    || (candidateGlob.endsWith("/*") && candidate === candidateGlob.slice(0, -2))

  return matches(glob, path) || matches(glob.toLowerCase(), path.toLowerCase())
}

/**
 * Whether a match pattern matches `url`, following Chrome's URLPattern: the `*` scheme
 * covers http and https, `*.example.com` also matches `example.com`, hosts compare without
 * case or trailing dots, a pattern without a port matches any port, and the path (with its
 * query) is matched as a glob. Invalid patterns and URLs that do not parse match nothing.
 */
export const matchesUrlPattern = (pattern: string, url: string): boolean => {
  const result = parseUrlPattern(pattern)

  return result.valid && URL.canParse(url) && matchesParsed(result.pattern, new URL(url))
}

const matchesParsed = (parsed: UrlPattern, target: URL): boolean => {
  const scheme = target.protocol.slice(0, -1)

  if (!reportedSchemes.has(scheme)) return false

  if (parsed.all) return true

  if (parsed.scheme === "*" ? scheme !== "http" && scheme !== "https" : scheme !== parsed.scheme) return false

  if (scheme !== "file") {
    const host = canonicalHost(target.hostname)

    if (parsed.host !== "" && host !== parsed.host && !(parsed.subdomains && host.endsWith(`.${parsed.host}`))) return false

    if (parsed.port !== "*" && parsed.port !== (target.port === "" ? defaultPorts.get(scheme) : target.port)) return false
  }

  return pathMatches(parsed.path, `${target.pathname}${target.search}`)
}

/** The request fields Chrome matches a `RequestFilter` against. */
export interface FilterTarget {
  readonly url: string
  readonly type: ChromeWebRequest.ResourceType
  readonly tabId: number
}

/**
 * Whether Chrome would deliver a request to a listener registered with `filter`: a URL with
 * a scheme webRequest reports (never `chrome:` or `data:`, say) and an empty `urls` list or
 * any matching pattern, an empty or absent `types` list or a listed type,
 * and `tabId` and `windowId` when given and not -1. `windowId` is the window holding the
 * request's tab, -1 for requests outside a tab.
 */
export const matchesRequestFilter = (filter: ChromeWebRequest.RequestFilter, target: FilterTarget, windowId = -1): boolean =>
  compileFilter(filter)(target, parseTarget(target.url), windowId)

/** A request URL parsed once per dispatch; undefined when it does not parse. */
const parseTarget = (url: string): URL | undefined => URL.canParse(url) ? new URL(url) : undefined

type CompiledFilter = (target: FilterTarget, url: URL | undefined, windowId: number) => boolean

/** Parses a filter's patterns once, so dispatching to many listeners stays cheap. */
const compileFilter = (filter: ChromeWebRequest.RequestFilter): CompiledFilter => {
  const anyUrl = filter.urls.length === 0

  const patterns = filter.urls.flatMap((pattern) => {
    const result = parseUrlPattern(pattern)

    return result.valid ? [result.pattern] : []
  })

  const types: ReadonlySet<string> | undefined = filter.types === undefined || filter.types.length === 0 ? undefined : new Set(filter.types)
  const tabId = filter.tabId ?? -1
  const windowId = filter.windowId ?? -1

  // Chrome never reports requests for other schemes, so even an empty `urls` list skips them.
  return (target, url, targetWindowId) =>
    url !== undefined && reportedSchemes.has(url.protocol.slice(0, -1))
    && (anyUrl || patterns.some((pattern) => matchesParsed(pattern, url)))
    && (types === undefined || types.has(target.type))
    && (tabId === -1 || tabId === target.tabId)
    && (windowId === -1 || windowId === targetWindowId)
}

const resourceTypes: ReadonlySet<string> = new Set([
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object", "xmlhttprequest", "ping",
  "csp_report", "media", "websocket", "webbundle", "other"
])

/** The extraInfoSpec values Chrome's schema accepts per event, blocking modes included. */
const allowedSpecs = {
  onBeforeRequest: ["blocking", "requestBody", "extraHeaders"],
  onBeforeSendHeaders: ["requestHeaders", "blocking", "extraHeaders"],
  onSendHeaders: ["requestHeaders", "extraHeaders"],
  onHeadersReceived: ["blocking", "responseHeaders", "extraHeaders", "securityInfo", "securityInfoRawDer"],
  onAuthRequired: ["responseHeaders", "blocking", "asyncBlocking", "extraHeaders"],
  onResponseStarted: ["responseHeaders", "extraHeaders"],
  onCompleted: ["responseHeaders", "extraHeaders"],
  onErrorOccurred: ["extraHeaders"],
  onBeforeRedirect: ["responseHeaders", "extraHeaders"]
} as const satisfies Record<string, ReadonlyArray<string>>

export type RequestEventName = keyof typeof allowedSpecs

/** Chrome's console message for a blocking registration the extension has no permission for. */
export const blockingPermissionError = "You do not have permission to use blocking webRequest listeners. "
  + "Be sure to declare the webRequestBlocking permission in your manifest."

/** One `addListener` call: the arguments after the listener, exactly as given. */
export type Registration = readonly [filter: ChromeWebRequest.RequestFilter] | readonly [
  filter: ChromeWebRequest.RequestFilter,
  extraInfoSpec: ReadonlyArray<string>
]

interface Listening<Details> {
  readonly listener: (details: Details, asyncCallback?: ChromeWebRequest.AuthCallback) => void
  readonly filter: ChromeWebRequest.RequestFilter
  readonly matches: CompiledFilter
  readonly spec: ReadonlySet<string>
}

interface EventContext {
  readonly authProvider: boolean
  readonly windowOf: (tabId: number) => number
  readonly consoleErrors: Array<string>
  readonly listenerErrors: Array<Error>
}

const asError = (cause: unknown): Error => cause instanceof Error ? cause : new Error(String(cause))

/**
 * Runs each delivery whose listener is still registered, collecting listener exceptions as
 * Chrome logs them, and returns how many listeners ran. Like Chrome, a listener removed by
 * an earlier one during the same dispatch is skipped.
 */
const dispatch = <Details>(
  deliveries: ReadonlyArray<readonly [Listening<Details>, Details]>,
  isRegistered: (listening: Listening<Details>) => boolean,
  errors: Array<Error>
): number => {
  let delivered = 0

  for (const [listening, details] of deliveries) {
    if (!isRegistered(listening)) continue

    delivered++

    try {
      listening.listener(details)
    } catch (cause) {
      errors.push(asError(cause))
    }
  }

  return delivered
}

const invalid = (name: RequestEventName, message: string) =>
  new TypeError(`Error in invocation of webRequest.${name}.addListener: ${message}`)

/** Throws like Chrome's synchronous schema validation; returns the console error for checks Chrome makes later. */
const validate = (
  name: RequestEventName,
  filter: ChromeWebRequest.RequestFilter,
  spec: ReadonlyArray<string>,
  context: EventContext
): string | undefined => {
  if (!Array.isArray(filter.urls)) throw invalid(name, "filter.urls must be an array of strings.")

  for (const type of filter.types ?? []) {
    if (!resourceTypes.has(type)) throw invalid(name, `Invalid resource type '${type}'.`)
  }

  for (const key of ["tabId", "windowId"] as const) {
    const value = filter[key]

    if (value !== undefined && !Number.isInteger(value)) throw invalid(name, `filter.${key} must be an integer.`)
  }

  const allowed: ReadonlyArray<string> = allowedSpecs[name]

  for (const flag of spec) {
    if (!allowed.includes(flag)) throw invalid(name, `Value '${flag}' is not a valid extraInfoSpec for ${name}.`)
  }

  for (const url of filter.urls) {
    if (!parseUrlPattern(url).valid) return `'${url}' is not a valid URL pattern.`
  }

  const blocking = spec.includes("blocking")
  const asyncBlocking = spec.includes("asyncBlocking")

  if (blocking && asyncBlocking) return "Only one of 'blocking' or 'asyncBlocking' may be given."

  if ((blocking || asyncBlocking) && !(name === "onAuthRequired" && context.authProvider)) return blockingPermissionError

  return undefined
}

/**
 * A filter-aware webRequest event. Each listener receives a structured clone of the
 * details, minus the optional fields its extraInfoSpec did not ask for (`strip`), and
 * only for requests matching its filter. Listener exceptions are collected, not thrown,
 * and later listeners still run.
 */
const makeRequestEvent = <Details extends FilterTarget>(
  name: RequestEventName,
  context: EventContext,
  strip: (details: Details, spec: ReadonlySet<string>) => void
) => {
  const listeners: Array<Listening<Details>> = []
  // The same registrations as a set, so dispatch can skip removed ones cheaply.
  const active = new Set<Listening<Details>>()
  const isRegistered = (listening: Listening<Details>) => active.has(listening)
  const waiting = new Set<{ readonly count: number, readonly resolve: () => void }>()
  const failures = new Map<"addListener" | "removeListener", Array<Error>>()
  const calls: Array<Registration> = []
  const removed: Array<(listener: Listening<Details>) => void> = []

  const check = (operation: "addListener" | "removeListener") => {
    const queue = failures.get(operation)

    if (queue !== undefined && queue.length > 0) throw queue.shift()
  }

  const api = {
    addListener: (
      listener: (details: Details, asyncCallback?: ChromeWebRequest.AuthCallback) => void,
      filter: ChromeWebRequest.RequestFilter,
      ...rest: [extraInfoSpec?: Array<string>]
    ): void => {
      check("addListener")
      const spec = rest[0] ?? []
      calls.push(rest.length === 0 ? [structuredClone(filter)] : [structuredClone(filter), [...spec]])
      const error = validate(name, filter, spec, context)

      if (error !== undefined) {
        context.consoleErrors.push(`webRequest.${name}: ${error}`)

        return
      }

      // Like Chrome, each call is its own registration, even for a function already registered.
      const copy = structuredClone(filter)
      const listening: Listening<Details> = { listener, filter: copy, matches: compileFilter(copy), spec: new Set(spec) }
      listeners.push(listening)
      active.add(listening)

      for (const waiter of waiting) {
        if (listeners.length >= waiter.count) {
          waiting.delete(waiter)
          waiter.resolve()
        }
      }
    },
    removeListener: (listener: (details: Details, asyncCallback?: ChromeWebRequest.AuthCallback) => void): void => {
      check("removeListener")

      // Chrome removes every registration of the function.
      for (const listening of listeners.filter((each) => each.listener === listener)) {
        listeners.splice(listeners.indexOf(listening), 1)
        active.delete(listening)

        for (const notify of removed) notify(listening)
      }
    }
  }

  /** The listeners matching `details`, each with its own copy of the details. */
  const deliveries = (details: Details): Array<readonly [Listening<Details>, Details]> => {
    const url = parseTarget(details.url)
    const windowId = context.windowOf(details.tabId)

    return listeners.flatMap((listening) => {
      if (!listening.matches(details, url, windowId)) return []

      const copy = structuredClone(details)
      strip(copy, listening.spec)

      return [[listening, copy] as const]
    })
  }

  return {
    api,
    deliveries,
    isRegistered,
    onRemoved: (notify: (listener: Listening<Details>) => void) => { removed.push(notify) },
    controls: {
      /** Active registrations; a function registered twice counts twice. */
      get listenerCount() { return listeners.length },
      /** Every `addListener` call's filter and extraInfoSpec, as given, accepted or not. */
      calls,
      /** The filter and extraInfoSpec of each active listener, in registration order. */
      get registrations(): ReadonlyArray<{ readonly filter: ChromeWebRequest.RequestFilter, readonly extraInfoSpec: ReadonlyArray<string> }> {
        return listeners.map(({ filter, spec }) => ({ filter, extraInfoSpec: Array.from(spec) }))
      },
      /** Resolves once at least `count` registrations (default 1) are active. */
      waitForListener: (count = 1): Promise<void> => listeners.length >= count
        ? Promise.resolve()
        : new Promise((resolve) => { waiting.add({ count, resolve }) }),
      /** Makes the next `addListener` or `removeListener` call throw `cause`. */
      failNext: (operation: "addListener" | "removeListener", cause: Error) => {
        const queue = failures.get(operation) ?? []
        queue.push(cause)
        failures.set(operation, queue)
      },
      /** Delivers one event to the matching listeners and returns how many received it. */
      emit: (details: Details): number => dispatch(deliveries(details), isRegistered, context.listenerErrors)
    }
  }
}

const withoutRequestHeaders = <Details extends { requestHeaders?: Array<ChromeWebRequest.HttpHeader> }>(
  details: Details,
  spec: ReadonlySet<string>
) => {
  if (!spec.has("requestHeaders")) delete details.requestHeaders
}

const withoutResponseHeaders = <Details extends { responseHeaders?: Array<ChromeWebRequest.HttpHeader> }>(
  details: Details,
  spec: ReadonlySet<string>
) => {
  if (!spec.has("responseHeaders")) delete details.responseHeaders
}

const withoutRequestBody = (details: ChromeWebRequest.BeforeRequest, spec: ReadonlySet<string>) => {
  if (!spec.has("requestBody")) delete details.requestBody
}

/** `securityInfo` needs either security flag; certificate bytes need `"securityInfoRawDer"`. */
const withoutReceivedExtras = (details: ChromeWebRequest.HeadersReceived, spec: ReadonlySet<string>) => {
  withoutResponseHeaders(details, spec)

  if (!spec.has("securityInfo") && !spec.has("securityInfoRawDer")) {
    delete details.securityInfo
  } else if (!spec.has("securityInfoRawDer")) {
    for (const certificate of details.securityInfo?.certificates ?? []) delete certificate.rawDER
  }
}

/** Options for `makeWebRequest`. */
export interface WebRequestOptions {
  /**
   * Whether the manifest grants `"webRequestAuthProvider"` (default true). Without it, an
   * onAuthRequired listener registered with `"blocking"` or `"asyncBlocking"` is refused
   * with a console error, as Chrome does.
   */
  readonly authProvider?: boolean
}

/** A request for `controls.request` to drive through its lifecycle. */
export interface SimulatedRequest {
  readonly url: string
  /** Defaults to `"GET"`. */
  readonly method?: string
  /** Defaults to `"xmlhttprequest"`. */
  readonly type?: ChromeWebRequest.ResourceType
  /** Defaults to -1, a request outside any tab. */
  readonly tabId?: number
  /** Defaults to 0, the main frame. */
  readonly frameId?: number
  readonly initiator?: string
  readonly documentId?: string
  readonly requestBody?: ChromeWebRequest.BeforeRequest["requestBody"]
  readonly requestHeaders?: Array<ChromeWebRequest.HttpHeader>
  /**
   * Server redirects, in order, before the final URL; each emits onBeforeRedirect (302 by
   * default). Like Fetch, a 303, or a 301 or 302 after POST, continues as GET without the
   * body; 307 and 308 keep both.
   */
  readonly redirects?: ReadonlyArray<{ readonly url: string, readonly statusCode?: number }>
  /** The final response; defaults to 200 OK, not from cache. */
  readonly response?: {
    readonly statusCode?: number
    readonly statusLine?: string
    readonly responseHeaders?: Array<ChromeWebRequest.HttpHeader>
    readonly fromCache?: boolean
    readonly ip?: string
  }
  /** Fails the final hop after onBeforeRequest with this error instead of completing. */
  readonly error?: string
}

/** What `controls.request` emitted, in order, and the request id it used. */
export interface SimulatedRequestResult {
  readonly requestId: string
  readonly events: ReadonlyArray<RequestEventName>
}

const statusLines: ReadonlyMap<number, string> = new Map([
  [200, "OK"], [204, "No Content"], [301, "Moved Permanently"], [302, "Found"], [303, "See Other"],
  [307, "Temporary Redirect"], [308, "Permanent Redirect"], [401, "Unauthorized"], [404, "Not Found"],
  [407, "Proxy Authentication Required"], [500, "Internal Server Error"]
])

const statusLine = (statusCode: number) => `HTTP/1.1 ${statusCode} ${statusLines.get(statusCode) ?? ""}`.trimEnd()

/**
 * An in-memory `chrome.webRequest`. Listeners are matched like Chrome's (see
 * `matchesRequestFilter` and `matchesUrlPattern`), each receives its own copy of the
 * details without the optional fields its extraInfoSpec did not ask for (`requestBody`,
 * `requestHeaders`, `responseHeaders`, `securityInfo`, and `rawDER` without
 * `"securityInfoRawDer"`). As in Chrome, each `addListener` call is a separate
 * registration with its own filter, and `removeListener` removes every registration of
 * that function.
 *
 * Like Chrome, `addListener` throws for a malformed filter or an extraInfoSpec value the
 * event does not accept, but only logs (to `controls.consoleErrors`) and skips the listener
 * for an invalid URL pattern or a blocking registration without permission; only
 * onAuthRequired may block, and only with `options.authProvider` (the default).
 *
 * `controls.request` drives a request through its lifecycle, and each event's `emit`
 * delivers single events. Requests for schemes webRequest does not report (`chrome:`,
 * `data:`, ...) reach no listener, and a listener removed by an earlier one during the
 * same dispatch is skipped. `onAuthRequired.challenge` resolves with the answers of its
 * `"asyncBlocking"` listeners; one removed while its challenge is pending, or one that
 * throws, counts as `{}`, as Chrome unblocks the request. Other onAuthRequired listeners,
 * synchronous `"blocking"` ones included, are only notified. Timestamps come from a counter and request ids are
 * `"1"`, `"2"`, …. `handlerBehaviorChanged` is counted, with no quota enforced. Pass
 * `overrides` to replace any API member.
 */
export const makeWebRequest = (
  options: WebRequestOptions = {},
  overrides: Partial<ChromeWebRequest.ChromeWebRequestApi> = {}
) => {
  const windows = new Map<number, number>()
  const consoleErrors: Array<string> = []
  const listenerErrors: Array<Error> = []

  const context: EventContext = {
    authProvider: options.authProvider ?? true,
    windowOf: (tabId) => windows.get(tabId) ?? -1,
    consoleErrors,
    listenerErrors
  }

  const beforeRequest = makeRequestEvent<ChromeWebRequest.BeforeRequest>("onBeforeRequest", context, withoutRequestBody)
  const beforeSendHeaders = makeRequestEvent<ChromeWebRequest.BeforeSendHeaders>("onBeforeSendHeaders", context, withoutRequestHeaders)
  const sendHeaders = makeRequestEvent<ChromeWebRequest.SendHeaders>("onSendHeaders", context, withoutRequestHeaders)
  const headersReceived = makeRequestEvent<ChromeWebRequest.HeadersReceived>("onHeadersReceived", context, withoutReceivedExtras)
  const authRequired = makeRequestEvent<ChromeWebRequest.AuthRequired>("onAuthRequired", context, withoutResponseHeaders)
  const responseStarted = makeRequestEvent<ChromeWebRequest.ResponseStarted>("onResponseStarted", context, withoutResponseHeaders)
  const completed = makeRequestEvent<ChromeWebRequest.Completed>("onCompleted", context, withoutResponseHeaders)
  const errorOccurred = makeRequestEvent<ChromeWebRequest.ErrorOccurred>("onErrorOccurred", context, () => {})
  const beforeRedirect = makeRequestEvent<ChromeWebRequest.BeforeRedirect>("onBeforeRedirect", context, withoutResponseHeaders)
  const actionIgnored = TestEvent.makeEvent<[ChromeWebRequest.ActionIgnored]>()
  let handlerBehaviorChangedCalls = 0
  let clock = 0
  let requests = 0

  // Answers owed by "asyncBlocking" listeners, settled by their callback or their removal.
  const owed = new Map<Listening<ChromeWebRequest.AuthRequired>, Set<(answer: ChromeWebRequest.AuthAnswer) => void>>()

  authRequired.onRemoved((listening) => {
    const pending = owed.get(listening)
    owed.delete(listening)

    for (const settle of pending ?? []) settle({})
  })

  const api: ChromeWebRequest.ChromeWebRequestApi = {
    handlerBehaviorChanged: async () => { handlerBehaviorChangedCalls++ },
    onBeforeRequest: beforeRequest.api,
    onBeforeSendHeaders: beforeSendHeaders.api,
    onSendHeaders: sendHeaders.api,
    onHeadersReceived: headersReceived.api,
    onAuthRequired: authRequired.api,
    onResponseStarted: responseStarted.api,
    onCompleted: completed.api,
    onErrorOccurred: errorOccurred.api,
    onBeforeRedirect: beforeRedirect.api,
    onActionIgnored: actionIgnored.api,
    ...overrides
  }

  const challenge = (details: ChromeWebRequest.AuthRequired): Promise<Array<ChromeWebRequest.AuthAnswer>> => {
    const answers: Array<Promise<ChromeWebRequest.AuthAnswer>> = []

    for (const [listening, copy] of authRequired.deliveries(details)) {
      // A listener an earlier one removed during this dispatch neither runs nor blocks.
      if (!authRequired.isRegistered(listening)) continue

      if (!listening.spec.has("asyncBlocking")) {
        dispatch([[listening, copy]], authRequired.isRegistered, listenerErrors)
        continue
      }

      answers.push(new Promise((resolve) => {
        let settled = false
        const pending = owed.get(listening) ?? new Set()
        owed.set(listening, pending)

        // Chrome takes the first answer and ignores later calls.
        const settle = (answer: ChromeWebRequest.AuthAnswer) => {
          if (settled) return

          settled = true
          pending.delete(settle)
          resolve(structuredClone(answer))
        }

        pending.add(settle)

        try {
          listening.listener(copy, settle)
        } catch (cause) {
          // Chrome logs the exception and unblocks the request.
          listenerErrors.push(asError(cause))
          settle({})
        }
      }))
    }

    return Promise.all(answers)
  }

  const request = (simulated: SimulatedRequest): SimulatedRequestResult => {
    const requestId = String(++requests)
    const events: Array<RequestEventName> = []
    const frameId = simulated.frameId ?? 0
    const hops = [...(simulated.redirects ?? []), { url: simulated.url, statusCode: undefined }]
    let method = simulated.method ?? "GET"
    let requestBody = simulated.requestBody

    const base = (url: string) => {
      const details: ChromeWebRequest.BeforeRequest = {
        requestId, url, method, frameId, parentFrameId: frameId === 0 ? -1 : 0,
        tabId: simulated.tabId ?? -1, type: simulated.type ?? "xmlhttprequest", timeStamp: ++clock,
        frameType: frameId === 0 ? "outermost_frame" : "sub_frame", documentLifecycle: "active"
      }

      if (simulated.initiator !== undefined) details.initiator = simulated.initiator

      if (simulated.documentId !== undefined) details.documentId = simulated.documentId

      return details
    }

    const full = (url: string) => {
      const { requestBody: _requestBody, ...details } = base(url)

      return { ...details, documentLifecycle: details.documentLifecycle ?? "active", frameType: details.frameType ?? "outermost_frame" }
    }

    const emit = <Details>(name: RequestEventName, event: { readonly emit: (details: Details) => number }, details: Details) => {
      events.push(name)
      event.emit(details)
    }

    for (const [index, hop] of hops.entries()) {
      const scheme = new URL(hop.url).protocol.slice(0, -1)

      // Chrome reports nothing for other schemes; after a redirect to one, such as `data:`,
      // onBeforeRedirect is the request's last event.
      if (!reportedSchemes.has(scheme)) break

      const isFile = scheme === "file"
      const final = index === hops.length - 1
      const before = base(hop.url)

      if (requestBody !== undefined) before.requestBody = requestBody

      emit("onBeforeRequest", controls.onBeforeRequest, before)

      if (final && simulated.error !== undefined) {
        emit("onErrorOccurred", controls.onErrorOccurred, { ...full(hop.url), error: simulated.error, fromCache: false })
        break
      }

      const statusCode = final ? simulated.response?.statusCode ?? 200 : hop.statusCode ?? 302
      const line = final ? simulated.response?.statusLine ?? statusLine(statusCode) : statusLine(statusCode)
      const response = { statusCode, statusLine: line }
      const responseHeaders = final ? simulated.response?.responseHeaders : [{ name: "location", value: hops[index + 1]?.url ?? "" }]
      const headers = responseHeaders === undefined ? {} : { responseHeaders }
      const ip = final && simulated.response?.ip !== undefined ? { ip: simulated.response.ip } : {}
      const fromCache = final ? simulated.response?.fromCache ?? false : false

      if (!isFile) {
        const requestHeaders = simulated.requestHeaders === undefined ? {} : { requestHeaders: simulated.requestHeaders }
        emit("onBeforeSendHeaders", controls.onBeforeSendHeaders, { ...full(hop.url), ...requestHeaders })
        emit("onSendHeaders", controls.onSendHeaders, { ...full(hop.url), ...requestHeaders })
        emit("onHeadersReceived", controls.onHeadersReceived, { ...full(hop.url), ...response, ...headers })
      }

      if (!final) {
        emit("onBeforeRedirect", controls.onBeforeRedirect, {
          ...full(hop.url), ...response, ...headers, ...ip, fromCache, redirectUrl: hops[index + 1]?.url ?? ""
        })

        // Fetch's redirect rules: 303 turns anything but HEAD into GET, 301 and 302 turn POST into GET.
        if ((statusCode === 303 && method !== "HEAD") || ((statusCode === 301 || statusCode === 302) && method === "POST")) {
          method = "GET"
          requestBody = undefined
        }

        continue
      }

      emit("onResponseStarted", controls.onResponseStarted, { ...full(hop.url), ...response, ...headers, ...ip, fromCache })
      emit("onCompleted", controls.onCompleted, { ...full(hop.url), ...response, ...headers, ...ip, fromCache })
    }

    return { requestId, events }
  }

  const controls = {
    onBeforeRequest: beforeRequest.controls,
    onBeforeSendHeaders: beforeSendHeaders.controls,
    onSendHeaders: sendHeaders.controls,
    onHeadersReceived: headersReceived.controls,
    onAuthRequired: {
      // Delegating getters: spreading the event's controls would freeze their values.
      get listenerCount() { return authRequired.controls.listenerCount },
      calls: authRequired.controls.calls,
      get registrations() { return authRequired.controls.registrations },
      waitForListener: authRequired.controls.waitForListener,
      failNext: authRequired.controls.failNext,
      /**
       * Raises an authentication challenge: listeners without `"asyncBlocking"` are only
       * notified; the promise resolves with each blocking listener's answer, in
       * registration order, once all have answered.
       */
      challenge,
      /** Challenges still waiting for an answer. */
      get pendingChallenges() {
        return Array.from(owed.values()).reduce((count, pending) => count + pending.size, 0)
      }
    },
    onResponseStarted: responseStarted.controls,
    onCompleted: completed.controls,
    onErrorOccurred: errorOccurred.controls,
    onBeforeRedirect: beforeRedirect.controls,
    onActionIgnored: actionIgnored.controls,
    /** Drives a request through its lifecycle, emitting each event Chrome would. */
    request,
    /** Places a tab in a window, for `windowId` filters; tabs default to window -1. */
    setTabWindow: (tabId: number, windowId: number) => { windows.set(tabId, windowId) },
    /** Messages Chrome would log instead of throwing, such as invalid URL patterns. */
    consoleErrors,
    /** Exceptions thrown by listeners, which Chrome logs. */
    listenerErrors,
    get handlerBehaviorChangedCalls() { return handlerBehaviorChangedCalls }
  }

  return { api, layer: ChromeWebRequest.layer(api), controls }
}
