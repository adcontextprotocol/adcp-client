const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createReportingProducer,
  createReportingStatusHandler,
  createSyncReportingStatusHandler,
  evaluateReportingLedgerCoverageV1,
} = require('@adcp/sdk/reporting/ledger');
const { createReliableReportingService } = require('@adcp/sdk/reporting/service');
const {
  createInlineReportingSourceExecutor,
  redactedReportingSourceOfferingV1,
  redactedReportingSourceRequestV1,
} = require('@adcp/sdk/reporting/source');
const { TOOL_RESPONSE_SCHEMAS, getCanonicalToolValidator } = require('@adcp/sdk/schemas');
const { MemoryLedgerStore } = require('../helpers/memory-reporting-ledger-store.js');

// Independent civil-date expectations, including the six literal instants in
// reporting_core/run_real_source_calendar_dst_scheduler. No scheduler helper
// or storyboard output is used to construct the expected boundaries.
const calendars = [
  {
    name: 'New York spring',
    zone: 'America/New_York',
    dates: ['2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10'],
    boundaries: [
      '2026-03-07T05:00:00.000Z',
      '2026-03-08T05:00:00.000Z',
      '2026-03-09T04:00:00.000Z',
      '2026-03-10T04:00:00.000Z',
    ],
    deadlines: ['2026-03-08T09:00:00.000Z', '2026-03-09T08:00:00.000Z', '2026-03-10T08:00:00.000Z'],
    next: '2026-03-11T04:00:00.000Z',
    hours: [24, 23, 24],
  },
  {
    name: 'New York fall',
    zone: 'America/New_York',
    dates: ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03'],
    boundaries: [
      '2026-10-31T04:00:00.000Z',
      '2026-11-01T04:00:00.000Z',
      '2026-11-02T05:00:00.000Z',
      '2026-11-03T05:00:00.000Z',
    ],
    deadlines: ['2026-11-01T08:00:00.000Z', '2026-11-02T09:00:00.000Z', '2026-11-03T09:00:00.000Z'],
    next: '2026-11-04T05:00:00.000Z',
    hours: [24, 25, 24],
  },
  {
    name: 'Berlin spring in another year',
    zone: 'Europe/Berlin',
    dates: ['2027-03-27', '2027-03-28', '2027-03-29', '2027-03-30'],
    boundaries: [
      '2027-03-26T23:00:00.000Z',
      '2027-03-27T23:00:00.000Z',
      '2027-03-28T22:00:00.000Z',
      '2027-03-29T22:00:00.000Z',
    ],
    deadlines: ['2027-03-28T00:30:00.000Z', '2027-03-28T23:30:00.000Z', '2027-03-29T23:30:00.000Z'],
    next: '2027-03-30T22:00:00.000Z',
    sla: 'PT90M',
    slaMs: 5_400_000,
    hours: [24, 23, 24],
  },
  {
    name: 'Lord Howe half-hour spring',
    zone: 'Australia/Lord_Howe',
    dates: ['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06'],
    boundaries: [
      '2026-10-02T13:30:00.000Z',
      '2026-10-03T13:30:00.000Z',
      '2026-10-04T13:00:00.000Z',
      '2026-10-05T13:00:00.000Z',
    ],
    deadlines: ['2026-10-03T17:30:00.000Z', '2026-10-04T17:00:00.000Z', '2026-10-05T17:00:00.000Z'],
    next: '2026-10-06T13:00:00.000Z',
    hours: [24, 23.5, 24],
  },
  {
    name: 'Kolkata fixed-offset control',
    zone: 'Asia/Kolkata',
    dates: ['2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10'],
    boundaries: [
      '2026-03-06T18:30:00.000Z',
      '2026-03-07T18:30:00.000Z',
      '2026-03-08T18:30:00.000Z',
      '2026-03-09T18:30:00.000Z',
    ],
    deadlines: ['2026-03-07T22:30:00.000Z', '2026-03-08T22:30:00.000Z', '2026-03-09T22:30:00.000Z'],
    next: '2026-03-10T18:30:00.000Z',
    hours: [24, 24, 24],
  },
];

