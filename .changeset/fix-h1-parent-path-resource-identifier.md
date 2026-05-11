---
"@adcp/sdk": patch
---

fix(cli): diagnose-auth H1 no longer fires on RFC-9728-correct parent-path resource identifiers

`diagnose-auth` H1 ("Resource URL mismatch") previously flagged any case where the PRM `resource` field did not exactly match the agent URL — including the normative RFC 9728 §3.3 pattern where a single resource server fronts multiple endpoints under a shared parent-path identifier (e.g., `resource: https://api.example.com/figma` covering `https://api.example.com/figma/mcp`).

H1 now returns `[ruled-out]` when the agent URL is the same as, or a sub-path of, the advertised resource identifier. H1 remains `[likely]` for genuine mismatches (different origin, or divergent path not covered by the resource). The `prmDiffersFromAgent` flag in H5 is updated to use the same compatibility predicate so it no longer shows a stale "see H1" cross-reference for spec-correct parent-path configurations.
