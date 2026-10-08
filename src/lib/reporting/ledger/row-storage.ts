import { createHash } from 'crypto';

import { canonicalize } from '../../utils/jcs';
import {
  REPORTING_ROW_ENCODING_V1,
  createReportingRevisionEnvelopeHasherV1,
  createReportingRowsOnlyHasherV1,
  decodeVerifiedReportingRowSegmentsV1,
  encodeReportingRowsV1,
  isReportingRowEncodingError,
  verifyReportingRowChunkV1,
  verifyReportingRowManifestsV1,
  type ReportingEncodedRowsV1,
  type ReportingRowChunkManifestV1,
  type ReportingRowSegmentManifestV1,
} from './row-encoding';
import { probeReportingRowStorageSchemaV1 } from './row-storage-migration';

/**
 * Revision row storage (shared SDK persistence spec,
 * adcontextprotocol/adcp#7996 §3). Revision headers stay in the ledger
 * document; rows live as canonical JSONL chunks in a storage binding, and
 * every read is verified against digests committed in PostgreSQL before rows
 * are released.
 */

export type ReportingRowStoreErrorCode =
  | 'INVALID_INPUT'
  | 'CONTENT_CONFLICT'
  | 'ROWS_INTEGRITY_FAILED'
  | 'ROWS_UNAVAILABLE'
  | 'ROWS_EXPIRED'
  | 'PROVIDER_UNAVAILABLE'
  | 'DEADLINE_EXCEEDED'
  | 'ABORTED'
  | 'UNSAFE_BINDING'
  | 'STATE_UNAVAILABLE';

/** Stable, secret-free row-storage failure. Switch on `code`. */
export class ReportingRowStoreError extends Error {
  constructor(
    readonly code: ReportingRowStoreErrorCode,
    detail?: string
  ) {
    super(detail ? `Reporting row store: ${code}: ${detail}` : `Reporting row store: ${code}`);
    this.name = 'ReportingRowStoreError';
    Object.defineProperty(this, Symbol.for('adcp.reportingRowStoreError'), { value: true });
  }
}

export function isReportingRowStoreError(error: unknown): error is ReportingRowStoreError {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as Record<symbol, unknown>)[Symbol.for('adcp.reportingRowStoreError')] === true
  );
}

/** Rows stored as chunk bodies in the ledger's own PostgreSQL schema. */
export interface ReportingPostgresRowBindingV1 {
  kind: 'postgres';
}

export type ReportingRowBindingDefinitionV1 = ReportingPostgresRowBindingV1;

export interface ReportingRowBindingSelectionInputV1 {
  account_id: string;
  reporting_obligation_id: string;
  row_set_kind: 'revision' | 'adjustment';
  finality?: 'snapshot' | 'official';
  row_count: number;
  canonical_byte_count: number;
}

export interface ReportingRowStorageOptionsV1 {
  /**
   * Logical binding ID → immutable definition. Defaults to a single
   * `postgres` binding. Changing a definition requires a new ID; existing
   * revisions keep resolving through the binding they were written with.
   */
  bindings?: Readonly<Record<string, ReportingRowBindingDefinitionV1>>;
  /** Picks the binding for each new row set. Defaults to the only binding, or `postgres`. */
  selectRowBinding?(input: ReportingRowBindingSelectionInputV1): string | Promise<string>;
  /**
   * Stable deployment namespace, combined with the schema's installation
   * identity into each binding's `namespace_key`. Defaults to `default`.
   */
  deploymentNamespace?: string;
}

export interface ReportingRowSetPrepareInputV1 {
  rowSetId: string;
  rowSetKind: 'revision' | 'adjustment';
  accountId: string;
  obligationId: string;
  rows: readonly Record<string, unknown>[];
  finality?: 'snapshot' | 'official';
  /** Committed protocol binding the chunks must reproduce. */
  binding: { sha256: string; byteCount: number; rowCount: number };
  /** Required for revisions (`revision_envelope_v1`); omitted for adjustments (`rows_v1`). */
  controlTotals?: readonly unknown[];
}

export interface ReportingPreparedRowSetV1 {
  readonly input: ReportingRowSetPrepareInputV1;
  readonly encoded: ReportingEncodedRowsV1;
  readonly bindingId: string;
  readonly binding: ReportingRowBindingDefinitionV1;
  readonly digestProfile: 'revision_envelope_v1' | 'rows_v1';
}

