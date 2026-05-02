---
"@adcp/sdk": patch
---

feat(types): add `@deprecated` aliases for error-details schemas renamed in AdCP 3.0.x

adcp#3149 (`rate-limited.json`) and adcp#3566 (five other error-details files) canonicalized SCREAMING_SNAKE titles like `RATE_LIMITED Details` and `ACCOUNT_SETUP_REQUIRED Details` into Title Case. The previous SDK release emitted `RATE_LIMITEDDetails`, `ACCOUNT_SETUP_REQUIREDDetails`, etc.; post-3.0.4 the canonical names are `RateLimitedDetails`, `AccountSetupRequiredDetails`, etc.

Hand-authored aliases in `src/lib/types/error-details.aliases.ts` preserve the old names for one minor cycle so consumers' imports keep compiling. Each alias is `@deprecated` so editor tooling surfaces the canonical replacement; slated for removal in the next major.

Aliases shipped (covers both type and Schema export pairs):

- `ACCOUNT_SETUP_REQUIREDDetails` / `…Schema` → `AccountSetupRequiredDetails` / `…Schema`
- `AUDIENCE_TOO_SMALLDetails` / `…Schema` → `AudienceTooSmallDetails` / `…Schema`
- `BUDGET_TOO_LOWDetails` / `…Schema` → `BudgetTooLowDetails` / `…Schema`
- `CONFLICTDetails` / `…Schema` → `ConflictDetails` / `…Schema`
- `POLICY_VIOLATIONDetails` / `…Schema` → `PolicyViolationDetails` / `…Schema`
- `RATE_LIMITEDDetails` / `…Schema` → `RateLimitedDetails` / `…Schema` (3.0.1 rename)

`creative-rejected.json` is intentionally absent — codegen never emitted a standalone `CreativeRejectedDetails` (or its prior SCREAMING_SNAKE form) because the brand-domain `CreativeRejected` interface lays claim to the namespace first. Tracked as #1271.

Closes #1065.
