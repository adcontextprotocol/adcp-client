import type {
  CreateReportingManagedDeliveryRuntimeOptionsV1,
  ReportingManagedDeliveryStore,
} from '../lib/reporting/ledger/managed';

type RuntimeStore = CreateReportingManagedDeliveryRuntimeOptionsV1['store'];

declare const directStore: ReportingManagedDeliveryStore;
// @ts-expect-error Capability publication requires atomic durable policy adoption.
const runtimeStoreMissingAtomicPolicyHook: RuntimeStore = directStore;

declare const separatePolicyStore: ReportingManagedDeliveryStore &
  Required<
    Pick<ReportingManagedDeliveryStore, 'adoptAdvertisedRecoveryWindowSeconds' | 'adoptAdvertisedStatusRetentionDays'>
  >;
// @ts-expect-error Separate hooks cannot make capability publication atomic.
const runtimeStoreWithOnlySeparatePolicyHooks: RuntimeStore = separatePolicyStore;

declare const publishingStore: ReportingManagedDeliveryStore &
  Required<Pick<ReportingManagedDeliveryStore, 'adoptAdvertisedPolicies'>>;
const runtimeStoreWithAtomicPolicyHook: RuntimeStore = publishingStore;

void runtimeStoreMissingAtomicPolicyHook;
void runtimeStoreWithOnlySeparatePolicyHooks;
void runtimeStoreWithAtomicPolicyHook;
