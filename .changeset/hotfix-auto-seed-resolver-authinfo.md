---
"@adcp/sdk": patch
---

fix(server): auto-seed adapter no longer calls platform.accounts.resolve without authInfo

PR #1219 had the auto-seed adapter call `platform.accounts.resolve` to derive the namespace key, intending to keep it symmetric with the bridge's `ctx.account?.id` read. Triage flagged the security gap: the comply-controller's `ComplyControllerContext` doesn't expose `authInfo`, so the adapter calls `resolve(ref, { toolName })` with attacker-supplied `account_id` and no auth context. A resolver that maps `account_id` to an internal id without validating `authInfo` would let a caller spoof `account.account_id: 'victim'` and have seeds written into the victim's resolved namespace. That namespace is then visible to the victim's `get_products` (which reads through the framework-authenticated `ctx.account.id`).

This patch reverts to writing under raw `account.account_id`. The architectural fix — widening `ComplyControllerContext` to expose the framework-resolved account so the adapter can match the bridge's read namespace — remains tracked at #1216.

**Trade-off**: adopters whose resolver maps `account_id` to a distinct internal id (e.g., `acc_1` → `tenant_a:acc_1`) hit a documented limitation: the adapter writes to `acc_1` but the bridge reads from `tenant_a:acc_1`, so seeded fixtures don't appear in `get_products`. Silent test loss, not cross-tenant pollution. Mapping-resolver adopters can wire explicit seed adapters today (escape hatch unchanged).

Multi-tenant correctness for identity resolvers (the common case) is preserved — same behavior as before #1219.
