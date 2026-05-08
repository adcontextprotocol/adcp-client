---
'@adcp/sdk': patch
---

fix(task-executor): return descriptive failed result when polling an evicted task

`TaskExecutor.pollTaskCompletion` now catches `"Task <id> not found"` errors
from `getTaskStatus` and returns a `TaskResultFailure` with an actionable
error message rather than letting an opaque exception escape the polling
loop.

A2A 0.3.x defines no minimum retention TTL for completed tasks, so a seller
MAY evict a task between the buyer observing the working-state response and
the first explicit `tasks/get` poll firing. The error suggests using push
notifications (`reporting_webhook`) instead of polling, or configuring a
longer task retention TTL on the seller.

Defense-in-depth follow-up to #1585. The cross-storyboard root cause was
already addressed in #1588 (`resetContext()` per storyboard) and #1593
(narrowed `pendingTaskId` auto-thread to same-skill same-context); this
change improves the error surface for any residual case where an evicted
task is queried.
