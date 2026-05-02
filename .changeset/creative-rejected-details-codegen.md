---
"@adcp/sdk": patch
---

fix(codegen): honor schema title in gap-schemas dedupe (emit CreativeRejectedDetails)

`schemas/cache/3.0.4/error-details/creative-rejected.json` has title "Creative Rejected Details" but the gap-schemas pass derived its dedupe key from the filename (`creative-rejected` → `CreativeRejected`). That collided with the brand-domain `CreativeRejected` interface (different schema, from `creative-approval-response.json`) already in the `generatedTypes` set, so the file was silently skipped before `json-schema-to-typescript` could produce its actual title-derived `CreativeRejectedDetails`.

Six other error-details files (`account-setup-required`, `audience-too-small`, `budget-too-low`, `conflict`, `policy-violation`, `rate-limited`) emit fine because their kebab-name doesn't collide. Only `creative-rejected` was affected; the gap predates 3.0.4.

Fix: peek at the schema's `title` (when present) and use the title-derived name for both the dedupe check and the `compile()` argument. `CreativeRejectedDetails` now emits as a standalone interface. Brand-domain `CreativeRejected` is unaffected.

Closes #1271.
