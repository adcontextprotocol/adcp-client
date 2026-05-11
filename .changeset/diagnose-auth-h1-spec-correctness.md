---
'@adcp/sdk': patch
---

fix(diagnose-auth): downgrade H1 for spec-correct parent-path resource identifiers (#1666)

`adcp diagnose-auth` H1 ("Resource URL mismatch between well-known and agent host") previously fired as `[likely]` whenever the PRM `resource` didn't string-equal the agent URL. Per **RFC 9728 §2 + §3.2** the `resource` value is the canonical resource identifier the AS binds tokens to (the **RFC 9068 §3** `aud` claim target), not the request URI — and **RFC 8707 §2** allows any absolute URI with an optional path component. A parent-path resource identifier covering multiple endpoints is the canonical pattern, not a bug. H1 now distinguishes four cases:

- **origin mismatch** (different scheme/host/port) → still `likely` (real bug).
- **agent URL is a sub-path under the advertised resource identifier** → `ruled_out` with an explanation that this is the intended pattern (e.g. PRM `resource=http://localhost:3000/figma` for an agent at `http://localhost:3000/figma/mcp`).
- **same origin, agent path is a sibling/disjoint segment** → `possible` with non-prescriptive evidence (the AS may legitimately host multiple resource identifiers on the same origin; we can't tell without inspecting AS aud-binding policy).
- **`resource` is not a parseable URL** (e.g. opaque URN) → `possible` with a pointer to RFC 8707 §2's absolute-URI requirement.

Exact match continues to be `ruled_out`. Surfaced during PR #1665 verification against a figma seller agent whose RFC-9728-compliant PRM was flagged as a likely issue.
