# Governance Migration — `authority_level` → `reallocation_threshold` / `human_review_required`

AdCP removed the single-field `budget.authority_level` enum in favor of two
orthogonal fields. Budget reallocation autonomy is now expressed
numerically on the budget, and human review is a plan-level flag driven
by GDPR Article 22 / EU AI Act Annex III.

## What changed

**Before:**

```json
{
  "budget": {
    "total": 10000,
    "currency": "USD",
    "authority_level": "agent_full" | "agent_limited" | "human_required"
  }
}
```

**After:**

```json
{
  "budget": {
    "total": 10000,
    "currency": "USD",
    "reallocation_unlimited": true
  },
  "human_review_required": false
}
```

`budget` must now set **exactly one** of `reallocation_threshold` (≥ 0, in
`budget.currency`) or `reallocation_unlimited: true`. `human_review_required`
lives on the plan, not the budget.

## Field mapping

| Old `authority_level` | New budget                           | New plan                            |
| --------------------- | ------------------------------------ | ----------------------------------- |
| `agent_full`          | `reallocation_unlimited: true`       | —                                   |
| `agent_limited`       | `reallocation_threshold: <positive>` | —                                   |
| `human_required`      | `reallocation_threshold: 0` (strict) | `human_review_required: true`       |

## Regulated-vertical invariant

When a plan's `policy_categories` includes
`fair_housing`, `fair_lending`, `fair_employment`, or
`pharmaceutical_advertising`, or when `policy_ids` includes
`eu_ai_act_annex_iii`, `human_review_required: true` is **required**. The
schema encodes this as `if/then`, but some codegen tooling drops those
constraints — call `validateGovernancePlan` client-side to catch it early.

## Helpers

```ts
import {
  buildHumanReviewPlan,
  buildHumanOverride,
  validateGovernancePlan,
} from '@adcp/sdk';

// Stamps human_review_required: true. The caller still declares the
// reason via policy_categories / policy_ids.
const plan = buildHumanReviewPlan({
  plan_id: 'plan-2026-q2',
  brand: { domain: 'brand.example' },
  objectives: 'Regulated mortgage campaign',
  budget: { total: 250000, currency: 'USD', reallocation_threshold: 10000 },
  flight: { start: '2026-04-01T00:00:00Z', end: '2026-06-30T00:00:00Z' },
  policy_categories: ['fair_lending'],
  data_subject_contestation: {
    url: 'https://brand.example/contestation',
    email: 'privacy@brand.example',
    languages: ['en'],
  },
});

// Validate before sync. Governance agents resolve synonyms and custom
// policies server-side, so they remain authoritative — this is a
// pre-submit guard for the canonical invariants.
const issues = validateGovernancePlan(plan);
if (issues.length > 0) throw new Error(JSON.stringify(issues));

// On re-sync, to downgrade human_review_required: true → false,
// provide a human_override artifact. Throws if reason <20 chars,
// approver isn't an email, or either contains control characters.
const override = buildHumanOverride({
  reason: 'Human reviewer cleared targeting post Annex III review',
  approver: 'compliance@brand.example',
});
```

## Other additions

- `restricted-attribute` enum adds `age` and `familial_status`.
- `brand.json` / `brand-ref.json` add `data_subject_contestation` (URL,
  email, languages) at brand and house level, resolved in order:
  plan.brand inline → brand.json → brand.json.house → missing.
- `plan.policy_categories` cross-validated against `policy_ids`.
- `plan.human_override: { reason, approver, approved_at }` is the artifact
  required to downgrade `human_review_required: true` on re-sync.
