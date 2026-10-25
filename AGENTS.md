# Project instructions

This is an Effect v4 ESM library for Chrome Manifest V3, not a Node runtime library.
Use strict TypeScript, NodeNext-compatible `.js` relative imports, typed errors,
Effect services/layers, and scoped listener cleanup. Never access Chrome globals
at import time. Wakeup listeners must register synchronously at worker startup;
Chrome may stop workers without executing finalizers.

New and changed Chrome modules follow `docs/CONVENTIONS.md`.

## Effect guidance and local reference

Before changing Effect patterns, run `npm run effect-solutions -- list` and
`npm run effect-solutions -- show basics services-and-layers error-handling testing`.
Guides are prescriptive context, but some setup instructions target older tools.
The installed **Effect 4.0.4** source is available at `node_modules/effect/src/`
after `npm ci`; inspect its signatures and implementation rather than guessing
v3 APIs. In particular, see `Effect.ts`, `Context.ts`, `Layer.ts`, `Stream.ts`,
`Schema.ts`, and `persistence/KeyValueStore.ts`. The current upstream v4 repository
is https://github.com/Effect-TS/effect (the guides' effect-smol URL is historical).
No separate reference checkout is required or claimed to exist.

## Validation and tooling

Run `npm run lint`, `npm run typecheck`, `npm run build`, and `npm test`.
Lint enforces zero warnings as well as zero errors.
Tests use exact `@effect/vitest@4.0.4`, `vitest@5.0.4`, and `effect@4.0.4` with
explicit Chrome mocks; do not silently allow missing tests. The integration peers
require Effect `^4.0.4` and Vitest `>=5 <6`; do not follow stale beta install advice.
Return Effects directly from `it.effect`, using `Effect.gen` and `yield*` rather
than `runPromise` wrappers. Test scope and TestClock are automatic. Use
`forkScoped` / `forkChild` for owned fibers and join or interrupt before assertions;
keep explicit inner scopes when checking cleanup before test completion. Use
`Effect.flip` for typed errors and `Effect.exit` for defects/interruption.
Advance genuine Effect deadlines with `TestClock.adjust` from `effect/testing`.
Synchronize Chrome registration with explicit mock gates, not sleeps or assumed
scheduler turns. Preserve ordinary async tests at intentional AbortSignal,
native callback, and ManagedRuntime Promise lifecycle boundaries; independent
runtimes do not inherit the test clock. Keep injected layers/mocks fresh per test
and preserve stress counts and race semantics. Test-only unstable-API suppressions
document the pinned integration; they do not relax production API discipline.
Root lint targets `src`, `test`, and `vitest.config.ts`, not generated files or
independently configured examples. Keep native Chrome callback boundaries intact;
if a lint recommendation cannot safely apply, explain it in a narrow suppression.

`npm ci` runs `effect-tsgo patch --oxlint`, patching TypeScript and Oxlint with
the pinned compatible integration. Do not run the legacy JS language-service
patcher or a second tsgo language server alongside it. Effect diagnostics come
from Oxlint; the editor plugin has `diagnostics: false` to avoid duplicates.
Upgrade integration/compiler/linter versions together after checking the
@effect/tsgo supported-version table and actually running prepare.

## Vendored anti-slop

Generic and Effect anti-slop plugins live in `tools/oxlint/anti-slop/`; preserve
their MIT licenses and pinned provenance in `UPSTREAM.md`. There is no official
npm package. Keep `@oxlint/plugins` exactly matched to resolved Oxlint. Preserve
the recommended Effect preset and root lint scope when updating the plugin.
Do not blindly autofix semantic rules or fabricate type evidence to satisfy lint.
Use meaningful `SAFETY:` comments for necessary assertions. The documented
file-specific raw Chrome message/storage exceptions are I/O boundaries, not
permission to introduce unknown contracts in domain logic. Keep additional
exceptions narrow and justified. After API changes also run WXT's typecheck/build.
