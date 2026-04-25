---
'@adcp/client': patch
---

**Preview: `DecisioningPlatform` v1.0 type scaffold** (`src/lib/server/decisioning/`). Lands the type surface for the v6.0 framework refactor — adopters describe their decisioning system once via per-specialism interfaces (`SalesPlatform`, `CreativeTemplatePlatform`, `CreativeGenerativePlatform`, `AudiencePlatform`) and the framework owns wire mapping, account resolution, async tasks, status normalization, and lifecycle state. No runtime wiring yet; types are not exported from any public subpath. See `docs/proposals/decisioning-platform-v1.md` for the design and `docs/proposals/decisioning-platform-training-agent-migration.md` for a worked migration sketch (Innovid training-agent → DecisioningPlatform: ~5x line reduction, 9 of 10 documented blockers dissolve).

Status: Preview / 6.0. Wiring lands in a follow-up PR with the framework refactor.
