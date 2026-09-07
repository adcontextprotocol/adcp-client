import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { canonicalJsonSha256 } from '../../utils/jcs';
import { enforceSsrfPolicy, enforceSsrfPolicyResolved } from '../../substitution/observer/ssrf';
import { WEBHOOK_SSRF_POLICY } from '../pin-and-bind-fetch';
import type {
  WebhookAttemptAuthorizationDecision,
  WebhookEmitAttempt,
  WebhookAuthentication,
} from '../webhook-emitter';
import type {
  NotificationAuthenticationMode,
  NotificationEvent,
  NotificationFanoutDelivery,
  NotificationReplacementResult,
  NotificationSubscriptionConfigInput,
  NotificationSubscriptionScope,
  NotificationSubscriptionSet,
  NotificationSubscriptionView,
  PersistentNotificationRuntime,
  PersistentNotificationRuntimeOptions,
  StoredNotificationAuthentication,
  StoredNotificationSubscription,
} from './types';
import { NotificationSubscriptionValidationError } from './types';

export const CALLER_NOTIFICATION_TYPES = Object.freeze(['capabilities.changed', 'principal.changed'] as const);

export const ACCOUNT_NOTIFICATION_TYPES = Object.freeze([
  'creative.status_changed',
  'creative.assignment_changed',
  'indicators.changed',
  'creative.purged',
  'account.status_changed',
  'account.change_recorded',
  'product.created',
  'product.updated',
  'product.priced',
  'product.removed',
  'signal.created',
  'signal.updated',
  'signal.priced',
  'signal.removed',
  'wholesale_feed.bulk_change',
  'reporting.delivery_ready',
  'reporting.status_changed',
  'reporting.ledger_changed',
] as const);

interface NotificationAttemptContext {
  kind: 'adcp_notification_subscription';
  version: 1;
  scope: NotificationSubscriptionScope;
  eventAnchor: 'caller' | 'account';
  accountId?: string;
  subscriberId: string;
  destinationGeneration: string;
  eventType: string;
  futureCallerInvalidation?: true;
  notificationId: string;
}

/**
 * Durable subscription control plane. The supplied emitter factory is called
 * exactly once with the runtime's mandatory live authorizer, preventing a
 * recovery worker from accidentally bypassing subscription generation and
 * application authority checks.
 */
