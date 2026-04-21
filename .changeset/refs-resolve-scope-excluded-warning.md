---
'@adcp/client': patch
---

`refs_resolve`: emit a `scope_excluded_all_refs` meta-observation when
a scope filter partitions every source ref out. The integrity check
enforces nothing when no ref falls in-scope; graders previously got a
silent pass. The meta-observation surfaces the structural smell without
changing pass/fail semantics. Suppressed under `on_out_of_scope: 'ignore'`
(which explicitly opts out of scope warnings). Closes #711.
