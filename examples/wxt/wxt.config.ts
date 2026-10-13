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
    permissions: ["storage", "alarms", "tabs", "scripting"],
    optional_host_permissions: ["https://example.com/*"],
    minimum_chrome_version: "120"
  }
})
