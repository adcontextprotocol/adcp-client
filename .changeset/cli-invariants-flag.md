---
'@adcp/client': minor
---

`adcp storyboard run` gains `--invariants <module[,module...]>`. The flag
dynamic-imports each specifier before the runner resolves
`storyboard.invariants`, giving operators a way to populate the assertion
registry (adcp#2639) without editing the CLI. Relative paths resolve against
the current directory; bare specifiers resolve as npm packages.

Modules are expected to call `registerAssertion(...)` at import time. The
flag runs before the `--dry-run` gate so bad specifiers surface immediately
during preview, not after agent resolution and auth.

Applies to `adcp storyboard run`, `adcp comply` (deprecated alias), and
`adcp storyboard run --url` multi-instance dispatch.
