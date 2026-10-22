import * as ChromeUserScripts from "../ChromeUserScripts.js"

export type UserScriptsOperation =
  | "register" | "update" | "unregister" | "getScripts"
  | "configureWorld" | "getWorldConfigurations" | "resetWorldConfiguration" | "execute"

/** One frame's outcome before `execute` shapes it, as Chrome's script executor reports it. */
export interface FrameOutcome {
  readonly frameId: number
  readonly documentId: string
  /** The value the script evaluated to; undefined or omitted is reported as `null`, as Chrome does. */
  readonly result?: ChromeUserScripts.InjectionResult["result"]
  /** Why the injection failed in this frame, such as a removed frame or missing host access. */
  readonly error?: string
}

/** Decides which frames an `execute` call reached and what each one evaluated to. */
export type FrameResponder = (
  injection: ChromeUserScripts.UserScriptInjection
) => ReadonlyArray<FrameOutcome> | Promise<ReadonlyArray<FrameOutcome>>

/** The synchronous throw every fixture call raises while `controls.setAccess(false)` is in effect. */
export const accessOffMessage = "The userScripts API is turned off for this extension (fixture)"

/** Chrome's limit on configured user script worlds per extension. */
export const maxWorlds = 100

const maxWorldIdLength = 256

/** Chrome's world id rules; returns the id with `""` normalized to the default world (undefined). */
const worldIdOf = (world: ChromeUserScripts.ExecutionWorld | undefined, worldId: string | undefined): string | undefined => {
  if (worldId === undefined) return undefined

  if (world === "MAIN") throw new Error("World ID can only be specified for USER_SCRIPT worlds.")

  if (worldId === "") return undefined

  if (worldId.startsWith("_")) throw new Error("World IDs beginning with '_' are reserved.")

  if (worldId.length > maxWorldIdLength) throw new Error(`World IDs must be at most ${maxWorldIdLength} characters.`)

  return worldId
}

const checkScriptId = (id: string) => {
  if (id === "") throw new Error("Script's ID must not be empty")

  if (id.startsWith("_")) throw new Error(`Script's ID '${id}' must not start with '_'`)
}

const checkSources = (sources: ReadonlyArray<ChromeUserScripts.ScriptSource> | undefined, subject: string) => {
  if (sources === undefined || sources.length === 0) throw new Error(`${subject} must specify at least one js source.`)

  // Both members may arrive from untyped callers, so check presence rather than trusting the union.
  for (const source of sources) {
    if ((source.code === undefined) === (source.file === undefined)) {
      throw new Error(`${subject} must specify exactly one of 'code' or 'file' as a js source.`)
    }
  }
}

/** Chrome's `ParseUserScript`: validates, then stores the script with its defaults filled in. */
const parse = (script: ChromeUserScripts.RegisteredUserScript): ChromeUserScripts.RegisteredUserScript => {
  const subject = `User script with ID '${script.id}'`

  if (script.matches === undefined) throw new Error(`${subject} must specify 'matches'.`)

  checkSources(script.js, subject)

  const worldId = worldIdOf(script.world, script.worldId)

  // Chrome parses match patterns after its own user-script checks.
  if (script.matches.length === 0) throw new Error(`Script with ID '${script.id}' must specify at least one match.`)

  const parsed: ChromeUserScripts.RegisteredUserScript = {
    id: script.id,
    matches: [...script.matches],
    js: structuredClone(script.js ?? []),
    allFrames: script.allFrames ?? false,
    runAt: script.runAt ?? "document_idle",
    world: script.world ?? "USER_SCRIPT"
  }

  if (script.excludeMatches !== undefined) parsed.excludeMatches = [...script.excludeMatches]

  if (script.includeGlobs !== undefined) parsed.includeGlobs = [...script.includeGlobs]

  if (script.excludeGlobs !== undefined) parsed.excludeGlobs = [...script.excludeGlobs]

  if (worldId !== undefined) parsed.worldId = worldId

  return parsed
}

/** Chrome's `ApplyUpdate`: supplied fields win, except the globs, which an update never changes. */
const merge = (
  current: ChromeUserScripts.RegisteredUserScript,
  next: ChromeUserScripts.RegisteredUserScript
): ChromeUserScripts.RegisteredUserScript => {
  const merged = structuredClone(current)

  if (next.runAt !== undefined) merged.runAt = next.runAt

  if (next.allFrames !== undefined) merged.allFrames = next.allFrames

  if (next.matches !== undefined) merged.matches = next.matches

  if (next.excludeMatches !== undefined) merged.excludeMatches = next.excludeMatches

  if (next.js !== undefined) merged.js = next.js

  if (next.world !== undefined) merged.world = next.world

  if (next.worldId !== undefined) merged.worldId = next.worldId

  return merged
}