export function createPersistentNotificationRuntime(
  options: PersistentNotificationRuntimeOptions
): PersistentNotificationRuntime {
  if (!options?.store) throw new TypeError('createPersistentNotificationRuntime requires store');
  if (!options.proofAdapter?.prove) {
    throw new TypeError('createPersistentNotificationRuntime requires proofAdapter.prove');
  }
  if (typeof options.authorizeDelivery !== 'function') {
    throw new TypeError('createPersistentNotificationRuntime requires authorizeDelivery');
  }
  if (typeof options.createEmitter !== 'function') {
    throw new TypeError('createPersistentNotificationRuntime requires createEmitter');
  }
  const production = process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'development';
  if (production && options.store.durability !== 'durable') {
    throw new TypeError('Production persistent notifications require a durable NotificationSubscriptionStore');
  }
  const maxFanoutCandidates = options.maxFanoutCandidates ?? 1000;
  if (!Number.isSafeInteger(maxFanoutCandidates) || maxFanoutCandidates < 1 || maxFanoutCandidates > 10_000) {
    throw new TypeError('maxFanoutCandidates must be an integer from 1 through 10000');
  }
  const fanoutConcurrency = options.fanoutConcurrency ?? 8;
  if (!Number.isSafeInteger(fanoutConcurrency) || fanoutConcurrency < 1 || fanoutConcurrency > 64) {
    throw new TypeError('fanoutConcurrency must be an integer from 1 through 64');
  }
  const adopterCallbackTimeoutMs = options.adopterCallbackTimeoutMs ?? 30_000;
  if (
    !Number.isSafeInteger(adopterCallbackTimeoutMs) ||
    adopterCallbackTimeoutMs < 1 ||
    adopterCallbackTimeoutMs > 300_000
  ) {
    throw new TypeError('adopterCallbackTimeoutMs must be an integer from 1 through 300000');
  }

  const accountEventTypes = new Set(options.supportedAccountEventTypes ?? ACCOUNT_NOTIFICATION_TYPES);
  const futureCallerInvalidationEventTypes = new Set(options.futureCallerInvalidationEventTypes ?? []);
  for (const eventType of futureCallerInvalidationEventTypes) {
    if (accountEventTypes.has(eventType)) {
      throw new TypeError('futureCallerInvalidationEventTypes must not contain account-anchored event types');
    }
  }
  const callerEventTypes = new Set([
    ...(options.supportedCallerEventTypes ?? CALLER_NOTIFICATION_TYPES),
    ...accountEventTypes,
    ...futureCallerInvalidationEventTypes,
  ]);
  const callerOnlyEventTypes = new Set([
    ...(options.supportedCallerEventTypes ?? CALLER_NOTIFICATION_TYPES),
    ...futureCallerInvalidationEventTypes,
  ]);
  const validateDestination = options.validateDestination ?? validatePersistentNotificationDestination;

  const authorizeWebhookAttempt = async (
    attempt: Readonly<WebhookEmitAttempt>
  ): Promise<WebhookAttemptAuthorizationDecision> => {
    const context = parseAttemptContext(attempt.attemptAuthorizationContext);
    if (!context) return { decision: 'suppress', reason: 'authorization_error' };

    let set: NotificationSubscriptionSet | null;
    try {
      set = await options.store.get(context.scope);
    } catch {
      return { decision: 'suppress', reason: 'authorization_error' };
    }
    if (!set) return { decision: 'suppress', reason: 'subscription_missing' };
    const subscription = set.subscriptions.find(item => item.subscriberId === context.subscriberId);
    if (!subscription) return { decision: 'suppress', reason: 'subscription_missing' };
    if (subscription.destinationGeneration !== context.destinationGeneration) {
      return { decision: 'suppress', reason: 'subscription_stale' };
    }
    if (!subscription.active || subscription.proofGeneration !== subscription.destinationGeneration) {
      return { decision: 'suppress', reason: 'subscription_inactive' };
    }
    if (
      !subscription.eventTypes.includes(context.eventType) &&
      !(
        context.futureCallerInvalidation === true &&
        futureCallerInvalidationEventTypes.has(context.eventType) &&
        subscription.includeFutureEventTypes
      )
    ) {
      return { decision: 'suppress', reason: 'event_not_allowed' };
    }
    if (
      (context.eventAnchor === 'account' && !context.accountId) ||
      (context.eventAnchor === 'caller' && context.accountId !== undefined) ||
      (context.scope.kind === 'account' &&
        (context.eventAnchor !== 'account' || context.scope.accountId !== context.accountId)) ||
      (context.scope.kind === 'caller' && context.eventAnchor === 'account' && !subscription.allAuthorizedAccounts)
    ) {
      return { decision: 'suppress', reason: 'event_not_allowed' };
    }

    let decision: { authorized: true } | { authorized: false };
    try {
      decision = await runAdopterCallback(adopterCallbackTimeoutMs, 'authorizeDelivery', signal =>
        options.authorizeDelivery({
          scope: structuredClone(context.scope),
          eventAnchor: context.eventAnchor,
          ...(context.accountId === undefined ? {} : { accountId: context.accountId }),
          subscriberId: context.subscriberId,
          destinationGeneration: context.destinationGeneration,
          eventType: context.eventType,
          notificationId: context.notificationId,
          signal,
        })
      );
    } catch {
      return { decision: 'suppress', reason: 'authorization_error' };
    }
    if (decision?.authorized !== true) return { decision: 'suppress', reason: 'authorization_denied' };

    const authenticationMode = subscription.authentication.mode;
    if (authenticationMode === 'rfc9421') {
      return { decision: 'allow', authentication: null };
    }
    const bindingId = subscription.authentication.bindingId;
    if (!bindingId || !options.credentialAdapter) {
      return { decision: 'suppress', reason: 'credential_unavailable' };
    }
    try {
      const authentication = await runAdopterCallback(adopterCallbackTimeoutMs, 'credentialAdapter.resolve', signal =>
        options.credentialAdapter!.resolve({
          scope: structuredClone(context.scope),
          subscriberId: context.subscriberId,
          destinationGeneration: context.destinationGeneration,
          mode: authenticationMode,
          bindingId,
          signal,
        })
      );
      if (!resolvedAuthenticationMatches(authenticationMode, authentication)) {
        return { decision: 'suppress', reason: 'credential_unavailable' };
      }
      return { decision: 'allow', authentication };
    } catch {
      return { decision: 'suppress', reason: 'credential_unavailable' };
    }
  };

  const emitter = options.createEmitter(authorizeWebhookAttempt);
  if (!emitter?.emit || !emitter.emitRecovered || !emitter.forTenantScope) {
    throw new TypeError('createEmitter must return a RecoverableWebhookEmitter');
  }

  return {
    store: options.store,
    emitter,
    authorizeWebhookAttempt,
    async replace(scope, configs, replaceOptions = {}): Promise<NotificationReplacementResult> {
      assertScope(scope);
      assertUniqueSubscribers(configs);
      const current = await options.store.get(scope);
      if (
        replaceOptions.expectedGeneration !== undefined &&
        current?.generation !== replaceOptions.expectedGeneration
      ) {
        return {
          outcome: 'conflict',
          ...(current && { currentGeneration: current.generation }),
        };
      }
      const previous = new Map(current?.subscriptions.map(item => [item.subscriberId, item]));
      const normalized: StoredNotificationSubscription[] = [];
      const credentialStages: PreparedCredentialStage[] = [];
      const discardStages = () =>
        discardCredentialStages(
          options.credentialAdapter,
          credentialStages,
          adopterCallbackTimeoutMs,
          options.onCredentialStageError
        );
      try {
        for (let index = 0; index < configs.length; index++) {
          normalized.push(
            await normalizeConfig({
              scope,
              config: configs[index]!,
              previous: previous.get(configs[index]!.subscriber_id),
              index,
              dryRun: replaceOptions.dryRun === true,
              accountEventTypes,
              callerEventTypes,
              callerOnlyEventTypes,
              credentialAdapter: options.credentialAdapter,
              credentialStages,
              adopterCallbackTimeoutMs,
              validateDestination,
            })
          );
        }
      } catch (error) {
        await discardStages();
        throw error;
      }
      normalized.sort((a, b) => a.subscriberId.localeCompare(b.subscriberId));

      if (replaceOptions.dryRun === true) {
        return {
          outcome: 'validated',
          notificationConfigs: normalized.map(item => projectSubscription(item, false)),
          wouldChange:
            canonicalJsonSha256(normalized.map(withoutProofGeneration)) !==
            canonicalJsonSha256((current?.subscriptions ?? []).map(withoutProofGeneration)),
        };
      }

      for (const subscription of normalized) {
        const prior = previous.get(subscription.subscriberId);
        if (!subscription.active) {
          if (prior?.destinationGeneration === subscription.destinationGeneration && prior.proofGeneration) {
            subscription.proofGeneration = prior.proofGeneration;
          }
          continue;
        }
        if (
          prior?.destinationGeneration === subscription.destinationGeneration &&
          prior.proofGeneration === subscription.destinationGeneration
        ) {
          subscription.proofGeneration = prior.proofGeneration;
          continue;
        }
        let proof: { proved: true } | { proved: false };
        try {
          proof = await runAdopterCallback(adopterCallbackTimeoutMs, 'proofAdapter.prove', signal =>
            options.proofAdapter.prove({
              scope: structuredClone(scope),
              subscriberId: subscription.subscriberId,
              url: subscription.url,
              eventTypes: [...subscription.eventTypes],
              authentication: { ...subscription.authentication },
              destinationGeneration: subscription.destinationGeneration,
              signal,
            })
          );
        } catch {
          proof = { proved: false };
        }
        if (proof?.proved !== true) {
          await discardStages();
          return { outcome: 'proof_failed', subscriberId: subscription.subscriberId };
        }
        subscription.proofGeneration = subscription.destinationGeneration;
      }

      let result: Awaited<ReturnType<typeof options.store.replace>>;
      try {
        result = await options.store.replace({
          scope,
          expectedGeneration: current?.generation ?? null,
          nextGeneration: `cfg_${randomUUID()}`,
          subscriptions: normalized,
        });
      } catch (error) {
        await discardStages();
        throw error;
      }
      if (result.outcome === 'conflict') {
        await discardStages();
        return result;
      }
      await commitCredentialStages(
        options.credentialAdapter,
        credentialStages,
        adopterCallbackTimeoutMs,
        options.onCredentialStageError
      );
      return {
        outcome:
          result.outcome === 'unchanged' ? 'unchanged' : result.set.subscriptions.length === 0 ? 'cleared' : 'applied',
        generation: result.set.generation,
        notificationConfigs: result.set.subscriptions.map(item => projectSubscription(item, true)),
      };
    },
    async read(scope) {
      assertScope(scope);
      const set = await options.store.get(scope);
      return {
        ...(set && { generation: set.generation }),
        notificationConfigs: set?.subscriptions.map(item => projectSubscription(item, true)) ?? [],
      };
    },
    async emit(event) {
      assertEvent(event, accountEventTypes, callerOnlyEventTypes);
      const futureCallerInvalidation = futureCallerInvalidationEventTypes.has(event.notificationType);
      const candidateSets = await options.store.findCandidates(
        {
          anchor: event.anchor,
          tenantId: event.tenantId,
          ...(event.principalId === undefined ? {} : { principalId: event.principalId }),
          ...(event.accountId === undefined ? {} : { accountId: event.accountId }),
          eventType: event.notificationType,
          ...(futureCallerInvalidation ? { futureCallerInvalidation: true } : {}),
        },
        maxFanoutCandidates
      );
      if (candidateSets.length > maxFanoutCandidates) {
        throw new Error('Persistent notification fanout exceeded maxFanoutCandidates; no deliveries were attempted');
      }

      const targets = candidateSets.flatMap(set =>
        set.subscriptions
          .filter(
            subscription =>
              subscription.active &&
              subscription.proofGeneration === subscription.destinationGeneration &&
              (subscription.eventTypes.includes(event.notificationType) ||
                (futureCallerInvalidation && subscription.includeFutureEventTypes)) &&
              (set.scope.kind !== 'caller' || event.anchor !== 'account' || subscription.allAuthorizedAccounts)
          )
          .map(subscription => ({ set, subscription }))
      );
      if (targets.length > maxFanoutCandidates) {
        throw new Error('Persistent notification fanout exceeded maxFanoutCandidates; no deliveries were attempted');
      }
      const deliveries = await mapConcurrent(targets, fanoutConcurrency, async ({ set, subscription }) => {
        const deliveryId = deliveryIdentity(event.emissionId, set.scope, subscription);
        const payload = notificationPayload(event, subscription.subscriberId);
        const context: NotificationAttemptContext = {
          kind: 'adcp_notification_subscription',
          version: 1,
          scope: structuredClone(set.scope),
          eventAnchor: event.anchor,
          ...(event.accountId === undefined ? {} : { accountId: event.accountId }),
          subscriberId: subscription.subscriberId,
          destinationGeneration: subscription.destinationGeneration,
          eventType: event.notificationType,
          ...(futureCallerInvalidation ? { futureCallerInvalidation: true } : {}),
          notificationId: event.notificationId,
        };
        const delivery = {
          scope: structuredClone(set.scope),
          subscriberId: subscription.subscriberId,
          destinationGeneration: subscription.destinationGeneration,
        };
        try {
          const result = await emitter.forTenantScope(set.scope.tenantId).emit({
            url: subscription.url,
            payload,
            delivery_id: deliveryId,
            authentication: null,
            attemptAuthorizationContext: context as unknown as Record<string, unknown>,
          });
          return { ...delivery, result } satisfies NotificationFanoutDelivery;
        } catch {
          return {
            ...delivery,
            failure: { reason: 'delivery_runtime_error' },
          } satisfies NotificationFanoutDelivery;
        }
      });
      return {
        notificationId: event.notificationId,
        emissionId: event.emissionId,
        matched: targets.length,
        deliveries,
      };
    },
  };
}

