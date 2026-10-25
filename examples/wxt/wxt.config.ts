import { defineConfig } from "wxt"

export default defineConfig({
  manifestVersion: 3,
  // Scope-aware parsing prevents library-local `storage` parameters in the
  // linked dist from being mistaken for WXT's auto-imported storage helper.
  imports: { parser: "acorn" },
  // The linked library has its own dev dependency on Effect. Bundle one copy.
  vite: () => ({ resolve: { dedupe: ["effect"] } }),
  manifest: {
    name: "Effect Chrome: all integrations",
    description: "Vanilla WXT demo of Effect Chrome services and MV3 lifecycle handling",
    // This example is also the opt-in live integration stress host.
    permissions: [
      "storage", "alarms", "tabs", "scripting", "identity", "webNavigation", "cookies", "notifications", "activeTab",
      "bookmarks", "history", "downloads", "tabGroups", "sessions", "management", "contextMenus", "idle",
      "sidePanel", "tabCapture", "debugger", "offscreen", "declarativeNetRequest", "webRequest", "userScripts"
    ],
    omnibox: { keyword: "effect-stress" },
    side_panel: { default_path: "sidepanel.html" },
    commands: { "stress-command": { description: "Effect Chrome stress command" } },
    // The limits runner sets and evicts cookies only on this reserved test host.
    host_permissions: ["https://limits.effect-platform-chrome.test/*"],
    optional_host_permissions: ["https://example.com/*"],
    // Lets example.com open the popup page in a tab, so browser automation that cannot type
    // chrome-extension:// URLs can still reach the stress and limits runners.
    web_accessible_resources: [{ resources: ["popup.html", "chunks/*", "assets/*"], matches: ["https://example.com/*"] }],
    minimum_chrome_version: "120"
  }
})
