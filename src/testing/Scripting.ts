import * as ChromeScripting from "../ChromeScripting.js"

// Injected values cross a serialization boundary: arguments, results and failure causes are
// raw values until the fixture or its consumer shapes them.
/* oxlint-disable anti-slop/no-unknown-parameters */

export type ScriptingOperation =
  | "executeScript" | "insertCSS" | "removeCSS"
  | "registerContentScripts" | "getRegisteredContentScripts" | "updateContentScripts" | "unregisterContentScripts"

/** One frame of a simulated tab. Frame 0 is the tab's main frame. */
export interface ScriptingFrame {
  readonly frameId: number
  readonly documentId: string
  /** The frame's URL. Chrome refuses to script `chrome://` pages and the Chrome Web Store. */
  readonly url?: string
  /** Fails every injection into this frame with this message, as missing host access would. */
  readonly error?: string
}

/** A value that survives Chrome's serialization of arguments and results. */
export type SerializableValue = null | boolean | number | string | ReadonlyArray<SerializableValue> | SerializableObject

export interface SerializableObject {
  readonly [key: string]: SerializableValue
}

/** What a packaged JavaScript file evaluates to in a frame. */
export type FileEvaluator = (frame: ScriptingFrame) => SerializableValue

/** One stylesheet `insertCSS` put into a frame's document. */
export interface InsertedStyle {
  readonly tabId: number
  readonly frameId: number
  readonly documentId: string
  readonly origin: ChromeScripting.StyleOrigin
  readonly css?: string
  readonly files?: ReadonlyArray<string>
}

type FrameOutcome =
  | { readonly frame: ScriptingFrame, readonly value: SerializableValue }
  | { readonly frame: ScriptingFrame, readonly error: string }

interface Hold {
  readonly enter: () => void
  readonly gate: Promise<void>
}

const mainFrameId = 0

const restrictedPrefixes: ReadonlyArray<readonly [string, string]> = [
  ["chrome://", "Cannot access a chrome:// URL"],
  ["https://chromewebstore.google.com/", "The extensions gallery cannot be scripted."],
  ["https://chrome.google.com/webstore", "The extensions gallery cannot be scripted."]
]

/** Why Chrome cannot inject into `frame`, if it cannot. */
const accessError = (frame: ScriptingFrame): string | undefined => {
  if (frame.error !== undefined) return frame.error

  const url = frame.url ?? ""

  return restrictedPrefixes.find(([prefix]) => url.startsWith(prefix))?.[1]
}

const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)

/** Chrome serializes values roughly as JSON: `undefined` and functions become `null`. */
const serialize = (value: unknown): SerializableValue => {
  const text = JSON.stringify(value)

  return text === undefined ? null : JSON.parse(text)
}

const checkScriptId = (id: string) => {
  if (id === "") throw new Error("Script's ID must not be empty")

  if (id.startsWith("_")) throw new Error(`Script's ID '${id}' must not start with '_'`)
}

/** Chrome's `GetFileResources`: at least one file, no repeats, each one packaged. */
const checkFiles = (files: ReadonlyArray<string>, packaged: ReadonlyMap<string, FileEvaluator | undefined>) => {
  if (files.length === 0) throw new Error("At least one file must be specified.")

  const seen = new Set<string>()

  for (const file of files) {
    if (seen.has(file)) throw new Error(`Duplicate file specified: '${file}'.`)

    seen.add(file)

    if (!packaged.has(file)) throw new Error(`Could not load file: '${file}'.`)
  }
}

