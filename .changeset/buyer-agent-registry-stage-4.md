---
'@adcp/sdk': minor
---

feat(server): BuyerAgentRegistry — Phase 1 Stage 4 (status enforcement + credential redaction)

Phase 1 Stage 4 of #1269. Wires the durable identity surface from Stages 1-3 into request gating + closes the credential-leak surface in error projections.

**Status enforcement.** Resolved `BuyerAgent.status === 'suspended' | 'blocked'` triggers framework-level rejection on new requests:

- `PERMISSION_DENIED` envelope with `error.details.scope: 'agent'` and `error.details.status: <status>`.
- Status check runs in the dispatcher seam right after registry resolution, BEFORE `accounts.resolve` — no tenant lookup wasted on rejected requests.
- `'active'` agents pass through unchanged.
- `null` registry returns (unrecognized agent) do NOT trigger status enforcement — Phase 2 (#1292) handles per-agent billing rejection separately.

In-flight protection: the seam runs once per synchronous request, not on `tasks_get` polls or background webhook deliveries. A task started under an `'active'` agent and continued after status flips to `'suspended'` is NOT retroactively cancelled. Sellers who need hard cutoff implement that in their platform method via `BuyerAgent.status` checks (the resolved record is on `ctx.agent`).

**Credential pattern redaction.** New `redactCredentialPatterns(message)` helper (`@adcp/sdk/server/redact`, internal) scrubs known credential shapes from any string projected to `error.details.reason` on the wire. Applied to all six dispatcher sites where `err.message → details.reason`:

- Buyer-agent registry resolution failures
- `resolveAccount` failures
- `resolveAccountFromAuth` failures
- `resolveSessionKey` failures
- Idempotency principal resolution failures
- Tool handler throws

Patterns scrubbed:
- `Bearer <token>` headers
- JSON-quoted credential fields: `"token":"..."`, `"client_secret":"..."`, etc.
- Unquoted credential fields: `token=...`, `client_id: ...`, `key=...`, etc.
- Long token-shaped strings (≥ 32 chars of base64/hex/url-safe, word-bounded)

The redactor is conservative — false positives (legitimate IDs that match a pattern) get redacted; false negatives are minimized. Adopters who need the unredacted error log it server-side; production-default `exposeErrorDetails: false` already gates the wire path.

13 new tests across status enforcement (active passes, suspended/blocked rejected with structured details, runs before accounts.resolve, null doesn't trigger), redactor unit tests (Bearer headers, labeled patterns, JSON-quoted shapes, long-token detection, prose preserved, edge cases), and registry-throw / handler-throw end-to-end redaction. Full suite: 7353 pass, 0 fail.

Phase 2 (#1292) — framework-level billing-capability enforcement and the AdCP-3.1 error-code emission — is still gated on the SDK's 3.1 cutover.
