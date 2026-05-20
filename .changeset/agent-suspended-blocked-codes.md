---
'@adcp/sdk': minor
---

feat(errors): adopt `AGENT_SUSPENDED` / `AGENT_BLOCKED` typed codes (adcp#3906 consolidates the 3.0.5 placeholder)

Adopt the dedicated 3.1 error codes for buyer-agent commercial-status rejections. Closes #1406.

**Wire-level changes (server-side emission):**
- Suspended buyer agents now reject with `code: 'AGENT_SUSPENDED'` instead of `code: 'PERMISSION_DENIED', details: { scope: 'agent', status: 'suspended' }`.
- Blocked buyer agents now reject with `code: 'AGENT_BLOCKED'` instead of `code: 'PERMISSION_DENIED', details: { scope: 'agent', status: 'blocked' }`.
- Both codes carry `recovery: 'terminal'` at the wire envelope. The 3.0.5 placeholder shape's `recovery: 'transient'` for suspended contradicted the no-retry MUST; the transient-vs-permanent distinction lives at the seller's `BuyerAgent.status` record, not on the wire.
- The `details.status` field is removed — envelopes carrying it fail schema validation against AdCP 3.1.
- The `PERMISSION_DENIED + scope: 'agent' + reason: 'sandbox-only'` path is unchanged.

**Typed surface (forward-compat overlay extension):**
- New typed error classes: `AgentSuspendedError`, `AgentBlockedError` (in `src/lib/server/decisioning/errors-typed.ts`).
- Both codes added to the forward-compat overlay (`src/lib/types/forward-compat-error-codes.ts`) with `sinceAdcpVersion: '3.1.0'` and `recovery: 'terminal'`.
- `BuyerRetryPolicy.DEFAULT_CODE_POLICY` now maps both codes to `{ action: 'escalate', escalateReason: 'terminal' }` — auto-retry is refused by default.

**Adopter migration:**
- Code that parsed `error.code === 'PERMISSION_DENIED' && error.details?.status === 'suspended'` should switch to `error.code === 'AGENT_SUSPENDED'`. Same for `'blocked'`.
- The `details.status` field will no longer be present.
- Adopters using `BuyerRetryPolicy` defaults get the correct terminal-escalate behavior automatically.

**References:**
- Spec PR: [adcontextprotocol/adcp#3906](https://github.com/adcontextprotocol/adcp/pull/3906)
- 3.0.5 placeholder registration: [adcontextprotocol/adcp#3887](https://github.com/adcontextprotocol/adcp/pull/3887)
- Closes spec issue: [adcontextprotocol/adcp#3871](https://github.com/adcontextprotocol/adcp/issues/3871)
