const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getAssertion } = require('../../dist/lib/testing/storyboard/assertions');
const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner');
const { registerDefaultInvariants } = require('../../dist/lib/testing/storyboard/default-invariants');

registerDefaultInvariants();
const invariant = getAssertion('discovery.pricing_currency_filter');
const context = { storyboard: {}, agentUrl: 'https://seller.example/mcp', options: {}, state: {} };
const media = currency => ({ pricing_option_id: `media-${currency}`, pricing_model: 'cpm', floor_price: 8, currency });
const cpm = (currency, amount = 1) => ({
  pricing_option_id: `signal-${currency}`,
  model: 'cpm',
  cpm: amount,
  currency,
});
const signal = (prices, extras = {}) => ({
  signal_ref: { scope: 'product', signal_id: 'affinity' },
  default_selected: true,
  ...(prices === undefined ? {} : { pricing_options: prices }),
  ...extras,
});
const product = extras => ({ product_id: 'seller-product', pricing_options: [media('USD')], ...extras });
const step = (products, extras = {}) => ({
  step_id: 'filtered-products',
  task: 'get_products',
  passed: true,
  request: { payload: { filters: { pricing_currencies: ['USD'] } } },
  response: { products },
  ...extras,
});
const check = products => invariant.onStep(context, step(products));
const mandatory = (signals, rules = {}) =>
  product({
    signal_targeting_rules: { selection_mode: 'fixed', ...rules },
    signal_targeting_options: signals,
  });
const failures = results => results.filter(result => !result.passed);

test('the pricing filter invariant is registered by default', () => {
  assert.equal(invariant.default, true);
});

test('every price on every product is constrained; option IDs and ordering are irrelevant', () => {
  assert.equal(
    failures(
      check([
        product({ pricing_options: [media('USD'), { ...media('USD'), pricing_option_id: 'alternate' }] }),
        product({ product_id: 'second' }),
      ])
    ).length,
    0
  );
  const optionFailure = failures(check([product({ pricing_options: [media('USD'), media('EUR')] })]));
  assert.equal(optionFailure.length, 1);
  assert.match(optionFailure[0].error, /products\[0\]\.pricing_options\[1\]\.currency/);
  assert.equal(failures(check([product(), product({ pricing_options: [media('EUR')] })])).length, 1);
});

test('multiple accepted currencies are alternatives and empty matches remain valid', () => {
  const multiple = step([product({ pricing_options: [media('USD'), media('EUR')] })], {
    request: { payload: { filters: { pricing_currencies: ['USD', 'EUR'] } } },
  });
  assert.equal(failures(invariant.onStep(context, multiple)).length, 0);
  const empty = check([]);
  assert.equal(failures(empty).length, 0);
  assert.equal(empty[0].status, 'not_applicable');
  assert.match(empty[0].description, /positive media-pricing coverage is unproven/);
});

test('optional, removable defaults, and unselected fixed options do not gate media currency', () => {
  for (const rules of [{}, { selection_mode: 'optional' }]) {
    assert.equal(
      failures(
        check([
          product({
            signal_targeting_rules: rules,
            signal_targeting_options: [signal([cpm('EUR')])],
          }),
        ])
      ).length,
      0
    );
  }
  assert.equal(failures(check([mandatory([signal([cpm('EUR')], { default_selected: false })])])).length, 0);
});

test('every compulsory signal must have a compatible alternative on the same product', () => {
  assert.equal(failures(check([mandatory([signal([cpm('EUR')])])])).length, 1);
  assert.equal(failures(check([mandatory([signal([cpm('EUR'), cpm('USD')])])])).length, 0);
  assert.equal(failures(check([mandatory([signal([cpm('USD')]), signal([cpm('EUR')])])])).length, 1);
  assert.equal(failures(check([product(), mandatory([signal([cpm('EUR')])])])).length, 1);
});

test('effective FX conversion of media and mandatory charges is valid', () => {
  const converted = mandatory([signal([cpm('EUR')])]);
  converted.pricing_options = [media('EUR')];
  assert.equal(
    failures(
      invariant.onStep(
        context,
        step([converted], {
          request: { payload: { filters: { pricing_currencies: ['EUR'] } } },
        })
      )
    ).length,
    0
  );
  assert.equal(failures(check([mandatory([signal([cpm('USD')])])])).length, 0);
});

