---
"@adcp/sdk": patch
---

Add `3.0.6` to `COMPATIBLE_ADCP_VERSIONS` and bump 3.0.5 → 3.0.6 schema citations across user-facing surfaces.

PR #1510 bumped `ADCP_VERSION` to 3.0.6 but didn't add 3.0.6 to the `COMPATIBLE_ADCP_VERSIONS` literal union in `scripts/sync-version.ts`. Callers passing `{ adcpVersion: '3.0.6' }` to constructor options fell through the literal-union autocomplete to the `(string & {})` escape hatch — still accepted at runtime, but no editor completion or compile-time signal. Closes the gap by appending `'3.0.6'` to the list and regenerating `src/lib/version.ts` via `sync-version`.

Bumped citations elsewhere so the docs / examples / source comments line up with the pinned version:

- `skills/cross-cutting.md` § Spec reference — `schemas/cache/3.0.5/bundled/<protocol>/` → `3.0.6`
- `skills/SHAPE-GOTCHAS.md` §7 — `schemas/cache/3.0.5/enums/signal-catalog-type.json` → `3.0.6`
- `examples/hello_seller_adapter_social.ts` — `/schemas/3.0.5/core/audience.json` → `3.0.6`
- `src/lib/server/decisioning/runtime/from-platform.ts` — `schemas/cache/3.0.5/core/account-ref.json` → `3.0.6`

`docs/migration-6.6-to-6.7.md` 3.0.5 references are historical (the migration target was 3.0.5) and stay unchanged.

Tracked at adcp-client #1523 (waiting on adcp#4015 — audio variant phase for `creative_template` storyboard) and #1525 (waiting on adcp#4021 — `output_only` flag on `format.assets[]`). Both upstream issues remain OPEN.

Validated: fork-matrix 23/23, typecheck + format clean.

Pure additive at the wire and at the type level — `COMPATIBLE_ADCP_VERSIONS` extends backward compatibility, no existing strings change.
