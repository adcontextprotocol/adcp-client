import type { PersistentNotificationRuntime } from '../lib/server';
import type { ReportingLedgerStore } from '../lib/reporting/ledger/types';

/**
 * Pins the members added for the transactional reporting notification path as
 * optional, so an implementation written against an earlier release still
 * satisfies the published interfaces.
 *
 * This lives in a compiled fixture on purpose. The equivalent assertion in a
 * `test/**\/*.js` file is inert: those files are outside every TypeScript
 * config, so making either member required would not fail anything. Here it is
 * a compile error.
 */

/** Keys a caller may omit entirely. */
type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];

// Fails to compile the moment either member becomes required.
const checkpointFlagIsOptional: 'hasDeliveryAttemptCheckpoint' extends OptionalKeys<PersistentNotificationRuntime>
  ? true
  : never = true;
const checkpointFunctionIsOptional: 'deliveryAttemptCheckpoint' extends OptionalKeys<PersistentNotificationRuntime>
  ? true
  : never = true;
const finalityBaselinePortIsOptional: 'resolveTransitionFinalityBaseline' extends OptionalKeys<ReportingLedgerStore>
  ? true
  : never = true;
void checkpointFlagIsOptional;
void checkpointFunctionIsOptional;
void finalityBaselinePortIsOptional;

// The same guarantee stated as a construction an existing adopter would write:
// every member an earlier release required, and neither of the new ones.
declare const store: PersistentNotificationRuntime['store'];
declare const emitter: PersistentNotificationRuntime['emitter'];
declare const authorizeWebhookAttempt: PersistentNotificationRuntime['authorizeWebhookAttempt'];
declare const replace: PersistentNotificationRuntime['replace'];
declare const read: PersistentNotificationRuntime['read'];
declare const emit: PersistentNotificationRuntime['emit'];

const runtimeWithoutCheckpointMembers = {
  store,
  emitter,
  authorizeWebhookAttempt,
  replace,
  read,
  emit,
} satisfies PersistentNotificationRuntime;
void runtimeWithoutCheckpointMembers;

// Widened to the interface, both members read as possibly-undefined, which is
// what makes "absent means unproven" a checkable contract rather than a
// convention a consumer has to remember.
const adoptedRuntime: PersistentNotificationRuntime = runtimeWithoutCheckpointMembers;
const absentFlag: boolean | undefined = adoptedRuntime.hasDeliveryAttemptCheckpoint;
const absentFunction: PersistentNotificationRuntime['deliveryAttemptCheckpoint'] =
  adoptedRuntime.deliveryAttemptCheckpoint;
void absentFlag;
void absentFunction;
