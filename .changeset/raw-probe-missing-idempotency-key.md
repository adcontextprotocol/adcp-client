---
'@adcp/client': patch
---

Route storyboard steps with `omit_idempotency_key: true` on mutating tasks through the raw-HTTP MCP probe so no SDK-layer normalization can inject a key onto the wire (adcp-client#678, adcp#2607). The `skipIdempotencyAutoInject` plumbing in `normalizeRequestParams`, `SingleAgentClient.executeAndHandle`, and `TaskExecutor.executeTask` already honors the flag, but a single regression in any of those sites would silently make every SDK-speaking agent pass the missing-key conformance vector vacuously. Dispatching via `rawMcpProbe` (the same path already used for `step.auth` overrides and `probeSignedRequest`) removes the escape hatch entirely.

Scope: applies when `options.protocol` is `'mcp'` and `options.auth` is absent, `'bearer'`, or `'basic'`. OAuth and A2A stay on the SDK path — their dispatch requires refresh-capable tokens / a different envelope that the raw probe can't replicate — and continue to rely on the existing `skipIdempotencyAutoInject` plumbing. No YAML surface change: the existing `omit_idempotency_key: true` field on a mutating step is the trigger, matching how the runner already gates the runner-level `applyIdempotencyInvariant` skip.

Hardening for outbound headers: bearer tokens and basic credentials are validated for CR/LF/non-printable ASCII before being placed in headers (errors name the offending field without echoing the value), empty bearer tokens fail loudly instead of silent SDK fallback, and basic-auth usernames containing `:` are rejected per RFC 7617. `X-Test-Session-ID` is added to `SECRET_KEY_PATTERN` so any future code path that persists outbound headers into compliance reports redacts it automatically.
