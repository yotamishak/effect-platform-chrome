import { Context, Effect, Exit, Layer, Queue, Schema, Stream } from "effect"

export class ChromePermissionsError extends Schema.TaggedError<ChromePermissionsError>()("ChromePermissionsError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

/** Promise-based MV3 permissions subset; no host-access UI APIs. */
export interface ChromePermissionsApi {
  getAll(): Promise<chrome.permissions.Permissions>
  contains(permissions: chrome.permissions.Permissions): Promise<boolean>
  request(permissions: chrome.permissions.Permissions): Promise<boolean>
  remove(permissions: chrome.permissions.Permissions): Promise<boolean>
  readonly onAdded: Pick<typeof chrome.permissions.onAdded, "addListener" | "removeListener">
  readonly onRemoved: Pick<typeof chrome.permissions.onRemoved, "addListener" | "removeListener">
}

export interface ChromePermissionsService {
  readonly getAll: Effect.Effect<chrome.permissions.Permissions, ChromePermissionsError>
  readonly contains: (permissions: chrome.permissions.Permissions) => Effect.Effect<boolean, ChromePermissionsError>
  /** Lazy: caller must ensure execution reaches Chrome within a user gesture. */
  readonly request: (permissions: chrome.permissions.Permissions) => Effect.Effect<boolean, ChromePermissionsError>
  /** Explicit native boundary: starts the request NOW, not when the returned Effect runs. */
  readonly requestFromUserGesture: (permissions: chrome.permissions.Permissions) => Effect.Effect<boolean, ChromePermissionsError>
  readonly remove: (permissions: chrome.permissions.Permissions) => Effect.Effect<boolean, ChromePermissionsError>
  readonly onAdded: Stream.Stream<chrome.permissions.Permissions, ChromePermissionsError>
  readonly onRemoved: Stream.Stream<chrome.permissions.Permissions, ChromePermissionsError>
}

export class ChromePermissions extends Context.Service<ChromePermissions, ChromePermissionsService>()("effect-platform-chrome/ChromePermissions") {}

const invoke = <A>(operation: string, run: () => Promise<A>): Effect.Effect<A, ChromePermissionsError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ChromePermissionsError({ operation, cause })
  })

/** Attach both settlement handlers immediately, even if the returned Effect is never run. */
const requestImmediately = (
  api: ChromePermissionsApi,
  permissions: chrome.permissions.Permissions
): Effect.Effect<boolean, ChromePermissionsError> => {
  try {
    const outcome: Promise<Exit.Exit<boolean, ChromePermissionsError>> = api.request(permissions).then(
      (granted) => Exit.succeed(granted),
      (cause) => Exit.fail(new ChromePermissionsError({ operation: "request", cause }))
    )

    return Effect.flatMap(Effect.promise(() => outcome), (exit) => exit)
  } catch (cause) {
    return Effect.fail(new ChromePermissionsError({ operation: "request", cause }))
  }
}

const observe = (
  operation: "onAdded" | "onRemoved",
  getSource: () => ChromePermissionsApi["onAdded"]
): Stream.Stream<chrome.permissions.Permissions, ChromePermissionsError> => Stream.callback((queue) => {
  let active = true

  const listener = (permissions: chrome.permissions.Permissions) => {
    if (active) Queue.offerUnsafe(queue, permissions)
  }

  return Effect.gen(function*() {
    const source = yield* Effect.try({
      try: getSource,
      catch: (cause) => new ChromePermissionsError({ operation, cause })
    })

    // Cleanup must already exist if registration inserts the listener then throws.
    yield* Effect.acquireRelease(
      Effect.succeed(listener),
      () => Effect.sync(() => {
        active = false
        source.removeListener(listener)
      })
    )
    yield* Effect.try({
      try: () => source.addListener(listener),
      catch: (cause) => new ChromePermissionsError({ operation, cause })
    })
  })
}, { bufferSize: 64, strategy: "sliding" })

/**
 * Each consumption owns a scoped listener. At most 64 pending events are retained;
 * overflow drops the oldest because native Chrome callbacks cannot backpressure.
 * These streams are observations, not synchronous MV3 wakeup registrations.
 */
export const make = (api: ChromePermissionsApi): ChromePermissionsService => ChromePermissions.of({
  getAll: invoke("getAll", () => api.getAll()),
  contains: (permissions) => invoke("contains", () => api.contains(permissions)),
  request: (permissions) => invoke("request", () => api.request(permissions)),
  requestFromUserGesture: (permissions) => requestImmediately(api, permissions),
  remove: (permissions) => invoke("remove", () => api.remove(permissions)),
  onAdded: observe("onAdded", () => api.onAdded),
  onRemoved: observe("onRemoved", () => api.onRemoved)
})

export const layer = (api: ChromePermissionsApi): Layer.Layer<ChromePermissions> => Layer.succeed(ChromePermissions, make(api))

/** The global is accessed only when this layer is built. */
export const layerLive: Layer.Layer<ChromePermissions, ChromePermissionsError> = Layer.effect(ChromePermissions, Effect.try({
  try: () => {
    const api = typeof chrome === "undefined" ? undefined : chrome.permissions

    if (api === undefined) {
      throw new Error("chrome.permissions is unavailable in this context")
    }

    return make(api)
  },
  catch: (cause) => new ChromePermissionsError({ operation: "initialize", cause })
}))
