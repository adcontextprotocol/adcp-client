---
'@adcp/client': patch
---

Add `unresolved_hidden_by_pagination` meta-observation to `refs_resolve` when `target_paginated` AND at least one `unresolved_with_pagination` co-occur on the same result. Closes #718.

Catches the integrity gap introduced by #717: a seller that unconditionally returns `pagination.has_more: true` can hide refs it can't service — the demotion logic passes the check, and graders keying on `refs_resolve.passed` alone miss the structural smell. The new meta-observation names the co-occurrence neutrally (structural descriptor, not an accusation — graders decide intent) so compliance dashboards get an independent grader signal without changing pass/fail semantics. Shape mirrors `scope_excluded_all_refs` (the #711 silent-no-op detector): `{ kind, unresolved_count }` — the per-ref detail already lives in the `unresolved_with_pagination` observations. `unresolved_count` is deduped, so it matches the per-ref observation count.

Becomes redundant when `adcp#2601`'s "compliance mode returns everything referenced in a single response" rule lands at the spec level.
