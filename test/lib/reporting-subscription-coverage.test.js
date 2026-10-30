const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const path = require('node:path');
const consumer = require('@adcp/sdk/reporting/consumer');
const ledger = require('@adcp/sdk/reporting/ledger');

const {
  createReportingPeriodCalendarV1,
  expectedSubscriptionPeriods,
  groupExpectedSubscriptionPeriodsV1,
  resolveReportingSubscriptionOfferingsV1,
  reportingSubscriptionScopeIncludesV1,
} = consumer;

// The JSON table is the cross-SDK parity contract (adcp-client-python mirrors it).
const table = require(path.join(__dirname, '..', 'fixtures', 'reporting-subscriptions', 'coverage-cases.json'));

const instant = value => Date.parse(value);
const iso = value => new Date(value).toISOString();

function comparable(rows) {
  return rows.map(row => ({
    subscription_version: row.subscription_version,
    media_buy_id: row.media_buy_id,
    offering_id: row.offering_id,
    period_start: instant(row.period_start),
    period_end: instant(row.period_end),
  }));
}

describe('expectedSubscriptionPeriods parity table', () => {
  test('the table is non-trivial and every case is uniquely named', () => {
    assert.ok(table.cases.length >= 75);
    assert.equal(new Set(table.cases.map(c => c.name)).size, table.cases.length);
  });

  for (const testCase of table.cases) {
    test(testCase.name, () => {
      const input = structuredClone(testCase.input);
      if (testCase.expected_error) {
        assert.throws(
          () => expectedSubscriptionPeriods(input),
          error => error.name === testCase.expected_error
        );
        return;
      }
      const actual = expectedSubscriptionPeriods(input);
      assert.deepEqual(comparable(actual), comparable(testCase.expected), testCase.rule);
      const offerings = new Map(input.offerings.map(offering => [offering.offering_id, offering]));
      for (const row of actual) {
        assert.equal(row.subscription_id, input.subscription_id);
        assert.equal(row.account_id, input.account.account_id);
        assert.equal(row.report_definition_id, offerings.get(row.offering_id).report_definition_id);
        assert.equal(row.period_start, iso(instant(row.period_start)), 'emits canonical toISOString form');
      }
      assert.ok(testCase.expected_obligations, 'every case states its obligations');
      if (testCase.expected_obligations) {
        const grouped = groupExpectedSubscriptionPeriodsV1(actual).map(group => ({
          subscription_version: group.subscription_version,
          offering_id: group.offering_id,
          period_start: instant(group.period_start),
          period_end: instant(group.period_end),
          media_buy_ids: group.media_buy_ids,
        }));
        assert.deepEqual(
          grouped,
          testCase.expected_obligations.map(group => ({
            ...group,
            period_start: instant(group.period_start),
            period_end: instant(group.period_end),
          }))
        );
      }
    });
  }

  test('every subscription in the table is schema-valid', () => {
    // Validate against the bundle the SDK pins (ADCP_VERSION).
    const Ajv = require('ajv');
    const addFormats = require('ajv-formats');
    const fs = require('node:fs');
    const pinned = fs.readFileSync(path.join(__dirname, '..', '..', 'ADCP_VERSION'), 'utf8').trim();
    const root = path.join(__dirname, '..', '..', 'schemas', 'cache', pinned);
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    for (const dir of ['core', 'enums']) {
      for (const file of fs.readdirSync(path.join(root, dir))) {
        if (!file.endsWith('.json')) continue;
        const schema = JSON.parse(fs.readFileSync(path.join(root, dir, file), 'utf8'));
        // The dimension vocabulary is extensible (receivers MUST accept unknown values), as the SDK validates it.
        if (file === 'reporting-dimension.json') {
          delete schema.enum;
          schema.pattern = schema['x-pattern'];
        }
        ajv.addSchema(schema);
      }
    }
    const validate = ajv.getSchema(
      `https://adcontextprotocol.org/schemas/${pinned}/core/reporting-subscription.json`
    );
    for (const testCase of table.cases) {
      for (const version of testCase.input.versions) {
        assert.equal(validate(version.configuration), true, `${testCase.name}: ${JSON.stringify(validate.errors)}`);
      }
    }
  });

  test('the function is pure: inputs are not mutated and repeated calls agree', () => {
    for (const testCase of table.cases.filter(c => !c.expected_error)) {
      const input = structuredClone(testCase.input);
      const snapshot = structuredClone(input);
      const first = expectedSubscriptionPeriods(input);
      assert.deepEqual(input, snapshot, testCase.name);
      assert.deepEqual(expectedSubscriptionPeriods(input), first, testCase.name);
    }
  });

  test('ledger and consumer entry points export the same rule', () => {
    assert.equal(typeof ledger.expectedSubscriptionPeriods, 'function');
    const input = structuredClone(table.cases[0].input);
    assert.deepEqual(ledger.expectedSubscriptionPeriods(input), expectedSubscriptionPeriods(input));
  });
});

