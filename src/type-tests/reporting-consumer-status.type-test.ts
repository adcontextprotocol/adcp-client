import type {
  SyncReportingStatusHandlerV1,
  SyncReportingStatusRequestV1,
  SyncReportingStatusResponseV1,
} from '../lib/reporting/ledger/status-ingest';
import type { MediaBuyHandlers } from '../lib/server/create-adcp-server';

type Completed = Extract<SyncReportingStatusResponseV1, { status: 'completed' }>;
type Recorded = Extract<Completed['results'][number], { result: 'recorded' | 'unchanged' }>;
type Failed = Extract<Completed['results'][number], { result: 'failed' }>;

type Assert<T extends true> = T;
type IsRequired<T, K extends keyof T> = {} extends Pick<T, K> ? false : true;

type _CompletedResultsAreNonempty = Assert<Completed['results'] extends [unknown, ...unknown[]] ? true : false>;
type _RecordedAtIsRequired = Assert<IsRequired<Recorded['consumer_status'], 'recorded_at'>>;
type _FailedErrorsAreNonempty = Assert<Failed['errors'] extends [unknown, ...unknown[]] ? true : false>;
type _SubmittedStatusOmitsRecordedAt = Assert<
  'recorded_at' extends keyof SyncReportingStatusRequestV1['statuses'][number] ? false : true
>;
type SyncReportingStatusServerSlot = NonNullable<MediaBuyHandlers['syncReportingStatus']>;
type _SdkHandlerFitsServerSlot = Assert<
  SyncReportingStatusHandlerV1<Parameters<SyncReportingStatusServerSlot>[1]> extends SyncReportingStatusServerSlot
    ? true
    : false
>;

declare const recorded: Recorded;
declare const failed: Failed;
recorded.consumer_status.recorded_at.toUpperCase();
failed.errors[0]!.code.toUpperCase();
