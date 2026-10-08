import type {
  ReportingLedgerAdjustmentMetadataV1,
  ReportingLedgerRevisionMetadataV1,
  ReportingLedgerStore,
  ReportingRevisionRowsPageV1,
  ReportingRevisionRowsReadV1,
} from './types';

/**
 * Row-free revision listing for paths that only need identity, finality,
 * supersession, binding and wire metadata. Prefers the store's
 * `listRevisionMetadata`; a store without it is read through `listRevisions`
 * and its rows are dropped before they reach the caller.
 */
export async function listRevisionMetadataFromStore(
  store: Pick<ReportingLedgerStore, 'listRevisions' | 'listRevisionMetadata'>,
  reporting_obligation_id: string
): Promise<ReportingLedgerRevisionMetadataV1[]> {
  if (typeof store.listRevisionMetadata === 'function') {
    return store.listRevisionMetadata(reporting_obligation_id);
  }
  const revisions = await store.listRevisions(reporting_obligation_id);
  return revisions.map(({ rows: _rows, ...metadata }) => metadata);
}

/** Row-free counterpart of {@link listRevisionMetadataFromStore} for adjustments. */
export async function listAdjustmentMetadataFromStore(
  store: Pick<ReportingLedgerStore, 'listAdjustments' | 'listAdjustmentMetadata'>,
  reporting_obligation_id: string
): Promise<ReportingLedgerAdjustmentMetadataV1[]> {
  if (typeof store.listAdjustmentMetadata === 'function') {
    return store.listAdjustmentMetadata(reporting_obligation_id);
  }
  const adjustments = await store.listAdjustments(reporting_obligation_id);
  return adjustments.map(({ rows: _rows, ...metadata }) => metadata);
}

/** Account-scoped revision metadata, preferring the store's row-free read. */
export async function getRevisionMetadataFromStore(
  store: Pick<ReportingLedgerStore, 'getRevision' | 'getRevisionMetadata'>,
  reporting_revision_id: string,
  account_id: string
): Promise<ReportingLedgerRevisionMetadataV1 | null> {
  if (typeof store.getRevisionMetadata === 'function') {
    return store.getRevisionMetadata(reporting_revision_id, account_id);
  }
  const revision = await store.getRevision(reporting_revision_id, account_id);
  if (!revision) return null;
  const { rows: _rows, ...metadata } = revision;
  return metadata;
}

/**
 * One page of a revision's rows. Prefers the store's paged reader; otherwise
 * loads the revision through `getRevision` and slices it.
 */
export async function readRevisionRowsFromStore(
  store: Pick<ReportingLedgerStore, 'getRevision' | 'readRevisionRows'>,
  input: ReportingRevisionRowsReadV1
): Promise<ReportingRevisionRowsPageV1 | null> {
  if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
    throw new RangeError('Reporting row page offset must be a non-negative integer');
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
    throw new RangeError('Reporting row page limit must be a positive integer');
  }
  if (typeof store.readRevisionRows === 'function') return store.readRevisionRows(input);
  const revision = await store.getRevision(input.reporting_revision_id, input.account_id);
  if (!revision) return null;
  return {
    rows: revision.rows.slice(input.offset, input.offset + input.limit),
    total: revision.rows.length,
  };
}
