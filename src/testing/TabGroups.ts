import * as ChromeTabGroups from "../ChromeTabGroups.js"
import * as TestEvent from "./Event.js"

type WindowType = `${chrome.windows.WindowType}`

const WINDOW_ID_CURRENT = -2

const colors: ReadonlyArray<ChromeTabGroups.Color> = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]

/** A simulated window: its type and its tab strip, one slot per tab holding a group id or -1. */
interface Strip {
  readonly type: WindowType
  /** Leading ungrouped tabs that are pinned. */
  readonly pinned: number
  slots: Array<number>
  /** The window's group ids in the order they joined it, which is the order Chrome lists them in. */
  order: Array<number>
}

/** A window opened through `controls.openWindow`. */
export interface TabGroupWindowOptions {
  /** Only `"normal"` windows (the default) hold groups. */
  readonly type?: WindowType
  /** Pinned tabs at the start of the strip. */
  readonly pinnedTabs?: number
  /** Ungrouped tabs after the pinned ones. */
  readonly ungroupedTabs?: number
}

/** A group added through `controls.create`, as `chrome.tabs.group` would make one. */
export interface TabGroupSeed {
  /** Defaults to the current (most recently focused) window. */
  readonly windowId?: number
  /** Tabs in the new group, at least 1 (the default). */
  readonly tabCount?: number
  /** Where the group's tabs go in the strip; the end when absent, -1 or past the end. */
  readonly index?: number
  readonly title?: string
  readonly color?: ChromeTabGroups.Color
  readonly collapsed?: boolean
  readonly shared?: boolean
}

/** Replaces lone surrogates with U+FFFD, as Chrome's UTF-8 conversion of a JS string does. */
const wellFormed = (value: string): string =>
  value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, String.fromCodePoint(0xFFFD))

/**
 * Chrome's tab group title matching (`base::MatchPattern`): `*` matches any run of
 * characters, `?` matches zero or one character, and `\` makes the next character literal.
 * Characters are compared by code point and the whole title must match.
 */
export const matchesGroupTitle = (title: string, pattern: string): boolean => {
  const text = Array.from(wellFormed(title))
  const glob = Array.from(wellFormed(pattern))
  let p = 0
  let s = 0

  do {
    let questions = 0
    let star = false

    for (; p < glob.length; p++) {
      if (glob[p] === "?") questions++
      else if (glob[p] === "*") star = true
      else break
    }

    // How many characters the wildcards just eaten may skip before the literals match: -1 is any.
    let distance = star ? -1 : questions
    const patternStart = p
    let stringStart = s
    let escape = false

    for (;;) {
      if (p === glob.length) {
        if (s === text.length) break
      } else {
        const char = glob[p]

        if (!escape && (char === "*" || char === "?")) break

        if (!escape && char === "\\") {
          escape = true
          p++
          continue
        }

        escape = false

        if (s === text.length) return false

        if (char === text[s]) {
          p++
          s++
          continue
        }
      }

      if (distance === 0) return false

      distance--
      p = patternStart
      stringStart++
      s = stringStart
    }
  } while (p !== glob.length)

  return true
}

/** Chrome's synchronous argument validation for integer parameters. */
const integer = (operation: string, parameter: string, value: number, minimum: number) => {
  if (!Number.isInteger(value)) {
    throw new TypeError(`Error in invocation of tabGroups.${operation}: Error at parameter '${parameter}': Invalid type: expected integer, found number.`)
  }

  if (value < minimum) {
    throw new TypeError(`Error in invocation of tabGroups.${operation}: Error at parameter '${parameter}': Value must be at least ${minimum}.`)
  }
}

const color = (operation: string, parameter: string, value: ChromeTabGroups.Color | undefined) => {
  if (value !== undefined && !colors.includes(value)) {
    throw new TypeError(`Error in invocation of tabGroups.${operation}: Error at parameter '${parameter}': Value must be one of ${colors.join(", ")}.`)
  }
}

/** Runs `run` now, turning its result or throw into a settled Promise, as Chrome replies. */
const settle = <A>(run: () => A): Promise<A> => {
  try {
    return Promise.resolve(run())
  } catch (cause) {
    return Promise.reject(cause)
  }
}