function fixture(
  calendar,
  { service = false, official = false, accountId = 'calendar-account', offeringChanges = {} } = {}
) {
  const request = redactedReportingSourceRequestV1();
  const sourceOffering = structuredClone(redactedReportingSourceOfferingV1);
  sourceOffering.sourceTimezone.ianaTimezone = calendar.zone;
  sourceOffering.cadence.expectedAvailabilityLag = 'PT0S';
  sourceOffering.cadence.worstCaseAvailabilityLag = 'PT0S';
  if (official) {
    const { triggerSupport } = sourceOffering.cadence;
    delete sourceOffering.cadence;
    Object.assign(sourceOffering, {
      publicationClass: 'AUTHORITATIVE',
      revisionSemantics: 'official_with_declared_correction_policy',
      finalization: {
        schedule: { sourceLocalReadyTime: '00:00', daysAfterPeriodEnd: 0 },
        expectedAvailabilityLag: 'PT0S',
        worstCaseAvailabilityLag: 'PT0S',
        triggerSupport,
        correctionWindow: 'P7D',
        correctionPolicy: 'immutable_correction',
      },
    });
  }
  Object.assign(sourceOffering, offeringChanges);
  const sourceCalls = [];
  const fetchSlice = (request, context) => {
    sourceCalls.push(structuredClone(request));
    return {
      reporting_period: { start: request.start_date, end: request.end_date },
      currency: context.sourceSettings.currency,
      reporting_rows: [],
      ...(official ? { is_final: true } : {}),
    };
  };
  const store = new MemoryLedgerStore();
  const source = createInlineReportingSourceExecutor(fetchSlice, sourceOffering);
  const producer = createReportingProducer({
    store,
    source,
    offerings: [sourceOffering],
    contact: { name: 'Calendar test', email: 'calendar@example.invalid' },
  });
  const input = {
    account: { account_id: accountId },
    sourceScope: request.sourceScope,
    delivery_config_id: 'calendar-daily',
    delivery_config_version: 1,
    offeringId: sourceOffering.offeringId,
    report_definition_id: sourceOffering.contract.report_definition_id,
    feedPurpose: 'analytics',
    requiredFinality: official ? 'official' : 'snapshot',
    ...(official
      ? {
          finalityPolicy: {
            policyId: 'calendar-close',
            basis: 'source_final',
            sourceSignal: 'get_media_buy_delivery.is_final',
          },
        }
      : {}),
    requestedMetrics: request.requestedMetrics,
    requestedDimensions: request.requestedDimensions,
    constituents: request.coverage.constituents,
    mediaBuyIds: request.coverage.mediaBuyIds,
    sourceTimezone: calendar.zone,
    schedule: {
      anchor: calendar.boundaries[0],
      periodMilliseconds: 86_400_000,
      deliverySlaMilliseconds: calendar.slaMs ?? 14_400_000,
      recoveryWindowMilliseconds: 86_400_000,
      periodDuration: 'P1D',
      alignment: 'source_timezone',
      periodTimezone: calendar.zone,
      deliverySlaDuration: calendar.sla ?? 'PT4H',
    },
    sourceSettings: request.sourceSettings,
    contract: sourceOffering.contract,
  };
  const context = { account: { id: accountId, ctx_metadata: {} }, consumer: 'calendar-reader' };
  let reporting;
  if (service) {
    const contract = sourceOffering.contract;
    const deliveryOffering = {
      offering_id: sourceOffering.offeringId,
      feed_purpose: 'analytics',
      report_definition_id: contract.report_definition_id,
      report_definition_uri: contract.reportDefinitionUri,
      report_definition_sha256: contract.reportDefinitionSha256,
      reporting_profile: {
        id: contract.reportingProfile,
        version: contract.schemaVersion,
        schema_uri: contract.schemaUri,
        schema_sha256: contract.schemaSha256,
        schema_dialect: contract.schemaDialect,
        schema_ref_policy: contract.schemaRefPolicy,
        grain: sourceOffering.grain,
        primary_keys: ['media_buy_id'],
      },
      schedule: {
        period_duration: 'P1D',
        alignment: 'source_timezone',
        period_timezone_policy: 'fixed',
        period_timezone: calendar.zone,
        delivery_sla: calendar.sla ?? 'PT4H',
      },
      supported_finality: [input.requiredFinality],
      reconciliation_mode: 'delivery_only',
    };
    reporting = createReliableReportingService({
      store,
      adapters: { calendar: { sourceOffering, deliveryOffering, fetchSlice } },
      contact: { name: 'Calendar test', email: 'calendar@example.invalid' },
      automatedRecoveryWindowSeconds: 86_400,
      statusRetentionDays: 30,
      resolveSource: () => ({ adapterId: 'calendar', sourceScope: request.sourceScope, sourceTimezone: calendar.zone }),
      resolveCurrency: () => 'USD',
      resolveCoverage: () => ({ constituents: request.coverage.constituents }),
    });
  }
  return { store, producer: reporting?.producer ?? producer, sourceCalls, sourceOffering, input, context, reporting };
}

function serviceInput(input) {
  const { account, sourceScope, sourceTimezone, contract, constituents, mediaBuyIds, sourceSettings, ...rest } = input;
  const { currency, ...untrustedSettings } = sourceSettings;
  return { ...rest, sourceSettings: untrustedSettings };
}

function validateStatus(response) {
  const validate = getCanonicalToolValidator('get_reporting_status', 'sync', { adcpVersion: '3.2.0-rc.4' });
  assert.equal(typeof validate, 'function');
  assert.equal(TOOL_RESPONSE_SCHEMAS.get_reporting_status.safeParse(response).success, true);
  assert.equal(validate(response), true, JSON.stringify(validate.errors));
}

for (const calendar of calendars) {
  test(`calendar producer: ${calendar.name}`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date(calendar.boundaries[0]) });
    const { store, producer, input, context, sourceCalls } = fixture(calendar);
    const originalInput = structuredClone(input);
    const installed = await producer.installConfiguration(input);
    assert.deepEqual(await producer.installConfiguration(input), installed, 'generation replay is immutable');
    assert.deepEqual(await store.listObligations(input.account.account_id), []);
    const end = calendar.boundaries.at(-1);
    const query = {
      account_id: input.account.account_id,
      view: 'periods',
      period: { start: input.schedule.anchor, end },
    };
    assert.equal(evaluateReportingLedgerCoverageV1(query, [installed], [], end).complete, false);
    const planned = await producer.planObligations(end, { account_id: input.account.account_id });
    assert.equal(planned.length, 3);
    assert.deepEqual(
      planned.map(item => [item.period.start, item.period.end, item.expectedAt]),
      calendar.deadlines.map((due, index) => [calendar.boundaries[index], calendar.boundaries[index + 1], due])
    );
    assert.deepEqual(
      planned.map(item => (Date.parse(item.period.end) - Date.parse(item.period.start)) / 3_600_000),
      calendar.hours
    );
    assert.deepEqual(
      planned.map(item => item.periodOrdinal),
      [0, 1, 2]
    );
    assert.equal(evaluateReportingLedgerCoverageV1(query, [installed], planned, end).complete, true);
    assert.equal(
      evaluateReportingLedgerCoverageV1(
        query,
        [installed],
        planned.filter(item => item.periodOrdinal !== 1),
        end
      ).complete,
      false
    );
    const before = structuredClone(await store.listObligations(input.account.account_id));
    assert.deepEqual(await producer.planObligations(end, { account_id: input.account.account_id }), []);
    assert.deepEqual(await store.listObligations(input.account.account_id), before, 'replay never rewrites periods');

    const now = new Date(Date.parse(calendar.deadlines.at(-1)) + 1_000);
    t.mock.timers.setTime(now.getTime());
    const worker = await producer.runWorker({ now: () => now, account_id: input.account.account_id });
    assert.equal(worker.revisionsCommitted, 3, JSON.stringify(worker));
    assert.deepEqual(
      sourceCalls.map(item => [item.start_date, item.end_date]),
      calendar.dates.slice(0, -1).map((date, index) => [date, calendar.dates[index + 1]])
    );
    const status = await createReportingStatusHandler(store)(
      { account: input.account, view: 'periods', period: query.period },
      context
    );
    validateStatus(status);
    assert.equal(status.scope.coverage_complete, true);
    assert.equal(status.scope.scope_closed, true);
    assert.deepEqual(
      status.periods.map(item => [item.period.start, item.period.end, item.expected_at]),
      calendar.deadlines.map((due, index) => [calendar.boundaries[index], calendar.boundaries[index + 1], due])
    );
    const summary = await createReportingStatusHandler(store)(
      { account: input.account, view: 'summary', period: query.period },
      context
    );
    validateStatus(summary);
    assert.equal(summary.next_expected_at, calendar.next);
    assert.ok(
      status.periods.every(
        item => item.schedule.period_duration === 'P1D' && item.schedule.period_timezone === calendar.zone
      )
    );
    assert.deepEqual(input, originalInput);
    assert.deepEqual(await producer.installConfiguration(input), installed);
  });
}

