---
'@adcp/sdk': minor
---

fix(codegen): bridge JSON Schema validation constraints across the lossy TS → Zod hop

Generated Zod schemas now enforce the `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, and `format` keywords from the upstream JSON Schemas. Before this change, those keywords were silently lost during the `JSON Schema → TypeScript (json-schema-to-typescript) → Zod (ts-to-zod)` codegen because TypeScript can't carry a numeric range or a regex on a `number` / `string` field. The emitted Zod for `MediaBuy.revision` was `z.number().optional()` instead of `z.number().min(1).optional()`, so typed validators accepted constraint-violating values that Ajv (which loads the raw JSON Schema) correctly rejected.

The codegen now pre-processes each schema before it reaches `json-schema-to-typescript`, encoding each property's constraints into the JSDoc-bound `description` field as `@minimum` / `@maximum` / `@minLength` / `@maxLength` / `@pattern` / `@format` tags. `ts-to-zod` natively reads those JSDoc tags, so the constraints round-trip into `.min()` / `.max()` / `.regex()` / `.iso.datetime()` / `.email()` / etc. on the emitted Zod schemas. About 900 new validator chains land across `schemas.generated.ts` covering currency codes, ISO country codes, ISBN/IBAN/BIC patterns, RFC-conformant URLs, ISO-8601 timestamps, and numeric ranges (`revision >= 1`, `priority >= 1`, all monetary `total_budget`/`rate` >= 0, etc.).

Behavioral impact for adopters: typed SDK validators (`MediaBuySchema.parse(...)`, etc.) now reject inputs they previously silently accepted. This matches what real Ajv-driven server-side validation already did — the SDK no longer hands a typed buyer payload the wire would refuse. Adopters who relied on the looser typed validators to construct fixtures or intermediate stages will need to populate the constraint-valid values.

`exclusiveMinimum` / `exclusiveMaximum` are not injected (ts-to-zod has no exclusive variant); they continue to be enforced at runtime by Ajv against the unstripped schema. Pattern values containing newlines or unsupported `format` keywords (e.g. `iri-reference`) are likewise skipped — same Ajv fallback.

Fixes #1745.
