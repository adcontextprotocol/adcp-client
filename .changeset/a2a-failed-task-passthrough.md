---
'@adcp/sdk': patch
---

fix(a2a): pass through terminal-state Task with adcp_error DataPart instead of throwing

When a seller emits a spec-compliant terminal-state Task (per AdCP
transport-errors §A2A Binding) carrying the canonical `adcp_error` envelope
on the artifact's DataPart, the protocol layer now lets the response flow to
the upstream unwrapper even if the seller also surfaced a transport-level
`result.error` hint. Previously, the generic "A2A agent returned error: ..."
throw fired first and swallowed the structured `adcp_error.code` /
`recovery` / `field` / `correlation_id`, leaving storyboard validators
reading transport state ("Task ... is in terminal state: 3") instead of the
AdCP error envelope. Sibling of #1571; fixes #1575.