for (const calendar of calendars.slice(0, 2)) {
  test(`calendar service installation and exact status eligibility: ${calendar.name}`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date(calendar.boundaries[0]) });
    const { store, reporting, input, context } = fixture(calendar, { service: true });
    const { account } = input;
    const installed = await reporting.installConfiguration(serviceInput(input), context);
    assert.equal(installed.schedule.periodDuration, 'P1D');
    assert.equal(installed.schedule.periodTimezone, calendar.zone);
    assert.deepEqual(await reporting.installConfiguration(serviceInput(input), context), installed);
    // Independent buyer status can report absence before the producer has
    // planned anything. Exact-period validation must use the same civil grid.
    assert.deepEqual(await store.listObligations(account.account_id), []);
    const now = new Date(Date.parse(calendar.deadlines[1]) + 1_000);
    t.mock.timers.setTime(now.getTime());
    const sync = createSyncReportingStatusHandler(store, { resolveConsumerId: ctx => ctx.consumer, now: () => now });
    const base = {
      delivery_config_id: input.delivery_config_id,
      delivery_config_version: input.delivery_config_version,
      report_definition_id: input.report_definition_id,
      period: { start: calendar.boundaries[1], end: calendar.boundaries[2], source_timezone: calendar.zone },
      consumer_status: 'obligation_missing',
      status_as_of: now.toISOString(),
    };
    const result = await sync(
      {
        account,
        idempotency_key: `calendar-${calendar.name.replaceAll(' ', '-')}`,
        statuses: [
          { ...base, reporting_status_id: 'calendar-correct-period-0001' },
          {
            ...base,
            reporting_status_id: 'calendar-fixed-offset-0001',
            period: {
              ...base.period,
              end: new Date(Date.parse(base.period.start) + 86_400_000).toISOString(),
            },
          },
          {
            ...base,
            reporting_status_id: 'calendar-fractional-period-0001',
            period: {
              ...base.period,
              start: base.period.start.replace('.000Z', '.0001Z'),
            },
          },
        ],
      },
      context
    );
    assert.deepEqual(
      result.results.map(item => item.result),
      ['recorded', 'failed', 'failed'],
      JSON.stringify(result)
    );
    assert.ok(result.results.slice(1).every(item => item.errors[0].field.includes('period')));
    assert.equal((await reporting.runCycle({ now, accountId: account.account_id })).planned, 2);
    assert.equal((await store.listObligations(account.account_id)).length, 2);
  });
}

test('calendar origin, close boundary, bounded planning and next deadline agree', async t => {
  const calendar = calendars[0];
  t.mock.timers.enable({ apis: ['Date'], now: new Date(calendar.boundaries[0]) });
  const { store, producer, input, context } = fixture(calendar);
  input.schedule.anchor = '1970-01-01T05:00:00.000Z';
  const configuration = await producer.installConfiguration(input);
  const beforeClose = new Date(Date.parse(calendar.boundaries[2]) - 1).toISOString();
  assert.equal((await producer.planObligations(beforeClose)).length, 1, 'spring day is still open');
  t.mock.timers.setTime(Date.parse(calendar.deadlines[0]));
  assert.equal((await producer.runWorker({ now: () => new Date(calendar.deadlines[0]) })).revisionsCommitted, 1);
  const summary = await createReportingStatusHandler(store)(
    {
      account: input.account,
      view: 'summary',
      period: { start: calendar.boundaries[1], end: calendar.boundaries[2] },
    },
    context
  );
  validateStatus(summary);
  assert.equal(summary.next_expected_at, '2026-03-09T08:00:00.000Z');
  const closed = await producer.planObligations(calendar.boundaries[2], { maxObligations: 1 });
  assert.equal(closed.length, 1);
  assert.deepEqual(closed[0].period, {
    start: calendar.boundaries[1],
    end: calendar.boundaries[2],
    sourceTimezone: calendar.zone,
  });
  assert.equal(closed[0].expectedAt, calendar.deadlines[1]);
  assert.equal(closed[0].recoveryDeadlineAt, '2026-03-10T08:00:00.000Z');
  assert.deepEqual(await producer.planObligations(calendar.boundaries[2]), []);
  assert.equal(
    evaluateReportingLedgerCoverageV1(
      {
        account_id: input.account.account_id,
        view: 'summary',
        period: { start: calendar.boundaries[0], end: calendar.boundaries[2] },
      },
      [configuration],
      await store.listObligations(),
      calendar.boundaries[2]
    ).complete,
    true
  );
});

test('calendar generation ownership uses civil boundaries and trusted accounts', async t => {
  const calendar = calendars[0];
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-03-07T12:00:00.000Z') });
  const { store, producer, input, context } = fixture(calendar);
  const first = await producer.installConfiguration(input);
  // A replacement installed partway through the following day starts owning
  // the next complete period; the predecessor still owns the in-flight one.
  t.mock.timers.setTime(Date.parse('2026-03-09T12:00:00.000Z'));
  const second = await producer.installConfiguration({ ...input, delivery_config_version: 2 });
  const other = await producer.installConfiguration({ ...input, account: { account_id: 'other-calendar-account' } });
  assert.notEqual(second.configurationId, first.configurationId);
  assert.notEqual(other.configurationId, first.configurationId);
  const planned = await producer.planObligations('2026-03-11T04:00:00.000Z', { account_id: input.account.account_id });
  assert.deepEqual(
    planned.map(item => [item.delivery_config_version, item.period.start, item.period.end]),
    [
      [1, '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'],
      [1, '2026-03-09T04:00:00.000Z', '2026-03-10T04:00:00.000Z'],
      [2, '2026-03-10T04:00:00.000Z', '2026-03-11T04:00:00.000Z'],
    ]
  );
  assert.deepEqual(await store.listObligations(other.account.account_id), []);
  const now = new Date('2026-03-11T12:00:00.000Z');
  const sync = createSyncReportingStatusHandler(store, { resolveConsumerId: ctx => ctx.consumer, now: () => now });
  const result = await sync(
    {
      account: input.account,
      idempotency_key: 'calendar-owned-status',
      statuses: [
        {
          reporting_status_id: 'calendar-unowned-period-0001',
          delivery_config_id: input.delivery_config_id,
          delivery_config_version: 2,
          report_definition_id: input.report_definition_id,
          period: { start: calendar.boundaries[2], end: calendar.boundaries[3], source_timezone: calendar.zone },
          consumer_status: 'obligation_missing',
          status_as_of: now.toISOString(),
        },
      ],
    },
    context
  );
  assert.equal(result.results[0].result, 'failed');
  assert.ok(result.results[0].errors[0].field.includes('period'));
});

