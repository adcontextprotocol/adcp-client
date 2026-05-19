---
'@adcp/sdk': patch
---

docs: add `docs/guides/BASIC-AUTH.md` for gateway-fronted agents

Closes #1870. Documents the basic-auth-via-gateway pattern that the SDK and CLI have supported since #1866. Covers: when to use `--auth-scheme basic`, worked CLI + SDK examples, the load-bearing invariant (basic auth lives on `headers.Authorization`; do not also set `auth_token`), a copyable wire-trace verification test pattern, and common adopter pitfalls.

Cross-references added:

- `docs/CLI.md` "Authentication Methods" → links to the new guide and shows the CLI one-liner.
- `SingleAgentClient.getAgentInfo` JSDoc → names the invariant in-source so contributors editing the auth resolution path see it without having to read commit history.

Patch-bump because the JSDoc lives in a published source file. The .md docs aren't bundled, but the JSDoc surfaces in the published `.d.ts`.
