import { Storage } from '@google-cloud/storage';
import {
  createReportingStatusHandler,
  type ReportingLedgerStore,
  type ReportingStatusHandlerV1,
} from '@adcp/sdk/reporting/ledger';
import {
  createGcsReportingResourceReaderV1,
  createGcsReportingReferenceResolverV1,
  type GcsReportingReaderOptionsV1,
} from '@adcp/sdk/reporting/gcs';

declare const store: ReportingLedgerStore;
interface ExistingContext {
  account: { id: string };
  consumer: string;
}
const genericHandler: ReportingStatusHandlerV1 = createReportingStatusHandler<ExistingContext>(store);
const implicitHandler: ReportingStatusHandlerV1 = createReportingStatusHandler(store);
const inferredReturn: ReturnType<typeof createReportingStatusHandler> = genericHandler;
const options: GcsReportingReaderOptionsV1 = {
  scope: {
    principal_id: 'saved-principal',
    account_id: 'saved-account',
    destination_ref: 'saved-destination',
    generation: 1,
  },
  bucket: 'saved-private-bucket',
  objectPrefix: 'saved-contracts/',
  getStorage: async () => new Storage(),
  authorize: async () => false,
};
void [
  implicitHandler,
  inferredReturn,
  createGcsReportingResourceReaderV1(options),
  createGcsReportingReferenceResolverV1(options),
];
