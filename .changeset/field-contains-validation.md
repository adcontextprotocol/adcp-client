---
"@adcp/sdk": minor
---

feat(storyboard): `field_contains` validation check — closes adcontextprotocol/adcp#3803 item 2

Adds a wildcard-aware membership check to the storyboard validator. `path` may include `[*]` segments (resolved via the existing `resolvePathAll`), and the check passes when ANY resolved value matches `value` or any of `allowed_values`.

Lets storyboards write:

```yaml
- check: field_contains
  path: creatives[0].errors[*].code
  value: PROVENANCE_VERIFIER_NOT_ACCEPTED
```

instead of the brittle positional form `creatives[0].errors[0].code value: PROVENANCE_VERIFIER_NOT_ACCEPTED`, which breaks when a future seller emits multiple errors per creative or reorders the cascade. When the path has no wildcard segments the check reduces to scalar equality.

Symmetric to `field_value` for missing-value/missing-path errors and JSON pointer emission. 8 new test cases in `test/lib/storyboard-validations.test.js`.
