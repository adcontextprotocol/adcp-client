import type {
  CreateReportingManagedDeliveryRuntimeOptionsV1,
  ReportingManagedDeliveryStore,
} from '../lib/reporting/ledger/managed';

type RuntimeStore = CreateReportingManagedDeliveryRuntimeOptionsV1['store'];
type RuntimeStoreRequiresRecoveryWindowIntrospection = RuntimeStore extends {
  listInstalledRecoveryWindowSeconds: (...args: never[]) => unknown;
}
  ? true
  : false;
const recoveryWindowIntrospectionIsOptional: RuntimeStoreRequiresRecoveryWindowIntrospection = false;

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

publishingStore.adoptAdvertisedPolicies({
  automatedRecoveryWindowSeconds: 60,
  statusRetentionDays: 30,
  resourceRetentionDays: 30,
  authorizationRevocationSeconds: 60,
});
// @ts-expect-error Atomic capability adoption must include the resource and revocation promises.
publishingStore.adoptAdvertisedPolicies({
  automatedRecoveryWindowSeconds: 60,
  statusRetentionDays: 30,
});

void runtimeStoreMissingAtomicPolicyHook;
void runtimeStoreWithOnlySeparatePolicyHooks;
void runtimeStoreWithAtomicPolicyHook;
void recoveryWindowIntrospectionIsOptional;
