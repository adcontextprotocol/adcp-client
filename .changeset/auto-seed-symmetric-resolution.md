---
"@adcp/sdk": patch
---

fix(server): auto-seed adapters use resolved account id (symmetric with bridge)

The catalog-backed auto-seed adapters introduced in #1100 wrote fixtures keyed by raw `input.account.account_id`, while the bridge read from `ctx.account?.id` (the resolved id set by the framework's `resolveAccount`). On a platform whose resolver maps `account_id` to a distinct internal id (e.g., a tenant-prefixed shape), the asymmetry caused silent fixture loss — `seed_product` succeeded but `get_products` couldn't find the seeded product because the namespace key on read didn't match the one on write.

Auto-seed adapters now run `platform.accounts.resolve` on the request's `account` reference and use the resolved `id` as the namespace key, matching what the bridge reads. Adopters with identity resolvers (the common case) see no behavior change.

Also: when the auto-seed adapter fires without a resolvable account (typically a misconfigured `sandboxGate` that lets account-less requests through), it now logs a warn-level diagnostic and drops the write, instead of silently returning. Misconfigurations that previously caused "seeds vanish without explanation" now surface as a single actionable log line.

Closes #1216.