interface QueryableV1 {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: Row[]; rowCount?: number | null }>;
}

interface RowSetRecordV1 {
  row_set_id: string;
  row_set_kind: 'revision' | 'adjustment';
  account_id: string;
  obligation_id: string;
  digest_profile: 'revision_envelope_v1' | 'rows_v1';
  content_sha256: string;
  canonical_byte_count: string | number;
  row_count: string | number;
  row_manifest_sha256: string;
  chunk_count: number;
  row_binding_id: string;
  row_location_version: number;
  rows_state: 'live' | 'pruning' | 'pruned' | 'unavailable';
  kind: 'postgres' | 'object';
}

interface ChunkRecordV1 {
  chunk_index: number;
  first_ordinal: string | number;
  row_count: number;
  byte_count: string | number;
  sha256: string;
  segments: ReportingRowSegmentManifestV1[];
}

/** A row set whose chunk manifest has been verified against its committed digest. */
export interface ReportingRowSetHandleV1 {
  readonly rowSetId: string;
  readonly rowSetKind: 'revision' | 'adjustment';
  readonly accountId: string;
  readonly obligationId: string;
  readonly digestProfile: 'revision_envelope_v1' | 'rows_v1';
  readonly contentSha256: string;
  readonly canonicalByteCount: number;
  readonly rowCount: number;
  readonly rowManifestSha256: string;
  readonly bindingId: string;
  readonly kind: 'postgres' | 'object';
  readonly manifests: readonly ReportingRowChunkManifestV1[];
}

const DEFAULT_BINDING_ID = 'postgres';
const BINDING_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Reads and writes revision row sets. Reads are always available once the
 * row-storage migration is applied; writes require an explicit opt-in on the
 * owning store.
 */
export class ReportingRowStorageV1 {
  private readonly bindings: Readonly<Record<string, ReportingRowBindingDefinitionV1>>;
  private readonly deploymentNamespace: string;
  private readied?: Promise<void>;

  constructor(
    private readonly pool: QueryableV1,
    private readonly options: ReportingRowStorageOptionsV1 = {}
  ) {
    const bindings = options.bindings ?? { [DEFAULT_BINDING_ID]: { kind: 'postgres' } };
    const ids = Object.keys(bindings);
    if (ids.length === 0) throw new ReportingRowStoreError('INVALID_INPUT', 'at least one row binding is required');
    for (const id of ids) {
      if (!BINDING_ID.test(id)) throw new ReportingRowStoreError('INVALID_INPUT', `invalid row binding ID ${id}`);
      if (bindings[id]!.kind !== 'postgres') {
        throw new ReportingRowStoreError('INVALID_INPUT', `row binding ${id} has an unsupported kind`);
      }
    }
    this.bindings = Object.freeze({ ...bindings });
    this.deploymentNamespace = options.deploymentNamespace ?? 'default';
    if (!this.deploymentNamespace || this.deploymentNamespace.length > 256) {
      throw new ReportingRowStoreError('INVALID_INPUT', 'deploymentNamespace must be 1-256 characters');
    }
  }

  /** Probe the schema and register (or verify) every configured binding. Idempotent. */
  ready(): Promise<void> {
    this.readied ??= this.register().catch(error => {
      this.readied = undefined;
      throw error;
    });
    return this.readied;
  }

  /** Encode rows, prove the chunks reproduce the committed binding, and select a binding. */
  async prepare(input: ReportingRowSetPrepareInputV1): Promise<ReportingPreparedRowSetV1> {
    await this.ready();
    let encoded: ReportingEncodedRowsV1;
    try {
      encoded = encodeReportingRowsV1(input.rows);
    } catch (error) {
      if (isReportingRowEncodingError(error)) throw new ReportingRowStoreError('INVALID_INPUT', error.message);
      throw error;
    }
    const digestProfile = input.rowSetKind === 'revision' ? 'revision_envelope_v1' : 'rows_v1';
    const hasher =
      digestProfile === 'revision_envelope_v1'
        ? createReportingRevisionEnvelopeHasherV1({
            reporting_revision_id: input.rowSetId,
            row_count: input.rows.length,
            control_totals: input.controlTotals ?? [],
          })
        : createReportingRowsOnlyHasherV1(input.rows.length);
    for (const chunk of encoded.chunks) hasher.update(chunk.bytes);
    const digest = hasher.digest();
    if (
      digest.sha256 !== input.binding.sha256 ||
      digest.byteCount !== input.binding.byteCount ||
      input.binding.rowCount !== input.rows.length
    ) {
      throw new ReportingRowStoreError('INVALID_INPUT', 'rows do not reproduce their committed binding');
    }
    const ids = Object.keys(this.bindings);
    const bindingId = this.options.selectRowBinding
      ? await this.options.selectRowBinding({
          account_id: input.accountId,
          reporting_obligation_id: input.obligationId,
          row_set_kind: input.rowSetKind,
          ...(input.finality ? { finality: input.finality } : {}),
          row_count: input.rows.length,
          canonical_byte_count: digest.byteCount,
        })
      : ids.length === 1
        ? ids[0]!
        : DEFAULT_BINDING_ID;
    const binding = this.bindings[bindingId];
    if (!binding) throw new ReportingRowStoreError('INVALID_INPUT', `row binding ${bindingId} is not configured`);
    return Object.freeze({ input, encoded, bindingId, binding, digestProfile });
  }

