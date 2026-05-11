---
'@adcp/sdk': minor
---

fix(comply): autodetect `request_signer` and `oauth_metadata` prereqs (#1702)

Extends the implicit-requires pattern shipped in #1678 (`webhook_receiver`)
to two more requirement surfaces, removing ~44 false-negative step
failures per `comply()` run on agents that don't claim the underlying
capability.

- Adds `'request_signer'` to `RequirementName` / `KNOWN_REQUIREMENTS` /
  `REQUIREMENT_TO_SKIP_REASON` and extends `detectImplicitRequires` to
  flag any storyboard whose `id === 'signed_requests'` or that contains
  a `request_signing_probe` step. The gate consults the agent's
  `get_adcp_capabilities.request_signing.supported` from the discovered
  profile (not a runner opt-out flag) so an agent that claims the
  capability but hasn't pre-registered the runner's compliance test
  keypair still fails — matches the universal storyboard's stated
  gating contract at
  `compliance/{version}/universal/signed-requests.yaml` ("absence of
  advertisement is not a failure").
- Pre-empts `oauth_discovery` cascade-skip on `security_baseline` when
  the agent's capabilities don't declare `account.authorization_endpoint`.
  The existing reactive `phaseAbsent` cascade (#677) only triggers on a
  404 from `/.well-known/oauth-protected-resource`; non-404 responses
  from a bearer-only agent (200-HTML, 405, redirect — the Wonderstruck
  shape) fell through to validation failures inside an `optional: true`
  phase. The pre-empt is phase-level, not storyboard-level, so the
  universal `unauth_rejection` and `mechanism_required` checks still run.

Part of the coordinated stance at #1685 (the SDK is a witness, not a
translator).