test('keeps numeric schedules and unchanged UTC generation/obligation identities', async t => {
  const { createHash } = require('node:crypto');
  const { canonicalJsonV1 } = require('@adcp/sdk/reporting/source');
  const calendar = { zone: 'UTC', boundaries: ['2026-03-08T00:00:00.000Z'] };
  t.mock.timers.enable({ apis: ['Date'], now: new Date(calendar.boundaries[0]) });
  const explicit = fixture(calendar);
  const installed = await explicit.producer.installConfiguration(explicit.input);
  // The existing generation fingerprint contract is unchanged for equal
  // boundaries. No version marker may perturb a previously supported UTC day.
  assert.equal(
    installed.semanticFingerprint,
    `sha256:${createHash('sha256').update(canonicalJsonV1(explicit.input)).digest('hex')}`
  );
  const numeric = fixture(calendar);
  for (const key of ['periodDuration', 'alignment', 'periodTimezone', 'deliverySlaDuration'])
    delete numeric.input.schedule[key];
  await numeric.producer.installConfiguration(numeric.input);
  const a = await explicit.producer.planObligations('2026-03-10T00:00:00.000Z');
  const b = await numeric.producer.planObligations('2026-03-10T00:00:00.000Z');
  assert.deepEqual(
    a.map(item => [item.reporting_obligation_id, item.semanticFingerprint, item.period, item.expectedAt]),
    b.map(item => [item.reporting_obligation_id, item.semanticFingerprint, item.period, item.expectedAt])
  );
  const elapsed = fixture(calendar);
  elapsed.input.schedule.periodDuration = 'PT24H';
  await elapsed.producer.installConfiguration(elapsed.input);
  assert.deepEqual(
    (await elapsed.producer.planObligations('2026-03-10T00:00:00.000Z')).map(item => item.period),
    a.map(item => item.period)
  );
  const oldSla = fixture(calendar);
  oldSla.input.schedule.deliverySlaDuration = 'P1D';
  oldSla.input.schedule.deliverySlaMilliseconds = 86_400_000;
  const existingSla = await oldSla.producer.installConfiguration(oldSla.input);
  assert.equal(
    existingSla.semanticFingerprint,
    `sha256:${createHash('sha256').update(canonicalJsonV1(oldSla.input)).digest('hex')}`
  );
  assert.equal(
    (await oldSla.producer.planObligations('2026-03-09T00:00:00.000Z'))[0].expectedAt,
    '2026-03-10T00:00:00.000Z'
  );
});

test('legacy variable-offset labels require a new generation instead of reinterpretation', async t => {
  const { createHash } = require('node:crypto');
  const { canonicalJsonV1 } = require('@adcp/sdk/reporting/source');
  const calendar = calendars[0];
  t.mock.timers.enable({ apis: ['Date'], now: new Date(calendar.boundaries[0]) });
  const { store, producer, input } = fixture(calendar);
  // Public store setup models a seller-owned generation with the pre-calendar
  // fingerprint, not an rc.45 producer installation (which refused this zone).
  const legacy = {
    ...structuredClone(input),
    configurationId: 'legacy-seller-calendar',
    installedAt: input.schedule.anchor,
    semanticFingerprint: `sha256:${createHash('sha256').update(canonicalJsonV1(input)).digest('hex')}`,
  };
  await store.putConfiguration(legacy);
  assert.deepEqual(await producer.installConfiguration(input), legacy, 'exact replay must stay immutable');
  await assert.rejects(producer.planObligations(calendar.boundaries[2]), /install a new configuration generation/);
  assert.deepEqual(await store.listConfigurations(), [legacy]);
  assert.deepEqual(await store.listObligations(), []);
  await producer.installConfiguration({ ...input, delivery_config_version: 2 });
  const planned = await producer.planObligations(calendar.boundaries[2]);
  assert.equal(planned.length, 2);
  assert.ok(planned.every(item => item.delivery_config_version === 2));
  assert.equal(planned[1].period.end, calendar.boundaries[2]);
  assert.deepEqual((await store.listConfigurations())[0], legacy);
});

test('rejects unsupported elapsed grids, calendar SLAs and incompatible source windows', async t => {
  const calendar = calendars[0];
  t.mock.timers.enable({ apis: ['Date'], now: new Date(calendar.boundaries[0]) });
  const { producer, input } = fixture(calendar);
  for (const [change, message] of [
    [{ periodDuration: 'PT24H' }, /changes its UTC offset/],
    [{ periodDuration: undefined }, /changes its UTC offset/],
    [{ periodDuration: 'P1M' }, /periodDuration does not describe/],
    [{ alignment: 'account_timezone', periodTimezone: undefined }, /not schedulable/],
    [{ periodTimezone: 'UTC' }, /does not match/],
    [{ deliverySlaDuration: 'P1D', deliverySlaMilliseconds: 86_400_000 }, /changes its UTC offset/],
  ]) {
    const schedule = { ...input.schedule, ...change };
    for (const key of Object.keys(schedule)) if (schedule[key] === undefined) delete schedule[key];
    await assert.rejects(producer.installConfiguration({ ...input, schedule }), message);
  }
  for (const windowing of [
    { kind: 'fixed_closed_window', minimumWindow: 'PT24H', maximumWindow: 'P2D', overlappingWindowsSupported: false },
    { kind: 'fixed_closed_window', minimumWindow: 'P1D', maximumWindow: 'PT24H', overlappingWindowsSupported: false },
  ]) {
    const incompatible = fixture(calendar, { offeringChanges: { windowing } });
    await assert.rejects(
      incompatible.producer.installConfiguration(incompatible.input),
      /outside its source window bounds/
    );
    assert.throws(
      () => fixture(calendar, { service: true, offeringChanges: { windowing } }),
      /outside its source window bounds/
    );
  }
  const midnightGap = { zone: 'America/Santiago', boundaries: ['2026-09-01T04:00:00.000Z'] };
  assert.throws(() => fixture(midnightGap, { service: true }), /lossless source-local midnight boundaries/);
  assert.throws(
    () => fixture({ zone: '+02:00', boundaries: ['2026-03-07T22:00:00.000Z'] }, { service: true }),
    /IANA|time zone|timezone/i
  );
  const wider = fixture(calendar, {
    offeringChanges: {
      windowing: { ...redactedReportingSourceOfferingV1.windowing, maximumWindow: 'P2D' },
      sourceExecution: { ...redactedReportingSourceOfferingV1.sourceExecution, maximumWindowDaysPerRequest: 2 },
    },
  });
  await assert.rejects(
    wider.producer.installConfiguration({
      ...wider.input,
      schedule: {
        ...wider.input.schedule,
        periodDuration: 'P2D',
        periodMilliseconds: 172_800_000,
      },
    }),
    /UTC offset|period boundary/
  );
});

