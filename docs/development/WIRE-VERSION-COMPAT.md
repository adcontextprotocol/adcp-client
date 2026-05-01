# Wire Version Compat Playbook

How `@adcp/sdk` keeps a buyer pinned to one AdCP major version while talking to sellers running other ones, and the recipe for adding a new compat shim when the SDK pin moves or a legacy seller version needs ongoing support.

> **Audience: SDK contributors.** Adopters consuming the SDK don't need any of this — they call `agent.getProducts(...)` and the wire shape they get against a v2.5 seller is the same v3 surface they get against a v3 seller. This playbook is for the people maintaining that property.

## The shape of the problem

The SDK speaks a single AdCP major version on its public surface — `ADCP_VERSION` in `src/lib/version.ts`. As of writing that's `3.0.1`. Every buyer-facing type, helper, and example assumes v3 shape.

In the field, sellers don't all upgrade in lockstep. There are still v2.5 sellers (Wonderstruck, others) and there will be v4 sellers before every v3 seller has finished migrating. The SDK has to:

1. **Detect** what version a seller speaks (`SingleAgentClient.detectServerVersion`).
2. **Adapt** v3-shaped requests down to the seller's wire shape on the way out.
3. **Normalize** the seller's response back up to v3 on the way in.
4. **Validate** against the seller's schema — not the SDK's pin — so we don't reject legitimate responses as malformed.
5. **Surface drift** when the adapter or the seller produces something the schema rejects, without silently dropping data.

There is exactly one active legacy compat layer at a time today: `legacy/v2-5/`. That's intentional. See [N=1 vs N×M](#n1-vs-nm) below.

## What's already wired

### Schema cache

```
schemas/cache/
├── 3.0.1/   # current SDK pin
├── latest/  # symlink to 3.0.1
└── v2.5/    # legacy bundle, pulled from 2.5-maintenance HEAD
```

Refresh:

```sh
npm run sync-schemas         # SDK pin
npm run sync-schemas:v2.5    # legacy bundle
npm run sync-schemas:all     # both
```

`sync-v2-5-schemas.ts` pulls from a pinned `2.5-maintenance` SHA with a sha256 verification — published v2.5 tags are stale (see `adcontextprotocol/adcp#3689` upstream).

### Generated types

```
src/lib/types/
├── tools.generated.ts   # v3 (SDK pin)
└── v2-5/
    └── tools.generated.ts
```

Regenerate after a schema bump:

```sh
npm run generate-types         # v3
npm run generate-types:v2.5    # v2.5
npm run generate-types:all
```

The v2.5 codegen runs through the same `enforceStrictSchema` / `removeNumberedTypeDuplicates` pipeline as v3 (`scripts/generate-v2-5-types.ts`), so the export shape matches.

### Adapter registry

```
src/lib/adapters/legacy/v2-5/
├── types.ts                     # AdapterPair<TReq3, TReq25, TRes25, TRes3>
├── index.ts                     # getV25Adapter(toolName) + listV25AdapterTools()
├── get_products.ts              # one module per registered tool
├── create_media_buy.ts
├── update_media_buy.ts
├── sync_creatives.ts
├── list_creative_formats.ts
└── preview_creative.ts
```

Each per-tool module exports a typed `AdapterPair`:

```ts
export const getProductsAdapter: AdapterPair<
  GetProductsRequest,           // v3 input
  V25.GetProductsRequest,       // v2.5 wire
  V25.GetProductsResponse,      // v2.5 wire
  GetProductsResponse           // v3 surface
> = {
  toolName: 'get_products',
  adaptRequest: adaptGetProductsRequestForV2,
  // normalizeResponse?: ...   // optional; pass-through if absent
};
```

`SingleAgentClient.adaptRequestForServerVersion` and `normalizeResponseToV3` dispatch through `getV25Adapter(taskType)` rather than carrying tool-specific switch statements. Adding or removing a per-tool pair doesn't touch the dispatch.

### Version-pinned validation

`TaskExecutor.validateResponseSchema` validates against the version the seller actually spoke, derived from `lastKnownServerVersion` (set by `detectServerVersion`). Without this, a v2.5 seller's perfectly valid v2.5-shaped response would be rejected as malformed v3. See `TaskExecutor.ts` line ~1835:

```ts
const validationVersion = this.lastKnownServerVersion === 'v2' ? 'v2.5' : this.config.adcpVersion;
```

### Drift surface

Every adapter run feeds two debug-log channels:

