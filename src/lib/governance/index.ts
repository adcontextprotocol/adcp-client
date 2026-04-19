/**
 * Governance plan helpers — Annex III / GDPR Art 22 invariants.
 *
 * These helpers complement `@modelcontextprotocol/sdk`-generated types by
 * enforcing cross-field constraints that `if/then` codegen commonly drops:
 *  - budget reallocation autonomy is exactly one of `reallocation_threshold`
 *    or `reallocation_unlimited`
 *  - regulated-vertical `policy_categories` / Annex III `policy_ids` require
 *    `human_review_required: true`
 *
 * The helpers never mutate their inputs.
 */

export const REGULATED_HUMAN_REVIEW_CATEGORIES = Object.freeze([
  'fair_housing',
  'fair_lending',
  'fair_employment',
  'pharmaceutical_advertising',
] as const);

export const ANNEX_III_POLICY_IDS = Object.freeze(['eu_ai_act_annex_iii'] as const);

export type ReallocationAutonomy =
  | { reallocation_unlimited: true; reallocation_threshold?: never }
  | { reallocation_threshold: number; reallocation_unlimited?: never };

export interface PlanBudget {
  total: number;
  currency: string;
  reallocation_threshold?: number;
  reallocation_unlimited?: boolean;
  [k: string]: unknown;
}

export interface DataSubjectContestation {
  url?: string;
  email?: string;
  languages?: string[];
  [k: string]: unknown;
}

export interface HumanOverride {
  reason: string;
  approver: string;
  approved_at: string;
}

export interface GovernancePlan {
  plan_id: string;
  brand: { domain: string; [k: string]: unknown };
  objectives: string;
  budget: PlanBudget;
  flight: { start: string; end: string; [k: string]: unknown };
  policy_categories?: string[];
  policy_ids?: string[];
  human_review_required?: boolean;
  human_override?: HumanOverride;
  data_subject_contestation?: DataSubjectContestation;
  [k: string]: unknown;
}

export interface BuildAnnexIIIPlanInput {
  plan_id: string;
  brand: { domain: string; [k: string]: unknown };
  objectives: string;
  budget: Omit<PlanBudget, 'reallocation_threshold' | 'reallocation_unlimited'> & ReallocationAutonomy;
  flight: { start: string; end: string; [k: string]: unknown };
  policy_categories?: string[];
  policy_ids?: string[];
  data_subject_contestation?: DataSubjectContestation;
  [k: string]: unknown;
}

/**
 * Build a plan for regulated verticals. Stamps `human_review_required: true`
 * and preserves every other field verbatim.
 *
 * `data_subject_contestation` is optional here — if omitted, the governance
 * agent will emit a critical finding and resolve via brand.json / house.
 */
export function buildAnnexIIIPlan(input: BuildAnnexIIIPlanInput): GovernancePlan {
  return {
    ...input,
    human_review_required: true,
  } as GovernancePlan;
}

export interface BuildHumanOverrideInput {
  reason: string;
  approver: string;
  approvedAt?: string | Date;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_REASON_LENGTH = 20;

/**
 * Build a `human_override` artifact for downgrading `human_review_required`
 * on a plan re-sync. Validates that the reason is substantive (≥20 chars)
 * and the approver is an email address.
 *
 * Throws on invalid input — governance agents reject malformed overrides.
 */
export function buildHumanOverride(input: BuildHumanOverrideInput): HumanOverride {
  const reason = input.reason.trim();
  if (reason.length < MIN_REASON_LENGTH) {
    throw new Error(
      `human_override.reason must be at least ${MIN_REASON_LENGTH} characters (got ${reason.length})`
    );
  }
  const approver = input.approver.trim();
  if (!EMAIL_PATTERN.test(approver)) {
    throw new Error(`human_override.approver must be an email address (got "${approver}")`);
  }
  const approvedAt =
    input.approvedAt instanceof Date
      ? input.approvedAt.toISOString()
      : input.approvedAt ?? new Date().toISOString();
  return { reason, approver, approved_at: approvedAt };
}

export interface GovernanceValidationIssue {
  code:
    | 'budget.reallocation_both_set'
    | 'budget.reallocation_missing'
    | 'budget.reallocation_threshold_negative'
    | 'plan.human_review_required_missing';
  path: string;
  message: string;
}

/**
 * Check plan-level invariants that codegen commonly drops from generated
 * types (if/then, oneOf):
 *
 *  - Budget must set exactly one of `reallocation_threshold` /
 *    `reallocation_unlimited`.
 *  - `reallocation_threshold` must be ≥ 0.
 *  - `human_review_required: true` is required when `policy_categories`
 *    includes a regulated vertical or `policy_ids` includes Annex III.
 *
 * Returns `[]` when the plan is valid. Does not validate field presence
 * beyond these invariants — the Zod schema covers the rest.
 */
export function validateGovernancePlan(plan: Partial<GovernancePlan>): GovernanceValidationIssue[] {
  const issues: GovernanceValidationIssue[] = [];

  if (plan.budget) {
    const hasThreshold = typeof plan.budget.reallocation_threshold === 'number';
    const hasUnlimited = plan.budget.reallocation_unlimited === true;

    if (hasThreshold && hasUnlimited) {
      issues.push({
        code: 'budget.reallocation_both_set',
        path: 'budget',
        message:
          'budget.reallocation_threshold and budget.reallocation_unlimited are mutually exclusive',
      });
    } else if (!hasThreshold && !hasUnlimited) {
      issues.push({
        code: 'budget.reallocation_missing',
        path: 'budget',
        message:
          'budget must set exactly one of reallocation_threshold or reallocation_unlimited',
      });
    }

    if (hasThreshold && (plan.budget.reallocation_threshold as number) < 0) {
      issues.push({
        code: 'budget.reallocation_threshold_negative',
        path: 'budget.reallocation_threshold',
        message: 'budget.reallocation_threshold must be ≥ 0',
      });
    }
  }

  const regulatedCategories = (plan.policy_categories ?? []).filter(c =>
    (REGULATED_HUMAN_REVIEW_CATEGORIES as readonly string[]).includes(c)
  );
  const annexIIIIds = (plan.policy_ids ?? []).filter(id =>
    (ANNEX_III_POLICY_IDS as readonly string[]).includes(id)
  );

  if ((regulatedCategories.length > 0 || annexIIIIds.length > 0) && plan.human_review_required !== true) {
    const reasons: string[] = [];
    if (regulatedCategories.length > 0) {
      reasons.push(`policy_categories includes [${regulatedCategories.join(', ')}]`);
    }
    if (annexIIIIds.length > 0) {
      reasons.push(`policy_ids includes [${annexIIIIds.join(', ')}]`);
    }
    issues.push({
      code: 'plan.human_review_required_missing',
      path: 'human_review_required',
      message: `human_review_required must be true when ${reasons.join(' or ')}`,
    });
  }

  return issues;
}
