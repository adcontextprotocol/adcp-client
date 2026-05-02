// Tests for the curated `hint` field on ValidationIssue (issue #1309).
// Each rule in `src/lib/validation/hints.ts` gets at least one positive
// case (hint fires when the matching shape appears) and the table-level
// invariant — issues that don't match any rule have `hint: undefined`.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { validateRequest, validateResponse } = require('../../dist/lib/validation');
const { findHint, _hintRuleCount } = require('../../dist/lib/validation/hints.js');
const { buildAdcpValidationErrorPayload } = require('../../dist/lib/validation/schema-errors.js');

describe('curated validation hints (issue #1309)', () => {
  test('activation_key type=key_value missing key fires the hint', () => {
    const outcome = validateResponse('activate_signal', {
      deployments: [
        {
          type: 'platform',
          platform: 'dsp1',
          is_live: true,
          activation_key: { type: 'key_value' },
        },
      ],
    });
    const leaf = outcome.issues.find(i => i.pointer === '/deployments/0/activation_key/key');
    assert.ok(leaf, `expected the missing-key issue, got: ${JSON.stringify(outcome.issues)}`);
    assert.match(leaf.hint ?? '', /top-level `key` and `value` strings/);
    assert.match(leaf.hint ?? '', /do not nest under a `key_value` field/);
  });

  test('activation_key type=key_value missing value fires the same hint', () => {
    const outcome = validateResponse('activate_signal', {
      deployments: [
        {
          type: 'platform',
          platform: 'dsp1',
          is_live: true,
          activation_key: { type: 'key_value' },
        },
      ],
    });
    const valueIssue = outcome.issues.find(i => i.pointer === '/deployments/0/activation_key/value');
    assert.ok(valueIssue, 'expected the missing-value issue');
    assert.match(valueIssue.hint ?? '', /top-level `key` and `value` strings/);
  });

  test('activation_key type=segment_id missing segment_id fires its hint', () => {
    // Synthetic issue — the schema-driven path produces this exact
    // pointer + discriminator pair, but it requires a payload that
    // matches the segment_id branch's discriminator without supplying
    // segment_id (rare in practice). Direct findHint() call proves
    // the rule wires correctly.
    const hint = findHint(
      {
        pointer: '/deployments/0/activation_key/segment_id',
        message: "must have required property 'segment_id'",
        keyword: 'required',
        schemaPath: '#/.../activation_key/oneOf/0/required',
        discriminator: [{ field: 'type', value: 'segment_id' }],
      },
      'activate_signal'
    );
    assert.match(hint ?? '', /top-level `segment_id` string/);
  });

  test('missing idempotency_key fires the mutating-tools hint', () => {
    const outcome = validateRequest('create_media_buy', {
      account: { account_id: 'acme' },
      brand: { domain: 'acme.com' },
      start_time: '2026-05-01T00:00:00Z',
      end_time: '2026-05-31T23:59:59Z',
      packages: [{ buyer_ref: 'p1', product_id: 'p1', budget: 10, pricing_option_id: 'po1' }],
    });
    const issue = outcome.issues.find(i => i.pointer === '/idempotency_key');
    assert.ok(issue, 'expected /idempotency_key issue');
    assert.match(issue.hint ?? '', /Mutating tools require `idempotency_key`/);
    assert.match(issue.hint ?? '', /reuse the same value on retries/);
  });

  test('account discriminator merging fires the pick-one-variant hint', () => {
    const outcome = validateRequest('create_media_buy', {
      idempotency_key: '00000000-0000-0000-0000-000000000000',
      account: { account_id: 'acme', brand: { domain: 'x' }, operator: 'op' },
      brand: { domain: 'acme.com' },
      start_time: '2026-05-01T00:00:00Z',
      end_time: '2026-05-31T23:59:59Z',
      packages: [{ buyer_ref: 'p1', product_id: 'p1', budget: 10, pricing_option_id: 'po1' }],
    });
    const additional = outcome.issues.find(i => i.pointer === '/account' && i.keyword === 'additionalProperties');
    assert.ok(additional, `expected additionalProperties at /account, got: ${JSON.stringify(outcome.issues)}`);
    assert.match(additional.hint ?? '', /discriminated union/);
    assert.match(additional.hint ?? '', /Pick ONE variant/);
  });

  test('budget as object fires the number-not-object hint', () => {
    const outcome = validateRequest('create_media_buy', {
      idempotency_key: '00000000-0000-0000-0000-000000000000',
      account: { account_id: 'acme' },
      brand: { domain: 'acme.com' },
      start_time: '2026-05-01T00:00:00Z',
      end_time: '2026-05-31T23:59:59Z',
      packages: [
        { buyer_ref: 'p1', product_id: 'p1', budget: { amount: 10, currency: 'USD' }, pricing_option_id: 'po1' },
      ],
    });
    const issue = outcome.issues.find(i => i.pointer === '/packages/0/budget');
    assert.ok(issue, 'expected budget type issue');
    assert.match(issue.hint ?? '', /budget` is a number, not an object/);
    assert.match(issue.hint ?? '', /Currency comes from the referenced `pricing_option`/);
  });

  test('brand missing domain fires the domain-not-brand_id hint', () => {
    const outcome = validateRequest('create_media_buy', {
      idempotency_key: '00000000-0000-0000-0000-000000000000',
      account: { account_id: 'acme' },
      brand: { brand_id: 'acme-corp' },
      start_time: '2026-05-01T00:00:00Z',
      end_time: '2026-05-31T23:59:59Z',
      packages: [{ buyer_ref: 'p1', product_id: 'p1', budget: 10, pricing_option_id: 'po1' }],
    });
    const issue = outcome.issues.find(i => i.pointer === '/brand/domain' && i.keyword === 'required');
    assert.ok(issue, `expected /brand/domain required issue, got: ${JSON.stringify(outcome.issues)}`);
    assert.match(issue.hint ?? '', /uses `domain` \(not `brand_id`\)/);
  });

  test('format_id as string fires the object-shape hint', () => {
    const outcome = validateRequest('build_creative', {
      idempotency_key: '00000000-0000-0000-0000-000000000000',
      creative_manifest: { format_id: 'video_1920x1080', assets: [] },
    });
    const issue = outcome.issues.find(i => i.pointer === '/creative_manifest/format_id' && i.keyword === 'type');
    assert.ok(issue, 'expected format_id type issue');
    assert.match(issue.hint ?? '', /format_id` is an object/);
    assert.match(issue.hint ?? '', /agent_url, id/);
  });

  test('signal_ids as bare strings fires the provenance-objects hint', () => {
    const outcome = validateRequest('get_signals', {
      signal_ids: ['cohort_abc', 'cohort_xyz'],
    });
    const issue = outcome.issues.find(i => i.pointer === '/signal_ids/0' && i.keyword === 'type');
    assert.ok(issue, 'expected /signal_ids/0 type issue');
    assert.match(issue.hint ?? '', /array of provenance objects/);
    assert.match(issue.hint ?? '', /Bare ID strings are rejected/);
  });

  test('VAST asset missing delivery_type fires the inline-vs-redirect hint', () => {
    // Synthetic — the issue path the rule matches happens deep inside
    // sync_creatives' nested asset oneOf cascade. Direct findHint()
    // call covers the wiring without building a 200-line valid creative
    // payload that gates on this single field.
    const hint = findHint(
      {
        pointer: '/creatives/0/assets/0/delivery_type',
        message: "must have required property 'delivery_type'",
        keyword: 'required',
        schemaPath: '#/.../assets/oneOf/2/required',
        discriminator: [{ field: 'asset_type', value: 'vast' }],
      },
      'sync_creatives'
    );
    assert.match(hint ?? '', /VAST assets require `delivery_type/);
    assert.match(hint ?? '', /inline.*content/);
  });

  test('issues outside the curated table have no hint', () => {
    // Regression: an unrelated `additionalProperties` failure shouldn't
    // accidentally pick up the `account` rule (or any rule). The
    // matcher's specificity gates protect this.
    const outcome = validateRequest('create_property_list', {
      idempotency_key: '00000000-0000-0000-0000-000000000000',
      name: 'Test',
      unknown_field: { should: 'reject' },
    });
    for (const issue of outcome.issues) {
      assert.strictEqual(issue.hint, undefined, `unrelated issue picked up a hint: ${issue.pointer} → ${issue.hint}`);
    }
  });

  test('hints ride the wire envelope by default and ride into prose', () => {
    const issues = [
      {
        pointer: '/idempotency_key',
        message: "must have required property 'idempotency_key'",
        keyword: 'required',
        schemaPath: '#/required',
        hint: 'Mutating tools require `idempotency_key`...',
      },
    ];
    const payload = buildAdcpValidationErrorPayload('create_media_buy', 'request', issues);
    assert.strictEqual(payload.issues[0].hint, 'Mutating tools require `idempotency_key`...');
    assert.match(payload.message, /hint: Mutating tools require `idempotency_key`/);
  });

  test('hint rule count is non-zero (regression guard for rule loading)', () => {
    // If the rule table imports break (e.g. a future TS bundling tweak),
    // the count drops to zero and every hint silently disappears.
    assert.ok(
      _hintRuleCount > 5,
      `expected at least 5 curated rules, got ${_hintRuleCount} — rule table may have failed to load`
    );
  });

  test('regression: nested activation_key under `key_value` still gets the flatness hint', () => {
    // The DX expert flagged this as a possible gap — adopters who write
    // `{type: 'key_value', key_value: {key, value}}` (the EXACT mistake
    // #1283 warns about). The schema declares `additionalProperties: true`
    // on each variant, so the extra `key_value` field is allowed and the
    // missing top-level `key`/`value` produce the standard `required`
    // errors my hint catches. Lock that in.
    const outcome = validateResponse('activate_signal', {
      deployments: [
        {
          type: 'platform',
          platform: 'dsp1',
          is_live: true,
          activation_key: { type: 'key_value', key_value: { key: 'x', value: 'y' } },
        },
      ],
    });
    const leaf = outcome.issues.find(
      i => i.pointer === '/deployments/0/activation_key/key' && i.keyword === 'required'
    );
    assert.ok(leaf, `expected the flatness hint to fire on nested case, got: ${JSON.stringify(outcome.issues)}`);
    assert.match(leaf.hint ?? '', /do not nest under a `key_value` field/);
  });

  test("regression: a synthetic issue outside every rule's shape returns undefined", () => {
    // Two-pronged guard:
    //   (a) catches a contributor accidentally appending a wildcard rule
    //       (no conditions = matches everything).
    //   (b) catches a future change to `findHint` that defaults to a
    //       non-undefined fallback.
    // The synthetic issue uses a pointer + keyword + tool combo no
    // shipped rule cares about. If `findHint` ever returns a string
    // here, something has gone wrong.
    const cleanIssue = {
      pointer: '/zzz_unrelated_field_no_rule_matches',
      message: 'must be at least 8 characters',
      keyword: 'minLength',
      schemaPath: '#/zzz/minLength',
    };
    assert.strictEqual(
      findHint(cleanIssue, 'zzz_unrelated_tool'),
      undefined,
      'a no-condition rule would catch every issue and break the no-hint contract'
    );
  });
});
