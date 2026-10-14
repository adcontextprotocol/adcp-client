---
'@adcp/sdk': minor
---

Add natural-key account sync diagnostics, aligned `ctx.existing` snapshots, and opt-in `accounts.strictIdempotency` failures for duplicate identities and unaccepted payment terms. Fill missing billing fields from matching persisted accounts and diagnose missing agent-billing terms on list responses.

Natural-key snapshots require the resolved account's own brand domain and operator. Identity-free singleton resolvers remain compatible by supplying `null` snapshots; custom stores must echo their identity metadata for cross-request framework identity checks.

Add `createKeyedAccountStore` with non-expiring memory, PostgreSQL, and Redis backends, atomic concurrent syncs, principal isolation, and payment-term checks before persistence. Add an account sync compliance invariant and example storyboard.