function withoutProofGeneration(subscription: Readonly<StoredNotificationSubscription>): Record<string, unknown> {
  const { proofGeneration: _proofGeneration, ...rest } = subscription;
  return rest;
}

interface PreparedCredentialStage {
  scope: NotificationSubscriptionScope;
  subscriberId: string;
  mode: Exclude<NotificationAuthenticationMode, 'rfc9421'>;
  bindingId: string;
  stageId: string;
  supersedesBindingId?: string;
}

interface NormalizeConfigInput {
  scope: Readonly<NotificationSubscriptionScope>;
  config: Readonly<NotificationSubscriptionConfigInput>;
  previous?: Readonly<StoredNotificationSubscription>;
  index: number;
  dryRun: boolean;
  accountEventTypes: ReadonlySet<string>;
  callerEventTypes: ReadonlySet<string>;
  callerOnlyEventTypes: ReadonlySet<string>;
  credentialAdapter?: PersistentNotificationRuntimeOptions['credentialAdapter'];
  credentialStages: PreparedCredentialStage[];
  adopterCallbackTimeoutMs: number;
  validateDestination: NonNullable<PersistentNotificationRuntimeOptions['validateDestination']>;
}

async function normalizeConfig(input: NormalizeConfigInput): Promise<StoredNotificationSubscription> {
  const { config, scope } = input;
  assertIdentifier(config.subscriber_id, `notification_configs[${input.index}].subscriber_id`, 255);
  const url = normalizeWebhookUrl(config.url, `notification_configs[${input.index}].url`);
  let destinationValidation: { allowed: true } | { allowed: false };
  try {
    destinationValidation = await runAdopterCallback(input.adopterCallbackTimeoutMs, 'validateDestination', signal =>
      input.validateDestination({
        scope: structuredClone(scope),
        subscriberId: config.subscriber_id,
        url,
        signal,
      })
    );
  } catch {
    destinationValidation = { allowed: false };
  }
  if (destinationValidation?.allowed !== true) {
    throw validation('webhook URL failed DNS and reserved-range validation', input.index, 'url');
  }
  if (!Array.isArray(config.event_types) || config.event_types.length === 0) {
    throw validation('event_types must contain at least one event type', input.index, 'event_types');
  }
  const eventTypes = [...new Set(config.event_types)].sort();
  for (let eventIndex = 0; eventIndex < eventTypes.length; eventIndex++) {
    const eventType = eventTypes[eventIndex];
    if (typeof eventType !== 'string' || eventType.length === 0) {
      throw validation('event type must be a non-empty string', input.index, `event_types[${eventIndex}]`);
    }
    const supported = scope.kind === 'account' ? input.accountEventTypes : input.callerEventTypes;
    if (!supported.has(eventType)) {
      throw validation(
        `event type ${JSON.stringify(eventType)} is not supported on this anchor`,
        input.index,
        `event_types[${eventIndex}]`
      );
    }
    if (scope.kind === 'account' && input.callerOnlyEventTypes.has(eventType)) {
      throw validation(
        `event type ${JSON.stringify(eventType)} is caller-anchored`,
        input.index,
        `event_types[${eventIndex}]`
      );
    }
  }
  if (
    scope.kind === 'caller' &&
    eventTypes.some(eventType => input.accountEventTypes.has(eventType)) &&
    config.all_authorized_accounts !== true
  ) {
    throw validation(
      'all_authorized_accounts must be true for account-anchored caller subscriptions',
      input.index,
      'all_authorized_accounts'
    );
  }
  if (config.product_payload_view !== undefined && !eventTypes.some(eventType => eventType.startsWith('product.'))) {
    throw validation('product_payload_view requires a product.* event type', input.index, 'product_payload_view');
  }

  const authentication = await normalizeAuthentication(input);
  const destinationGeneration = `dest_${canonicalJsonSha256({
    scope,
    subscriberId: config.subscriber_id,
    url,
    authentication,
    eventTypes,
    allAuthorizedAccounts: config.all_authorized_accounts === true,
    includeFutureEventTypes: config.include_future_event_types === true,
    productPayloadView: config.product_payload_view ?? null,
  })}`;
  return {
    subscriberId: config.subscriber_id,
    url,
    eventTypes,
    active: config.active !== false,
    allAuthorizedAccounts: config.all_authorized_accounts === true,
    includeFutureEventTypes: config.include_future_event_types === true,
    ...(config.product_payload_view === undefined ? {} : { productPayloadView: config.product_payload_view }),
    authentication,
    destinationGeneration,
  };
}

