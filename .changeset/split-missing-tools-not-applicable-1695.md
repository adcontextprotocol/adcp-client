---
"@adcp/sdk": major
---

feat(conform)!: split `storyboards_missing_tools` from `storyboards_not_applicable` in `ComplianceResult`

**Breaking change**: `ComplianceResult.storyboards_not_applicable[]` previously included both version-gated and missing-tool coverage gaps. It now contains only version-gated entries. Consumers that check `(result.storyboards_not_applicable ?? []).length === 0` to assert zero coverage gaps must also check `storyboards_missing_tools`.

`ComplianceResult.storyboards_not_applicable[]` previously conflated two coverage-gap reasons that the AdCP spec's `runner-output-contract.yaml` (L249-300) keeps distinct:

- **`not_applicable`** — the agent didn't declare the protocol the storyboard tests (version-gating path).
- **`missing_tool`** — the agent declared the protocol but a required tool was absent from the discovered toolset (introduced by PR #1682).

Both cases are now surfaced separately:

```ts
interface ComplianceResult {
  storyboards_not_applicable?: string[]; // version-gated (protocol not declared)
  storyboards_missing_tools?: string[];  // protocol declared, required_tool absent
}
```

`storyboards_not_applicable` keeps its current semantics but now only contains version-gated entries. `storyboards_missing_tools` is new. The combined set is `[...storyboards_not_applicable, ...storyboards_missing_tools]` — the total coverage gap is unchanged.

**Migration**: Update any consumer that relied on `storyboards_not_applicable` alone to detect missing-tool coverage gaps to also check `storyboards_missing_tools`. Per-storyboard tool names (i.e. which tools were missing) are available in `ComplianceSummaryArtifact.skip_causes`; `storyboards_missing_tools` is a plain `string[]` of storyboard IDs for symmetry with `storyboards_not_applicable`.

**Naming note**: The spec's `RunnerSkipReason` enum uses the singular `missing_tool`; this field uses the plural `storyboards_missing_tools` to match the `storyboards_*` naming convention.

Closes #1695.
