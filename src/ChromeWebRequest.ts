import { Context, Layer, Schema, Stream } from "effect"
import { liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeWebRequestError extends Schema.TaggedError<ChromeWebRequestError>()("ChromeWebRequestError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

export type RequestFilter = chrome.webRequest.RequestFilter

export type BeforeRequest = chrome.webRequest.OnBeforeRequestDetails

export type BeforeSendHeaders = chrome.webRequest.OnBeforeSendHeadersDetails

export type SendHeaders = chrome.webRequest.OnSendHeadersDetails

export type HeadersReceived = chrome.webRequest.OnHeadersReceivedDetails

export type ResponseStarted = chrome.webRequest.OnResponseStartedDetails

export type Completed = chrome.webRequest.OnCompletedDetails

export type ErrorOccurred = chrome.webRequest.OnErrorOccurredDetails

export type BeforeRedirect = chrome.webRequest.OnBeforeRedirectDetails

/** Chrome's `extraInfoSpec` values for an event, without `"blocking"`: this module only observes. */
type Observing<Spec extends string> = Exclude<Spec, "blocking">

export type BeforeRequestSpec = Observing<`${chrome.webRequest.OnBeforeRequestOptions}`>

export type BeforeSendHeadersSpec = Observing<`${chrome.webRequest.OnBeforeSendHeadersOptions}`>

export type SendHeadersSpec = `${chrome.webRequest.OnSendHeadersOptions}`

export type HeadersReceivedSpec = Observing<`${chrome.webRequest.OnHeadersReceivedOptions}`>

export type ResponseStartedSpec = `${chrome.webRequest.OnResponseStartedOptions}`

export type CompletedSpec = `${chrome.webRequest.OnCompletedOptions}`

export type ErrorOccurredSpec = `${chrome.webRequest.OnErrorOccurredOptions}`

export type BeforeRedirectSpec = `${chrome.webRequest.OnBeforeRedirectOptions}`

/**
 * A webRequest event, whose `addListener` also takes the URL filter and the optional
 * extra-info flags. Chrome's events accept a wider flag set (including `"blocking"`).
 */
export interface WebRequestEvent<Details, Spec extends string> {
  addListener(listener: (details: Details) => void, filter: RequestFilter, extraInfoSpec?: Array<Spec>): void
  removeListener(listener: (details: Details) => void): void
}

/** The MV3 event subset this module needs. */
export interface ChromeWebRequestApi {
  readonly onBeforeRequest: WebRequestEvent<BeforeRequest, BeforeRequestSpec>
  readonly onBeforeSendHeaders: WebRequestEvent<BeforeSendHeaders, BeforeSendHeadersSpec>
  readonly onSendHeaders: WebRequestEvent<SendHeaders, SendHeadersSpec>
  readonly onHeadersReceived: WebRequestEvent<HeadersReceived, HeadersReceivedSpec>
  readonly onResponseStarted: WebRequestEvent<ResponseStarted, ResponseStartedSpec>
  readonly onCompleted: WebRequestEvent<Completed, CompletedSpec>
  readonly onErrorOccurred: WebRequestEvent<ErrorOccurred, ErrorOccurredSpec>
  readonly onBeforeRedirect: WebRequestEvent<BeforeRedirect, BeforeRedirectSpec>
}

type Observer<Details, Spec extends string> = (
  filter: RequestFilter,
  extraInfoSpec?: ReadonlyArray<Spec>
) => Stream.Stream<Details, ChromeWebRequestError>

/**
 * Observational streams over the request lifecycle, in Chrome's order: onBeforeRequest,
 * onBeforeSendHeaders, onSendHeaders, onHeadersReceived, then onBeforeRedirect (looping
 * back), onResponseStarted, and finally onCompleted or onErrorOccurred.
 *
 * MV3 grants normal extensions no blocking webRequest, so these streams never cancel,
 * redirect or rewrite a request; block or modify requests with declarative rules through
 * ChromeDeclarativeNetRequest. Each stream takes Chrome's required `RequestFilter` (`urls`
 * match patterns, optionally `types`, `tabId` and `windowId`) and optional extra-info
 * flags, such as `"requestHeaders"` or `"responseHeaders"`, that add fields to the details.
 * Events arrive only for hosts the extension has host permissions for.
 *
 * Listeners exist only while a stream runs and cannot wake an MV3 service worker; register
 * wake listeners synchronously through `ChromeServiceWorker.listen`. Each subscription
 * buffers at most 64 events, dropping the oldest, so busy pages can overflow it.
 */
export interface ChromeWebRequestService {
  readonly onBeforeRequest: Observer<BeforeRequest, BeforeRequestSpec>
  readonly onBeforeSendHeaders: Observer<BeforeSendHeaders, BeforeSendHeadersSpec>
  readonly onSendHeaders: Observer<SendHeaders, SendHeadersSpec>
  readonly onHeadersReceived: Observer<HeadersReceived, HeadersReceivedSpec>
  readonly onResponseStarted: Observer<ResponseStarted, ResponseStartedSpec>
  readonly onCompleted: Observer<Completed, CompletedSpec>
  readonly onErrorOccurred: Observer<ErrorOccurred, ErrorOccurredSpec>
  readonly onBeforeRedirect: Observer<BeforeRedirect, BeforeRedirectSpec>
}

export class ChromeWebRequest extends Context.Service<ChromeWebRequest, ChromeWebRequestService>()(
  "effect-platform-chrome/ChromeWebRequest"
) {}

const observer = <Details, Spec extends string>(
  operation: string,
  getEvent: () => WebRequestEvent<Details, Spec>
): Observer<Details, Spec> => (filter, extraInfoSpec) => observe(
  (): EventSource<[details: Details]> => {
    const event = getEvent()

    return {
      // Pass extraInfoSpec only when given, never as an explicit undefined.
      addListener: (listener) => extraInfoSpec === undefined
        ? event.addListener(listener, filter)
        : event.addListener(listener, filter, [...extraInfoSpec]),
      removeListener: (listener) => event.removeListener(listener)
    }
  },
  (details) => details,
  (cause) => new ChromeWebRequestError({ operation, cause })
)

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeWebRequestApi): ChromeWebRequestService => ChromeWebRequest.of({
  onBeforeRequest: observer("onBeforeRequest", () => api.onBeforeRequest),
  onBeforeSendHeaders: observer("onBeforeSendHeaders", () => api.onBeforeSendHeaders),
  onSendHeaders: observer("onSendHeaders", () => api.onSendHeaders),
  onHeadersReceived: observer("onHeadersReceived", () => api.onHeadersReceived),
  onResponseStarted: observer("onResponseStarted", () => api.onResponseStarted),
  onCompleted: observer("onCompleted", () => api.onCompleted),
  onErrorOccurred: observer("onErrorOccurred", () => api.onErrorOccurred),
  onBeforeRedirect: observer("onBeforeRedirect", () => api.onBeforeRedirect)
})

export const layer = (api: ChromeWebRequestApi): Layer.Layer<ChromeWebRequest> => Layer.succeed(ChromeWebRequest, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeWebRequest, ChromeWebRequestError> = liveLayer(
  ChromeWebRequest, "webRequest", (chrome) => chrome.webRequest, make,
  (cause) => new ChromeWebRequestError({ operation: "initialize", cause })
)
