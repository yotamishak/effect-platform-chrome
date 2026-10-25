import { Cause, Effect, Exit, Layer, Match, Option, Predicate } from "effect"
import * as Bookmarks from "effect-platform-chrome/ChromeBookmarks"
import * as History from "effect-platform-chrome/ChromeHistory"
import * as Downloads from "effect-platform-chrome/ChromeDownloads"
import * as TabGroups from "effect-platform-chrome/ChromeTabGroups"
import * as Tabs from "effect-platform-chrome/ChromeTabs"
import * as Sessions from "effect-platform-chrome/ChromeSessions"
import * as Management from "effect-platform-chrome/ChromeManagement"
import * as I18n from "effect-platform-chrome/ChromeI18n"

export const dataModules: string[] = ["ChromeBookmarks", "ChromeHistory", "ChromeDownloads", "ChromeTabGroups", "ChromeSessions", "ChromeManagement", "ChromeI18n"]

interface Check {
  readonly name: string
  readonly ok: boolean
  readonly completed?: number | undefined
  readonly error?: string
}

/** Run from a persistent extension page: closing a popup destroys its cleanup runtime. */
export interface DataReport {
  module: string
  passed: boolean
  checks: Check[]
  skipped?: string
}

export async function runDataModule(name: string): Promise<DataReport> {
  const checks: Check[] = []
  const namespace = `effect-data-${crypto.randomUUID()}`
  const indices = Array.from({ length: 240 }, (_, i) => i)

  const record = (label: string, ok: boolean, completed?: number) => {
    checks.push({ name: label, ok, completed })
  }

  const cleanup = <A, E>(label: string, effect: Effect.Effect<A, E>) => effect.pipe(
    Effect.exit,
    Effect.map((exit) => {
      checks.push(Exit.isSuccess(exit)
        ? { name: label, ok: true }
        : { name: label, ok: false, error: Cause.pretty(exit.cause) })
    })
  )

  const rejects = <A, E extends { readonly operation: string; readonly _tag: string }>(
    label: string, effect: Effect.Effect<A, E>, tag: string, operation: string
  ) => effect.pipe(Effect.match({
    onSuccess: () => record(label, false),
    onFailure: (error) => record(label, error._tag === tag && error.operation === operation)
  }))

  const stress = <E, R>(label: string, f: (i: number) => Effect.Effect<boolean, E, R>) =>
    Effect.forEach(indices, f, { concurrency: 8 }).pipe(
      Effect.timeout("30 seconds"),
      Effect.map((results) => record(label, results.every(Boolean), results.length))
    )

  try {
    switch (name) {
      case "ChromeBookmarks":
        await Effect.runPromise(Effect.gen(function*() {
          const api = yield* Bookmarks.ChromeBookmarks

          // Individual reverse-order finalizers never recursively delete foreign additions.
          const own = (details: Bookmarks.CreateDetails) => Effect.acquireRelease(
            api.create(details), (node) => cleanup(`remove owned bookmark ${node.id}`, api.remove(node.id))
          )

          const folder = yield* own({ title: namespace })
          const nested = yield* own({ parentId: folder.id, title: "nested" })
          const url = `https://example.invalid/${namespace}/bookmark?q=%E2%9C%93#edge`
          const first = yield* own({ parentId: folder.id, title: "Unicode ✓ 空", url })
          const second = yield* own({ parentId: folder.id, title: "duplicate URL", url })
          record("duplicate URLs have distinct ids", first.id !== second.id)
          const updated = yield* api.update(first.id, { title: "" })
          record("empty title roundtrip", updated.title === "")
          const moved = yield* api.move(first.id, { parentId: nested.id, index: 0 })
          record("move between owned folders", moved.parentId === nested.id && moved.index === 0)
          yield* stress("240 concurrent owned-node reads", (i) => Match.value(i % 3).pipe(
            Match.when(0, () => api.get(first.id, second.id).pipe(Effect.map((nodes) => nodes.length === 2 && nodes.some((n) => n.id === first.id)))),
            Match.when(1, () => api.getSubTree(folder.id).pipe(Effect.map((nodes) => nodes[0]?.children?.length === 2))),
            Match.orElse(() => api.search({ url }).pipe(Effect.map((nodes) => nodes.some((n) => n.id === first.id) && nodes.some((n) => n.id === second.id))))))
          yield* rejects("nonempty owned folder cannot be removed", api.remove(folder.id), "ChromeBookmarksError", "remove")
          yield* rejects("folder cannot move into itself", api.move(nested.id, { parentId: nested.id }), "ChromeBookmarksError", "move")
          yield* rejects("missing bookmark is typed", api.get("999999999999999"), "ChromeBookmarksError", "get")
        }).pipe(Effect.scoped, Effect.provide(Bookmarks.layerLive)))
        break
      case "ChromeHistory":
        await Effect.runPromise(Effect.gen(function*() {
          const api = yield* History.ChromeHistory
          const urls = Array.from({ length: 4 }, (_, i) => `https://example.invalid/${namespace}/${i}?unicode=%E2%9C%93`)

          for (const url of urls) {
            // Register before addUrl: even a partially successful native call is cleaned.
            yield* Effect.addFinalizer(() => cleanup("delete owned history URL", api.deleteUrl(url)))
            yield* api.addUrl(url)
            yield* api.addUrl(url)
          }

          yield* stress("240 exact URL visit reads", (i) => api.getVisits(urls[i % urls.length]!).pipe(
            Effect.map((visits) => visits.length >= 1 && visits.every((v) => v.visitId.length > 0))
          ))
          const found = yield* api.search({ text: namespace, startTime: 0, maxResults: 20 })
          record("all unique URLs searchable", urls.every((url) => found.some((item) => item.url === url)))
          const missing = yield* api.getVisits(`https://example.invalid/${namespace}/never-added`)
          record("unknown URL has no visits", missing.length === 0)

          for (const url of urls) {
            yield* api.deleteUrl(url)
            record("owned URL deletion roundtrip", (yield* api.getVisits(url)).length === 0)
          }
        }).pipe(Effect.scoped, Effect.provide(History.layerLive)))
        break
      case "ChromeDownloads":
        await Effect.runPromise(Effect.gen(function*() {
          const api = yield* Downloads.ChromeDownloads
          let fileRemoved = false

          const id = yield* Effect.acquireRelease(api.download({
            url: `data:text/plain;charset=utf-8,${encodeURIComponent(namespace + " ✓\n")}`,
            filename: `${namespace}.txt`, saveAs: false, conflictAction: "uniquify"
          }), (ownedId) => Effect.gen(function*() {
            // Always attempt both steps, even when Chrome cannot remove the file.
            let items = yield* Effect.exit(api.search({ id: ownedId }))

            if (Exit.isSuccess(items) && items.value.some((item) => item.state === "in_progress")) {
              yield* cleanup("cancel active owned download", api.cancel(ownedId))
              // Completion can race cancellation; inspect again before removing its file.
              items = yield* Effect.exit(api.search({ id: ownedId }))
            }

            if (Exit.isFailure(items)) {
              checks.push({ name: "inspect owned download cleanup", ok: false, error: Cause.pretty(items.cause) })

              if (!fileRemoved) yield* cleanup("remove owned file", api.removeFile(ownedId))
            } else if (!fileRemoved && items.value.some((item) => item.state === "complete" && item.exists)) {
              yield* cleanup("remove owned file", api.removeFile(ownedId))
            }

            yield* cleanup("erase owned download record", api.erase({ id: ownedId }).pipe(
              Effect.flatMap(() => api.search({ id: ownedId })),
              Effect.flatMap((items) => items.length === 0 ? Effect.void : Effect.die(new Error("Owned download record remains")))
            ))
          }))

          const completed = yield* api.waitForComplete(id).pipe(Effect.timeout("20 seconds"))
          record("tiny data URL completes", completed.id === id && completed.state === "complete" && completed.fileSize > 0)
          yield* stress("240 completed download reads and waits", (i) => i % 2 === 0
            ? api.search({ id }).pipe(Effect.map((items) => items.length === 1 && items[0]?.id === id))
            : api.waitForComplete(id).pipe(Effect.map((item) => item.id === id && item.state === "complete")))
          yield* rejects("completed download cannot pause", api.pause(id), "ChromeDownloadsError", "pause")
          yield* api.removeFile(id)
          fileRemoved = true
          record("owned file removed", true)
          const erased = yield* api.erase({ id })
          record("erase returns only owned id", erased.length === 1 && erased[0] === id)
          yield* api.waitForComplete(id).pipe(Effect.match({
            onSuccess: () => record("erased download wait is typed", false),
            onFailure: (error) => record("erased download wait is typed", Predicate.isTagged(error, "ChromeDownloadsError") && error.operation === "search")
          }))
        }).pipe(Effect.scoped, Effect.provide(Downloads.layerLive)))
        break
      case "ChromeTabGroups":
        await Effect.runPromise(Effect.gen(function*() {
          const api = yield* TabGroups.ChromeTabGroups
          const tabs = yield* Tabs.ChromeTabs
          const ids: number[] = []

          for (let i = 0; i < 3; i++) {
            const tab = yield* Effect.acquireRelease(
              tabs.create({ url: `about:blank#${namespace}-${i}`, active: false }),
              (owned) => owned.id === undefined ? Effect.void : cleanup(`remove owned tab ${owned.id}`, tabs.remove(owned.id))
            )

            if (tab.id === undefined) return yield* Effect.die(new Error("Created tab has no id"))
            ids.push(tab.id)
          }

          const firstId = ids[0]

          if (firstId === undefined) return yield* Effect.die(new Error("No owned tabs created"))
          const groupId = yield* tabs.group({ tabIds: [firstId, ...ids.slice(1)] })
          yield* api.update(groupId, { title: namespace, color: "blue", collapsed: true })
          const updated = yield* api.get(groupId)
          record("group title/color/collapse", updated.title === namespace && updated.color === "blue" && updated.collapsed)
          yield* stress("240 group reads", (i) => i % 2 === 0
            ? api.get(groupId).pipe(Effect.map((group) => group.id === groupId && group.title === namespace))
            : api.query({ title: namespace }).pipe(Effect.map((groups) => groups.some((group) => group.id === groupId))))
          yield* api.update(groupId, { title: "", collapsed: false })
          record("empty title and expansion", (yield* api.get(groupId)).title === "" && !(yield* api.get(groupId)).collapsed)
          yield* tabs.ungroup(ids[0]!)
          record("ungroup own tab", (yield* tabs.get(ids[0]!)).groupId === -1)
          yield* tabs.group({ groupId, tabIds: [ids[0]!] })
          record("regroup own tab", (yield* tabs.get(ids[0]!)).groupId === groupId)

          for (const id of ids) yield* tabs.ungroup(id)
          yield* rejects("empty group disappears", api.get(groupId), "ChromeTabGroupsError", "get")
        }).pipe(Effect.scoped, Effect.provide(Layer.merge(TabGroups.layerLive, Tabs.layerLive))))
        break
      case "ChromeSessions":
        await Effect.runPromise(Effect.gen(function*() {
          const api = yield* Sessions.ChromeSessions
          yield* stress("240 bounded session/device reads", (i) => i % 2 === 0
            ? api.getRecentlyClosed({ maxResults: 1 }).pipe(Effect.map((sessions) => sessions.length <= 1 && sessions.every((s) => (s.tab === undefined) !== (s.window === undefined))))
            : api.getDevices({ maxResults: 1 }).pipe(Effect.map((devices) => devices.every((device) => device.sessions.length <= 1))))
          record("zero recently closed limit", (yield* api.getRecentlyClosed({ maxResults: 0 })).length === 0)
          yield* rejects("negative session limit is typed", api.getRecentlyClosed({ maxResults: -1 }), "ChromeSessionsError", "getRecentlyClosed")
          yield* rejects("oversized device limit is typed", api.getDevices({ maxResults: Sessions.MAX_SESSION_RESULTS + 1 }), "ChromeSessionsError", "getDevices")
        }).pipe(Effect.scoped, Effect.provide(Sessions.layerLive)))
        break
      case "ChromeManagement":
        await Effect.runPromise(Effect.gen(function*() {
          const api = yield* Management.ChromeManagement
          const self = yield* api.getSelf
          record("self has extension identity", self.id.length > 0 && self.version.length > 0 && self.enabled)
          yield* stress("240 read-only self/inventory calls", (i) => i % 2 === 0
            ? api.getSelf.pipe(Effect.map((item) => item.id === self.id && item.version === self.version))
            : api.getAll.pipe(Effect.map((items) => items.some((item) => item.id === self.id) && new Set(items.map((item) => item.id)).size === items.length)))
        }).pipe(Effect.scoped, Effect.provide(Management.layerLive)))
        break
      case "ChromeI18n":
        await Effect.runPromise(Effect.gen(function*() {
          const api = yield* I18n.ChromeI18n
          const locale = yield* api.getUILanguage
          record("UI language is nonempty", locale.length > 0)
          yield* stress("240 locale/message/detection reads", (i) => Match.value(i % 3).pipe(
            Match.when(0, () => api.getUILanguage.pipe(Effect.map((value) => value === locale))),
            Match.when(1, () => api.getMessage("@@extension_id").pipe(Effect.map((value) => Option.isSome(value) && /^[a-p]{32}$/.test(value.value)))),
            Match.orElse(() => api.detectLanguage("This is a long English sentence about testing a browser extension and checking language detection without changing any user data.").pipe(
              Effect.map((result) => result.languages.some((language) => language.language === "en") && result.languages.every((language) => language.percentage >= 0 && language.percentage <= 100))
             ))))
          record("missing message is None", Option.isNone(yield* api.getMessage(namespace.replaceAll("-", "_"))))
          const empty = yield* api.detectLanguage("")
          record("empty detection is unreliable", !empty.isReliable)
          const short = yield* api.detectLanguage("Hi")
          record("short detection is unreliable", !short.isReliable)
          const preferred = yield* api.getAcceptLanguages
          record("preferred language entries are nonempty", preferred.every((language) => language.length > 0))
        }).pipe(Effect.scoped, Effect.provide(I18n.layerLive)))
        break
      default:
        return { module: name, passed: false, checks, skipped: "Unknown data module" }
    }
  } catch (error) {
    checks.push({ name: "module execution", ok: false, error: error instanceof Error ? error.message : String(error) })
  }

  return { module: name, passed: checks.length > 0 && checks.every((check) => check.ok), checks }
}
