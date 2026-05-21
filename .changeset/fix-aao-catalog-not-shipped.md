---
'@adcp/sdk': patch
---

fix(v2/projection): vendor `aao-reference-formats.json` into the published bundle

The v1↔v2 projection loader (`v2/projection/catalog.ts`, new in 7.10) requires
the AAO canonical-formats catalog at runtime. The previous build resolved it
from `test/lib/v2-projection-fixtures/aao-reference-formats.json` (not in the
published `files` glob) and `.context/adcp-3307/...` (a dev-machine path),
so any consumer that exercised `get_products`-class augmentation
(`augmentProductWithFormatOptions` / `withFormatOptions`) crashed with
`AAO catalog (reference-formats.json) not found`.

The build now copies the fixture to `dist/lib/v2/projection/aao-reference-formats.json`
via `scripts/copy-v2-projection-catalog.ts`, and the loader looks adjacent to
its compiled location first. The source-tree `test/` path is retained as a
dev fallback (tsx / vitest / source checkouts) but is not required for the
published bundle to function.

Reported as adcontextprotocol/adcp-client#1909.
