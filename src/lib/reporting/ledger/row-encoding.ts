import { createHash } from 'crypto';

import { canonicalize } from '../../utils/jcs';

/**
 * Canonical JSONL row encoding for reporting revisions (shared SDK
 * persistence contract, `reporting-row-storage` v1).
 *
 * Rows are stored as `JCS(row) + "\n"` in ordinal order. JCS escapes newline
 * characters inside strings, so the `0x0A` byte only ever separates rows.
 * Rows are grouped into segments (the unit of verification and paged reads)
 * and chunks (the unit of storage). Boundaries are fixed by the contract so
 * every SDK produces byte-identical chunks and manifests for the same rows:
 *
 * - a new chunk starts when the current chunk holds
 *   {@link REPORTING_ROW_CHUNK_MAX_ROWS} rows, or when appending the next row
 *   would exceed {@link REPORTING_ROW_CHUNK_MAX_BYTES} canonical bytes;
 * - segments restart at each chunk boundary and close every
 *   {@link REPORTING_ROW_SEGMENT_MAX_ROWS} rows.
 *
 * A row larger than the chunk byte limit forms its own segment and chunk.
 * Digests always cover uncompressed canonical bytes.
 */

export const REPORTING_ROW_ENCODING_V1 = 'adcp_canonical_jsonl_v1' as const;
export const REPORTING_ROW_SEGMENT_MAX_ROWS = 500;
export const REPORTING_ROW_CHUNK_MAX_SEGMENTS = 20;
export const REPORTING_ROW_CHUNK_MAX_ROWS = REPORTING_ROW_SEGMENT_MAX_ROWS * REPORTING_ROW_CHUNK_MAX_SEGMENTS;
export const REPORTING_ROW_CHUNK_MAX_BYTES = 8 * 1024 * 1024;

const NEWLINE = 0x0a;
const COMMA = Buffer.from(',', 'utf8');
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export type ReportingRowEncodingErrorCode =
  | 'INVALID_ROW'
  | 'MANIFEST_MISMATCH'
  | 'CHUNK_INTEGRITY_FAILED'
  | 'ENVELOPE_INTEGRITY_FAILED';

export class ReportingRowEncodingError extends Error {
  constructor(
    readonly code: ReportingRowEncodingErrorCode,
    detail: string
  ) {
    super(`Reporting row encoding: ${code}: ${detail}`);
    this.name = 'ReportingRowEncodingError';
    Object.defineProperty(this, Symbol.for('adcp.reportingRowEncodingError'), { value: true });
  }
}

export function isReportingRowEncodingError(error: unknown): error is ReportingRowEncodingError {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as Record<symbol, unknown>)[Symbol.for('adcp.reportingRowEncodingError')] === true
  );
}

export interface ReportingRowSegmentManifestV1 {
  first_ordinal: number;
  row_count: number;
  /** Offset of the segment within its chunk's uncompressed canonical bytes. */
  byte_offset: number;
  byte_count: number;
  sha256: string;
}

export interface ReportingRowChunkManifestV1 {
  chunk_index: number;
  first_ordinal: number;
  row_count: number;
  byte_count: number;
  sha256: string;
  segments: ReportingRowSegmentManifestV1[];
}

export interface ReportingRowChunkV1 {
  manifest: ReportingRowChunkManifestV1;
  /** Uncompressed canonical JSONL bytes. */
  bytes: Buffer;
}

export interface ReportingEncodedRowsV1 {
  encoding: typeof REPORTING_ROW_ENCODING_V1;
  rowCount: number;
  /** Total canonical JSONL bytes across all chunks. */
  byteCount: number;
  chunks: ReportingRowChunkV1[];
  manifests: ReportingRowChunkManifestV1[];
  /** `sha256(JCS(manifests))`; bound immutably on the revision header. */
  rowManifestSha256: string;
}

export interface ReportingRevisionEnvelopeInputV1 {
  reporting_revision_id: string;
  row_count: number;
  control_totals: readonly unknown[];
}

export interface ReportingRevisionEnvelopeDigestV1 {
  sha256: string;
  /** Byte length of the canonical envelope; equals `binding.byteCount`. */
  byteCount: number;
}

/**
 * Canonicalize one row for storage. Refuses values whose canonical bytes are
 * not portable across conforming JCS implementations: non-plain objects,
 * non-finite numbers, integers outside ±(2^53 − 1), and lone surrogates.
 */
