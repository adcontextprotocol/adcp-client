---
'@adcp/sdk': major
---

fix(governance): drop `categories` from `governance_agents[]` wire emission (3.1.0-beta.2)

AdCP 3.1.0-beta.2 narrowed the `governance_agents[]` wire shape from `{url, categories?}` to `{url}` only. Per-agent category signaling moved out of band; the spec no longer carries `categories` on the wire.

**Changes:**
- `projectGovernanceAgent` in `src/lib/server/decisioning/account.ts` — emits `{url}` only.
- `stripGovernanceAgentSecrets` in `src/lib/server/responses.ts` — drops the `categories` preservation branch.
- The inline projection in `syncGovernanceRowToWire` — same.
- Tests in `test/lib/sync-governance-credential-strip.test.js` — assert `categories` is now stripped (defense-in-depth alongside the existing `authentication.credentials` strip).

**Adopter migration:** the SDK no longer emits `categories` on `governance_agents[]`. If your code was reading the field off the wire, it'll see `undefined` — switch to whatever out-of-band channel the seller now uses for per-agent category metadata.

Part of the #1902 8.0-beta sweep (3/5 structural breaks closed).
