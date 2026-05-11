---
'@adcp/sdk': minor
---

fix(comply): autodetect `webhook_receiver` requirement from storyboard token presence

`comply()` was shipping the literal mustache token `{{runner.webhook_url:<step_id>}}` on the wire whenever a webhook-emitting storyboard ran without a configured receiver. 3.0-strict sellers reject the resulting payload as `INVALID_REQUEST: Input should be a valid URL, relative URL without a base`, cascading 5 distinct first-step failures across `webhook_emission/*` and `idempotency/replay_same_payload`.

This PR adds `'webhook_receiver'` to `RequirementName` and `KNOWN_REQUIREMENTS`, maps it to `requirement_unmet` in the runner's skip-reason table, and adds a structural pre-pass (`detectImplicitRequires`) that scans every step's `sample_request` for `{{runner.webhook_url:…}}` or `{{runner.webhook_base}}` tokens. When any are found and `options.webhook_receiver` is unset, the storyboard grades `not_applicable` with `skip.requirement: 'webhook_receiver'` — matching the spec contract at `compliance/{version}/universal/webhook-emission.yaml` (L34, L62–70, L331–332).

**Authoring impact:** none. Storyboard authors do not need to add `requires: [webhook_receiver]` — the token presence is the declaration. Existing storyboards that reference the runner's webhook URL automatically inherit the gate.

**Behavior change:** runs that previously failed with `INVALID_REQUEST` from a strict seller now grade `not_applicable` and surface `requirement_unmet:webhook_receiver` in the structured skip block. Runs that already configure `webhook_receiver` are unchanged.

Fixes #1678. Part of the coordinated stance at #1685.
