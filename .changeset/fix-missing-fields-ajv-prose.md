---
"@adcp/client": patch
---

fix(hints): drop AJV-prose fallback in `groupRequiredIssues`

`MissingRequiredFieldHint.missing_fields` is documented as "Field name(s) the parent object was required to carry." When the field-name extraction regex did not match an AJV `required` error message (e.g. a reworded or locale-variant message), the fallback `?? issue.message` wrote the entire AJV prose string into `missing_fields[]` as if it were a field name. Downstream renderers (CLI, Addie, JUnit) wrap entries in backticks and generate "add the X field" coaching, so they would produce nonsense output for these entries.

The fallback is now removed. When the regex does not match, the issue is skipped — `missing_fields` contains only clean field identifiers. Unextractable issues remain visible via `ValidationResult.warning`.