test('calendar source feasibility includes the fall-back finalization day', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-31T04:00:00.000Z') });
  const { sourceOffering } = fixture(calendars[1], { official: true });
  const finalization = {
    ...sourceOffering.finalization,
    schedule: { sourceLocalReadyTime: '00:00', daysAfterPeriodEnd: 1 },
  };
  // Period end on Nov 1 plus one *source-local* ready day reaches Nov 2
  // after 25 elapsed hours. A 24-hour SLA is structurally impossible.
  assert.throws(
    () =>
      fixture(
        { ...calendars[1], sla: 'PT24H', slaMs: 86_400_000 },
        {
          official: true,
          service: true,
          offeringChanges: { finalization },
        }
      ),
    /source calendar finalization/
  );
  const feasible = fixture(
    { ...calendars[1], sla: 'PT25H', slaMs: 90_000_000 },
    {
      official: true,
      service: true,
      offeringChanges: { finalization },
    }
  );
  assert.equal(feasible.reporting.capabilities.offerings[0].schedule.delivery_sla, 'PT25H');
});

test('MCP calendar controller runs the installed official scheduler and reads persisted obligations', async t => {
  const { createServer } = require('node:http');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { TOOL_INPUT_SHAPE, toMcpResponse } = require('@adcp/sdk');
  const { z } = require('zod');
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-03-08T05:00:00.000Z') });
  const fixtures = {};
  let writes = 0;
  let cycles = 0;
  for (const [name, anchor, clock] of [
    ['spring_forward', '2026-03-08T05:00:00.000Z', '2026-03-09T12:00:00.000Z'],
    ['fall_back', '2026-11-01T04:00:00.000Z', '2026-11-02T12:00:00.000Z'],
  ]) {
    t.mock.timers.setTime(Date.parse(anchor));
    const f = fixture(
      { zone: 'America/New_York', boundaries: [anchor] },
      {
        service: true,
        official: true,
        accountId: `calendar-${name}`,
      }
    );
    await f.reporting.installConfiguration(serviceInput(f.input), f.context);
    const put = f.store.putObligation.bind(f.store);
    f.store.putObligation = async value => {
      writes += 1;
      return put(value);
    };
    fixtures[name] = { ...f, clock, anchor };
    assert.deepEqual(await f.store.listObligations(), [], 'installation itself must not preseed success');
    assert.deepEqual(f.sourceCalls, []);
  }
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests += 1;
    assert.equal(request.headers['x-adcp-auth'], 'calendar-sandbox');
    const mcp = new McpServer({ name: 'calendar-scheduler-fixture', version: '1.0.0' });
    mcp.registerTool(
      'comply_test_controller',
      {
        inputSchema: {
          ...TOOL_INPUT_SHAPE,
          account: z.object({ account_id: z.literal('reporting_core_lab'), sandbox: z.literal(true) }),
        },
      },
      async params => {
        assert.equal(params.scenario, 'reliable_reporting_core_integrity_probe');
        assert.deepEqual(params.params, { operation: 'probe_scheduler_dst' });
        const simulated = {};
        for (const [name, f] of Object.entries(fixtures)) {
          t.mock.timers.setTime(Date.parse(f.clock));
          cycles += 1;
          const cycle = await f.reporting.runCycle({ now: new Date(f.clock), accountId: f.input.account.account_id });
          const read = await createReportingStatusHandler(f.store)(
            {
              account: f.input.account,
              view: 'periods',
              period: { start: f.anchor, end: f.clock },
            },
            f.context
          );
          validateStatus(read);
          assert.equal(read.periods.length, 1);
          assert.equal(
            read.revisions.length,
            1,
            JSON.stringify({ cycle, periods: read.periods, calls: f.sourceCalls })
          );
          const [obligation] = read.periods;
          assert.equal(obligation.required_finality, 'official');
          assert.equal(read.revisions[0].finality, 'official');
          simulated[name] = {
            start: obligation.period.start,
            end: obligation.period.end,
            expected_at: obligation.expected_at,
          };
        }
        return toMcpResponse({ status: 'completed', success: true, simulated });
      }
    );
    mcp.registerTool(
      'get_reporting_status',
      {
        inputSchema: {
          account: z.object({ account_id: z.string() }),
          view: z.literal('periods'),
          period: z.object({ start: z.string(), end: z.string() }),
        },
      },
      async params => {
        const f = Object.values(fixtures).find(item => item.input.account.account_id === params.account.account_id);
        assert.ok(f, 'caller must own the selected sandbox account');
        t.mock.timers.setTime(Date.parse((await f.store.listObligations()).length ? f.clock : f.anchor));
        const read = await createReportingStatusHandler(f.store)(params, f.context);
        return { structuredContent: read, content: [{ type: 'text', text: JSON.stringify(read) }] };
      }
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on('close', () => {
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(request, response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'calendar-scheduler-buyer', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), {
      requestInit: { headers: { 'x-adcp-auth': 'calendar-sandbox' } },
    })
  );
  for (const f of Object.values(fixtures)) {
    const result = await client.callTool({
      name: 'get_reporting_status',
      arguments: {
        account: f.input.account,
        view: 'periods',
        period: { start: f.anchor, end: f.clock },
      },
    });
    assert.notEqual(result.isError, true);
    validateStatus(result.structuredContent);
    assert.deepEqual(result.structuredContent.periods, []);
  }
  assert.equal(cycles, 0);
  assert.equal(writes, 0);
  const operation = {
    name: 'comply_test_controller',
    arguments: {
      account: { account_id: 'reporting_core_lab', sandbox: true },
      scenario: 'reliable_reporting_core_integrity_probe',
      params: { operation: 'probe_scheduler_dst' },
    },
  };
  const result = await client.callTool(operation);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  // The public canonical tool registry does not index this compliance-only
  // controller. Require its public response schema; every reporting read above
  // and below additionally requires the canonical rc.4 reporting validator.
  const controllerSchema = TOOL_RESPONSE_SCHEMAS.comply_test_controller;
  assert.equal(typeof controllerSchema?.safeParse, 'function');
  const parsed = controllerSchema.safeParse(result.structuredContent);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error));
  assert.deepEqual(result.structuredContent.simulated, {
    fall_back: {
      start: '2026-11-01T04:00:00.000Z',
      end: '2026-11-02T05:00:00.000Z',
      expected_at: '2026-11-02T09:00:00.000Z',
    },
    spring_forward: {
      start: '2026-03-08T05:00:00.000Z',
      end: '2026-03-09T04:00:00.000Z',
      expected_at: '2026-03-09T08:00:00.000Z',
    },
  });
  const before = await Promise.all(Object.values(fixtures).map(f => f.store.listObligations()));
  const replay = await client.callTool(operation);
  assert.deepEqual(replay.structuredContent, result.structuredContent);
  assert.equal(cycles, 4, 'both runs invoke the real scheduler for each installed generation');
  assert.equal(writes, 2, 'replayed planning performs no duplicate obligation writes');
  assert.deepEqual(await Promise.all(Object.values(fixtures).map(f => f.store.listObligations())), before);
  for (const [name, f] of Object.entries(fixtures)) {
    const read = await client.callTool({
      name: 'get_reporting_status',
      arguments: {
        account: f.input.account,
        view: 'periods',
        period: { start: f.anchor, end: f.clock },
      },
    });
    assert.notEqual(read.isError, true);
    validateStatus(read.structuredContent);
    const [obligation] = read.structuredContent.periods;
    assert.deepEqual(
      { start: obligation.period.start, end: obligation.period.end, expected_at: obligation.expected_at },
      result.structuredContent.simulated[name]
    );
    assert.equal(f.sourceCalls.length, 1, 'replay must reuse the actual source publication');
  }
  assert.ok(requests >= 7, 'MCP initialization and every tool action traverse HTTP');
});

