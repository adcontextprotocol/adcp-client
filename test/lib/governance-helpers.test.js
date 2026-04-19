const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  buildAnnexIIIPlan,
  buildHumanOverride,
  validateGovernancePlan,
  REGULATED_HUMAN_REVIEW_CATEGORIES,
  ANNEX_III_POLICY_IDS,
} = require('../../dist/lib/governance');

describe('buildAnnexIIIPlan', () => {
  test('stamps human_review_required: true on the returned plan', () => {
    const plan = buildAnnexIIIPlan({
      plan_id: 'plan-1',
      brand: { domain: 'example.com' },
      objectives: 'Regulated campaign',
      budget: { total: 10000, currency: 'USD', reallocation_unlimited: true },
      flight: { start: '2026-05-01T00:00:00Z', end: '2026-06-01T00:00:00Z' },
      policy_categories: ['fair_lending'],
    });
    assert.strictEqual(plan.human_review_required, true);
    assert.deepStrictEqual(plan.policy_categories, ['fair_lending']);
  });

  test('does not mutate the input', () => {
    const input = {
      plan_id: 'plan-1',
      brand: { domain: 'example.com' },
      objectives: 'Regulated campaign',
      budget: { total: 5000, currency: 'USD', reallocation_threshold: 500 },
      flight: { start: '2026-05-01T00:00:00Z', end: '2026-06-01T00:00:00Z' },
    };
    const before = JSON.stringify(input);
    buildAnnexIIIPlan(input);
    assert.strictEqual(JSON.stringify(input), before);
  });
});

describe('buildHumanOverride', () => {
  test('accepts valid input and returns ISO approved_at', () => {
    const override = buildHumanOverride({
      reason: 'Compliance team ratified post-review',
      approver: 'compliance@example.com',
    });
    assert.strictEqual(override.reason, 'Compliance team ratified post-review');
    assert.strictEqual(override.approver, 'compliance@example.com');
    assert.match(override.approved_at, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('accepts Date for approvedAt', () => {
    const when = new Date('2026-04-18T12:00:00Z');
    const override = buildHumanOverride({
      reason: 'Human reviewer cleared the Annex III risks',
      approver: 'approver@example.com',
      approvedAt: when,
    });
    assert.strictEqual(override.approved_at, '2026-04-18T12:00:00.000Z');
  });

  test('rejects reason shorter than 20 characters', () => {
    assert.throws(
      () =>
        buildHumanOverride({
          reason: 'too short',
          approver: 'a@b.co',
        }),
      /at least 20 characters/
    );
  });

  test('rejects non-email approver', () => {
    assert.throws(
      () =>
        buildHumanOverride({
          reason: 'Compliance team ratified post-review',
          approver: 'not-an-email',
        }),
      /must be an email address/
    );
  });
});

describe('validateGovernancePlan', () => {
  const validBudget = { total: 1000, currency: 'USD', reallocation_unlimited: true };
  const validFlight = { start: '2026-05-01T00:00:00Z', end: '2026-06-01T00:00:00Z' };
  const validBrand = { domain: 'example.com' };

  test('returns no issues for a valid non-regulated plan', () => {
    const issues = validateGovernancePlan({
      plan_id: 'p1',
      brand: validBrand,
      objectives: 'Test',
      budget: validBudget,
      flight: validFlight,
    });
    assert.deepStrictEqual(issues, []);
  });

  test('flags when both reallocation fields are set', () => {
    const issues = validateGovernancePlan({
      budget: {
        total: 1000,
        currency: 'USD',
        reallocation_threshold: 100,
        reallocation_unlimited: true,
      },
    });
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].code, 'budget.reallocation_both_set');
  });

  test('flags when neither reallocation field is set', () => {
    const issues = validateGovernancePlan({
      budget: { total: 1000, currency: 'USD' },
    });
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].code, 'budget.reallocation_missing');
  });

  test('flags negative reallocation_threshold', () => {
    const issues = validateGovernancePlan({
      budget: { total: 1000, currency: 'USD', reallocation_threshold: -1 },
    });
    assert.ok(
      issues.some(i => i.code === 'budget.reallocation_threshold_negative'),
      `expected negative-threshold issue, got ${JSON.stringify(issues)}`
    );
  });

  test('flags missing human_review_required for each regulated category', () => {
    for (const category of REGULATED_HUMAN_REVIEW_CATEGORIES) {
      const issues = validateGovernancePlan({
        budget: validBudget,
        policy_categories: [category],
      });
      const missing = issues.find(i => i.code === 'plan.human_review_required_missing');
      assert.ok(missing, `expected human_review_required issue for ${category}`);
      assert.match(missing.message, new RegExp(category));
    }
  });

  test('flags missing human_review_required for eu_ai_act_annex_iii', () => {
    const issues = validateGovernancePlan({
      budget: validBudget,
      policy_ids: [...ANNEX_III_POLICY_IDS],
    });
    assert.ok(
      issues.some(i => i.code === 'plan.human_review_required_missing'),
      'expected human_review_required issue for Annex III policy id'
    );
  });

  test('passes when human_review_required: true is set for regulated category', () => {
    const issues = validateGovernancePlan({
      budget: validBudget,
      policy_categories: ['fair_housing'],
      human_review_required: true,
    });
    assert.deepStrictEqual(issues, []);
  });

  test('passes for non-regulated policy_categories without human_review_required', () => {
    const issues = validateGovernancePlan({
      budget: validBudget,
      policy_categories: ['health_wellness'],
    });
    assert.deepStrictEqual(issues, []);
  });
});
