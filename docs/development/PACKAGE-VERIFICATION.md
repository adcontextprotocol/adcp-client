# Package artifact verification

The SDK ships a tree-shakeable dual ESM + CJS build with ~30 subpath exports.
Two mechanical guards keep the publish artifact honest so packaging regressions
fail CI instead of reaching consumers.

**How they run in CI** (both live in `.github/workflows/ci.yml`):

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

### Why the build emits `.d.mts`

The package is `type: commonjs`, so a `.d.ts` is a CJS-format declaration. The
`import` condition resolves to `.mjs` (real ESM), so it needs an ESM-format
declaration or attw reports "masquerading as CJS". `scripts/generate-dmts-declarations.ts`
runs at the end of `build:lib`: it copies each `.d.ts` to `.d.mts` and appends
explicit `.mjs` / `/index.mjs` extensions to relative specifiers (ESM
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

## `npm run verify:package` — clean-room dual-format smoke

`scripts/verify-package.mjs` packs a tarball, installs it plus its **required**
peers pinned to their **range floors** into a throwaway dir under `os.tmpdir()`
(outside the workspace, so npm resolution is honest and not monorepo-deduped),
then loads `@adcp/sdk`, `@adcp/sdk/enums`, and `@adcp/sdk/server` through both a
real ESM `import` and a real CJS `require`, asserting each loads and exposes a
known runtime symbol. `server` is included so the `@a2a-js/sdk` peer gets real
ESM/CJS load coverage through a dedicated entrypoint. Optional peers
(`peerDependenciesMeta`) are **not** installed — no tested subpath loads them,
so pinning them would add only install weight and registry-flake surface. It
uses `npm install` in the temp dir (never workspace pnpm/catalog) and cleans up
on exit. Requires a prior `npm run build:lib`.

This is what catches a peer floor that is declared lower than the code needs:
CJS named-import interop can mask a too-low pin, but a real ESM import surfaces
it as a load-time `ERR_MODULE_NOT_FOUND`.

## Peer-dependency floor rationale

`verify:package` installs the required peers at their floors on every run;
their floors are pinned to what the code actually imports. (Optional peers are
listed for completeness but the smoke does not install them.)

| Peer | Floor | How the SDK uses it | Why the floor |
| --- | --- | --- | --- |
| `@a2a-js/sdk` | `^0.3.13` | `@adcp/sdk/server` imports `agentCardHandler` from `@a2a-js/sdk/server/express` | That subpath first exists in 0.3.13 (see the #2344 changeset). |
| `@modelcontextprotocol/sdk` | `^1.24.0` | `src/lib/server/{serve,tasks,postgres-task-store}.ts` import `@modelcontextprotocol/sdk/experimental/tasks/*` | `experimental/tasks/stores/in-memory.js` first ships in **1.24.0** (absent in 1.23.1). The main entry eagerly loads `server/tasks`, so any consumer importing `@adcp/sdk` on `< 1.24.0` hits `ERR_MODULE_NOT_FOUND`. Corrected from an earlier `^1.17.5`. |
| `zod` | `^4.1.5` | Bare `import … from 'zod'` only (no `zod/v4` subpaths); top-level v4 API | v4 top-level surface; loads at floor. Dev pin `^4.1.12` is a patch-level gap. |
| `@opentelemetry/api` | `^1.0.0` (optional) | Metrics/tracing | Stable 1.x API. Not installed by the smoke. |
| `pg` | `^8.0.0` (optional) | `postgres-task-store` | Stable 8.x `Pool`/`Client` API. Not installed by the smoke. |
| `redis` | `^4.6.0 \|\| ^5.0.0` (optional) | Redis-backed stores | Both major lines supported. Not installed by the smoke. |

When a floor changes, update both `package.json#peerDependencies` and this
table, then rerun `verify:package` to confirm the new floor loads.
