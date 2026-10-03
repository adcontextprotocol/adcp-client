const { describe, it } = require('node:test');
const assert = require('node:assert');

const { assessAcceptancePolicy } = require('../../dist/lib');

function rule(overrides = {}) {
  return {
    rule_id: 'rule',
    subject_category: 'political_advertising',
    applies_to: ['media_buy'],
    disposition: 'allowed',
    ...overrides,
  };
}

function profile(id, rules, overrides = {}) {
  return {
    profile_id: id,
    version: '1',
    content_digest: `sha256:${'0'.repeat(64)}`,
    policy_refs: [
      {
        policy_id: `${id}_policy`,
        version: '1',
        content_digest: `sha256:${'1'.repeat(64)}`,
      },
    ],
    coverage: 'complete',
    scope: {
      subject_categories: ['political_advertising'],
      applies_to: ['media_buy'],
      all_jurisdictions: true,
    },
    rules,
    ...overrides,
  };
}

function resolved(value, source = 'seller') {
  if (source === 'registry') {
    return {
      source,
      resolution: 'resolved',
      profileId: value.profile_id,
      profile: value,
      ref: {
        policy_id: 'registry_policy',
        policy_version: '1',
        policy_digest: `sha256:${'1'.repeat(64)}`,
        profile_id: value.profile_id,
        profile_version: value.version,
        profile_digest: value.content_digest,
      },
    };
  }
  return { source, resolution: 'resolved', profileId: value.profile_id, profile: value };
}

function context(overrides = {}) {
  return {
    subjects: [
      {
        subject_category: 'political_advertising',
        subject_facets: ['candidate_or_party'],
      },
    ],
    advertiser_roles: ['political_actor'],
    delivery_jurisdictions: ['US'],
    ...overrides,
  };
}

function assess(profiles, overrides = {}) {
  return assessAcceptancePolicy({
    profiles,
    acceptanceContext: context(),
    appliesTo: 'media_buy',
    evaluatedAt: '2026-09-21T12:00:00.000Z',
    ...overrides,
  });
}

