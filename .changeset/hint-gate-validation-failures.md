---
"@adcp/client": patch
---

Runner hint gate now fires on any step-level failure (task-level OR validation-level), not just task failures. Closes adcp-client#883. Some sellers return 200 with an advisory `errors[]` + `available:` list (success envelope with warnings); the previous gate missed those because `passed` was true at the task level. `expect_error` semantics are unchanged — genuinely-failing expect_error steps still stay silent by design.
