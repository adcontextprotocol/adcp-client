import type {
  CreateReportingManagedDeliveryRuntimeOptionsV1,
  ReportingManagedDeliveryStore,
} from '../lib/reporting/ledger/managed';

type RuntimeStore = CreateReportingManagedDeliveryRuntimeOptionsV1['store'];

declare const directStore: ReportingManagedDeliveryStore;
// @ts-expect-error Capability publication requires both durable policy hooks.
const runtimeStoreMissingPolicyHooks: RuntimeStore = directStore;

declare const recoveryOnlyStore: ReportingManagedDeliveryStore &
  Required<Pick<ReportingManagedDeliveryStore, 'adoptAdvertisedRecoveryWindowSeconds'>>;
// @ts-expect-error Recovery-window adoption alone cannot publish retention capabilities.
const runtimeStoreMissingRetentionHook: RuntimeStore = recoveryOnlyStore;

declare const retentionOnlyStore: ReportingManagedDeliveryStore &
  Required<Pick<ReportingManagedDeliveryStore, 'adoptAdvertisedStatusRetentionDays'>>;
// @ts-expect-error Status-retention adoption alone cannot publish recovery capabilities.
const runtimeStoreMissingRecoveryHook: RuntimeStore = retentionOnlyStore;

declare const publishingStore: ReportingManagedDeliveryStore &
  Required<
    Pick<ReportingManagedDeliveryStore, 'adoptAdvertisedRecoveryWindowSeconds' | 'adoptAdvertisedStatusRetentionDays'>
  >;
const runtimeStoreWithPolicyHooks: RuntimeStore = publishingStore;

void runtimeStoreMissingPolicyHooks;
void runtimeStoreMissingRetentionHook;
void runtimeStoreMissingRecoveryHook;
void runtimeStoreWithPolicyHooks;
