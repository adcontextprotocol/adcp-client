---
'@adcp/sdk': patch
---

Scale the CLI's default compliance timeout budget with the selected storyboard count (`max(120, 10 × n)`) instead of a flat 120 seconds, backported from main, so larger selections don't silently truncate a full assessment run.
