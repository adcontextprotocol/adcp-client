---
"@adcp/sdk": patch
---

fix(v2/projection): resolve v1-canonical-mapping.json and 3.1+ schema cache from dist/lib/schemas-data in published npm tarball

`registry.ts` and `canonical-properties.ts` looked for their data files at `../../../../schemas/cache/<version>/` (relative to the compiled loader), which resolves to the package root's `schemas/cache/` directory — a path that does not exist in the published npm tarball. The files are actually shipped at `dist/lib/schemas-data/<version>/`.

Both loaders now check `../../schemas-data/<version>/` first (the npm-tarball path), then fall back to `../../../../schemas/cache/<version>/` for source-checkout development workflows where schemas are synced locally. Mirrors the two-candidate resolution pattern already in `catalog.ts` after #1909.

Fixes storyboard crashes on `get_products` for v3.1-beta projection paths: `v1-canonical-mapping.json not found`.