// Resolver-only checks deliberately use the internal module. Public producer,
// coverage and status checks below exercise the same rules without exposing it.
const {
  reportingCalendarDayOrigin,
  reportingCalendarDaySchedule,
  reportingPeriodSchedule,
} = require('../../dist/lib/reporting/ledger/schedule.js');

function retainedConfiguration(input, installedAt, legacy = false) {
  const { createHash } = require('node:crypto');
  const { canonicalJsonV1 } = require('@adcp/sdk/reporting/source');
  return {
    ...structuredClone(input),
    configurationId: 'retained-calendar-generation',
    installedAt,
    semanticFingerprint: `sha256:${createHash('sha256')
      .update(canonicalJsonV1(legacy ? input : ['reporting-source-calendar-day-v1', input]))
      .digest('hex')}`,
  };
}

const skippedDates = [
  {
    zone: 'Pacific/Apia',
    origin: '1970-01-01T11:00:00.000Z',
    missing: 15338,
    before: '2011-12-29T10:00:00.000Z',
    after: '2011-12-30T10:00:00.000Z',
    following: '2011-12-31T10:00:00.000Z',
  },
  {
    zone: 'Pacific/Fakaofo',
    origin: '1970-01-01T11:00:00.000Z',
    missing: 15338,
    before: '2011-12-29T11:00:00.000Z',
    after: '2011-12-30T11:00:00.000Z',
    following: '2011-12-31T11:00:00.000Z',
  },
  {
    zone: 'Pacific/Kiritimati',
    origin: '1970-01-01T10:40:00.000Z',
    missing: 9130,
    before: '1994-12-30T10:00:00.000Z',
    after: '1994-12-31T10:00:00.000Z',
    following: '1995-01-01T10:00:00.000Z',
  },
  {
    zone: 'Pacific/Kanton',
    origin: '1970-01-01T12:00:00.000Z',
    missing: 9130,
    before: '1994-12-30T11:00:00.000Z',
    after: '1994-12-31T11:00:00.000Z',
    following: '1995-01-01T11:00:00.000Z',
  },
];

for (const { zone, origin, missing, before, after, following } of skippedDates) {
  test(`calendar regression: skipped date in ${zone}`, async t => {
    const { input } = fixture({ zone, boundaries: [origin] });
    const schedule = reportingCalendarDaySchedule(input.schedule, zone);
    await t.test('valid neighboring point identities are unchanged', () => {
      assert.equal(reportingCalendarDayOrigin(zone), Date.parse(origin));
      for (const [ordinal, instant] of [
        [missing - 1, before],
        [missing + 1, after],
        [missing + 2, following],
      ]) {
        assert.equal(schedule.boundary(ordinal), Date.parse(instant));
        assert.equal(schedule.floor(Date.parse(instant)), ordinal);
        assert.equal(schedule.ceil(Date.parse(instant)), ordinal);
        assert.equal(schedule.floor(Date.parse(instant) + 1), ordinal);
      }
      assert.equal(schedule.ceil(Date.parse(after) + 1), missing + 2);
      assert.ok(schedule.boundary(missing + 2) > schedule.boundary(missing + 1));
    });
    await t.test('the missing ordinal and both affected periods explicitly refuse', () => {
      for (const ordinal of [missing - 1, missing]) {
        assert.throws(
          () => [schedule.boundary(ordinal), schedule.boundary(ordinal + 1)],
          /unrepresentable|lossless source-local/,
          `period ${ordinal} cannot alias its missing endpoint`
        );
      }
      assert.throws(() => schedule.boundary(missing), /unrepresentable|lossless source-local/);
    });
    await t.test('ceil inside the preceding day refuses instead of jumping over the missing ordinal', () => {
      assert.equal(schedule.floor(Date.parse(before) + 1), missing - 1);
      assert.throws(() => schedule.ceil(Date.parse(before) + 1), /unrepresentable|lossless source-local/);
    });
  });
}