/** The run of slots `[start, start + length)` belonging to `groupId`. */
const span = (strip: Strip, groupId: number) => {
  const start = strip.slots.indexOf(groupId)
  const length = start === -1 ? 0 : strip.slots.lastIndexOf(groupId) - start + 1

  return { start, length }
}

/**
 * Chrome's check that a group may land at `index`: the end is always allowed, pinned tabs and
 * the inside of another group are not.
 */
const checkIndex = (strip: Strip, index: number) => {
  if (index >= strip.slots.length || index < 0) return

  if (index < strip.pinned) throw new Error("Cannot move the group to an index that is in the middle of pinned tabs.")

  const target = strip.slots[index]

  if (target !== ChromeTabGroups.TAB_GROUP_ID_NONE && index > 0 && strip.slots[index - 1] === target) {
    throw new Error("Cannot move the group to an index that is in the middle of another group.")
  }
}

/**
 * In-memory tab groups across simulated windows. Each window is a tab strip of pinned,
 * ungrouped and grouped tabs (tabs themselves are not modelled); window 1 is a normal, empty,
 * focused window. `controls.create` adds a group as `chrome.tabs.group` would (emitting
 * `onCreated`), and `controls.remove`, `controls.ungroup` and `controls.closeWindow` close
 * groups (emitting `onRemoved`). `get`, `query`, `update` and `move` follow Chrome: missing
 * groups and windows fail with Chrome's messages, out-of-range integers and unknown colors
 * throw synchronously, `query` walks windows from the most recently focused, lists each
 * window's groups in the order they joined it (created there or moved in, not tab-strip order)
 * and matches titles with `matchesGroupTitle`, `update` always emits `onUpdated`, and `move`
 * applies Chrome's index rules, emitting `onMoved` within a window (nothing when the group
 * stays put) or `onRemoved` then `onCreated` and `onUpdated` across windows. Events fire before
 * the call settles, but results and events carry the group as that call left it, whatever a
 * listener changes meanwhile. Pass `overrides` to replace any member.
 */
