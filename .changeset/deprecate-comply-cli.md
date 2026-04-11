---
"@adcp/client": minor
---

Deprecate `adcp comply` CLI command in favor of `adcp storyboard run`. Running `adcp storyboard run <agent>` without a storyboard ID now runs all matching storyboards (the same behavior as `adcp comply`). The `comply` command still works but prints a deprecation warning and will be removed in v5.