/** Chrome's `ParseUserScript` checks, then the script as `getRegisteredContentScripts` reports it. */
const parse = (script: ChromeScripting.RegisteredContentScript): ChromeScripting.RegisteredContentScript => {
  if (script.matches === undefined) throw new Error(`Script with ID '${script.id}' must specify 'matches'.`)

  if (script.matches.length === 0) throw new Error(`Script with ID '${script.id}' must specify at least one match.`)

  const js = script.js ?? []
  const css = script.css ?? []

  if (js.length === 0 && css.length === 0) throw new Error(`Script with ID '${script.id}' must specify at least one js or css file.`)

  const base = {
    id: script.id,
    matches: [...script.matches],
    allFrames: script.allFrames ?? false,
    matchOriginAsFallback: script.matchOriginAsFallback ?? false,
    persistAcrossSessions: script.persistAcrossSessions ?? true,
    runAt: script.runAt ?? "document_idle",
    world: script.world ?? "ISOLATED"
  }

  const parsed: ChromeScripting.RegisteredContentScript = js.length > 0
    ? { ...base, js: [...js] }
    : { ...base, css: [...css] }

  if (js.length > 0 && css.length > 0) parsed.css = [...css]

  if (script.excludeMatches !== undefined && script.excludeMatches.length > 0) parsed.excludeMatches = [...script.excludeMatches]

  return parsed
}

/** Chrome's `ApplyUpdate`: supplied fields win, except `world`, which an update never changes. */
const merge = (
  current: ChromeScripting.RegisteredContentScript,
  next: ChromeScripting.ContentScriptUpdate
): ChromeScripting.RegisteredContentScript => {
  const merged = structuredClone(current)

  if (next.matches !== undefined) merged.matches = next.matches

  if (next.excludeMatches !== undefined) merged.excludeMatches = next.excludeMatches

  if (next.js !== undefined) merged.js = next.js

  if (next.css !== undefined) merged.css = next.css

  if (next.allFrames !== undefined) merged.allFrames = next.allFrames

  if (next.matchOriginAsFallback !== undefined) merged.matchOriginAsFallback = next.matchOriginAsFallback

  if (next.runAt !== undefined) merged.runAt = next.runAt

  if (next.persistAcrossSessions !== undefined) merged.persistAcrossSessions = next.persistAcrossSessions

  return merged
}

/** Chrome's result shaping: one failed frame fails the call; otherwise failed frames are dropped, main frame first. */
const report = (outcomes: ReadonlyArray<FrameOutcome>): Array<ChromeScripting.InjectionResult<SerializableValue>> => {
  const [only] = outcomes

  if (outcomes.length === 1 && only !== undefined && "error" in only) throw new Error(only.error)

  const results: Array<ChromeScripting.InjectionResult<SerializableValue>> = []

  for (const outcome of outcomes) {
    if ("error" in outcome) continue

    const result = { frameId: outcome.frame.frameId, documentId: outcome.frame.documentId, result: outcome.value }

    if (outcome.frame.frameId === mainFrameId) results.unshift(result)
    else results.push(result)
  }

  return results
}

const sameFiles = (left: ReadonlyArray<string> | undefined, right: ReadonlyArray<string> | undefined) =>
  left === undefined || right === undefined
    ? left === right
    : left.length === right.length && left.every((file, index) => file === right[index])

