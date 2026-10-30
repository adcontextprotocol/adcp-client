---
"@adcp/sdk": patch
---

Keep standalone legacy fixture steps untested when their required controller is unavailable, instead of sending unseeded product IDs or failing contribution assertions whose setup never ran. Preserve independent capability discovery, intrinsic tool and contract skips, explicit external-state opt-out, and the separate prepared-state and declarative fixture-resolution paths.
