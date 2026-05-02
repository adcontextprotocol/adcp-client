---
"@adcp/sdk": minor
---

feat(brand-rights): wire `update_rights` as a first-class mutating tool and add `creative_approval` webhook builders. The brand-rights domain group in `createAdcpServer` and the `BrandRightsPlatform` v6 typed-platform interface both gain the deferred surfaces from #552.

`update_rights` (MCP/A2A tool):
- Full `AdcpToolMap` entry → request schema validates `idempotency_key` requirement, response auto-wraps via `updateRightsResponse`.
- `BrandRightsHandlers.updateRights?` for v5 raw-handler adopters.
- `BrandRightsPlatform.updateRights` for v6 typed-platform adopters.
- Auto-hydrates the underlying grant from `req.rights_id` (parallel to `acquire_rights`'s `req.rights` pattern); handlers read the resolved grant from `ctx.store`.
- Picked up by `MUTATING_TASKS` automatically (Zod-derived) and by `BRAND_RIGHTS_TOOLS` for protocol detection.

`creative_approval` (webhook-only):
- Type re-exports (`CreativeApprovalRequest`, `CreativeApprovalResponse`, `CreativeApproved`, `CreativeRejected`, `CreativePendingReview`, `CreativeApprovalError`) reachable via `@adcp/sdk/types`.
- Per-arm builders (`creativeApproved`, `creativeApprovalRejected`, `creativeApprovalPendingReview`, `creativeApprovalError`) on `@adcp/sdk/server` inject the status discriminator. Webhooks have no MCP envelope, so these return raw JSON-serializable payloads, not `McpToolResponse`.
- `BrandRightsPlatform.reviewCreativeApproval` types the receiver method; adopters mount their own HTTP route at the URL they returned in `acquire_rights.approval_webhook` and dispatch through it.
- Intentionally NOT in `BRAND_RIGHTS_TOOLS` or `MUTATING_TASKS` — webhook payloads carry their own `idempotency_key` validated by adopters at the receiver.

Skill (`skills/build-brand-rights-agent/SKILL.md`) updated with the `update_rights` response shape (success + pending + error arms) and the `creative_approval` webhook receiver pattern.

Closes #551.
