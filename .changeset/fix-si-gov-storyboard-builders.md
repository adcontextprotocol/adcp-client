---
'@adcp/client': patch
---

Storyboard runner: fix spec-violating shapes and `sample_request`
precedence across the SI + governance request builders. All affected
builders now honor `step.sample_request` first (matching peer builders),
and their synthetic fallbacks conform to the generated Zod schemas so
framework-dispatch agents running strict validation at the MCP boundary
no longer reject them with `-32602 invalid_type`.

- `si_get_offering`: drop the string `context` and the out-of-schema
  `identity`; emit the prose string as optional `intent` (per
  `si-get-offering-request.json`, `context` is a ref to an object).
- `si_initiate_session`: move prose from `context` (which must be an
  object) to required `intent`; default the identity fallback to the
  realistic anonymous handoff shape (`consent_granted: false` +
  `anonymous_session_id`) instead of `consent_granted: true` with an
  empty consented user — spec-legal either way, but the anonymous shape
  is what a host that hasn't obtained PII consent actually sends.
- `si_send_message` / `si_terminate_session`: honor `sample_request` so
  storyboards can drive `action_response`, `handoff_transaction`,
  `termination_context`, and non-default `reason` paths without the
  fallback stomping the scenario.
- `sync_governance`: lengthen default `authentication.credentials` to
  meet `minLength: 32`, and honor `sample_request` so fixtures like
  `signal-marketplace/scenarios/governance_denied.yaml` that author
  `url: $context.governance_agent_url` flow through.

Closes #802.
