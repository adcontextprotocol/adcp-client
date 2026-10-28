---
"@adcp/sdk": patch
---

Preserve macro-bearing URL schemas as strings when generating the current AdCP 3.1 types. Backport the lexical-validator normalization from upstream commit 5d51dabd9f; the original JSON Schema format and pattern checks remain enforced by runtime validation.