  /**
   * Persist a prepared `postgres`-kind row set inside the caller's ledger
   * transaction. Replays of an identical row set are no-ops; a conflicting
   * row set under the same ID is refused.
   */
  async writeInTransaction(transaction: QueryableV1, prepared: ReportingPreparedRowSetV1): Promise<void> {
    const { input, encoded } = prepared;
    const inserted = await transaction.query(
      `INSERT INTO adcp_reporting_row_sets
         (row_set_id, row_set_kind, account_id, obligation_id, encoding, digest_profile, content_sha256,
          canonical_byte_count, row_count, row_manifest_sha256, chunk_count, row_binding_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (row_set_id) DO NOTHING`,
      [
        input.rowSetId,
        input.rowSetKind,
        input.accountId,
        input.obligationId,
        REPORTING_ROW_ENCODING_V1,
        prepared.digestProfile,
        input.binding.sha256,
        input.binding.byteCount,
        encoded.rowCount,
        encoded.rowManifestSha256,
        encoded.chunks.length,
        prepared.bindingId,
      ]
    );
    if (inserted.rowCount !== 1) {
      const existing = await transaction.query<{ content_sha256: string; row_manifest_sha256: string }>(
        'SELECT content_sha256, row_manifest_sha256 FROM adcp_reporting_row_sets WHERE row_set_id = $1',
        [input.rowSetId]
      );
      const row = existing.rows[0];
      if (
        !row ||
        row.content_sha256 !== input.binding.sha256 ||
        row.row_manifest_sha256 !== encoded.rowManifestSha256
      ) {
        throw new ReportingRowStoreError('CONTENT_CONFLICT', 'row set identity names different content');
      }
      return;
    }
    for (const chunk of encoded.chunks) {
      const manifest = chunk.manifest;
      await transaction.query(
        `INSERT INTO adcp_reporting_chunk_bodies (account_id, obligation_id, sha256, body)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [input.accountId, input.obligationId, manifest.sha256, chunk.bytes]
      );
      await transaction.query(
        `INSERT INTO adcp_reporting_row_chunks
           (row_set_id, chunk_index, account_id, obligation_id, first_ordinal, row_count, byte_count, sha256, segments)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          input.rowSetId,
          manifest.chunk_index,
          input.accountId,
          input.obligationId,
          manifest.first_ordinal,
          manifest.row_count,
          manifest.byte_count,
          manifest.sha256,
          JSON.stringify(manifest.segments),
        ]
      );
    }
  }

  /**
   * Load a row set and verify its chunk manifest against the committed digest.
   * Returns `null` when no row set exists (legacy inline rows) or it belongs
   * to another account. Throws `ROWS_EXPIRED` / `ROWS_UNAVAILABLE` when the
   * rows were pruned or lost.
   */
  async find(
    rowSetId: string,
    accountId: string,
    queryable: QueryableV1 = this.pool
  ): Promise<ReportingRowSetHandleV1 | null> {
    const found = await queryable.query<RowSetRecordV1 & Record<string, unknown>>(
      `SELECT row_set.row_set_id, row_set.row_set_kind, row_set.account_id, row_set.obligation_id,
              row_set.digest_profile, row_set.content_sha256, row_set.canonical_byte_count, row_set.row_count,
              row_set.row_manifest_sha256, row_set.chunk_count, row_set.row_binding_id,
              row_set.row_location_version, row_set.rows_state, binding.kind
         FROM adcp_reporting_row_sets row_set
         JOIN adcp_reporting_row_bindings binding ON binding.row_binding_id = row_set.row_binding_id
        WHERE row_set.row_set_id = $1 AND row_set.account_id = $2`,
      [rowSetId, accountId]
    );
    const record = found.rows[0];
    if (!record) return null;
    if (record.rows_state === 'pruning' || record.rows_state === 'pruned') {
      throw new ReportingRowStoreError('ROWS_EXPIRED');
    }
    if (record.rows_state === 'unavailable') throw new ReportingRowStoreError('ROWS_UNAVAILABLE');
    const chunks = await queryable.query<ChunkRecordV1 & Record<string, unknown>>(
      `SELECT chunk_index, first_ordinal, row_count, byte_count, sha256, segments
         FROM adcp_reporting_row_chunks WHERE row_set_id = $1 ORDER BY chunk_index`,
      [rowSetId]
    );
    const manifests: ReportingRowChunkManifestV1[] = chunks.rows.map(chunk => ({
      chunk_index: chunk.chunk_index,
      first_ordinal: Number(chunk.first_ordinal),
      row_count: chunk.row_count,
      byte_count: Number(chunk.byte_count),
      sha256: chunk.sha256,
      segments: chunk.segments.map(segment => ({
        first_ordinal: Number(segment.first_ordinal),
        row_count: Number(segment.row_count),
        byte_offset: Number(segment.byte_offset),
        byte_count: Number(segment.byte_count),
        sha256: segment.sha256,
      })),
    }));
    const rowCount = Number(record.row_count);
    try {
      verifyReportingRowManifestsV1(manifests, { rowCount, rowManifestSha256: record.row_manifest_sha256 });
    } catch (error) {
      if (isReportingRowEncodingError(error)) throw new ReportingRowStoreError('ROWS_INTEGRITY_FAILED', error.message);
      throw error;
    }
    if (manifests.length !== record.chunk_count) {
      throw new ReportingRowStoreError('ROWS_INTEGRITY_FAILED', 'chunk count does not match the row set');
    }
    return Object.freeze({
      rowSetId: record.row_set_id,
      rowSetKind: record.row_set_kind,
      accountId: record.account_id,
      obligationId: record.obligation_id,
      digestProfile: record.digest_profile,
      contentSha256: record.content_sha256,
      canonicalByteCount: Number(record.canonical_byte_count),
      rowCount,
      rowManifestSha256: record.row_manifest_sha256,
      bindingId: record.row_binding_id,
      kind: record.kind,
      manifests: Object.freeze(manifests),
    });
  }

  /** Verified rows `[offset, offset + limit)` in ordinal order. */
  async readPage(
    handle: ReportingRowSetHandleV1,
    offset: number,
    limit: number,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>[]> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) {
      throw new ReportingRowStoreError('INVALID_INPUT', 'row page bounds are invalid');
    }
    const end = Math.min(handle.rowCount, offset + limit);
    const rows: Record<string, unknown>[] = [];
    for (const manifest of handle.manifests) {
      if (offset >= end) break;
      const chunkEnd = manifest.first_ordinal + manifest.row_count;
      if (chunkEnd <= offset || manifest.first_ordinal >= end) continue;
      signal?.throwIfAborted();
      const from = manifest.segments.findIndex(
        segment => segment.first_ordinal + segment.row_count > Math.max(offset, manifest.first_ordinal)
      );
      let to = from;
      while (to + 1 < manifest.segments.length && manifest.segments[to + 1]!.first_ordinal < end) to += 1;
      const firstSegment = manifest.segments[from]!;
      const lastSegment = manifest.segments[to]!;
      const bytes = await this.readChunkRange(
        handle,
        manifest,
        firstSegment.byte_offset,
        lastSegment.byte_offset + lastSegment.byte_count - firstSegment.byte_offset
      );
      const decoded = this.decode(() => decodeVerifiedReportingRowSegmentsV1(manifest, [from, to], bytes));
      const startIndex = Math.max(offset, firstSegment.first_ordinal) - firstSegment.first_ordinal;
      const endIndex = Math.min(end, lastSegment.first_ordinal + lastSegment.row_count) - firstSegment.first_ordinal;
      rows.push(...decoded.slice(startIndex, endIndex));
    }
    return rows;
  }

  /**
   * Every row, verified chunk by chunk and against the committed binding.
   * `controlTotals` are required for revision row sets.
   */
  async readAll(
    handle: ReportingRowSetHandleV1,
    controlTotals?: readonly unknown[],
    options: { maxBytes?: number; signal?: AbortSignal } = {}
  ): Promise<Record<string, unknown>[]> {
    if (options.maxBytes !== undefined && handle.canonicalByteCount > options.maxBytes) {
      throw new ReportingRowStoreError('INVALID_INPUT', 'row set exceeds the hydration byte limit');
    }
    const hasher =
      handle.digestProfile === 'revision_envelope_v1'
        ? createReportingRevisionEnvelopeHasherV1({
            reporting_revision_id: handle.rowSetId,
            row_count: handle.rowCount,
            control_totals: controlTotals ?? [],
          })
        : createReportingRowsOnlyHasherV1(handle.rowCount);
    const rows: Record<string, unknown>[] = [];
    for (const manifest of handle.manifests) {
      options.signal?.throwIfAborted();
      const bytes = await this.readChunkRange(handle, manifest, 0, manifest.byte_count);
      this.decode(() => verifyReportingRowChunkV1(manifest, bytes));
      hasher.update(bytes);
      rows.push(
        ...this.decode(() => decodeVerifiedReportingRowSegmentsV1(manifest, [0, manifest.segments.length - 1], bytes))
      );
    }
    const digest = this.decode(() => hasher.digest());
    if (digest.sha256 !== handle.contentSha256 || digest.byteCount !== handle.canonicalByteCount) {
      throw new ReportingRowStoreError('ROWS_INTEGRITY_FAILED', 'rows do not reproduce the committed binding');
    }
    return rows;
  }

  private async readChunkRange(
    handle: ReportingRowSetHandleV1,
    manifest: ReportingRowChunkManifestV1,
    byteOffset: number,
    byteCount: number
  ): Promise<Buffer> {
    if (handle.kind !== 'postgres') throw new ReportingRowStoreError('STATE_UNAVAILABLE', 'unsupported row binding');
    const result = await this.pool.query<{ bytes: Buffer }>(
      `SELECT substring(body FROM $4::integer + 1 FOR $5::integer) AS bytes
         FROM adcp_reporting_chunk_bodies
        WHERE account_id = $1 AND obligation_id = $2 AND sha256 = $3`,
      [handle.accountId, handle.obligationId, manifest.sha256, byteOffset, byteCount]
    );
    const bytes = result.rows[0]?.bytes;
    if (!bytes) throw new ReportingRowStoreError('ROWS_UNAVAILABLE', `chunk ${manifest.chunk_index} body is missing`);
    return bytes;
  }

  private decode<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (isReportingRowEncodingError(error)) throw new ReportingRowStoreError('ROWS_INTEGRITY_FAILED', error.message);
      throw error;
    }
  }

  private async register(): Promise<void> {
    const { installationId } = await probeReportingRowStorageSchemaV1(this.pool);
    const namespaceKey = sha256Hex(canonicalize(['adcp.rows.v1', this.deploymentNamespace, installationId]));
    for (const [bindingId, binding] of Object.entries(this.bindings)) {
      const identityConfig = {};
      const identitySha256 = sha256Hex(canonicalize([binding.kind, binding.kind, identityConfig]));
      await this.pool.query(
        `INSERT INTO adcp_reporting_row_bindings
           (row_binding_id, kind, provider, identity_config, identity_sha256, namespace_key)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         ON CONFLICT (row_binding_id) DO NOTHING`,
        [bindingId, binding.kind, binding.kind, JSON.stringify(identityConfig), identitySha256, namespaceKey]
      );
      const stored = await this.pool.query<{ identity_sha256: string; namespace_key: string; state: string }>(
        'SELECT identity_sha256, namespace_key, state FROM adcp_reporting_row_bindings WHERE row_binding_id = $1',
        [bindingId]
      );
      const row = stored.rows[0];
      if (!row || row.identity_sha256 !== identitySha256) {
        throw new ReportingRowStoreError(
          'UNSAFE_BINDING',
          `row binding ${bindingId} identity differs from its definition`
        );
      }
      if (row.namespace_key !== namespaceKey) {
        throw new ReportingRowStoreError('UNSAFE_BINDING', `row binding ${bindingId} belongs to another installation`);
      }
    }
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
