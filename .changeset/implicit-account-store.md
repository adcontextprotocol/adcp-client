---
"@adcp/sdk": minor
---

Add `InMemoryImplicitAccountStore` reference adapter for `resolution: 'implicit'` platforms. Closes #1340 (partial — Postgres adapter and storyboard phases deferred; see issue for remaining scope).

Platforms where buyers call `sync_accounts` before any tool no longer need to hand-roll the `authPrincipal → accounts` map. `InMemoryImplicitAccountStore` implements both `upsert()` and `resolve()` with a configurable `keyFn` (defaults to `credential.client_id` / `credential.key_id` / `credential.agent_url`) and a configurable `ttlMs` (default 24h).

Also ships:
- `docs/guides/account-resolution.md` — key-derivation rationale, `ACCOUNT_NOT_FOUND` vs `AUTH_REQUIRED` error contract, TTL guidance for durable stores
- `examples/decisioning-platform-implicit-accounts.ts` — runnable wiring example
- Fix deprecated `authInfo.clientId` reference in `AccountStore.resolve()` JSDoc (use `credential.client_id` / `credential.key_id`)
