---
"@adcp/sdk": minor
---

feat(conform): split `storyboards_missing_tools` from `storyboards_not_applicable` in `ComplianceResult`

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

Consumers that only read `storyboards_not_applicable` continue to work; they will no longer see missing-tool entries in that array.

Closes #1695.
