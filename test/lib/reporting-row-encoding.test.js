const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');

const {
  REPORTING_ROW_CHUNK_MAX_BYTES,
  REPORTING_ROW_CHUNK_MAX_ROWS,
  REPORTING_ROW_SEGMENT_MAX_ROWS,
  assertReportingRevisionEnvelopeV1,
  createReportingRevisionEnvelopeHasherV1,
  createReportingRowsOnlyHasherV1,
  decodeVerifiedReportingRowSegmentsV1,
  encodeReportingRowsV1,
  isReportingRowEncodingError,
  reportingRevisionEnvelopeDigestV1,
  verifyReportingRowChunkV1,
  verifyReportingRowManifestsV1,
} = require('../../dist/lib/reporting/ledger/index.js');
const { canonicalize } = require('../../dist/lib/utils/jcs.js');

const FIXTURE = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'fixtures', 'reporting-row-storage-v1.json'), 'utf8')
);

const TOTALS = [
  { name: 'impressions', value: '1200', value_type: 'integer' },
  { name: 'spend', value: '42.17', value_type: 'decimal', unit: 'USD' },
];

function referenceBinding(revisionId, rows, controlTotals = TOTALS) {
  const bytes = Buffer.from(
    canonicalize({
      reporting_revision_id: revisionId,
      row_count: rows.length,
      control_totals: controlTotals,
      reporting_rows: rows,
    }),
    'utf8'
  );
  return { sha256: createHash('sha256').update(bytes).digest('hex'), byteCount: bytes.byteLength };
}

function envelope(revisionId, rows, controlTotals = TOTALS) {
  return { reporting_revision_id: revisionId, row_count: rows.length, control_totals: controlTotals };
}

function rowsOf(count, fill = '') {
  return Array.from({ length: count }, (_, index) => ({ ordinal: index, label: `row-${index}${fill}` }));
}

function assertCode(fn, code) {
  assert.throws(fn, error => isReportingRowEncodingError(error) && error.code === code);
}

