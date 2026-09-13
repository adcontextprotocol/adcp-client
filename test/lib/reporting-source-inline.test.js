const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  InlineReportingSourceError,
  createInlineReportingSourceExecutor,
  parseVerifiedReportingSourceManifestV1,
  redactedReportingSourceOfferingV1,
  redactedReportingSourceRequestV1,
  runReportingSourceReplayConformanceV1,
  validateReportingSourceFailureV1,
} = require('../../dist/lib/reporting/source/index.js');

function request(sourceExecutionKey) {
  return redactedReportingSourceRequestV1({ sourceExecutionKey });
}

function context() {
  return { signal: new AbortController().signal };
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
    assert.deepEqual(calls[0].scope, slice.sourceScope);
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

  test('rejects oversized scalar evidence before JSON serialization', async () => {
    const source = createInlineReportingSourceExecutor(
      () => [{ media_buy_id: 'fixture-media-buy', impressions: 1, spend: 'x'.repeat(6 * 1024 * 1024) }],
      redactedReportingSourceOfferingV1
    );
    const result = await source.execute(request('fixture-inline-scalar-cap'), context());
    assert.equal(validateReportingSourceFailureV1(result, 'STAGING_FAILED').code, 'STAGING_FAILED');
  });
});
