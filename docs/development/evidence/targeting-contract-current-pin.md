# Targeting input and proposal snapshot contract

## Applicability on current main

The rebased candidate starts from `cccb3ea83cb07dc24584e07aa2626b55761564bf`,
following #2939. The original PR head was
`76b044514c9b03ce7905732bd0021fcc27746940`, based on
`ecf1c74535fb184a91c5b4279b40e8f38f4558e9` (#2907).

The SDK version is `14.0.0-rc.38`; the protocol pin remains `3.2.0-rc.3`.
The published protocol bundle is
`https://adcontextprotocol.org/protocol/3.2.0-rc.3.tgz`, SHA-256
`1cd940f76516b43327cbfa6c17c0befd4c093ca85b53a81a4062d38bb522d831`.
Repository schema synchronization verified its checksum and cosign signature.

The title collision remains reproducible after full generation on this base:

| Dimension | Shared title | Strict schema | Input schema |
| --- | --- | --- | --- |
| `geo_metros` | Targeting Geo Metros | array | array or null |
| `language` | Targeting Languages | array | array or null |
| `keyword_targets` | Targeting Keywords | array | array or null |
| `negative_keywords` | Targeting Negative Keywords | array | array or null |

All 37 property names agree between the two schemas. First-definition type
deduplication currently admits these four null commands in core strict targeting
and rejects them in tool input targeting: eight declaration errors. The baseline
type regression fails at `TargetingOverlay.geo_metros`; its runtime regression
also rejects a schema-valid `geo_metros: null` input through generated Zod.
The unchanged base passes example compilation and the expanded official-MCP
starter rejection/digest/readback assertions. The original starter TS2322 is
therefore historical; it is not the justification for this patch.

## Historical overlap resolution

Before the final rebase, only two of the original twelve PR paths changed after
its recorded base:

| Path | Newer main change | Resolution |
| --- | --- | --- |
| `src/lib/types/schemas.generated.ts` | #2918 (`5591b93f`) | Regenerate from current source; preserve every non-targeting declaration. |
| `src/type-tests/negotiation-generated-parity.type-test.ts` | #2928 (`46eb3012`) | Retain all frequency-cap, criteria, refinement and public-export assertions; append targeting assertions. |

The other ten paths had no intervening blob change (including paths absent
from both bases). #2907 is already the recorded base; its cardinality fallback,
public helpers, and store implementation are retained. #2917 and #2920 have no
direct path overlap. #2923's targeting documentation and #2936's existing-platform
adapter and tests were inherited intact. A blob comparison preserved all 161
other paths changed since the recorded base, including deletions.

The final rebase from that audited main to #2939's
`cccb3ea83cb07dc24584e07aa2626b55761564bf` has no path overlap with this
change. It inherits #2939's removal of obsolete preview artifacts and its exact
published-protocol inventory guard.

No historical generated files or rc.4 evidence files are carried into this
candidate. Current generation adds six input aliases in each TypeScript unit
and six corresponding Zod schemas. No declarations are removed. The only
existing declarations changed are targeting aliases and input references;
non-targeting declaration checksums match the current base. The two existing
public targeting Zod exports are additionally replaced from their authoritative
cached JSON Schemas so runtime validation does not lose wire-only constraints.

## Contracts retained

The transform changes naming annotations only. It is non-mutating and
idempotent, preserves array constraints and enum items, and works with both
root compilation orders and referenced or inline device arrays. A priority
resolver normalizes only the cached targeting-input document. The generator's
exact runtime projections dereference canonical URIs exclusively through the
verified local cache, with network and filesystem fallback disabled. Other
reference-resolution behavior is unchanged. Missing-cache fallback remains
detectable by generated parity tests.

The cardinality fallback remains before core-import rewriting in the tool
pipeline and outermost in core postprocessing. Its multi-repair regression,
including the last property, remains intact. Correct array aliases make the
fallback a no-op.

The public helpers retain their signatures and runtime identity across root,
server, and media-buy exports. Null-prototype accumulation and the shared
`__proto__`/`constructor`/`prototype` exclusion remain intact. Resolution returns
`undefined` when nothing survives; an omitted or explicitly undefined update
preserves state, while null clears it. The existing generic inference limitation
when `applyTargetingInput` receives an untyped `undefined` prior is unchanged;
the typing regression uses the supported explicit overlay type argument.

Store coverage exercises all 37 dimension clears on create fallback and new
packages, scoped persistence, absent/undefined/empty updates, per-dimension and
whole-overlay clearing, unsafe keys, seller-echo precedence, and fresh-wrapper
readback through both memory and PostgreSQL JSONB. Store and helper implementation
blobs are unchanged. An empty overlay object is accepted by this pin's overlay
schema; the store deliberately represents no surviving dimensions by omission.

Proposal tests exercise every dimension's null command across three kinds and
three statuses using both canonical AJV and exact Zod, with JSON round trips.
Purchase input accepts commands; commercial snapshots reject them. Array
cardinality, string patterns, nested invalid values, omitted targeting and empty
overlays have their schema-defined distinctions in both AJV and the public Zod
schemas. This newly corrects public Zod acceptance of wire-invalid arrays,
scalars, and nested closed-object extensions. No new required request field is
introduced.

The starter still rejects every supplied overlay before creating a buy. Its
supported-field constructor retains product/pricing IDs, budget, optional
context, resolved pricing and flight, and published measurement/performance
terms. The current-base fixed-flight test independently retains digest
`sha256:nq7wnX0GYS36FZG0Toc5V1WD1rh3R8SSldqB6T9EGjQ`.

## Qualification boundaries

The packed candidate contains 6,107 files and remains within the unchanged byte
ceilings. Historical
rc.4 comparisons against 6,059 files and an older commercial semantic guard do
not qualify this base or establish current rc.4 compatibility. This work does
not adopt or qualify rc.4, change a protocol pin, or alter a package budget.

Exact candidate head/tree, command results, receipt hashes, review findings and
fresh CI belong in the PR body after the source is frozen. Pre-rebase CI and
automation approval do not qualify the candidate. Database checks use an
explicit local disposable database rather than the VM's inherited database
configuration. Package verification, supported runtimes and peers, examples,
full fast/slow suites, deterministic generation, and both independent review
stacks are publication gates; failures must remain visible.
