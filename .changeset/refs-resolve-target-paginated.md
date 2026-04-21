---
'@adcp/client': patch
---

`refs_resolve`: detect paginated current-step targets and demote
unresolved refs to observations instead of failing the check.

Previously, when the target response carried `pagination.has_more:
true`, any ref legitimately defined on a later page graded as
`missing` — a false-positive failure against a conformant paginating
seller. The runner now emits a `target_paginated` meta-observation and
reports each would-be-missing ref as an `unresolved_with_pagination`
observation, letting the check pass until the spec-level resolution
lands (compliance mode requiring sellers to return everything
referenced by products in a single response). Closes #712.