export const makeTabGroups = (overrides: Partial<ChromeTabGroups.ChromeTabGroupsApi> = {}) => {
  const windows = new Map<number, Strip>()
  const groups = new Map<number, ChromeTabGroups.TabGroup>()
  /** Window ids, most recently focused first. */
  const activation: Array<number> = []
  const created = TestEvent.makeEvent<[ChromeTabGroups.TabGroup]>()
  const updated = TestEvent.makeEvent<[ChromeTabGroups.TabGroup]>()
  const removed = TestEvent.makeEvent<[ChromeTabGroups.TabGroup]>()
  const moved = TestEvent.makeEvent<[ChromeTabGroups.TabGroup]>()
  let nextWindowId = 1
  let nextGroupId = 1

  const snapshot = (group: ChromeTabGroups.TabGroup): ChromeTabGroups.TabGroup => ({ ...group })

  const current = (): number => {
    const windowId = activation[0]

    if (windowId === undefined) throw new Error("No current window")

    return windowId
  }

  const findWindow = (windowId: number): Strip => {
    const strip = windows.get(windowId)

    if (strip === undefined) throw new Error(`No window with id: ${windowId}.`)

    return strip
  }

  const findGroup = (groupId: number): ChromeTabGroups.TabGroup => {
    const group = groups.get(groupId)

    if (group === undefined) throw new Error(`No group with id: ${groupId}.`)

    return group
  }

  /** A window's groups as Chrome's TabGroupModel lists them: in the order they joined it. */
  const groupsIn = (strip: Strip): Array<ChromeTabGroups.TabGroup> => strip.order.flatMap((groupId) => {
    const group = groups.get(groupId)

    return group === undefined ? [] : [group]
  })

  const openWindow = (options: TabGroupWindowOptions = {}): number => {
    const pinned = options.pinnedTabs ?? 0
    const ungrouped = options.ungroupedTabs ?? 0

    if (!Number.isInteger(pinned) || pinned < 0 || !Number.isInteger(ungrouped) || ungrouped < 0) {
      throw new RangeError("pinnedTabs and ungroupedTabs must be non-negative integers")
    }

    const windowId = nextWindowId++
    windows.set(windowId, {
      type: options.type ?? "normal",
      pinned,
      slots: Array.from({ length: pinned + ungrouped }, () => ChromeTabGroups.TAB_GROUP_ID_NONE),
      order: []
    })
    activation.push(windowId)

    return windowId
  }

  /** Takes a group's tabs out of its strip and forgets it, emitting `onRemoved`. */
  const close = (groupId: number, keepTabs: boolean) => {
    const group = findGroup(groupId)
    const strip = findWindow(group.windowId)
    strip.slots = keepTabs
      ? strip.slots.map((slot) => slot === groupId ? ChromeTabGroups.TAB_GROUP_ID_NONE : slot)
      : strip.slots.filter((slot) => slot !== groupId)
    strip.order = strip.order.filter((id) => id !== groupId)
    groups.delete(groupId)
    removed.controls.emit(snapshot(group))
  }

  /** Moves within a window and returns the group as moved, before any listener reacts. */
  const moveWithin = (group: ChromeTabGroups.TabGroup, strip: Strip, requested: number): ChromeTabGroups.TabGroup => {
    const { start, length } = span(strip, group.id)
    checkIndex(strip, requested > start ? requested + length : requested)
    const remaining = strip.slots.length - length
    const index = requested >= remaining || requested < 0 ? remaining : requested
    const result = snapshot(group)

    if (index === start) return result

    const slots = strip.slots.filter((slot) => slot !== group.id)
    slots.splice(index, 0, ...Array.from({ length }, () => group.id))
    strip.slots = slots
    moved.controls.emit(snapshot(result))

    return result
  }

  /**
   * Moves into another window, where the group joins last, and returns it as moved. Every
   * event carries the group as the move left it, whatever an earlier listener changes.
   */
  const moveAcross = (
    group: ChromeTabGroups.TabGroup,
    source: Strip,
    targetId: number,
    target: Strip,
    requested: number
  ): ChromeTabGroups.TabGroup => {
    const index = requested > target.slots.length || requested < 0 ? target.slots.length : requested
    checkIndex(target, index)
    const { length } = span(source, group.id)
    const before = snapshot(group)
    source.slots = source.slots.filter((slot) => slot !== group.id)
    source.order = source.order.filter((id) => id !== group.id)
    target.slots.splice(index, 0, ...Array.from({ length }, () => group.id))
    target.order.push(group.id)
    group.windowId = targetId
    const result = snapshot(group)
    removed.controls.emit(before)
    created.controls.emit(snapshot(result))
    updated.controls.emit(snapshot(result))

    return result
  }

  openWindow()

  const api: ChromeTabGroups.ChromeTabGroupsApi = {
    get: (groupId) => {
      integer("get", "groupId", groupId, 0)

      return settle(() => snapshot(findGroup(groupId)))
    },
    query: (queryInfo) => {
      if (queryInfo.windowId !== undefined) integer("query", "queryInfo.windowId", queryInfo.windowId, WINDOW_ID_CURRENT)

      color("query", "queryInfo.color", queryInfo.color)

      return settle(() => {
        const currentId = current()
        const title = queryInfo.title

        return activation.flatMap((windowId) => {
          const strip = findWindow(windowId)
          const wanted = queryInfo.windowId

          if (wanted !== undefined && wanted >= 0 && wanted !== windowId) return []

          if (wanted === WINDOW_ID_CURRENT && windowId !== currentId) return []

          if (strip.type !== "normal") return []

          return groupsIn(strip).filter((group) =>
            (queryInfo.collapsed === undefined || queryInfo.collapsed === group.collapsed)
            && (title === undefined || matchesGroupTitle(group.title ?? "", title))
            && (queryInfo.color === undefined || queryInfo.color === group.color)
            && (queryInfo.shared === undefined || queryInfo.shared === (group.shared ?? false))
          ).map(snapshot)
        })
      })
    },
    update: (groupId, updateProperties) => {
      integer("update", "groupId", groupId, 0)
      color("update", "updateProperties.color", updateProperties.color)

      return settle(() => {
        const group = findGroup(groupId)

        if (updateProperties.collapsed !== undefined) group.collapsed = updateProperties.collapsed

        if (updateProperties.color !== undefined) group.color = updateProperties.color

        if (updateProperties.title !== undefined) group.title = wellFormed(updateProperties.title)

        const result = snapshot(group)
        updated.controls.emit(snapshot(result))

        return result
      })
    },
    move: (groupId, moveProperties) => {
      integer("move", "groupId", groupId, 0)
      integer("move", "moveProperties.index", moveProperties.index, -1)

      if (moveProperties.windowId !== undefined) {
        integer("move", "moveProperties.windowId", moveProperties.windowId, WINDOW_ID_CURRENT)
      }

      return settle(() => {
        const group = findGroup(groupId)
        const source = findWindow(group.windowId)
        const requested = moveProperties.windowId

        if (requested !== undefined) {
          const targetId = requested === WINDOW_ID_CURRENT ? current() : requested
          const target = findWindow(targetId)

          if (target.type !== "normal") throw new Error("Tabs can only be moved to and from normal windows.")

          if (target !== source) return moveAcross(group, source, targetId, target, moveProperties.index)
        }

        return moveWithin(group, source, moveProperties.index)
      })
    },
    onCreated: created.api,
    onUpdated: updated.api,
    onRemoved: removed.api,
    onMoved: moved.api,
    ...overrides
  }

  return {
    api,
    layer: ChromeTabGroups.layer(api),
    controls: {
      /** Opens a window, least recently focused until `focusWindow`, and returns its id. */
      openWindow,
      /** Makes a window the current one, first in `query` order. */
      focusWindow: (windowId: number) => {
        findWindow(windowId)
        activation.splice(activation.indexOf(windowId), 1)
        activation.unshift(windowId)
      },
      /**
       * Closes a window, emitting `onRemoved` for each of its groups in strip order. The strip is
       * read again after each removal, so a group a listener moves out survives, a group a
       * listener adds is closed too, and a listener closing the same window again ends both calls.
       */
      closeWindow: (windowId: number) => {
        const strip = findWindow(windowId)
        const first = () => strip.slots.find((slot) => groups.has(slot))

        for (let next = first(); next !== undefined; next = first()) close(next, false)

        // A listener already closed it: splicing at -1 would drop another window's activation.
        if (windows.get(windowId) !== strip) return

        windows.delete(windowId)
        activation.splice(activation.indexOf(windowId), 1)
      },
      /** The most recently focused window's id; throws when every window is closed. */
      get currentWindowId() { return current() },
      /**
       * Groups new tabs into a new group, emitting `onCreated`, and returns it. Throws for an
       * unknown or non-normal window, an unknown color, or an index inside another group or
       * among pinned tabs.
       */
      create: (seed: TabGroupSeed = {}): ChromeTabGroups.TabGroup => {
        const windowId = seed.windowId ?? current()
        const strip = findWindow(windowId)
        const tabCount = seed.tabCount ?? 1

        if (!Number.isInteger(tabCount) || tabCount < 1) throw new RangeError("tabCount must be a positive integer")

        color("group", "color", seed.color)

        if (strip.type !== "normal") throw new Error("Grouping is not supported by tabs in this window.")

        const requested = seed.index ?? -1
        const index = requested > strip.slots.length || requested < 0 ? strip.slots.length : requested
        checkIndex(strip, index)

        const group: ChromeTabGroups.TabGroup = {
          id: nextGroupId++,
          collapsed: seed.collapsed ?? false,
          color: seed.color ?? "grey",
          shared: seed.shared ?? false,
          title: wellFormed(seed.title ?? ""),
          windowId
        }

        groups.set(group.id, group)
        strip.slots.splice(index, 0, ...Array.from({ length: tabCount }, () => group.id))
        strip.order.push(group.id)
        const result = snapshot(group)
        created.controls.emit(snapshot(result))

        return result
      },
      /** Closes a group and its tabs, emitting `onRemoved`. */
      remove: (groupId: number) => close(groupId, false),
      /** Ungroups a group's tabs, which stay in place, emitting `onRemoved`. */
      ungroup: (groupId: number) => close(groupId, true),
      group: (groupId: number): ChromeTabGroups.TabGroup | undefined => {
        const group = groups.get(groupId)

        return group === undefined ? undefined : snapshot(group)
      },
      /** The window's tab strip: one entry per tab, its group id or -1. */
      strip: (windowId: number): ReadonlyArray<number> => [...findWindow(windowId).slots],
      onCreated: created.controls,
      onUpdated: updated.controls,
      onRemoved: removed.controls,
      onMoved: moved.controls
    }
  }
}