async function normalizeAuthentication(input: NormalizeConfigInput): Promise<StoredNotificationAuthentication> {
  const auth = input.config.authentication;
  if (auth === undefined) return { mode: 'rfc9421' };
  if (!Array.isArray(auth.schemes) || auth.schemes.length !== 1) {
    throw validation('authentication.schemes must contain exactly one scheme', input.index, 'authentication.schemes');
  }
  const scheme = auth.schemes[0];
  const mode: Exclude<NotificationAuthenticationMode, 'rfc9421'> =
    scheme === 'Bearer'
      ? 'bearer'
      : scheme === 'HMAC-SHA256'
        ? 'hmac_sha256'
        : (() => {
            throw validation('unsupported authentication scheme', input.index, 'authentication.schemes[0]');
          })();
  const previous = input.previous?.authentication.mode === mode ? input.previous.authentication : undefined;
  if (auth.credentials === undefined) {
    if (previous?.bindingId) return { mode, bindingId: previous.bindingId };
    throw validation(
      'credentials are required for a new legacy authentication binding',
      input.index,
      'authentication.credentials'
    );
  }
  if (typeof auth.credentials !== 'string' || auth.credentials.length < 32) {
    throw validation(
      'authentication.credentials must contain at least 32 characters',
      input.index,
      'authentication.credentials'
    );
  }
  if (!input.credentialAdapter) {
    throw validation('legacy authentication requires a credentialAdapter', input.index, 'authentication');
  }
  if (input.dryRun && typeof input.credentialAdapter.preview !== 'function') {
    throw validation(
      'credentialAdapter.preview is required for dry-run legacy authentication',
      input.index,
      'authentication'
    );
  }
  if (
    !input.dryRun &&
    (typeof input.credentialAdapter.stage !== 'function' ||
      typeof input.credentialAdapter.commit !== 'function' ||
      typeof input.credentialAdapter.discard !== 'function')
  ) {
    throw validation(
      'credentialAdapter.stage, commit, and discard are required for legacy authentication',
      input.index,
      'authentication'
    );
  }
  const bindingInput = {
    scope: structuredClone(input.scope),
    subscriberId: input.config.subscriber_id,
    mode,
    credential: auth.credentials,
    ...(previous?.bindingId === undefined ? {} : { previousBindingId: previous.bindingId }),
  };
  if (input.dryRun) {
    let preview: { outcome: 'unchanged' } | { outcome: 'changed' };
    try {
      preview = await runAdopterCallback(input.adopterCallbackTimeoutMs, 'credentialAdapter.preview', signal =>
        input.credentialAdapter!.preview({ ...bindingInput, signal })
      );
    } catch {
      throw validation('credential binding preview failed', input.index, 'authentication');
    }
    if (preview?.outcome === 'unchanged') {
      if (!previous?.bindingId) {
        throw validation(
          'credentialAdapter.preview cannot report unchanged without a previous binding',
          input.index,
          'authentication'
        );
      }
      return { mode, bindingId: previous.bindingId };
    }
    if (preview?.outcome !== 'changed') {
      throw validation('credentialAdapter.preview returned an invalid outcome', input.index, 'authentication');
    }
    // This value is never persisted or projected. A fresh opaque sentinel only
    // makes the semantic comparison differ without hashing the credential.
    return { mode, bindingId: `dry_${randomUUID()}` };
  }

  let stage: { outcome: 'unchanged'; bindingId: string } | { outcome: 'staged'; bindingId: string; stageId: string };
  try {
    stage = await runAdopterCallback(input.adopterCallbackTimeoutMs, 'credentialAdapter.stage', signal =>
      input.credentialAdapter!.stage({ ...bindingInput, signal })
    );
  } catch {
    throw validation('credential binding stage failed', input.index, 'authentication');
  }
  if (!stage || !validOpaqueHandle(stage.bindingId, auth.credentials)) {
    throw validation(
      'credentialAdapter.stage must return an opaque non-secret bindingId of at most 512 bytes',
      input.index,
      'authentication'
    );
  }
  if (stage.outcome === 'unchanged') {
    if (!previous?.bindingId || stage.bindingId !== previous.bindingId) {
      throw validation(
        'credentialAdapter.stage returned unchanged without the exact previous binding',
        input.index,
        'authentication'
      );
    }
    return { mode, bindingId: stage.bindingId };
  }
  if (
    stage.outcome !== 'staged' ||
    !validOpaqueHandle(stage.stageId, auth.credentials) ||
    stage.bindingId === previous?.bindingId
  ) {
    throw validation(
      'credentialAdapter.stage must return a new immutable binding and opaque stageId for changed credentials',
      input.index,
      'authentication'
    );
  }
  input.credentialStages.push({
    scope: structuredClone(input.scope),
    subscriberId: input.config.subscriber_id,
    mode,
    bindingId: stage.bindingId,
    stageId: stage.stageId,
    ...(previous?.bindingId === undefined ? {} : { supersedesBindingId: previous.bindingId }),
  });
  return { mode, bindingId: stage.bindingId };
}