test('calendar regression: ordinary midnight gaps, folds and half-hour changes keep point inverses', () => {
  for (const [zone, anchor, days] of [
    ['America/Santiago', '2026-09-01T04:00:00.000Z', 900],
    ['Australia/Lord_Howe', '2026-10-02T13:30:00.000Z', 800],
    ['America/New_York', '1970-01-01T05:00:00.000Z', 400],
    ['Europe/Berlin', '1969-12-31T23:00:00.000Z', 400],
  ]) {
    const { input } = fixture({ zone, boundaries: [anchor] });
    const schedule = reportingCalendarDaySchedule(input.schedule, zone);
    for (let ordinal = 0; ordinal < days; ordinal += 1) {
      const start = schedule.boundary(ordinal);
      assert.ok(schedule.boundary(ordinal + 1) > start, `${zone}: positive period ${ordinal}`);
      assert.equal(schedule.floor(start), ordinal, `${zone}: floor at ${ordinal}`);
      assert.equal(schedule.ceil(start), ordinal, `${zone}: ceil at ${ordinal}`);
    }
  }
});

test('calendar regression: coverage and status refuse missing civil endpoints without banning their neighbors', async t => {
  const f = fixture({ zone: 'Pacific/Apia', boundaries: ['1970-01-01T11:00:00.000Z'] });
  const configuration = retainedConfiguration(f.input, '2011-12-28T10:00:00.000Z');
  await f.store.putConfiguration(configuration);
  const before = structuredClone(await f.store.listConfigurations());
  const query = {
    account_id: f.input.account.account_id,
    view: 'periods',
    period: { start: '2011-12-29T10:00:00.000Z', end: '2011-12-30T10:00:00.000Z' },
  };
  await t.test('coverage cannot certify a retained count across an unrepresentable period', () => {
    assert.throws(
      () =>
        evaluateReportingLedgerCoverageV1(
          query,
          [configuration],
          [15337, 15338].map(periodOrdinal => ({ configurationId: configuration.configurationId, periodOrdinal })),
          '2011-12-31T10:00:00.000Z'
        ),
      /unrepresentable|lossless source-local/
    );
    assert.equal(
      evaluateReportingLedgerCoverageV1(
        { ...query, period: { start: '2011-12-30T10:00:00.000Z', end: '2011-12-31T10:00:00.000Z' } },
        [configuration],
        [{ configurationId: configuration.configurationId, periodOrdinal: 15339 }],
        '2011-12-31T10:00:00.000Z'
      ).complete,
      true
    );
    assert.throws(
      () =>
        evaluateReportingLedgerCoverageV1(
          { ...query, period: { start: '2011-12-28T10:00:00.000Z', end: '2011-12-31T10:00:00.000Z' } },
          [configuration],
          [15336, 15337, 15338, 15339].map(periodOrdinal => ({
            configurationId: configuration.configurationId,
            periodOrdinal,
          })),
          '2011-12-31T10:00:00.000Z'
        ),
      /unrepresentable|lossless source-local/,
      'valid outer endpoints cannot hide a missing interior date'
    );
  });
  await t.test('summary cannot advertise the next start as a usable period with a missing end', async () => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2011-12-28T11:00:00.000Z') });
    await assert.rejects(
      createReportingStatusHandler(f.store)(
        {
          account: f.input.account,
          view: 'summary',
          period: { start: '2011-12-28T10:00:00.000Z', end: '2011-12-28T11:00:00.000Z' },
        },
        f.context
      ),
      /unrepresentable|lossless source-local/
    );
  });
  await t.test('consumer status cannot accept an aliased period endpoint', async () => {
    const now = new Date('2011-12-31T12:00:00.000Z');
    const sync = createSyncReportingStatusHandler(f.store, { resolveConsumerId: ctx => ctx.consumer, now: () => now });
    await assert.rejects(
      sync(
        {
          account: f.input.account,
          idempotency_key: 'calendar-missing-date-status',
          statuses: [
            {
              reporting_status_id: 'calendar-missing-date-status-0001',
              delivery_config_id: f.input.delivery_config_id,
              delivery_config_version: 1,
              report_definition_id: f.input.report_definition_id,
              period: { ...query.period, source_timezone: 'Pacific/Apia' },
              consumer_status: 'obligation_missing',
              status_as_of: now.toISOString(),
            },
          ],
        },
        f.context
      ),
      /unrepresentable|lossless source-local/
    );
  });
  await t.test('planning refuses the affected period before writing even when the offering is absent', async () => {
    const store = new MemoryLedgerStore();
    await store.putConfiguration(retainedConfiguration(f.input, '2011-12-29T10:00:00.000Z'));
    let writes = 0;
    const put = store.putObligation.bind(store);
    store.putObligation = async value => {
      writes += 1;
      return put(value);
    };
    const source = createInlineReportingSourceExecutor(() => {
      throw new Error('unexpected source fetch');
    }, f.sourceOffering);
    const producer = createReportingProducer({
      store,
      source,
      offerings: [],
      contact: { name: 'Calendar test', email: 'calendar@example.invalid' },
    });
    await assert.rejects(producer.planObligations('2011-12-30T10:00:00.000Z'), /unrepresentable|lossless source-local/);
    assert.equal(writes, 0);
    assert.deepEqual(await store.listObligations(), []);
  });
  assert.deepEqual(await f.store.listConfigurations(), before);
  assert.deepEqual(await f.store.listObligations(), []);
  assert.deepEqual(f.sourceCalls, []);
});

