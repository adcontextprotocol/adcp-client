import type { MaybePromise } from '../create-adcp-server';
import type {
  RecoverableWebhookEmitter,
  WebhookAttemptAuthorizer,
  WebhookAuthentication,
  WebhookEmitResult,
} from '../webhook-emitter';

export type NotificationSubscriptionScope =
  | { kind: 'caller'; tenantId: string; principalId: string }
  | { kind: 'account'; tenantId: string; principalId: string; accountId: string };

export type NotificationEventAnchor = 'caller' | 'account';

/** Structural input accepted from either generated notification-config shape. */
export interface NotificationSubscriptionConfigInput {
  subscriber_id: string;
  url: string;
  event_types: readonly string[];
  all_authorized_accounts?: boolean;
  include_future_event_types?: boolean;
  product_payload_view?: 'canonical' | 'legacy';
  authentication?: {
    schemes: readonly ('Bearer' | 'HMAC-SHA256')[];
    credentials?: string;
  };
  active?: boolean;
}

export type NotificationAuthenticationMode = 'rfc9421' | 'bearer' | 'hmac_sha256';

export interface StoredNotificationAuthentication {
  mode: NotificationAuthenticationMode;
  /** Opaque, stable, non-secret application handle. Never a credential or credential hash. */
  bindingId?: string;
}

export interface StoredNotificationSubscription {
  subscriberId: string;
  url: string;
  eventTypes: string[];
  active: boolean;
  allAuthorizedAccounts: boolean;
  includeFutureEventTypes: boolean;
  productPayloadView?: 'canonical' | 'legacy';
  authentication: StoredNotificationAuthentication;
  /** Hash of the exact proof-bound destination tuple. */
  destinationGeneration: string;
  /** Equal to destinationGeneration only after exact-tuple proof succeeds. */
  proofGeneration?: string;
}

export interface NotificationSubscriptionSet {
  scope: NotificationSubscriptionScope;
  /** Opaque CAS token for the whole declarative set. */
  generation: string;
  subscriptions: StoredNotificationSubscription[];
}

export interface NotificationSubscriptionMatch {
  anchor: NotificationEventAnchor;
  tenantId: string;
  principalId?: string;
  accountId?: string;
  eventType: string;
  /** This event was explicitly classified by the server as future, caller-only, and invalidation-only. */
  futureCallerInvalidation?: boolean;
}

export type NotificationSubscriptionStoreReplaceResult =
  | { outcome: 'applied'; set: NotificationSubscriptionSet }
  | { outcome: 'unchanged'; set: NotificationSubscriptionSet }
  | { outcome: 'conflict'; currentGeneration?: string };

export interface NotificationSubscriptionStore {
  readonly durability: 'process-local' | 'durable';
  probe?(): Promise<void>;
  get(scope: Readonly<NotificationSubscriptionScope>): MaybePromise<NotificationSubscriptionSet | null>;
  /**
   * Atomic full-set replacement. `expectedGeneration: null` means the scope
   * must not exist; a string must match exactly.
   */
  replace(args: {
    scope: Readonly<NotificationSubscriptionScope>;
    expectedGeneration: string | null;
    nextGeneration: string;
    subscriptions: readonly StoredNotificationSubscription[];
  }): MaybePromise<NotificationSubscriptionStoreReplaceResult>;
  /** Returns at most `limit + 1` sets so the runtime can fail closed on truncation. */
  findCandidates(
    match: Readonly<NotificationSubscriptionMatch>,
    limit: number
  ): MaybePromise<NotificationSubscriptionSet[]>;
}

