/**
 * Injected Chrome fixtures for tests, one module per adapter under `testing/`. Import a
 * single fixture from `effect-platform-chrome/testing/<Name>`, or all of them from here.
 * None of them reads Chrome globals.
 */
export * from "./testing/Event.js"

export * from "./testing/Storage.js"

export * from "./testing/Port.js"

export * from "./testing/Tabs.js"

export * from "./testing/Action.js"

export * from "./testing/ContextMenus.js"

export * from "./testing/Omnibox.js"

export * from "./testing/Offscreen.js"

export * from "./testing/Cookies.js"

export * from "./testing/Identity.js"

export * from "./testing/WebNavigation.js"

export * from "./testing/Notifications.js"

export * from "./testing/DeclarativeNetRequest.js"

export * from "./testing/Bookmarks.js"

export * from "./testing/Windows.js"