for (const price of [
  cpm('EUR', 0),
  { model: 'flat_fee', amount: 0, currency: 'EUR' },
  { model: 'per_unit', unit_price: 0, currency: 'EUR' },
  { model: 'percent_of_media', percent: 0, currency: 'EUR' },
  { model: 'percent_of_media', percent: 10, max_cpm: 0, currency: 'EUR' },
]) {
  test(`zero incremental ${price.model} charge is compatible regardless of currency`, () => {
    assert.equal(failures(check([mandatory([signal([price])])])).length, 0);
  });
}

for (const price of [
  cpm('EUR'),
  { model: 'flat_fee', amount: 10, currency: 'EUR' },
  { model: 'per_unit', unit_price: 1, currency: 'EUR' },
  { model: 'percent_of_media', percent: 10, currency: 'EUR' },
]) {
  test(`positive compulsory ${price.model} charge in an unavailable currency fails`, () => {
    assert.equal(failures(check([mandatory([signal([price])])])).length, 1);
  });
}

test('bundled signals are free; custom/no-currency is reported as unproven', () => {
  assert.equal(failures(check([mandatory([signal(undefined)])])).length, 0);
  const custom = { model: 'custom', description: 'Seller-specific charge', metadata: { policy: 'seller-defined' } };
  const findings = check([mandatory([signal([custom])])]);
  assert.equal(failures(findings).length, 0);
  assert.ok(findings.some(result => result.status === 'not_applicable' && result.description.includes('unproven')));
  assert.equal(
    failures(check([mandatory([signal([custom]), signal([cpm('EUR')])])])).length,
    1,
    'an unproven custom price cannot conceal a separate known compulsory EUR charge'
  );
});

test('per-group fixed obligations apply, and an optional override removes a global fixed default', () => {
  const groupSignals = [signal([cpm('EUR')], { selection_group: 'affinity' })];
  assert.equal(
    failures(
      check([
        mandatory(groupSignals, {
          selection_mode: 'optional',
          selection_group_rules: [{ selection_group: 'affinity', selection_mode: 'fixed' }],
        }),
      ])
    ).length,
    1
  );
  assert.equal(
    failures(
      check([
        mandatory(groupSignals, {
          selection_group_rules: [{ selection_group: 'affinity', selection_mode: 'optional' }],
        }),
      ])
    ).length,
    0
  );
  assert.equal(
    failures(
      check([
        mandatory(groupSignals, {
          selection_mode: 'optional',
          selection_group_rules: [{ selection_group: 'affinity', selection_mode: 'fixed', targeting_mode: 'exclude' }],
        }),
      ])
    ).length,
    0,
    'include-only options are not forced by an exclude-only group rule'
  );
});

test('required choices must offer enough compatible alternatives; optional choices stay exempt', () => {
  assert.equal(failures(check([mandatory([signal([cpm('EUR')])], { selection_mode: 'required' })])).length, 1);
  assert.equal(
    failures(check([mandatory([signal([cpm('EUR')]), signal([cpm('USD')])], { selection_mode: 'required' })])).length,
    0
  );
  assert.equal(
    failures(
      check([
        mandatory([signal([cpm('EUR')]), signal([cpm('USD')])], {
          selection_mode: 'required',
          min_selected_signals: 2,
        }),
      ])
    ).length,
    1
  );
  const grouped = mandatory(
    [signal([cpm('USD')], { selection_group: 'optional' }), signal([cpm('EUR')], { selection_group: 'required' })],
    {
      selection_mode: 'optional',
      selection_group_rules: [
        { selection_group: 'optional', selection_mode: 'optional' },
        { selection_group: 'required', selection_mode: 'required' },
      ],
    }
  );
  const result = failures(check([grouped]));
  assert.equal(result.length, 1);
  assert.match(result[0].error, /selection_group_rules\[1\]/);
});