describe('reporting canonical JSONL row encoding', () => {
  test('streamed envelope digest equals the protocol revision binding', () => {
    const cases = [
      [],
      [{}],
      [{ media_buy_id: 'mb_1', impressions: 10, spend: '1.50' }],
      [
        { name: 'café 😀 日本語', sep: ' ', control: '\u0007\n"\\' },
        { nested: { z: [1, { b: null, a: true }], a: [] }, n: -0, big: 1e21 / 1e6, tiny: 1e-7 },
        { float: 0.30000000000000004, neg: -12.5, int: 9007199254740991 },
      ],
      rowsOf(1234),
    ];
    for (const rows of cases) {
      const encoded = encodeReportingRowsV1(rows);
      const expected = referenceBinding('rrev_case', rows);
      assert.deepEqual(
        reportingRevisionEnvelopeDigestV1(
          envelope('rrev_case', rows),
          encoded.chunks.map(chunk => chunk.bytes)
        ),
        expected
      );
      assert.equal(encoded.rowCount, rows.length);
      assertReportingRevisionEnvelopeV1(
        envelope('rrev_case', rows),
        encoded.chunks.map(chunk => chunk.bytes),
        expected
      );
    }
  });

  test('an empty revision has no chunks and still binds "reporting_rows":[]', () => {
    const encoded = encodeReportingRowsV1([]);
    assert.equal(encoded.chunks.length, 0);
    assert.equal(encoded.byteCount, 0);
    assert.equal(encoded.rowManifestSha256, createHash('sha256').update('[]').digest('hex'));
    verifyReportingRowManifestsV1([], { rowCount: 0, rowManifestSha256: encoded.rowManifestSha256 });
    assert.deepEqual(
      reportingRevisionEnvelopeDigestV1(envelope('rrev_empty', [], []), []),
      referenceBinding('rrev_empty', [], [])
    );
  });

  test('segments close every 500 rows and chunks every 10,000 rows', () => {
    const encoded = encodeReportingRowsV1(rowsOf(REPORTING_ROW_CHUNK_MAX_ROWS + 1));
    assert.equal(encoded.chunks.length, 2);
    const [first, second] = encoded.manifests;
    assert.equal(first.row_count, REPORTING_ROW_CHUNK_MAX_ROWS);
    assert.equal(first.segments.length, REPORTING_ROW_CHUNK_MAX_ROWS / REPORTING_ROW_SEGMENT_MAX_ROWS);
    assert.ok(first.segments.every(segment => segment.row_count === REPORTING_ROW_SEGMENT_MAX_ROWS));
    assert.deepEqual(
      { first_ordinal: second.first_ordinal, row_count: second.row_count, segments: second.segments.length },
      { first_ordinal: REPORTING_ROW_CHUNK_MAX_ROWS, row_count: 1, segments: 1 }
    );
    assert.equal(second.segments[0].byte_offset, 0, 'segments restart at a chunk boundary');
    verifyReportingRowManifestsV1(encoded.manifests, {
      rowCount: REPORTING_ROW_CHUNK_MAX_ROWS + 1,
      rowManifestSha256: encoded.rowManifestSha256,
    });

    const partial = encodeReportingRowsV1(rowsOf(1234));
    assert.deepEqual(
      partial.manifests[0].segments.map(segment => segment.row_count),
      [500, 500, 234]
    );
  });

  test('chunks close before exceeding 8 MiB and an oversized row stands alone', () => {
    const megabyte = 'x'.repeat(1024 * 1024);
    const rows = Array.from({ length: 9 }, (_, index) => ({ index, payload: megabyte }));
    const encoded = encodeReportingRowsV1(rows);
    assert.deepEqual(
      encoded.manifests.map(manifest => manifest.row_count),
      [7, 2]
    );
    assert.ok(encoded.manifests.every(manifest => manifest.byte_count <= REPORTING_ROW_CHUNK_MAX_BYTES));

    const oversized = [{ a: 1 }, { payload: 'y'.repeat(REPORTING_ROW_CHUNK_MAX_BYTES) }, { b: 2 }];
    const split = encodeReportingRowsV1(oversized);
    assert.deepEqual(
      split.manifests.map(manifest => manifest.row_count),
      [1, 1, 1]
    );
    verifyReportingRowManifestsV1(split.manifests, { rowCount: 3, rowManifestSha256: split.rowManifestSha256 });
    assert.deepEqual(
      reportingRevisionEnvelopeDigestV1(
        envelope('rrev_big', oversized),
        split.chunks.map(chunk => chunk.bytes)
      ),
      referenceBinding('rrev_big', oversized)
    );
  });

  test('refuses rows whose canonical bytes are not portable', () => {
    assertCode(() => encodeReportingRowsV1([['not', 'an', 'object']]), 'INVALID_ROW');
    assertCode(() => encodeReportingRowsV1([null]), 'INVALID_ROW');
    assertCode(() => encodeReportingRowsV1([{ id: 2 ** 53 }]), 'INVALID_ROW');
    assertCode(() => encodeReportingRowsV1([{ nested: [{ id: -(2 ** 60) }] }]), 'INVALID_ROW');
    assertCode(() => encodeReportingRowsV1([{ value: Number.POSITIVE_INFINITY }]), 'INVALID_ROW');
    assertCode(() => encodeReportingRowsV1([{ text: 'lone \ud800 surrogate' }]), 'INVALID_ROW');
    assertCode(() => encodeReportingRowsV1([{ text: 'lone \udc00 surrogate' }]), 'INVALID_ROW');
    assertCode(() => encodeReportingRowsV1([{ at: new Date(0) }]), 'INVALID_ROW');
    assert.doesNotThrow(() => encodeReportingRowsV1([{ ok: 'paired 😀', id: 2 ** 53 - 1 }]));
  });

  test('manifest verification rejects dropped, reordered and altered chunks', () => {
    const encoded = encodeReportingRowsV1(rowsOf(REPORTING_ROW_CHUNK_MAX_ROWS * 2 + 10));
    const expected = { rowCount: encoded.rowCount, rowManifestSha256: encoded.rowManifestSha256 };
    verifyReportingRowManifestsV1(encoded.manifests, expected);

    assertCode(() => verifyReportingRowManifestsV1(encoded.manifests.slice(0, 2), expected), 'MANIFEST_MISMATCH');
    assertCode(
      () => verifyReportingRowManifestsV1([encoded.manifests[1], encoded.manifests[0], encoded.manifests[2]], expected),
      'MANIFEST_MISMATCH'
    );
    const altered = structuredClone(encoded.manifests);
    altered[1].sha256 = 'f'.repeat(64);
    assertCode(() => verifyReportingRowManifestsV1(altered, expected), 'MANIFEST_MISMATCH');

    // A manifest that is self-consistent but breaks the contract tiling is
    // refused even when the caller supplies its matching digest.
    const truncated = structuredClone(encoded.manifests.slice(0, 1));
    truncated[0].segments.pop();
    const { reportingRowManifestSha256V1 } = require('../../dist/lib/reporting/ledger/index.js');
    assertCode(
      () =>
        verifyReportingRowManifestsV1(truncated, {
          rowCount: REPORTING_ROW_CHUNK_MAX_ROWS,
          rowManifestSha256: reportingRowManifestSha256V1(truncated),
        }),
      'MANIFEST_MISMATCH'
    );
  });

  test('chunk verification detects tampered bytes and segment line counts', () => {
    const encoded = encodeReportingRowsV1(rowsOf(1200));
    const [chunk] = encoded.chunks;
    verifyReportingRowChunkV1(chunk.manifest, chunk.bytes);

    const flipped = Buffer.from(chunk.bytes);
    flipped[10] ^= 0x01;
    assertCode(() => verifyReportingRowChunkV1(chunk.manifest, flipped), 'CHUNK_INTEGRITY_FAILED');
    assertCode(() => verifyReportingRowChunkV1(chunk.manifest, chunk.bytes.subarray(1)), 'CHUNK_INTEGRITY_FAILED');
  });

  test('ranged segment reads release only verified rows', () => {
    const rows = rowsOf(1200);
    const encoded = encodeReportingRowsV1(rows);
    const [chunk] = encoded.chunks;
    const [, second, third] = chunk.manifest.segments;
    const ranged = chunk.bytes.subarray(second.byte_offset, third.byte_offset + third.byte_count);
    assert.deepEqual(decodeVerifiedReportingRowSegmentsV1(chunk.manifest, [1, 2], ranged), rows.slice(500, 1200));

    const tampered = Buffer.from(ranged);
    tampered[tampered.byteLength - 5] ^= 0x01;
    assertCode(() => decodeVerifiedReportingRowSegmentsV1(chunk.manifest, [1, 2], tampered), 'CHUNK_INTEGRITY_FAILED');
    assertCode(() => decodeVerifiedReportingRowSegmentsV1(chunk.manifest, [2, 1], ranged), 'MANIFEST_MISMATCH');
    assertCode(() => decodeVerifiedReportingRowSegmentsV1(chunk.manifest, [0, 3], ranged), 'MANIFEST_MISMATCH');
    assertCode(() => decodeVerifiedReportingRowSegmentsV1(chunk.manifest, [0, 0], ranged), 'CHUNK_INTEGRITY_FAILED');
  });

  test('envelope hashing fails closed on row-count drift and partial rows', () => {
    const rows = rowsOf(3);
    const encoded = encodeReportingRowsV1(rows);
    const short = createReportingRevisionEnvelopeHasherV1({ ...envelope('rrev_x', rows), row_count: 4 });
    short.update(encoded.chunks[0].bytes);
    assertCode(() => short.digest(), 'ENVELOPE_INTEGRITY_FAILED');

    const partial = createReportingRevisionEnvelopeHasherV1(envelope('rrev_x', rows));
    assertCode(() => partial.update(encoded.chunks[0].bytes.subarray(0, 5)), 'CHUNK_INTEGRITY_FAILED');

    assertCode(
      () =>
        assertReportingRevisionEnvelopeV1(
          envelope('rrev_other', rows),
          encoded.chunks.map(chunk => chunk.bytes),
          referenceBinding('rrev_x', rows)
        ),
      'ENVELOPE_INTEGRITY_FAILED'
    );
  });

  test('rows_v1 profile equals sha256(JCS(rows))', () => {
    for (const rows of [[], rowsOf(1), rowsOf(1001)]) {
      const encoded = encodeReportingRowsV1(rows);
      const hasher = createReportingRowsOnlyHasherV1(rows.length);
      for (const chunk of encoded.chunks) hasher.update(chunk.bytes);
      const bytes = Buffer.from(canonicalize(rows), 'utf8');
      assert.deepEqual(hasher.digest(), {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteCount: bytes.byteLength,
      });
    }
  });

  test('matches the shared golden fixture byte for byte', () => {
    for (const vector of FIXTURE.vectors) {
      const encoded = encodeReportingRowsV1(vector.rows);
      assert.deepEqual(
        encoded.chunks.map(chunk => chunk.bytes.toString('base64')),
        vector.expected.chunks_base64,
        vector.id
      );
      assert.deepEqual(encoded.manifests, vector.expected.manifests, vector.id);
      assert.equal(encoded.rowManifestSha256, vector.expected.row_manifest_sha256, vector.id);
      assert.deepEqual(
        referenceBinding(vector.envelope.reporting_revision_id, vector.rows, vector.envelope.control_totals),
        { sha256: vector.expected.revision_content_sha256, byteCount: vector.expected.canonical_byte_count },
        vector.id
      );
      assert.deepEqual(
        reportingRevisionEnvelopeDigestV1(
          vector.envelope,
          encoded.chunks.map(chunk => chunk.bytes)
        ),
        {
          sha256: vector.expected.revision_content_sha256,
          byteCount: vector.expected.canonical_byte_count,
        },
        vector.id
      );
    }
  });
});
