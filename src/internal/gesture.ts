import { Effect, Exit } from "effect"

/**
 * The user-gesture bridge behind every `xFromUserGesture` operation. Chrome honours some calls
 * (`permissions.request`, `sidePanel.open`, `downloads.open`) only while a user gesture is
 * active, and the gesture ends when the handler's synchronous stack returns. A lazy Effect
 * cannot guarantee it reaches Chrome in time, so the returned function calls Chrome NOW, on
 * the caller's stack, and returns an Effect that observes that one call:
 *
 * - both settlement handlers are attached immediately, so a rejection is never unhandled even
 *   if the Effect never runs;
 * - a synchronous throw, a rejection, or a result that is not a Promise becomes
 *   `onError(operation, cause)`, exactly as `invoker` maps it;
 * - every run of the Effect replays the same outcome and never calls Chrome again;
 * - interrupting a run stops waiting; it cannot cancel what Chrome has started.
 */
export const starter = <E>(onError: (operation: string, cause: unknown) => E) =>
  <A>(operation: string, run: () => PromiseLike<A>): Effect.Effect<A, E> => {
    try {
      const outcome = Promise.resolve(run().then(
        (value): Exit.Exit<A, E> => Exit.succeed(value),
        (cause): Exit.Exit<A, E> => Exit.fail(onError(operation, cause))
      ))

      return Effect.flatMap(Effect.promise(() => outcome), (exit) => exit)
    } catch (cause) {
      return Effect.fail(onError(operation, cause))
    }
  }