function projectSubscription(
  subscription: Readonly<StoredNotificationSubscription>,
  includeGenerations: boolean
): NotificationSubscriptionView {
  return {
    subscriber_id: subscription.subscriberId,
    url: subscription.url,
    event_types: [...subscription.eventTypes],
    active: subscription.active,
    ...(subscription.allAuthorizedAccounts && { all_authorized_accounts: true }),
    ...(subscription.includeFutureEventTypes && { include_future_event_types: true }),
    ...(subscription.productPayloadView === undefined ? {} : { product_payload_view: subscription.productPayloadView }),
    ...(subscription.authentication.mode === 'bearer'
      ? { authentication: { schemes: ['Bearer'] } as const }
      : subscription.authentication.mode === 'hmac_sha256'
        ? { authentication: { schemes: ['HMAC-SHA256'] } as const }
        : {}),
    ...(includeGenerations ? { destination_generation: subscription.destinationGeneration } : {}),
    ...(includeGenerations && subscription.proofGeneration ? { proof_generation: subscription.proofGeneration } : {}),
  };
}

/** Strip SDK operational generations for generated AdCP response projections. */
export function projectNotificationSubscriptionReadback(
  views: readonly NotificationSubscriptionView[]
): NotificationSubscriptionConfigInput[] {
  return views.map(view => ({
    subscriber_id: view.subscriber_id,
    url: view.url,
    event_types: [...view.event_types],
    active: view.active,
    ...(view.all_authorized_accounts === undefined ? {} : { all_authorized_accounts: view.all_authorized_accounts }),
    ...(view.include_future_event_types === undefined
      ? {}
      : { include_future_event_types: view.include_future_event_types }),
    ...(view.product_payload_view === undefined ? {} : { product_payload_view: view.product_payload_view }),
    ...(view.authentication === undefined ? {} : { authentication: view.authentication }),
  }));
}