test('group rules inherit required selection mode and mixed aggregate feasibility stays explicit', () => {
  const grouped = mandatory([signal([cpm('EUR')], { selection_group: 'audience' })], {
    selection_mode: 'required',
    selection_group_rules: [{ selection_group: 'audience' }],
  });
  const findings = check([grouped]);
  assert.equal(failures(findings).length, 1, 'an inherited required group cannot leak a known EUR-only obligation');
  assert.ok(findings.some(result => result.status === 'not_applicable' && result.description.includes('aggregate')));
});

test('required selection respects same-group capacity instead of counting unavailable combinations', () => {
  const grouped = mandatory(
    [
      signal([cpm('USD')], { selection_group: 'same' }),
      signal([cpm('USD')], { selection_group: 'same' }),
      signal([cpm('EUR')], { selection_group: 'other' }),
    ],
    { selection_mode: 'required', min_selected_signals: 2, max_selected_per_group: 1 }
  );
  assert.equal(failures(check([grouped])).length, 1);
  grouped.signal_targeting_options[2].pricing_options = [cpm('USD')];
  assert.equal(failures(check([grouped])).length, 0);
});

test('an omitted mandatory inline menu is explicitly unproven', () => {
  const findings = check([product({ signal_targeting_rules: { selection_mode: 'required' } })]);
  assert.equal(failures(findings).length, 0);
  assert.ok(findings.some(result => result.status === 'not_applicable' && result.description.includes('inline menu')));
});

test('a group selection limit cannot widen the product selection limit', () => {
  const grouped = mandatory(
    Array.from({ length: 3 }, () => signal([cpm('USD')], { selection_group: 'audience' })),
    {
      selection_mode: 'optional',
      max_selected_signals: 2,
      selection_group_rules: [
        { selection_group: 'audience', selection_mode: 'required', min_selected_signals: 3, max_selected_signals: 5 },
      ],
    }
  );
  assert.equal(failures(check([grouped])).length, 1);
});

test('missing inline menus, projected prices, errors and unrelated calls are not invented failures', () => {
  assert.deepEqual(invariant.onStep(context, step([product()], { skipped: true })), []);
  assert.deepEqual(invariant.onStep(context, step([product()], { task: 'get_signals' })), []);
  assert.deepEqual(invariant.onStep(context, step([product()], { request: { payload: {} } })), []);
  assert.deepEqual(invariant.onStep(context, step([], { response: { errors: [{ code: 'INVALID_REQUEST' }] } })), []);
  assert.equal(
    failures(
      check([
        product({
          pricing_options: undefined,
          signal_targeting_rules: { selection_mode: 'required' },
        }),
      ])
    ).length,
    0
  );
  const withAdvisory = step([product()], { response: { products: [product()], errors: [{ code: 'STALE_RESPONSE' }] } });
  assert.ok(
    invariant.onStep(context, withAdvisory).length > 0,
    'success payloads with advisory errors are still checked'
  );
});

test('the default invariant gates real storyboard results without authored currency validations', async () => {
  const storyboard = {
    id: 'pricing-filter-integration',
    version: '1.0.0',
    title: 'Currency filter',
    category: 'test',
    summary: '',
    narrative: '',
    phases: [
      {
        id: 'discovery',
        title: 'Discovery',
        steps: [
          {
            id: 'filtered',
            title: 'Filtered products',
            task: 'get_products',
            sample_request: {
              buying_mode: 'brief',
              brief: 'Display inventory',
              filters: { pricing_currencies: ['USD'] },
            },
            validations: [{ check: 'field_present', path: 'products' }],
          },
        ],
      },
    ],
  };
  for (const price of [cpm('USD'), cpm('EUR'), undefined]) {
    const result = await runStoryboard('https://seller.example/mcp', storyboard, {
      agentTools: ['get_products'],
      _profile: { tools: ['get_products'] },
      _client: {
        resetContext() {},
        async getProducts() {
          return { success: true, data: { products: price ? [mandatory([signal([price])])] : [] } };
        },
      },
    });
    assert.equal(result.overall_passed, price?.currency !== 'EUR', JSON.stringify(result.assertions));
    assert.ok(result.assertions.some(finding => finding.assertion_id === invariant.id));
    if (price === undefined) {
      assert.ok(
        result.assertions.some(finding => finding.assertion_id === invariant.id && finding.status === 'not_applicable')
      );
    }
  }
});
