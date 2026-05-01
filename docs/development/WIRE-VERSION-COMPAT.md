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

**Asymmetry caveat.** The `AdapterPair` shape assumes symmetric translation, but cross-version reality is often asymmetric:

- **Lossy fields** — proposal-mode `create_media_buy` is one such case (the type comment in `legacy/v2-5/types.ts` calls out that `adaptRequest` may throw for v3 inputs the v2 wire can't represent).
- **Direction inversion for newer-than-pin sellers** — when the SDK pin is v3 and the seller is v4, `adaptRequest: TReq3 → TReq4` would have to *synthesize* fields the buyer didn't send. That direction usually isn't viable; the current SDK rejects v4+ sellers as `unsupported` and asks adopters to upgrade the SDK rather than try to forward-pad.
- **New tools in newer versions** — there's no v3 surface for them, so neither registry direction can carry them. Surface as a typed `unsupported_in_legacy` rather than silent drop.

When a future `AdapterPair` needs to declare lossiness, add a third optional method to `types.ts`:

```ts
export interface AdapterPair<...> {
  toolName: string;
  adaptRequest(req: TReq3): TReq25;
  normalizeResponse?(res: TRes25): TRes3;
  unsupported?(req: TReq3): UnsupportedReason | null; // null = supported
}
```

The dispatch checks `unsupported(req)` first and surfaces a typed `ADCPError` rather than handing a malformed payload to the seller. Don't add this until a real case needs it — the v2.5 shim's `throw` from `adaptRequest` is good enough today.

### Version-pinned validation

`TaskExecutor.validateResponseSchema` validates against the version the seller actually spoke, derived from `lastKnownServerVersion` (set by `detectServerVersion`). Without this, a v2.5 seller's perfectly valid v2.5-shaped response would be rejected as malformed v3. See the `validateResponseSchema` method (line ~1844):

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

**Where the translation logic lives — read carefully.** The existing files in `src/lib/utils/` (`pricing-adapter.ts`, `creative-adapter.ts`, `sync-creatives-adapter.ts`) carry **v2.5-specific** logic despite their unversioned names. They were written before the registry existed and the names predate the multi-version reality.

For any new wire version, **do not branch the existing v2.5 helpers**. Either:

1. **Recommended:** create a new `src/lib/utils/<tool>-adapter-v<X>.ts` per tool. The registry pair imports from there. Keeps each version's translation isolated.
2. **Acceptable for trivial deltas:** the per-tool registry module (`legacy/<version>/<tool>.ts`) inlines the translation directly, with no `utils/` helper. Reasonable when the v3 → v<X> mapping is two field renames.

`utils/*-adapter.ts` may eventually get renamed to `utils/*-adapter-v2-5.ts` when the rename is cheaper than the rename-debt; until then, treat the unversioned names as v2.5-locked. The registry is a wrapper layer — it doesn't own the translation logic, but it does own which version's logic each tool routes through.

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

Two pieces: the **detection signal** (how do we know what version the seller speaks) and the **registry selection** (which adapter table do we route through).

**Detection signal.** Prefer the authoritative channel:

1. **`get_adcp_capabilities.adcp_version`** when the seller exposes it. AdCP 3.0+ sellers declare their version explicitly in the capabilities response — this is the channel new versions should use first.
2. **`tools/list` shape sniffing** as fallback only, for sellers that predate `get_adcp_capabilities`. v2.5 sellers fall here today; v4+ should not.

`detectServerVersion` currently returns `'v2' | 'v3'` from `tools/list` sniffing. Extend it to:

```ts
type DetectedVersion = 'v2' | 'v3' | 'v4';

private async detectServerVersion(): Promise<DetectedVersion> {
  // Prefer the declared channel.
  const caps = await this.cachedCapabilities();
  if (caps?.adcp_version) {
    return parseAdcpMajor(caps.adcp_version); // 'v2' | 'v3' | 'v4'
  }
  // Fall back to tools/list shape sniffing for legacy sellers.
  return this.sniffFromTools();
}
```

Pre-v4 sellers without `get_adcp_capabilities` keep the shape-sniff path. Don't add tool-name string matches as primary detection for new versions — that's the OpenRTB "extension sniffing" trap.

**Registry selection.** Replace the `if (version !== 'v3')` block in `adaptRequestForServerVersion` with a map:

```ts
type AdapterLookup = (toolName: string) => AdapterPair | undefined;

const REGISTRY_BY_VERSION: ReadonlyMap<DetectedVersion, AdapterLookup> = new Map([
  ['v2', getV25Adapter],
  // ['v3', getV3Adapter],   // when SDK pin moves to v4
]);

function selectAdapterRegistry(version: DetectedVersion): AdapterLookup | undefined {
  return REGISTRY_BY_VERSION.get(version);
}

// dispatch:
const adapter = selectAdapterRegistry(version);
if (adapter) {
  const pair = adapter(taskType);
  if (pair) adapted = pair.adaptRequest(params);
}
```

`selectAdapterRegistry` does not exist yet — introduce it in this step. The current SDK pin (`'v3'` today) is **not** in the map: direct calls don't need adaptation. When the pin moves, the previous pin's lookup joins the map.

Mirror the change in `normalizeResponseToV3` (or rename to `normalizeResponseToCurrent` if the SDK pin moves above v3).

### 6. Wire validation pinning

`TaskExecutor.validateResponseSchema` derives `validationVersion` from `lastKnownServerVersion`. Today:

```ts
const validationVersion = this.lastKnownServerVersion === 'v2' ? 'v2.5' : this.config.adcpVersion;
```

Extend to a map. Don't keep the binary-version ternary — silent fall-through to `this.config.adcpVersion` for unknown versions is exactly how we ended up with v3 schemas rejecting v2.5 responses pre-#1137:

```ts
const SCHEMA_BUNDLE_BY_VERSION: ReadonlyMap<DetectedVersion, string> = new Map([
  ['v2', 'v2.5'],
  // ['v3', '3.0.1'],   // when SDK pin moves to v4 and v3 becomes legacy
]);

const validationVersion =
  this.lastKnownServerVersion
    ? (SCHEMA_BUNDLE_BY_VERSION.get(this.lastKnownServerVersion) ?? this.config.adcpVersion)
    : this.config.adcpVersion;
```

The map mirrors `REGISTRY_BY_VERSION` from step 5 — every detected version that needs adaptation also needs its own validation bundle. The current SDK pin is not in either map (current-pin sellers validate against `this.config.adcpVersion` directly). The fall-through stays defensive: if a future detection bug returns a version we don't have a bundle for, we validate against the SDK pin rather than crash.

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

**No live seller running the new version yet?** This is the common case for forward-version compat (e.g. v4 sellers don't exist yet when you're staging the SDK pin move). Two options, in order of preference:

1. **Stand up a mock server using `createAdcpServer`** that publishes the new version's tool surface. Drop it under `test/fixtures/mock-v<X>-server.ts` — the existing `test/fixtures/` directory holds similar agent fixtures and the registry tests pull from there. Wire the smoke at `process.env.MOCK_SELLER_URL` so it can run against either a real or fake seller. The mock doesn't need to be production-quality; it needs to publish the right `tools/list` shape and accept your adapted requests without 500ing.
2. **Round-trip the adapter against the schema bundle** instead of an HTTP server. The conformance test (step 7) already does this on the request side; extend it to also validate that round-tripping a synthesized response through `normalizeResponse` produces a v3-shape that passes v3 schema validation. Catches type-level drift without needing a live seller.

(1) catches transport bugs (auth headers, MCP `structuredContent` parsing) that (2) misses. Use both when you can; (2) alone if you're early.

### 9. Changeset + PR

```sh
npm run changeset
```

Pick `minor` for adding a new legacy compat layer (additive). Description should call out:

- Which version(s) are now supported.
- Whether the SDK pin moved (and if so, what changed for adopters).
- Whether the smoke harness actually round-tripped against a live seller (link the smoke output if so).

PR body should reference this playbook so reviewers can verify each step landed.

### Time estimate

Realistic for one focused contributor:

- **~1 week** with a known-good live seller of the target version (most of the time goes to per-tool adapter logic and conformance fixtures).
- **~2 weeks** without a live seller (mock server build adds ~3 days; the longer feedback loop of "ship adapter → wait for next dogfood" adds the rest).

If it's taking longer than that, the per-tool deltas between SDK pin and target version are bigger than they look — pause and re-scope before grinding through. v2.5 → v3 had four tools that needed real adaptation (get_products, create_media_buy, sync_creatives, list_creative_formats) and roughly two that were prefix-strip-only. v4 → v3 may differ.

### Anti-patterns

What gets caught in code review every time:

- **Don't branch the existing v2.5 helpers** in `utils/*-adapter.ts` to also handle v4. Each version gets its own translation logic — see step 4. Branching means a v2.5 fix risks regressing v4 and vice versa.
- **Don't skip step 6** (validation pinning). The temptation is "the SDK pin works as a default and the seller might be close enough" — that's how we ended up rejecting valid v2.5 responses pre-#1137. Always pin validation to the detected version.
- **Don't share conformance fixtures across versions.** Each `legacy/<version>/` gets its own `adapter-v<version>-conformance.test.js`. Sharing fixtures couples the test to the lower-common-denominator and the failure mode confuses reviewers.
- **Don't bump `ADCP_VERSION` (the SDK pin) in the same PR as adding a legacy shim.** Two separate concerns — one is "we now support the new pin," the other is "we keep supporting the old pin underneath." Reviewing them together obscures both.
- **Don't omit the `removeNumberedTypeDuplicates` codegen pass.** `json-schema-to-typescript` emits `Foo`, `Foo1`, `Foo2` for re-referenced enums. The dedupe is in `scripts/generate-types.ts` and shared with v2.5 codegen — call it from your new generator. Skipping it produces autocomplete confusion that won't surface until adopters import the types.
- **Don't bypass `_provenance.json`.** The schema cache is reproducible because we pin the source SHA + sha256. Stripping that for "convenience" defeats CI determinism.

## N=1 vs N×M

The directory tree is `legacy/v2-5/`, not `v3-to-v2-5/`. That's intentional and worth understanding before extending it.

A full `(SDK_version × seller_version)` matrix would be N×M files for N SDK versions × M seller versions, with corresponding test coverage. **We choose N=1 because we don't have the staffing for N×M, not because the industry has converged on one shim.** Ad-tech precedent is mixed:

- OpenRTB carries 2.x and 3.0 simultaneously and IAB still publishes both — adoption never displaced 2.5/2.6 the way a clean N=1 model assumes.
- Prebid.js maintains multiple OpenRTB version mappings concurrently and supports first-price/second-price legacy modes well past their stated deprecation runways.
- GAM (closed, vendor-controlled) does deprecate aggressively on a major-version cadence — closer to N=1 in practice but not directly comparable to an open protocol.

So the engineering policy is "one active legacy shim with a deprecation runway," not "everyone in ad-tech does this." This SDK's pattern:

- **Today:** SDK pinned to v3, one legacy shim for v2.5, no shim for v3 (it's the pin).
- **When SDK moves to v4:** the v2.5 shim sunsets, a new v3 shim joins. Two active legacy shims briefly, dropping back to one when v2.5 hits end-of-support.
- **Deprecation runway:** one major-version overlap **or** 12 months from end-of-support announcement, whichever is longer. Adopters who need ancient compat pin to an older SDK major.
- **What we don't do:** maintain v2.5 + v3 + v4 + v5 simultaneously.

The directory tree (`legacy/<seller-version>/`) reflects this: the SDK's current pin is implicit and the only thing on disk is the exceptional, time-boxed compat work. If we ever staff a true matrix, the tree shape changes; until then, encoding one would be larping a maintenance burden nobody will own.

### Sunsetting a shim

When a shim hits end-of-support:

1. **Announce in CHANGELOG** — one major-version (or 12 months, whichever longer) before deletion. Tell adopters which SDK version drops it.
2. **Switch detection to typed rejection.** `detectServerVersion` returns the version, but the dispatch in `adaptRequestForServerVersion` returns a `VERSION_UNSUPPORTED` `ADCPError` instead of routing through the deleted registry. Adopters get a typed error, not a silent no-op.
3. **Delete the directory and prune the dispatch maps.** `src/lib/adapters/legacy/<version>/`, `src/lib/types/<version-dir>/`, `schemas/cache/<version>/`, `scripts/sync-<version>-schemas.ts`, `scripts/generate-<version>-types.ts`, the conformance + registry tests, the smoke harness. Also remove the version's entries from `REGISTRY_BY_VERSION` (step 5) and `SCHEMA_BUNDLE_BY_VERSION` (step 6) — a stale map entry pointing at a deleted registry compiles fine but blows up at runtime.
4. **Bump the major.** Removing a legacy shim is a breaking change for any adopter still talking to that version. Land it on a major-version bump with a clear migration note pointing at the older SDK pin.

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
