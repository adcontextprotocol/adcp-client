---
'@adcp/client': patch
---

Fix spec-violating request shapes for `si_get_offering`, `si_initiate_session`,
and `sync_governance` in both the storyboard request builders and the
sponsored-intelligence test scenarios.

- `si_get_offering`: the prose string moves from `context` (which is the core
  context object per `si-get-offering-request.json`) to `intent`. The `identity`
  field is dropped — it is not part of the request schema.
- `si_initiate_session`: the prose handoff moves from `context` to `intent`
  (required). `identity` now follows `si-identity.json` — `{ consent_granted,
  user: { name } }` rather than the non-spec `{ principal, device_id }`.
- `sync_governance`: the builder now honors `step.sample_request` (so
  storyboards can pin `url: $context.governance_agent_url`) and the fallback
  `credentials` is padded to ≥32 chars to satisfy the schema's `minLength: 32`.

Framework-dispatch agents running strict validation at the MCP boundary
previously rejected these with `-32602 invalid_type`; legacy-dispatch
permissively accepted the wrong shapes.

Closes #802.
