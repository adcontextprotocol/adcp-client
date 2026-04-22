---
'@adcp/client': patch
---

Storyboard runner: fix spec-violating shapes emitted by three request
builders. All three now honor `step.sample_request` first (matching peer
builders) and their synthetic fallbacks conform to the generated Zod
schemas, so framework-dispatch agents running strict validation at the
MCP boundary no longer reject them with `-32602 invalid_type`.

- `si_get_offering`: drop the string `context` and the out-of-schema
  `identity`; emit the prose string as `intent` (optional per
  `si-get-offering-request.json`).
- `si_initiate_session`: move the prose string from `context` (which
  must be an object per `core/context.json`) to the required `intent`
  field.
- `sync_governance`: lengthen default `authentication.credentials` to
  meet `minLength: 32`, and honor `sample_request` so fixtures like
  `signal-marketplace/scenarios/governance_denied.yaml` that author
  `url: $context.governance_agent_url` flow through.

Closes #802.