export interface NotificationCredentialBindingAdapter {
  /**
   * Compare a credential with the immutable binding already on the tuple.
   * This MUST NOT write, rotate, hash, or otherwise expose the credential.
   */
  preview(input: {
    scope: Readonly<NotificationSubscriptionScope>;
    subscriberId: string;
    mode: Exclude<NotificationAuthenticationMode, 'rfc9421'>;
    credential: string;
    previousBindingId?: string;
    signal: AbortSignal;
  }): MaybePromise<{ outcome: 'unchanged' } | { outcome: 'changed' }>;
  /**
   * Stage a write-only credential under an immutable, versioned opaque
   * binding. Never mutate an existing binding in place. A new or changed
   * credential MUST return `staged` with a bindingId different from
   * previousBindingId. Every `staged` outcome owns a fresh binding that is not
   * shared with another staging operation, even when concurrent operations
   * supply the same credential. A stage must be durable and resolvable for
   * proof and post-CAS delivery.
   */
  stage(input: {
    scope: Readonly<NotificationSubscriptionScope>;
    subscriberId: string;
    mode: Exclude<NotificationAuthenticationMode, 'rfc9421'>;
    credential: string;
    previousBindingId?: string;
    signal: AbortSignal;
  }): MaybePromise<
    { outcome: 'unchanged'; bindingId: string } | { outcome: 'staged'; bindingId: string; stageId: string }
  >;
  /**
   * Finalize a stage after the subscription CAS references its binding.
   * Idempotent. This is post-CAS bookkeeping and must own its monitoring and
   * retry path; failure cannot roll back the durable subscription reference.
   */
  commit(input: {
    scope: Readonly<NotificationSubscriptionScope>;
    subscriberId: string;
    mode: Exclude<NotificationAuthenticationMode, 'rfc9421'>;
    bindingId: string;
    stageId: string;
    /** Retire only after a grace period for already-authorized in-flight sends. */
    supersedesBindingId?: string;
    signal: AbortSignal;
  }): MaybePromise<void>;
  /**
   * Discard an unreferenced stage after validation/proof/CAS failure.
   * Idempotent. It MUST NOT affect any other stage or committed binding. The
   * adapter must reap abandoned stages because a process can fail before this
   * callback, or a callback can ignore its aborted signal and complete late.
   */
  discard(input: {
    scope: Readonly<NotificationSubscriptionScope>;
    subscriberId: string;
    mode: Exclude<NotificationAuthenticationMode, 'rfc9421'>;
    bindingId: string;
    stageId: string;
    signal: AbortSignal;
  }): MaybePromise<void>;
  /** Resolve only after live subscription and application authorization succeed. */
  resolve(input: {
    scope: Readonly<NotificationSubscriptionScope>;
    subscriberId: string;
    destinationGeneration: string;
    mode: Exclude<NotificationAuthenticationMode, 'rfc9421'>;
    bindingId: string;
    signal: AbortSignal;
  }): MaybePromise<WebhookAuthentication>;
}

export interface NotificationProofAdapter {
  prove(input: {
    scope: Readonly<NotificationSubscriptionScope>;
    subscriberId: string;
    url: string;
    eventTypes: readonly string[];
    authentication: Readonly<StoredNotificationAuthentication>;
    destinationGeneration: string;
    signal: AbortSignal;
  }): MaybePromise<{ proved: true } | { proved: false }>;
}

export type NotificationDestinationValidator = (input: {
  scope: Readonly<NotificationSubscriptionScope>;
  subscriberId: string;
  url: string;
  signal: AbortSignal;
}) => MaybePromise<{ allowed: true } | { allowed: false }>;

export interface NotificationDeliveryAuthorizationInput {
  scope: Readonly<NotificationSubscriptionScope>;
  eventAnchor: NotificationEventAnchor;
  /** Account whose data the event carries, including for caller-scoped all-account subscribers. */
  accountId?: string;
  subscriberId: string;
  destinationGeneration: string;
  eventType: string;
  notificationId: string;
  signal: AbortSignal;
}

export type NotificationDeliveryAuthorizer = (
  input: Readonly<NotificationDeliveryAuthorizationInput>
) => MaybePromise<{ authorized: true } | { authorized: false }>;

/**
 * One resolved delivery target. Together with the event's `emissionId` these
 * three fields are exactly the inputs to the per-subscriber delivery identity,
 * so pinning them pins the idempotency key the subscriber sees.
 */
export interface NotificationRecipientRef {
  scope: NotificationSubscriptionScope;
  subscriberId: string;
  destinationGeneration: string;
}

