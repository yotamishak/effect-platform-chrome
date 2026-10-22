import { Effect } from "effect"
import * as ChromeRpc from "effect-platform-chrome/ChromeRpc"
import { defineContentScript } from "wxt/utils/define-content-script"
import { FrameRpc, framePort, roleParam } from "../shared/limits.js"

// Target frames for the limits runner (popup/limits.ts). Inactive unless the page URL
// carries the role parameter; the runner opens example.com with it. webNavigation does
// not report extension pages, so the targets have to be web pages. Roles:
// - top: builds the frame tree below and serves FrameRpc itself;
// - child: serves FrameRpc;
// - other: listens on onConnect but never serves (a port reaching it is never answered);
// - silent: no listener at all (a port to it disconnects at once);
// - plain: serves FrameRpc with no child frames (navigation target).
export default defineContentScript({
  matches: ["https://example.com/*"],
  allFrames: true,
  main(ctx) {
    const params = new URL(location.href).searchParams
    const role = params.get(roleParam)
    if (role === null) return

    if (role === "top") {
      const children = Number(params.get("children") ?? "4")
      const frame = (query: string) => {
        const element = document.createElement("iframe")
        element.src = `https://example.com/?${roleParam}=${query}`
        document.body.append(element)
      }
      for (let index = 0; index < children; index++) frame(`child&index=${index}`)
      frame("other")
      frame("silent")
    }

    const handlers = FrameRpc.toLayer({
      Echo: ({ text }) => Effect.succeed(text),
      PushStates: ({ from, count }) => Effect.sync(() => {
        for (let index = from; index < from + count; index++) {
          history.pushState(null, "", `?${roleParam}=${role}&push=${index}`)
        }
        return Number(new URL(location.href).searchParams.get("push") ?? "-1")
      }),
      Where: () => Effect.sync(() => ({ url: location.href, top: window.top === window }))
    })

    const listener = role === "other"
      ? () => undefined
      : (port: chrome.runtime.Port) => {
        if (port.name !== framePort) return
        void Effect.runPromise(ChromeRpc.serve(chrome.runtime, port, "owned", FrameRpc).pipe(Effect.provide(handlers)))
      }
    if (role !== "silent") {
      chrome.runtime.onConnect.addListener(listener)
      ctx.onInvalidated(() => chrome.runtime.onConnect.removeListener(listener))
    }
  }
})