describe('acceptance-policy assessment', () => {
  it('returns advisory allowed only for complete in-scope coverage', () => {
    const result = assess([resolved(profile('default', [rule()]))]);

    assert.deepStrictEqual(result, {
      advisory: true,
      outcome: 'allowed',
      profileIds: ['default'],
      matchingRuleIds: ['rule'],
      matchedRules: [
        {
          profileId: 'default',
          ruleId: 'rule',
          disposition: 'allowed',
          policyIds: [],
          requirements: [],
        },
      ],
      requirements: [],
      diagnostics: [],
    });
  });

  it('preserves unknown for partial coverage and omitted rules', () => {
    const value = profile('partial', [rule()], { coverage: 'partial', scope: undefined });
    const result = assess([resolved(value)]);

    assert.strictEqual(result.outcome, 'unknown');
    assert.deepStrictEqual(result.diagnostics, [{ code: 'partial_coverage', profileId: 'partial' }]);
  });

  it('lets an explicit prohibition win over partial coverage', () => {
    const value = profile('partial', [rule({ disposition: 'prohibited' })], {
      coverage: 'partial',
      scope: undefined,
    });
    const result = assess([resolved(value)]);

    assert.strictEqual(result.outcome, 'prohibited');
    assert.deepStrictEqual(result.matchingRuleIds, ['rule']);
    assert.deepStrictEqual(result.diagnostics, [{ code: 'partial_coverage', profileId: 'partial' }]);
  });

  it('composes seller and product profiles with the most restrictive rule', () => {
    const seller = profile('seller', [rule({ rule_id: 'seller_allow' })]);
    const product = profile('product', [rule({ rule_id: 'product_block', disposition: 'prohibited' })]);
    const result = assess([resolved(seller), resolved(product, 'registry')]);

    assert.strictEqual(result.outcome, 'prohibited');
    assert.deepStrictEqual(result.profileIds, ['seller', 'product']);
    assert.deepStrictEqual(result.matchingRuleIds, ['seller_allow', 'product_block']);
  });

  it('classifies conditional requirements into disclosure, setup, and review outcomes', () => {
    const conditional = requirement =>
      resolved(profile('conditional', [rule({ disposition: 'conditional', requirements: [{ kind: requirement }] })]));

    assert.strictEqual(assess([conditional('disclosure')]).outcome, 'requires_disclosure');
    assert.strictEqual(assess([conditional('advertiser_verification')]).outcome, 'requires_setup');
    assert.strictEqual(assess([conditional('prior_authorization')]).outcome, 'requires_review');
  });

  it('uses the strictest conditional bucket across profiles', () => {
    const disclosure = profile('disclosure', [
      rule({ rule_id: 'disclose', disposition: 'conditional', requirements: [{ kind: 'disclosure' }] }),
    ]);
    const review = profile('review', [
      rule({
        rule_id: 'review',
        disposition: 'conditional',
        requirements: [{ kind: 'custom', id: 'manual', description: 'Manual review' }],
      }),
    ]);
    const result = assess([resolved(disclosure), resolved(review)]);

    assert.strictEqual(result.outcome, 'requires_review');
    assert.deepStrictEqual(
      result.requirements.map(value => value.kind),
      ['disclosure', 'custom']
    );
  });

  it('preserves unknown when a matching dimension is omitted from context', () => {
    const value = profile('scoped', [
      rule({
        subject_facets: ['candidate_or_party'],
        advertiser_roles: ['political_actor'],
        jurisdictions: ['US'],
      }),
    ]);
    const result = assess([resolved(value)], {
      acceptanceContext: context({ advertiser_roles: undefined }),
    });

    assert.strictEqual(result.outcome, 'unknown');
    assert.deepStrictEqual(result.diagnostics, [{ code: 'incomplete_context', profileId: 'scoped', ruleId: 'rule' }]);
  });

  it('uses complete scope aliases and requires the entire contemplated delivery set to be covered', () => {
    const value = profile('regional', [rule()], {
      region_aliases: { NORTH_AMERICA: ['US', 'CA'] },
      scope: {
        subject_categories: ['political_advertising'],
        applies_to: ['media_buy'],
        jurisdiction_groups: ['NORTH_AMERICA'],
      },
    });

    assert.strictEqual(
      assess([resolved(value)], {
        acceptanceContext: context({ delivery_jurisdictions: ['US', 'CA'] }),
      }).outcome,
      'allowed'
    );
    const outside = assess([resolved(value)], {
      acceptanceContext: context({ delivery_jurisdictions: ['US', 'GB'] }),
    });
    assert.strictEqual(outside.outcome, 'unknown');
    assert.deepStrictEqual(outside.diagnostics, [{ code: 'incomplete_context', profileId: 'regional' }]);
  });

  it('applies effective_at inclusively and expires_at exclusively', () => {
    const value = profile('windowed', [
      rule({
        rule_id: 'windowed_block',
        disposition: 'prohibited',
        effective_at: '2026-09-21T12:00:00.000Z',
        expires_at: '2026-09-22T12:00:00.000Z',
      }),
    ]);

    assert.strictEqual(assess([resolved(value)]).outcome, 'prohibited');
    assert.strictEqual(assess([resolved(value)], { evaluatedAt: '2026-09-22T12:00:00.000Z' }).outcome, 'allowed');
  });

  it('fails closed on schema-valid rule timestamps unsupported by Date.parse', () => {
    const effective = profile('unsupported_effective', [
      rule({ disposition: 'prohibited', effective_at: '2026-12-31T23:59:60Z' }),
    ]);
    const expires = profile('unsupported_expiry', [
      rule({ disposition: 'prohibited', expires_at: '2026-12-31T23:59:60Z' }),
    ]);

    assert.strictEqual(assess([resolved(effective)]).outcome, 'unknown');
    assert.strictEqual(assess([resolved(expires)]).outcome, 'unknown');
  });

  it('matches every declared rule dimension and rejects each independent mismatch', () => {
    const matching = profile('matching', [
      rule({
        subject_facets: ['candidate_or_party'],
        advertiser_roles: ['political_actor'],
        jurisdictions: ['US'],
        disposition: 'prohibited',
      }),
    ]);
    assert.strictEqual(assess([resolved(matching)]).outcome, 'prohibited');

    const mismatches = [
      { name: 'facet', rule: { subject_facets: ['issue_advocacy'] } },
      { name: 'role', rule: { advertiser_roles: ['election_authority'] } },
      { name: 'jurisdiction', rule: { jurisdictions: ['CA'] } },
      { name: 'surface', rule: { applies_to: ['creative'] } },
    ];
    for (const mismatch of mismatches) {
      const value = profile(`other_${mismatch.name}`, [rule({ ...mismatch.rule, disposition: 'prohibited' })], {
        scope: {
          subject_categories: ['political_advertising'],
          applies_to: ['media_buy', 'creative'],
          all_jurisdictions: true,
        },
      });
      const result = assess([resolved(value)]);
      assert.strictEqual(result.outcome, 'allowed', mismatch.name);
      assert.deepStrictEqual(result.matchingRuleIds, [], mismatch.name);
    }
  });

  it('retains unresolved uncertainty but lets a verified prohibition win', () => {
    const value = profile('resolved', [rule({ disposition: 'prohibited' })]);
    const result = assess([resolved(value), { source: 'catalog', resolution: 'missing', profileId: 'missing' }]);

    assert.strictEqual(result.outcome, 'prohibited');
    assert.deepStrictEqual(result.profileIds, ['resolved']);
    assert.deepStrictEqual(result.matchingRuleIds, ['rule']);
    assert.deepStrictEqual(result.diagnostics, [{ code: 'profile_unresolved', profileId: 'missing' }]);
  });

  it('returns unknown for an unresolved profile when no known prohibition applies', () => {
    const value = profile('resolved', [rule()]);
    const result = assess([resolved(value), { source: 'catalog', resolution: 'missing', profileId: 'missing' }]);

    assert.strictEqual(result.outcome, 'unknown');
    assert.deepStrictEqual(result.matchingRuleIds, ['rule']);
  });

  it('uses definite mismatches even when another rule dimension is omitted', () => {
    const value = profile('scoped', [
      rule({ advertiser_roles: ['political_actor'], jurisdictions: ['CA'], disposition: 'prohibited' }),
    ]);
    const result = assess([resolved(value)], {
      acceptanceContext: context({ advertiser_roles: undefined, delivery_jurisdictions: ['US'] }),
    });

    assert.strictEqual(result.outcome, 'allowed');
    assert.deepStrictEqual(result.matchingRuleIds, []);
    assert.deepStrictEqual(result.diagnostics, []);
  });

  it('preserves unknown when subjects are omitted entirely', () => {
    const value = profile('subject', [rule({ subject_facets: ['candidate_or_party'], disposition: 'prohibited' })]);
    const result = assess([resolved(value)], {
      acceptanceContext: { advertiser_roles: ['political_actor'] },
    });

    assert.strictEqual(result.outcome, 'unknown');
    assert.deepStrictEqual(result.diagnostics, [
      { code: 'incomplete_context', profileId: 'subject' },
      { code: 'incomplete_context', profileId: 'subject', ruleId: 'rule' },
    ]);
  });

  it('fails closed on conflicting identities without dropping restrictive rules', () => {
    const allowed = resolved(profile('same', [rule({ rule_id: 'allowed' })]));
    const prohibited = resolved(
      profile('same', [rule({ rule_id: 'prohibited', disposition: 'prohibited' })], {
        version: '2',
        content_digest: `sha256:${'2'.repeat(64)}`,
      })
    );
    const result = assess([allowed, prohibited]);

    assert.strictEqual(result.outcome, 'prohibited');
    assert.deepStrictEqual(result.matchingRuleIds, ['allowed', 'prohibited']);
    assert.deepStrictEqual(result.diagnostics, [{ code: 'profile_conflict', profileId: 'same' }]);
  });

  it('classifies funding restrictions as requiring review', () => {
    const value = profile('funding', [
      rule({
        disposition: 'conditional',
        requirements: [{ kind: 'funding_restriction', criteria: ['no_foreign_funding'] }],
      }),
    ]);

    assert.strictEqual(assess([resolved(value)]).outcome, 'requires_review');
  });

  it('never discards requirements attached to a matching allowed rule', () => {
    const value = profile('allowed_requirement', [
      rule({ disposition: 'allowed', requirements: [{ kind: 'disclosure', format: 'paid_for_by' }] }),
    ]);
    const result = assess([resolved(value)]);

    assert.strictEqual(result.outcome, 'requires_disclosure');
    assert.deepStrictEqual(result.requirements, [{ kind: 'disclosure', format: 'paid_for_by' }]);
    assert.deepStrictEqual(result.matchedRules[0].requirements, [{ kind: 'disclosure', format: 'paid_for_by' }]);
  });

  it('fails closed on unknown jurisdiction groups at the evaluator boundary', () => {
    const value = profile('invalid_alias', [rule({ jurisdiction_groups: ['UNKNOWN'], disposition: 'prohibited' })]);
    const result = assess([resolved(value)]);

    assert.strictEqual(result.outcome, 'unknown');
    assert.deepStrictEqual(result.matchingRuleIds, []);
    assert.deepStrictEqual(result.diagnostics, [{ code: 'invalid_profile', profileId: 'invalid_alias' }]);
  });

  it('rejects requirement kinds unknown to the selected schema', () => {
    const value = profile('future', [
      rule({ disposition: 'conditional', requirements: [{ kind: 'future_escrow_requirement' }] }),
    ]);

    const result = assess([resolved(value)]);
    assert.strictEqual(result.outcome, 'unknown');
    assert.deepStrictEqual(result.diagnostics, [{ code: 'invalid_profile', profileId: 'future' }]);
  });

  it('validates context and evaluation time without throwing', () => {
    const profiles = [resolved(profile('default', [rule()]))];
    const invalidContext = assess(profiles, { acceptanceContext: { subjects: [] } });
    const nullContext = assess(profiles, { acceptanceContext: null });
    const omittedContext = assessAcceptancePolicy({ profiles, appliesTo: 'media_buy' });
    const invalidTime = assess(profiles, { evaluatedAt: 'not-a-date' });

    assert.strictEqual(invalidContext.outcome, 'unknown');
    assert.deepStrictEqual(invalidContext.diagnostics, [{ code: 'invalid_context' }]);
    assert.deepStrictEqual(nullContext.diagnostics, [{ code: 'invalid_context' }]);
    assert.deepStrictEqual(omittedContext.diagnostics, [{ code: 'invalid_context' }]);
    assert.strictEqual(invalidTime.outcome, 'unknown');
    assert.deepStrictEqual(invalidTime.diagnostics, [{ code: 'invalid_evaluation_time' }]);
  });

  it('validates resolved profiles without throwing or trusting malformed enums', () => {
    const malformed = value => ({ source: 'seller', resolution: 'resolved', profileId: 'bad', profile: value });
    const values = [
      null,
      { ...profile('bad', [rule()]), coverage: 'Complete' },
      profile('bad', [rule({ disposition: 'Prohibited' })]),
      profile('bad', [rule({ applies_to: 'media_buy' })]),
      { ...profile('bad', [rule()]), rules: undefined },
    ];

    for (const value of values) {
      const result = assess([malformed(value)]);
      assert.strictEqual(result.outcome, 'unknown');
      assert.deepStrictEqual(result.diagnostics, [{ code: 'invalid_profile', profileId: 'bad' }]);
    }
  });

  it('fails closed without serializing malformed profile identity fields', () => {
    const malformedVersion = { ...profile('bad', [rule()]), version: 1n };
    const cyclicVersion = {};
    cyclicVersion.self = cyclicVersion;
    const cyclic = { ...profile('cycle', [rule()]), version: cyclicVersion };

    for (const values of [
      [{ source: 'seller', resolution: 'resolved', profileId: 'bad', profile: malformedVersion }],
      [
        { source: 'seller', resolution: 'resolved', profileId: 'cycle', profile: cyclic },
        { source: 'product', resolution: 'resolved', profileId: 'cycle', profile: cyclic },
      ],
    ]) {
      const result = assess(values);
      assert.strictEqual(result.outcome, 'unknown');
      assert.deepStrictEqual(result.diagnostics, [{ code: 'invalid_profile', profileId: values[0].profileId }]);
    }
  });

  it('rejects a resolution whose outer and embedded profile IDs differ', () => {
    const value = resolved(profile('embedded', [rule()]));
    value.profileId = 'outer';
    const result = assess([value]);

    assert.strictEqual(result.outcome, 'unknown');
    assert.deepStrictEqual(result.diagnostics, [{ code: 'invalid_profile', profileId: 'outer' }]);
  });

  it('bounds diagnostics from unresolved seller-controlled selections', () => {
    const profiles = Array.from({ length: 40 }, (_, index) => ({
      source: 'catalog',
      resolution: 'missing',
      profileId: `missing_${index}`,
    }));
    const result = assess(profiles);

    assert.strictEqual(result.outcome, 'unknown');
    assert.strictEqual(result.diagnostics.length, 32);
    assert.deepStrictEqual(result.diagnostics[0], { code: 'profile_unresolved', profileId: 'missing_0' });
  });

  it('fails closed before processing oversized profile selections', () => {
    const profiles = Array.from({ length: 1025 }, (_, index) => ({
      source: 'catalog',
      resolution: 'missing',
      profileId: `missing_${index}`,
    }));

    const result = assess(profiles);
    assert.strictEqual(result.outcome, 'unknown');
    assert.deepStrictEqual(result.diagnostics, [{ code: 'assessment_limit_exceeded' }]);
  });

  it('fails closed before validating an oversized rule selection', () => {
    const value = profile(
      'oversized',
      Array.from({ length: 10_001 }, () => rule())
    );

    const result = assess([resolved(value)]);
    assert.strictEqual(result.outcome, 'unknown');
    assert.deepStrictEqual(result.diagnostics, [{ code: 'assessment_limit_exceeded' }]);
  });

  it('counts an exact seller/product profile selection once against the rule budget', () => {
    const value = resolved(
      profile(
        'large_shared',
        Array.from({ length: 6000 }, (_, index) => rule({ rule_id: `rule_${index}`, disposition: 'prohibited' }))
      )
    );

    const result = assess([value, value]);
    assert.strictEqual(result.outcome, 'prohibited');
    assert.deepStrictEqual(result.diagnostics, []);
    assert.strictEqual(result.matchingRuleIds.length, 6000);
  });

  it('fails closed on oversized nested requirement content before cloning', () => {
    const value = profile('oversized_requirement', [
      rule({
        disposition: 'conditional',
        requirements: [{ kind: 'custom', id: 'manual', description: 'x'.repeat(1024 * 1024) }],
      }),
    ]);

    const result = assess([resolved(value)]);
    assert.strictEqual(result.outcome, 'unknown');
    assert.deepStrictEqual(result.diagnostics, [{ code: 'assessment_limit_exceeded' }]);
  });

  it('rejects a wide nested array before enqueueing its elements', () => {
    const value = profile('wide', [rule()]);
    value.extension = Array(100_001).fill(null);

    const result = assess([resolved(value)]);
    assert.strictEqual(result.outcome, 'unknown');
    assert.deepStrictEqual(result.diagnostics, [{ code: 'assessment_limit_exceeded' }]);
  });

  it('bounds acceptance-context complexity before schema validation', () => {
    const acceptanceContext = context();
    acceptanceContext.extension = Array(100_001).fill(null);

    const result = assess([resolved(profile('default', [rule()]))], { acceptanceContext });
    assert.strictEqual(result.outcome, 'unknown');
    assert.deepStrictEqual(result.diagnostics, [{ code: 'assessment_limit_exceeded' }]);
  });

  it('bounds context membership values before repeated rule matching', () => {
    const acceptanceContext = context({
      advertiser_roles: Array.from({ length: 4097 }, (_, index) => `role_${index}`),
    });

    const result = assess([resolved(profile('default', [rule()]))], { acceptanceContext });
    assert.strictEqual(result.outcome, 'unknown');
    assert.deepStrictEqual(result.diagnostics, [{ code: 'assessment_limit_exceeded' }]);
  });

  it('deep-clones returned requirements away from cached profile input', () => {
    const requirement = { kind: 'advertiser_eligibility', criteria: ['domestic_entity'] };
    const value = profile('detached', [rule({ disposition: 'conditional', requirements: [requirement] })]);
    const result = assess([resolved(value)]);

    result.requirements[0].criteria.push('mutated');
    result.matchedRules[0].requirements[0].criteria.push('also_mutated');
    assert.deepStrictEqual(requirement.criteria, ['domestic_entity']);
  });

  it('deduplicates a profile selected by both seller default and product', () => {
    const value = resolved(profile('shared', [rule()]));
    const result = assess([value, value]);

    assert.strictEqual(result.outcome, 'allowed');
    assert.deepStrictEqual(result.profileIds, ['shared']);
    assert.deepStrictEqual(result.matchingRuleIds, ['rule']);
  });
});
