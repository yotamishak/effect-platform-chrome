import { Cause, Effect, Layer, Option, type Scope } from "effect"
import * as ChromeAlarms from "effect-platform-chrome/ChromeAlarms"
import * as ChromeCookies from "effect-platform-chrome/ChromeCookies"
import * as ChromeIdentity from "effect-platform-chrome/ChromeIdentity"
import * as ChromeKeyValueStore from "effect-platform-chrome/ChromeKeyValueStore"
import * as ChromeNotifications from "effect-platform-chrome/ChromeNotifications"
import * as ChromePermissions from "effect-platform-chrome/ChromePermissions"
import * as ChromePort from "effect-platform-chrome/ChromePort"
import * as ChromeRuntime from "effect-platform-chrome/ChromeRuntime"
import * as ChromeSchemaStorage from "effect-platform-chrome/ChromeSchemaStorage"
import * as ChromeScripting from "effect-platform-chrome/ChromeScripting"
import * as ChromeStorage from "effect-platform-chrome/ChromeStorage"
import * as ChromeTabs from "effect-platform-chrome/ChromeTabs"
import * as ChromeWebNavigation from "effect-platform-chrome/ChromeWebNavigation"
import * as ChromeWindows from "effect-platform-chrome/ChromeWindows"

export interface LimitStage {
  readonly name: string
  readonly ok: boolean
  /** Why the stage could not run here; skipped stages count as neither passed nor failed. */
  readonly skipped?: string
  readonly completed: number
  readonly expected: number
  readonly milliseconds: number
  readonly details?: Readonly<Record<string, unknown>>
  readonly error?: string
}
export interface LimitsReport {
  readonly stages: ReadonlyArray<LimitStage>
  readonly failed: number
  readonly skipped: number
  readonly milliseconds: number
}
export interface LimitsOptions {
  /** Shows and clears real OS notifications; off by default. */
  readonly notifications?: boolean
  /** Only stages whose name contains one of these strings. */
  readonly only?: ReadonlyArray<string>
}

export interface Outcome {
  readonly completed: number
  readonly ok: boolean
  readonly skipped?: string
  readonly details?: Readonly<Record<string, unknown>>
}

/** The target tab the runner opens, by frame role. */
export interface Frames {
  readonly target: number
  readonly nav: number
  readonly top: number
  readonly children: ReadonlyArray<number>
  readonly other: number
  readonly silent: number
}

const storage = ChromeStorage.layerLive
export const layer = Layer.mergeAll(
  ChromeAlarms.layerLive, ChromeCookies.layerLive, ChromeIdentity.layerLive,
  ChromeKeyValueStore.layerLive({ namespace: "wxt-limits" }), ChromeNotifications.layerLive,
  ChromePermissions.layerLive, ChromePort.layerLive, ChromeRuntime.layerLive,
  ChromeSchemaStorage.layer.pipe(Layer.provide(storage)),
  ChromeScripting.layerLive, storage, ChromeTabs.layerLive, ChromeWebNavigation.layerLive,
  ChromeWindows.layerLive
)
export type Services = Layer.Success<typeof layer>

export type Stage = readonly [name: string, expected: number, effect: Effect.Effect<Outcome, unknown, Services | Scope.Scope>]

export const errorText = (error: unknown) => Cause.pretty(Cause.fail(error))
/** Chrome's own message: the adapters' typed errors keep it on their cause. */
export const chromeMessage = (error: unknown): string =>
  error instanceof Error && error.cause instanceof Error ? error.cause.message : errorText(error).split("\n")[0] ?? ""

export const poll = <A, E, R>(effect: Effect.Effect<Option.Option<A>, E, R>, attempts: number) =>
  Effect.gen(function*() {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const found = yield* effect
      if (Option.isSome(found)) return found.value
      yield* Effect.sleep("50 millis")
    }
    return yield* Effect.fail(new Error("Timed out waiting"))
  })
