import type { ReportingConsumerStatus } from '../../types';
import type { ReportingConsumerStatusV1 } from './status-ingest';
import type { ReportingLedgerConsumerStatementV1, ReportingLedgerConsumerStatusInputV1 } from './types';

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// Compiled by typecheck on both the primary pin and candidate bundles. New
// wire fields/statuses must survive the generated -> ledger -> wire roundtrip.
export type LedgerInputMatchesWire = Assert<
  Equal<Omit<ReportingLedgerConsumerStatusInputV1, 'account_id' | 'consumerId'>, ReportingConsumerStatusV1>
>;
export type LedgerStatementMatchesWire = Assert<
  Equal<
    Omit<ReportingLedgerConsumerStatementV1, 'account_id' | 'consumerId' | 'recorded_at'>,
    ReportingConsumerStatusV1
  >
>;
export type RecordedAtIsRequired = Assert<Equal<ReportingLedgerConsumerStatementV1['recorded_at'], string>>;
export type StatusesMatch = Assert<
  Equal<ReportingLedgerConsumerStatusInputV1['consumer_status'], ReportingConsumerStatus['consumer_status']>
>;
