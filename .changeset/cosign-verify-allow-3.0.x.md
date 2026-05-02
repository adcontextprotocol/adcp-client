---
"@adcp/sdk": patch
---

Broaden cosign keyless verify regex in `scripts/sync-schemas.ts` to allow signatures from any release branch (not just `main` and `2.6.x`). Aligns with adcp-client-python and adcp-go, which both use a `refs/(heads|tags)/.*` wildcard.

**The bug**: v3.0.1, v3.0.2, v3.0.3 were released from `refs/heads/3.0.x` (the maintenance branch); the prior regex `^...refs/heads/(main|2\.6\.x)$` silently rejected them with `cosign verify-blob failed for v3.0.1: none of the expected identities matched what was in the certificate, got subjects [...refs/heads/3.0.x]`. SDK adopters bumping past v3.0.0 hit this on every sync.

**The fix**: switch to `^...refs/(heads|tags)/.*$`. The trust gate is upstream `release.yml`'s `on.push.branches` allowlist (currently `main`, `3.0.x`, `2.6.x`) — that's what determines which refs can produce a signature. Mirroring the list here added no defense and broke every time a new release line was added. The wildcard delegates branch-allowlist enforcement to the workflow itself, where it belongs. `refs/tags/*` is forward-compat for any future post-tag re-signing flow.

Closes the verify-failure on v3.0.1+ that adopters reported when bumping past 3.0.0.
