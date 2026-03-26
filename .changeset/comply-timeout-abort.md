---
"@adcp/client": minor
---

Add `timeout_ms` and `signal` options to `comply()` for timeout and cancellation support. `timeout_ms` stops new scenarios from starting when exceeded. `signal` accepts an `AbortSignal` for external cancellation (e.g., graceful shutdown). Both options compose — either can trigger abort.