describe('expectedSubscriptionPeriods invariants', () => {
  const baseline = table.cases.find(c => c.name === 'baseline').input;

  test('exceptions only ever remove periods', () => {
    const owed = expectedSubscriptionPeriods(structuredClone(baseline));
    const windows = [
      { reason: 'capacity', from: '2026-11-03T00:00:00Z' },
      { reason: 'capacity', from: '2026-10-01T00:00:00Z', until: '2026-11-04T00:00:00Z' },
      { reason: 'overridden', from: '2026-11-04T12:00:00Z', overridden_by: { subscription_id: 'x' } },
      { reason: 'offering_unsupported', media_buy_id: 'mb_other', from: '2026-11-01T00:00:00Z' },
    ];
    for (const entry of windows) {
      const reduced = expectedSubscriptionPeriods({ ...structuredClone(baseline), coverage: { excluded: [entry] } });
      const keys = new Set(owed.map(row => JSON.stringify(row)));
      for (const row of reduced) assert.ok(keys.has(JSON.stringify(row)), 'an exception never adds a period');
      const removed = owed.filter(row => !reduced.some(other => JSON.stringify(other) === JSON.stringify(row)));
      for (const row of removed) {
        const start = instant(row.period_start);
        assert.ok(start >= instant(entry.from) && (entry.until === undefined || start < instant(entry.until)));
      }
    }
  });

  test('periods are contiguous, complete and never clipped across a long flight', () => {
    const input = structuredClone(baseline);
    input.buys[0].end_time = '2027-06-30T07:00:00Z';
    input.now = '2027-08-01T00:00:00Z';
    const owed = expectedSubscriptionPeriods(input);
    assert.equal(owed[0].period_start, '2026-11-03T00:00:00.000Z');
    assert.equal(owed.at(-1).period_start, '2027-06-30T00:00:00.000Z', 'the period containing the stop is owed');
    for (let index = 1; index < owed.length; index += 1) {
      assert.equal(owed[index].period_start, owed[index - 1].period_end);
      assert.equal(instant(owed[index].period_end) - instant(owed[index].period_start), 86_400_000);
    }
  });

  test('version cutovers never owe a period twice and leave no gap on aligned schedules', () => {
    const input = structuredClone(
      table.cases.find(c => c.name === 'new subscription version, aligned schedules').input
    );
    input.buys[0].end_time = '2026-11-20T00:00:00Z';
    const owed = expectedSubscriptionPeriods(input);
    const starts = owed.map(row => row.period_start);
    assert.equal(new Set(starts).size, starts.length);
    for (let index = 1; index < owed.length; index += 1)
      assert.equal(owed[index].period_start, owed[index - 1].period_end);
  });

  test('fails closed above max_periods', () => {
    const input = structuredClone(baseline);
    input.max_periods = 2;
    assert.throws(() => expectedSubscriptionPeriods(input), RangeError);
  });

  test('rejects malformed instants and mismatched version records', () => {
    assert.throws(() => expectedSubscriptionPeriods({ ...structuredClone(baseline), now: '2026-12-01' }), TypeError);
    const input = structuredClone(baseline);
    input.versions[0].configuration.subscription_version = 9;
    assert.throws(() => expectedSubscriptionPeriods(input), TypeError);
    const inactive = structuredClone(baseline);
    inactive.versions[0].configuration.active = false;
    assert.throws(() => expectedSubscriptionPeriods(inactive), /deactivated_at/);
    const destination = structuredClone(baseline);
    destination.versions[0].configuration.destination = { destination_id: 'd' };
    assert.throws(() => expectedSubscriptionPeriods(destination), /destination_method/);
  });
});

