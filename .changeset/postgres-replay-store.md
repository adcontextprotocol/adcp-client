---
"@adcp/client": minor
---

feat(signing): PostgresReplayStore for distributed verifier deployments

Adds a Postgres-backed `ReplayStore` so multi-instance verifier deployments share replay-protection state. The default `InMemoryReplayStore` is per-process; on a fleet, an attacker who captures a signed request can replay it against a sibling whose cache hasn't seen the nonce — RFC 9421's 5-minute expiry bounds the window but that's plenty of time for an in-flight replay. `PostgresReplayStore` closes that hole using a `(keyid, scope, nonce)` primary key the verifier checks on every signed request.

New exports from `@adcp/client/signing/server`:

- `PostgresReplayStore` — `ReplayStore` implementation against the structural `PgQueryable` interface (same pattern as `PostgresTaskStore` and `PostgresStateStore`; the SDK stays free of a hard `pg` dependency).
- `getReplayStoreMigration(tableName?)` — idempotent DDL for the cache table plus indexes on `expires_at` and `(keyid, scope, expires_at)`.
- `sweepExpiredReplays(pool, options?)` — exported helper for callers to schedule (cron, app timer, `pg_cron`, etc.); Postgres has no native row-level TTL, so expired rows have to be deleted explicitly.

The insert path is a single CTE statement that handles replay/cap/insert decision atomically. `ON CONFLICT DO UPDATE WHERE existing-is-expired` recycles expired rows in place — a same-nonce insert after the previous registration's TTL elapsed (but before the sweeper ran) correctly returns `'ok'` rather than falsely reporting `'replayed'`. Concurrent same-nonce inserts (10 parallel) consistently produce exactly one `'ok'` and the rest `'replayed'`, matching `InMemoryReplayStore` semantics.

Wire format unchanged. No AdCP version bump.

See [`docs/guides/SIGNING-GUIDE.md` § Verify Inbound Signatures](./guides/SIGNING-GUIDE.md#step-4-verify-inbound-signatures-seller) for the multi-instance failure mode and the wire-up.

Closes #1015.
