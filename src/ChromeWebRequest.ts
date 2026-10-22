import { Context, Effect, Exit, FiberSet, Layer, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { invoker, liveLayer } from "./internal/api.js"
import { observe, type EventSource } from "./internal/event.js"

export class ChromeWebRequestError extends Schema.TaggedError<ChromeWebRequestError>()("ChromeWebRequestError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/**
 * Which requests a listener receives: `urls` match patterns (an empty list matches every
 * URL), and optionally resource `types`, a `tabId` and a `windowId`. Chrome requires it.
 */
export type RequestFilter = chrome.webRequest.RequestFilter

export type ResourceType = `${chrome.webRequest.ResourceType}`

export type HttpHeader = chrome.webRequest.HttpHeader

export type BeforeRequest = chrome.webRequest.OnBeforeRequestDetails

export type BeforeSendHeaders = chrome.webRequest.OnBeforeSendHeadersDetails

export type SendHeaders = chrome.webRequest.OnSendHeadersDetails

export type HeadersReceived = chrome.webRequest.OnHeadersReceivedDetails

export type AuthRequired = chrome.webRequest.OnAuthRequiredDetails

export type ResponseStarted = chrome.webRequest.OnResponseStartedDetails

export type Completed = chrome.webRequest.OnCompletedDetails

export type ErrorOccurred = chrome.webRequest.OnErrorOccurredDetails

export type BeforeRedirect = chrome.webRequest.OnBeforeRedirectDetails

/** The modification Chrome ignored: `"redirect"`, `"request_headers"`, `"response_headers"` or `"auth_credentials"`. */
export type IgnoredAction = `${chrome.webRequest.IgnoredActionType}`

/** One `onActionIgnored` notification: a proposed modification lost to another extension's. */
export interface ActionIgnored {
  readonly action: IgnoredAction
  readonly requestId: string
}

export type AuthCredentials = chrome.webRequest.AuthCredentials

/**
 * An answer to an authentication challenge: `authCredentials` to retry the request with
 * them, `cancel: true` to cancel it and show the error page, or `{}` to take no action,
 * which lets Chrome show its own login prompt or fail the request.
 */
export type AuthAnswer = Pick<chrome.webRequest.BlockingResponse, "authCredentials" | "cancel">

/** Chrome's `extraInfoSpec` values for an event, without the blocking modes: this module only observes. */
type Observing<Spec extends string> = Exclude<Spec, "blocking" | "asyncBlocking">

export type BeforeRequestSpec = Observing<`${chrome.webRequest.OnBeforeRequestOptions}`>

export type BeforeSendHeadersSpec = Observing<`${chrome.webRequest.OnBeforeSendHeadersOptions}`>

export type SendHeadersSpec = `${chrome.webRequest.OnSendHeadersOptions}`

export type HeadersReceivedSpec = Observing<`${chrome.webRequest.OnHeadersReceivedOptions}`>

export type AuthRequiredSpec = Observing<`${chrome.webRequest.OnAuthRequiredOptions}`>

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

/** Chrome's answer callback for an `"asyncBlocking"` onAuthRequired listener. */
export type AuthCallback = (response: chrome.webRequest.BlockingResponse) => void

/**
 * `chrome.webRequest.onAuthRequired`. Chrome passes the second, `asyncCallback`, argument
 * only to listeners registered with `"asyncBlocking"`.
 */
export interface AuthRequiredEvent {
  addListener(
    listener: (details: AuthRequired, asyncCallback?: AuthCallback) => void,
    filter: RequestFilter,
    extraInfoSpec?: Array<AuthRequiredSpec | "asyncBlocking">
  ): void
  removeListener(listener: (details: AuthRequired, asyncCallback?: AuthCallback) => void): void
}

/** The Promise-based MV3 subset this module needs. */
export interface ChromeWebRequestApi {
  handlerBehaviorChanged(): Promise<void>
  readonly onBeforeRequest: WebRequestEvent<BeforeRequest, BeforeRequestSpec>
  readonly onBeforeSendHeaders: WebRequestEvent<BeforeSendHeaders, BeforeSendHeadersSpec>
  readonly onSendHeaders: WebRequestEvent<SendHeaders, SendHeadersSpec>
  readonly onHeadersReceived: WebRequestEvent<HeadersReceived, HeadersReceivedSpec>
  readonly onAuthRequired: AuthRequiredEvent
  readonly onResponseStarted: WebRequestEvent<ResponseStarted, ResponseStartedSpec>
  readonly onCompleted: WebRequestEvent<Completed, CompletedSpec>
  readonly onErrorOccurred: WebRequestEvent<ErrorOccurred, ErrorOccurredSpec>
  readonly onBeforeRedirect: WebRequestEvent<BeforeRedirect, BeforeRedirectSpec>
  readonly onActionIgnored: EventSource<[details: ActionIgnored]>
}

type Observer<Details, Spec extends string> = (
  filter: RequestFilter,
  extraInfoSpec?: ReadonlyArray<Spec>
) => Stream.Stream<Details, ChromeWebRequestError>

/**
 * Observational streams over the request lifecycle, in Chrome's order: onBeforeRequest,
 * onBeforeSendHeaders, onSendHeaders, onHeadersReceived, onAuthRequired (when the server
 * asks for credentials), onBeforeRedirect (looping back to onBeforeRequest for the new URL)
 * or onResponseStarted, and finally onCompleted or onErrorOccurred. One `requestId` follows
 * a request through redirects and authentication retries. `file:` URLs only report
 * onBeforeRequest, onResponseStarted, onCompleted and onErrorOccurred; requests served
 * from the in-memory cache report nothing.
 *
 * MV3 grants normal extensions no blocking webRequest, so these streams never cancel,
 * redirect or rewrite a request; block or modify requests with declarative rules through
 * ChromeDeclarativeNetRequest. The one exception, supplying credentials to an
 * authentication challenge, is `answerAuthRequired`.
 *
 * Each stream takes Chrome's required `RequestFilter` and optional extra-info flags, such
 * as `"requestHeaders"`, `"responseHeaders"`, `"requestBody"` or `"extraHeaders"`, that add
 * fields to the details; flags are passed to Chrome only when given. Chrome validates the
 * filter's shape and the flags synchronously, so an unknown flag (`"securityInfo"` before
 * Chrome 144, say) fails the stream with a typed error. An invalid URL pattern or a missing
 * permission is only logged to the extension's console; the stream then receives nothing.
 * Events arrive only for requests whose URL, and initiator for subresources, the extension
 * has host permissions for.
 *
 * Listeners exist only while a stream runs and cannot wake an MV3 service worker; register
 * wake listeners synchronously through `ChromeServiceWorker.listen`, which passes the
 * `RequestFilter` but no extra-info flags. Each subscription buffers at most 64 events,
 * dropping the oldest, so busy pages can overflow it.
 */
export interface ChromeWebRequestService {
  /**
   * Flushes Chrome's in-memory cache after the behaviour of webRequest handlers changed,
   * so cached requests reach them again. Expensive: Chrome allows
   * `MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES` (20) calls per sustained
   * 10 minutes and warns about more. Adding or removing listeners does not need it.
   * Needs Chrome 116+, where it returns a Promise; earlier versions fail with a typed error.
   */
  readonly handlerBehaviorChanged: Effect.Effect<void, ChromeWebRequestError>
  /** Requests about to start; with `"requestBody"`, POST and PUT bodies too. */
  readonly onBeforeRequest: Observer<BeforeRequest, BeforeRequestSpec>
  /** Requests about to send their headers; `"requestHeaders"` adds them (some, like Authorization, are hidden). */
  readonly onBeforeSendHeaders: Observer<BeforeSendHeaders, BeforeSendHeadersSpec>
  /** Requests whose headers were just sent, including other extensions' modifications. */
  readonly onSendHeaders: Observer<SendHeaders, SendHeadersSpec>
  /** Responses whose headers arrived; `"securityInfo"` and `"securityInfoRawDer"` need Chrome 144+. */
  readonly onHeadersReceived: Observer<HeadersReceived, HeadersReceivedSpec>
  /**
   * Authentication challenges, observed without answering them. Repeats for the same
   * request when credentials are rejected.
   */
  readonly onAuthRequired: Observer<AuthRequired, AuthRequiredSpec>
  /** Responses whose first body byte arrived. */
  readonly onResponseStarted: Observer<ResponseStarted, ResponseStartedSpec>
  /** Requests that finished successfully. */
  readonly onCompleted: Observer<Completed, CompletedSpec>
  /** Requests that failed; `error` is a description Chrome does not keep stable, not a code to parse. */
  readonly onErrorOccurred: Observer<ErrorOccurred, ErrorOccurredSpec>
  /** Server-initiated redirects, before the request continues at `redirectUrl`. */
  readonly onBeforeRedirect: Observer<BeforeRedirect, BeforeRedirectSpec>
  /**
   * Answers authentication challenges for matching requests until the scope closes,
   * registering an `"asyncBlocking"` listener (plus any `extraInfoSpec` flags). Each
   * challenge runs `answer` in its own fiber with the caller's services and is answered
   * exactly once: with the answer's credentials or cancellation, or with no action (`{}`)
   * when `answer` dies, is interrupted, or is still running when the scope closes, and for
   * challenges that arrive while the listener is being removed. Handle failures inside
   * `answer`; an answer that never completes keeps the request waiting until the scope
   * closes. Rejected credentials raise a new challenge for the same `requestId`, so give up
   * after a few attempts rather than loop.
   *
   * Requires the `"webRequestAuthProvider"` permission; without it Chrome only logs an
   * error and never calls `answer`. The effect succeeds once the listener is registered and
   * fails with a typed `"onAuthRequired"` error when the event is missing or registration
   * throws. Like the streams, this listener cannot wake an MV3 service worker, so a
   * challenge that arrives while the worker is stopped gets Chrome's default handling.
   */
  readonly answerAuthRequired: <R>(
    filter: RequestFilter,
    answer: (details: AuthRequired) => Effect.Effect<AuthAnswer, never, R>,
    extraInfoSpec?: ReadonlyArray<AuthRequiredSpec>
  ) => Effect.Effect<void, ChromeWebRequestError, R | Scope.Scope>
  /**
   * Modifications this extension proposed that Chrome ignored because another extension's
   * conflicting one won. Chrome takes no filter for it.
   */
  readonly onActionIgnored: Stream.Stream<ActionIgnored, ChromeWebRequestError>
}

export class ChromeWebRequest extends Context.Service<ChromeWebRequest, ChromeWebRequestService>()(
  "effect-platform-chrome/ChromeWebRequest"
) {}

const invoke = invoker((operation, cause) => new ChromeWebRequestError({ operation, cause }))

const eventError = (operation: string) => (cause: unknown) => new ChromeWebRequestError({ operation, cause })

/** Reads an event, throwing when Chrome left it out so the failure is typed before any listener exists. */
const present = <Event>(operation: string, getEvent: () => Event | undefined): Event => {
  const event = getEvent()

  if (event === undefined) throw new Error(`chrome.webRequest.${operation} is unavailable in this context`)

  return event
}

const observer = <Details, Spec extends string>(
  operation: string,
  getEvent: () => WebRequestEvent<Details, Spec> | undefined
): Observer<Details, Spec> => (filter, extraInfoSpec) => observe(
  (): EventSource<[details: Details]> => {
    const event = present(operation, getEvent)

    return {
      // Pass extraInfoSpec only when given, never as an explicit undefined.
      addListener: (listener) => extraInfoSpec === undefined
        ? event.addListener(listener, filter)
        : event.addListener(listener, filter, [...extraInfoSpec]),
      removeListener: (listener) => event.removeListener(listener)
    }
  },
  (details) => details,
  eventError(operation)
)

/** A fresh empty answer per challenge: Chrome takes no action. */
const noAction = (): AuthAnswer => ({})

/** A fresh response with only the fields the answer sets, so Chrome never sees explicit undefineds. */
const responseOf = (answer: AuthAnswer): AuthAnswer => {
  const response: AuthAnswer = {}

  if (answer.cancel !== undefined) response.cancel = answer.cancel

  if (answer.authCredentials !== undefined) {
    response.authCredentials = { username: answer.authCredentials.username, password: answer.authCredentials.password }
  }

  return response
}

const answerer = (getEvent: () => AuthRequiredEvent | undefined) => <R>(
  filter: RequestFilter,
  answer: (details: AuthRequired) => Effect.Effect<AuthAnswer, never, R>,
  extraInfoSpec?: ReadonlyArray<AuthRequiredSpec>
): Effect.Effect<void, ChromeWebRequestError, R | Scope.Scope> => Effect.gen(function*() {
  const onError = eventError("onAuthRequired")
  const event = yield* Effect.try({ try: () => present("onAuthRequired", getEvent), catch: onError })
  // Each unanswered challenge's fallback, which answers it with no action.
  const unanswered = new Set<() => void>()
  let active = true

  // Finalizers run in reverse: remove the listener, interrupt running answers (which answer
  // with no action), then answer whatever never got a fiber.
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    for (const fallback of Array.from(unanswered)) fallback()
  }))

  const run = yield* FiberSet.makeRuntime<R>()

  const listener = (details: AuthRequired, asyncCallback?: AuthCallback) => {
    // Only "asyncBlocking" registrations receive a callback; without one there is nothing to answer.
    if (asyncCallback === undefined) return

    let answered = false

    const settle = (response: AuthAnswer) => {
      if (answered) return

      answered = true
      unanswered.delete(fallback)

      try {
        asyncCallback(response)
      } catch {
        // Chrome has no further use for this challenge (its request is gone); a throw here
        // must not stop the remaining challenges from being answered.
      }
    }

    const fallback = () => settle(noAction())

    if (!active) return fallback()

    unanswered.add(fallback)
    run(Effect.suspend(() => answer(details)).pipe(
      Effect.onExit((exit) => Effect.sync(() => settle(Exit.isSuccess(exit) ? responseOf(exit.value) : noAction()))),
      Effect.exit
    ))
  }

  const remove = Effect.sync(() => {
    active = false
    event.removeListener(listener)
  })

  const spec: Array<AuthRequiredSpec | "asyncBlocking"> = ["asyncBlocking", ...(extraInfoSpec ?? [])]

  yield* Effect.acquireRelease(
    // Remove at once if registration throws, since it may have partially succeeded.
    Effect.try({ try: () => event.addListener(listener, filter, spec), catch: onError }).pipe(Effect.onError(() => remove)),
    () => remove
  )
})

