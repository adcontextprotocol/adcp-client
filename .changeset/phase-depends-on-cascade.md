---
'@adcp/sdk': minor
---

Storyboard runner: per-phase cascade scoping via `phase.depends_on` (#1161).

Stateful cascade is now scoped per-phase rather than per-storyboard. Phases declare which prior phases they actually depend on for state; only those phases tripping their cascade gates the current phase's stateful steps. Independent phases run normally even when other phases tripped.

**Field shape**: `phase.depends_on?: string[]` on `StoryboardPhase`. Default semantics (field absent) preserves the storyboard-scope behavior — implicit "depends on all prior phases." Backward-compatible with every existing storyboard, including the F6 round-2 cross-phase pattern (`signal_marketplace/governance_denied`).

**Two new modes**:
- `depends_on: []` declares the phase independent. Runs even if every prior phase tripped its cascade. Use for phases whose state derives from the request body alone (e.g., `audience_sync` carrying its own account ref via `brand`+`operator`) rather than from prior-phase state.
- `depends_on: ['phase_id', ...]` declares targeted dependencies. Only the named phases gate this phase's cascade; other tripped phases are irrelevant.

**Within-phase cascade preserved**: stateful steps later in a phase still cascade-skip when an earlier stateful step in the same phase trips. Intra-phase state dependency is a storyboard authoring intent that `depends_on` (which scopes inter-phase cascade) doesn't override.

**Loader validation**: forward references, self-references, and unknown phase IDs in `depends_on` fail loud at parse time. Empty list (`[]`) is legal.

**Companion spec issue**: needs to be filed at `adcontextprotocol/adcp` to add the field to the storyboard schema and audit each specialism storyboard for which phases are functionally independent (notably `sales-social` where `audience_sync` / `creative_push` / `event_setup` / `event_logging` / `financials` are arguably independent of `account_setup` for explicit-mode platforms — the citrusad-shape 1/9/0 case).

Diagnostic improvement: cascade-detail messages now reference the trigger from the specific dependency phase rather than a storyboard-scope first-trip, so reports show which dependency actually gated the skip.
