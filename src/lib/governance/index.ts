/**
 * Governance plan helpers — GDPR Art 22 / EU AI Act Annex III invariants.
 *
 * These helpers complement the Zod-generated request schemas by exposing
 * constraints that `datamodel-code-generator`-style codegen commonly drops
 * from `if/then` and `oneOf`:
 *  - budget reallocation autonomy is exactly one of `reallocation_threshold`
 *    or `reallocation_unlimited`
 *  - regulated-vertical `policy_categories` / Annex III `policy_ids` require
 *    `human_review_required: true`
 *
 * The helpers never mutate their inputs. The validator is intentionally
 * advisory — the authoritative check happens in the governance agent, which
 * resolves category synonyms and custom policies server-side.
 */

/**
 * `policy_categories` values that MUST set `human_review_required: true`
 * under GDPR Art 22 / EU AI Act Annex III. Matches the schema's `if/then`
 * constraint on `sync-plans-request.json`. Governance agents resolve
 * synonyms and custom policies server-side; this list is the client-side
 * minimum for pre-submit validation.
 */
export const REGULATED_HUMAN_REVIEW_CATEGORIES = Object.freeze([
  'fair_housing',
  'fair_lending',
  'fair_employment',
  'pharmaceutical_advertising',
] as const);

/**
 * `policy_ids` values that MUST set `human_review_required: true`.
 * Client-enforced minimum; server-side resolution remains authoritative.
 */
export const ANNEX_III_POLICY_IDS = Object.freeze(['eu_ai_act_annex_iii'] as const);

/**
 * Budget reallocation autonomy. Exactly one field must be set; the runtime
 * validator `validateGovernancePlan` is the source of truth. The structural
 * type does not enforce mutual exclusion because `PlanBudget` carries an
 * index signature for forward-compatibility with schema additions.
 */
export type ReallocationAutonomy =
  | { reallocation_unlimited: true }
  | { reallocation_threshold: number };

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

export interface BuildHumanReviewPlanInput {
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
 * Stamp `human_review_required: true` on a plan. The caller remains
 * responsible for declaring the reason for human review through
 * `policy_categories` (e.g. `'fair_lending'`) or `policy_ids` (e.g.
 * `'eu_ai_act_annex_iii'`). This helper does not infer or set either.
 *
 * Call `validateGovernancePlan` on the returned plan before `sync_plans`
 * to verify the reallocation autonomy and regulated-vertical invariants.
 */
export function buildHumanReviewPlan(input: BuildHumanReviewPlanInput): GovernancePlan {
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

const EMAIL_PATTERN = /^[^\s@.]+(?:\.[^\s@.]+)*@[^\s@.]+(?:\.[^\s@.]+)*\.[^\s@.]{2,}$/;
const CONTROL_CHAR_PATTERN = /[\x00-\x1F\x7F]/;
const MIN_REASON_LENGTH = 20;

function assertParseableIsoTimestamp(value: string, field: string): void {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`${field} must be a parseable ISO 8601 timestamp (got "${value}")`);
  }
}

/**
 * Build a `human_override` artifact for downgrading `human_review_required`
 * on a plan re-sync. Validates that the reason is substantive (≥20
 * characters after trimming edge whitespace), the approver is an email,
 * and no control characters appear in either field (audit-log safety).
 *
 * `approvedAt` defaults to the current ISO timestamp. Callers recording
 * a retroactive approval should pass the human's decision time explicitly.
 *
 * Throws `Error` with a descriptive message on invalid input.
 */
export function buildHumanOverride(input: BuildHumanOverrideInput): HumanOverride {
  const reason = input.reason.trim();
  if (reason.length < MIN_REASON_LENGTH) {
    throw new Error(
      `human_override.reason must be at least ${MIN_REASON_LENGTH} characters (got ${reason.length})`
    );
  }
  if (CONTROL_CHAR_PATTERN.test(reason)) {
    throw new Error('human_override.reason must not contain control characters');
  }

  const approver = input.approver.trim();
  if (CONTROL_CHAR_PATTERN.test(approver)) {
    throw new Error('human_override.approver must not contain control characters');
  }
  if (!EMAIL_PATTERN.test(approver)) {
    throw new Error(`human_override.approver must be an email address (got "${approver}")`);
  }

  let approvedAt: string;
  if (input.approvedAt instanceof Date) {
    if (Number.isNaN(input.approvedAt.getTime())) {
      throw new Error('human_override.approvedAt is an invalid Date');
    }
    approvedAt = input.approvedAt.toISOString();
  } else if (typeof input.approvedAt === 'string') {
    assertParseableIsoTimestamp(input.approvedAt, 'human_override.approvedAt');
    approvedAt = input.approvedAt;
  } else {
    approvedAt = new Date().toISOString();
  }

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
 * Client-side check for plan-level invariants that generated types often
 * drop from `if/then` / `oneOf`. Complements the Zod request schema, which
 * covers structural validation (required fields, value types).
 *
 * Runs two checks:
 *
 *  - When `budget` is present: exactly one of `reallocation_threshold` /
 *    `reallocation_unlimited` must be set, and `reallocation_threshold`
 *    must be ≥ 0. Missing `budget` is **not** flagged — leave structural
 *    validation to the Zod schema.
 *  - When `policy_categories` includes a value in
 *    `REGULATED_HUMAN_REVIEW_CATEGORIES`, or `policy_ids` includes a value
 *    in `ANNEX_III_POLICY_IDS`, `human_review_required: true` is required.
 *    Governance agents resolve synonyms and custom policies server-side;
 *    this check is a best-effort pre-submit guard for the canonical names.
 *
 * Returns `[]` when no client-detectable invariants are violated. Callers
 * should still treat the governance agent as authoritative.
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