- **Pre-send**: `validateOutgoingRequest` (warn-only by default, see `client-hooks.ts`) — catches the SDK shipping a v2.5-rejecting payload.
- **Post-adapter**: `validateAdaptedRequestAgainstV2` (warn-only) — catches the adapter producing an off-spec shape *after* v3 → v2.5 translation.

Both feed `result.debug_logs`. Buyers see `Schema validation warning for <tool>: <issues>` entries with the concrete pointer (e.g. `/creatives/0/assets/asset_type`) without losing the response payload.

Response-side validation defaults to **warn** as well (changed in #1172) — v2.5 sellers ship enough legacy drift (envelope nulls, optional-but-required fields, enum mismatches) that strict-by-default rejected too much real data.

### Conformance fixtures

`test/lib/adapter-v2-5-conformance.test.js` runs each adapter's request-side output against `schemas/cache/v2.5/` and asserts conformance. Tools with KNOWN drift get an `expected_failures` entry pinning the failure mode so a fix that closes the gap surfaces as an unexpected pass and prompts a fixture flip.

`test/lib/legacy-v2-5-adapter-registry.test.js` asserts that every registered pair's `adaptRequest` produces the same output as the underlying `utils/*-adapter.ts` helper (regression-only check that the registry wrapper doesn't drift from its source).

### Smoke harness

`scripts/smoke-wonderstruck-v2-5.ts` calls a v2.5 seller through the SDK end-to-end and reports `result.debug_logs` drift. Run it after touching anything in this stack — the harness is the canary that surfaces all five problems above against a real seller.

```sh
npx tsx scripts/smoke-wonderstruck-v2-5.ts
```

Auto-detects Wonderstruck from `SALES_AGENTS_CONFIG`; trivial to point at any v2 seller.

## Recipe: adding a new wire-shape compat shim

Use this when one of:

- The SDK's `ADCP_VERSION` pin moves up (e.g. v3 → v4) and v3 sellers need ongoing support → add `legacy/v3/` alongside `legacy/v2-5/`.
- A new legacy version that nobody covered before becomes important (e.g. a v2.6 patch that diverged enough to need its own shim).

