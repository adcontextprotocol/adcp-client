---
'@adcp/client': minor
---

Governance: migrate test fixtures off `budget.authority_level`; add Annex III helpers and a client-side invariant validator.

AdCP removed `budget.authority_level` in favor of two orthogonal fields:

- `budget.reallocation_threshold: number ≥ 0` / `budget.reallocation_unlimited: true` — budget reallocation autonomy (mutually exclusive).
- `plan.human_review_required: boolean` — mandatory human review for decisions affecting data subjects under GDPR Art 22 / EU AI Act Annex III.

Changes:

- Remove every `authority_level` reference from `src/lib/testing/` and `test/lib/` fixtures. Mapping: `agent_full → reallocation_unlimited: true`; `agent_limited → keep reallocation_threshold` (drop authority_level); `human_required → plan.human_review_required: true`.
- New `@adcp/client` exports from `src/lib/governance/`:
  - `buildAnnexIIIPlan(input)` — stamps `human_review_required: true` on a regulated-vertical plan.
  - `buildHumanOverride({ reason, approver, approvedAt? })` — builds the artifact required to downgrade `human_review_required: true → false` on re-sync (validates reason ≥20 chars, approver is an email).
  - `validateGovernancePlan(plan)` — client-side check for two invariants that `datamodel-code-generator`-style codegen drops from `if/then`: budget threshold XOR unlimited, and regulated `policy_categories` (`fair_housing`, `fair_lending`, `fair_employment`, `pharmaceutical_advertising`) or Annex III `policy_ids` requiring `human_review_required: true`.
  - `REGULATED_HUMAN_REVIEW_CATEGORIES`, `ANNEX_III_POLICY_IDS` constants.
- `skills/build-governance-agent/SKILL.md` `check_governance` decision logic updated to document `reallocation_threshold` / `reallocation_unlimited`, auto-flipping `human_review_required`, `data_subject_contestation` findings, `human_override` artifacts, and the audit-mode-no-downgrade rule.
- `docs/guides/GOVERNANCE-MIGRATION.md` documents the `authority_level` → `reallocation_threshold` / `reallocation_unlimited` / `human_review_required` mapping.

Fixes #576.