export interface NotificationEvent {
  /** Application-stable identity for this delivery event; reuse on crash retry, rotate on re-emission. */
  emissionId: string;
  /** Logical protocol identity. Keep stable when the same event is re-emitted. */
  notificationId: string;
  notificationType: string;
  anchor: NotificationEventAnchor;
  tenantId: string;
  /** Restrict fanout to one authenticated caller; omit only for deliberate tenant-wide fanout. */
  principalId?: string;
  /** Required for account-anchored events. */
  accountId?: string;
  payload: Record<string, unknown>;
  /**
   * Durably freezes the recipient set before any external send.
   *
   * The runtime resolves its candidates, hands them to this callback, and then
   * delivers to exactly the intersection of those candidates and what the
   * callback returns. An emitter that persists the first resolved set and
   * replays it verbatim therefore keeps every `delivery_id` — and so every
   * subscriber-visible idempotency key — stable across an ambiguous retry: a
   * subscription replaced or revoked after the first send is skipped rather
   * than addressed under a new destination generation, so a replay can never
   * add a second logical delivery of the same notification.
   *
   * Called at most once per `emit`, before the first attempt. It is a
   * durability barrier owned by the emitting subsystem, not an adopter policy
   * hook, so it is deliberately not bounded by `adopterCallbackTimeoutMs`: the
   * runtime cannot safely abandon a write that may still commit. Implementations
   * must enforce their own transaction-level deadline. Throwing aborts the
   * emission before anything is sent.
   */
  freezeRecipients?: (
    candidates: readonly NotificationRecipientRef[]
  ) => MaybePromise<readonly NotificationRecipientRef[]>;
}

/** Durable record that one recipient is about to receive an external POST. */
export interface NotificationDeliveryAttemptCheckpointInput {
  scope: Readonly<NotificationSubscriptionScope>;
  eventAnchor: NotificationEventAnchor;
  accountId?: string;
  subscriberId: string;
  destinationGeneration: string;
  eventType: string;
  notificationId: string;
  signal: AbortSignal;
}

/**
 * Durably records that a delivery is about to be attempted, awaited on the
 * allow path of live delivery authority immediately before every external POST.
 *
 * It is keyed on the durable attempt context rather than on a per-emission
 * closure precisely so that recovered outbox attempts participate: an emission
 * snapshot cannot carry a function, so a per-emission barrier would be silently
 * skipped by the very path — a restarted outbox worker — where an ambiguous send
 * is most likely.
 *
 * This is what makes a frozen recipient set safely revisable. Suppression fails
 * closed before this point, so a recipient with no checkpoint provably never
 * received a POST and may be replaced; a recipient with one is pinned forever,
 * because a crash after it is an ambiguous send. Rejecting suppresses that
 * delivery as retryable with no external attempt.
 */
export type NotificationDeliveryAttemptCheckpoint = (
  input: Readonly<NotificationDeliveryAttemptCheckpointInput>
) => MaybePromise<void>;

/**
 * Whether a live-authority suppression is a deliberate decision not to deliver
 * or an operational failure that says nothing about the subscriber.
 *
 * `terminal` — the subscriber must not receive this event: it is gone, inactive,
 * not subscribed to the type, or the adopter denied it. Settle the emission.
 *
 * `retryable` — the runtime could not establish authority: a store read failed,
 * an authorization or credential callback threw or timed out, or the
 * subscription generation moved while the emission was in flight. Nothing was
 * sent (`attempts: 0`), so the owner must release and retry rather than record
 * the notification as delivered.
 */
export type NotificationSuppressionDisposition = 'terminal' | 'retryable';

export interface NotificationSubscriptionView {
  subscriber_id: string;
  url: string;
  event_types: string[];
  active: boolean;
  all_authorized_accounts?: boolean;
  include_future_event_types?: boolean;
  product_payload_view?: 'canonical' | 'legacy';
  authentication?: { schemes: ['Bearer'] | ['HMAC-SHA256'] };
  destination_generation?: string;
  proof_generation?: string;
}

export class NotificationSubscriptionValidationError extends Error {
  override readonly name = 'NotificationSubscriptionValidationError';
  constructor(
    message: string,
    readonly field?: string
  ) {
    super(message);
  }
}