function notificationPayload(event: Readonly<NotificationEvent>, subscriberId: string): Record<string, unknown> {
  const payload = structuredClone(event.payload);
  canonicalJsonSha256(payload);
  assertPayloadField(payload, 'notification_type', event.notificationType);
  assertPayloadField(payload, 'notification_id', event.notificationId);
  assertPayloadField(payload, 'subscriber_id', subscriberId);
  if (event.accountId !== undefined) assertPayloadField(payload, 'account_id', event.accountId);
  return {
    ...payload,
    notification_type: event.notificationType,
    notification_id: event.notificationId,
    subscriber_id: subscriberId,
    ...(event.accountId === undefined ? {} : { account_id: event.accountId }),
  };
}

function assertPayloadField(payload: Record<string, unknown>, field: string, expected: string): void {
  if (payload[field] !== undefined && payload[field] !== expected) {
    throw new NotificationSubscriptionValidationError(
      `payload.${field} conflicts with the trusted notification event`,
      `payload.${field}`
    );
  }
}

function deliveryIdentity(
  emissionId: string,
  scope: Readonly<NotificationSubscriptionScope>,
  subscription: Readonly<StoredNotificationSubscription>
): string {
  return `notification_${canonicalJsonSha256({
    emissionId,
    scope,
    subscriberId: subscription.subscriberId,
    destinationGeneration: subscription.destinationGeneration,
  })}`;
}

