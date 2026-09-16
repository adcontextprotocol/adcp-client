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
