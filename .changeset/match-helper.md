---
'@adcp/client': minor
---
Add `match(result, handlers)` — exhaustive, compile-time-checked handler for the `TaskResult` discriminated union. Replaces manual `if (result.status === ...)` narrowing at response sites. Optional `_` catchall makes handlers optional.
