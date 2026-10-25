// Fresh development fixtures. The opt-in ChromeTesting stress runner also invokes
// this in the popup; those checks remain fixture tests, not native Chrome tests.
import { Effect, Layer, Option, Schema, Stream } from "effect"
import * as ChromeTesting from "effect-platform-chrome/ChromeTesting"
import * as ChromeSchemaStorage from "effect-platform-chrome/ChromeSchemaStorage"
import { preferencesEntry } from "../shared/schema-entry.js"

class FixtureFailure extends Schema.TaggedError<FixtureFailure>()("FixtureFailure", {
  message: Schema.String
}) {}

export const fixtureExample = Effect.fn("fixtureExample")(function*() {
  // Always create fresh fixtures; never share mutable state between test cases.
  const storage = ChromeTesting.makeStorage()
  const schemaLayer = ChromeSchemaStorage.layer.pipe(Layer.provide(storage.layer))

  const observed = yield* Effect.gen(function*() {
    const service = yield* ChromeSchemaStorage.ChromeSchemaStorage
    const entry = preferencesEntry(service, "development-fixture")
    storage.controls.seed("local", {
      [entry.storageKey]: { version: 0, payload: { greeting: "fixture" } }
    })
    yield* entry.get({ writeBack: true })

    // take(1) ends the subscription and closes its registration scope.
    return yield* Stream.runCollect(entry.observe.pipe(Stream.take(1)))
  }).pipe(Effect.provide(schemaLayer))

  if (storage.controls.onChanged.listenerCount !== 0) return yield* new FixtureFailure({ message: "Fixture listener not released" })

  const first = observed[0]

  if (first === undefined || Option.isNone(first) || first.value.text !== "fixture") {
    return yield* new FixtureFailure({ message: "Fixture migration failed" })
  }

  const event = ChromeTesting.makeEvent<[number]>()
  let received = 0
  const listener = (number: number) => { received = number }

  event.api.addListener(listener)
  event.controls.emit(7)
  event.api.removeListener(listener)

  // Port deliveries are manually gated: no sleep or scheduler-turn assumptions.
  const pair = ChromeTesting.makePortPair("development")
  let frames = 0
  const onMessage = () => { frames++ }

  pair.right.port.onMessage.addListener(onMessage)
  pair.left.port.postMessage({ hello: "fixture" })
  pair.controls.flush()
  pair.right.port.onMessage.removeListener(onMessage)
  pair.controls.disconnect()
  pair.controls.flush()

  return { observed, received, frames, listeners: storage.controls.onChanged.listenerCount,
    pendingFrames: pair.controls.pendingCount }
})
