---
'@adcp/sdk': patch
---

docs: corpus migration phase 2B — 6 sibling skills migrated v5 → v6

Continues #1088. The remaining 6 sibling skill files migrate from v5 `createAdcpServer` patterns to v6 `createAdcpServerFromPlatform` + typed `DecisioningPlatform` class:

- `skills/build-generative-seller-agent/SKILL.md` — 12 → 2 v5 mentions (legacy callouts only)
- `skills/build-governance-agent/SKILL.md` — 12 → 1
- `skills/build-retail-media-agent/SKILL.md` — 12 → 3
- `skills/build-si-agent/SKILL.md` — 9 → 1
- `skills/build-creative-agent/SKILL.md` — 12 → 2
- `skills/build-signals-agent/SKILL.md` — 13 → 2

Total 70 → 11 mentions (84% reduction). The remaining 11 are all intentional callouts in SDK Quick Reference tables ("`createAdcpServer(config)` *(legacy)*") and Common Mistakes table rows that point adopters at the `@adcp/sdk/server/legacy/v5` subpath for mid-migration / escape-hatch use only.

Each skill's canonical Implementation worked example is now a typed `class implements DecisioningPlatform<>` skeleton with the appropriate sub-platform interfaces (`SalesPlatform`, `SignalsPlatform`, `CreativeBuilderPlatform` / `CreativeAdServerPlatform`, `CampaignGovernancePlatform` + `PropertyListsPlatform`, `SponsoredIntelligencePlatform`). All imports moved from `@adcp/sdk` to `@adcp/sdk/server` for server-side surface.

The matrix-failing skills (governance, generative-seller, retail-media, si, creative_ad_server) should now scaffold to v6 cleanly. Re-running the Emma matrix is the next validation step — expected uplift from 3/16 to a meaningful improvement.

Refs #1088. Closes phase 2B. Phase 2 of #1088 is now complete; full corpus migration done apart from `BUILD-AN-AGENT.md` (high-traffic doc, deferred to phase 2C).

Subagent attempt during phase 2 was sandbox-blocked — these files were migrated manually in the parent session.
