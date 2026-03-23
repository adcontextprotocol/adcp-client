---
"@adcp/client": minor
---

Add audience governance schemas, match breakdown, and compliance testing.

**Schemas**: audience-selector (signal ref or description discriminated union), audience-constraints (include/exclude), restricted-attribute (GDPR Article 9 enum), match-id-type (hashed PII + universal IDs). Synced from AdCP PR #1593.

**Breaking upstream changes**: `buyer_ref` removed from create/update_media_buy, `buyer_campaign_ref` removed from check_governance/report_plan_outcome, `governance_context` changed from structured object to opaque string token. GovernanceMiddleware, GovernanceAdapter, and TaskExecutor updated accordingly.

**Compliance**: sync_audiences response schema registered for validation. Campaign governance scenarios added to comply() governance track. sync_plans now exercises policy_categories, audience constraints, and restricted_attributes. Delivery monitoring includes audience_distribution indices. Signals flow reports governance metadata availability.
