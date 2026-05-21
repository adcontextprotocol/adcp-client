---
'@adcp/sdk': patch
---

fix(v2/projection): resolve v1-canonical-mapping.json and canonical schemas from `dist/lib/schemas-data/` in published tarballs

The v1↔v2 projection loaders (`registry.ts`, `canonical-properties.ts`) walked `schemas/cache/<version>/registries/` and `schemas/cache/<version>/formats/canonical/` relative to their source location — paths that exist in the SDK author's worktree but NOT in the published npm tarball (the `files` glob ships `dist/lib/schemas-data/<version>/...` per `scripts/copy-schemas-to-dist.ts`). Same shape of bug as the AAO catalog regression fixed in 7.10.1; this is the sibling.

After `npm install @adcp/sdk@7.10.1` and exercising `get_products`-class augmentation on a 3.1.0-beta.2-aware product, both loaders threw at first call — manifested in compliance matrices as cascading failures off the first product-discovery step (45/280 on `/sales` vs the 74/380 floor regardless of which fixture was missing, because the failure cascades the same way).

Both loaders now try the published-tarball path (`dist/lib/schemas-data/<version>/...`) first and fall through to the source-tree path (`schemas/cache/<version>/...`) only when running from a checkout pre-`build:lib`. Error messages updated to point at the issue tracker rather than asking adopters to vendor the SDK's packaging gap themselves.
