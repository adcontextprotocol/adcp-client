---
'@adcp/client': patch
---

`security_baseline` runner now enforces RFC 9728 protected-resource metadata
(PRM) validations whenever the agent serves PRM at all, closing a spoofing
path (adcp-client#677) where an agent with a broken OAuth metadata document
could pass the storyboard by also declaring an API key. Previously,
`oauth_discovery`'s `optional: true` semantics swallowed failures of the
`resource_equals_agent_url` and `http_status: 200` checks so long as the
API-key path carried `auth_mechanism_verified`. Now:

- A PRM response of **HTTP 404** skips the `oauth_discovery` phase cleanly
  (step reports `skip_reason: 'oauth_not_advertised'`, remaining phase steps
  cascade-skip). API-key-only agents that don't serve PRM see no change.
- Any **HTTP 2xx** PRM response flips the phase into hard-fail mode: a
  wrong `resource` URL, missing `authorization_servers`, or unreachable
  authorization-server metadata fails the storyboard regardless of whether
  the API-key path also passes.
- Other PRM statuses (401, 500, redirects, fetch errors) keep their
  existing swallow-on-optional behavior — the rule only tightens when the
  agent is honestly advertising OAuth.

The semantic shift encoded here: the test-kit's `auth.api_key` declaration
is an opt-IN to the API-key path, not an opt-OUT of the OAuth path. An
agent that serves PRM must serve it correctly.
