---
"@adcp/client": minor
---

feat(sync): pull canonical agent skills from the protocol tarball

`scripts/sync-schemas.ts` now extracts protocol-managed skills (`call-adcp-agent`, `adcp-media-buy`, `adcp-creative`, `adcp-signals`, `adcp-governance`, `adcp-si`, `adcp-brand`) from the published `/protocol/<version>.tgz` bundle alongside schemas and compliance, into `@adcp/client/skills/<name>/`. The sync is **manifest-driven and per-name** — only directories enumerated in `manifest.contents.skills` are overwritten, so SDK-local skills (`build-seller-agent`, `build-creative-agent`, etc.) stay untouched.

The buyer-side `call-adcp-agent` skill is now sourced from the spec repo (adcontextprotocol/adcp#3097) rather than maintained as a local copy — version-pinned to `ADCP_VERSION`, Sigstore-verified via the same cosign path as schemas, no manual sync.

Adds an `ADCP_BASE_URL` env override (defaults to `https://adcontextprotocol.org`) so CI / local-dev can point sync at a fake CDN for testing.