/** Chrome's `CanAccessTarget` order: `allFrames` with ids is refused before mixed ids. */
const checkTarget = (target: ChromeUserScripts.InjectionTarget) => {
  const frameIds = "frameIds" in target ? target.frameIds : undefined
  const documentIds = "documentIds" in target ? target.documentIds : undefined

  if (target.allFrames === true && (frameIds !== undefined || documentIds !== undefined)) {
    throw new Error("Cannot specify 'allFrames' if either 'frameIds' or 'documentIds' is specified.")
  }

  if (frameIds !== undefined && documentIds !== undefined) throw new Error("Cannot specify both 'frameIds' and 'documentIds'.")
}

/** Chrome's result shaping: one failed frame fails the call; otherwise failed frames are dropped, top frame first. */
const reportFrames = (outcomes: ReadonlyArray<FrameOutcome>): Array<ChromeUserScripts.InjectionResult> => {
  const [only] = outcomes

  if (outcomes.length === 1 && only?.error !== undefined) throw new Error(only.error)

  const results: Array<ChromeUserScripts.InjectionResult> = []

  for (const outcome of outcomes) {
    if (outcome.error !== undefined) continue

    // Chrome serializes the completion value, reporting undefined as null and never sharing objects.
    const result: ChromeUserScripts.InjectionResult = {
      frameId: outcome.frameId, documentId: outcome.documentId, result: structuredClone(outcome.result ?? null)
    }

    if (outcome.frameId === 0) results.unshift(result)
    else results.push(result)
  }

  return results
}

const encoder = new TextEncoder()

/** Chrome keeps world configurations in a dictionary, so it lists them by the key's UTF-8 bytes. */
const byteOrder = (left: string, right: string): number => {
  const leftBytes = encoder.encode(left)
  const rightBytes = encoder.encode(right)

  for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index++) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0)

    if (difference !== 0) return difference
  }

  return leftBytes.length - rightBytes.length
}

/** The dictionary key Chrome stores a world under; the default world's is `_default`. */
const worldKey = (worldId: string) => worldId === "" ? "_default" : worldId

const worldEntry = (worldId: string, properties: { readonly csp: string | undefined, readonly messaging: boolean }) => {
  const entry: ChromeUserScripts.WorldProperties = { messaging: properties.messaging }

  if (properties.csp !== undefined) entry.csp = properties.csp

  if (worldId !== "") entry.worldId = worldId

  return entry
}

/**
 * An in-memory `chrome.userScripts` (Chrome 135+) with Chrome's validation: `register`
 * rejects empty, reserved (`_`) and duplicate ids, a missing `matches`, an empty `js`, a
 * source with both or neither of `code` and `file`, an invalid `worldId` and an empty
 * `matches`, all before registering anything; stored scripts get Chrome's defaults
 * (`allFrames: false`, `runAt: "document_idle"`, `world: "USER_SCRIPT"`). `update` checks its
 * ids like `register` (repeats included), is atomic, rejects unknown ids, moves updated
 * scripts to the end and, like Chrome, never changes `includeGlobs` or `excludeGlobs`. `unregister` rejects unknown ids atomically
 * and removes everything without `ids`. Worlds follow Chrome: a configuration is stored only
 * when it differs from the default, worlds are listed by the UTF-8 bytes of their key (the
 * default world's is `_default`), `configureWorld` refuses once `maxWorlds` are configured,
 * and resets of unconfigured worlds succeed. `execute` validates the injection, rejects with
 * `No tab with id` without a `controls.respond` responder, validates the target, asks the
 * responder for per-frame outcomes, then shapes them like Chrome, cloning each result. The
 * syntax of match patterns and file paths is not validated. `controls.setAccess(false)` makes every call
 * throw synchronously, as Chrome does once the user revokes access.
 */