export type NotificationReplacementResult =
  | {
      outcome: 'applied' | 'unchanged' | 'cleared' | 'validated';
      generation?: string;
      notificationConfigs: NotificationSubscriptionView[];
      /** Present on dry-run validation. */
      wouldChange?: boolean;
    }
  | { outcome: 'conflict'; currentGeneration?: string }
  | { outcome: 'proof_failed'; subscriberId: string };

interface NotificationFanoutDeliveryBase {
  scope: NotificationSubscriptionScope;
  subscriberId: string;
  destinationGeneration: string;
}

export type NotificationFanoutDelivery = NotificationFanoutDeliveryBase &
  (
    | { result: WebhookEmitResult; failure?: never }
    | {
        result?: never;
        /**
         * `delivery_binding_retired` is terminal: the delivery identity is
         * retired or past its retry horizon and can never succeed. Anything
         * else is an operational failure worth retrying.
         */
        failure: { reason: 'delivery_runtime_error' | 'delivery_binding_retired'; terminal?: boolean };
      }
  );

export interface NotificationFanoutResult {
  notificationId: string;
  emissionId: string;
  matched: number;
  deliveries: NotificationFanoutDelivery[];
}

export interface PersistentNotificationRuntimeOptions {
  store: NotificationSubscriptionStore;
  proofAdapter: NotificationProofAdapter;
  credentialAdapter?: NotificationCredentialBindingAdapter;
  authorizeDelivery: NotificationDeliveryAuthorizer;
  /**
   * Durable pre-POST checkpoint. Required by any emission owner that freezes a
   * recipient set and needs to know whether a recipient was ever addressed;
   * `PersistentNotificationRuntime.hasDeliveryAttemptCheckpoint` reports whether
   * it is wired so such an owner can fail closed at startup instead of silently
   * losing the guarantee.
   */
  checkpointDeliveryAttempt?: NotificationDeliveryAttemptCheckpoint;
  /** Defaults to DNS resolution plus the SDK's strict webhook SSRF policy. */
  validateDestination?: NotificationDestinationValidator;
  /** Build the emitter with the supplied mandatory per-attempt authorizer. */
  createEmitter(authorizeAttempt: WebhookAttemptAuthorizer): RecoverableWebhookEmitter;
  supportedCallerEventTypes?: readonly string[];
  supportedAccountEventTypes?: readonly string[];
  /**
   * Later-version caller-only events safe for `include_future_event_types`.
   * Every listed type MUST be invalidation-only; the adopting application owns
   * that classification and payload construction.
   */
  futureCallerInvalidationEventTypes?: readonly string[];
  maxFanoutCandidates?: number;
  /** Maximum simultaneous subscriber retry cycles. Defaults to 8. */
  fanoutConcurrency?: number;
  /**
   * Timeout for policy, credential, proof, and destination callbacks. Defaults
   * to 30 seconds. Store operations must enforce transaction-level deadlines;
   * the runtime cannot safely abandon a mutating CAS that may commit late.
   */
  adopterCallbackTimeoutMs?: number;
  /**
   * Non-blocking observer for failed post-stage commit/discard bookkeeping.
   * Observer failures never change the already-decided replacement outcome.
   */
  onCredentialStageError?: (event: {
    operation: 'commit' | 'discard';
    scope: NotificationSubscriptionScope;
    subscriberId: string;
    bindingId: string;
    stageId: string;
    error: unknown;
  }) => MaybePromise<void>;
}

export interface PersistentNotificationRuntime {
  readonly store: NotificationSubscriptionStore;
  readonly emitter: RecoverableWebhookEmitter;
  readonly authorizeWebhookAttempt: WebhookAttemptAuthorizer;
  /** True when a durable pre-POST attempt checkpoint is wired. */
  readonly hasDeliveryAttemptCheckpoint: boolean;
  replace(
    scope: Readonly<NotificationSubscriptionScope>,
    configs: readonly NotificationSubscriptionConfigInput[],
    options?: { expectedGeneration?: string; dryRun?: boolean }
  ): Promise<NotificationReplacementResult>;
  read(scope: Readonly<NotificationSubscriptionScope>): Promise<{
    generation?: string;
    notificationConfigs: NotificationSubscriptionView[];
  }>;
  emit(event: Readonly<NotificationEvent>): Promise<NotificationFanoutResult>;
}
