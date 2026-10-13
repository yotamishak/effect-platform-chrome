import { Effect, Schema } from "effect"
import type { Service } from "effect-platform-chrome/ChromeSchemaStorage"

export const Preferences = Schema.Struct({ text: Schema.String, revision: Schema.Int })
const Legacy = Schema.Struct({ greeting: Schema.String })
export const preferencesEntry = (service: Service, namespace = "wxt-schema-demo") => service.entry({
  namespace, key: "preferences", area: "local", version: 1, schema: Preferences,
  migrations: [{ from: 0, run: (payload) => Schema.decodeUnknownEffect(Legacy)(payload).pipe(
    Effect.map(({ greeting }) => ({ text: greeting, revision: 0 }))
  ) }]
})