describe('createReportingPeriodCalendarV1 (period_generation)', () => {
  const boundaries = (calendar, from, count) => {
    const first = calendar.ceilOrdinal(instant(from));
    return Array.from({ length: count }, (_, index) => iso(calendar.boundary(first + index)));
  };

  test('utc origin is 1970-01-01T00:00:00Z', () => {
    const calendar = createReportingPeriodCalendarV1({ period_duration: 'P1D', alignment: 'utc' });
    assert.equal(calendar.boundary(0), 0);
    assert.equal(iso(calendar.boundary(1)), '1970-01-02T00:00:00.000Z');
    // P7D weeks count from the origin, a Thursday.
    const weeks = createReportingPeriodCalendarV1({ period_duration: 'P7D', alignment: 'utc' });
    assert.equal(iso(weeks.ceil(instant('2026-11-04T00:00:00Z'))), '2026-11-05T00:00:00.000Z');
  });

  test('account_timezone days follow civil midnights through DST', () => {
    const calendar = createReportingPeriodCalendarV1({
      period_duration: 'P1D',
      alignment: 'account_timezone',
      timezone: 'America/New_York',
    });
    assert.deepEqual(boundaries(calendar, '2026-03-07T05:00:00Z', 4), [
      '2026-03-07T05:00:00.000Z',
      '2026-03-08T05:00:00.000Z',
      '2026-03-09T04:00:00.000Z',
      '2026-03-10T04:00:00.000Z',
    ]);
    assert.deepEqual(boundaries(calendar, '2026-10-31T04:00:00Z', 3), [
      '2026-10-31T04:00:00.000Z',
      '2026-11-01T04:00:00.000Z',
      '2026-11-02T05:00:00.000Z',
    ]);
  });

  const walk = (calendar, from, count) => {
    let at = calendar.ceil(instant(from));
    const out = [iso(at)];
    for (let index = 0; index < count; index += 1) {
      at = calendar.next(at);
      out.push(iso(at));
    }
    return out;
  };

  test('hours are exact elapsed time under utc', () => {
    const calendar = createReportingPeriodCalendarV1({ period_duration: 'PT36H', alignment: 'utc' });
    assert.equal(
      calendar.next(calendar.ceil(instant('2026-03-07T05:00:00Z'))) - calendar.ceil(instant('2026-03-07T05:00:00Z')),
      129_600_000
    );
  });

  test('sub-daily local periods restart at each local midnight (adcp#8588)', () => {
    const local = (zone, duration = 'PT1H') =>
      createReportingPeriodCalendarV1({ period_duration: duration, alignment: 'account_timezone', timezone: zone });
    assert.deepEqual(walk(local('Asia/Singapore'), '2026-11-03T00:10:00Z', 1), [
      '2026-11-03T01:00:00.000Z',
      '2026-11-03T02:00:00.000Z',
    ]);
    assert.deepEqual(walk(local('Asia/Kathmandu'), '2026-11-03T00:00:00Z', 1), [
      '2026-11-03T00:15:00.000Z',
      '2026-11-03T01:15:00.000Z',
    ]);
    const fallBack = walk(local('America/New_York'), '2026-11-01T04:00:00Z', 25);
    assert.equal(fallBack.at(-1), '2026-11-02T05:00:00.000Z', 'a 25-hour day has 25 hourly periods');
    const springForward = walk(local('America/New_York'), '2026-03-08T05:00:00Z', 23);
    assert.equal(springForward.at(-1), '2026-03-09T04:00:00.000Z', 'a 23-hour day has 23 hourly periods');
    assert.deepEqual(walk(local('America/New_York', 'PT6H'), '2026-03-08T05:00:00Z', 4), [
      '2026-03-08T05:00:00.000Z',
      '2026-03-08T10:00:00.000Z',
      '2026-03-08T16:00:00.000Z',
      '2026-03-08T22:00:00.000Z',
      '2026-03-09T04:00:00.000Z',
    ]);
    assert.throws(() => local('UTC', 'PT7H'), /must divide 24 hours/);
    assert.throws(() => local('UTC', 'P1DT1H'), /mixes date and time/);
    assert.throws(() => local('UTC').boundary(0), /no ordinal addressing/);
  });

  test('a billing anchor inside a DST fold is interval zero itself', () => {
    const calendar = createReportingPeriodCalendarV1({
      period_duration: 'P1M',
      alignment: 'billing_cycle',
      timezone: 'America/New_York',
      period_anchor: '2026-11-01T06:30:00Z',
    });
    assert.equal(iso(calendar.boundary(0)), '2026-11-01T06:30:00.000Z');
    assert.equal(iso(calendar.ceil(instant('2026-11-01T06:30:00Z'))), '2026-11-01T06:30:00.000Z');
  });

  test('next skips a zero-length period', () => {
    const calendar = createReportingPeriodCalendarV1({
      period_duration: 'P1D',
      alignment: 'account_timezone',
      timezone: 'Pacific/Apia',
    });
    assert.deepEqual(walk(calendar, '2011-12-29T10:00:00Z', 2), [
      '2011-12-29T10:00:00.000Z',
      '2011-12-30T10:00:00.000Z',
      '2011-12-31T10:00:00.000Z',
    ]);
  });

  test('billing cycles clamp to month end without drifting the anchor day', () => {
    const calendar = createReportingPeriodCalendarV1({
      period_duration: 'P1M',
      alignment: 'billing_cycle',
      timezone: 'America/New_York',
      period_anchor: '2026-01-31T05:00:00Z',
    });
    assert.deepEqual(
      [0, 1, 2, 3].map(n => iso(calendar.boundary(n))),
      ['2026-01-31T05:00:00.000Z', '2026-02-28T05:00:00.000Z', '2026-03-31T04:00:00.000Z', '2026-04-30T04:00:00.000Z']
    );
    assert.equal(iso(calendar.boundary(-1)), '2025-12-31T05:00:00.000Z');
  });

  test('quarters and years', () => {
    const quarters = createReportingPeriodCalendarV1({ period_duration: 'P3M', alignment: 'utc' });
    assert.equal(iso(quarters.ceil(instant('2026-02-10T00:00:00Z'))), '2026-04-01T00:00:00.000Z');
    assert.equal(iso(quarters.floor(instant('2026-02-10T00:00:00Z'))), '2026-01-01T00:00:00.000Z');
    const years = createReportingPeriodCalendarV1({ period_duration: 'P1Y', alignment: 'utc' });
    assert.equal(iso(years.ceil(instant('2026-02-10T00:00:00Z'))), '2027-01-01T00:00:00.000Z');
  });

  test('a skipped civil date yields a zero-length period, which coverage never owes', () => {
    const calendar = createReportingPeriodCalendarV1({
      period_duration: 'P1D',
      alignment: 'account_timezone',
      timezone: 'Pacific/Apia',
    });
    const first = calendar.ceilOrdinal(instant('2011-12-29T00:00:00Z'));
    assert.deepEqual(
      [0, 1, 2, 3].map(n => iso(calendar.boundary(first + n))),
      ['2011-12-29T10:00:00.000Z', '2011-12-30T10:00:00.000Z', '2011-12-30T10:00:00.000Z', '2011-12-31T10:00:00.000Z']
    );
  });

  test('ceil and floor agree with boundaries', () => {
    const calendar = createReportingPeriodCalendarV1({ period_duration: 'PT15M', alignment: 'utc' });
    const on = instant('2026-11-03T10:15:00Z');
    assert.equal(calendar.ceil(on), on);
    assert.equal(calendar.floor(on), on);
    assert.equal(iso(calendar.ceil(on + 1)), '2026-11-03T10:30:00.000Z');
    assert.equal(iso(calendar.floor(on - 1)), '2026-11-03T10:00:00.000Z');
  });

  test('refuses schedules the protocol does not define', () => {
    assert.throws(() => createReportingPeriodCalendarV1({ period_duration: 'P0D', alignment: 'utc' }), TypeError);
    assert.throws(
      () =>
        createReportingPeriodCalendarV1({ period_duration: 'P1D', alignment: 'account_timezone', timezone: '+05:00' }),
      TypeError
    );
    assert.throws(
      () =>
        createReportingPeriodCalendarV1({
          period_duration: 'P1D',
          alignment: 'account_timezone',
          timezone: 'Mars/Base',
        }),
      TypeError
    );
    assert.throws(
      () => createReportingPeriodCalendarV1({ period_duration: 'P1M', alignment: 'billing_cycle', timezone: 'UTC' }),
      /period_anchor/
    );
  });
});