/**
 * An in-memory `chrome.scripting` modelled on Chromium's implementation, with Chrome-like
 * error messages.
 *
 * Tabs and their frames come from `controls.setTab`; packaged files from `controls.addFile`.
 * Targets are validated like Chrome (`allFrames` with explicit ids, both id kinds, unknown
 * tabs, frames and documents), default to the main frame, and repeated ids collapse.
 * A frame with an `error`, a `chrome://` URL or a Web Store URL cannot be injected into: when
 * it is the only targeted frame the call rejects, otherwise it is left out (`insertCSS`
 * ignores it), as Chrome does. `executeScript` requires exactly one of `func` and `files`,
 * rejects `args` with files and arguments JSON cannot serialize, then evaluates `func`
 * locally once per frame with JSON-cloned arguments (closures are NOT stripped, unlike
 * Chrome) and awaits it; a JavaScript file evaluates to its `addFile` evaluator, the last
 * file's value being the result. Results are JSON-cloned, `undefined` becomes `null`, and the
 * main frame comes first. A function that throws or rejects fails its frame like an
 * injection failure (how Chrome reports a script's own exception is not modelled).
 * `controls.evaluatingFrame()` tells the running function which frame it is in. CSS insertions are recorded per frame document; `removeCSS` removes the latest one
 * with the same `css` or `files` and `origin`, and nothing when there is none.
 *
 * Dynamic content scripts follow Chrome's all-or-nothing rules: empty, reserved
 * (`_`) and duplicate ids (including ids still being registered), a missing or empty
 * `matches`, no `js` or `css`, and unpackaged or repeated files reject the whole batch.
 * Stored scripts carry Chrome's defaults. `updateContentScripts` rejects unknown ids, merges
 * the supplied fields, and like Chrome never changes `world`. `getRegisteredContentScripts`
 * and `unregisterContentScripts` treat an absent or empty `ids` as every script, as Chrome
 * does; unregistering an unknown id rejects without removing anything. Match patterns are
 * not validated. `controls.restart()` drops tabs, styles and the scripts that do not persist
 * across sessions.
 *
 * Every call can fail once through `controls.failNext` (rejection) or `controls.throwNext`
 * (synchronous throw), and `controls.holdNext` pauses one call where Chrome goes
 * asynchronous. Pass `overrides` to replace any member.
 */
