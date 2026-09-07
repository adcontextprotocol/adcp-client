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
   * Resolve the stable opaque binding that `bind()` would return without
   * persisting or rotating the credential. Dry-run replacement uses this to
   * compare the exact destination tuple without causing a secret-store write.
   */
  preview(input: {
    scope: Readonly<NotificationSubscriptionScope>;
    subscriberId: string;
    mode: Exclude<NotificationAuthenticationMode, 'rfc9421'>;
    credential: string;
    previousBindingId?: string;
  }): MaybePromise<{ bindingId: string }>;
  /**
   * Store or rotate a write-only credential and return a stable opaque
   * binding. It must return the same binding as `preview()` for the same
   * credential and tuple, and rebinding that tuple must remain idempotent.
   */
  bind(input: {
    scope: Readonly<NotificationSubscriptionScope>;
    subscriberId: string;
    mode: Exclude<NotificationAuthenticationMode, 'rfc9421'>;
    credential: string;
    previousBindingId?: string;
  }): MaybePromise<{ bindingId: string }>;
  /** Resolve only after live subscription and application authorization succeed. */
  resolve(input: {
    scope: Readonly<NotificationSubscriptionScope>;
    subscriberId: string;
    destinationGeneration: string;
    mode: Exclude<NotificationAuthenticationMode, 'rfc9421'>;
    bindingId: string;
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
  }): MaybePromise<{ proved: true } | { proved: false }>;
}

export type NotificationDestinationValidator = (input: {
  scope: Readonly<NotificationSubscriptionScope>;
  subscriberId: string;
  url: string;
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
}

export type NotificationDeliveryAuthorizer = (
  input: Readonly<NotificationDeliveryAuthorizationInput>
) => MaybePromise<{ authorized: true } | { authorized: false }>;

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
}

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

export interface NotificationFanoutDelivery {
  scope: NotificationSubscriptionScope;
  subscriberId: string;
  destinationGeneration: string;
  result: WebhookEmitResult;
}

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
}

export interface PersistentNotificationRuntime {
  readonly store: NotificationSubscriptionStore;
  readonly emitter: RecoverableWebhookEmitter;
  readonly authorizeWebhookAttempt: WebhookAttemptAuthorizer;
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
