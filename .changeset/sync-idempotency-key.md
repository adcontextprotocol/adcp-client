---
'@adcp/client': minor
---

Regenerated types from latest AdCP schemas. Adds `idempotency_key` (required, string) to webhook payloads — `MCPWebhookPayload`, `ArtifactWebhookPayload`, `CollectionListChangedWebhook`, `PropertyListChangedWebhook` — and renames `RevocationNotification.notification_id` → `idempotency_key`.

Upstream migrated these surfaces to a single canonical dedup field. Receivers must dedupe by `idempotency_key` scoped to the authenticated sender identity. Publishers populating `RevocationNotification.notification_id` must rename the field.