describe('selector resolution and scope', () => {
  const offerings = table.cases.find(c => c.name === 'match all').input.offerings;
  const ids = offerings.map(offering => offering.offering_id);
  const selector = extra => ({
    feed_purpose: 'analytics',
    period_duration: 'P1D',
    required_finality: 'official',
    ...extra,
  });

  test('ties go to the lowest offering_id in byte order', () => {
    const twins = [
      { ...offerings[1], offering_id: 'b' },
      { ...offerings[1], offering_id: 'B' },
      { ...offerings[1], offering_id: 'a' },
    ];
    // Byte order puts uppercase before lowercase.
    assert.deepEqual(
      resolveReportingSubscriptionOfferingsV1({
        selector: selector({ dimensions: ['package', 'creative'] }),
        reconciliation_mode: 'delivery_only',
        offerings: twins,
        eligible_offering_ids: ['a', 'b', 'B'],
      }),
      ['B']
    );
  });

  test('an unknown vocabulary value matches nothing', () => {
    assert.deepEqual(
      resolveReportingSubscriptionOfferingsV1({
        selector: selector({ dimensions: ['package', 'audience_segment'], match: 'all' }),
        reconciliation_mode: 'delivery_only',
        offerings,
        eligible_offering_ids: ids,
      }),
      []
    );
  });

  test('a configurable billing cycle is never resolvable by a subscription', () => {
    const configurable = {
      ...offerings[0],
      offering_id: 'cfg',
      schedule: {
        period_duration: 'P1D',
        alignment: 'billing_cycle',
        period_anchor_policy: 'configurable',
        delivery_sla: 'P1D',
      },
    };
    assert.deepEqual(
      resolveReportingSubscriptionOfferingsV1({
        selector: selector({ dimensions: ['package'] }),
        reconciliation_mode: 'delivery_only',
        offerings: [configurable],
        eligible_offering_ids: ['cfg'],
      }),
      []
    );
  });

  test('a utc schedule matches a period_timezone override only for UTC or Etc/UTC', () => {
    const resolve = zone =>
      resolveReportingSubscriptionOfferingsV1({
        selector: selector({ dimensions: ['package'], period_timezone: zone }),
        reconciliation_mode: 'delivery_only',
        offerings,
        eligible_offering_ids: ids,
      });
    assert.deepEqual(resolve('Etc/UTC'), ['off_a_pkg']);
    assert.deepEqual(resolve('UTC'), ['off_a_pkg']);
    assert.deepEqual(resolve('GMT'), [], 'only UTC and Etc/UTC are UTC aliases for matching');
    assert.deepEqual(resolve('Europe/London'), []);
  });

  test('scope membership', () => {
    const all = { scope: { all_authorized_accounts: true } };
    assert.equal(reportingSubscriptionScopeIncludesV1(all, { account_id: 'a' }), true);
    assert.equal(
      reportingSubscriptionScopeIncludesV1({ ...all, exclude_account_ids: ['a'] }, { account_id: 'a' }),
      false
    );
    assert.equal(reportingSubscriptionScopeIncludesV1({ scope: { account_ids: ['b'] } }, { account_id: 'a' }), false);
    assert.equal(
      reportingSubscriptionScopeIncludesV1({ ...all, operator_domains: ['x.example'] }, { account_id: 'a' }),
      false
    );
    assert.equal(
      reportingSubscriptionScopeIncludesV1(
        { ...all, operator_domains: ['x.example'] },
        { account_id: 'a', operator: 'x.example' }
      ),
      true
    );
  });
});
