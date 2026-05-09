---
"@adcp/sdk": patch
---

chore(deps): bump fast-uri to 3.1.2 (security advisory)

Closes the GHSA-q3j6-qgpj-74h6 + GHSA-v39h-62p7-jpjc audit failures
that have been red-X'ing CI on every release since the advisories
dropped. `fast-uri` is a transitive dep (via `ajv` → `fastify`); the
SDK doesn't import it directly, but the audit blocked the
`Run security audit` step on every PR.

No public-API change; no behavior change in any SDK code path.
