---
'@adcp/sdk': minor
---

Add AdCP 3.2 cross-role governance authorization builders, capability-gated buyer middleware, compact-JWS service verification, and the published conformance vectors.

Governance adapter transport or malformed-response failures now throw `GovernanceAdapterError` instead of returning a denial-shaped result, so sellers can distinguish unavailable governance infrastructure from an authoritative policy denial. Authoritative adapter denials now use the AdCP 3.2 `CheckGovernanceResponse` fields (`verdict`, `check_type`, and `findings`) and no longer expose the legacy `status`, `binding`, or `plan_id` response members.

Governed calls now fail closed instead of forwarding receiver credentials from `push_notification_config`, `reporting_webhook`, or `artifact_webhook` to the governance agent. For an SDK-injected task-status webhook, retry with `{ disableWebhook: true }` and poll, or use A2A task-status notifications. Credential-bearing reporting and artifact callbacks must be omitted from governed requests. Legacy condition re-checks preserve and persist the response `governance_context` continuation token.
