---
'@adcp/sdk': patch
---

fix(storyboard): distinguish constraint violations from missing fields; remove spurious confirmed_at advisory (closes #1736)

Two false positives in the storyboard evaluator are resolved:

- **Missing vs constraint, distinct classification.** `validateResponseSchema` (Zod path in `testing/client.ts`) and the storyboard `response_schema` handler (AJV-derived path in `testing/storyboard/validations.ts`) now split violations into two groups: `Response missing required fields: <pointers>` for absent required fields (`keyword: 'required'`) and `Response constraint violations: <pointer> (<keyword>): <message>` for present-but-invalid values (`minimum`, `maximum`, `enum`, `format`, …). Zod's `invalid_type` issue is re-tagged to `keyword: 'required'` when the value is `undefined`, since the remediation differs (add the field vs. fix the value). Each violation carries a JSON Pointer (`/foo/0/bar`) for downstream tooling.
- **Spurious `confirmed_at` advisory removed.** The hard-coded "Agent does not return confirmed_at in create_media_buy response" warning had no backing storyboard rule and fired even when `confirmed_at` is optional in the schema. The companion hard-coded `revision` advisory is removed for the same reason — genuine non-conformance (e.g. `revision: 0` violating `minimum: 1`) is caught by the response_schema validator with the structured constraint-violation output above. Upstream resolution: adcp#3025.

A regression test (`test/lib/comply-advisory-rule-source.test.js`) pins that no advisory fires on `create_media_buy` for any combination of `confirmed_at`/`revision` presence, and the schema-validation test gains cases for the new missing/constraint split.
