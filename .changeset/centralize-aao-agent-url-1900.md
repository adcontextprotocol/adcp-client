---
"@adcp/sdk": patch
---

refactor(v2): centralize AAO canonical agent URL into a shared constant

Extract `'https://creative.adcontextprotocol.org/'` from
`synthesizeFormatIdFromGlob` (registry.ts) into
`AAO_CANONICAL_AGENT_URL` in a new `src/lib/v2/projection/constants.ts`.
No behavior change — the synthesized `agent_url` value is byte-identical.
The JSDoc on the constant documents the distinction from
`DEFAULT_MIRROR_HOSTS` (an allowlist of hostnames for `$ref` sandboxing,
not an `agent_url` base). Also clarifies the JSDoc on
`synthesizeFormatIdFromGlob` to note the `agent_url` is non-normative
(registry synthesis is implementation-defined per spec).