function assertEvent(
  event: Readonly<NotificationEvent>,
  accountEventTypes: ReadonlySet<string>,
  callerOnlyEventTypes: ReadonlySet<string>
): void {
  assertIdentifier(event.emissionId, 'emissionId', 512);
  assertIdentifier(event.notificationId, 'notificationId', 512);
  assertIdentifier(event.notificationType, 'notificationType', 255);
  assertIdentifier(event.tenantId, 'tenantId', 512);
  if (event.principalId !== undefined) assertIdentifier(event.principalId, 'principalId', 512);
  if (event.anchor === 'account') {
    if (!event.accountId)
      throw new NotificationSubscriptionValidationError('accountId is required for account events', 'accountId');
    assertIdentifier(event.accountId, 'accountId', 512);
    if (!accountEventTypes.has(event.notificationType)) {
      throw new NotificationSubscriptionValidationError('notificationType is not account-anchored', 'notificationType');
    }
  } else if (event.anchor === 'caller') {
    if (event.accountId !== undefined) {
      throw new NotificationSubscriptionValidationError('caller events must not carry accountId', 'accountId');
    }
    if (!callerOnlyEventTypes.has(event.notificationType)) {
      throw new NotificationSubscriptionValidationError('notificationType is not caller-anchored', 'notificationType');
    }
  } else {
    throw new NotificationSubscriptionValidationError('anchor must be caller or account', 'anchor');
  }
  canonicalJsonSha256(event.payload);
}

function assertUniqueSubscribers(configs: readonly NotificationSubscriptionConfigInput[]): void {
  if (!Array.isArray(configs) || configs.length > 16) {
    throw new NotificationSubscriptionValidationError(
      'notification_configs must contain at most 16 subscribers',
      'notification_configs'
    );
  }
  const seen = new Set<string>();
  for (let index = 0; index < configs.length; index++) {
    const subscriberId = configs[index]?.subscriber_id;
    if (typeof subscriberId !== 'string') {
      throw validation('subscriber_id must be a string', index, 'subscriber_id');
    }
    if (seen.has(subscriberId)) {
      throw validation('duplicate subscriber_id', index, 'subscriber_id');
    }
    seen.add(subscriberId);
  }
}

function normalizeWebhookUrl(value: unknown, field: string): string {
  if (typeof value !== 'string')
    throw new NotificationSubscriptionValidationError('webhook URL must be a string', field);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NotificationSubscriptionValidationError('webhook URL is invalid', field);
  }
  if (url.username || url.password || url.hash) {
    throw new NotificationSubscriptionValidationError('webhook URL must not contain userinfo or a fragment', field);
  }
  const policy = enforceSsrfPolicy(url, WEBHOOK_SSRF_POLICY);
  if (!policy.allowed) throw new NotificationSubscriptionValidationError('webhook URL is denied by SSRF policy', field);
  return url.toString();
}

/** Point-in-time registration validation; delivery still re-resolves and pins every attempt. */
export async function validatePersistentNotificationDestination(input: {
  url: string;
}): Promise<{ allowed: true } | { allowed: false }> {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return { allowed: false };
  }
  const literal = enforceSsrfPolicy(url, WEBHOOK_SSRF_POLICY);
  if (!literal.allowed) return { allowed: false };
  try {
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    const resolved = enforceSsrfPolicyResolved(
      url,
      addresses.map(address => address.address),
      WEBHOOK_SSRF_POLICY
    );
    return resolved.allowed ? { allowed: true } : { allowed: false };
  } catch {
    return { allowed: false };
  }
}

