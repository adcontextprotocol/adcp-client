---
'@adcp/sdk': minor
---

feat(types): ship per-tool `.d.ts` slices via `@adcp/sdk/types/<tool>` (#1944)

Two consumer classes win here.

**TypeScript adopters who only need one tool's types** can opt into a narrow import and skip the full surface entirely:

```ts
import type { SyncAccountsRequest } from '@adcp/sdk/types/sync-accounts';
```

Each slice is a self-contained `.d.ts` containing the tool's `*Request` / `*Response` / `*Success` / `*Error` / `*Submitted` types plus the full dependency closure (request envelope, error shapes, referenced core types, enums). No cross-slice imports — an adopter pulling one slice pays exactly that slice's tsc cost. **Measured: `sync_accounts` slice peaks at ~50 MB; the same adopter importing from `@adcp/sdk` root needs 4-6 GB and crashes with FATAL mark-compact on Node's default 4 GB heap. ~95× memory reduction, ~25× wall-clock speedup.** Adopters who don't opt in see no change.

**Agentic adopters** (LLM coding agents, MCP clients reading `.d.ts` files as context to write SDK-using code) get a parallel context-token win. The full surface is ~45,000 lines (~600k tokens for a model); a single tool slice is ~900-1000 lines (~12-15k tokens). Feeding an LLM exactly one slice instead of the whole bundle is the difference between burning the conversation budget on type definitions and having room for the actual prompt.

To make those slices discoverable without filesystem-walking, the codegen also emits `@adcp/sdk/types/per-tool-index.json` — a manifest mapping spec-canonical snake_case tool names (`sync_accounts`) to the kebab-case subpath (`@adcp/sdk/types/sync-accounts`) and the symbols each slice exports. LLMs trained on the spec will instinctively type the snake_case name; the manifest is what they reach for to resolve the import.

**What changed**:

- `scripts/generate-per-tool-types.ts` runs at the end of `build:lib`, parses the published `tools.generated.d.ts` + `core.generated.d.ts` + `enums.generated.d.ts` into a name→declaration map, BFS-walks the dependency closure from each tool's entry-point types, and emits one self-contained `.d.ts` per tool to `dist/lib/types/<tool>.d.ts`. 50 slices total.
- `package.json` `exports` map and `typesVersions` add `./types/*` subpath pattern (the existing `types/v2-5` / `types/v3-1-beta` exact matches still take precedence). `per-tool-index.json` ships alongside the slices.
- New CI guard `check:adopter-types-narrow` exercises five slices including both `get_adcp_capabilities` and `si_get_offering` (which cover the `AdCP` / `SI` naming carve-outs) under a tight 512 MB heap cap.

**Adopter requirements**: `moduleResolution: "node16"` / `"nodenext"` / `"bundler"` to see the subpath via the `exports` field. Older `moduleResolution: "node"` adopters continue importing from the root unchanged.

This is purely additive — root `@adcp/sdk` exports are unchanged. No migration required.