export function canonicalReportingRowV1(row: unknown, ordinal = 0): string {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new ReportingRowEncodingError('INVALID_ROW', `row ${ordinal} is not a JSON object`);
  }
  assertPortableNumbers(row, ordinal);
  let canonical: string;
  try {
    canonical = canonicalize(row);
  } catch (error) {
    throw new ReportingRowEncodingError(
      'INVALID_ROW',
      `row ${ordinal} is not canonical JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (LONE_SURROGATE.test(canonical)) {
    throw new ReportingRowEncodingError('INVALID_ROW', `row ${ordinal} contains a lone surrogate`);
  }
  return canonical;
}

/** Encode rows into contract-fixed canonical JSONL chunks and manifests. */
export function encodeReportingRowsV1(rows: readonly unknown[]): ReportingEncodedRowsV1 {
  const chunks: ReportingRowChunkV1[] = [];
  let chunkLines: Buffer[] = [];
  let chunkBytes = 0;
  let chunkFirstOrdinal = 0;

  const closeChunk = () => {
    if (chunkLines.length === 0) return;
    chunks.push(buildChunk(chunks.length, chunkFirstOrdinal, chunkLines));
    chunkLines = [];
    chunkBytes = 0;
  };

  rows.forEach((row, ordinal) => {
    const line = Buffer.from(canonicalReportingRowV1(row, ordinal) + '\n', 'utf8');
    if (
      chunkLines.length === REPORTING_ROW_CHUNK_MAX_ROWS ||
      (chunkLines.length > 0 && chunkBytes + line.byteLength > REPORTING_ROW_CHUNK_MAX_BYTES)
    ) {
      closeChunk();
    }
    if (chunkLines.length === 0) chunkFirstOrdinal = ordinal;
    chunkLines.push(line);
    chunkBytes += line.byteLength;
  });
  closeChunk();

  const manifests = chunks.map(chunk => chunk.manifest);
  return {
    encoding: REPORTING_ROW_ENCODING_V1,
    rowCount: rows.length,
    byteCount: chunks.reduce((total, chunk) => total + chunk.manifest.byte_count, 0),
    chunks,
    manifests,
    rowManifestSha256: reportingRowManifestSha256V1(manifests),
  };
}

/** `sha256(JCS(manifests))` over the ordered chunk manifests, locators excluded. */
export function reportingRowManifestSha256V1(manifests: readonly ReportingRowChunkManifestV1[]): string {
  return sha256Hex(
    canonicalize(
      manifests.map(manifest => ({
        chunk_index: manifest.chunk_index,
        first_ordinal: manifest.first_ordinal,
        row_count: manifest.row_count,
        byte_count: manifest.byte_count,
        sha256: manifest.sha256,
        segments: manifest.segments.map(segment => ({
          first_ordinal: segment.first_ordinal,
          row_count: segment.row_count,
          byte_offset: segment.byte_offset,
          byte_count: segment.byte_count,
          sha256: segment.sha256,
        })),
      }))
    )
  );
}

/**
 * Verify that a manifest set is internally consistent and matches the
 * header's committed `row_manifest_sha256` and `row_count`. Ordinals must be
 * contiguous from zero, chunk and segment boundaries must follow the contract
 * limits, and segment byte ranges must tile their chunk exactly.
 */
export function verifyReportingRowManifestsV1(
  manifests: readonly ReportingRowChunkManifestV1[],
  expected: { rowCount: number; rowManifestSha256: string }
): void {
  if (reportingRowManifestSha256V1(manifests) !== expected.rowManifestSha256.toLowerCase()) {
    throw new ReportingRowEncodingError('MANIFEST_MISMATCH', 'chunk manifest digest does not match the header');
  }
  let nextOrdinal = 0;
  manifests.forEach((manifest, index) => {
    if (manifest.chunk_index !== index || manifest.first_ordinal !== nextOrdinal) {
      throw new ReportingRowEncodingError('MANIFEST_MISMATCH', `chunk ${index} is out of order`);
    }
    if (
      manifest.row_count < 1 ||
      manifest.row_count > REPORTING_ROW_CHUNK_MAX_ROWS ||
      manifest.segments.length < 1 ||
      manifest.segments.length > REPORTING_ROW_CHUNK_MAX_SEGMENTS
    ) {
      throw new ReportingRowEncodingError('MANIFEST_MISMATCH', `chunk ${index} exceeds contract limits`);
    }
    let segmentOrdinal = manifest.first_ordinal;
    let segmentOffset = 0;
    manifest.segments.forEach((segment, segmentIndex) => {
      const last = segmentIndex === manifest.segments.length - 1;
      if (
        segment.first_ordinal !== segmentOrdinal ||
        segment.byte_offset !== segmentOffset ||
        segment.row_count < 1 ||
        segment.byte_count < 1 ||
        segment.row_count > REPORTING_ROW_SEGMENT_MAX_ROWS ||
        (!last && segment.row_count !== REPORTING_ROW_SEGMENT_MAX_ROWS)
      ) {
        throw new ReportingRowEncodingError('MANIFEST_MISMATCH', `chunk ${index} segment ${segmentIndex} is invalid`);
      }
      segmentOrdinal += segment.row_count;
      segmentOffset += segment.byte_count;
    });
    if (segmentOrdinal !== manifest.first_ordinal + manifest.row_count || segmentOffset !== manifest.byte_count) {
      throw new ReportingRowEncodingError('MANIFEST_MISMATCH', `chunk ${index} segments do not tile the chunk`);
    }
    if (manifest.row_count > 1 && manifest.byte_count > REPORTING_ROW_CHUNK_MAX_BYTES) {
      throw new ReportingRowEncodingError('MANIFEST_MISMATCH', `chunk ${index} exceeds the byte limit`);
    }
    nextOrdinal += manifest.row_count;
  });
  if (nextOrdinal !== expected.rowCount) {
    throw new ReportingRowEncodingError('MANIFEST_MISMATCH', 'chunk manifests do not cover row_count');
  }
}

/**
 * Verify a whole chunk's canonical bytes against its manifest: total digest,
 * byte count, and every segment's digest and line count.
 */
export function verifyReportingRowChunkV1(manifest: ReportingRowChunkManifestV1, bytes: Uint8Array): void {
  const buffer = toBuffer(bytes);
  if (buffer.byteLength !== manifest.byte_count || sha256Hex(buffer) !== manifest.sha256) {
    throw new ReportingRowEncodingError('CHUNK_INTEGRITY_FAILED', `chunk ${manifest.chunk_index} digest mismatch`);
  }
  manifest.segments.forEach((segment, index) => {
    verifySegment(manifest, index, buffer.subarray(segment.byte_offset, segment.byte_offset + segment.byte_count));
  });
}

/**
 * Verify and decode a contiguous range of segments `[fromSegment, toSegment]`
 * (inclusive). `bytes` must hold exactly those segments' canonical bytes,
 * starting at the first segment's `byte_offset` — the shape returned by a
 * ranged object read. Rows are released only after every segment verifies.
 */
export function decodeVerifiedReportingRowSegmentsV1(
  manifest: ReportingRowChunkManifestV1,
  segmentRange: readonly [fromSegment: number, toSegment: number],
  bytes: Uint8Array
): Record<string, unknown>[] {
  const [from, to] = segmentRange;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to >= manifest.segments.length) {
    throw new ReportingRowEncodingError('MANIFEST_MISMATCH', 'segment range is outside the chunk');
  }
  const buffer = toBuffer(bytes);
  const base = manifest.segments[from]!.byte_offset;
  const end = manifest.segments[to]!.byte_offset + manifest.segments[to]!.byte_count;
  if (buffer.byteLength !== end - base) {
    throw new ReportingRowEncodingError('CHUNK_INTEGRITY_FAILED', 'segment range byte length mismatch');
  }
  for (let index = from; index <= to; index += 1) {
    const segment = manifest.segments[index]!;
    verifySegment(
      manifest,
      index,
      buffer.subarray(segment.byte_offset - base, segment.byte_offset - base + segment.byte_count)
    );
  }
  return splitLines(buffer).map(line => JSON.parse(line.toString('utf8')) as Record<string, unknown>);
}

/**
 * Streaming hasher for the protocol revision binding
 * `sha256(JCS({reporting_revision_id, row_count, control_totals, reporting_rows}))`.
 * Feed verified chunk bytes in order; rows are never parsed.
 */
export function createReportingRevisionEnvelopeHasherV1(envelope: ReportingRevisionEnvelopeInputV1): {
  update(chunkBytes: Uint8Array): void;
  digest(): ReportingRevisionEnvelopeDigestV1;
} {
  const prefix = Buffer.from(
    `{"control_totals":${canonicalize(envelope.control_totals)},"reporting_revision_id":${canonicalize(
      envelope.reporting_revision_id
    )},"reporting_rows":[`,
    'utf8'
  );
  const suffix = Buffer.from(`],"row_count":${canonicalize(envelope.row_count)}}`, 'utf8');
  return createJoinedRowsHasher(prefix, suffix, envelope.row_count);
}

/** Envelope digest over already-encoded chunk bytes. */
export function reportingRevisionEnvelopeDigestV1(
  envelope: ReportingRevisionEnvelopeInputV1,
  chunks: Iterable<Uint8Array>
): ReportingRevisionEnvelopeDigestV1 {
  const hasher = createReportingRevisionEnvelopeHasherV1(envelope);
  for (const chunk of chunks) hasher.update(chunk);
  return hasher.digest();
}

/** Streaming hasher for digest profile `rows_v1`: `sha256(JCS(rows))`. */
export function createReportingRowsOnlyHasherV1(rowCount: number): {
  update(chunkBytes: Uint8Array): void;
  digest(): ReportingRevisionEnvelopeDigestV1;
} {
  return createJoinedRowsHasher(Buffer.from('[', 'utf8'), Buffer.from(']', 'utf8'), rowCount);
}

/**
 * Throw unless the canonical chunks reproduce the header's committed revision
 * binding. Used at write time (proof that chunks and envelope agree) and for
 * full-revision reads.
 */
export function assertReportingRevisionEnvelopeV1(
  envelope: ReportingRevisionEnvelopeInputV1,
  chunks: Iterable<Uint8Array>,
  expected: { sha256: string; byteCount?: number }
): void {
  const actual = reportingRevisionEnvelopeDigestV1(envelope, chunks);
  if (
    actual.sha256 !== expected.sha256.toLowerCase() ||
    (expected.byteCount !== undefined && actual.byteCount !== expected.byteCount)
  ) {
    throw new ReportingRowEncodingError('ENVELOPE_INTEGRITY_FAILED', 'revision content binding mismatch');
  }
}

function buildChunk(chunkIndex: number, firstOrdinal: number, lines: readonly Buffer[]): ReportingRowChunkV1 {
  const segments: ReportingRowSegmentManifestV1[] = [];
  let offset = 0;
  for (let start = 0; start < lines.length; start += REPORTING_ROW_SEGMENT_MAX_ROWS) {
    const segmentLines = lines.slice(start, start + REPORTING_ROW_SEGMENT_MAX_ROWS);
    const segmentBytes = Buffer.concat(segmentLines);
    segments.push({
      first_ordinal: firstOrdinal + start,
      row_count: segmentLines.length,
      byte_offset: offset,
      byte_count: segmentBytes.byteLength,
      sha256: sha256Hex(segmentBytes),
    });
    offset += segmentBytes.byteLength;
  }
  const bytes = Buffer.concat(lines);
  return {
    manifest: {
      chunk_index: chunkIndex,
      first_ordinal: firstOrdinal,
      row_count: lines.length,
      byte_count: bytes.byteLength,
      sha256: sha256Hex(bytes),
      segments,
    },
    bytes,
  };
}

function verifySegment(manifest: ReportingRowChunkManifestV1, index: number, bytes: Buffer): void {
  const segment = manifest.segments[index]!;
  if (bytes.byteLength !== segment.byte_count || sha256Hex(bytes) !== segment.sha256) {
    throw new ReportingRowEncodingError(
      'CHUNK_INTEGRITY_FAILED',
      `chunk ${manifest.chunk_index} segment ${index} digest mismatch`
    );
  }
  let lines = 0;
  for (const byte of bytes) if (byte === NEWLINE) lines += 1;
  if (lines !== segment.row_count || bytes[bytes.byteLength - 1] !== NEWLINE) {
    throw new ReportingRowEncodingError(
      'CHUNK_INTEGRITY_FAILED',
      `chunk ${manifest.chunk_index} segment ${index} line count mismatch`
    );
  }
}

function createJoinedRowsHasher(
  prefix: Buffer,
  suffix: Buffer,
  expectedRows: number
): { update(chunkBytes: Uint8Array): void; digest(): ReportingRevisionEnvelopeDigestV1 } {
  const hash = createHash('sha256').update(prefix);
  let byteCount = prefix.byteLength;
  let rows = 0;
  let finished = false;
  return {
    update(chunkBytes) {
      if (finished) throw new Error('Reporting row hasher already finished');
      const buffer = toBuffer(chunkBytes);
      if (buffer.byteLength > 0 && buffer[buffer.byteLength - 1] !== NEWLINE) {
        throw new ReportingRowEncodingError('CHUNK_INTEGRITY_FAILED', 'chunk does not end at a row boundary');
      }
      for (const line of splitLines(buffer)) {
        if (rows > 0) {
          hash.update(COMMA);
          byteCount += 1;
        }
        hash.update(line);
        byteCount += line.byteLength;
        rows += 1;
      }
    },
    digest() {
      if (finished) throw new Error('Reporting row hasher already finished');
      finished = true;
      if (rows !== expectedRows) {
        throw new ReportingRowEncodingError('ENVELOPE_INTEGRITY_FAILED', 'row count does not match the header');
      }
      hash.update(suffix);
      return { sha256: hash.digest('hex'), byteCount: byteCount + suffix.byteLength };
    },
  };
}

function splitLines(buffer: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < buffer.byteLength; index += 1) {
    if (buffer[index] === NEWLINE) {
      lines.push(buffer.subarray(start, index));
      start = index + 1;
    }
  }
  if (start !== buffer.byteLength) {
    throw new ReportingRowEncodingError('CHUNK_INTEGRITY_FAILED', 'trailing bytes after the last row');
  }
  return lines;
}

function assertPortableNumbers(value: unknown, ordinal: number): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new ReportingRowEncodingError(
        'INVALID_ROW',
        `row ${ordinal} contains a number outside the portable range; encode it as a string`
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertPortableNumbers(item, ordinal);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) assertPortableNumbers(item, ordinal);
  }
}

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
