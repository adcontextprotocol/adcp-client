---
'@adcp/client': minor
---

Storyboard runner now implements first-class branch-set grading, the
`contributes: true` boolean shorthand, and the implicit-detection fallback
the AdCP spec requires (adcp-client#693, adcp#2633, adcp#2646).

**Authoring (parser):** phases can declare `branch_set: { id, semantics }`
and contributing steps can use `contributes: true` as shorthand for
`contributes_to: <enclosing phase's branch_set.id>`. Enforced at parse time:

- `contributes: true` is only legal inside a phase that declares `branch_set:`.
- A step MUST NOT set both `contributes` and `contributes_to` (ambiguous).
- `contributes_to:` inside a branch-set phase MUST equal `branch_set.id`.
- Phases declaring `branch_set:` MUST set `optional: true`.
- `branch_set.semantics` must be a supported value (`any_of` today; future
  `all_of` / `at_least_n` are reserved). Unknown values are rejected at
  parse rather than silently skipping grading.

**Grading (runner):** after all phases run, branch-set peers are re-graded
per the schema rule (storyboard-schema.yaml "Per-step grading in any_of
branch patterns"). Branch-set membership is resolved two ways:

1. Explicit `branch_set: { id, semantics: 'any_of' }` declaration.
2. Implicit fallback: an optional phase with a step declaring
   `contributes_to: <flag>` that matches a later `assert_contribution
   check: any_of` target. Keeps pre-adcp#2633 storyboards working
   unchanged.

When a peer contributes the flag, non-contributing peers' failing steps are
re-labeled as `skipped: true` with a new canonical skip reason
`peer_branch_taken` and the mandated detail format:

```
<flag> contributed by <peer_phase_id>.<peer_step_id> — <this_phase_id> is moot
```

Hard failures (non-optional phases and `presenceDetected` PRM 2xx paths,
adcp-client#677) are exempt from re-grading — the invariants they enforce
must stand even when a peer branch contributed.

`peer_branch_taken` is distinct from `not_applicable` (coverage gap) and
raw `failed` — dashboards can tell "agent took the other branch" apart
from "agent misbehaved." When no peer contributes, failures stay raw and
`assert_contribution` is the single signal that fails the storyboard.

`comply.ts` observation generators (`check_governance` + slow-response)
now guard on `!step.warnings?.length` so re-graded moot peers don't emit
stale observations.

No storyboard migration is required.
