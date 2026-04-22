---
'@adcp/client': patch
---

ci: consolidate pipeline and drop redundant jobs

CI-only change, no runtime/library behaviour affected. Published package contents are unchanged.

- `ci.yml`: collapse `test` / `quality` / `security` into a single job. Each was re-running `checkout + setup-node + npm ci`, wasting ~1–2 min of setup per PR. Also removes the `clean && build:lib` re-build in the old quality job and the redundant `build` step (alias of `build:lib`).
- `ci.yml`: drop `publish-dry-run`. `release.yml`'s `prepublishOnly` already validates packaging on the actual release PR.
- `ci.yml`: drop dead `develop` branch from the push trigger.
- `schema-sync.yml`: drop the PR-triggered `validate-schemas` job — `ci.yml` already syncs schemas and diffs generated files on every PR. Scheduled auto-update job preserved.
- `commitlint.yml`: use `npm ci` instead of `npm install --save-dev`; the `@commitlint/*` packages are already in `devDependencies`.
