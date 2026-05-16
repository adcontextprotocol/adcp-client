---
'@adcp/sdk': patch
---

fix(codegen): guard `generate-wire-spec-fields` against fresh-clone empty cache

When `schemas/cache/` is gitignored and not yet downloaded (e.g. fresh clone before `npm run sync-schemas`), the codegen previously overwrote the committed `src/lib/server/wire-spec-fields.generated.ts` with an empty stub, breaking `tsc` for every consuming module until the dev manually re-synced. The script now detects the empty-cache + pre-existing-non-empty-output case and leaves the committed file unchanged, with a console line explaining the skip.

No runtime behavior change; build-time only.
