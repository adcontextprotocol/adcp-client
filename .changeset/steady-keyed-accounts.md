---
'@adcp/sdk': minor
---

Add account sync contract diagnostics and opt-in strict identity/payment-term checks, aligned existing-account context, and a durable keyed account store with memory, PostgreSQL, and transactional KV backends. Default storyboard assertions check natural-key re-syncs and explicit payment-term remaps; an opt-in certification assertion checks agent-billed commercial fields.

Account stores now receive lookup-only `resolve` calls during sync and current stored commercial fields may complete omitted response fields. Resolvers must honor `provisioning: false` and provide current state. Strict failures preserve returned account IDs and status; custom stores remain responsible for transactional enforcement.