function parseAttemptContext(value: unknown): NotificationAttemptContext | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.kind !== 'adcp_notification_subscription' || input.version !== 1) return null;
  if (
    typeof input.subscriberId !== 'string' ||
    typeof input.destinationGeneration !== 'string' ||
    typeof input.eventType !== 'string' ||
    typeof input.notificationId !== 'string' ||
    (input.eventAnchor !== 'caller' && input.eventAnchor !== 'account') ||
    (input.futureCallerInvalidation !== undefined && input.futureCallerInvalidation !== true) ||
    (input.accountId !== undefined && typeof input.accountId !== 'string')
  ) {
    return null;
  }
  try {
    assertScope(input.scope as NotificationSubscriptionScope);
  } catch {
    return null;
  }
  return {
    kind: 'adcp_notification_subscription',
    version: 1,
    scope: structuredClone(input.scope as NotificationSubscriptionScope),
    eventAnchor: input.eventAnchor,
    ...(input.accountId === undefined ? {} : { accountId: input.accountId as string }),
    subscriberId: input.subscriberId,
    destinationGeneration: input.destinationGeneration,
    eventType: input.eventType,
    ...(input.futureCallerInvalidation === true ? { futureCallerInvalidation: true } : {}),
    notificationId: input.notificationId,
  };
}

function resolvedAuthenticationMatches(
  mode: Exclude<NotificationAuthenticationMode, 'rfc9421'>,
  authentication: WebhookAuthentication
): authentication is Exclude<WebhookAuthentication, null> {
  return (
    (mode === 'bearer' && authentication?.type === 'bearer' && authentication.token.length > 0) ||
    (mode === 'hmac_sha256' && authentication?.type === 'hmac_sha256' && authentication.secret.length > 0)
  );
}

function validOpaqueHandle(value: unknown, credential: string): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 512 &&
    !value.includes(credential)
  );
}

async function commitCredentialStages(
  adapter: PersistentNotificationRuntimeOptions['credentialAdapter'],
  stages: readonly PreparedCredentialStage[],
  timeoutMs: number,
  onError: PersistentNotificationRuntimeOptions['onCredentialStageError']
): Promise<void> {
  if (stages.length === 0) return;
  if (!adapter) return;
  const results = await Promise.allSettled(
    stages.map(stage =>
      runAdopterCallback(timeoutMs, 'credentialAdapter.commit', signal => adapter.commit({ ...stage, signal }))
    )
  );
  reportCredentialStageErrors('commit', stages, results, onError);
}

async function discardCredentialStages(
  adapter: PersistentNotificationRuntimeOptions['credentialAdapter'],
  stages: readonly PreparedCredentialStage[],
  timeoutMs: number,
  onError: PersistentNotificationRuntimeOptions['onCredentialStageError']
): Promise<void> {
  if (!adapter || stages.length === 0) return;
  const results = await Promise.allSettled(
    stages.map(stage =>
      runAdopterCallback(timeoutMs, 'credentialAdapter.discard', signal =>
        adapter.discard({
          scope: stage.scope,
          subscriberId: stage.subscriberId,
          mode: stage.mode,
          bindingId: stage.bindingId,
          stageId: stage.stageId,
          signal,
        })
      )
    )
  );
  reportCredentialStageErrors('discard', stages, results, onError);
}

function reportCredentialStageErrors(
  operation: 'commit' | 'discard',
  stages: readonly PreparedCredentialStage[],
  results: readonly PromiseSettledResult<void>[],
  onError: PersistentNotificationRuntimeOptions['onCredentialStageError']
): void {
  if (!onError) return;
  results.forEach((result, index) => {
    if (result.status !== 'rejected') return;
    const stage = stages[index]!;
    try {
      void Promise.resolve(
        onError({
          operation,
          scope: structuredClone(stage.scope),
          subscriberId: stage.subscriberId,
          bindingId: stage.bindingId,
          stageId: stage.stageId,
          error: result.reason,
        })
      ).catch(() => undefined);
    } catch {
      // Observability must not change the durable replacement outcome.
    }
  });
}

async function runAdopterCallback<T>(
  timeoutMs: number,
  name: string,
  invoke: (signal: AbortSignal) => T | PromiseLike<T>
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${name} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => invoke(controller.signal)), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= values.length) return;
        results[index] = await mapper(values[index]!, index);
      }
    })
  );
  return results;
}

function assertScope(scope: Readonly<NotificationSubscriptionScope>): void {
  if (scope == null || typeof scope !== 'object') throw new TypeError('notification subscription scope is required');
  if (scope.kind !== 'caller' && scope.kind !== 'account') throw new TypeError('scope.kind must be caller or account');
  assertIdentifier(scope.tenantId, 'scope.tenantId', 512);
  assertIdentifier(scope.principalId, 'scope.principalId', 512);
  if (scope.kind === 'account') assertIdentifier(scope.accountId, 'scope.accountId', 512);
}

function assertIdentifier(value: unknown, field: string, maxBytes: number): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    value.includes('\0')
  ) {
    throw new NotificationSubscriptionValidationError(
      `${field} must be a non-empty UTF-8 string of at most ${maxBytes} bytes without NUL`,
      field
    );
  }
}

function validation(message: string, index: number, field: string): NotificationSubscriptionValidationError {
  return new NotificationSubscriptionValidationError(message, `notification_configs[${index}].${field}`);
}