Each numbered step is a discrete commit. Steps 1–3 land before step 4 (the registry references types that don't exist yet otherwise).

### 1. Pull the schema bundle

Add `scripts/sync-<version>-schemas.ts` modeled on `sync-v2-5-schemas.ts`:

- Pin the source — branch SHA + sha256 — so CI builds are reproducible.
- Drop output at `schemas/cache/<version>/` matching the existing layout (`core/`, `media-buy/`, etc.).
- Wire it into `package.json#scripts`:
  - `sync-schemas:<version>` — direct invocation
  - `sync-schemas:all` — append it to the chain so a single command refreshes everything

Verify with `ls schemas/cache/<version>/media-buy/` after running.

### 2. Generate types

Add `scripts/generate-<version>-types.ts` modeled on `scripts/generate-v2-5-types.ts`:

- Compile each tool's request + response schemas as one mega-schema (so re-referenced types collapse to a single export).
- Run output through `enforceStrictSchema` and `removeNumberedTypeDuplicates` — both exported from `scripts/generate-types.ts`.
- Write to `src/lib/types/<version-dir>/tools.generated.ts`. Add `index.ts` re-exporting the surface you want adapters to import.
- Wire into `package.json#scripts`:
  - `generate-types:<version>`
  - Append to `generate-types:all`

Add to the package's published files in `package.json`:

```json
"files": [
  "dist/lib/**/*",
  ...
]
```

`dist/lib/types/<version-dir>/` ships under `dist/lib/**/*`. No package.json change needed unless you're adding an export-map subpath (e.g. `@adcp/sdk/types/v2-5`) — in that case mirror the existing `./types/v2-5` entry in `package.json#exports`.

### 3. Verify the schema bundle ships in the published tarball

Bundle path matters because `schema-loader.ts` resolves bundle keys at runtime against `dist/lib/schemas-data/<key>/`. The `copy-schemas-to-dist` build step picks up `schemas/cache/<version>/` automatically — verify with:

```sh
npm run build:lib
ls dist/lib/schemas-data/
```

You should see your new bundle alongside `3.0/` and `v2.5/`.

### 4. Add the per-tool adapter modules

For each tool that diverges between SDK pin and the new legacy version:

```
src/lib/adapters/legacy/<version>/
├── types.ts            # AdapterPair<...> (copy from legacy/v2-5/types.ts; same shape)
├── index.ts            # getV<X>Adapter(toolName) + listV<X>AdapterTools()
├── <tool>.ts           # one per registered tool
└── ...
```

Each tool module:

```ts
import type { AdapterPair } from './types';
import type { GetProductsRequest, GetProductsResponse } from '../../../types';
import type {
  GetProductsRequest as V<X>GetProductsRequest,
  GetProductsResponse as V<X>GetProductsResponse,
} from '../../../types/<version-dir>';
import { adaptGetProductsForV<X> } from '../../../utils/...';

export const getProductsAdapter: AdapterPair<
  GetProductsRequest,
  V<X>GetProductsRequest,
  V<X>GetProductsResponse,
  GetProductsResponse
> = {
  toolName: 'get_products',
  adaptRequest: adaptGetProductsForV<X>,
  // normalizeResponse: ...   // optional
};
```

The actual adapter logic lives in `src/lib/utils/*-adapter.ts` (existing v2 helpers) or a new `src/lib/utils/<tool>-adapter-v<X>.ts` for the new version. The registry is a wrapper layer — it doesn't own the translation logic.

`index.ts`:

```ts
import type { AdapterPair } from './types';
import { getProductsAdapter } from './get_products';
// ... other tools

const PAIRS: ReadonlyArray<AdapterPair> = [
  getProductsAdapter,
  // ...
];

const REGISTRY: ReadonlyMap<string, AdapterPair> = new Map(PAIRS.map(p => [p.toolName, p]));

export type { AdapterPair } from './types';
export function getV<X>Adapter(toolName: string): AdapterPair | undefined {
  return REGISTRY.get(toolName);
}
export function listV<X>AdapterTools(): string[] {
  return [...REGISTRY.keys()];
}
```

### 5. Wire the dispatch

`SingleAgentClient.adaptRequestForServerVersion` currently has:

```ts
if (version !== 'v3') {
  const pair = getV25Adapter(taskType);
  if (pair) adapted = pair.adaptRequest(params);
}
```

Generalize to dispatch on the detected version:

```ts
const adapter = selectAdapterRegistry(version);    // returns getV25Adapter | getV3Adapter | undefined
if (adapter) {
  const pair = adapter(taskType);
  if (pair) adapted = pair.adaptRequest(params);
}
```

`detectServerVersion` returns `'v2' | 'v3'` today — extend the discriminator to whatever new versions you're supporting (probably `'v2' | 'v3' | 'v4'`). Keep the discriminator narrow — version detection is a string match against the seller's `tools/list`, not a semver parse.

Mirror the change in `normalizeResponseToV3` (or rename to `normalizeResponseToCurrent` if the SDK pin moves above v3).

### 6. Wire validation pinning

`TaskExecutor.validateResponseSchema` derives `validationVersion` from `lastKnownServerVersion`:

```ts
const validationVersion = this.lastKnownServerVersion === 'v2' ? 'v2.5' : this.config.adcpVersion;
```

Extend this to map every legacy version to its bundle key. The map should mirror `selectAdapterRegistry` from step 5 — version detected → schema bundle to validate against. Don't fall back to `this.config.adcpVersion` for unknown versions; that's how we ended up with v3 schemas rejecting v2.5 responses pre-#1137.

### 7. Conformance fixtures

`test/lib/adapter-v<version>-conformance.test.js`:

- Canonical v3 input per registered tool.
- Run through the adapter, validate output against the new bundle.
- KNOWN drift gets `expected_failures: { issue, pointers: [...] }` so a fix surfaces as an unexpected pass.

`test/lib/legacy-v<version>-adapter-registry.test.js`:

- Every registered pair's `adaptRequest` matches the underlying `utils/*` helper for the same input.
- `listV<X>AdapterTools()` returns every tool that has a fixture.
- `getV<X>Adapter('not_a_real_tool')` returns `undefined`.

### 8. Smoke harness

Copy `scripts/smoke-wonderstruck-v2-5.ts` to `scripts/smoke-<seller>-v<version>.ts` and adjust:

- Change the seller-name regex in `getAgentIds().find(...)` to match a known seller running the new version.
- Add or remove probe calls based on which tools you adapted.

The smoke is a developer tool, not a test — keep it under `scripts/` (excluded from `package.json#files`).

### 9. Changeset + PR

```sh
npm run changeset
```

Pick `minor` for adding a new legacy compat layer (additive). Description should call out:

- Which version(s) are now supported.
- Whether the SDK pin moved (and if so, what changed for adopters).
- Whether the smoke harness actually round-tripped against a live seller (link the smoke output if so).

PR body should reference this playbook so reviewers can verify each step landed.

## N=1 vs N×M

The directory tree is `legacy/v2-5/`, not `v3-to-v2-5/`. That's intentional and worth understanding before extending it.

A full `(SDK_version × seller_version)` matrix would be N×M files for N SDK versions × M seller versions, with corresponding test coverage. In practice nobody staffs that. Look at OpenRTB, Prebid, GAM — each maintains exactly one active legacy compat layer with a deprecation runway, then drops it when adoption is below the support floor.

This SDK follows the same pattern:

- **Today:** SDK pinned to v3, one legacy shim for v2.5, no shim for v3 (it's the pin).
- **When SDK moves to v4:** the v2.5 shim sunsets (deprecation notice + version), a new v3 shim joins. Two active legacy shims briefly, dropping back to one when v2.5 hits end-of-support.
- **What we don't do:** maintain v2.5 + v3 + v4 + v5 simultaneously. Adopters who need ancient compat pin to an older SDK major.

The directory tree (`legacy/<seller-version>/`) reflects this: the SDK's current pin is implicit and the only thing on disk is the exceptional, time-boxed compat work. If we ever staff a true matrix, the tree shape changes; until then, encoding one would be larping.

## Compatibility today

| SDK version | Talks to seller | Path |
|---|---|---|
| 6.x (pin: v3) | v3 | direct (no adaptation, no validator pinning) |
| 6.x (pin: v3) | v2.5 | `legacy/v2-5/` adapter registry; v2.5 schema validation; warn-only drift surface |
| 6.x (pin: v3) | v2.x (pre-2.5) | unsupported — pin to `@adcp/sdk@5.x` |
| 6.x (pin: v3) | v4+ | unsupported — buyer SDK upgrade required |

Detection happens at first call (`detectServerVersion` reads the seller's `tools/list` capabilities) and is cached on `lastKnownServerVersion` for the rest of the agent's lifecycle.

## Testing checklist for compat changes

- [ ] `npm run test:lib` — full library suite green.
- [ ] `test/lib/adapter-v<version>-conformance.test.js` — every fixture either passes outright or has a pinned `expected_failures` entry.
- [ ] `test/lib/legacy-v<version>-adapter-registry.test.js` — all pairs registered, smoke check that `adaptRequest` matches its underlying helper.
- [ ] Smoke harness against a live seller — `npx tsx scripts/smoke-<seller>-v<version>.ts` produces zero unexpected `drift_warnings` in `result.debug_logs`.
- [ ] Schema-cache regen check — `npm run ci:schema-check` passes (the script that regenerates types and diffs against the committed output).

If you can run all five and the output is clean, the compat path is honest.

## When N=1 isn't enough

If the SDK ends up needing two simultaneous legacy shims (e.g. v2.5 still has long-tail adopters when v3 sunsets and v4 is the new pin), the dispatch layer in step 5 already accommodates that — `selectAdapterRegistry` returns the right registry per detected version and per-tool adapters live in their own subdirectories.

The harder problem at that scale is human attention. Each active shim costs:

- Schema cache to refresh quarterly.
- Per-tool adapters to update when the SDK adds a v3 (or v4) tool.
- Conformance fixtures and smoke harness to keep pointed at a live seller of that version.
- Drift triage when sellers wander off-spec.

Two shims is plausible. Three is where the maintenance cost and the actual adoption signal need a hard look. The directory shape doesn't prevent it; the calendar does.

## Cross-references

- [`docs/development/PROTOCOL_DIFFERENCES.md`](./PROTOCOL_DIFFERENCES.md) — MCP vs A2A, transport-level differences (orthogonal to wire-version compat but commonly conflated).
- [`docs/migration-5.x-to-6.x.md`](../migration-5.x-to-6.x.md) — what changed for adopters between SDK majors.
- [`scripts/generate-v2-5-types.ts`](../../scripts/generate-v2-5-types.ts) — the v2.5 codegen, model for new versions.
- [`src/lib/adapters/legacy/v2-5/index.ts`](../../src/lib/adapters/legacy/v2-5/index.ts) — the registry pattern in code.
- [`test/lib/adapter-v2-5-conformance.test.js`](../../test/lib/adapter-v2-5-conformance.test.js) — conformance fixture model.
