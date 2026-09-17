const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  InlineReportingSourceError,
  createInlineReportingSourceExecutor,
  parseVerifiedReportingSourceManifestV1,
  redactedReportingSourceOfferingV1,
  redactedReportingSourceRequestV1,
  reportingCoverageDenominatorFingerprintV1,
  runReportingSourceReplayConformanceV1,
  validateReportingSourceFailureV1,
} = require('../../dist/lib/reporting/source/index.js');

function request(sourceExecutionKey) {
  return redactedReportingSourceRequestV1({ sourceExecutionKey });
}

function context() {
  return { signal: new AbortController().signal };
}

function presentAvailability(input) {
  return {
    version: '1.0',
    cells: input.constituents.flatMap(constituent =>
      input.requested_metrics.map(metric => ({
        constituent_id: constituent.constituent_id,
        metric,
        status: 'present',
        data_through: input.end_date,
      }))
    ),
  };
}

// Two constituents backed by the same media buy. Both orders are exercised because the
// mapping from media buy to constituent used to keep only the last declaration.
function sharedMediaBuyRequest(sourceExecutionKey, zeroCellFirst) {
  const slice = request(sourceExecutionKey);
  const base = slice.coverage.constituents[0];
  const constituents = [base, { ...base, constituentId: 'fixture-constituent-b' }];
  slice.coverage.constituents = zeroCellFirst ? constituents : [constituents[1], constituents[0]];
  slice.coverage.denominatorFingerprint = reportingCoverageDenominatorFingerprintV1(slice.coverage.constituents);
  return slice;
}

function sharedMediaBuyCells(input, overrides = []) {
  return {
    version: '1.0',
    cells: input.constituents.flatMap(constituent =>
      input.requested_metrics.map(metric => {
        const override = overrides.find(
          candidate => candidate.constituent_id === constituent.constituent_id && candidate.metric === metric
        );
        return override
          ? { ...override }
          : {
              constituent_id: constituent.constituent_id,
              metric,
              status: 'present',
              data_through: input.end_date,
            };
      })
    ),
  };
}

