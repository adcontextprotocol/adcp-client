---
'@adcp/sdk': patch
---

fix(deps): resolve npm audit advisories via non-breaking lockfile bumps

`npm audit fix` (non-breaking): `ws` 8.20.1 → 8.21.0 (GHSA-96hv-2xvq-fx4p, high — memory-exhaustion DoS; the only runtime dep affected), `tar` 7.5.15 → 7.5.16 (GHSA-vmf3-w455-68vh, moderate — build-time devDependency) and `markdown-it` 14.1.1 → 14.2.0 (GHSA-6v5v-wf23-fmfq, moderate — dev-only, via typedoc). Lockfile-only; no `package.json` range changes. Incidentally re-resolves a few unrelated dev-only transitives to satisfy the tree (`js-yaml` 4.1.1 → 4.2.0, `hono` 4.12.23 → 4.12.25) — distinct from the `@changesets/*` → `js-yaml` advisory chain, which requires a breaking major bump and is left for a separate maintainer decision.
