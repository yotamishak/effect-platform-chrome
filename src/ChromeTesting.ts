/**
 * Injected Chrome fixtures for tests, one module per adapter under `testing/`. Import a
 * single fixture from `effect-platform-chrome/testing/<Name>`, or all of them from here.
 * None of them reads Chrome globals.
 */
export * from "./testing/Event.js"

export * from "./testing/Storage.js"

export * from "./testing/Port.js"

export * from "./testing/Tabs.js"