export const makeScripting = (overrides: Partial<ChromeScripting.ChromeScriptingApi> = {}) => {
  const tabs = new Map<number, Array<ScriptingFrame>>()
  const files = new Map<string, FileEvaluator | undefined>()
  const styles: Array<InsertedStyle> = []
  const scripts = new Map<string, ChromeScripting.RegisteredContentScript>()
  const pending = new Set<string>()
  const rejections = new Map<ScriptingOperation, Array<unknown>>()
  const throws = new Map<ScriptingOperation, Array<unknown>>()
  const holds = new Map<ScriptingOperation, Array<Hold>>()
  let evaluating: ScriptingFrame | undefined

  /** Throws a queued synchronous failure, or returns a queued rejection, for `operation`. */
  const enter = (operation: ScriptingOperation): Promise<never> | undefined => {
    const thrown = throws.get(operation)

    if (thrown !== undefined && thrown.length > 0) throw thrown.shift()

    const rejected = rejections.get(operation)

    return rejected !== undefined && rejected.length > 0 ? Promise.reject(rejected.shift()) : undefined
  }

  const pause = async (operation: ScriptingOperation) => {
    const hold = holds.get(operation)?.shift()

    if (hold === undefined) return

    hold.enter()
    await hold.gate
  }

  /** The frames a target selects, main frame first, with Chrome's validation. */
  const resolve = (target: ChromeScripting.InjectionTarget): Array<ScriptingFrame> => {
    const frameIds = "frameIds" in target ? target.frameIds : undefined
    const documentIds = "documentIds" in target ? target.documentIds : undefined

    if (target.allFrames === true && (frameIds !== undefined || documentIds !== undefined)) {
      throw new Error("Cannot specify 'allFrames' if either 'frameIds' or 'documentIds' is specified.")
    }

    if (frameIds !== undefined && documentIds !== undefined) throw new Error("Cannot specify both 'frameIds' and 'documentIds'.")

    const frames = tabs.get(target.tabId)

    if (frames === undefined) throw new Error(`No tab with id: ${target.tabId}.`)

    const pick = (selected: (frame: ScriptingFrame) => boolean) => [
      ...frames.filter((frame) => frame.frameId === mainFrameId && selected(frame)),
      ...frames.filter((frame) => frame.frameId !== mainFrameId && selected(frame))
    ]

    if (target.allFrames === true) return pick(() => true)

    if (frameIds !== undefined) {
      for (const frameId of frameIds) {
        if (!frames.some((frame) => frame.frameId === frameId)) throw new Error(`No frame with id ${frameId} in tab with id ${target.tabId}`)
      }

      return pick((frame) => frameIds.includes(frame.frameId))
    }

    if (documentIds !== undefined) {
      for (const documentId of documentIds) {
        if (!frames.some((frame) => frame.documentId === documentId)) {
          throw new Error(`No document with id ${documentId} in tab with id ${target.tabId}`)
        }
      }

      return pick((frame) => documentIds.includes(frame.documentId))
    }

    const main = pick((frame) => frame.frameId === mainFrameId)

    if (main.length === 0) throw new Error(`No frame with id ${mainFrameId} in tab with id ${target.tabId}`)

    return main
  }

  const inFrames = async (
    frames: ReadonlyArray<ScriptingFrame>,
    run: (frame: ScriptingFrame) => Promise<SerializableValue>
  ): Promise<Array<FrameOutcome>> => Promise.all(frames.map(async (frame): Promise<FrameOutcome> => {
    const denied = accessError(frame)

    if (denied !== undefined) return { frame, error: denied }

    try {
      return { frame, value: await run(frame) }
    } catch (cause) {
      return { frame, error: messageOf(cause) }
    }
  }))

  const executeScript = async <Args extends Array<unknown>, Result>(
    injection: chrome.scripting.ScriptInjection<Args, Result>
  ): Promise<Array<ChromeScripting.InjectionResult<Awaited<Result>>>> => {
    if ((injection.func === undefined) === (injection.files === undefined)) {
      throw new Error("Exactly one of 'func' and 'files' must be specified")
    }

    const frames = resolve(injection.target)
    let run: (frame: ScriptingFrame) => Promise<SerializableValue>

    if (injection.func === undefined) {
      if ("args" in injection) throw new Error("'args' may not be used with file injections.")

      const paths = injection.files ?? []
      checkFiles(paths, files)
      const last = files.get(paths[paths.length - 1] ?? "")
      run = async (frame) => last === undefined ? null : serialize(last(frame))
    } else {
      const func = injection.func
      let serialized: string | undefined

      try {
        serialized = "args" in injection ? JSON.stringify(injection.args) : undefined
      } catch {
        throw new Error("Unserializable argument passed.")
      }

      run = async (frame) => {
        evaluating = frame
        let returned: Result

        try {
          // Each frame deserializes its own copy of the arguments, as Chrome's renderers do.
          const args: Args | undefined = serialized === undefined ? undefined : JSON.parse(serialized)
          returned = args === undefined ? func() : func(...args)
        } finally {
          evaluating = undefined
        }

        return serialize(await returned)
      }
    }

    await pause("executeScript")

    // SAFETY: Chrome's typing promises the function's awaited result; like Chrome, the
    // fixture delivers whatever survived serialization, which is that value for JSON data.
    return report(await inFrames(frames, run)) as Array<ChromeScripting.InjectionResult<Awaited<Result>>>
  }

  const cssFrames = (injection: ChromeScripting.CSSInjection): Array<ScriptingFrame> => {
    if ((injection.css === undefined) === (injection.files === undefined)) {
      throw new Error("Exactly one of 'css' and 'files' must be specified.")
    }

    const frames = resolve(injection.target)

    if (injection.files !== undefined) checkFiles(injection.files, files)

    return frames
  }

  const styleFor = (injection: ChromeScripting.CSSInjection, frame: ScriptingFrame): InsertedStyle => {
    const base = { tabId: injection.target.tabId, frameId: frame.frameId, documentId: frame.documentId, origin: injection.origin ?? "AUTHOR" }

    return injection.css === undefined ? { ...base, files: [...(injection.files ?? [])] } : { ...base, css: injection.css }
  }

  const insertCSS = async (injection: ChromeScripting.CSSInjection) => {
    const frames = cssFrames(injection)
    await pause("insertCSS")

    report(await inFrames(frames, async (frame) => {
      styles.push(styleFor(injection, frame))

      return null
    }))
  }

  const removeCSS = async (injection: ChromeScripting.CSSInjection) => {
    const frames = cssFrames(injection)
    await pause("removeCSS")

    report(await inFrames(frames, async (frame) => {
      const wanted = styleFor(injection, frame)

      for (let index = styles.length - 1; index >= 0; index--) {
        const style = styles[index]

        if (style !== undefined && style.tabId === wanted.tabId && style.frameId === wanted.frameId
          && style.documentId === wanted.documentId && style.origin === wanted.origin && style.css === wanted.css
          && sameFiles(style.files, wanted.files)) {
          styles.splice(index, 1)

          break
        }
      }

      return null
    }))
  }

  /** Chrome's `CreateDynamicScriptIds`: valid ids, none repeated, none registered or pending. */
  const checkNewIds = (ids: ReadonlyArray<string>, taken: (id: string) => boolean) => {
    const batch = new Set<string>()

    for (const id of ids) {
      checkScriptId(id)

      if (taken(id) || batch.has(id)) throw new Error(`Duplicate script ID '${id}'`)

      batch.add(id)
    }
  }

  /** Reserves the ids while Chrome validates files off-thread, then commits or releases them. */
  const commit = async (operation: ScriptingOperation, parsed: ReadonlyArray<ChromeScripting.RegisteredContentScript>) => {
    for (const script of parsed) pending.add(script.id)

    try {
      await pause(operation)

      for (const script of parsed) {
        for (const file of [...(script.js ?? []), ...(script.css ?? [])]) {
          if (!files.has(file)) throw new Error(`Could not load file: '${file}'.`)
        }
      }

      // Map.set keeps an existing key's position, so registration order survives updates.
      for (const script of parsed) scripts.set(script.id, structuredClone(script))
    } finally {
      for (const script of parsed) pending.delete(script.id)
    }
  }

  const registerContentScripts = async (batch: Array<ChromeScripting.RegisteredContentScript>) => {
    checkNewIds(batch.map((script) => script.id), (id) => scripts.has(id) || pending.has(id))
    await commit("registerContentScripts", batch.map(parse))
  }

  const updateContentScripts = async (batch: Array<ChromeScripting.ContentScriptUpdate>) => {
    checkNewIds(batch.map((script) => script.id), (id) => pending.has(id))

    const parsed = batch.map((update) => {
      const current = scripts.get(update.id)

      if (current === undefined) throw new Error(`Script with ID '${update.id}' does not exist or is not fully registered`)

      return parse(merge(current, update))
    })

    await commit("updateContentScripts", parsed)
  }

  const selected = (filter: ChromeScripting.ContentScriptFilter | undefined) => {
    const ids = filter?.ids

    return ids === undefined || ids.length === 0 ? undefined : new Set(ids)
  }

  const getRegisteredContentScripts = async (filter?: ChromeScripting.ContentScriptFilter) => {
    const ids = selected(filter)
    await pause("getRegisteredContentScripts")

    return structuredClone(Array.from(scripts.values()).filter((script) => ids === undefined || ids.has(script.id)))
  }

  const unregisterContentScripts = async (filter?: ChromeScripting.ContentScriptFilter) => {
    const ids = selected(filter)
    await pause("unregisterContentScripts")

    if (ids === undefined) {
      scripts.clear()

      return
    }

    for (const id of ids) {
      checkScriptId(id)

      if (!scripts.has(id)) throw new Error(`Nonexistent script ID '${id}'`)
    }

    for (const id of ids) scripts.delete(id)
  }

  const api: ChromeScripting.ChromeScriptingApi = {
    executeScript: (injection) => enter("executeScript") ?? executeScript(injection),
    insertCSS: (injection) => enter("insertCSS") ?? insertCSS(structuredClone(injection)),
    removeCSS: (injection) => enter("removeCSS") ?? removeCSS(structuredClone(injection)),
    registerContentScripts: (batch) => enter("registerContentScripts") ?? registerContentScripts(structuredClone(batch)),
    getRegisteredContentScripts: (...filter) => enter("getRegisteredContentScripts") ?? getRegisteredContentScripts(...filter),
    updateContentScripts: (batch) => enter("updateContentScripts") ?? updateContentScripts(structuredClone(batch)),
    unregisterContentScripts: (...filter) => enter("unregisterContentScripts") ?? unregisterContentScripts(...filter),
    ...overrides
  }

  const queue = (failures: Map<ScriptingOperation, Array<unknown>>, operation: ScriptingOperation, cause: unknown) => {
    const pendingFailures = failures.get(operation) ?? []
    pendingFailures.push(cause)
    failures.set(operation, pendingFailures)
  }

  const dropStyles = (keep: (style: InsertedStyle) => boolean) => {
    const kept = styles.filter(keep)
    styles.length = 0
    styles.push(...kept)
  }

  return {
    api,
    layer: ChromeScripting.layer(api),
    controls: {
      /** Opens or replaces a tab; by default it has only a main frame. Its styles are dropped. */
      setTab: (tabId: number, frames: ReadonlyArray<ScriptingFrame> = [{ frameId: mainFrameId, documentId: `document-${tabId}` }]) => {
        tabs.set(tabId, [...frames])
        dropStyles((style) => style.tabId !== tabId)
      },
      /** Closes a tab and drops its styles. */
      removeTab: (tabId: number) => {
        tabs.delete(tabId)
        dropStyles((style) => style.tabId !== tabId)
      },
      /**
       * Commits a navigation: the frame with `frame.frameId` gets the new document (or the
       * frame is added) and the old document's styles are dropped.
       */
      navigate: (tabId: number, frame: ScriptingFrame) => {
        const frames = tabs.get(tabId)

        if (frames === undefined) throw new Error(`No tab with id: ${tabId}.`)

        const index = frames.findIndex((existing) => existing.frameId === frame.frameId)

        if (index >= 0) frames.splice(index, 1, frame)
        else frames.push(frame)

        dropStyles((style) => style.tabId !== tabId || style.frameId !== frame.frameId || style.documentId === frame.documentId)
      },
      /** Packages a file; a JavaScript file evaluates to `evaluate(frame)`, or `null` without one. */
      addFile: (path: string, evaluate?: FileEvaluator) => { files.set(path, evaluate) },
      /** The frame the running injected function was called in, during its synchronous part. */
      evaluatingFrame: (): ScriptingFrame | undefined => evaluating,
      /** A snapshot of the inserted stylesheets, oldest first. */
      styles: (): Array<InsertedStyle> => structuredClone(styles),
      /** A snapshot of the registered scripts, in registration order, as Chrome reports them. */
      scripts: (): Array<ChromeScripting.RegisteredContentScript> => structuredClone(Array.from(scripts.values())),
      /** Ids reserved by a registration or update that has not finished. */
      pending: (): Array<string> => Array.from(pending),
      /** A browser restart: tabs and styles go, and so do scripts that do not persist across sessions. */
      restart: () => {
        tabs.clear()
        styles.length = 0

        for (const [id, script] of scripts) {
          if (script.persistAcrossSessions === false) scripts.delete(id)
        }
      },
      /**
       * Holds the next call of `operation` where Chrome goes asynchronous (after validation;
       * for registrations, with the ids reserved) until `release` is called. `entered`
       * resolves once that call is waiting.
       */
      holdNext: (operation: ScriptingOperation) => {
        let enterHold = () => {}

        let release = () => {}

        const entered = new Promise<void>((resolve) => { enterHold = resolve })
        const gate = new Promise<void>((resolve) => { release = resolve })
        const queued = holds.get(operation) ?? []
        queued.push({ enter: enterHold, gate })
        holds.set(operation, queued)

        return { entered, release: () => { release() } }
      },
      /** Rejects the next call of `operation` with `cause`. */
      failNext: (operation: ScriptingOperation, cause: unknown) => { queue(rejections, operation, cause) },
      /** Throws `cause` synchronously from the next call of `operation`, as Chrome's argument validation does. */
      throwNext: (operation: ScriptingOperation, cause: unknown) => { queue(throws, operation, cause) }
    }
  }
}