test('calendar regression: legacy finite lookups preserve numeric ordinals and enclosing boundaries on both sides of installation', () => {
  const { input } = fixture({ zone: 'America/New_York', boundaries: ['1970-01-01T05:00:00.000Z'] });
  const configuration = retainedConfiguration(input, '1971-02-05T05:00:00.000Z', true);
  const original = structuredClone(configuration);
  const schedule = reportingPeriodSchedule(configuration);
  // Fixed literal windows: the fall ceil used to return 298, whose boundary
  // happens to match the numeric grid, although the numeric ceil here is 297.
  for (const instant of [
    '1970-04-27T04:00:00.000Z',
    '1970-04-27T04:30:00.000Z',
    '1970-04-27T05:00:00.000Z',
    '1970-10-25T04:00:00.000Z',
    '1970-10-25T04:30:00.000Z',
    '1970-10-25T05:00:00.000Z',
    '1971-04-26T04:30:00.000Z',
    '1971-10-31T04:30:00.000Z',
  ]) {
    for (const operation of ['floor', 'ceil']) {
      assert.throws(
        () => schedule[operation](Date.parse(instant)),
        /install a new configuration generation/,
        `${operation}: ${instant}`
      );
    }
  }
  assert.throws(() => schedule.boundary(116), /install a new configuration generation/);
  for (const [instant, floor, ceil] of [
    ['1969-12-31T04:59:59.999Z', -2, -1],
    ['1969-12-31T05:00:00.000Z', -1, -1],
    ['1970-01-01T05:00:00.000Z', 0, 0],
    ['1971-02-05T04:59:59.999Z', 399, 400],
    ['1971-02-05T05:00:00.000Z', 400, 400],
    ['1971-02-05T05:00:00.001Z', 400, 401],
    ['1970-10-26T05:00:00.000Z', 298, 298],
  ]) {
    assert.equal(schedule.floor(Date.parse(instant)), floor, instant);
    assert.equal(schedule.ceil(Date.parse(instant)), ceil, instant);
  }
  const laterAnchor = retainedConfiguration(
    { ...input, schedule: { ...input.schedule, anchor: '1971-01-01T05:00:00.000Z' } },
    configuration.installedAt,
    true
  );
  for (const operation of ['floor', 'ceil']) {
    assert.throws(
      () => reportingPeriodSchedule(laterAnchor)[operation](Date.parse('1970-04-27T04:30:00.000Z')),
      /install a new configuration generation/
    );
    for (const sentinel of [-Infinity, Infinity, NaN]) assert.equal(schedule[operation](sentinel), sentinel);
  }
  assert.deepEqual(configuration, original);
});

test('calendar regression: public coverage rejects a legacy fall ceil with the wrong ordinal', () => {
  const { input } = fixture({ zone: 'America/New_York', boundaries: ['1970-01-01T05:00:00.000Z'] });
  const configuration = retainedConfiguration(input, input.schedule.anchor, true);
  assert.throws(
    () =>
      evaluateReportingLedgerCoverageV1(
        {
          account_id: input.account.account_id,
          view: 'periods',
          period: { start: '1970-01-01T05:00:00.000Z', end: '1970-10-25T04:30:00.000Z' },
        },
        [configuration],
        [],
        '1970-10-26T05:00:00.000Z'
      ),
    /install a new configuration generation/
  );
});

test('calendar regression: a withdrawn offering cannot bypass calendar planning validation', async t => {
  const calendar = calendars[0];
  t.mock.timers.enable({ apis: ['Date'], now: new Date(calendar.boundaries[0]) });
  const f = fixture(calendar);
  const installed = await f.producer.installConfiguration(f.input);
  let writes = 0;
  const put = f.store.putObligation.bind(f.store);
  f.store.putObligation = async value => {
    writes += 1;
    return put(value);
  };
  const source = createInlineReportingSourceExecutor(() => {
    throw new Error('unexpected source fetch');
  }, f.sourceOffering);
  const withdrawn = createReportingProducer({
    store: f.store,
    source,
    offerings: [],
    contact: { name: 'Calendar test', email: 'calendar@example.invalid' },
  });
  assert.deepEqual(
    await withdrawn.installConfiguration(f.input),
    installed,
    'withdrawal does not invalidate immutable replay'
  );
  await assert.rejects(withdrawn.planObligations(calendar.boundaries[2]), /calendar.*source offering.*unavailable/i);
  assert.equal(writes, 0);
  assert.deepEqual(await f.store.listObligations(), []);
  assert.deepEqual(f.sourceCalls, []);
  const valid = await f.producer.planObligations(calendar.boundaries[2]);
  assert.deepEqual(
    valid.map(value => [value.period.start, value.period.end]),
    [
      ['2026-03-07T05:00:00.000Z', '2026-03-08T05:00:00.000Z'],
      ['2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'],
    ]
  );
  assert.equal(writes, 2);
  assert.deepEqual(await f.producer.planObligations(calendar.boundaries[2]), []);
  assert.equal(writes, 2);
  assert.deepEqual(await f.store.listConfigurations(), [installed]);
});

test('calendar regression: intrinsic lossless periods are required even without a source offering', async () => {
  const f = fixture({ zone: 'America/Santiago', boundaries: ['2026-09-01T04:00:00.000Z'] });
  // A retained host-authored generation can outlive its offering and install
  // horizon. The September 6 midnight gap starts at local 01:00, so the source
  // date-only request cannot express this interval losslessly.
  await f.store.putConfiguration(retainedConfiguration(f.input, '2026-09-06T04:00:00.000Z'));
  let writes = 0;
  let fetches = 0;
  const put = f.store.putObligation.bind(f.store);
  f.store.putObligation = async value => {
    writes += 1;
    return put(value);
  };
  const source = createInlineReportingSourceExecutor(() => {
    fetches += 1;
    throw new Error('unexpected source fetch');
  }, f.sourceOffering);
  const producer = createReportingProducer({
    store: f.store,
    source,
    offerings: [],
    contact: { name: 'Calendar test', email: 'calendar@example.invalid' },
  });
  await assert.rejects(
    producer.planObligations('2026-09-07T03:00:00.000Z'),
    /lossless source-local midnight boundaries/
  );
  assert.equal(writes, 0);
  assert.equal(fetches, 0);
  assert.deepEqual(await f.store.listObligations(), []);
});

test('calendar regression: numeric planning retains its behavior after offering withdrawal', async t => {
  const f = fixture({ zone: 'UTC', boundaries: ['2026-03-07T00:00:00.000Z'] });
  for (const key of ['periodDuration', 'alignment', 'periodTimezone', 'deliverySlaDuration'])
    delete f.input.schedule[key];
  t.mock.timers.enable({ apis: ['Date'], now: new Date(f.input.schedule.anchor) });
  const installed = await f.producer.installConfiguration(f.input);
  const source = createInlineReportingSourceExecutor(() => {
    throw new Error('unexpected source fetch');
  }, f.sourceOffering);
  const producer = createReportingProducer({
    store: f.store,
    source,
    offerings: [],
    contact: { name: 'Calendar test', email: 'calendar@example.invalid' },
  });
  assert.deepEqual(await producer.installConfiguration(f.input), installed);
  const planned = await producer.planObligations('2026-03-08T00:00:00.000Z');
  assert.deepEqual(
    planned.map(value => value.period),
    [{ start: '2026-03-07T00:00:00.000Z', end: '2026-03-08T00:00:00.000Z', sourceTimezone: 'UTC' }]
  );
});
