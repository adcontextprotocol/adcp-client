---
"@adcp/client": patch
---

CLI now renders runner hints (`StoryboardStepResult.hints[]`) in both the human console output and JUnit `<failure>` body. Previously #875 added the detector and populated the field but the CLI was a no-op for the feature — triage output still looked identical to a bare seller error. Closes #879.

Console output prefixes each hint with `💡 Hint:` at the same 3-space indent as `Error:` and validations. JUnit failure bodies append `Hint (<kind>): <message>` lines so CI dashboards and test reporters pick them up.
