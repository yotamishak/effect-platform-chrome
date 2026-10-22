import { Effect, Schema } from "effect"
import * as ChromeMessage from "effect-platform-chrome/ChromeMessage"
import * as ChromeRuntime from "effect-platform-chrome/ChromeRuntime"
import { defineContentScript } from "wxt/utils/define-content-script"
import { channel, Request } from "../shared/protocol"

export default defineContentScript({
  matches: ["https://example.com/*"],
  main(ctx) {
    // Only Runtime is used here: storage.session is not exposed to content
    // scripts by default, and this demo does not broaden its access level.
    const runtime = ChromeRuntime.make(chrome.runtime)
    const listener = (message: unknown, _sender: chrome.runtime.MessageSender,
      respond: (response: unknown) => void) => {
      if (typeof message !== "object" || message === null ||
        !("channel" in message) || message.channel !== `${channel}/content`) return false
      respond(ChromeMessage.succeed({ title: document.title, url: location.href, source: "content" }))
      return false // synchronous response; no dangling async channel
    }
    chrome.runtime.onMessage.addListener(listener)
    ctx.onInvalidated(() => chrome.runtime.onMessage.removeListener(listener))
    void Effect.runPromise(runtime.request(Request, Schema.Unknown, {
      channel, op: "ping", text: "Hello from the example.com content script"
    })).then((result) => console.info("Effect demo content → background:", result),
      (error: unknown) => console.error("Effect demo content message failed:", error))
  }
})
