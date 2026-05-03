---
'@adcp/sdk': patch
---

Pin to AdCP 3.0.5. Picks up the brand-rights storyboard fix
(adcontextprotocol/adcp#3892, shipped as part of 3.0.5): `acquire_rights`
step's `context_outputs` now reads `path: rights_id` (was the non-existent
`rights_grant_id`), unblocking the `rights_acquisition` and
`rights_enforcement` scenarios for spec-conformant brand-rights agents.
Also picks up the optional storyboard-level `default_agent` field
(adcontextprotocol/adcp#3894) for multi-agent storyboard runners — strictly
additive, no SDK behavior change.
