import { Cause, Effect, Layer, ManagedRuntime, Schema } from "effect"
import * as ChromeSidePanel from "effect-platform-chrome/ChromeSidePanel"
import * as ChromeWindows from "effect-platform-chrome/ChromeWindows"
import { element } from "./view.js"

interface PanelInfo {
  readonly options: chrome.sidePanel.PanelOptions
  readonly layout: chrome.sidePanel.PanelLayout
  readonly behavior: chrome.sidePanel.PanelBehavior
}

interface PanelTarget {
  readonly service: ChromeSidePanel.ChromeSidePanelService
  readonly windowId: number
}

class PanelWindowUnavailable extends Schema.TaggedError<PanelWindowUnavailable>()("PanelWindowUnavailable", {}) {}

export function installSidePanel(log: (label: string, data: PanelInfo | string) => void) {
  const runtime = ManagedRuntime.make(Layer.merge(ChromeSidePanel.layerLive, ChromeWindows.layerLive))
  const openButton = element<HTMLButtonElement>("#panel-open")
  const closeButton = element<HTMLButtonElement>("#panel-close")
  const inspectButton = element<HTMLButtonElement>("#panel-inspect")
  const status = element("#panel-status")
  let target: PanelTarget | undefined

  const observe = <A, E>(label: string, effect: Effect.Effect<A, E>, format: (value: A) => PanelInfo | string) => {
    void runtime.runPromise(effect.pipe(Effect.matchCause({
      onSuccess: (value) => {
        status.textContent = label
        log(label, format(value))
      },
      onFailure: (cause) => {
        const message = Cause.pretty(cause)
        status.textContent = message
        log(`${label}: error`, message)
      }
    })))
  }

  openButton.addEventListener("click", () => {
    if (target === undefined) return

    // Start Chrome's call synchronously on this click stack, before running an Effect.
    const opening = target.service.openFromUserGesture({ windowId: target.windowId })
    observe("Side panel opened", opening, () => "The playground is now available beside your active tab.")
  })

  closeButton.addEventListener("click", () => {
    if (target === undefined) return

    observe("Side panel closed", target.service.close({ windowId: target.windowId }), () => "Closed this window's panel.")
  })

  inspectButton.addEventListener("click", () => {
    if (target === undefined) return

    const service = target.service

    const inspect = Effect.gen(function*() {
      return {
        options: yield* service.getOptions(),
        layout: yield* service.getLayout,
        behavior: yield* service.getPanelBehavior
      }
    })

    observe("Side panel options", inspect, (value) => value)
  })

  const prepare = Effect.gen(function*() {
    const service = yield* ChromeSidePanel.ChromeSidePanel
    const windows = yield* ChromeWindows.ChromeWindows
    const current = yield* windows.getCurrent()

    if (current.id === undefined) return yield* new PanelWindowUnavailable({})

    return { service, windowId: current.id }
  })

  void runtime.runPromise(prepare.pipe(Effect.matchCause({
    onSuccess: (value) => {
      target = value
      openButton.disabled = false
      closeButton.disabled = false
      inspectButton.disabled = false
      status.textContent = "Ready. Open the side panel from the button above, or inspect its options here."
    },
    onFailure: (cause) => {
      status.textContent = Cause.pretty(cause)
      log("Side panel initialization failed", status.textContent)
    }
  })))

  window.addEventListener("pagehide", () => { void runtime.dispose() }, { once: true })
}