/** Creates the service without reading browser globals or registering listeners. */
export const make = (api: ChromeWebRequestApi): ChromeWebRequestService => ChromeWebRequest.of({
  handlerBehaviorChanged: invoke("handlerBehaviorChanged", () => api.handlerBehaviorChanged()),
  onBeforeRequest: observer("onBeforeRequest", () => api.onBeforeRequest),
  onBeforeSendHeaders: observer("onBeforeSendHeaders", () => api.onBeforeSendHeaders),
  onSendHeaders: observer("onSendHeaders", () => api.onSendHeaders),
  onHeadersReceived: observer("onHeadersReceived", () => api.onHeadersReceived),
  onAuthRequired: observer("onAuthRequired", () => api.onAuthRequired),
  onResponseStarted: observer("onResponseStarted", () => api.onResponseStarted),
  onCompleted: observer("onCompleted", () => api.onCompleted),
  onErrorOccurred: observer("onErrorOccurred", () => api.onErrorOccurred),
  onBeforeRedirect: observer("onBeforeRedirect", () => api.onBeforeRedirect),
  answerAuthRequired: answerer(() => api.onAuthRequired),
  onActionIgnored: observe(
    () => present("onActionIgnored", () => api.onActionIgnored),
    ({ action, requestId }: ActionIgnored): ActionIgnored => ({ action, requestId }),
    eventError("onActionIgnored")
  )
})

export const layer = (api: ChromeWebRequestApi): Layer.Layer<ChromeWebRequest> => Layer.succeed(ChromeWebRequest, make(api))

/** The global is read only when the layer is built, never at import time. */
export const layerLive: Layer.Layer<ChromeWebRequest, ChromeWebRequestError> = liveLayer(
  ChromeWebRequest, "webRequest", (chrome) => chrome.webRequest, make,
  (cause) => new ChromeWebRequestError({ operation: "initialize", cause })
)
