import { Cause, Effect, Exit, Option, Schema } from "effect"
import * as RpcClient from "effect/rpc/RpcClient"
import * as ChromeMessage from "effect-platform-chrome/ChromeMessage"
import * as ChromeRpc from "effect-platform-chrome/ChromeRpc"
import * as ChromeRuntime from "effect-platform-chrome/ChromeRuntime"
import { fixtureExample } from "../../development/fixtures.js"
import { DemoRpc, rpcChannel } from "../../shared/rpc.js"

export const utilityModules: string[] = ["ChromeMessage", "ChromeTesting", "ChromeRpc-edgecases", "ChromeRuntime-edgecases"]

interface Check {
  readonly name: string
  readonly ok: boolean
  readonly completed?: number | undefined
  readonly error?: string | undefined
}

// Serialize raw test envelopes exactly as Chrome's JSON messaging boundary does;
// callers immediately decode the resulting wire value with the response schema.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
const jsonRoundtrip = (value: unknown): Schema.Json => Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(value)))

export interface UtilityReport {
  module: string
  boundary: string
  passed: boolean
  checks: Check[]
  milliseconds: number
}

/** Run in a persistent extension page so the host survives until cleanup completes. */
export async function runUtilityModule(name: string): Promise<UtilityReport> {
  const checks: Check[] = []
  const started = performance.now()
  let boundary = "in-browser library/schema execution; no native Chrome calls"

  const record = (label: string, ok: boolean, completed?: number, error?: string) => {
    checks.push({ name: label, ok, completed, error })
  }

  const inspect = <A, E>(label: string, exit: Exit.Exit<A, E>) => {
    record(label, Exit.isSuccess(exit), undefined, Exit.isFailure(exit) ? Cause.pretty(exit.cause) : undefined)
  }

  try {
    switch (name) {
      case "ChromeMessage": {
        const Value = Schema.Struct({ index: Schema.FiniteFromString, text: Schema.String })
        const codes = ChromeMessage.ErrorCode.literals
        const counts = [0, 0, 0, 0]
        const failed = [0, 0, 0, 0]
        const labels = ["value schema/JSON roundtrip", "typed failure schema/JSON roundtrip", "void schema/JSON roundtrip", "malformed JSON envelope rejected"]
        await Effect.runPromise(Effect.gen(function*() {
          for (let i = 0; i < 5000; i++) {
            const kind = i % 4

            const result = yield* Effect.exit(Effect.gen(function*() {
              if (kind === 0) {
                const value = { index: i, text: `Unicode ✓ 空\u0000 ${i}` }
                const encoded = yield* Schema.encodeEffect(ChromeMessage.Response(Value))(ChromeMessage.succeed(value))
                const wire = jsonRoundtrip(encoded)
                const decoded = yield* ChromeMessage.decodeResponse(Value)(wire)
                const envelope = yield* Schema.decodeUnknownEffect(ChromeMessage.Response(Value))(wire)

                return decoded.index === i && decoded.text === value.text && envelope.ok && envelope.value.index === i
              }

              if (kind === 1) {
                const code = codes[Math.floor(i / 4) % codes.length]!
                const error = { code, message: `failure ${i}` }
                const encoded = yield* Schema.encodeEffect(ChromeMessage.Response(Value))(ChromeMessage.fail(error))
                const wire = jsonRoundtrip(encoded)
                const envelope = yield* Schema.decodeUnknownEffect(ChromeMessage.Response(Value))(wire)

                return yield* ChromeMessage.decodeResponse(Value)(wire).pipe(Effect.match({
                  onSuccess: () => false,
                  onFailure: (failure) => failure instanceof ChromeMessage.ChromeMessageError &&
                    failure.code === code && failure.message === error.message && !envelope.ok && envelope.error.code === code
                }))
              }

              if (kind === 2) {
                const encoded = yield* Schema.encodeEffect(ChromeMessage.Response(Schema.Void))(ChromeMessage.succeed(undefined))
                const wire = jsonRoundtrip(encoded)
                const value = yield* ChromeMessage.decodeResponse(Schema.Void)(wire)
                const envelope = yield* Schema.decodeUnknownEffect(ChromeMessage.Response(Schema.Void))(wire)

                return JSON.stringify(wire) === '{"ok":true}' && value === undefined && envelope.ok && envelope.value === undefined
              }

              const malformed = [null, [], {}, { ok: "true", value: i }, { ok: true, value: { index: "bad", text: "" } },
                { ok: false, error: { code: "Unknown", message: "bad" } }, { ok: true }]

              const wire = jsonRoundtrip(malformed[Math.floor(i / 4) % malformed.length])

              return yield* ChromeMessage.decodeResponse(Value)(wire).pipe(Effect.match({
                onSuccess: () => false,
                onFailure: (error) => error instanceof Schema.SchemaError
              }))
            }))

            counts[kind] = counts[kind]! + 1

            if (Exit.isFailure(result) || !result.value) {
              failed[kind] = failed[kind]! + 1

              if (failed[kind]! <= 3) record(`${labels[kind]} case ${i}`, false, undefined,
                Exit.isFailure(result) ? Cause.pretty(result.cause) : "Decoded outcome violated the expected invariant")
            }
          }
        }).pipe(Effect.timeout("30 seconds")))

        for (let i = 0; i < labels.length; i++) record(labels[i]!, counts[i] === 1250 && failed[i] === 0, counts[i])
        record("5000 cases completed", counts.reduce((a, b) => a + b, 0) === 5000, 5000)
        record("cleanup: no listeners, ports or browser resources acquired", true)
        break
      }

      case "ChromeTesting": {
        boundary = "in-browser fixtures, NOT native Chrome; fixtureExample creates fresh fixtures for each call"
        await Effect.runPromise(Effect.gen(function*() {
          for (let i = 0; i < 100; i++) {
            const exit = yield* Effect.exit(fixtureExample().pipe(Effect.timeout("2 seconds")))

            if (Exit.isFailure(exit)) {
              inspect(`fresh fixture ${i}: execution and cleanup`, exit)
              continue
            }

            const result = exit.value
            const observed = result.observed[0]
            record(`fresh fixture ${i}: migration, event and port delivery`, result.observed.length === 1 &&
              observed !== undefined && Option.isSome(observed) && observed.value.text === "fixture" &&
              result.received === 7 && result.frames === 1)
            record(`fresh fixture ${i}: cleanup (storage listeners and pending port frames)`, result.listeners === 0 && result.pendingFrames === 0)
          }
        }).pipe(Effect.timeout("30 seconds")))
        record("100 fresh fixtureExample calls completed", true, 100)
        break
      }

      case "ChromeRpc-edgecases": {
        boundary = "actual Chrome runtime ports and actual ChromeRpc/RpcClient; dedicated connections to the demo RPC worker"

        const connect = (label: string, maxFrameLength?: number) => Effect.gen(function*() {
          const native = yield* Effect.acquireRelease(
            Effect.try(() => chrome.runtime.connect({ name: rpcChannel })),
            (port) => Effect.sync(() => {
              // Runs after the protocol finalizer, including readiness timeout interruption.
              record(`${label}: protocol listeners removed`, !port.onMessage.hasListeners() && !port.onDisconnect.hasListeners())

              try {
                port.disconnect()
                record(`${label}: native disconnect cleanup completed`, true)
              } catch (error) {
                record(`${label}: native disconnect cleanup completed`, false, undefined, String(error))
              }
            })
          )

          const protocol = yield* ChromeRpc.makeClientProtocol(chrome.runtime, native, "owned",
            maxFrameLength === undefined ? {} : { maxFrameLength })

          // The pinned Effect v4 RPC integration exercises the actual browser transport.
          // oxlint-disable-next-line effecttsgo/unstable-api-usage
          const clientEffect = RpcClient.make(DemoRpc)

          // Protocol is the matching pinned RPC client's transport service.
          // oxlint-disable-next-line effecttsgo/unstable-api-usage
          const client = yield* clientEffect.pipe(Effect.provideService(RpcClient.Protocol, protocol))

          return yield* client.Ping({ text: label })
        })

        const control = await Effect.runPromiseExit(connect("control").pipe(Effect.scoped, Effect.timeout("3 seconds")))
        inspect("control: normal frame limit reaches a live RPC peer", control)

        if (Exit.isSuccess(control)) record("control: echo correlation", control.value === "control")
        const probeStarted = performance.now()

        const probe = await Effect.runPromise(connect("tiny-frame", 1).pipe(
          Effect.exit, Effect.timeoutOption("500 millis"), Effect.scoped
        ))

        const elapsed = performance.now() - probeStarted
        record("tiny-frame: probe and scope cleanup returned within 2 seconds", elapsed < 2000)
        record("invariant: locally unsendable readiness frame fails promptly instead of stalling", Option.isSome(probe) && Exit.isFailure(probe.value),
          undefined, Option.isNone(probe)
            ? `FAILED INVARIANT: maxFrameLength=1 accepted, then readiness stalled until the explicit 500ms deadline (${Math.round(elapsed)}ms including cleanup)`
            : Exit.isSuccess(probe.value) ? "Unexpected successful call with a one-code-unit frame limit" : Cause.pretty(probe.value.cause))
        break
      }

      case "ChromeRuntime-edgecases": {
        boundary = "iframe cross-realm callable with INJECTED sendMessage API; boundary test, NOT a native Chrome send"
        const iframe = document.createElement("iframe")
        iframe.hidden = true

        try {
          document.body.append(iframe)
          // Keep the foreign-realm function intact: binding would invalidate this regression.
          // oxlint-disable-next-line typescript/unbound-method
          const callable = iframe.contentWindow?.setTimeout
          // Probe the raw foreign window boundary, including its actual callable representation.
          // oxlint-disable-next-line anti-slop/no-runtime-typeof
          const crossRealmCallable = typeof callable === "function" && !(callable instanceof Function)
          record("iframe provides a cross-realm callable", crossRealmCallable)

          if (!crossRealmCallable) break
          let injectedCalls = 0

          const runtime = ChromeRuntime.make({
            ...chrome.runtime,
            sendMessage: async () => { injectedCalls++;

 return "injected-only" }
          })

          const exit = await Effect.runPromiseExit(runtime.sendMessage(callable))
          record("invariant: cross-realm function rejected before the injected API", injectedCalls === 0 && Exit.isFailure(exit),
            injectedCalls, injectedCalls > 0 ? "FAILED INVARIANT: instanceof Function guard admitted a foreign-realm callable" :
              Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "Unexpected successful function send")
          record("no native sendMessage was invoked by this boundary test", true)
        } finally {
          iframe.remove()
          record("cleanup: iframe removed", !iframe.isConnected)
        }

        break
      }

      default:
        record("known utility module", false, undefined, `Unknown utility module: ${name}`)
    }
  } catch (error) {
    record("module execution", false, undefined, error instanceof Error ? error.message : String(error))
  }

  return { module: name, boundary, passed: checks.length > 0 && checks.every((check) => check.ok),
    checks, milliseconds: performance.now() - started }
}
