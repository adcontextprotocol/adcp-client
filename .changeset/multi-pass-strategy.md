---
'@adcp/client': minor
---

Add `multi-pass` multi-instance strategy for storyboard runner (#607)

Opt-in via `--multi-instance-strategy multi-pass` (CLI) or
`multi_instance_strategy: 'multi-pass'` (library). Runs the storyboard once
per replica, each pass starting the round-robin dispatcher at a different
replica. Ensures each step is exercised against a different replica across
passes — surfacing bugs isolated to one replica (stale config, divergent
version, local-cache miss) that single-pass round-robin can't distinguish
from a success. Default stays `round-robin` to keep CI time predictable.

`StoryboardResult` gains `passes?: StoryboardPassResult[]` with per-pass
detail. Top-level `passed_count` / `failed_count` / `skipped_count` and
`overall_passed` aggregate across passes; top-level `phases` remains the
first pass for backward compatibility.

Known limitation: for N=2, offset-shift preserves pair parity, so a
write→read pair whose dispatch indices differ by an odd amount lands
same-replica in every pass. Closing that gap requires dependency-aware
dispatch reading `context_inputs` (tracked as #607 option 2).
