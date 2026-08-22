---
'@adcp/sdk': minor
---

comply: add `storyboard_start_offset` to distribute coverage across budget-limited runs (adcontextprotocol/adcp#6632). When `timeout_ms` truncates a run, execution previously always started from the same list head, so consecutive truncated runs re-graded the same prefix while tail storyboards were never exercised. The new option rotates the runnable storyboard list (modulo length, relative order preserved) so callers can vary the starting point between runs. The timeout-budget observation now also lists `storyboards_not_started` ids so per-run coverage gaps are inspectable, not just countable.
