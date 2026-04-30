---
'@adcp/sdk': minor
---

Adds v2.5 schema bundle support so the SDK can validate against the actually-shipping AdCP 2.5.3 contract, not just v3.

`scripts/sync-v2-5-schemas.ts` (`npm run sync-schemas:v2.5`) pulls the v2.5.3 schema bundle from `adcontextprotocol/adcp@2.5-maintenance` at a pinned commit and drops it at `schemas/cache/v2.5/`. The pinned-SHA approach is necessary because the upstream `v2.5.2` and `v2.5.3` releases were never tagged or published as GitHub releases despite shipping in `package.json` and `CHANGELOG.md` (filed at `adcontextprotocol/adcp#3689`); pulling from the published spec site would silently regress to v2.5.1, missing the `additionalProperties: true` forward-compat relaxation, the `error.json` `details` typing fix, and the `impressions` / `paused` package-request fields.

The existing `resolveBundleKey('v2.5')` legacy alias and `copy-schemas-to-dist.ts` legacy-prerelease path both already routed `v2.5` correctly without resolver changes — the bundle ships at `dist/lib/schemas-data/v2.5/` alongside `dist/lib/schemas-data/3.0/`.

`schema-loader.ts`'s `ensureCoreLoaded` now registers request tool files in addition to fragments. v2.5's source tree ships flat (no pre-bundled `bundled/` subtree) with cross-fragment `$ref`s like `media-buy/create-media-buy-request.json` referencing `/schemas/media-buy/package-request.json`. The filename-suffix heuristic in `buildFileIndex` misclassifies fragments like `package-request.json` as tools (`package::request`), so the previous "skip everything in fileIndex" rule left them unregistered and AJV emitted `MissingRefError` on the cross-fragment lookup. The narrowed rule now skips only response tool files (which need `relaxResponseRoot` lazy-applied via `getValidator`); request tool files and fragments are pre-registered, so cross-fragment `$ref`s resolve at compile time. v3's bundled-schemas path is unaffected (refs were already inlined).

No buyer-facing API surface change. Internal-only — the v2.5 bundle is reachable via `getValidator(toolName, direction, 'v2.5')` for upcoming adapter-conformance work.