export const makeUserScripts = (overrides: Partial<ChromeUserScripts.ChromeUserScriptsApi> = {}) => {
  const scripts = new Map<string, ChromeUserScripts.RegisteredUserScript>()
  const worlds = new Map<string, { readonly csp: string | undefined, readonly messaging: boolean }>()
  const failures = new Map<UserScriptsOperation, Array<Error>>()
  let access = true
  let responder: FrameResponder | undefined

  /** Throws synchronously while access is off; otherwise returns a queued rejection, if any. */
  const enter = (operation: UserScriptsOperation): Promise<never> | undefined => {
    if (!access) throw new Error(accessOffMessage)

    const failure = failures.get(operation)?.shift()

    return failure === undefined ? undefined : Promise.reject(failure)
  }

  const register = async (batch: Array<ChromeUserScripts.RegisteredUserScript>) => {
    const ids = new Set<string>()

    for (const script of batch) {
      checkScriptId(script.id)

      if (scripts.has(script.id) || ids.has(script.id)) throw new Error(`Duplicate script ID '${script.id}'`)

      ids.add(script.id)
    }

    for (const script of batch.map(parse)) scripts.set(script.id, script)
  }

  const update = async (batch: Array<ChromeUserScripts.RegisteredUserScript>) => {
    const ids = new Set<string>()

    // Like register, Chrome validates every id, and refuses repeats, before looking any script up.
    for (const script of batch) {
      checkScriptId(script.id)

      if (ids.has(script.id)) throw new Error(`Duplicate script ID '${script.id}'`)

      ids.add(script.id)
    }

    const merged = batch.map((script) => {
      const current = scripts.get(script.id)

      if (current === undefined) throw new Error(`Script with ID '${script.id}' does not exist or is not fully registered`)

      return { current, next: script }
    }).map(({ current, next }) => parse(merge(current, next)))

    // Chrome removes the old scripts and adds the updated ones after the rest, in batch order.
    for (const script of merged) scripts.delete(script.id)

    for (const script of merged) scripts.set(script.id, script)
  }

  const unregister = async (filter?: ChromeUserScripts.UserScriptFilter) => {
    if (filter?.ids === undefined) {
      scripts.clear()

      return
    }

    for (const id of filter.ids) {
      checkScriptId(id)

      if (!scripts.has(id)) throw new Error(`Nonexistent script ID '${id}'`)
    }

    for (const id of filter.ids) scripts.delete(id)
  }

  const getScripts = async (filter?: ChromeUserScripts.UserScriptFilter) => {
    const ids = filter?.ids === undefined ? undefined : new Set(filter.ids)

    return structuredClone(Array.from(scripts.values()).filter((script) => ids === undefined || ids.has(script.id)))
  }

  const configureWorld = async (properties: ChromeUserScripts.WorldProperties) => {
    const key = worldIdOf("USER_SCRIPT", properties.worldId) ?? ""

    if (worlds.size >= maxWorlds) throw new Error(`You may only configure up to ${maxWorlds} individual user script worlds.`)

    const current = worlds.get(key) ?? { csp: undefined, messaging: false }
    const next = { csp: properties.csp ?? current.csp, messaging: properties.messaging ?? current.messaging }

    if (next.csp !== current.csp || next.messaging !== current.messaging) worlds.set(key, next)
  }

  const listWorlds = () => Array.from(worlds)
    .sort(([left], [right]) => byteOrder(worldKey(left), worldKey(right)))
    .map(([worldId, properties]) => worldEntry(worldId, properties))

  const resetWorldConfiguration = async (worldId?: string) => {
    worlds.delete(worldIdOf("USER_SCRIPT", worldId) ?? "")
  }

  const execute = async (injection: ChromeUserScripts.UserScriptInjection) => {
    checkSources(injection.js, "User script")
    worldIdOf(injection.world, injection.worldId)

    // Chrome looks the tab up before validating the rest of the target.
    if (responder === undefined) throw new Error(`No tab with id: ${injection.target.tabId}`)

    checkTarget(injection.target)

    return reportFrames(await responder(structuredClone(injection)))
  }

  const api: ChromeUserScripts.ChromeUserScriptsApi = {
    register: (batch) => enter("register") ?? register(structuredClone(batch)),
    update: (batch) => enter("update") ?? update(structuredClone(batch)),
    unregister: (...filter) => enter("unregister") ?? unregister(...filter),
    getScripts: (...filter) => enter("getScripts") ?? getScripts(...filter),
    configureWorld: (properties) => enter("configureWorld") ?? configureWorld(properties),
    getWorldConfigurations: () => enter("getWorldConfigurations") ?? Promise.resolve(listWorlds()),
    resetWorldConfiguration: (...worldId) => enter("resetWorldConfiguration") ?? resetWorldConfiguration(...worldId),
    execute: (injection) => enter("execute") ?? execute(injection),
    ...overrides
  }

  return {
    api,
    layer: ChromeUserScripts.layer(api),
    controls: {
      /** A snapshot of every registered script, in `getScripts` order (updated scripts move to the end). */
      scripts: (): Array<ChromeUserScripts.RegisteredUserScript> => structuredClone(Array.from(scripts.values())),
      /** A snapshot of every configured world, as `getWorldConfigurations` reports them. */
      worlds: (): Array<ChromeUserScripts.WorldProperties> => listWorlds(),
      /** Turns the user's access off (every call throws synchronously) or back on. */
      setAccess: (enabled: boolean) => { access = enabled },
      /** Decides each later `execute` call's per-frame outcomes. */
      respond: (next: FrameResponder) => { responder = next },
      /** Rejects the next call of `operation` with `cause`, after the access check. */
      failNext: (operation: UserScriptsOperation, cause: Error) => {
        const queue = failures.get(operation) ?? []
        queue.push(cause)
        failures.set(operation, queue)
      }
    }
  }
}
