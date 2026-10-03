const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { describe, test } = require('node:test');

const {
  BasicSourceBatchManifestV1Schema,
  ReportingContractIdentityV1Schema,
  ReportingSourceCapabilitiesV1Schema,
  ReportingSourceConformanceError,
  ReportingSourceScopeV1Schema,
  ReportingSourceSliceRequestV1Schema,
  ReportingSourceWindowingV1Schema,
  SourceBatchManifestV1Schema,
  buildReportingSourceManifestV1,
  canonicalJsonUtf8V1GoldenVectors,
  canonicalJsonV1,
  encodeReportingSourceManifestV1,
  redactedReportingSourceCapabilitiesV1,
  redactedReportingSourceRequestV1,
  redactedReportingSourceResultV1,
  reportingCoverageDenominatorFingerprintV1,
  runReportingSourceReplayConformanceV1,
  sourceBatchCoverageFingerprintV1,
  sourceBatchManifestReferenceV1,
  sourceBatchObjectSetFingerprintV1,
  sourceBatchPublicationContentFingerprintV1,
  validateReportingRevisionSequenceV1,
  validateReportingSourceExecutionV1,
} = require('../../dist/lib/reporting/source/index.js');

describe('reporting source contract V1', () => {
  test('publishes byte-for-byte canonical JSON golden vectors', () => {
    for (const vector of canonicalJsonUtf8V1GoldenVectors) {
      const bytes = Buffer.from(canonicalJsonV1(vector.value), 'utf8');
      assert.equal(bytes.toString('hex'), vector.canonicalUtf8Hex, vector.name);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), vector.sha256, vector.name);
    }
    assert.throws(() => canonicalJsonV1({ value: 1.5 }), /safe integers/);
    assert.throws(() => canonicalJsonV1({ value: undefined }), /does not permit/);
  });

  test('matches the shared Python/TypeScript canonical JSON contract fixtures', async () => {
    const fixture = JSON.parse(
      await readFile(path.join(__dirname, '../fixtures/reporting-interop/canonical-json-v1.json'), 'utf8')
    );
    assert.equal(fixture.contract, 'canonical_json_utf8_v1');
    for (const vector of fixture.vectors) {
      const bytes = Buffer.from(canonicalJsonV1(vector.value), 'utf8');
      assert.equal(bytes.toString('hex'), vector.canonical_utf8_hex, vector.name);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), vector.sha256, vector.name);
    }
  });

  test('validates replay at both manifest strictness levels', async () => {
    for (const level of ['basic', 'evidenced']) {
      const request = redactedReportingSourceRequestV1({
        sourceExecutionKey: `fixture-${level}-replay`,
      });
      const fixture = redactedReportingSourceResultV1(level, request);
      const executor = {
        capabilities: redactedReportingSourceCapabilitiesV1,
        async execute() {
          return fixture.result;
        },
      };
      const manifest = await runReportingSourceReplayConformanceV1({
        level,
        executor,
        request,
        objectReader: fixture.objectReader,
      });
      assert.equal(manifest.level, level);
      assert.equal(
        (level === 'basic' ? BasicSourceBatchManifestV1Schema : SourceBatchManifestV1Schema).safeParse(manifest)
          .success,
        true
      );
    }
  });

  test('executes duplicate source keys concurrently and requires atomic replay', async () => {
    const request = redactedReportingSourceRequestV1({ sourceExecutionKey: 'fixture-concurrent-replay' });
    const fixture = redactedReportingSourceResultV1('basic', request);
    let active = 0;
    let maximumActive = 0;
    const executor = {
      capabilities: redactedReportingSourceCapabilitiesV1,
      async execute() {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise(resolve => setImmediate(resolve));
        active -= 1;
        return fixture.result;
      },
    };
    await runReportingSourceReplayConformanceV1({
      level: 'basic',
      executor,
      request,
      objectReader: fixture.objectReader,
    });
    assert.equal(maximumActive, 2);
  });

  test('rejects an executor that coalesces only in-flight duplicates', async () => {
    const request = redactedReportingSourceRequestV1({ sourceExecutionKey: 'fixture-inflight-only-replay' });
    const fixture = redactedReportingSourceResultV1('basic', request);
    let inFlight;
    let runs = 0;
    const executor = {
      capabilities: redactedReportingSourceCapabilitiesV1,
      execute() {
        if (inFlight) return inFlight;
        runs += 1;
        inFlight = new Promise(resolve => {
          setImmediate(() => {
            const result = structuredClone(fixture.result);
            result.response.manifest.stagedCommitRef = `fixture-generation-${runs}`;
            inFlight = undefined;
            resolve(result);
          });
        });
        return inFlight;
      },
    };
    await assert.rejects(
      runReportingSourceReplayConformanceV1({
        level: 'basic',
        executor,
        request,
        objectReader: fixture.objectReader,
      }),
      error => error instanceof ReportingSourceConformanceError && error.code === 'REPLAY_MISMATCH'
    );
    assert.equal(runs, 2);
  });

  test('cancels the other duplicate execution after an asymmetric failure', async () => {
    const request = redactedReportingSourceRequestV1({ sourceExecutionKey: 'fixture-asymmetric-replay' });
    request.deadline.deadlineAt = new Date(Date.now() + 500).toISOString();
    const fixture = redactedReportingSourceResultV1('basic', request);
    let calls = 0;
    let pendingSettled = false;
    const startedAt = Date.now();
    await assert.rejects(
      runReportingSourceReplayConformanceV1({
        level: 'basic',
        executor: {
          capabilities: redactedReportingSourceCapabilitiesV1,
          execute(_received, { signal }) {
            calls += 1;
            if (calls === 1)
              return Promise.resolve({
                ok: false,
                error: {
                  contractVersion: '1.0',
                  code: 'SOURCE_PERMANENT',
                  retry: 'terminal',
                  scope: 'source',
                  safeMessage: 'Fixture terminal failure',
                },
              });
            return new Promise(resolve => {
              signal.addEventListener(
                'abort',
                () => {
                  pendingSettled = true;
                  resolve({
                    ok: false,
                    error: {
                      contractVersion: '1.0',
                      code: 'CANCELLED',
                      retry: 'cancelled',
                      scope: 'slice',
                      safeMessage: 'Fixture cancelled',
                    },
                  });
                },
                { once: true }
              );
            });
          },
        },
        request,
        objectReader: fixture.objectReader,
      }),
      error => error instanceof ReportingSourceConformanceError && error.message.startsWith('SOURCE_PERMANENT:')
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pendingSettled, true);
    assert.ok(Date.now() - startedAt < 250);
  });

  test('builds digest-bound manifests without caller-managed placeholder ordering', () => {
    const request = redactedReportingSourceRequestV1();
    const fixture = redactedReportingSourceResultV1('basic', request);
    const built = buildReportingSourceManifestV1({
      level: 'basic',
      request,
      stagedCommitRef: fixture.result.response.manifest.stagedCommitRef,
      objects: fixture.manifest.objects,
      controlTotals: fixture.manifest.controlTotals,
      metricAvailability: fixture.manifest.metricAvailability,
      coverage: {
        status: fixture.manifest.coverage.status,
        constituents: fixture.manifest.coverage.constituents,
      },
      observedAt: fixture.manifest.period.observedAt,
      dataThrough: fixture.manifest.period.dataThrough,
      finalityEvidence: fixture.manifest.finality.evidence,
      acquiredAt: fixture.manifest.acquiredAt,
      explicitZero: fixture.manifest.explicitZero,
      eventTimeRange: fixture.manifest.eventTimeRange,
      warnings: fixture.manifest.warnings,
      completeness: fixture.manifest.completeness,
    });
    assert.deepEqual(built.manifest, fixture.manifest);
    assert.deepEqual(Buffer.from(built.manifestBytes), Buffer.from(fixture.result.manifestBytes));
    assert.deepEqual(built.reference, fixture.result.response.manifest);

    const coverageWithStaleDigests = structuredClone(fixture.manifest.coverage);
    coverageWithStaleDigests.denominatorFingerprint = 'f'.repeat(64);
    coverageWithStaleDigests.coverageFingerprint = 'e'.repeat(64);
    const rebound = buildReportingSourceManifestV1({
      level: 'basic',
      request,
      stagedCommitRef: fixture.result.response.manifest.stagedCommitRef,
      objects: fixture.manifest.objects,
      metricAvailability: fixture.manifest.metricAvailability,
      coverage: coverageWithStaleDigests,
      observedAt: fixture.manifest.period.observedAt,
      dataThrough: fixture.manifest.period.dataThrough,
      finalityEvidence: fixture.manifest.finality.evidence,
      acquiredAt: fixture.manifest.acquiredAt,
      explicitZero: fixture.manifest.explicitZero,
      eventTimeRange: fixture.manifest.eventTimeRange,
      completeness: fixture.manifest.completeness,
    });
    assert.equal(rebound.manifest.coverage.denominatorFingerprint, request.coverage.denominatorFingerprint);
    assert.equal(
      rebound.manifest.coverage.coverageFingerprint,
      sourceBatchCoverageFingerprintV1(coverageWithStaleDigests.constituents)
    );
  });

  test('returns Zod failures rather than throwing for malformed boundary fields', () => {
    const request = structuredClone(redactedReportingSourceRequestV1());
    request.period.start = 'garbage';
    assert.doesNotThrow(() => {
      assert.equal(ReportingSourceSliceRequestV1Schema.safeParse(request).success, false);
    });

    const manifest = structuredClone(redactedReportingSourceResultV1('basic').manifest);
    manifest.period.start = 'garbage';
    assert.doesNotThrow(() => {
      assert.equal(BasicSourceBatchManifestV1Schema.safeParse(manifest).success, false);
    });

    for (const mutate of [
      candidate => {
        candidate.sourceScope = { ratio: 1.5 };
      },
      candidate => {
        candidate.objects[0].sha256 = 'not-a-sha';
      },
    ]) {
      const malformed = structuredClone(redactedReportingSourceResultV1('basic').manifest);
      mutate(malformed);
      assert.doesNotThrow(() => {
        assert.equal(BasicSourceBatchManifestV1Schema.safeParse(malformed).success, false);
      });
    }

    assert.doesNotThrow(() => {
      assert.equal(
        ReportingSourceWindowingV1Schema.safeParse({
          kind: 'fixed_closed_window',
          minimumWindow: 'X',
          maximumWindow: 'P1D',
          overlappingWindowsSupported: false,
        }).success,
        false
      );
    });

    const capabilities = structuredClone(redactedReportingSourceCapabilitiesV1);
    capabilities.offerings[0].cadence.expectedAvailabilityLag = 'GARBAGE';
    assert.doesNotThrow(() => {
      assert.equal(ReportingSourceCapabilitiesV1Schema.safeParse(capabilities).success, false);
    });
  });

  test('fails closed when full coverage completes with unavailable cells', async () => {
    const request = redactedReportingSourceRequestV1();
    const fixture = redactedReportingSourceResultV1('basic', request);
    const manifest = structuredClone(fixture.manifest);
    manifest.coverage.status = 'none';
    for (const constituent of manifest.coverage.constituents) {
      constituent.status = 'missing';
      constituent.reason = 'Source omitted the requested constituent';
      delete constituent.dataThrough;
    }
    for (const metric of manifest.metricAvailability) {
      metric.status = 'missing';
      metric.reason = 'Source omitted the requested metric';
      delete metric.dataThrough;
    }
    manifest.coverage.coverageFingerprint = sourceBatchCoverageFingerprintV1(manifest.coverage.constituents);
    manifest.publication.contentFingerprint = sourceBatchPublicationContentFingerprintV1(manifest);
    const bytes = encodeReportingSourceManifestV1(manifest);
    const result = {
      ...fixture.result,
      response: {
        ...fixture.result.response,
        manifest: sourceBatchManifestReferenceV1('fixture-unavailable-manifest', bytes, 'basic'),
      },
      manifestBytes: bytes,
    };
    await assert.rejects(
      validateReportingSourceExecutionV1({
        level: 'basic',
        capabilities: redactedReportingSourceCapabilitiesV1,
        request,
        result,
        objectReader: fixture.objectReader,
      }),
      error => error instanceof ReportingSourceConformanceError && error.code === 'MANIFEST_MISMATCH'
    );
  });

  test('requires every requested constituent-metric cell', async () => {
    const request = redactedReportingSourceRequestV1();
    const fixture = redactedReportingSourceResultV1('basic', request);
    const manifest = structuredClone(fixture.manifest);
    manifest.metricAvailability = manifest.metricAvailability.filter(item => item.metric !== 'spend');
    manifest.publication.contentFingerprint = sourceBatchPublicationContentFingerprintV1(manifest);
    const bytes = encodeReportingSourceManifestV1(manifest);
    const result = {
      ...fixture.result,
      response: {
        ...fixture.result.response,
        manifest: sourceBatchManifestReferenceV1('fixture-missing-metric', bytes, 'basic'),
      },
      manifestBytes: bytes,
    };
    await assert.rejects(
      validateReportingSourceExecutionV1({
        level: 'basic',
        capabilities: redactedReportingSourceCapabilitiesV1,
        request,
        result,
        objectReader: fixture.objectReader,
      }),
      error => error instanceof ReportingSourceConformanceError && error.code === 'MANIFEST_MISMATCH'
    );
  });

  test('binds explicit offering timezone and calendar window bounds', async () => {
    for (const mutate of [
      request => {
        request.period.sourceTimezone = 'Asia/Tokyo';
      },
      request => {
        request.period.end = '2026-09-02T02:00:00.000Z';
        request.period.sourceReadCutoffAt = request.period.end;
      },
    ]) {
      const request = structuredClone(redactedReportingSourceRequestV1());
      mutate(request);
      let called = false;
      await assert.rejects(
        runReportingSourceReplayConformanceV1({
          level: 'basic',
          executor: {
            capabilities: redactedReportingSourceCapabilitiesV1,
            async execute() {
              called = true;
              throw new Error('must not execute');
            },
          },
          request,
          objectReader: redactedReportingSourceResultV1('basic').objectReader,
        }),
        error => error instanceof ReportingSourceConformanceError && error.code === 'CAPABILITY_MISMATCH'
      );
      assert.equal(called, false);
    }
  });

  test('rejects freshness regression in a revision sequence', () => {
    const prior = structuredClone(redactedReportingSourceResultV1('basic').manifest);
    prior.period.observedAt = '2026-09-02T01:00:00.000Z';
    prior.finality.evidence.observedAt = '2026-09-02T01:00:00.000Z';
    prior.acquiredAt = '2026-09-02T01:00:00.000Z';
    const candidate = redactedReportingSourceResultV1(
      'basic',
      redactedReportingSourceRequestV1({
        sourceExecutionKey: 'fixture-regressed-snapshot',
      })
    ).manifest;
    assert.throws(() => validateReportingRevisionSequenceV1([prior, candidate]), ReportingSourceConformanceError);
  });

  test('does not admit a replayed publication as a new revision', () => {
    const manifest = redactedReportingSourceResultV1('basic').manifest;
    assert.throws(
      () => validateReportingRevisionSequenceV1([manifest, structuredClone(manifest)]),
      ReportingSourceConformanceError
    );
  });

  test('binds revision lineage to the frozen logical slice fingerprint', () => {
    const prior = structuredClone(redactedReportingSourceResultV1('basic').manifest);
    const candidate = structuredClone(prior);
    candidate.identity.sourceExecutionKey = 'fixture-distinct-revision';
    candidate.identity.logicalSliceFingerprint = `sha256:${'f'.repeat(64)}`;
    candidate.publication.publicationId = 'fixture-distinct-publication';
    assert.throws(() => validateReportingRevisionSequenceV1([prior, candidate]), ReportingSourceConformanceError);
  });

  test('requires a nonempty event-time range for nonzero rows', () => {
    const manifest = structuredClone(redactedReportingSourceResultV1('basic').manifest);
    manifest.eventTimeRange.start = manifest.eventTimeRange.end;
    assert.equal(BasicSourceBatchManifestV1Schema.safeParse(manifest).success, false);
  });

  test('keeps unavailable zero rows distinct from observed zero', () => {
    const manifest = structuredClone(redactedReportingSourceResultV1('basic').manifest);
    manifest.objects[0].rowCount = 0;
    manifest.rowCount = 0;
    manifest.objectSetSha256 = sourceBatchObjectSetFingerprintV1(manifest.objects);
    manifest.coverage.status = 'none';
    for (const constituent of manifest.coverage.constituents) {
      constituent.status = 'missing';
      constituent.reason = 'Source data is unavailable';
      delete constituent.dataThrough;
    }
    for (const metric of manifest.metricAvailability) {
      metric.status = 'missing';
      metric.reason = 'Source data is unavailable';
      delete metric.dataThrough;
    }
    manifest.coverage.coverageFingerprint = sourceBatchCoverageFingerprintV1(manifest.coverage.constituents);
    manifest.publication.contentFingerprint = sourceBatchPublicationContentFingerprintV1(manifest);
    assert.equal(BasicSourceBatchManifestV1Schema.safeParse(manifest).success, false);
    delete manifest.eventTimeRange;
    manifest.publication.contentFingerprint = sourceBatchPublicationContentFingerprintV1(manifest);
    assert.equal(BasicSourceBatchManifestV1Schema.safeParse(manifest).success, true);
  });

  test('rejects non-terminal or incomplete evidenced source reads', () => {
    const fixture = redactedReportingSourceResultV1('evidenced');
    const wrongCount = structuredClone(fixture.manifest);
    wrongCount.completeness.providerPagination.pages[0].itemCount = 0;
    assert.equal(SourceBatchManifestV1Schema.safeParse(wrongCount).success, false);

    const nonTerminal = structuredClone(fixture.manifest);
    nonTerminal.completeness.sourceJob = {
      mode: 'terminal_success',
      terminal: true,
      jobs: [
        {
          jobId: 'fixture-job',
          submissionRequestId: 'fixture-job-submit',
          submissionResponseSha256: 'a'.repeat(64),
        },
      ],
      polls: [
        {
          jobId: 'fixture-job',
          ordinal: 0,
          requestId: 'fixture-job-poll',
          observedAt: nonTerminal.acquiredAt,
          state: 'running',
          responseSha256: 'b'.repeat(64),
        },
      ],
    };
    nonTerminal.providerUsage.asyncJobCount = 1;
    nonTerminal.providerUsage.requestCount = 3;
    assert.equal(SourceBatchManifestV1Schema.safeParse(nonTerminal).success, false);

    const brokenCursorChain = structuredClone(fixture.manifest);
    brokenCursorChain.completeness.providerPagination = {
      kind: 'cursor',
      complete: true,
      termination: 'no_next_cursor',
      pages: [
        brokenCursorChain.completeness.providerPagination.pages[0],
        {
          ...brokenCursorChain.completeness.providerPagination.pages[0],
          ordinal: 1,
          requestId: 'fixture-request-2',
          itemCount: 0,
          outputObjectOrdinals: [],
        },
      ],
    };
    brokenCursorChain.completeness.sourceRequestIds = ['fixture-request', 'fixture-request-2'];
    brokenCursorChain.providerUsage.requestCount = 2;
    brokenCursorChain.providerUsage.pageCount = 2;
    assert.equal(SourceBatchManifestV1Schema.safeParse(brokenCursorChain).success, false);
  });

  test('does not let an executor mutate the frozen conformance identity', async () => {
    const request = redactedReportingSourceRequestV1({ sourceExecutionKey: 'fixture-mutation-replay' });
    request.sourceScope = { routing: { connection: 'tenant-a' }, groups: ['one'] };
    await assert.rejects(
      runReportingSourceReplayConformanceV1({
        level: 'basic',
        executor: {
          capabilities: redactedReportingSourceCapabilitiesV1,
          async execute(received) {
            received.account.account_id = 'different-account';
            received.sourceScope.routing.connection = 'tenant-b';
            received.sourceScope.groups.push('two');
            return redactedReportingSourceResultV1('basic', received).result;
          },
        },
        request,
        objectReader: redactedReportingSourceResultV1('basic', request).objectReader,
      }),
      error => error instanceof ReportingSourceConformanceError && error.code === 'MANIFEST_MISMATCH'
    );
    assert.equal(request.account.account_id, 'fixture-account');
    assert.deepEqual(request.sourceScope, { routing: { connection: 'tenant-a' }, groups: ['one'] });
  });

  test('isolates the staged reader from the caller source scope', async () => {
    const request = redactedReportingSourceRequestV1({ sourceExecutionKey: 'fixture-reader-isolation' });
    request.sourceScope = { routing: { connection: 'tenant-a' } };
    const fixture = redactedReportingSourceResultV1('basic', request);
    await validateReportingSourceExecutionV1({
      level: 'basic',
      capabilities: redactedReportingSourceCapabilitiesV1,
      request,
      result: fixture.result,
      objectReader: {
        async read(input) {
          const bytes = await fixture.objectReader.read(input);
          input.sourceScope.routing.connection = 'tenant-b';
          return bytes;
        },
      },
    });
    assert.equal(request.sourceScope.routing.connection, 'tenant-a');
  });

  test('accepts equivalent instant encodings at authoritative period end', () => {
    const manifest = structuredClone(redactedReportingSourceResultV1('basic').manifest);
    manifest.publication.publicationClass = 'AUTHORITATIVE';
    manifest.finality = {
      revisionKind: 'authoritative',
      evidence: { owner: 'adapter', basis: 'source_declared', observedAt: manifest.period.end },
    };
    manifest.period.dataThrough = '2026-09-02T01:00:00+01:00';
    for (const constituent of manifest.coverage.constituents) constituent.dataThrough = '2026-09-02T00:00:00Z';
    for (const metric of manifest.metricAvailability) metric.dataThrough = '2026-09-02T00:00:00+00:00';
    manifest.coverage.coverageFingerprint = sourceBatchCoverageFingerprintV1(manifest.coverage.constituents);
    manifest.publication.contentFingerprint = sourceBatchPublicationContentFingerprintV1(manifest);
    assert.equal(BasicSourceBatchManifestV1Schema.safeParse(manifest).success, true);
  });

  test('emits one bounded issue for a missing metric matrix', () => {
    const manifest = structuredClone(redactedReportingSourceResultV1('basic').manifest);
    const second = structuredClone(manifest.coverage.constituents[0]);
    second.constituentId = 'fixture-constituent-2';
    second.mediaBuyId = 'fixture-media-buy-2';
    second.productBinding.bindingId = 'fixture-product-binding-2';
    second.productBinding.mediaBuyId = second.mediaBuyId;
    manifest.coverage.constituents.push(second);
    manifest.coverage.denominatorFingerprint = reportingCoverageDenominatorFingerprintV1(
      manifest.coverage.constituents
    );
    manifest.coverage.coverageFingerprint = sourceBatchCoverageFingerprintV1(manifest.coverage.constituents);
    manifest.publication.contentFingerprint = sourceBatchPublicationContentFingerprintV1(manifest);
    const parsed = BasicSourceBatchManifestV1Schema.safeParse(manifest);
    assert.equal(parsed.success, false);
    assert.equal(
      parsed.error.issues.filter(issue => issue.message === 'Every constituent requires every metric cell').length,
      1
    );
  });

  test('rejects non-canonical source scope values and oversized manifests', () => {
    assert.equal(redactedReportingSourceRequestV1().sourceScope.connection, 'fixture-redacted');
    const request = structuredClone(redactedReportingSourceRequestV1());
    request.sourceScope = { ratio: 1.5 };
    const { SourceBatchContractError } = require('../../dist/lib/reporting/source/index.js');
    assert.equal(ReportingSourceSliceRequestV1Schema.safeParse(request).success, false);

    const manifest = structuredClone(redactedReportingSourceResultV1('basic').manifest);
    manifest.sourceScope.padding = 'x'.repeat(64_000);
    manifest.warnings = Array.from({ length: 1000 }, (_, index) => `${index}`.padEnd(1024, 'x'));
    manifest.publication.contentFingerprint = sourceBatchPublicationContentFingerprintV1(manifest);
    assert.throws(
      () => encodeReportingSourceManifestV1(manifest),
      error => error instanceof SourceBatchContractError && error.code === 'SOURCE_MANIFEST_TOO_LARGE'
    );
  });

  test('bounds sourceScope depth and reports invalid contract URLs through Zod', () => {
    let nested = { leaf: true };
    for (let index = 0; index < 65; index += 1) nested = { nested };
    assert.equal(ReportingSourceScopeV1Schema.safeParse({ nested }).success, false);
    assert.doesNotThrow(() => {
      const contract = structuredClone(redactedReportingSourceRequestV1().contract);
      contract.reportDefinitionUri = '###';
      assert.equal(ReportingContractIdentityV1Schema.safeParse(contract).success, false);
    });
  });

  test('rejects oversized staged objects before invoking the reader', async () => {
    const request = redactedReportingSourceRequestV1();
    const fixture = redactedReportingSourceResultV1('basic', request);
    const manifest = structuredClone(fixture.manifest);
    manifest.objects[0].byteCount = 513 * 1024 * 1024;
    manifest.byteCount = manifest.objects[0].byteCount;
    manifest.objectSetSha256 = sourceBatchObjectSetFingerprintV1(manifest.objects);
    manifest.publication.contentFingerprint = sourceBatchPublicationContentFingerprintV1(manifest);
    const bytes = encodeReportingSourceManifestV1(manifest);
    let read = false;
    await assert.rejects(
      validateReportingSourceExecutionV1({
        level: 'basic',
        capabilities: redactedReportingSourceCapabilitiesV1,
        request,
        result: {
          ...fixture.result,
          response: {
            ...fixture.result.response,
            manifest: sourceBatchManifestReferenceV1('fixture-oversized-object', bytes, 'basic'),
          },
          manifestBytes: bytes,
        },
        objectReader: {
          async read() {
            read = true;
            return new Uint8Array();
          },
        },
      }),
      error => error instanceof ReportingSourceConformanceError && error.code === 'OBJECT_MISMATCH'
    );
    assert.equal(read, false);
  });

  test('propagates cancellation and observes started executor settlement', async () => {
    const request = redactedReportingSourceRequestV1();
    const fixture = redactedReportingSourceResultV1('basic', request);
    const controller = new AbortController();
    let settled = false;
    let announceStarted;
    const started = new Promise(resolve => {
      announceStarted = resolve;
    });
    const executor = {
      capabilities: redactedReportingSourceCapabilitiesV1,
      execute(_request, { signal }) {
        return new Promise(resolve => {
          announceStarted();
          signal.addEventListener(
            'abort',
            () => {
              setImmediate(() => {
                settled = true;
                resolve({
                  ok: false,
                  error: {
                    contractVersion: '1.0',
                    code: 'CANCELLED',
                    retry: 'cancelled',
                    scope: 'slice',
                    safeMessage: 'Fixture execution cancelled',
                  },
                });
              });
            },
            { once: true }
          );
        });
      },
    };
    const conformance = runReportingSourceReplayConformanceV1({
      level: 'basic',
      executor,
      request,
      objectReader: fixture.objectReader,
      signal: controller.signal,
    });
    await started;
    controller.abort();
    await assert.rejects(conformance, ReportingSourceConformanceError);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, true);
  });

  test('bounds an executor that ignores its deadline signal', async () => {
    const request = redactedReportingSourceRequestV1();
    request.deadline.deadlineAt = new Date(Date.now() + 25).toISOString();
    const fixture = redactedReportingSourceResultV1('basic', request);
    let observedSignal;
    const executor = {
      capabilities: redactedReportingSourceCapabilitiesV1,
      execute(_request, { signal }) {
        observedSignal = signal;
        return new Promise(() => {});
      },
    };
    await assert.rejects(
      runReportingSourceReplayConformanceV1({
        level: 'basic',
        executor,
        request,
        objectReader: fixture.objectReader,
      }),
      ReportingSourceConformanceError
    );
    assert.equal(observedSignal.aborted, true);
  });

  test('does not expose raw executor failures as public conformance messages', async () => {
    const request = redactedReportingSourceRequestV1();
    const raw = new Error('ECONNREFUSED 10.0.0.1:5432');
    await assert.rejects(
      runReportingSourceReplayConformanceV1({
        level: 'basic',
        executor: {
          capabilities: redactedReportingSourceCapabilitiesV1,
          async execute() {
            throw raw;
          },
        },
        request,
        objectReader: redactedReportingSourceResultV1('basic').objectReader,
      }),
      error =>
        error instanceof ReportingSourceConformanceError &&
        error.message === 'Reporting source executor failed without a typed source error' &&
        error.cause === raw
    );
  });

  test('copies public JSON Schema documents into the package', async () => {
    const schema = JSON.parse(
      await readFile(path.resolve('dist/lib/reporting/source/schemas/source-batch-manifest-v1.json'), 'utf8')
    );
    assert.equal(schema.type, 'object');
    assert.equal(schema.properties.level.const, 'evidenced');
  });
});
