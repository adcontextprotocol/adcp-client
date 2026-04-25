---
"@adcp/client": minor
---

feat(conformance): add FormatMismatchHint to StoryboardStepHint taxonomy

Third member of the `StoryboardStepHint` discriminated union. Emits a structured hint when a response_schema validation passes the lenient Zod check but fails strict AJV validation on a `format` keyword (`date-time`, `uuid`, `uri`, `email`, etc.). Non-fatal — does not flip step pass/fail. Fires only on strict_only_failure steps so it surfaces the strict/lenient delta without adding noise to already-failing validations. Closes #947.
