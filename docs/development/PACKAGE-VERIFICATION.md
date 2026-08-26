# Package artifact verification

The SDK ships a tree-shakeable dual ESM + CJS build with ~30 subpath exports.
Three mechanical guards keep the publish artifact honest so packaging regressions
fail CI instead of reaching consumers.

**How they run in CI** (all three live in `.github/workflows/ci.yml`):

- `check:package-size` is a fast, offline `npm pack --dry-run` audit, so it runs
  after every `library-build`. It caps packed bytes, unpacked bytes, file count,
  and the generated declaration sizes, and requires the exact schema façade.
- `check:package` is cheap and offline, so it runs on **every PR** as a step in
  the `library-build` job.
- `verify:package` does a live registry install, so it runs in the
  `package-smoke` job, whose expensive steps fire **only when a
  packaging-relevant file changed** (exports map, build config, declaration/emit
  scripts, dependency pins, or the smoke script itself). The job always
  completes — when nothing packaging-relevant changed, its steps are skipped and
  it passes — so it is safe to include in the required `test` aggregator and
  never hangs pending.

**Coverage tradeoff:** because `package-smoke` is gated on packaging paths (not
`src/lib/**`), a source-only change that drifts a peer floor — e.g. a new import
that needs a higher `@modelcontextprotocol/sdk` — won't run the smoke on that
PR. Bumping a dependency floor goes through `package.json` (which *is* gated),
so the common case is covered; a floor requirement introduced purely in source
without a manifest change is the residual gap.

## `npm run check:package` — static export-map checks

