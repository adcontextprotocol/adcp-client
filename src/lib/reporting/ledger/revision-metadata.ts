import type {
  ReportingLedgerAdjustmentMetadataV1,
  ReportingLedgerRevisionMetadataV1,
  ReportingLedgerStore,
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
