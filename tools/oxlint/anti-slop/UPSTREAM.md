# Vendored anti-slop

- Source: https://github.com/dmmulroy/anti-slop
- Revision: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`
- Installed from the revision's `skills/install-anti-slop/assets/anti-slop/`
  using its bundled `scripts/install.mjs`; the assets match canonical production
  `src/` (upstream test files are intentionally not bundled by the skill).
- Entry points: `index.ts` (generic) and `effect/index.ts` (Effect).
- License: upstream MIT text in `LICENSE`. The nested ESLint Stylistic MIT
  `vendor/eslint-stylistic/LICENSE` and `UPSTREAM.md` are preserved.
- Production source is unchanged. This provenance file and upstream root license
  are the only additions to the copied source. Keep this revision recoverable for
  three-way updates; do not overwrite local customizations during upgrades.

## Local configuration policy

`.oxlintrc.json` retains the recommended `@effect/tsgo` preset and enables all
18 generic rules, all five Effect rules, and `oxc/no-accumulating-spread` at error.
`@oxlint/plugins` is pinned to `1.87.0`, exactly matching resolved Oxlint; the
compatible compiler/Effect integration versions have not been upgraded.

The following file-specific exceptions preserve the public I/O contracts, not
application-domain validation shortcuts:

- `no-unsafe-dictionary-type`: `src/ChromeStorage.ts`,
  `src/ChromeKeyValueStore.ts`, and their corresponding tests. Chrome storage is
  an open dictionary of untrusted values. The adapter must not pretend arbitrary
  persisted values are parsed; KeyValueStore decodes its own versioned envelope
  with Schema on reads. Its corruption tests intentionally store invalid data.
- `no-unknown-parameters` and `no-unknown-returns`: `src/ChromeRuntime.ts`,
  `src/ChromeTabs.ts`, and `test/ChromeTabs.test.ts`. These are protocol-agnostic
  native message transports, not domain handlers; responses must remain unknown
  until decoded. Runtime also exposes `sendMessageSchema` for typed protocols.
- `no-unknown-parameters`: `src/ChromePort.ts`, `src/ChromeServiceWorker.ts`,
  and their corresponding tests. Port payloads and worker routing receive native
  unparsed messages. Worker selectors run synchronously before claiming the
  response channel; handlers own their protocol decoding. Tests model exactly
  those boundaries. Handler *error* types remain generic, not unknown.

All other anti-slop rules remain enabled in these files. There is one inline
`no-runtime-typeof` suppression in `ChromeAlarms.ts`: it dispatches a statically
typed native overload, not untrusted input. Two file-local
`effecttsgo/unstable-api-usage` suppressions cover only the KeyValueStore adapter
and its compatibility tests, since implementing that explicitly unstable Effect
API is their purpose. Necessary remaining fixture assertions carry specific
`SAFETY:` invariant comments; negative runtime validation uses `@ts-expect-error`
rather than fabricated type evidence.

Root lint checks `src`, `test`, and `vitest.config.ts`, with zero warnings allowed.
Vendored rules, generated output, dependencies, and agent assets are ignored.
The independently configured WXT example remains outside root lint scope and is
validated with its own typecheck/build after library API changes. Effect's
service-constructor rule checks relative project imports, not package aliases.