Runs [`publint --strict`](https://publint.dev) and
[`attw --pack .`](https://arethetypeswrong.github.io) against the built package.

- **publint** validates the `exports` map: condition ordering (`types` first),
  file existence, and format correctness.
- **attw** resolves every subpath through the four module-resolution modes
  (`node10`, `node16` from CJS, `node16` from ESM, `bundler`) and flags
  mismatches — the classic one being an ESM `.mjs` file typed by a CJS `.d.ts`
  ("masquerading as CJS").

Requires a prior `npm run build:lib` (it inspects `dist/`).

## `npm run check:package-size` — publish-size budgets

`scripts/check-package-size.mjs` asks npm for the exact dry-run pack manifest
and fails closed if its size metadata is missing. It enforces budgets for
compressed bytes, installed bytes, and entry count, plus separate limits for
the canonical generated schema declaration and its ESM façade. Because it runs
unconditionally after `build:lib`, growth from any packaged source, generated
schema, or copied cache is covered even when the live package smoke is skipped.
The full `verify:package` smoke imports and runs the same checker.

### Why the build emits `.d.mts`

The package is `type: commonjs`, so a `.d.ts` is a CJS-format declaration. The
`import` condition resolves to `.mjs` (real ESM), so it needs an ESM-format
declaration or attw reports "masquerading as CJS". `scripts/generate-dmts-declarations.ts`
runs at the end of `build:lib`: it normally copies each `.d.ts` to `.d.mts` and
appends explicit `.mjs` / `/index.mjs` extensions to relative specifiers (ESM
declaration resolution requires them) — the declaration-layer companion to the
runtime import-fixers in `tsup.config.ts`. Each subpath's `exports` entry then
carries per-condition types:

```jsonc
"./auth": {
  "import":  { "types": "./dist/lib/auth/index.d.mts", "default": "./dist/lib/auth/index.mjs" },
  "require": { "types": "./dist/lib/auth/index.d.ts",  "default": "./dist/lib/auth/index.js" }
}
```

The `./types/*` wildcard export stays a single `types`-only condition: the
per-tool slices under `dist/lib/types/` are self-contained type-only artifacts
(no runtime), so they have no `import`/`require` to split, and attw resolves the
wildcard cleanly. Because those slices are never reached through an `import`
condition, the generator **skips** emitting `.d.mts` for them (keyed off
`per-tool-index.json`), trimming ~5.5 MB of otherwise-unreachable declarations.

The generated Zod schema declaration is the other exception. Its fully
inferred type graph is tens of MiB, so duplicating it byte-for-byte would make
the installed package tens of MiB larger. The ESM declaration is instead an
exact façade:

```ts
export * from './schemas.generated.js';
```

TypeScript's declaration extension substitution resolves that `.js` specifier
to the canonical `schemas.generated.d.ts`, preserving the complete `.shape`,
`.pick`, `z.input`, and `z.output` surface without re-annotating or weakening
the public types. The generator and package-size audit both fail closed if the
façade contract becomes unsafe.

## `npm run verify:package` — clean-room dual-format smoke

`scripts/verify-package.mjs` packs a tarball and first installs it with pnpm's
seven-day `minimumReleaseAge` policy in a throwaway project. It then installs
the tarball plus its **required** peers pinned to their **range floors** and
`tldts@7.0.0` into another throwaway dir under `os.tmpdir()`
(outside the workspace, so npm resolution is honest and not monorepo-deduped),
then loads the main, enums, server, testing, and schemas entry points through
both a real ESM `import` and a real CJS `require`, asserting each loads and
exposes a known runtime symbol. It also type-checks the exact generated schema
surface from `.mts` and `.cts` consumers. `server` is included so the
`@a2a-js/sdk` peer gets real ESM/CJS load coverage through a dedicated
entrypoint. Optional peers
(`peerDependenciesMeta`) are **not** installed — no tested subpath loads them,
so pinning them would add only install weight and registry-flake surface. The
floor/load smoke uses `npm install` (never workspace pnpm/catalog), and both
temporary projects are cleaned up on exit. Requires pnpm 10.19 or newer, plus a
prior `npm run build:lib`.

This is what catches a peer floor that is declared lower than the code needs:
CJS named-import interop can mask a too-low pin, but a real ESM import surfaces
it as a load-time `ERR_MODULE_NOT_FOUND`.

## Peer-dependency floor rationale

`verify:package` installs the required peers at their floors on every run;
their floors are pinned to what the code actually imports. (Optional peers are
listed for completeness but the smoke does not install them.)

| Peer | Floor | How the SDK uses it | Why the floor |
| --- | --- | --- | --- |
| `@a2a-js/sdk` | `^1.0.1` | Client and server use the official 1.0 Agent Card, JSON-RPC transport, extension activation, and compatibility APIs | AdCP 3.2 normatively profiles A2A 1.0 and requires the `https://adcontextprotocol.org/extensions/adcp/v3` extension. |
| `@modelcontextprotocol/sdk` | `^1.24.0` | `src/lib/server/{serve,tasks,postgres-task-store}.ts` import `@modelcontextprotocol/sdk/experimental/tasks/*` | `experimental/tasks/stores/in-memory.js` first ships in **1.24.0** (absent in 1.23.1). The main entry eagerly loads `server/tasks`, so any consumer importing `@adcp/sdk` on `< 1.24.0` hits `ERR_MODULE_NOT_FOUND`. Corrected from an earlier `^1.17.5`. |
| `zod` | `^4.1.5` | Bare `import … from 'zod'` only (no `zod/v4` subpaths); top-level v4 API | v4 top-level surface; loads at the supported peer floor while development tracks the current compatible 4.x release. |
| `@opentelemetry/api` | `^1.0.0` (optional) | Metrics/tracing | Stable 1.x API. Not installed by the smoke. |
| `pg` | `^8.0.0` (optional) | `postgres-task-store` | Stable 8.x `Pool`/`Client` API. Not installed by the smoke. |
| `redis` | `^4.6.0 \|\| ^5.0.0 \|\| ^6.0.0` (optional) | Redis-backed stores | All three supported major lines use the async client APIs consumed by the SDK. Not installed by the smoke. |

When a floor changes, update both `package.json#peerDependencies` and this
table, then rerun `verify:package` to confirm the new floor loads.