describe('createInlineReportingSourceExecutor', () => {
  test('wraps a synchronous delivery fetch and passes basic replay conformance', async () => {
    const calls = [];
    const source = createInlineReportingSourceExecutor((input, fetchContext) => {
      calls.push({ input: structuredClone(input), scope: structuredClone(fetchContext.sourceScope) });
      return {
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        media_buy_deliveries: [{ media_buy_id: 'fixture-media-buy', totals: { impressions: 10, spend: '1.25' } }],
      };
    }, redactedReportingSourceOfferingV1);
    const slice = request('fixture-inline-sync');
    const manifest = await runReportingSourceReplayConformanceV1({
      level: 'basic',
      executor: source,
      request: slice,
      objectReader: source,
    });
    assert.equal(manifest.rowCount, 1);
    assert.equal(manifest.explicitZero, false);
    assert.equal(calls.length, 1, 'the inline executor durably replays one sealed fetch');
    assert.deepEqual(source.capabilities.offerings[0].sourceExecution.manifestLevels, ['basic']);
    assert.deepEqual(calls[0].input.media_buy_ids, ['fixture-media-buy']);
    assert.equal(calls[0].input.start_date, '2026-09-01');
    assert.equal(calls[0].input.end_date, '2026-09-02');
    assert.equal(calls[0].input.source_read_cutoff_at, slice.period.sourceReadCutoffAt);
    assert.deepEqual(calls[0].input.constituents, [
      { constituent_id: 'fixture-constituent', media_buy_id: 'fixture-media-buy' },
    ]);
    assert.deepEqual(calls[0].scope, slice.sourceScope);
  });

  test('projects independent metric cells and offering-owned semantic identities', async () => {
    let calls = 0;
    const offering = structuredClone(redactedReportingSourceOfferingV1);
    offering.metrics.push(
      {
        ...offering.metrics[0],
        name: 'clicks',
        semanticContractId: 'delivery.clicks',
      },
      {
        ...offering.metrics[0],
        name: 'viewability',
        semanticContractId: 'delivery.viewability',
      },
      {
        ...offering.metrics[0],
        name: 'completed_views',
        semanticContractId: 'delivery.completed_views',
      }
    );
    const source = createInlineReportingSourceExecutor(input => {
      calls += 1;
      return {
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25', clicks: 0 }],
        availability_evidence: {
          version: '1.0',
          cells: [
            {
              constituent_id: input.constituents[0].constituent_id,
              metric: 'impressions',
              status: 'present',
              data_through: input.end_date,
            },
            {
              constituent_id: input.constituents[0].constituent_id,
              metric: 'spend',
              status: 'present',
              data_through: input.end_date,
            },
            {
              constituent_id: input.constituents[0].constituent_id,
              metric: 'clicks',
              status: 'explicit_zero',
              data_through: input.end_date,
            },
            {
              constituent_id: input.constituents[0].constituent_id,
              metric: 'viewability',
              status: 'delayed',
              reason: 'Provider has not closed viewability processing',
              data_through: input.start_date,
            },
            {
              constituent_id: input.constituents[0].constituent_id,
              metric: 'completed_views',
              status: 'unsupported',
              reason: 'Inventory does not support completed views',
            },
          ],
        },
      };
    }, offering);
    const slice = request('fixture-inline-mixed-cells');
    slice.requestedMetrics.push('clicks', 'viewability', 'completed_views');
    slice.coverage.expected = 'partial';
    const manifest = await runReportingSourceReplayConformanceV1({
      level: 'basic',
      executor: source,
      request: slice,
      objectReader: source,
    });

    assert.equal(manifest.coverage.status, 'partial');
    assert.equal(manifest.coverage.constituents[0].status, 'partial');
    assert.equal(manifest.explicitZero, false);
    assert.deepEqual(
      manifest.metricAvailability.map(cell => [cell.metric, cell.status]),
      [
        ['impressions', 'present'],
        ['spend', 'present'],
        ['clicks', 'explicit_zero'],
        ['viewability', 'delayed'],
        ['completed_views', 'unsupported'],
      ]
    );
    assert.equal(
      manifest.metricAvailability.find(cell => cell.metric === 'clicks').semanticContractId,
      'delivery.clicks'
    );
    assert.equal(
      manifest.metricAvailability.find(cell => cell.metric === 'viewability').dataThrough,
      slice.period.start
    );
    assert.equal(calls, 1, 'availability evidence is sealed once and replayed byte-for-byte');
  });

  test('canonicalizes adopter cell order before hashing and roll-up', async () => {
    const buildSource = reverse =>
      createInlineReportingSourceExecutor(input => {
        const evidence = presentAvailability(input);
        if (reverse) evidence.cells.reverse();
        return {
          reporting_period: { start: input.start_date, end: input.end_date },
          currency: 'USD',
          reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' }],
          availability_evidence: evidence,
        };
      }, redactedReportingSourceOfferingV1);
    const slice = request('fixture-inline-canonical-cell-order');
    const left = await buildSource(false).execute(slice, context());
    const right = await buildSource(true).execute(slice, context());
    assert.equal(left.ok, true);
    assert.equal(right.ok, true);
    const leftManifest = parseVerifiedReportingSourceManifestV1(left.response.manifest, left.manifestBytes, 'basic');
    const rightManifest = parseVerifiedReportingSourceManifestV1(right.response.manifest, right.manifestBytes, 'basic');
    assert.equal(leftManifest.publication.contentFingerprint, rightManifest.publication.contentFingerprint);
    assert.deepEqual(
      rightManifest.metricAvailability.map(cell => cell.metric),
      slice.requestedMetrics
    );
  });

  test('seals evidenced empty periods only when zero and unavailable claims remain coherent', async () => {
    for (const item of [
      {
        key: 'explicit-zero',
        status: 'explicit_zero',
        cell: (input, metric) => ({
          constituent_id: input.constituents[0].constituent_id,
          metric,
          status: 'explicit_zero',
          data_through: input.end_date,
        }),
        coverage: 'full',
        explicitZero: true,
      },
      {
        key: 'delayed',
        status: 'delayed',
        cell: (input, metric) => ({
          constituent_id: input.constituents[0].constituent_id,
          metric,
          status: 'delayed',
          reason: 'Provider processing is delayed',
        }),
        coverage: 'none',
        explicitZero: false,
      },
      ...['unsupported', 'missing', 'stale', 'partial'].map(status => ({
        key: status,
        status,
        cell: (input, metric) => ({
          constituent_id: input.constituents[0].constituent_id,
          metric,
          status,
          reason: `Provider reports ${status} metric availability`,
        }),
        coverage: status === 'partial' ? 'partial' : 'none',
        explicitZero: false,
      })),
    ]) {
      const source = createInlineReportingSourceExecutor(
        input => ({
          reporting_period: { start: input.start_date, end: input.end_date },
          currency: 'USD',
          reporting_rows: [],
          availability_evidence: {
            version: '1.0',
            cells: input.requested_metrics.map(metric => item.cell(input, metric)),
          },
        }),
        redactedReportingSourceOfferingV1
      );
      const slice = request(`fixture-inline-evidenced-empty-${item.key}`);
      if (item.coverage !== 'full') slice.coverage.expected = 'partial';
      const result = await source.execute(slice, context());
      assert.equal(result.ok, true);
      const manifest = parseVerifiedReportingSourceManifestV1(result.response.manifest, result.manifestBytes, 'basic');
      assert.equal(manifest.coverage.status, item.coverage);
      assert.equal(manifest.coverage.constituents[0].status, item.status);
      assert.equal(manifest.explicitZero, item.explicitZero);
    }
  });

  test('rejects mixed available and unavailable empty evidence and retries full no-coverage requests', async () => {
    const mixed = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [],
        availability_evidence: {
          version: '1.0',
          cells: [
            {
              constituent_id: input.constituents[0].constituent_id,
              metric: input.requested_metrics[0],
              status: 'explicit_zero',
              data_through: input.end_date,
            },
            {
              constituent_id: input.constituents[0].constituent_id,
              metric: input.requested_metrics[1],
              status: 'delayed',
              reason: 'Provider processing is delayed',
            },
          ],
        },
      }),
      redactedReportingSourceOfferingV1
    );
    const mixedSlice = request('fixture-inline-empty-mixed-availability');
    mixedSlice.coverage.expected = 'partial';
    assert.equal(
      validateReportingSourceFailureV1(await mixed.execute(mixedSlice, context()), 'INTEGRITY_FAILED').code,
      'INTEGRITY_FAILED'
    );

    const delayed = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [],
        availability_evidence: {
          version: '1.0',
          cells: input.requested_metrics.map(metric => ({
            constituent_id: input.constituents[0].constituent_id,
            metric,
            status: 'delayed',
            reason: 'Provider processing is delayed',
          })),
        },
      }),
      redactedReportingSourceOfferingV1
    );
    assert.equal(
      validateReportingSourceFailureV1(
        await delayed.execute(request('fixture-inline-full-no-coverage'), context()),
        'PARTIAL_RESULT'
      ).code,
      'PARTIAL_RESULT'
    );
  });

  test('retains partial and stale row values without claiming complete availability', async () => {
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' }],
        availability_evidence: {
          version: '1.0',
          cells: [
            {
              constituent_id: input.constituents[0].constituent_id,
              metric: 'impressions',
              status: 'partial',
              reason: 'Provider returned an incomplete impression total',
              data_through: input.end_date,
            },
            {
              constituent_id: input.constituents[0].constituent_id,
              metric: 'spend',
              status: 'stale',
              reason: 'Provider spend watermark is stale',
              data_through: input.end_date,
            },
          ],
        },
      }),
      redactedReportingSourceOfferingV1
    );
    const slice = request('fixture-inline-partial-stale-values');
    slice.coverage.expected = 'partial';
    const result = await source.execute(slice, context());
    assert.equal(result.ok, true);
    const manifest = parseVerifiedReportingSourceManifestV1(result.response.manifest, result.manifestBytes, 'basic');
    assert.equal(manifest.coverage.status, 'partial');
    assert.deepEqual(
      manifest.metricAvailability.map(cell => cell.status),
      ['partial', 'stale']
    );
  });

  test('keeps partial provider support scoped to the affected constituent and metric', async () => {
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [
          { media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' },
          { media_buy_id: 'fixture-media-buy-2', impressions: 20 },
        ],
        availability_evidence: {
          version: '1.0',
          cells: input.constituents.flatMap(constituent =>
            input.requested_metrics.map(metric =>
              constituent.media_buy_id === 'fixture-media-buy-2' && metric === 'spend'
                ? {
                    constituent_id: constituent.constituent_id,
                    metric,
                    status: 'unsupported',
                    reason: 'Spend is unavailable for this inventory',
                  }
                : {
                    constituent_id: constituent.constituent_id,
                    metric,
                    status: 'present',
                    data_through: input.end_date,
                  }
            )
          ),
        },
      }),
      redactedReportingSourceOfferingV1
    );
    const slice = request('fixture-inline-constituent-support');
    const second = structuredClone(slice.coverage.constituents[0]);
    second.constituentId = 'fixture-constituent-2';
    second.mediaBuyId = 'fixture-media-buy-2';
    second.productBinding.bindingId = 'fixture-product-binding-2';
    second.productBinding.mediaBuyId = 'fixture-media-buy-2';
    slice.coverage.constituents.push(second);
    slice.coverage.mediaBuyIds.push('fixture-media-buy-2');
    slice.coverage.denominatorFingerprint = reportingCoverageDenominatorFingerprintV1(slice.coverage.constituents);
    const fullResult = await source.execute(slice, context());
    assert.equal(validateReportingSourceFailureV1(fullResult, 'PARTIAL_RESULT').code, 'PARTIAL_RESULT');
    slice.identity.sourceExecutionKey = 'fixture-inline-constituent-support-partial';
    slice.coverage.expected = 'partial';

    const result = await source.execute(slice, context());
    assert.equal(result.ok, true);
    const manifest = parseVerifiedReportingSourceManifestV1(result.response.manifest, result.manifestBytes, 'basic');
    assert.deepEqual(
      manifest.coverage.constituents.map(constituent => [constituent.constituentId, constituent.status]),
      [
        ['fixture-constituent', 'present'],
        ['fixture-constituent-2', 'partial'],
      ]
    );
    assert.equal(
      manifest.metricAvailability.find(
        cell => cell.constituentId === 'fixture-constituent-2' && cell.metric === 'spend'
      ).status,
      'unsupported'
    );
  });

  test('rejects malformed, duplicate, incomplete, and out-of-scope availability evidence', async () => {
    const mutations = [
      evidence => {
        evidence.version = '2.0';
      },
      evidence => {
        evidence.cells.push(structuredClone(evidence.cells[0]));
      },
      evidence => {
        evidence.cells.pop();
      },
      evidence => {
        evidence.cells[0].constituent_id = 'unrequested-constituent';
      },
      evidence => {
        evidence.cells[0].metric = 'unrequested_metric';
      },
      evidence => {
        delete evidence.cells[0].data_through;
      },
      evidence => {
        evidence.cells[0].reason = 'Present cannot also be unavailable';
      },
      evidence => {
        evidence.cells[0] = {
          constituent_id: 'fixture-constituent',
          metric: 'impressions',
          status: 'delayed',
        };
      },
      evidence => {
        evidence.cells[0].data_through = 'not-an-instant';
      },
      evidence => {
        evidence.cells[0].data_through = '2099-01-01T00:00:00.000Z';
      },
      evidence => {
        evidence.cells[0].extra = true;
      },
      evidence => {
        evidence.cells = Array(1_001).fill(evidence.cells[0]);
      },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const source = createInlineReportingSourceExecutor(input => {
        const availability_evidence = presentAvailability(input);
        mutate(availability_evidence);
        return {
          reporting_period: { start: input.start_date, end: input.end_date },
          currency: 'USD',
          reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' }],
          availability_evidence,
        };
      }, redactedReportingSourceOfferingV1);
      const result = await source.execute(request(`fixture-inline-invalid-evidence-${index}`), context());
      assert.equal(validateReportingSourceFailureV1(result, 'INTEGRITY_FAILED').code, 'INTEGRITY_FAILED');
    }
  });

  test('fails closed when rows contradict unavailable or explicit-zero cells', async () => {
    for (const [index, item] of [
      { status: 'unsupported', reason: 'Metric is unsupported', value: 10 },
      { status: 'delayed', reason: 'Metric is delayed', value: 10 },
      { status: 'missing', reason: 'Metric is missing', value: 10 },
      { status: 'unsupported', reason: 'Metric is unsupported', value: false },
      { status: 'explicit_zero', data_through: '2026-09-02', value: 1 },
      { status: 'explicit_zero', data_through: '2026-09-02', value: undefined },
    ].entries()) {
      const source = createInlineReportingSourceExecutor(input => {
        const availability_evidence = presentAvailability(input);
        availability_evidence.cells[0] = {
          constituent_id: input.constituents[0].constituent_id,
          metric: 'impressions',
          status: item.status,
          ...(item.reason ? { reason: item.reason } : {}),
          ...(item.data_through ? { data_through: item.data_through } : {}),
        };
        return {
          reporting_period: { start: input.start_date, end: input.end_date },
          currency: 'USD',
          reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: item.value, spend: '1.25' }],
          availability_evidence,
        };
      }, redactedReportingSourceOfferingV1);
      const result = await source.execute(request(`fixture-inline-row-evidence-conflict-${index}`), context());
      assert.equal(validateReportingSourceFailureV1(result, 'INTEGRITY_FAILED').code, 'INTEGRITY_FAILED');
    }
  });

  test('fails closed when a direct metric value contradicts its totals claim', async () => {
    for (const [index, item] of [
      { direct: 0, totals: 999, status: 'explicit_zero' },
      { direct: 10, totals: 11, status: 'present' },
      { direct: 10, totals: '10.5', status: 'present' },
      { direct: 5, totals: {}, status: 'present' },
    ].entries()) {
      const source = createInlineReportingSourceExecutor(input => {
        const availability_evidence = presentAvailability(input);
        availability_evidence.cells[0] = {
          constituent_id: input.constituents[0].constituent_id,
          metric: 'impressions',
          status: item.status,
          data_through: input.end_date,
        };
        return {
          reporting_period: { start: input.start_date, end: input.end_date },
          currency: 'USD',
          reporting_rows: [
            {
              media_buy_id: 'fixture-media-buy',
              impressions: item.direct,
              totals: { impressions: item.totals, spend: '1.25' },
            },
          ],
          availability_evidence,
        };
      }, redactedReportingSourceOfferingV1);
      const result = await source.execute(request(`fixture-inline-contradictory-metric-claim-${index}`), context());
      assert.equal(validateReportingSourceFailureV1(result, 'INTEGRITY_FAILED').code, 'INTEGRITY_FAILED');
    }
  });

  test('keeps agreeing duplicate metric claims sealable', async () => {
    const source = createInlineReportingSourceExecutor(input => {
      const availability_evidence = presentAvailability(input);
      availability_evidence.cells[0] = {
        constituent_id: input.constituents[0].constituent_id,
        metric: 'impressions',
        status: 'explicit_zero',
        data_through: input.end_date,
      };
      return {
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [
          {
            media_buy_id: 'fixture-media-buy',
            impressions: 0,
            totals: { impressions: '0.00', spend: '1.25' },
          },
        ],
        availability_evidence,
      };
    }, redactedReportingSourceOfferingV1);
    const result = await source.execute(request('fixture-inline-agreeing-metric-claim'), context());
    assert.equal(result.ok, true);
    const manifest = parseVerifiedReportingSourceManifestV1(result.response.manifest, result.manifestBytes, 'basic');
    assert.equal(manifest.coverage.status, 'full');
    assert.equal(manifest.metricAvailability.find(cell => cell.metric === 'impressions').status, 'explicit_zero');
  });

  test('refuses accessor-backed availability evidence without reading it', async () => {
    for (const [index, onPrototype] of [false, true].entries()) {
      let reads = 0;
      const source = createInlineReportingSourceExecutor(input => {
        const response = {
          reporting_period: { start: input.start_date, end: input.end_date },
          currency: 'USD',
          reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' }],
        };
        const descriptor = {
          enumerable: true,
          configurable: true,
          get: () => {
            reads += 1;
            return presentAvailability(input);
          },
        };
        if (!onPrototype) {
          Object.defineProperty(response, 'availability_evidence', descriptor);
          return response;
        }
        return Object.create(
          Object.defineProperty({}, 'availability_evidence', descriptor),
          Object.getOwnPropertyDescriptors(response)
        );
      }, redactedReportingSourceOfferingV1);
      const result = await source.execute(request(`fixture-inline-accessor-evidence-${index}`), context());
      assert.equal(validateReportingSourceFailureV1(result, 'INTEGRITY_FAILED').code, 'INTEGRITY_FAILED');
      assert.equal(reads, 0, 'the executor never invokes an adopter evidence accessor');
    }
  });

  test('decides the evidence slot from one descriptor observation', async () => {
    // A stateful slot that answers "accessor" once and "data" once used to be read
    // twice: the first answer suppressed the value, the second answer cleared the
    // accessor refusal, and the response fell through to legacy present inference --
    // sealing a row-carried spend that the evidence declared missing.
    let observations = 0;
    let reads = 0;
    const accessorFirst = createInlineReportingSourceExecutor(input => {
      const evidence = {
        version: '1.0',
        cells: [
          {
            constituent_id: input.constituents[0].constituent_id,
            metric: 'impressions',
            status: 'present',
            data_through: input.end_date,
          },
          {
            constituent_id: input.constituents[0].constituent_id,
            metric: 'spend',
            status: 'missing',
            reason: 'Provider did not return spend',
          },
        ],
      };
      return new Proxy(
        {
          reporting_period: { start: input.start_date, end: input.end_date },
          currency: 'USD',
          reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' }],
        },
        {
          getOwnPropertyDescriptor(target, property) {
            if (property !== 'availability_evidence') return Reflect.getOwnPropertyDescriptor(target, property);
            observations += 1;
            return observations === 1
              ? {
                  configurable: true,
                  enumerable: true,
                  get: () => {
                    reads += 1;
                    return evidence;
                  },
                }
              : { configurable: true, enumerable: true, writable: true, value: evidence };
          },
        }
      );
    }, redactedReportingSourceOfferingV1);
    const refused = await accessorFirst.execute(request('fixture-inline-restated-evidence-slot'), context());
    assert.equal(validateReportingSourceFailureV1(refused, 'INTEGRITY_FAILED').code, 'INTEGRITY_FAILED');
    assert.equal(observations, 1, 'the evidence slot is observed exactly once');
    assert.equal(reads, 0, 'the executor never invokes an adopter evidence accessor');

    // The mirrored ordering proves the captured value is what gets parsed: a later
    // restatement of the slot as an accessor cannot revoke the evidence already read.
    let dataObservations = 0;
    const dataFirst = createInlineReportingSourceExecutor(input => {
      const evidence = {
        version: '1.0',
        cells: [
          {
            constituent_id: input.constituents[0].constituent_id,
            metric: 'impressions',
            status: 'present',
            data_through: input.end_date,
          },
          {
            constituent_id: input.constituents[0].constituent_id,
            metric: 'spend',
            status: 'missing',
            reason: 'Provider did not return spend',
          },
        ],
      };
      return new Proxy(
        {
          reporting_period: { start: input.start_date, end: input.end_date },
          currency: 'USD',
          reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10 }],
        },
        {
          getOwnPropertyDescriptor(target, property) {
            if (property !== 'availability_evidence') return Reflect.getOwnPropertyDescriptor(target, property);
            dataObservations += 1;
            return dataObservations === 1
              ? { configurable: true, enumerable: true, writable: true, value: evidence }
              : { configurable: true, enumerable: true, get: () => evidence };
          },
        }
      );
    }, redactedReportingSourceOfferingV1);
    const slice = request('fixture-inline-captured-evidence-slot');
    slice.coverage.expected = 'partial';
    const governed = await dataFirst.execute(slice, context());
    assert.equal(governed.ok, true);
    assert.equal(dataObservations, 1, 'the evidence slot is observed exactly once');
    const manifest = parseVerifiedReportingSourceManifestV1(
      governed.response.manifest,
      governed.manifestBytes,
      'basic'
    );
    assert.equal(manifest.metricAvailability.find(cell => cell.metric === 'spend').status, 'missing');
    assert.equal(manifest.metricAvailability.find(cell => cell.metric === 'impressions').status, 'present');
  });

  test('bounds evidence slot resolution across hostile prototype chains', { timeout: 30_000 }, async () => {
    // Neither chain can be walked to an end: one repeats an identity forever, the other
    // never repeats one. An unbounded walk spins the event loop on either, so each trap
    // self-limits far above the real bound -- a regression overruns the hop assertion
    // below instead of hanging the suite.
    const HOP_BUDGET = 10_000;
    const rows = [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' }];
    const body = input => ({
      reporting_period: { start: input.start_date, end: input.end_date },
      currency: 'USD',
      reporting_rows: rows,
    });

    let cyclicHops = 0;
    let cyclic;
    const cyclicSource = createInlineReportingSourceExecutor(input => {
      cyclic = new Proxy(body(input), {
        getPrototypeOf() {
          cyclicHops += 1;
          if (cyclicHops > HOP_BUDGET) throw new Error('unbounded prototype walk');
          return cyclic;
        },
      });
      return cyclic;
    }, redactedReportingSourceOfferingV1);
    const cyclicResult = await cyclicSource.execute(request('fixture-inline-cyclic-prototype'), context());
    assert.equal(validateReportingSourceFailureV1(cyclicResult, 'INTEGRITY_FAILED').code, 'INTEGRITY_FAILED');
    assert.ok(cyclicHops > 0 && cyclicHops <= 8, `identity cycle detected after ${cyclicHops} hops`);

    // Every hop hands back a fresh prototype, so identity tracking alone never closes
    // the walk -- only the depth bound does.
    let regeneratedHops = 0;
    const regenerating = {
      getPrototypeOf() {
        regeneratedHops += 1;
        if (regeneratedHops > HOP_BUDGET) throw new Error('unbounded prototype walk');
        return new Proxy({}, regenerating);
      },
    };
    const regeneratingSource = createInlineReportingSourceExecutor(
      input => new Proxy(body(input), regenerating),
      redactedReportingSourceOfferingV1
    );
    const regeneratedResult = await regeneratingSource.execute(
      request('fixture-inline-regenerating-prototype'),
      context()
    );
    assert.equal(validateReportingSourceFailureV1(regeneratedResult, 'INTEGRITY_FAILED').code, 'INTEGRITY_FAILED');
    assert.ok(
      regeneratedHops > 0 && regeneratedHops <= 128,
      `depth bound stopped the walk after ${regeneratedHops} hops`
    );
  });

  test('reconciles exponent-form metric claims without coercing decimal strings', async () => {
    const claimSource = (key, direct, totals) =>
      createInlineReportingSourceExecutor(input => {
        const availability_evidence = presentAvailability(input);
        return {
          reporting_period: { start: input.start_date, end: input.end_date },
          currency: 'USD',
          reporting_rows: [
            {
              media_buy_id: 'fixture-media-buy',
              impressions: 10,
              spend: direct,
              totals: { impressions: 10, spend: totals },
            },
          ],
          availability_evidence,
        };
      }, redactedReportingSourceOfferingV1);

    // String(number) switches to exponent notation outside 1e-6..1e21, which used to
    // read as a contradiction against the identical plain-decimal totals claim.
    for (const [index, item] of [
      { direct: 1e-7, totals: '0.0000001' },
      { direct: 1.5e-7, totals: '0.00000015' },
      { direct: 1e-21, totals: '0.000000000000000000001' },
      { direct: 1e21, totals: '1000000000000000000000' },
      { direct: 1.5e21, totals: '1500000000000000000000' },
      { direct: -1e-7, totals: '-0.0000001' },
    ].entries()) {
      const source = claimSource(`agree-${index}`, item.direct, item.totals);
      const result = await source.execute(request(`fixture-inline-exponent-agree-${index}`), context());
      assert.equal(result.ok, true, `${item.direct} agrees with ${item.totals}`);
      const manifest = parseVerifiedReportingSourceManifestV1(result.response.manifest, result.manifestBytes, 'basic');
      assert.equal(manifest.metricAvailability.find(cell => cell.metric === 'spend').status, 'present');
    }

    // Contradiction detection survives the normalization. The large case also pins that
    // the totals string is read literally: coercing '...001' through Number would round
    // it onto 1e21 and let a genuine disagreement seal.
    for (const [index, item] of [
      { direct: 1e-7, totals: '0.0000002' },
      { direct: 1e21, totals: '1000000000000000000001' },
      { direct: -1e-7, totals: '0.0000001' },
    ].entries()) {
      const source = claimSource(`contradict-${index}`, item.direct, item.totals);
      const result = await source.execute(request(`fixture-inline-exponent-contradict-${index}`), context());
      assert.equal(
        validateReportingSourceFailureV1(result, 'INTEGRITY_FAILED').code,
        'INTEGRITY_FAILED',
        `${item.direct} contradicts ${item.totals}`
      );
    }
  });

  test('does not treat a present cell with missing row values as complete', async () => {
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10 }],
        availability_evidence: presentAvailability(input),
      }),
      redactedReportingSourceOfferingV1
    );
    const result = await source.execute(request('fixture-inline-present-missing-value'), context());
    assert.equal(validateReportingSourceFailureV1(result, 'PARTIAL_RESULT').code, 'PARTIAL_RESULT');
  });

  test('requires positive elapsed watermarks for available cells backed by rows', async () => {
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' }],
        availability_evidence: {
          ...presentAvailability(input),
          cells: presentAvailability(input).cells.map(cell => ({ ...cell, data_through: input.start_date })),
        },
      }),
      redactedReportingSourceOfferingV1
    );
    assert.equal(
      validateReportingSourceFailureV1(
        await source.execute(request('fixture-inline-zero-width-cell-watermark'), context()),
        'INTEGRITY_FAILED'
      ).code,
      'INTEGRITY_FAILED'
    );
  });

  test('keeps missing dimensions retryable when availability evidence is supplied', async () => {
    const offering = structuredClone(redactedReportingSourceOfferingV1);
    offering.dimensions.push({ name: 'region', support: 'exact' });
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' }],
        availability_evidence: presentAvailability(input),
      }),
      offering
    );
    const slice = request('fixture-inline-evidenced-missing-dimension');
    slice.requestedDimensions.push('region');
    assert.equal(
      validateReportingSourceFailureV1(await source.execute(slice, context()), 'PARTIAL_RESULT').code,
      'PARTIAL_RESULT'
    );
  });

  test('validates the same row snapshot that is staged', async () => {
    let spendReads = 0;
    const row = new Proxy(
      { media_buy_id: 'fixture-media-buy', impressions: 10 },
      {
        getOwnPropertyDescriptor(target, property) {
          if (property === 'spend') {
            spendReads += 1;
            return spendReads === 1
              ? undefined
              : { configurable: true, enumerable: true, writable: true, value: '999.99' };
          }
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      }
    );
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [row],
        availability_evidence: {
          version: '1.0',
          cells: [
            {
              constituent_id: input.constituents[0].constituent_id,
              metric: 'impressions',
              status: 'present',
              data_through: input.end_date,
            },
            {
              constituent_id: input.constituents[0].constituent_id,
              metric: 'spend',
              status: 'missing',
              reason: 'Provider did not return spend',
            },
          ],
        },
      }),
      redactedReportingSourceOfferingV1
    );
    const slice = request('fixture-inline-single-row-snapshot');
    slice.coverage.expected = 'partial';
    const result = await source.execute(slice, context());
    assert.equal(result.ok, true);
    const manifest = parseVerifiedReportingSourceManifestV1(result.response.manifest, result.manifestBytes, 'basic');
    const object = manifest.objects[0];
    const bytes = await source.read({
      sourceScope: slice.sourceScope,
      account: slice.account,
      delivery_config_id: slice.delivery_config_id,
      delivery_config_version: slice.delivery_config_version,
      report_definition_id: slice.report_definition_id,
      reporting_obligation_id: slice.reporting_obligation_id,
      objectRef: object.objectRef,
      objectGeneration: object.objectGeneration,
      maxBytes: object.byteCount,
      signal: context().signal,
    });
    assert.equal(spendReads, 1);
    assert.equal(Object.hasOwn(JSON.parse(Buffer.from(bytes).toString('utf8').trim()), 'spend'), false);
  });

  test('requires explicit temporal evidence for a partial-period source cutoff', async () => {
    const cutoff = '2026-09-01T12:00:00.000Z';
    const unsupported = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        media_buy_deliveries: [{ media_buy_id: 'fixture-media-buy', totals: { impressions: 10, spend: '1.25' } }],
      }),
      redactedReportingSourceOfferingV1
    );
    const unsupportedSlice = request('fixture-inline-partial-cutoff-unsupported');
    unsupportedSlice.period.sourceReadCutoffAt = cutoff;
    assert.equal(
      validateReportingSourceFailureV1(await unsupported.execute(unsupportedSlice, context()), 'PARTIAL_RESULT').code,
      'PARTIAL_RESULT'
    );

    let receivedCutoff;
    const evidenced = createInlineReportingSourceExecutor(input => {
      receivedCutoff = input.source_read_cutoff_at;
      return {
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        media_buy_deliveries: [{ media_buy_id: 'fixture-media-buy', totals: { impressions: 10, spend: '1.25' } }],
        data_through: input.source_read_cutoff_at,
        observed_at: input.source_read_cutoff_at,
      };
    }, redactedReportingSourceOfferingV1);
    const evidencedSlice = request('fixture-inline-partial-cutoff-evidenced');
    evidencedSlice.period.sourceReadCutoffAt = cutoff;
    const result = await evidenced.execute(evidencedSlice, context());
    assert.equal(result.ok, true);
    assert.equal(receivedCutoff, cutoff);
    const manifest = parseVerifiedReportingSourceManifestV1(result.response.manifest, result.manifestBytes, 'basic');
    assert.equal(manifest.period.dataThrough, cutoff);
  });

  test('accepts row-level currency and projects nested dimension evidence', async () => {
    const offering = structuredClone(redactedReportingSourceOfferingV1);
    offering.dimensions.push({ name: 'region', support: 'exact' });
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        media_buy_deliveries: [
          {
            media_buy_id: 'fixture-media-buy',
            currency: 'USD',
            totals: { region: 'fixture-region', impressions: 10, spend: '1.25' },
          },
        ],
      }),
      offering
    );
    const slice = request('fixture-inline-nested-dimension');
    slice.requestedDimensions.push('region');
    const result = await source.execute(slice, context());
    assert.equal(result.ok, true);
    const manifest = parseVerifiedReportingSourceManifestV1(result.response.manifest, result.manifestBytes, 'basic');
    const object = manifest.objects[0];
    const bytes = await source.read({
      sourceScope: slice.sourceScope,
      account: slice.account,
      delivery_config_id: slice.delivery_config_id,
      delivery_config_version: slice.delivery_config_version,
      report_definition_id: slice.report_definition_id,
      reporting_obligation_id: slice.reporting_obligation_id,
      objectRef: object.objectRef,
      objectGeneration: object.objectGeneration,
      maxBytes: object.byteCount,
      signal: context().signal,
    });
    assert.equal(JSON.parse(Buffer.from(bytes).toString('utf8').trim()).region, 'fixture-region');
  });

  test('preserves legacy fallback from invalid direct fields to valid nested totals', async () => {
    const source = createInlineReportingSourceExecutor(
      () => [
        {
          media_buy_id: 'fixture-media-buy',
          impressions: null,
          totals: { impressions: 10, spend: '1.25' },
        },
      ],
      redactedReportingSourceOfferingV1
    );
    const slice = request('fixture-inline-legacy-nested-fallback');
    const result = await source.execute(slice, context());
    assert.equal(result.ok, true);
    const manifest = parseVerifiedReportingSourceManifestV1(result.response.manifest, result.manifestBytes, 'basic');
    const object = manifest.objects[0];
    const bytes = await source.read({
      sourceScope: slice.sourceScope,
      account: slice.account,
      delivery_config_id: slice.delivery_config_id,
      delivery_config_version: slice.delivery_config_version,
      report_definition_id: slice.report_definition_id,
      reporting_obligation_id: slice.reporting_obligation_id,
      objectRef: object.objectRef,
      objectGeneration: object.objectGeneration,
      maxBytes: object.byteCount,
      signal: context().signal,
    });
    assert.deepEqual(JSON.parse(Buffer.from(bytes).toString('utf8').trim()), {
      media_buy_id: 'fixture-media-buy',
      totals: { impressions: 10, spend: '1.25' },
    });
  });

  test('accepts nonempty rows when every evidenced metric is explicitly zero', async () => {
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 0, spend: '0.00' }],
        availability_evidence: {
          ...presentAvailability(input),
          cells: presentAvailability(input).cells.map(cell => ({
            ...cell,
            status: 'explicit_zero',
          })),
        },
      }),
      redactedReportingSourceOfferingV1
    );
    const manifest = await runReportingSourceReplayConformanceV1({
      level: 'basic',
      executor: source,
      request: request('fixture-inline-row-level-zero'),
      objectReader: source,
    });
    assert.equal(manifest.rowCount, 1);
    assert.equal(manifest.explicitZero, false);
    assert.equal(manifest.coverage.constituents[0].status, 'explicit_zero');
    assert.ok(manifest.metricAvailability.every(cell => cell.status === 'explicit_zero'));
  });

  test('treats [] as an observed zero-row period', async () => {
    const source = createInlineReportingSourceExecutor(async () => [], redactedReportingSourceOfferingV1);
    const slice = request('fixture-inline-zero');
    const manifest = await runReportingSourceReplayConformanceV1({
      level: 'basic',
      executor: source,
      request: slice,
      objectReader: source,
    });
    assert.equal(manifest.rowCount, 0);
    assert.equal(manifest.explicitZero, true);
    assert.equal(manifest.coverage.status, 'full');
  });

  test('does not seal nonterminal handler statuses as zero-row evidence', async () => {
    for (const status of ['working', 'submitted', 'input_required', 'deferred']) {
      const source = createInlineReportingSourceExecutor(
        input => ({
          status,
          reporting_period: { start: input.start_date, end: input.end_date },
          currency: 'USD',
          reporting_rows: [],
        }),
        redactedReportingSourceOfferingV1
      );
      const result = await source.execute(request(`fixture-inline-${status}`), context());
      assert.equal(validateReportingSourceFailureV1(result, 'NOT_READY').code, 'NOT_READY');
    }
  });

  test('rejects offerings whose advertised windows cannot be fetched by date', () => {
    const hourly = structuredClone(redactedReportingSourceOfferingV1);
    hourly.grain = 'source_hour';
    hourly.windowing.minimumWindow = 'PT1H';
    hourly.windowing.maximumWindow = 'PT1H';
    assert.throws(() => createInlineReportingSourceExecutor(() => [], hourly), /whole source-day fixed windows/);
  });

  test('advertises only the one wire format the inline executor emits', () => {
    const offering = structuredClone(redactedReportingSourceOfferingV1);
    offering.formats.unshift({ mediaType: 'text/csv', compression: 'gzip' });
    offering.formats.push({ mediaType: 'application/json', compression: 'none' });
    const source = createInlineReportingSourceExecutor(() => [], offering);

    assert.deepEqual(source.capabilities.offerings[0].formats, [
      { mediaType: 'application/x-ndjson', compression: 'none' },
    ]);
  });

  test('maps null, thrown failures, typed failures, and partial responses', async () => {
    const cases = [
      { fetch: () => null, code: 'NOT_READY' },
      {
        fetch: () => {
          throw new Error('private upstream detail');
        },
        code: 'SOURCE_TRANSIENT',
      },
      {
        fetch: () => {
          throw new InlineReportingSourceError({
            contractVersion: '1.0',
            code: 'RATE_LIMITED',
            retry: 'retryable',
            scope: 'source',
            safeMessage: 'Source rate limit reached',
          });
        },
        code: 'RATE_LIMITED',
      },
      {
        fetch: () => ({ reporting_rows: [], partial_data: true }),
        code: 'PARTIAL_RESULT',
      },
      {
        fetch: () => ({}),
        code: 'SOURCE_PERMANENT',
      },
      {
        fetch: () => ({ reporting_rows: [], pagination: { has_more: true, next_cursor: 'next' } }),
        code: 'PARTIAL_RESULT',
      },
      {
        fetch: input => ({
          reporting_period: { start: input.start_date, end: input.end_date },
          currency: 'USD',
          media_buy_deliveries: [{ media_buy_id: 'different-media-buy', impressions: 1, spend: '0.10' }],
        }),
        code: 'INTEGRITY_FAILED',
      },
      {
        fetch: input => ({
          reporting_period: { start: input.start_date, end: input.end_date },
          currency: 'USD',
          reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 1, spend: '0.10' }],
          media_buy_deliveries: [
            { media_buy_id: 'fixture-media-buy', impressions: 1, spend: '0.10', status: 'unavailable' },
          ],
        }),
        code: 'PARTIAL_RESULT',
      },
      {
        fetch: () => [
          { media_buy_id: 'fixture-media-buy', impressions: 1, spend: '0.10' },
          { media_buy_id: 'unrequested-media-buy', impressions: 1, spend: '0.10' },
          null,
        ],
        code: 'INTEGRITY_FAILED',
      },
      {
        fetch: input => ({
          reporting_period: { start: input.start_date, end: input.end_date },
          currency: 'USD',
          media_buy_deliveries: [{ media_buy_id: 'fixture-media-buy', impressions: 1 }],
        }),
        code: 'PARTIAL_RESULT',
      },
      {
        fetch: () => [{ media_buy_id: 'fixture-media-buy', impressions: false, spend: '0.10' }],
        code: 'PARTIAL_RESULT',
      },
      {
        fetch: () => [{ media_buy_id: 'fixture-media-buy', impressions: 1, spend: {}, status: 'failed' }],
        code: 'PARTIAL_RESULT',
      },
      {
        fetch: input => ({
          status: 'failed',
          reporting_period: { start: input.start_date, end: input.end_date },
          currency: 'USD',
          reporting_rows: [],
        }),
        code: 'SOURCE_TRANSIENT',
      },
      ...['canceled', 'cancelled', 'rejected'].map(status => ({
        fetch: input => ({
          status,
          reporting_period: { start: input.start_date, end: input.end_date },
          currency: 'USD',
          reporting_rows: [],
        }),
        code: 'SOURCE_TRANSIENT',
      })),
      {
        fetch: input => ({
          status: 'unavailable',
          reporting_period: { start: input.start_date, end: input.end_date },
          currency: 'USD',
          reporting_rows: [],
        }),
        code: 'PARTIAL_RESULT',
      },
      {
        fetch: input => ({
          reporting_period: { start: input.start_date, end: input.end_date },
          currency: 'USD',
          media_buy_deliveries: [{ media_buy_id: 'fixture-media-buy', impressions: 1, spend: '0.10', currency: 'EUR' }],
        }),
        code: 'INTEGRITY_FAILED',
      },
    ];
    for (const [index, item] of cases.entries()) {
      const source = createInlineReportingSourceExecutor(item.fetch, redactedReportingSourceOfferingV1);
      const result = await source.execute(request(`fixture-inline-failure-${index}`), context());
      assert.equal(validateReportingSourceFailureV1(result, item.code).code, item.code);
    }
  });

  test('defensively copies replay bytes and enforces staged read bounds', async () => {
    const source = createInlineReportingSourceExecutor(
      () => [{ media_buy_id: 'fixture-media-buy', impressions: 1, spend: '0.10' }],
      redactedReportingSourceOfferingV1
    );
    const slice = request('fixture-inline-defensive-copy');
    const first = await source.execute(slice, context());
    assert.equal(first.ok, true);
    const originalFirstByte = first.manifestBytes[0];
    first.manifestBytes[0] = 0;
    const replay = await source.execute(slice, context());
    assert.equal(replay.ok, true);
    assert.equal(replay.manifestBytes[0], originalFirstByte);
    const manifest = parseVerifiedReportingSourceManifestV1(replay.response.manifest, replay.manifestBytes, 'basic');
    const object = manifest.objects[0];
    await assert.rejects(
      source.read({
        objectRef: object.objectRef,
        objectGeneration: object.objectGeneration,
        sourceScope: slice.sourceScope,
        account: slice.account,
        delivery_config_id: slice.delivery_config_id,
        delivery_config_version: slice.delivery_config_version,
        report_definition_id: slice.report_definition_id,
        reporting_obligation_id: slice.reporting_obligation_id,
        maxBytes: object.byteCount - 1,
        signal: context().signal,
      }),
      /exceeds maxBytes/
    );
    await assert.rejects(
      source.read({
        objectRef: object.objectRef,
        objectGeneration: object.objectGeneration,
        sourceScope: slice.sourceScope,
        account: slice.account,
        delivery_config_id: slice.delivery_config_id,
        delivery_config_version: slice.delivery_config_version,
        report_definition_id: slice.report_definition_id,
        reporting_obligation_id: slice.reporting_obligation_id,
        maxBytes: Number.NaN,
        signal: context().signal,
      }),
      /nonnegative safe integer/
    );
  });

  test('replays across lease metadata changes but rejects semantic key reuse', async () => {
    let calls = 0;
    const source = createInlineReportingSourceExecutor(() => {
      calls += 1;
      return [{ media_buy_id: 'fixture-media-buy', impressions: 1, spend: '0.10' }];
    }, redactedReportingSourceOfferingV1);
    const original = request('fixture-inline-semantic-replay');
    const first = await source.execute(original, context());
    assert.equal(first.ok, true);

    const retry = structuredClone(original);
    retry.trigger = { kind: 'retry', id: 'fixture-retry' };
    retry.deadline.deadlineAt = '2099-09-03T00:00:00.000Z';
    retry.deadline.cancellationIdentity = 'fixture-retry-cancel';
    const replay = await source.execute(retry, context());
    assert.equal(replay.ok, true);
    assert.deepEqual(replay.manifestBytes, first.manifestBytes);

    const conflict = structuredClone(original);
    conflict.requestedMetrics = ['impressions'];
    const rejected = await source.execute(conflict, context());
    assert.equal(validateReportingSourceFailureV1(rejected, 'INTEGRITY_FAILED').code, 'INTEGRITY_FAILED');
    assert.equal(calls, 1);
  });

  test('normalizes explicitly undefined optional fields before replay hashing', async () => {
    let calls = 0;
    const source = createInlineReportingSourceExecutor(() => {
      calls += 1;
      return [];
    }, redactedReportingSourceOfferingV1);
    const explicit = request('fixture-inline-explicit-undefined');
    explicit.finality.supersedesPublicationId = undefined;
    const first = await source.execute(explicit, context());
    const omitted = request('fixture-inline-explicit-undefined');
    const replay = await source.execute(omitted, context());
    assert.equal(first.ok, true);
    assert.equal(replay.ok, true);
    assert.deepEqual(replay.manifestBytes, first.manifestBytes);
    assert.equal(calls, 1);
  });

  test('registers a replay before invoking synchronously re-entrant adopter code', async () => {
    let nested;
    let calls = 0;
    const slice = request('fixture-inline-reentrant');
    let source;
    source = createInlineReportingSourceExecutor(() => {
      calls += 1;
      nested = source.execute(slice, context());
      return [{ media_buy_id: 'fixture-media-buy', impressions: 1, spend: '0.10' }];
    }, redactedReportingSourceOfferingV1);
    const outer = await source.execute(slice, context());
    const replay = await nested;
    assert.equal(calls, 1);
    assert.equal(outer.ok, true);
    assert.deepEqual(replay.manifestBytes, outer.manifestBytes);
  });

  test('does not let one joined caller cancel another', async () => {
    let finish;
    let input;
    const source = createInlineReportingSourceExecutor(received => {
      input = received;
      return new Promise(resolve => {
        finish = () =>
          resolve({
            reporting_period: { start: input.start_date, end: input.end_date },
            currency: 'USD',
            media_buy_deliveries: [{ media_buy_id: 'fixture-media-buy', totals: { impressions: 1, spend: '0.10' } }],
          });
      });
    }, redactedReportingSourceOfferingV1);
    const slice = request('fixture-inline-independent-cancel');
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = source.execute(slice, { signal: firstController.signal });
    const second = source.execute(slice, { signal: secondController.signal });
    firstController.abort();
    assert.equal(validateReportingSourceFailureV1(await first, 'CANCELLED').code, 'CANCELLED');
    finish();
    assert.equal((await second).ok, true);
  });

  test('proves full cells even when the caller only expected partial coverage', async () => {
    const source = createInlineReportingSourceExecutor(
      () => [{ media_buy_id: 'fixture-media-buy', impressions: 1, spend: '0.10' }],
      redactedReportingSourceOfferingV1
    );
    const slice = request('fixture-inline-partial-expected');
    slice.coverage.expected = 'partial';
    const manifest = await runReportingSourceReplayConformanceV1({
      level: 'basic',
      executor: source,
      request: slice,
      objectReader: source,
    });
    assert.equal(manifest.coverage.status, 'full');
  });

  test('requires declared finality before sealing authoritative rows', async () => {
    const { cadence, ...offeringBase } = redactedReportingSourceOfferingV1;
    const offering = {
      ...offeringBase,
      publicationClass: 'AUTHORITATIVE',
      revisionSemantics: 'official_with_declared_correction_policy',
      finalization: {
        schedule: { sourceLocalReadyTime: '00:00', daysAfterPeriodEnd: 1 },
        expectedAvailabilityLag: 'PT1H',
        worstCaseAvailabilityLag: 'P1D',
        triggerSupport: cadence.triggerSupport,
        correctionWindow: 'P1D',
        correctionPolicy: 'none',
      },
    };
    let ready = false;
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        media_buy_deliveries: [{ media_buy_id: 'fixture-media-buy', totals: { impressions: 1, spend: '0.10' } }],
        data_through: input.end_date,
        observed_at: input.end_date,
        is_final: ready,
        notification_type: ready ? 'final' : 'scheduled',
      }),
      offering
    );
    const slice = request('fixture-inline-authoritative');
    slice.publicationClass = 'AUTHORITATIVE';
    slice.finality = { revisionKind: 'authoritative' };
    const notReady = await source.execute(slice, context());
    assert.equal(validateReportingSourceFailureV1(notReady, 'NOT_READY').code, 'NOT_READY');
    ready = true;
    const manifest = await runReportingSourceReplayConformanceV1({
      level: 'basic',
      executor: source,
      request: slice,
      objectReader: source,
    });
    assert.equal(manifest.finality.evidence.basis, 'source_declared');
  });

  test('rejects authoritative final claims with incomplete or nonfinal metric evidence', async () => {
    const { cadence, ...offeringBase } = redactedReportingSourceOfferingV1;
    const offering = {
      ...offeringBase,
      publicationClass: 'AUTHORITATIVE',
      revisionSemantics: 'official_with_declared_correction_policy',
      finalization: {
        schedule: { sourceLocalReadyTime: '00:00', daysAfterPeriodEnd: 1 },
        expectedAvailabilityLag: 'PT1H',
        worstCaseAvailabilityLag: 'P1D',
        triggerSupport: cadence.triggerSupport,
        correctionWindow: 'P1D',
        correctionPolicy: 'none',
      },
    };
    const cases = [
      {
        code: 'PARTIAL_RESULT',
        mutate: evidence => {
          evidence.cells[1] = {
            constituent_id: 'fixture-constituent',
            metric: 'spend',
            status: 'delayed',
            reason: 'Spend close is delayed',
          };
        },
      },
      {
        code: 'PARTIAL_RESULT',
        mutate: evidence => {
          evidence.cells[1].data_through = '2026-09-01T12:00:00.000Z';
        },
      },
      {
        code: 'INTEGRITY_FAILED',
        mutate: evidence => {
          evidence.cells.pop();
        },
      },
    ];
    for (const [index, item] of cases.entries()) {
      const source = createInlineReportingSourceExecutor(input => {
        const availability_evidence = presentAvailability(input);
        item.mutate(availability_evidence);
        return {
          reporting_period: { start: input.start_date, end: input.end_date },
          currency: 'USD',
          reporting_rows: [
            {
              media_buy_id: 'fixture-media-buy',
              impressions: 1,
              ...(availability_evidence.cells[1]?.status === 'delayed' ? {} : { spend: '0.10' }),
            },
          ],
          data_through: input.end_date,
          observed_at: input.end_date,
          is_final: true,
          notification_type: 'final',
          availability_evidence,
        };
      }, offering);
      const slice = request(`fixture-inline-authoritative-evidence-${index}`);
      slice.publicationClass = 'AUTHORITATIVE';
      slice.finality = { revisionKind: 'authoritative' };
      const result = await source.execute(slice, context());
      assert.equal(validateReportingSourceFailureV1(result, item.code).code, item.code);
    }
  });

  test('rejects requests outside the narrowed inline offering', async () => {
    const source = createInlineReportingSourceExecutor(() => [], redactedReportingSourceOfferingV1);
    const slice = request('fixture-inline-unknown-offering');
    slice.offeringId = 'different-offering';
    const result = await source.execute(slice, context());
    assert.equal(validateReportingSourceFailureV1(result, 'UNSUPPORTED_OFFERING').code, 'UNSUPPORTED_OFFERING');
  });

  test('signals cancellation to the fetch and settles as CANCELLED', async () => {
    let settled = false;
    const source = createInlineReportingSourceExecutor(
      (_input, { signal }) =>
        new Promise(resolve => {
          signal.addEventListener(
            'abort',
            () => {
              settled = true;
              resolve([]);
            },
            { once: true }
          );
        }),
      redactedReportingSourceOfferingV1
    );
    const controller = new AbortController();
    const pending = source.execute(request('fixture-inline-cancel'), { signal: controller.signal });
    controller.abort();
    const result = await pending;
    assert.equal(validateReportingSourceFailureV1(result, 'CANCELLED').code, 'CANCELLED');
    assert.equal(settled, true);
  });

  test('rejects expired deadlines and aborts an owned fetch when its deadline elapses', async () => {
    let calls = 0;
    const expiredSource = createInlineReportingSourceExecutor(() => {
      calls += 1;
      return [];
    }, redactedReportingSourceOfferingV1);
    const expired = request('fixture-inline-expired-deadline');
    expired.deadline.deadlineAt = '2000-01-01T00:00:00.000Z';
    assert.equal(
      validateReportingSourceFailureV1(await expiredSource.execute(expired, context()), 'DEADLINE_EXCEEDED').code,
      'DEADLINE_EXCEEDED'
    );
    assert.equal(calls, 0);

    let settled = false;
    const source = createInlineReportingSourceExecutor(
      (_input, { signal }) =>
        new Promise(resolve =>
          signal.addEventListener(
            'abort',
            () => {
              settled = true;
              resolve([]);
            },
            { once: true }
          )
        ),
      redactedReportingSourceOfferingV1
    );
    const slice = request('fixture-inline-mid-fetch-deadline');
    slice.deadline.deadlineAt = new Date(Date.now() + 25).toISOString();
    const result = await source.execute(slice, context());
    assert.equal(validateReportingSourceFailureV1(result, 'DEADLINE_EXCEEDED').code, 'DEADLINE_EXCEEDED');
    assert.equal(settled, true);
  });

  test('rejects synchronous work that blocks past its absolute deadline', async () => {
    let calls = 0;
    const source = createInlineReportingSourceExecutor(() => {
      calls += 1;
      const until = Date.now() + 30;
      while (Date.now() < until) {
        // Deliberately block so the deadline timer cannot run.
      }
      return [];
    }, redactedReportingSourceOfferingV1);
    const slice = request('fixture-inline-sync-deadline-overrun');
    slice.deadline.deadlineAt = new Date(Date.now() + 10).toISOString();
    const result = await source.execute(slice, context());
    assert.equal(validateReportingSourceFailureV1(result, 'DEADLINE_EXCEEDED').code, 'DEADLINE_EXCEEDED');
    assert.equal(calls, 1);
    const retry = structuredClone(slice);
    retry.deadline.deadlineAt = new Date(Date.now() + 100).toISOString();
    assert.equal((await source.execute(retry, context())).ok, true, 'failed work is not sealed for replay');
    assert.equal(calls, 2);
  });

  test('cancels owned work when the caller aborts synchronously inside the fetch', async () => {
    const controller = new AbortController();
    let ownedSignal;
    const source = createInlineReportingSourceExecutor((_input, { signal }) => {
      ownedSignal = signal;
      controller.abort();
      return new Promise(resolve => signal.addEventListener('abort', () => resolve([]), { once: true }));
    }, redactedReportingSourceOfferingV1);
    const result = await source.execute(request('fixture-inline-sync-cancel'), { signal: controller.signal });
    assert.equal(validateReportingSourceFailureV1(result, 'CANCELLED').code, 'CANCELLED');
    assert.equal(ownedSignal.aborted, true);
  });

  test('isolates replay capacity by scope and continues to serve admitted replays', async () => {
    const source = createInlineReportingSourceExecutor(() => [], redactedReportingSourceOfferingV1);
    const admitted = request('fixture-inline-capacity-0');
    assert.equal((await source.execute(admitted, context())).ok, true);
    for (let index = 1; index < 100; index += 1) {
      assert.equal((await source.execute(request(`fixture-inline-capacity-${index}`), context())).ok, true);
    }
    const exhausted = await source.execute(request('fixture-inline-capacity-exhausted'), context());
    assert.equal(validateReportingSourceFailureV1(exhausted, 'QUOTA_EXHAUSTED').code, 'QUOTA_EXHAUSTED');
    assert.equal((await source.execute(admitted, context())).ok, true, 'an admitted key remains replayable');

    const otherScope = request('fixture-inline-other-scope');
    otherScope.sourceScope = { tenant: 'fixture-other-scope' };
    assert.equal((await source.execute(otherScope, context())).ok, true, 'another scope has independent capacity');
  });

  test('does not retain failed executions against replay capacity', async () => {
    let ready = false;
    const source = createInlineReportingSourceExecutor(() => (ready ? [] : null), redactedReportingSourceOfferingV1);
    for (let index = 0; index < 105; index += 1) {
      const result = await source.execute(request(`fixture-inline-not-ready-${index}`), context());
      assert.equal(validateReportingSourceFailureV1(result, 'NOT_READY').code, 'NOT_READY');
    }
    ready = true;
    assert.equal((await source.execute(request('fixture-inline-recovered'), context())).ok, true);
  });

  test('bounds sparse row-by-cell availability verification work', async () => {
    const offering = structuredClone(redactedReportingSourceOfferingV1);
    for (let index = offering.metrics.length; index < 1_000; index += 1) {
      offering.metrics.push({
        ...offering.metrics[0],
        name: `metric_${String(index).padStart(4, '0')}`,
        semanticContractId: `delivery.metric_${String(index).padStart(4, '0')}`,
      });
    }
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: Array(5_001).fill({ media_buy_id: 'fixture-media-buy' }),
        availability_evidence: {
          version: '1.0',
          cells: input.requested_metrics.map(metric => ({
            constituent_id: input.constituents[0].constituent_id,
            metric,
            status: 'partial',
            reason: 'Provider returned partial data',
          })),
        },
      }),
      offering
    );
    const slice = request('fixture-inline-row-cell-cap');
    slice.requestedMetrics = offering.metrics.map(metric => metric.name);
    slice.coverage.expected = 'partial';
    const result = await source.execute(slice, context());
    assert.equal(validateReportingSourceFailureV1(result, 'QUOTA_EXHAUSTED').code, 'QUOTA_EXHAUSTED');
  });

  test('classifies a bounded but oversized availability manifest as quota exhaustion', async () => {
    const offering = structuredClone(redactedReportingSourceOfferingV1);
    for (let index = offering.metrics.length; index < 1_000; index += 1) {
      offering.metrics.push({
        ...offering.metrics[0],
        name: `metric_${String(index).padStart(4, '0')}`,
        semanticContractId: `delivery.metric_${String(index).padStart(4, '0')}.${'x'.repeat(180)}`,
        semanticContractVersion: 'v'.repeat(128),
      });
    }
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [],
        availability_evidence: {
          version: '1.0',
          cells: input.requested_metrics.map(metric => ({
            constituent_id: input.constituents[0].constituent_id,
            metric,
            status: 'unsupported',
            reason: 'x'.repeat(512),
          })),
        },
      }),
      offering
    );
    const slice = request('fixture-inline-manifest-cap');
    slice.requestedMetrics = offering.metrics.map(metric => metric.name);
    slice.coverage.expected = 'partial';
    const result = await source.execute(slice, context());
    assert.equal(validateReportingSourceFailureV1(result, 'QUOTA_EXHAUSTED').code, 'QUOTA_EXHAUSTED');
  });

  test('rejects oversized scalar evidence before JSON serialization', async () => {
    const source = createInlineReportingSourceExecutor(
      () => [{ media_buy_id: 'fixture-media-buy', impressions: 1, spend: 'x'.repeat(6 * 1024 * 1024) }],
      redactedReportingSourceOfferingV1
    );
    const result = await source.execute(request('fixture-inline-scalar-cap'), context());
    assert.equal(validateReportingSourceFailureV1(result, 'STAGING_FAILED').code, 'STAGING_FAILED');
  });

  // Shared-media-buy slice with `constituentCount` constituents and tunable metric and
  // dimension breadth. The offering is widened to declare whatever is requested.
  function fanoutFixture({ key, constituentCount, rowCount, metricCount = 1, dimensionCount = 1, rowFor }) {
    const offering = structuredClone(redactedReportingSourceOfferingV1);
    const metrics = ['impressions', 'spend'].slice(0, Math.min(metricCount, 2));
    for (let index = metrics.length; index < metricCount; index += 1) {
      const name = `metric_${String(index).padStart(4, '0')}`;
      offering.metrics.push({ ...offering.metrics[0], name, semanticContractId: `delivery.${name}` });
      metrics.push(name);
    }
    const dimensions = ['media_buy_id'];
    for (let index = 1; index < dimensionCount; index += 1) {
      const name = `dimension_${String(index).padStart(4, '0')}`;
      offering.dimensions.push({ name, support: 'exact' });
      dimensions.push(name);
    }

    const slice = request(key);
    const base = slice.coverage.constituents[0];
    slice.requestedMetrics = metrics;
    slice.requestedDimensions = dimensions;
    slice.coverage.constituents = Array.from({ length: constituentCount }, (unused, index) => ({
      ...base,
      constituentId: `fixture-constituent-${String(index).padStart(4, '0')}`,
    }));
    slice.coverage.denominatorFingerprint = reportingCoverageDenominatorFingerprintV1(slice.coverage.constituents);

    const buildRow =
      rowFor ??
      (() => {
        const row = { media_buy_id: 'fixture-media-buy' };
        for (const metric of metrics) row[metric] = 10;
        for (const dimension of dimensions.slice(1)) row[dimension] = 'value';
        return row;
      });
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: Array.from({ length: rowCount }, (unused, index) => buildRow(index)),
        availability_evidence: {
          version: '1.0',
          cells: input.constituents.flatMap(constituent =>
            input.requested_metrics.map(metric => ({
              constituent_id: constituent.constituent_id,
              metric,
              status: 'present',
              data_through: input.end_date,
            }))
          ),
        },
      }),
      offering
    );
    return { source, slice };
  }

  // Widen the offering so `metricCount` metrics and `dimensionCount` dimensions are exact.
  function widenedOffering(metricCount, dimensionCount) {
    const offering = structuredClone(redactedReportingSourceOfferingV1);
    const metrics = ['impressions', 'spend'].slice(0, Math.min(metricCount, 2));
    for (let index = metrics.length; index < metricCount; index += 1) {
      const name = `metric_${String(index).padStart(4, '0')}`;
      offering.metrics.push({ ...offering.metrics[0], name, semanticContractId: `delivery.${name}` });
      metrics.push(name);
    }
    const dimensions = ['media_buy_id'];
    for (let index = 1; index < dimensionCount; index += 1) {
      const name = `dimension_${String(index).padStart(4, '0')}`;
      offering.dimensions.push({ name, support: 'exact' });
      dimensions.push(name);
    }
    return { offering, metrics, dimensions };
  }

  function peakHeapWatcher() {
    if (global.gc) global.gc();
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }, 4);
    return () => {
      clearInterval(timer);
      peak = Math.max(peak, process.memoryUsage().heapUsed);
      return (peak - before) / 1024 / 1024;
    };
  }

  test('admits the collection length it counted', async () => {
    // Length was read to admit the collection and read again to copy it. A collection
    // answering five and then zero had five real rows sealed as an observed empty period:
    // rowCount 0, explicit zero, coverage full.
    let lengthReads = 0;
    const source = createInlineReportingSourceExecutor(input => {
      const backing = Array.from({ length: 5 }, () => ({
        media_buy_id: 'fixture-media-buy',
        impressions: 10,
        spend: '1.25',
      }));
      const rows = new Proxy(backing, {
        get(target, property, receiver) {
          if (property === 'length') {
            lengthReads += 1;
            return lengthReads === 1 ? 5 : 0;
          }
          return Reflect.get(target, property, receiver);
        },
      });
      return {
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: rows,
      };
    }, redactedReportingSourceOfferingV1);
    const result = await source.execute(request('fixture-inline-length-restated'), context());
    assert.equal(lengthReads, 1, 'the collection length is observed exactly once');
    assert.equal(result.ok, true);
    const manifest = parseVerifiedReportingSourceManifestV1(result.response.manifest, result.manifestBytes, 'basic');
    // The five rows that were admitted are the five rows that are staged.
    assert.equal(manifest.objects[0].rowCount, 5);
    assert.ok(manifest.metricAvailability.every(cell => cell.status === 'present'));
  });

  test('resolves requested reserved field names from the reserved observation', async () => {
    // `currency` and `status` are read for the adapter's own checks. When one of them is
    // also a requested dimension it was read a second time, so a row could validate `USD`
    // and stage `EUR`, or pass the unavailable check and stage `failed`.
    for (const [index, item] of [
      { field: 'currency', first: 'USD', second: 'EUR' },
      { field: 'status', first: 'delivered', second: 'failed' },
    ].entries()) {
      let reads = 0;
      const offering = structuredClone(redactedReportingSourceOfferingV1);
      offering.dimensions.push({ name: item.field, support: 'exact' });
      const source = createInlineReportingSourceExecutor(
        () => [
          new Proxy(
            { media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' },
            {
              getOwnPropertyDescriptor(target, property) {
                if (property !== item.field) return Reflect.getOwnPropertyDescriptor(target, property);
                reads += 1;
                return {
                  configurable: true,
                  enumerable: true,
                  writable: true,
                  value: reads === 1 ? item.first : item.second,
                };
              },
            }
          ),
        ],
        offering
      );
      const slice = request(`fixture-inline-reserved-dimension-${index}`);
      slice.requestedDimensions = ['media_buy_id', item.field];
      const result = await source.execute(slice, context());
      assert.equal(reads, 1, `${item.field} is observed exactly once`);
      assert.equal(result.ok, true, `${item.field} dimension seals`);
      const object = parseVerifiedReportingSourceManifestV1(result.response.manifest, result.manifestBytes, 'basic')
        .objects[0];
      const staged = JSON.parse(
        Buffer.from(
          await source.read({
            sourceScope: slice.sourceScope,
            account: slice.account,
            delivery_config_id: slice.delivery_config_id,
            delivery_config_version: slice.delivery_config_version,
            report_definition_id: slice.report_definition_id,
            reporting_obligation_id: slice.reporting_obligation_id,
            objectRef: object.objectRef,
            objectGeneration: object.objectGeneration,
            maxBytes: object.byteCount,
            signal: context().signal,
          })
        )
          .toString('utf8')
          .trim()
      );
      // The value the adapter validated is the value it stages.
      assert.equal(staged[item.field], item.first, `${item.field} stages its validated observation`);
    }
  });

  test('proves each period boundary from one observation', async () => {
    // A boundary was read for presence, then for its type, then for its value, so a
    // getter could answer with rubbish twice and the requested date on the third read.
    let startReads = 0;
    const source = createInlineReportingSourceExecutor(input => {
      const period = {};
      Object.defineProperty(period, 'start', {
        enumerable: true,
        get: () => {
          startReads += 1;
          return startReads <= 2 ? 'not-a-date' : input.start_date;
        },
      });
      Object.defineProperty(period, 'end', { enumerable: true, value: input.end_date });
      return {
        reporting_period: period,
        currency: 'USD',
        reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' }],
      };
    }, redactedReportingSourceOfferingV1);
    const result = await source.execute(request('fixture-inline-period-boundary-reads'), context());
    assert.equal(startReads, 1, 'each period boundary is observed exactly once');
    assert.equal(validateReportingSourceFailureV1(result, 'PARTIAL_RESULT').code, 'PARTIAL_RESULT');
  });

  test('fails closed on present but malformed control fields', async () => {
    // Narrowing a malformed control field to its absent form admitted responses that used
    // to fail closed.
    for (const [index, item] of [
      { patch: { unavailable_count: '5' }, code: 'PARTIAL_RESULT' },
      { patch: { errors: 'boom' }, code: 'PARTIAL_RESULT' },
      { patch: { partial_data: 'yes' }, code: 'PARTIAL_RESULT' },
      { patch: { data_through: 1_764_633_600_000, observed_at: 1_764_633_600_000 }, code: 'SOURCE_PERMANENT' },
    ].entries()) {
      const source = createInlineReportingSourceExecutor(
        input => ({
          reporting_period: { start: input.start_date, end: input.end_date },
          currency: 'USD',
          reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' }],
          ...item.patch,
        }),
        redactedReportingSourceOfferingV1
      );
      const result = await source.execute(request(`fixture-inline-malformed-control-${index}`), context());
      assert.equal(
        validateReportingSourceFailureV1(result, item.code).code,
        item.code,
        `${JSON.stringify(item.patch)} fails closed`
      );
    }
  });

  test('reconciles a contradictory duplicate claim before projecting', async () => {
    // The contradiction was detected at capture but only acted on during projection, so
    // an unrelated row exhausting the staging budget first reported STAGING_FAILED and
    // the contradiction went unreported.
    const wide = 'x'.repeat(60);
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [
          ...Array.from({ length: 50_000 }, () => ({
            media_buy_id: 'fixture-media-buy',
            impressions: wide,
            spend: wide,
          })),
          { media_buy_id: 'fixture-media-buy', impressions: 10, spend: 1, totals: { spend: 2 } },
        ],
        availability_evidence: presentAvailability(input),
      }),
      redactedReportingSourceOfferingV1
    );
    const result = await source.execute(request('fixture-inline-contradiction-before-projection'), context());
    assert.equal(validateReportingSourceFailureV1(result, 'INTEGRITY_FAILED').code, 'INTEGRITY_FAILED');
  });

  test('settles strict coverage before spending the staging budget', async () => {
    // A `delayed` cell means the requested coverage is not proven, which is a retryable
    // partial result. Projecting first turned the identical verdict terminal as soon as
    // the rows were wide enough to exhaust the budget.
    const evidencedSource = impressions =>
      createInlineReportingSourceExecutor(
        input => ({
          reporting_period: { start: input.start_date, end: input.end_date },
          currency: 'USD',
          reporting_rows: Array.from({ length: 4 }, () => ({
            media_buy_id: 'fixture-media-buy',
            impressions,
          })),
          availability_evidence: {
            version: '1.0',
            cells: [
              {
                constituent_id: input.constituents[0].constituent_id,
                metric: 'impressions',
                status: 'present',
                data_through: input.end_date,
              },
              {
                constituent_id: input.constituents[0].constituent_id,
                metric: 'spend',
                status: 'delayed',
                reason: 'Provider processing is not closed',
              },
            ],
          },
        }),
        redactedReportingSourceOfferingV1
      );
    // The small response earns PARTIAL_RESULT from its own evidence.
    assert.equal(
      validateReportingSourceFailureV1(
        await evidencedSource('10').execute(request('fixture-inline-strict-coverage-small'), context()),
        'PARTIAL_RESULT'
      ).code,
      'PARTIAL_RESULT'
    );
    // The equivalent response with rows wide enough to exhaust projection earns the same.
    assert.equal(
      validateReportingSourceFailureV1(
        await evidencedSource('x'.repeat(1_500_000)).execute(request('fixture-inline-strict-coverage-wide'), context()),
        'PARTIAL_RESULT'
      ).code,
      'PARTIAL_RESULT'
    );
  });

  test('never projects the auxiliary collection it does not stage', async () => {
    // The auxiliary collection is validated from its captured claims and never staged, so
    // projecting it charged a budget against values nothing reads: 20,000 valid auxiliary
    // rows failed a response whose staged object is under a hundred bytes.
    const auxiliaryValue = 'y'.repeat(280);
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' }],
        media_buy_deliveries: Array.from({ length: 20_000 }, () => ({
          media_buy_id: 'fixture-media-buy',
          impressions: auxiliaryValue,
          spend: auxiliaryValue,
        })),
        availability_evidence: presentAvailability(input),
      }),
      redactedReportingSourceOfferingV1
    );
    const result = await source.execute(request('fixture-inline-auxiliary-not-projected'), context());
    assert.equal(result.ok, true, 'auxiliary rows are validated without being projected');
    const manifest = parseVerifiedReportingSourceManifestV1(result.response.manifest, result.manifestBytes, 'basic');
    assert.equal(manifest.objects[0].rowCount, 1);
    assert.ok(
      manifest.objects[0].byteCount < 1_024,
      `staged ${manifest.objects[0].byteCount} bytes, so the auxiliary rows were never staged`
    );
    assert.equal(manifest.coverage.status, 'full');
  });

  test('settles semantic verdicts before spending the staging budget', async () => {
    // Projecting first spent the staging budget proving nothing: an incomplete response
    // came back terminal STAGING_FAILED instead of the retryable PARTIAL_RESULT its
    // incompleteness earns, and an out-of-scope row was masked the same way. The values
    // are wide enough that projecting 100,000 of them exhausts the budget.
    const wide = 'x'.repeat(60);
    const incomplete = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        // `spend` is requested but never supplied.
        reporting_rows: Array.from({ length: 100_000 }, () => ({
          media_buy_id: 'fixture-media-buy',
          impressions: wide,
        })),
      }),
      redactedReportingSourceOfferingV1
    );
    assert.equal(
      validateReportingSourceFailureV1(
        await incomplete.execute(request('fixture-inline-verdict-before-projection'), context()),
        'PARTIAL_RESULT'
      ).code,
      'PARTIAL_RESULT'
    );

    const outOfScope = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: Array.from({ length: 100_000 }, () => ({
          media_buy_id: 'some-other-media-buy',
          impressions: wide,
          spend: wide,
        })),
      }),
      redactedReportingSourceOfferingV1
    );
    assert.equal(
      validateReportingSourceFailureV1(
        await outOfScope.execute(request('fixture-inline-scope-before-projection'), context()),
        'INTEGRITY_FAILED'
      ).code,
      'INTEGRITY_FAILED'
    );
  });

  test('observes the totals slot once across every field of a row', async () => {
    // The slot is latched per row. Without the latch it is observed once per field that
    // needs it, so a stateful descriptor can answer with a contradictory `totals` while
    // one metric is reconciled and an agreeing one while the next is, and the
    // contradiction seals.
    let slotReads = 0;
    const source = createInlineReportingSourceExecutor(input => {
      const row = new Proxy(
        { media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' },
        {
          getOwnPropertyDescriptor(target, property) {
            if (property !== 'totals') return Reflect.getOwnPropertyDescriptor(target, property);
            slotReads += 1;
            return {
              configurable: true,
              enumerable: true,
              writable: true,
              // First answer contradicts `spend`; a second answer would agree with it.
              value: slotReads === 1 ? { spend: '999.99' } : { spend: '1.25' },
            };
          },
        }
      );
      return {
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [row],
        availability_evidence: presentAvailability(input),
      };
    }, redactedReportingSourceOfferingV1);
    const result = await source.execute(request('fixture-inline-totals-latched'), context());
    assert.equal(slotReads, 1, 'the totals slot is observed once for the whole row');
    // The one observation contradicts `spend`, and that verdict stands.
    assert.equal(validateReportingSourceFailureV1(result, 'INTEGRITY_FAILED').code, 'INTEGRITY_FAILED');
  });

  test('treats every spelling of zero as zero, and nothing else', async () => {
    // Duplicate reconciliation compares claims as exact decimals, so `"00"` and `"0"` are
    // one quantity. Explicit-zero detection recognized only a single leading zero, so the
    // two rules disagreed: `"00"` sealed as a duplicate of `"0"` under a `present` cell
    // yet was refused under an `explicit_zero` one.
    const zeroCell = (input, status) => ({
      version: '1.0',
      cells: input.requested_metrics.map(metric => ({
        constituent_id: input.constituents[0].constituent_id,
        metric,
        status: metric === 'impressions' ? status : 'present',
        data_through: input.end_date,
      })),
    });
    const evidenced = (impressions, nested, status) =>
      createInlineReportingSourceExecutor(
        input => ({
          reporting_period: { start: input.start_date, end: input.end_date },
          currency: 'USD',
          reporting_rows: [
            {
              media_buy_id: 'fixture-media-buy',
              impressions,
              spend: '1.25',
              ...(nested === undefined ? {} : { totals: { impressions: nested } }),
            },
          ],
          availability_evidence: zeroCell(input, status),
        }),
        redactedReportingSourceOfferingV1
      );

    // Every spelling of zero satisfies an explicit-zero cell, alone or as a duplicate.
    for (const [index, item] of [
      { impressions: '0', nested: undefined },
      { impressions: '00', nested: undefined },
      { impressions: '000', nested: undefined },
      { impressions: '0.0', nested: undefined },
      { impressions: '000.000', nested: undefined },
      { impressions: '-00', nested: undefined },
      { impressions: 0, nested: undefined },
      { impressions: '00', nested: '0' },
      { impressions: '0', nested: '00.00' },
      { impressions: 0, nested: '000' },
    ].entries()) {
      const result = await evidenced(item.impressions, item.nested, 'explicit_zero').execute(
        request(`fixture-inline-zero-spelling-${index}`),
        context()
      );
      assert.equal(
        result.ok,
        true,
        `explicit_zero accepts ${JSON.stringify(item.impressions)}${item.nested === undefined ? '' : ` with totals ${JSON.stringify(item.nested)}`}`
      );
      const manifest = parseVerifiedReportingSourceManifestV1(result.response.manifest, result.manifestBytes, 'basic');
      assert.equal(manifest.metricAvailability.find(cell => cell.metric === 'impressions').status, 'explicit_zero');
    }

    // Nothing that is not zero is admitted, however it is spelled.
    for (const [index, item] of [
      { impressions: '0.1' },
      { impressions: '01' },
      { impressions: '00.1' },
      { impressions: '10' },
      { impressions: '-0.01' },
      { impressions: 1e-7 },
    ].entries()) {
      assert.equal(
        validateReportingSourceFailureV1(
          await evidenced(item.impressions, undefined, 'explicit_zero').execute(
            request(`fixture-inline-zero-nonzero-${index}`),
            context()
          ),
          'INTEGRITY_FAILED'
        ).code,
        'INTEGRITY_FAILED',
        `explicit_zero refuses ${JSON.stringify(item.impressions)}`
      );
    }

    // The same spellings still reconcile as one quantity under a present cell, so the two
    // rules now agree in both directions.
    const present = await evidenced('00', '0', 'present').execute(
      request('fixture-inline-zero-present-duplicate'),
      context()
    );
    assert.equal(present.ok, true, 'a zero duplicate still reconciles under a present cell');
  });

  test('rejects an invalid duplicate claim on an auxiliary row', async () => {
    // A claim that is present must be usable, whichever half of the duplicate it is.
    // Checking only the governing claim let an invalid `totals` value ride along on a
    // valid direct one; projection rejects that on a source row, but the auxiliary
    // collection is validated from its claims and never projected, so nothing saw it.
    const auxiliarySource = nested =>
      createInlineReportingSourceExecutor(
        input => ({
          reporting_period: { start: input.start_date, end: input.end_date },
          currency: 'USD',
          reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' }],
          media_buy_deliveries: [
            { media_buy_id: 'fixture-media-buy', impressions: 10, totals: { impressions: nested } },
          ],
          availability_evidence: presentAvailability(input),
        }),
        redactedReportingSourceOfferingV1
      );
    for (const [index, nested] of [null, {}, [], true].entries()) {
      const result = await auxiliarySource(nested).execute(
        request(`fixture-inline-auxiliary-invalid-nested-${index}`),
        context()
      );
      assert.equal(
        validateReportingSourceFailureV1(result, 'INTEGRITY_FAILED').code,
        'INTEGRITY_FAILED',
        `auxiliary totals.impressions=${JSON.stringify(nested)} is refused`
      );
    }

    // The same shape on a source row is refused too, so both collections agree.
    const sourceRow = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [
          { media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25', totals: { impressions: null } },
        ],
        availability_evidence: presentAvailability(input),
      }),
      redactedReportingSourceOfferingV1
    );
    assert.equal(
      validateReportingSourceFailureV1(
        await sourceRow.execute(request('fixture-inline-source-invalid-nested'), context()),
        'INTEGRITY_FAILED'
      ).code,
      'INTEGRITY_FAILED'
    );

    // A valid duplicate that agrees still seals, so the check is not over-broad.
    const agreeing = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' }],
        media_buy_deliveries: [
          { media_buy_id: 'fixture-media-buy', impressions: 10, totals: { impressions: '10.00' } },
        ],
        availability_evidence: presentAvailability(input),
      }),
      redactedReportingSourceOfferingV1
    );
    const sealed = await agreeing.execute(request('fixture-inline-auxiliary-valid-nested'), context());
    assert.equal(sealed.ok, true, 'an agreeing auxiliary duplicate still seals');
    const manifest = parseVerifiedReportingSourceManifestV1(sealed.response.manifest, sealed.manifestBytes, 'basic');
    assert.equal(manifest.coverage.status, 'full');
  });

  test('checks auxiliary rows against availability evidence', async () => {
    // The auxiliary collection carries claims that evidence must still reconcile. A
    // `media_buy_deliveries` row reporting spend contradicts a `missing` spend cell even
    // when the source rows are silent about it.
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10 }],
        media_buy_deliveries: [{ media_buy_id: 'fixture-media-buy', spend: '1.25' }],
        availability_evidence: {
          version: '1.0',
          cells: [
            {
              constituent_id: input.constituents[0].constituent_id,
              metric: 'impressions',
              status: 'present',
              data_through: input.end_date,
            },
            {
              constituent_id: input.constituents[0].constituent_id,
              metric: 'spend',
              status: 'missing',
              reason: 'Provider did not return spend',
            },
          ],
        },
      }),
      redactedReportingSourceOfferingV1
    );
    const slice = request('fixture-inline-auxiliary-evidence-checked');
    slice.coverage.expected = 'partial';
    const result = await source.execute(slice, context());
    assert.equal(validateReportingSourceFailureV1(result, 'INTEGRITY_FAILED').code, 'INTEGRITY_FAILED');

    // An auxiliary collection that agrees with the evidence still seals.
    const agreeing = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10 }],
        media_buy_deliveries: [{ media_buy_id: 'fixture-media-buy' }],
        availability_evidence: {
          version: '1.0',
          cells: [
            {
              constituent_id: input.constituents[0].constituent_id,
              metric: 'impressions',
              status: 'present',
              data_through: input.end_date,
            },
            {
              constituent_id: input.constituents[0].constituent_id,
              metric: 'spend',
              status: 'missing',
              reason: 'Provider did not return spend',
            },
          ],
        },
      }),
      redactedReportingSourceOfferingV1
    );
    const agreeingSlice = request('fixture-inline-auxiliary-evidence-agrees');
    agreeingSlice.coverage.expected = 'partial';
    const sealed = await agreeing.execute(agreeingSlice, context());
    assert.equal(sealed.ok, true, 'an auxiliary collection consistent with the evidence seals');
  });

  test('observes a response watermark once across every call site', async () => {
    // `data_through` is consulted twice: once to prove temporal evidence exists for a
    // partial-period cutoff, and once as the watermark itself. Without memoization the
    // first answer is checked and the second, unchecked, is what gets sealed.
    let watermarkReads = 0;
    const cutoff = '2026-09-01T12:00:00.000Z';
    const source = createInlineReportingSourceExecutor(input => {
      const response = {
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        media_buy_deliveries: [{ media_buy_id: 'fixture-media-buy', totals: { impressions: 10, spend: '1.25' } }],
        observed_at: input.source_read_cutoff_at,
      };
      Object.defineProperty(response, 'data_through', {
        enumerable: true,
        get: () => {
          watermarkReads += 1;
          // A later answer would move the watermark past the read cutoff unchecked.
          return watermarkReads === 1 ? input.source_read_cutoff_at : input.end_date;
        },
      });
      return response;
    }, redactedReportingSourceOfferingV1);
    const slice = request('fixture-inline-watermark-latched');
    slice.period.sourceReadCutoffAt = cutoff;
    const result = await source.execute(slice, context());
    assert.equal(watermarkReads, 1, 'the response watermark is observed once');
    assert.equal(result.ok, true);
    const manifest = parseVerifiedReportingSourceManifestV1(result.response.manifest, result.manifestBytes, 'basic');
    // The sealed watermark is the one observation, not a later restatement.
    assert.equal(manifest.period.dataThrough, cutoff);
  });

  test('never case-folds an over-long row status', async () => {
    // Every row is examined here -- none of them settles the outcome -- so the length
    // guard is what keeps the work bounded. The longest status this adapter recognizes is
    // seventeen characters, so a two million character one cannot match and is never
    // folded. These 20,000 rows share one status, which is 40 GB of characters to fold:
    // measured at 12.4 s folded against under 100 ms guarded.
    const longStatus = `delivered-${'S'.repeat(2_000_000)}`;
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: Array.from({ length: 20_000 }, () => ({
          media_buy_id: 'fixture-media-buy',
          impressions: 10,
          spend: '1.25',
          status: longStatus,
        })),
      }),
      redactedReportingSourceOfferingV1
    );
    const started = process.hrtime.bigint();
    const result = await source.execute(request('fixture-inline-long-status-guard'), context());
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    // The status is not one the adapter recognizes, so every row is admitted.
    assert.equal(result.ok, true);
    const manifest = parseVerifiedReportingSourceManifestV1(result.response.manifest, result.manifestBytes, 'basic');
    assert.equal(manifest.objects[0].rowCount, 20_000);
    assert.ok(elapsedMs < 3_000, `long-status rows took ${elapsedMs.toFixed(1)}ms`);
  });

  test('charges numeric claims for measuring, not for expanding', async () => {
    // A number is canonicalized into plain decimal only to reconcile a duplicate claim.
    // Charging that expanded width for merely measuring refused direct-only numeric
    // claims that never cost more than a finite check: 100,000 rows over two present
    // cells of `5e-324` were billed 132,400,000 of a 67,108,864 unit budget, though the
    // report sits inside the work, staging and retained bounds.
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: Array.from({ length: 100_000 }, () => ({
          media_buy_id: 'fixture-media-buy',
          impressions: 5e-324,
          spend: 5e-324,
        })),
        availability_evidence: presentAvailability(input),
      }),
      redactedReportingSourceOfferingV1
    );
    const result = await source.execute(request('fixture-inline-numeric-measure-charge'), context());
    assert.equal(result.ok, true, 'direct-only numeric claims are charged for measuring alone');
    const manifest = parseVerifiedReportingSourceManifestV1(result.response.manifest, result.manifestBytes, 'basic');
    assert.equal(manifest.objects[0].rowCount, 100_000);
    assert.equal(manifest.coverage.status, 'full');

    // A duplicate numeric claim still pays the expansion, so the bound it protects holds.
    const duplicated = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: Array.from({ length: 100_000 }, () => ({
          media_buy_id: 'fixture-media-buy',
          impressions: 5e-324,
          spend: 5e-324,
          totals: { impressions: 1e-323, spend: 1e-323 },
        })),
        availability_evidence: presentAvailability(input),
      }),
      redactedReportingSourceOfferingV1
    );
    assert.equal(
      validateReportingSourceFailureV1(
        await duplicated.execute(request('fixture-inline-numeric-expansion-charge'), context()),
        'QUOTA_EXHAUSTED'
      ).code,
      'QUOTA_EXHAUSTED'
    );
  });

  test('leaves totals unread when a direct metric already proves the field', async () => {
    // Without availability evidence a valid direct value settles the metric and `totals`
    // is never consulted. Reading it anyway let a throwing `totals` descriptor fail a
    // legacy response that the direct value had already proven.
    // The counter traps the row's own `totals` descriptor, not reads inside the object:
    // observing the slot at all is the cost, and a throwing descriptor is how a row makes
    // that observation fatal.
    let nestedReads = 0;
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [
          new Proxy(
            { media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' },
            {
              getOwnPropertyDescriptor(target, property) {
                if (property !== 'totals') return Reflect.getOwnPropertyDescriptor(target, property);
                nestedReads += 1;
                throw new Error('totals is not readable');
              },
            }
          ),
        ],
      }),
      redactedReportingSourceOfferingV1
    );
    const result = await source.execute(request('fixture-inline-totals-unread'), context());
    assert.equal(result.ok, true, 'a direct metric proves the field without consulting totals');
    assert.equal(nestedReads, 0, 'totals is not observed once the direct value settles the metric');
    const manifest = parseVerifiedReportingSourceManifestV1(result.response.manifest, result.manifestBytes, 'basic');
    assert.equal(manifest.coverage.status, 'full');
    assert.ok(manifest.metricAvailability.every(cell => cell.status === 'present'));

    // The fallback is unchanged: an invalid direct value still consults `totals`, once.
    let fallbackReads = 0;
    let fallbackSlotReads = 0;
    const fallback = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [
          new Proxy(
            { media_buy_id: 'fixture-media-buy', impressions: 10, spend: {} },
            {
              getOwnPropertyDescriptor(target, property) {
                if (property !== 'totals') return Reflect.getOwnPropertyDescriptor(target, property);
                fallbackSlotReads += 1;
                return {
                  configurable: true,
                  enumerable: true,
                  writable: true,
                  value: new Proxy(
                    { spend: '2.50' },
                    {
                      getOwnPropertyDescriptor(totalsTarget, totalsProperty) {
                        if (totalsProperty === 'spend') fallbackReads += 1;
                        return Reflect.getOwnPropertyDescriptor(totalsTarget, totalsProperty);
                      },
                    }
                  ),
                };
              },
            }
          ),
        ],
      }),
      redactedReportingSourceOfferingV1
    );
    const fell = await fallback.execute(request('fixture-inline-totals-fallback-once'), context());
    assert.equal(fell.ok, true, 'an invalid direct value still falls back to totals');
    assert.equal(fallbackReads, 1, 'the totals fallback is observed exactly once');
    assert.equal(fallbackSlotReads, 1, 'the row totals slot is observed exactly once');

    // With evidence both claims are still read, so a duplicate claim is reconciled
    // rather than silently preferred.
    const contradictory = createInlineReportingSourceExecutor(input => {
      const availability_evidence = presentAvailability(input);
      return {
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [
          { media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25', totals: { spend: '999.99' } },
        ],
        availability_evidence,
      };
    }, redactedReportingSourceOfferingV1);
    assert.equal(
      validateReportingSourceFailureV1(
        await contradictory.execute(request('fixture-inline-totals-still-reconciled'), context()),
        'INTEGRITY_FAILED'
      ).code,
      'INTEGRITY_FAILED'
    );
  });

  test('proves media_buy_id when it is a requested metric', async () => {
    // `media_buy_id` needs no captured claim to serve as a dimension, but as a requested
    // metric it does. Skipping it outright left the metric unproven, so a row that carried
    // exactly what was asked for came back as a retryable partial result.
    const offering = structuredClone(redactedReportingSourceOfferingV1);
    offering.metrics.push({
      ...offering.metrics[0],
      name: 'media_buy_id',
      semanticContractId: 'delivery.media_buy_id',
    });
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [{ media_buy_id: 'fixture-media-buy' }],
      }),
      offering
    );
    const slice = request('fixture-inline-media-buy-id-metric');
    slice.requestedMetrics = ['media_buy_id'];
    const result = await source.execute(slice, context());
    assert.equal(result.ok, true, 'media_buy_id is proven as a requested metric');
    const manifest = parseVerifiedReportingSourceManifestV1(result.response.manifest, result.manifestBytes, 'basic');
    assert.equal(manifest.coverage.status, 'full');
    assert.equal(manifest.metricAvailability.find(cell => cell.metric === 'media_buy_id').status, 'present');
    assert.equal(manifest.objects[0].rowCount, 1);
  });

  test('admits a report the staging cap accepts', async () => {
    // 100,000 rows over 32 short metrics write well inside the 32 MiB staging cap and
    // spend 3,400,000 of the 5,000,000 validation work units. Holding the retained-bytes
    // estimate to the per-scope staging limit refused it from a 33,600,000 byte estimate,
    // rejecting a payload the cap it mirrors admits.
    const offering = structuredClone(redactedReportingSourceOfferingV1);
    const metrics = [];
    for (let index = 0; index < 32; index += 1) {
      const name = `${String.fromCharCode(97 + Math.floor(index / 10))}${index % 10}`;
      offering.metrics.push({ ...offering.metrics[0], name, semanticContractId: `delivery.${name}` });
      metrics.push(name);
    }
    const slice = request('fixture-inline-staging-cap-admits');
    slice.requestedMetrics = metrics;
    const row = { media_buy_id: 'fixture-media-buy' };
    for (const metric of metrics) row[metric] = '1';
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: Array.from({ length: 100_000 }, () => ({ ...row })),
      }),
      offering
    );
    const result = await source.execute(slice, context());
    assert.equal(result.ok, true, 'a report the staging cap admits is not refused for retained state');
    const manifest = parseVerifiedReportingSourceManifestV1(result.response.manifest, result.manifestBytes, 'basic');
    assert.equal(manifest.objects[0].rowCount, 100_000);
    assert.equal(manifest.coverage.status, 'full');
    assert.ok(
      manifest.objects[0].byteCount < 32 * 1024 * 1024,
      `staged ${(manifest.objects[0].byteCount / 1048576).toFixed(1)} MiB, which the cap admits`
    );
  });

  test('does not read response fields a settled status never reaches', async () => {
    // `working` is a retryable not-ready verdict, decided from the status alone. Reading
    // every response field up front let a field no check would have reached -- a throwing
    // `reporting_period` -- turn that verdict terminal.
    let periodReads = 0;
    const source = createInlineReportingSourceExecutor(() => {
      const response = { status: 'working', currency: 'USD', reporting_rows: [] };
      Object.defineProperty(response, 'reporting_period', {
        enumerable: true,
        get: () => {
          periodReads += 1;
          throw new Error('reporting period is not readable');
        },
      });
      return response;
    }, redactedReportingSourceOfferingV1);
    const result = await source.execute(request('fixture-inline-working-period-unread'), context());
    assert.equal(validateReportingSourceFailureV1(result, 'NOT_READY').code, 'NOT_READY');
    assert.equal(periodReads, 0, 'a field no check reaches is never observed');

    // The same holds for `notification_type`, which the finality check only consults when
    // `is_final` has not already proven finality.
    let notificationReads = 0;
    const { cadence, ...offeringBase } = redactedReportingSourceOfferingV1;
    const authoritativeOffering = {
      ...offeringBase,
      publicationClass: 'AUTHORITATIVE',
      revisionSemantics: 'official_with_declared_correction_policy',
      finalization: {
        schedule: { sourceLocalReadyTime: '00:00', daysAfterPeriodEnd: 1 },
        expectedAvailabilityLag: 'PT1H',
        worstCaseAvailabilityLag: 'P1D',
        triggerSupport: cadence.triggerSupport,
        correctionWindow: 'P1D',
        correctionPolicy: 'none',
      },
    };
    const finalSource = createInlineReportingSourceExecutor(input => {
      const response = {
        is_final: true,
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' }],
        data_through: input.end_date,
        observed_at: input.end_date,
      };
      Object.defineProperty(response, 'notification_type', {
        enumerable: true,
        get: () => {
          notificationReads += 1;
          throw new Error('notification type is not readable');
        },
      });
      return response;
    }, authoritativeOffering);
    const authoritative = request('fixture-inline-final-notification-unread');
    authoritative.publicationClass = 'AUTHORITATIVE';
    authoritative.finality = { revisionKind: 'authoritative' };
    const sealed = await finalSource.execute(authoritative, context());
    assert.equal(sealed.ok, true);
    assert.equal(notificationReads, 0, 'notification_type is not read once is_final proves finality');
  });

  test('settles a row from its status before reading partial_data', async () => {
    // A failed row is a retryable partial result decided by its status alone. Reading
    // `partial_data` in the same breath let a throwing descriptor make it terminal.
    let partialDataReads = 0;
    const source = createInlineReportingSourceExecutor(
      () => [
        new Proxy(
          { media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25', status: 'failed' },
          {
            getOwnPropertyDescriptor(target, property) {
              if (property !== 'partial_data') return Reflect.getOwnPropertyDescriptor(target, property);
              partialDataReads += 1;
              throw new Error('partial_data is not readable');
            },
          }
        ),
      ],
      redactedReportingSourceOfferingV1
    );
    const result = await source.execute(request('fixture-inline-failed-row-partial-data'), context());
    assert.equal(validateReportingSourceFailureV1(result, 'PARTIAL_RESULT').code, 'PARTIAL_RESULT');
    assert.equal(partialDataReads, 0, 'a row settled by its status is not read further');

    // A row that its status does not settle is still checked for partial_data.
    const partialSource = createInlineReportingSourceExecutor(
      () => [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25', partial_data: true }],
      redactedReportingSourceOfferingV1
    );
    assert.equal(
      validateReportingSourceFailureV1(
        await partialSource.execute(request('fixture-inline-row-partial-data-flag'), context()),
        'PARTIAL_RESULT'
      ).code,
      'PARTIAL_RESULT'
    );
  });

  test('bounds evidence field length before validating it', async () => {
    // Evidence strings reached the schema unbounded, and a validator whose checks all run
    // still walks a value its length check has already rejected -- so an over-long
    // identifier was split into a code point array before anything refused it.
    const oversized = `fixture-${'c'.repeat(20_000_000)}`;
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' }],
        availability_evidence: {
          version: '1.0',
          cells: input.requested_metrics.map(metric => ({
            constituent_id: oversized,
            metric,
            status: 'present',
            data_through: input.end_date,
          })),
        },
      }),
      redactedReportingSourceOfferingV1
    );
    // The value is built before the window so only the executor's own work is measured.
    const readPeak = peakHeapWatcher();
    const started = process.hrtime.bigint();
    const result = await source.execute(request('fixture-inline-oversized-evidence-field'), context());
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const peakMiB = readPeak();
    assert.equal(validateReportingSourceFailureV1(result, 'INTEGRITY_FAILED').code, 'INTEGRITY_FAILED');
    // Measured at 782 ms and 172 MiB when the value was split into a code point array,
    // and 6 ms and 0.5 MiB once the length gate refuses it first.
    assert.ok(elapsedMs < 250, `oversized evidence field refusal took ${elapsedMs.toFixed(1)}ms`);
    assert.ok(peakMiB < 40, `oversized evidence field refusal peaked at ${peakMiB.toFixed(1)} MiB`);

    // A value just past the schema's own limit is refused without being walked, and a
    // value inside it still validates.
    const boundary = length =>
      createInlineReportingSourceExecutor(
        input => ({
          reporting_period: { start: input.start_date, end: input.end_date },
          currency: 'USD',
          reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' }],
          availability_evidence: {
            version: '1.0',
            cells: input.requested_metrics.map(metric => ({
              constituent_id: `c${'x'.repeat(length - 1)}`,
              metric,
              status: 'present',
              data_through: input.end_date,
            })),
          },
        }),
        redactedReportingSourceOfferingV1
      );
    assert.equal(
      validateReportingSourceFailureV1(
        await boundary(256).execute(request('fixture-inline-evidence-field-256'), context()),
        'INTEGRITY_FAILED'
      ).code,
      'INTEGRITY_FAILED'
    );
    // Within the schema limit the identifier is well formed but is not a requested
    // constituent, so it is refused as out of scope rather than as malformed.
    assert.equal(
      validateReportingSourceFailureV1(
        await boundary(255).execute(request('fixture-inline-evidence-field-255'), context()),
        'INTEGRITY_FAILED'
      ).code,
      'INTEGRITY_FAILED'
    );
  });

  test('fails closed on a malformed response status', async () => {
    // A status that is present but not a string is an unreadable response, not an absent
    // status. Narrowing it to absent let `status: 7` seal alongside otherwise valid rows.
    for (const [index, status] of [7, true, {}, ['failed']].entries()) {
      const source = createInlineReportingSourceExecutor(
        input => ({
          status,
          reporting_period: { start: input.start_date, end: input.end_date },
          currency: 'USD',
          reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' }],
        }),
        redactedReportingSourceOfferingV1
      );
      const result = await source.execute(request(`fixture-inline-malformed-status-${index}`), context());
      assert.equal(
        validateReportingSourceFailureV1(result, 'SOURCE_PERMANENT').code,
        'SOURCE_PERMANENT',
        `status ${JSON.stringify(status)} fails closed`
      );
    }
  });

  test('settles a nonterminal status before reading the row collections', async () => {
    // `working` is a retryable not-ready verdict. Reading the row collections first let a
    // throwing collection getter turn it terminal.
    let rowCollectionReads = 0;
    const source = createInlineReportingSourceExecutor(input => {
      const response = {
        status: 'working',
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
      };
      Object.defineProperty(response, 'reporting_rows', {
        enumerable: true,
        get: () => {
          rowCollectionReads += 1;
          throw new Error('row collection is unavailable');
        },
      });
      return response;
    }, redactedReportingSourceOfferingV1);
    const result = await source.execute(request('fixture-inline-nonterminal-status'), context());
    assert.equal(validateReportingSourceFailureV1(result, 'NOT_READY').code, 'NOT_READY');
    assert.equal(rowCollectionReads, 0, 'the row collection is not read once status settles the outcome');
  });

  test('observes the response status exactly once', async () => {
    // The status was read for the precedence check and again into the response capture,
    // so a status that answered once and then threw turned a valid response terminal.
    let statusReads = 0;
    const source = createInlineReportingSourceExecutor(input => {
      const response = {
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' }],
      };
      Object.defineProperty(response, 'status', {
        enumerable: true,
        get: () => {
          statusReads += 1;
          if (statusReads > 1) throw new Error('status is no longer readable');
          return 'completed';
        },
      });
      return response;
    }, redactedReportingSourceOfferingV1);
    const result = await source.execute(request('fixture-inline-single-status-read'), context());
    assert.equal(statusReads, 1, 'the response status is observed exactly once');
    assert.equal(result.ok, true);
    const manifest = parseVerifiedReportingSourceManifestV1(result.response.manifest, result.manifestBytes, 'basic');
    assert.equal(manifest.coverage.status, 'full');
  });

  test('settles row status before observing any other row field', async () => {
    // A failed row is a retryable partial result. Capturing the row's whole reserved set
    // up front let an unrelated `totals` descriptor make that verdict terminal.
    let totalsReads = 0;
    const source = createInlineReportingSourceExecutor(
      () => [
        new Proxy(
          { media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25', status: 'failed' },
          {
            getOwnPropertyDescriptor(target, property) {
              if (property !== 'totals') return Reflect.getOwnPropertyDescriptor(target, property);
              totalsReads += 1;
              throw new Error('totals is not readable');
            },
          }
        ),
      ],
      redactedReportingSourceOfferingV1
    );
    const result = await source.execute(request('fixture-inline-failed-row-totals'), context());
    assert.equal(validateReportingSourceFailureV1(result, 'PARTIAL_RESULT').code, 'PARTIAL_RESULT');
    assert.equal(totalsReads, 0, 'a failed row is not read beyond its status');
  });

  test('leaves auxiliary claims unread without availability evidence', async () => {
    // Without evidence nothing consults the auxiliary collection's claims, so its metric
    // and dimension descriptors must not be observed or billed. Capturing them made an
    // unused throwing descriptor terminal and wide auxiliary rows exhaust the budget.
    let auxiliaryMetricReads = 0;
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' }],
        media_buy_deliveries: [
          new Proxy(
            { media_buy_id: 'fixture-media-buy' },
            {
              getOwnPropertyDescriptor(target, property) {
                if (property !== 'spend') return Reflect.getOwnPropertyDescriptor(target, property);
                auxiliaryMetricReads += 1;
                throw new Error('auxiliary spend is not readable');
              },
            }
          ),
        ],
      }),
      redactedReportingSourceOfferingV1
    );
    const result = await source.execute(request('fixture-inline-auxiliary-unread'), context());
    assert.equal(result.ok, true, 'a legacy response is not failed by an unused auxiliary claim');
    assert.equal(auxiliaryMetricReads, 0, 'auxiliary claims are not observed without evidence');
    const manifest = parseVerifiedReportingSourceManifestV1(result.response.manifest, result.manifestBytes, 'basic');
    assert.equal(manifest.coverage.status, 'full');

    // The auxiliary collection is still scope-checked from its identity alone.
    const outOfScope = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' }],
        media_buy_deliveries: [{ media_buy_id: 'some-other-media-buy' }],
      }),
      redactedReportingSourceOfferingV1
    );
    assert.equal(
      validateReportingSourceFailureV1(
        await outOfScope.execute(request('fixture-inline-auxiliary-out-of-scope'), context()),
        'INTEGRITY_FAILED'
      ).code,
      'INTEGRITY_FAILED'
    );

    // Auxiliary breadth no longer spends the work budget when nothing reads it.
    const { offering, metrics, dimensions } = widenedOffering(500, 500);
    const wideSlice = request('fixture-inline-auxiliary-width');
    wideSlice.requestedMetrics = metrics;
    wideSlice.requestedDimensions = dimensions;
    const wideRow = { media_buy_id: 'fixture-media-buy' };
    for (const metric of metrics) wideRow[metric] = 1;
    for (const dimension of dimensions.slice(1)) wideRow[dimension] = 'v';
    const wide = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [{ ...wideRow }],
        media_buy_deliveries: Array.from({ length: 4_000 }, () => ({ media_buy_id: 'fixture-media-buy' })),
      }),
      offering
    );
    assert.equal(
      (await wide.execute(wideSlice, context())).ok,
      true,
      'auxiliary rows do not spend the claim budget without evidence'
    );
  });

  test('settles the response status before reading anything else', async () => {
    // A reported failure is a retryable source failure. Capturing the row collections
    // first turned a throwing collection into a terminal verdict instead.
    let rowCollectionReads = 0;
    const source = createInlineReportingSourceExecutor(input => {
      const response = {
        status: 'failed',
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
      };
      Object.defineProperty(response, 'reporting_rows', {
        enumerable: true,
        get: () => {
          rowCollectionReads += 1;
          throw new Error('row collection is unavailable');
        },
      });
      return response;
    }, redactedReportingSourceOfferingV1);
    const result = await source.execute(request('fixture-inline-status-precedence'), context());
    // SOURCE_TRANSIENT is the retryable verdict; SOURCE_PERMANENT would be terminal.
    assert.equal(validateReportingSourceFailureV1(result, 'SOURCE_TRANSIENT').code, 'SOURCE_TRANSIENT');
    assert.equal(rowCollectionReads, 0, 'the row collection is not read once status settles the outcome');
  });

  test('admits a legacy wide-metric report the staging budget accepts', async () => {
    // 100,000 rows over 20 short metrics stages at about 24 MB, well inside the staging
    // budget. Accounting for retained claims as a per-row array pair made the retained
    // bound stricter than the budget it mirrors and refused the report outright.
    // Short metric names keep the staged object inside the budget, which is what makes
    // this report one the adapter has always accepted.
    const offering = structuredClone(redactedReportingSourceOfferingV1);
    const metrics = ['impressions', 'spend'];
    for (let index = metrics.length; index < 20; index += 1) {
      const name = `m${String(index).padStart(2, '0')}`;
      offering.metrics.push({ ...offering.metrics[0], name, semanticContractId: `delivery.${name}` });
      metrics.push(name);
    }
    const slice = request('fixture-inline-legacy-wide-metrics');
    slice.requestedMetrics = metrics;
    const row = { media_buy_id: 'fixture-media-buy' };
    for (const metric of metrics) row[metric] = '1';
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: Array.from({ length: 100_000 }, () => ({ ...row })),
      }),
      offering
    );
    const result = await source.execute(slice, context());
    assert.equal(result.ok, true, 'a report the staging budget accepts is not refused for retained state');
    const manifest = parseVerifiedReportingSourceManifestV1(result.response.manifest, result.manifestBytes, 'basic');
    assert.equal(manifest.objects[0].rowCount, 100_000);
    assert.equal(manifest.coverage.status, 'full');
    assert.ok(
      manifest.objects[0].byteCount < 32 * 1024 * 1024,
      `staged ${(manifest.objects[0].byteCount / 1048576).toFixed(1)} MiB`
    );
  });

  test('validates one observation of each response field', async () => {
    // `currency` was read to test its presence and read again to compare it, so a
    // response naming a foreign currency on the first read and the frozen currency on the
    // second passed a check it should have failed.
    let currencyReads = 0;
    const currencySource = createInlineReportingSourceExecutor(input => {
      const response = {
        reporting_period: { start: input.start_date, end: input.end_date },
        reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' }],
      };
      Object.defineProperty(response, 'currency', {
        enumerable: true,
        get: () => {
          currencyReads += 1;
          return currencyReads === 1 ? 'EUR' : 'USD';
        },
      });
      return response;
    }, redactedReportingSourceOfferingV1);
    const currencyResult = await currencySource.execute(request('fixture-inline-response-currency'), context());
    assert.equal(validateReportingSourceFailureV1(currencyResult, 'INTEGRITY_FAILED').code, 'INTEGRITY_FAILED');
    assert.equal(currencyReads, 1, 'the response currency is observed exactly once');

    // `reporting_period` was read once for presence and once per boundary, so a response
    // could prove its start from one object and its end from another.
    let periodReads = 0;
    const periodSource = createInlineReportingSourceExecutor(input => {
      const response = {
        currency: 'USD',
        reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' }],
      };
      Object.defineProperty(response, 'reporting_period', {
        enumerable: true,
        get: () => {
          periodReads += 1;
          return periodReads <= 2
            ? { start: input.start_date, end: 'not-the-requested-end' }
            : { start: 'not-the-requested-start', end: input.end_date };
        },
      });
      return response;
    }, redactedReportingSourceOfferingV1);
    const periodResult = await periodSource.execute(request('fixture-inline-response-period'), context());
    assert.equal(validateReportingSourceFailureV1(periodResult, 'PARTIAL_RESULT').code, 'PARTIAL_RESULT');
    assert.equal(periodReads, 1, 'the response period is observed exactly once');
  });

  test('reads an aliased totals slot once', async () => {
    // A row whose `totals` is the row itself addresses each metric descriptor twice. The
    // first observation was discarded as invalid and the second was sealed under
    // `totals`, so the value staged was one the row had already denied.
    let spendReads = 0;
    const aliasedRow = () => {
      const target = { media_buy_id: 'fixture-media-buy', impressions: 10 };
      const row = new Proxy(target, {
        getOwnPropertyDescriptor(unusedTarget, property) {
          // `totals` aliases the row, so `totals.spend` addresses the same slot as `spend`.
          if (property === 'totals') {
            return { configurable: true, enumerable: true, writable: true, value: row };
          }
          if (property !== 'spend') return Reflect.getOwnPropertyDescriptor(target, property);
          spendReads += 1;
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: spendReads === 1 ? {} : '999.99',
          };
        },
      });
      return row;
    };
    const source = createInlineReportingSourceExecutor(() => [aliasedRow()], redactedReportingSourceOfferingV1);
    const result = await source.execute(request('fixture-inline-aliased-totals'), context());
    assert.equal(spendReads, 1, 'an aliased totals slot is observed once');
    // That single observation is not a usable value, so the metric stays unproven rather
    // than being satisfied by a second, different answer.
    assert.equal(validateReportingSourceFailureV1(result, 'PARTIAL_RESULT').code, 'PARTIAL_RESULT');
  });

  test('captures row collections by counted index, never by iterator', async () => {
    // A collection may report a length its iterator disagrees with. Spreading ran the
    // iterator, so 150,000 rows were materialized before the row cap rejected them.
    let iteratorCalls = 0;
    let producedValues = 0;
    const source = createInlineReportingSourceExecutor(input => {
      const rows = new Proxy([], {
        get(target, property, receiver) {
          if (property === 'length') return 0;
          if (property === Symbol.iterator) {
            iteratorCalls += 1;
            return function* oversized() {
              for (let index = 0; index < 150_000; index += 1) {
                producedValues += 1;
                yield { media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' };
              }
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
      return {
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: rows,
      };
    }, redactedReportingSourceOfferingV1);
    const slice = request('fixture-inline-iterable-row-collection');
    slice.coverage.expected = 'partial';
    const result = await source.execute(slice, context());
    assert.equal(iteratorCalls, 0, 'the row collection iterator is never run');
    assert.equal(producedValues, 0, 'no row is materialized beyond the counted length');
    // The declared length is what is admitted: zero rows is an observed empty period.
    assert.equal(result.ok, true);
    const manifest = parseVerifiedReportingSourceManifestV1(result.response.manifest, result.manifestBytes, 'basic');
    assert.equal(manifest.objects[0].rowCount, 0);
  });

  test('bounds evidence keys before reading them and requires own-data cells', async () => {
    // An envelope carrying 100,000 unknown keys had a descriptor materialized for each
    // one before validation could reject it.
    let descriptorReads = 0;
    const unknownKeys = Array.from({ length: 100_000 }, (unused, index) => `unknown_${index}`);
    const floodedSource = createInlineReportingSourceExecutor(input => {
      const evidence = new Proxy(
        { version: '1.0', cells: presentAvailability(input).cells },
        {
          ownKeys: () => ['version', 'cells', ...unknownKeys],
          getOwnPropertyDescriptor(target, property) {
            descriptorReads += 1;
            const own = Reflect.getOwnPropertyDescriptor(target, property);
            return own ?? { configurable: true, enumerable: true, writable: true, value: 1 };
          },
        }
      );
      return {
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' }],
        availability_evidence: evidence,
      };
    }, redactedReportingSourceOfferingV1);
    const flooded = await floodedSource.execute(request('fixture-inline-evidence-key-flood'), context());
    assert.equal(validateReportingSourceFailureV1(flooded, 'INTEGRITY_FAILED').code, 'INTEGRITY_FAILED');
    assert.equal(descriptorReads, 0, 'no evidence descriptor is read once the key set is refused');

    // A cell whose `status` is inherited from an accessor was admitted through the get
    // channel; only own data properties may prove a cell.
    let statusReads = 0;
    const inheritedSource = createInlineReportingSourceExecutor(input => {
      const proto = {};
      Object.defineProperty(proto, 'status', {
        enumerable: true,
        get: () => {
          statusReads += 1;
          return 'present';
        },
      });
      const cells = input.constituents.flatMap(constituent =>
        input.requested_metrics.map(metric =>
          Object.create(
            proto,
            Object.getOwnPropertyDescriptors({
              constituent_id: constituent.constituent_id,
              metric,
              data_through: input.end_date,
            })
          )
        )
      );
      return {
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' }],
        availability_evidence: { version: '1.0', cells },
      };
    }, redactedReportingSourceOfferingV1);
    const inherited = await inheritedSource.execute(request('fixture-inline-inherited-cell-status'), context());
    assert.equal(validateReportingSourceFailureV1(inherited, 'INTEGRITY_FAILED').code, 'INTEGRITY_FAILED');
    assert.equal(statusReads, 0, 'an inherited cell accessor is never invoked');
  });

  test('charges every scan pass a retained claim costs', async () => {
    // One claim is scanned for its byte width, tested for zero and canonicalized for the
    // duplicate comparison. Charging a single pass let a 27,000,000 character claim be
    // admitted and then scanned several times over, so the run ended in STAGING_FAILED
    // after the scanning rather than refusing the scan budget up front.
    const reused = `0.${'0'.repeat(27_000_000)}`;
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [
          { media_buy_id: 'fixture-media-buy', impressions: 10, spend: reused, totals: { spend: reused } },
        ],
        availability_evidence: presentAvailability(input),
      }),
      redactedReportingSourceOfferingV1
    );
    const slice = request('fixture-inline-scan-passes');
    slice.coverage.expected = 'partial';
    const started = process.hrtime.bigint();
    const result = await source.execute(slice, context());
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(validateReportingSourceFailureV1(result, 'QUOTA_EXHAUSTED').code, 'QUOTA_EXHAUSTED');
    assert.ok(elapsedMs < 2_000, `scan-pass refusal took ${elapsedMs.toFixed(1)}ms`);
  });

  test('holds captured claims within a bounded footprint', async () => {
    // Rows that identify their media buy and nothing else retain nothing through
    // projection, so the staging budget is untouched and the response is rejected as
    // incomplete -- but the capture still has to hold every requested field of every row.
    // 100,000 rows over 48 requested fields sits inside the work budget and is admitted;
    // what it must not do is amplify. Per-field claim objects in a Map measured about
    // 820 MiB here; one value array and one flag array shared by every row measure 83 MiB.
    const { offering, metrics, dimensions } = widenedOffering(24, 24);
    const slice = request('fixture-inline-capture-footprint');
    slice.requestedMetrics = metrics;
    slice.requestedDimensions = dimensions;
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: Array.from({ length: 100_000 }, () => ({ media_buy_id: 'fixture-media-buy' })),
      }),
      offering
    );
    const readPeak = peakHeapWatcher();
    const result = await source.execute(slice, context());
    const peakMiB = readPeak();
    assert.equal(validateReportingSourceFailureV1(result, 'PARTIAL_RESULT').code, 'PARTIAL_RESULT');
    assert.ok(peakMiB < 300, `captured claims peaked at ${peakMiB.toFixed(0)} MiB`);
  });

  test('stops at the first unavailable row without transforming later statuses', async () => {
    // The first row already decides PARTIAL_RESULT. Capturing every row before checking
    // meant 9,999 more rows were observed, and each shared status was case-folded into a
    // fresh 200,000-character copy on the way.
    let statusReads = 0;
    const sharedStatus = `Delivered-${'S'.repeat(200_000)}`;
    const rowProxy = fields =>
      new Proxy(fields, {
        getOwnPropertyDescriptor(target, property) {
          if (property === 'status') statusReads += 1;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      });
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [
          rowProxy({ media_buy_id: 'fixture-media-buy', status: 'failed', impressions: 1, spend: '1.00' }),
          ...Array.from({ length: 9_999 }, () =>
            rowProxy({ media_buy_id: 'fixture-media-buy', status: sharedStatus, impressions: 1, spend: '1.00' })
          ),
        ],
      }),
      redactedReportingSourceOfferingV1
    );
    const readPeak = peakHeapWatcher();
    const started = process.hrtime.bigint();
    const result = await source.execute(request('fixture-inline-status-short-circuit'), context());
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const peakMiB = readPeak();
    assert.equal(validateReportingSourceFailureV1(result, 'PARTIAL_RESULT').code, 'PARTIAL_RESULT');
    assert.equal(statusReads, 1, 'the run stops at the first row that settles the outcome');
    assert.ok(elapsedMs < 1_000, `status short-circuit took ${elapsedMs.toFixed(1)}ms`);
    assert.ok(peakMiB < 200, `status short-circuit peaked at ${peakMiB.toFixed(0)} MiB`);
  });

  test('charges the canonicalized width of numeric claims', async () => {
    // `String(5e-324)` prints 6 characters but canonicalizes to 326 digits, so a numeric
    // claim charged one unit while scanning hundreds. Duplicate claims across 200 rows and
    // 1,000 metrics were charged about 400,000 units for more than 130,000,000 characters.
    const { offering, metrics } = widenedOffering(1_000, 1);
    const strictSlice = request('fixture-inline-numeric-scan-width');
    strictSlice.requestedMetrics = metrics;
    strictSlice.coverage.expected = 'partial';
    const denormalRows = () =>
      Array.from({ length: 200 }, () => {
        const row = { media_buy_id: 'fixture-media-buy', totals: {} };
        for (const metric of metrics) {
          // Two different denormals: the comparison cannot short-circuit on identity.
          row[metric] = 5e-324;
          row.totals[metric] = 1e-323;
        }
        return row;
      });
    const strictSource = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: denormalRows(),
        availability_evidence: {
          version: '1.0',
          cells: input.requested_metrics.map(metric => ({
            constituent_id: input.constituents[0].constituent_id,
            metric,
            status: 'present',
            data_through: input.end_date,
          })),
        },
      }),
      offering
    );
    const strictStarted = process.hrtime.bigint();
    const refused = await strictSource.execute(strictSlice, context());
    const strictMs = Number(process.hrtime.bigint() - strictStarted) / 1e6;
    assert.equal(validateReportingSourceFailureV1(refused, 'QUOTA_EXHAUSTED').code, 'QUOTA_EXHAUSTED');
    assert.ok(strictMs < 2_000, `numeric width refusal took ${strictMs.toFixed(1)}ms`);

    // Without evidence nothing consults a duplicate-claim comparison, so the legacy path
    // must not canonicalize at all -- it used to reconcile every pair and discard it.
    const legacySlice = request('fixture-inline-numeric-scan-legacy');
    legacySlice.requestedMetrics = metrics;
    const legacySource = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: denormalRows(),
      }),
      offering
    );
    const legacyStarted = process.hrtime.bigint();
    const sealed = await legacySource.execute(legacySlice, context());
    const legacyMs = Number(process.hrtime.bigint() - legacyStarted) / 1e6;
    assert.equal(sealed.ok, true);
    assert.ok(legacyMs < 2_000, `legacy duplicate claims took ${legacyMs.toFixed(1)}ms`);
  });

  test('resolves each row identity from one observation', async () => {
    // The fanout budget read `media_buy_id` from the adopter row and the grouping read it
    // again. A row reporting a unique id on the first read and the shared id afterwards
    // was priced as if it belonged to no constituent and then processed as if it belonged
    // to all of them.
    let identityReads = 0;
    const rowCount = 6_000;
    const { source, slice } = fanoutFixture({
      key: 'fixture-inline-mutable-row-identity',
      constituentCount: 1_000,
      rowCount,
      rowFor: index =>
        new Proxy(
          { media_buy_id: 'fixture-media-buy', impressions: 10 },
          {
            getOwnPropertyDescriptor(target, property) {
              if (property !== 'media_buy_id') return Reflect.getOwnPropertyDescriptor(target, property);
              identityReads += 1;
              return {
                configurable: true,
                enumerable: true,
                writable: true,
                // Unique on the first observation, shared on every later one.
                value: identityReads <= rowCount ? `unpriced-media-buy-${index}` : 'fixture-media-buy',
              };
            },
          }
        ),
    });
    const started = process.hrtime.bigint();
    const result = await source.execute(slice, context());
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    // The one observation reports an unadmitted media buy, so the row is out of scope.
    assert.equal(validateReportingSourceFailureV1(result, 'INTEGRITY_FAILED').code, 'INTEGRITY_FAILED');
    assert.equal(identityReads, rowCount, 'each row identity is observed exactly once');
    assert.ok(elapsedMs < 2_000, `single-observation identity took ${elapsedMs.toFixed(1)}ms`);
  });

  test('charges exactly the validation visits it performs', async () => {
    // 1,000 constituents sharing one media buy, one metric and one dimension: two units
    // per row visit. 2,500 rows is exactly the 5,000,000 unit cap and must be admitted;
    // one row more must not be.
    const atCap = fanoutFixture({
      key: 'fixture-inline-work-cap-at',
      constituentCount: 1_000,
      rowCount: 2_500,
    });
    const sealed = await atCap.source.execute(atCap.slice, context());
    assert.equal(sealed.ok, true, 'a shape landing exactly on the cap is admitted');
    const manifest = parseVerifiedReportingSourceManifestV1(sealed.response.manifest, sealed.manifestBytes, 'basic');
    assert.equal(manifest.coverage.status, 'full');
    assert.equal(manifest.metricAvailability.length, 1_000);

    const overCap = fanoutFixture({
      key: 'fixture-inline-work-cap-over',
      constituentCount: 1_000,
      rowCount: 2_501,
    });
    const refused = await overCap.source.execute(overCap.slice, context());
    assert.equal(validateReportingSourceFailureV1(refused, 'QUOTA_EXHAUSTED').code, 'QUOTA_EXHAUSTED');
  });

  test('prices requested dimensions in the shared fanout budget', async () => {
    // Dimensions are checked per row per constituent just as metrics are, so leaving them
    // out of the budget let one metric stand in for 200 checks per visit.
    const over = fanoutFixture({
      key: 'fixture-inline-dimension-fanout-over',
      constituentCount: 1_000,
      rowCount: 100,
      metricCount: 1,
      dimensionCount: 200,
    });
    const started = process.hrtime.bigint();
    const refused = await over.source.execute(over.slice, context());
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(validateReportingSourceFailureV1(refused, 'QUOTA_EXHAUSTED').code, 'QUOTA_EXHAUSTED');
    assert.ok(elapsedMs < 2_000, `dimension fanout refusal took ${elapsedMs.toFixed(1)}ms`);

    // The same shape inside the budget still seals, with every dimension retained.
    const under = fanoutFixture({
      key: 'fixture-inline-dimension-fanout-under',
      constituentCount: 100,
      rowCount: 10,
      metricCount: 1,
      dimensionCount: 200,
    });
    const sealed = await under.source.execute(under.slice, context());
    assert.equal(sealed.ok, true);
    const manifest = parseVerifiedReportingSourceManifestV1(sealed.response.manifest, sealed.manifestBytes, 'basic');
    assert.equal(manifest.coverage.status, 'full');
    assert.equal(manifest.requestedDimensions.length, 200);
  });

  test('charges reused long claims before scanning them', async () => {
    // One long string reused as the discarded half of a duplicate claim: the retained
    // direct value is a single digit, so the projection budget only ever saw 32 bytes
    // while every row measured and canonicalized two million characters.
    const reused = `0.${'0'.repeat(2_000_000)}`;
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: Array.from({ length: 1_000 }, () => ({
          media_buy_id: 'fixture-media-buy',
          impressions: 10,
          spend: 0,
          totals: { spend: reused },
        })),
        availability_evidence: presentAvailability(input),
      }),
      redactedReportingSourceOfferingV1
    );
    const slice = request('fixture-inline-reused-long-claim');
    slice.coverage.expected = 'partial';
    const started = process.hrtime.bigint();
    const refused = await source.execute(slice, context());
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(validateReportingSourceFailureV1(refused, 'QUOTA_EXHAUSTED').code, 'QUOTA_EXHAUSTED');
    // The scan budget stops after a single staged object's worth of characters; without
    // it every row was scanned in full.
    assert.ok(elapsedMs < 5_000, `reused long claim refusal took ${elapsedMs.toFixed(1)}ms`);

    // An ordinary long decimal is still reconciled exactly and still seals.
    const ordinary = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [
          {
            media_buy_id: 'fixture-media-buy',
            impressions: 10,
            spend: 0.5,
            totals: { spend: `0.5${'0'.repeat(100_000)}` },
          },
        ],
        availability_evidence: presentAvailability(input),
      }),
      redactedReportingSourceOfferingV1
    );
    const sealed = await ordinary.execute(request('fixture-inline-ordinary-long-claim'), context());
    assert.equal(sealed.ok, true);
    const manifest = parseVerifiedReportingSourceManifestV1(sealed.response.manifest, sealed.manifestBytes, 'basic');
    assert.equal(manifest.metricAvailability.find(cell => cell.metric === 'spend').status, 'present');
  });

  test('bounds row-by-cell work across shared constituent fanout', async () => {
    // One media buy backing many constituents multiplies the comparison work by that
    // fanout. The rows x metrics bound never saw it, so a request well inside every
    // declared limit could demand orders of magnitude more work than the cap allows.
    const sharedFanout = (executionKey, constituentCount, rowCount) => {
      const slice = request(executionKey);
      const base = slice.coverage.constituents[0];
      slice.requestedMetrics = ['impressions'];
      slice.coverage.constituents = Array.from({ length: constituentCount }, (unused, index) => ({
        ...base,
        constituentId: `fixture-constituent-${String(index).padStart(4, '0')}`,
      }));
      slice.coverage.denominatorFingerprint = reportingCoverageDenominatorFingerprintV1(slice.coverage.constituents);
      const source = createInlineReportingSourceExecutor(
        input => ({
          reporting_period: { start: input.start_date, end: input.end_date },
          currency: 'USD',
          reporting_rows: Array.from({ length: rowCount }, () => ({
            media_buy_id: 'fixture-media-buy',
            impressions: 10,
          })),
          availability_evidence: {
            version: '1.0',
            cells: input.constituents.map(constituent => ({
              constituent_id: constituent.constituent_id,
              metric: 'impressions',
              status: 'present',
              data_through: input.end_date,
            })),
          },
        }),
        redactedReportingSourceOfferingV1
      );
      return { source, slice };
    };

    // 1,000 constituents x 6,000 rows x 1 metric = 6,000,000 comparisons, over the
    // 5,000,000 cap, while the rows x metrics bound only ever charged 6,000. The cap is
    // reached from counts alone, so no fanout is allocated and the refusal is immediate.
    const over = sharedFanout('fixture-inline-shared-fanout-over', 1_000, 6_000);
    const started = process.hrtime.bigint();
    const refused = await over.source.execute(over.slice, context());
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(validateReportingSourceFailureV1(refused, 'QUOTA_EXHAUSTED').code, 'QUOTA_EXHAUSTED');
    // Counting is linear in the rows; performing the fanout is not.
    assert.ok(elapsedMs < 2_000, `shared-fanout refusal took ${elapsedMs.toFixed(1)}ms`);

    // Below the cap the same shape must still seal, and every constituent sharing the
    // media buy has to be proved by it.
    const under = sharedFanout('fixture-inline-shared-fanout-under', 100, 10);
    const sealed = await under.source.execute(under.slice, context());
    assert.equal(sealed.ok, true);
    const manifest = parseVerifiedReportingSourceManifestV1(sealed.response.manifest, sealed.manifestBytes, 'basic');
    assert.equal(manifest.coverage.status, 'full');
    assert.equal(manifest.metricAvailability.length, 100);
    assert.ok(manifest.metricAvailability.every(cell => cell.status === 'present'));
  });

  test('does not spend projection capacity on the auxiliary collection without evidence', async () => {
    // Only availability verification reads the auxiliary collection, so on the legacy
    // path its values are never projected. Projecting them charged a separate budget and
    // turned an otherwise valid response into STAGING_FAILED.
    const oversized = 'x'.repeat(11 * 1024 * 1024);
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' }],
        media_buy_deliveries: [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: oversized }],
      }),
      redactedReportingSourceOfferingV1
    );
    const result = await source.execute(request('fixture-inline-auxiliary-capacity'), context());
    assert.equal(result.ok, true);
    const manifest = parseVerifiedReportingSourceManifestV1(result.response.manifest, result.manifestBytes, 'basic');
    assert.equal(manifest.coverage.status, 'full');
    // Only the source collection is staged, so the auxiliary value never reaches an object.
    assert.equal(manifest.objects[0].rowCount, 1);
    assert.ok(manifest.objects[0].byteCount < 1_024);
  });

  test('gives every constituent sharing one media buy its rows', async () => {
    const sharedRow = { media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' };

    // A contradiction against either constituent must fail closed in either declaration
    // order. Mapping one media buy onto a single constituent left the other row-free, so
    // its cells were compared against nothing.
    for (const override of [
      { metric: 'impressions', status: 'explicit_zero', data_through: undefined },
      { metric: 'spend', status: 'missing', reason: 'Provider did not return spend' },
      { metric: 'spend', status: 'delayed', reason: 'Provider processing is not closed' },
    ]) {
      for (const [index, zeroCellFirst] of [true, false].entries()) {
        for (const contradicted of ['fixture-constituent', 'fixture-constituent-b']) {
          const source = createInlineReportingSourceExecutor(
            input => ({
              reporting_period: { start: input.start_date, end: input.end_date },
              currency: 'USD',
              reporting_rows: [sharedRow],
              availability_evidence: sharedMediaBuyCells(input, [
                {
                  constituent_id: contradicted,
                  metric: override.metric,
                  status: override.status,
                  ...(override.reason ? { reason: override.reason } : { data_through: input.end_date }),
                },
              ]),
            }),
            redactedReportingSourceOfferingV1
          );
          const key = `fixture-shared-${override.metric}-${override.status}-${index}-${contradicted}`;
          const result = await source.execute(sharedMediaBuyRequest(key, zeroCellFirst), context());
          assert.equal(
            validateReportingSourceFailureV1(result, 'INTEGRITY_FAILED').code,
            'INTEGRITY_FAILED',
            `${override.status} ${override.metric} on ${contradicted} (zeroCellFirst=${zeroCellFirst})`
          );
        }
      }
    }

    // The sharpest case: when the contradicted constituent claims no cell as `present`,
    // nothing forced a partial, so a row-free constituent used to seal a manifest that
    // declared zero impressions and missing spend against a row carrying both.
    for (const [index, zeroCellFirst] of [true, false].entries()) {
      for (const contradicted of ['fixture-constituent', 'fixture-constituent-b']) {
        const source = createInlineReportingSourceExecutor(
          input => ({
            reporting_period: { start: input.start_date, end: input.end_date },
            currency: 'USD',
            reporting_rows: [sharedRow],
            availability_evidence: sharedMediaBuyCells(input, [
              {
                constituent_id: contradicted,
                metric: 'impressions',
                status: 'explicit_zero',
                data_through: input.end_date,
              },
              {
                constituent_id: contradicted,
                metric: 'spend',
                status: 'missing',
                reason: 'Provider did not return spend',
              },
            ]),
          }),
          redactedReportingSourceOfferingV1
        );
        const slice = sharedMediaBuyRequest(`fixture-shared-silent-${index}-${contradicted}`, zeroCellFirst);
        slice.coverage.expected = 'partial';
        const result = await source.execute(slice, context());
        assert.equal(
          validateReportingSourceFailureV1(result, 'INTEGRITY_FAILED').code,
          'INTEGRITY_FAILED',
          `wholly unavailable ${contradicted} (zeroCellFirst=${zeroCellFirst})`
        );
      }
    }

    // The legitimate all-present case must still seal in either order: the shared row
    // proves both constituents, so neither may read as row-free and partial.
    for (const [index, zeroCellFirst] of [true, false].entries()) {
      const source = createInlineReportingSourceExecutor(
        input => ({
          reporting_period: { start: input.start_date, end: input.end_date },
          currency: 'USD',
          reporting_rows: [sharedRow],
          availability_evidence: sharedMediaBuyCells(input),
        }),
        redactedReportingSourceOfferingV1
      );
      const result = await source.execute(
        sharedMediaBuyRequest(`fixture-shared-present-${index}`, zeroCellFirst),
        context()
      );
      assert.equal(result.ok, true, `all-present seals (zeroCellFirst=${zeroCellFirst})`);
      const manifest = parseVerifiedReportingSourceManifestV1(result.response.manifest, result.manifestBytes, 'basic');
      assert.equal(manifest.coverage.status, 'full');
      assert.equal(manifest.metricAvailability.length, 4);
      assert.ok(manifest.metricAvailability.every(cell => cell.status === 'present'));
    }
  });

  test('validates the captured evidence cells rather than a restated envelope', async () => {
    // The cap used to be checked against the captured own `cells` value while the schema
    // re-read `cells` through the get channel, so a proxy could be capped on the claim it
    // declared and validated on a different one.
    let getReads = 0;
    const source = createInlineReportingSourceExecutor(input => {
      const captured = [
        {
          constituent_id: input.constituents[0].constituent_id,
          metric: 'impressions',
          status: 'present',
          data_through: input.end_date,
        },
        {
          constituent_id: input.constituents[0].constituent_id,
          metric: 'spend',
          status: 'missing',
          reason: 'Provider did not return spend',
        },
      ];
      const restated = [
        captured[0],
        {
          constituent_id: input.constituents[0].constituent_id,
          metric: 'spend',
          status: 'present',
          data_through: input.end_date,
        },
      ];
      return {
        reporting_period: { start: input.start_date, end: input.end_date },
        currency: 'USD',
        reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' }],
        availability_evidence: new Proxy(
          { version: '1.0', cells: captured },
          {
            get(target, property, receiver) {
              if (property === 'cells') {
                getReads += 1;
                return restated;
              }
              return Reflect.get(target, property, receiver);
            },
          }
        ),
      };
    }, redactedReportingSourceOfferingV1);
    const result = await source.execute(request('fixture-inline-restated-evidence-cells'), context());
    // The captured claim is `missing`, and the row carries spend, so it must fail closed.
    assert.equal(validateReportingSourceFailureV1(result, 'INTEGRITY_FAILED').code, 'INTEGRITY_FAILED');
    assert.equal(getReads, 0, 'the evidence envelope is never read through the get channel');
  });

  test('reconciles long decimal claims in linear time', async () => {
    const zeros = '0'.repeat(100_000);
    const claimSource = (direct, totals) =>
      createInlineReportingSourceExecutor(
        input => ({
          reporting_period: { start: input.start_date, end: input.end_date },
          currency: 'USD',
          reporting_rows: [
            {
              media_buy_id: 'fixture-media-buy',
              impressions: 10,
              spend: direct,
              totals: { impressions: 10, spend: totals },
            },
          ],
          availability_evidence: presentAvailability(input),
        }),
        redactedReportingSourceOfferingV1
      );

    // A long zero run that never reaches the end of the string made the trailing-zero
    // regex retry it from every offset. Trimming is a single scan now, so a contradiction
    // between two such claims settles immediately instead of quadratically.
    const started = process.hrtime.bigint();
    const contradiction = await claimSource(`0.${zeros}1`, `0.${zeros}2`).execute(
      request('fixture-inline-long-decimal-contradiction'),
      context()
    );
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(validateReportingSourceFailureV1(contradiction, 'INTEGRITY_FAILED').code, 'INTEGRITY_FAILED');
    // Linear settles in single-digit milliseconds; the quadratic trim needed seconds.
    assert.ok(elapsedMs < 2_000, `long-decimal reconciliation took ${elapsedMs.toFixed(1)}ms`);

    // Trailing zeros are still insignificant, so a padded restatement of the same
    // quantity remains sealable.
    const agreement = await claimSource(0.5, `0.5${zeros}`).execute(
      request('fixture-inline-long-decimal-agreement'),
      context()
    );
    assert.equal(agreement.ok, true);
    const manifest = parseVerifiedReportingSourceManifestV1(
      agreement.response.manifest,
      agreement.manifestBytes,
      'basic'
    );
    assert.equal(manifest.metricAvailability.find(cell => cell.metric === 'spend').status, 'present');
  });

  test('accepts inherited and accessor-backed row collections', async () => {
    const row = () => ({ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.25' });
    const period = input => ({ start: input.start_date, end: input.end_date });

    // A class instance keeps its rows on the prototype as an accessor.
    class ClassDelivery {
      constructor(input) {
        this.reporting_period = period(input);
        this.currency = 'USD';
      }
      get reporting_rows() {
        return [row()];
      }
    }

    let accessorReads = 0;
    let deliveriesReads = 0;
    const shapes = [
      ['class-instance', input => new ClassDelivery(input)],
      [
        'inherited-value',
        input =>
          Object.create(
            { reporting_rows: [row()] },
            Object.getOwnPropertyDescriptors({ reporting_period: period(input), currency: 'USD' })
          ),
      ],
      [
        'own-accessor-rows',
        input => {
          const response = { reporting_period: period(input), currency: 'USD' };
          Object.defineProperty(response, 'reporting_rows', {
            enumerable: true,
            get: () => {
              accessorReads += 1;
              return [row()];
            },
          });
          return response;
        },
      ],
      [
        'own-accessor-deliveries',
        input => {
          const response = { reporting_period: period(input), currency: 'USD' };
          Object.defineProperty(response, 'media_buy_deliveries', {
            enumerable: true,
            get: () => {
              deliveriesReads += 1;
              return [row()];
            },
          });
          return response;
        },
      ],
    ];

    for (const [label, build] of shapes) {
      const source = createInlineReportingSourceExecutor(build, redactedReportingSourceOfferingV1);
      const result = await source.execute(request(`fixture-inline-row-shape-${label}`), context());
      assert.equal(result.ok, true, `${label} row collection is accepted`);
      const manifest = parseVerifiedReportingSourceManifestV1(result.response.manifest, result.manifestBytes, 'basic');
      assert.equal(manifest.coverage.status, 'full', label);
      assert.equal(manifest.objects[0].rowCount, 1, label);
    }
    // Each collection is read once and reused, so the staged rows are the validated rows.
    assert.equal(accessorReads, 1);
    assert.equal(deliveriesReads, 1);
  });

  test('bounds both delivery row collections before combining evidence', async () => {
    const row = { media_buy_id: 'fixture-media-buy', totals: { impressions: 1, spend: '0.10' } };
    const source = createInlineReportingSourceExecutor(
      input => ({
        reporting_period: { start: input.start_date, end: input.end_date },
        reporting_rows: [row],
        media_buy_deliveries: Array(100_000).fill(row),
      }),
      redactedReportingSourceOfferingV1
    );
    const result = await source.execute(request('fixture-inline-dual-row-bound'), context());
    assert.equal(validateReportingSourceFailureV1(result, 'QUOTA_EXHAUSTED').code, 'QUOTA_EXHAUSTED');
  });
});
