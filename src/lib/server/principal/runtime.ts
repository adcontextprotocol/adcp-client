import { randomUUID } from 'node:crypto';
import { compare as compareSemver } from 'semver';
import { canonicalJsonSha256 } from '../../utils/jcs';
import type {
  GetPrincipalRequest,
  GetPrincipalResponse,
  SyncAgentNotificationConfigsRequest,
  SyncAgentNotificationConfigsResponse,
  SyncPrincipalRequest,
  SyncPrincipalResponse,
} from '../../types/tools.generated';
import type { ServerPayload } from '../../types/server-payload';
import type { HandlerContext, ProtocolHandlers } from '../create-adcp-server';
import {
  NotificationSubscriptionValidationError,
  type PersistentNotificationRuntime,
  type PreparedNotificationReplacement,
} from '../notification-subscriptions/types';
import {
  projectNotificationSubscriptionReadback,
  projectStoredNotificationSubscriptionReadback,
} from '../notification-subscriptions/runtime';
import { PRINCIPAL_NOTIFICATION_STORE_OWNER } from './store';
import type {
  PendingPrincipalNotification,
  PrepareReportingDestination,
  PrincipalConfiguration,
  PrincipalConfigurationInput,
  PrincipalDeclarationSupport,
  PrincipalDeclarations,
  PrincipalDeclarationsState,
  PrincipalDestinationTransition,
  PrincipalKind,
  PrincipalNotificationRecoveryResult,
  PrincipalReportingDestination,
  PrincipalReportingDestinationInput,
  ResolvedReportingDestination,
  PrincipalStateStore,
  PrincipalStoreScope,
  ResolvedPrincipalScope,
  StoredPrincipalRecord,
  StoredReportingDestinationGeneration,
  VersionedPrincipalRecord,
} from './types';

type NotificationSubscriptionStoreWithPrincipalOwner = {
  [PRINCIPAL_NOTIFICATION_STORE_OWNER]?: PrincipalStateStore;
};

export interface CreatePrincipalLifecycleOptions<TAccount = unknown> {
  store: PrincipalStateStore;
  notifications: PersistentNotificationRuntime;
  /** Resolve only from authenticated server context. Request fields are untrusted. */
  resolvePrincipal(ctx: HandlerContext<TAccount>): ResolvedPrincipalScope | Promise<ResolvedPrincipalScope>;
  /** Canonical URL included in principal.changed invalidations. */
  agentUrl: string;
  declarations?: PrincipalDeclarationSupport;
  prepareReportingDestination?: PrepareReportingDestination;
  issuePrincipalId?: (scope: Readonly<PrincipalStoreScope>) => string;
  issueConfigurationVersion?: () => string;
  issueDestinationRef?: () => string;
  now?: () => Date;
  maxCasAttempts?: number;
  /** Maximum durable invalidations retained per principal row. Defaults to 256. */
  maxPendingNotifications?: number;
  /** Maximum invalidations attempted by one flush call. Defaults to 100. */
  maxNotificationsPerFlush?: number;
  /** Maximum retained reporting authorization generations. Defaults to 256. */
  maxReportingGenerations?: number;
  /** Expose the legacy notification-only protocol task in addition to sync_principal. */
  includeCompatibilityNotificationTask?: boolean;
  /** Explicitly accept crash-window duplicate delivery without an attempt checkpoint. */
  acknowledgeMissingAttemptCheckpoint?: boolean;
}

export interface PrincipalLifecycleRuntime<TAccount = unknown> {
  protocol: Pick<ProtocolHandlers<TAccount>, 'resolvePrincipalScope' | 'getPrincipal' | 'syncPrincipal'> &
    Partial<Pick<ProtocolHandlers<TAccount>, 'resolveScope' | 'syncAgentNotificationConfigs'>>;
  recognizePrincipal(input: {
    scope: PrincipalStoreScope;
    principalId: string;
    principalKind: PrincipalKind;
  }): Promise<void>;
  transitionDestination(
    scope: Readonly<PrincipalStoreScope>,
    transition: Readonly<PrincipalDestinationTransition>,
    options?: { deferNotification?: boolean }
  ): Promise<PrincipalConfiguration>;
  flushPrincipalNotifications(scope: Readonly<PrincipalStoreScope>): Promise<void>;
  recoverPrincipalNotifications(options?: {
    limit?: number;
    cursor?: string;
  }): Promise<PrincipalNotificationRecoveryResult>;
  resolveReportingDestination(
    scope: Readonly<PrincipalStoreScope>,
    destinationRef: string
  ): Promise<ResolvedReportingDestination | null>;
  reconcileDeclarations(
    scope: Readonly<PrincipalStoreScope>,
    options?: { deferNotification?: boolean }
  ): Promise<PrincipalConfiguration>;
}

/**
 * Durable principal lifecycle and protocol handlers.
 *
 * All caller-owned sections and the notification runtime's internal subscriber
 * set live in one CAS row. The framework idempotency middleware resolves exact
 * replays before these handlers run; this runtime owns version fences and the
 * atomic state transaction itself.
 */
export function createPrincipalLifecycle<TAccount = unknown>(
  options: CreatePrincipalLifecycleOptions<TAccount>
): PrincipalLifecycleRuntime<TAccount> {
  if (!options?.store) throw new TypeError('createPrincipalLifecycle requires store');
  if (!options.notifications?.prepareReplacement) {
    throw new TypeError('createPrincipalLifecycle requires a notification runtime with prepareReplacement');
  }
  const notificationOwner = (
    options.notifications.store as NotificationSubscriptionStoreWithPrincipalOwner | undefined
  )?.[PRINCIPAL_NOTIFICATION_STORE_OWNER];
  if (notificationOwner !== options.store) {
    throw new TypeError('createPrincipalLifecycle requires notifications backed by the same principal store');
  }
  if (!options.notifications.hasDeliveryAttemptCheckpoint && !options.acknowledgeMissingAttemptCheckpoint) {
    throw new TypeError(
      'createPrincipalLifecycle requires a durable delivery-attempt checkpoint or acknowledgeMissingAttemptCheckpoint'
    );
  }
  if (typeof options.resolvePrincipal !== 'function') {
    throw new TypeError('createPrincipalLifecycle requires resolvePrincipal');
  }
  const production = process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'development';
  if (production && options.store.durability !== 'durable') {
    throw new TypeError('Production principal lifecycle requires a durable PrincipalStateStore');
  }
  const agentUrl = new URL(options.agentUrl);
  if (agentUrl.protocol !== 'https:' && process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'development') {
    throw new TypeError('createPrincipalLifecycle agentUrl must use HTTPS in production');
  }
  const now = options.now ?? (() => new Date());
  const issuePrincipalId = options.issuePrincipalId ?? (() => `prin_${randomUUID()}`);
  const issueConfigurationVersion = options.issueConfigurationVersion ?? (() => `cfg_${randomUUID()}`);
  const issueDestinationRef = options.issueDestinationRef ?? (() => `dest_${randomUUID()}`);
  const maxCasAttempts = options.maxCasAttempts ?? 8;
  if (!Number.isSafeInteger(maxCasAttempts) || maxCasAttempts < 1 || maxCasAttempts > 32) {
    throw new TypeError('maxCasAttempts must be 1 through 32');
  }
  const maxPendingNotifications = boundedOption(options.maxPendingNotifications, 256, 'maxPendingNotifications');
  const maxNotificationsPerFlush = boundedOption(options.maxNotificationsPerFlush, 100, 'maxNotificationsPerFlush');
  const maxReportingGenerations = boundedOption(options.maxReportingGenerations, 256, 'maxReportingGenerations');

  async function resolve(ctx: HandlerContext<TAccount>): Promise<ResolvedPrincipalScope> {
    const cached = ctx.callerMutationScope as (ResolvedPrincipalScope & Record<string, unknown>) | undefined;
    const resolved = cached?.principal_kind ? cached : await options.resolvePrincipal(ctx);
    assertResolvedPrincipal(resolved);
    return Object.freeze({ ...resolved });
  }

  async function getPrincipal(
    params: GetPrincipalRequest,
    ctx: HandlerContext<TAccount>
  ): Promise<ServerPayload<GetPrincipalResponse>> {
    const resolved = await resolve(ctx);
    const scope = storeScope(resolved);
    const current = await options.store.get(scope);
    if (!current) {
      if (resolved.principal_record_id) {
        return {
          result: {
            kind: 'recognized',
            principal_id: resolved.principal_record_id,
            principal_kind: resolved.principal_kind,
          },
        };
      }
      return { result: { kind: 'unconfigured' } };
    }
    assertIdentityContinuity(current.record, resolved);
    if (!current.record.configuration || !current.record.configurationVersion) {
      return {
        result: {
          kind: 'recognized',
          principal_id: current.record.principalId,
          principal_kind: current.record.principalKind,
        },
      };
    }
    return { result: currentResult(current.record) };
  }

  async function syncPrincipal(
    params: SyncPrincipalRequest,
    ctx: HandlerContext<TAccount>
  ): Promise<ServerPayload<SyncPrincipalResponse>> {
    const resolved = await resolve(ctx);
    return syncConfiguration(resolved, params);
  }

  async function syncConfiguration(
    resolved: ResolvedPrincipalScope,
    params: SyncPrincipalRequest
  ): Promise<ServerPayload<SyncPrincipalResponse>> {
    const scope = storeScope(resolved);
    const current = await options.store.get(scope);
    if (current) assertIdentityContinuity(current.record, resolved);
    if (params.expected_principal_kind && params.expected_principal_kind !== resolved.principal_kind) {
      return syncFailure('CONFLICT', 'The authenticated principal kind does not match expected_principal_kind');
    }
    if (
      params.expected_configuration_version !== undefined &&
      params.expected_configuration_version !== current?.record.configurationVersion
    ) {
      return syncFailure('CONFLICT', 'The principal configuration changed; read current state and retry');
    }

    let notificationPlan: PreparedNotificationReplacement | undefined;
    try {
      if (params.configuration.notification_configs !== undefined) {
        const prepared = await options.notifications.prepareReplacement!(
          notificationScope(scope),
          params.configuration.notification_configs,
          {
            dryRun: params.dry_run === true,
            expectedGeneration: current?.record.notificationGeneration ?? null,
          }
        );
        if (prepared.outcome === 'conflict') {
          return syncFailure('CONFLICT', 'The principal notification section changed; read current state and retry');
        }
        if (prepared.outcome === 'proof_failed') {
          return syncFailure(
            'VALIDATION_ERROR',
            `Endpoint proof failed for subscriber ${JSON.stringify(prepared.subscriberId)}`
          );
        }
        notificationPlan = prepared.plan;
      }

      const nextConfiguration = await buildConfiguration(
        scope,
        current?.record.configuration,
        params.configuration,
        notificationPlan,
        params.dry_run === true
      );
      const reportingGenerations = mergeReportingGenerations(
        current?.record.reportingGenerations ?? [],
        current?.record.configuration?.reporting_destinations ?? [],
        nextConfiguration.reporting_destinations ?? [],
        params.configuration.reporting_destinations !== undefined,
        now(),
        maxReportingGenerations
      );
      const currentConfiguration = current?.record.configuration ?? {};
      const changed =
        notificationPlan?.changed === true ||
        canonicalJsonSha256(currentConfiguration) !== canonicalJsonSha256(nextConfiguration);
      const cleared = submittedSectionsAreEmpty(params.configuration);

      if (params.dry_run === true) {
        await notificationPlan?.discardCredentials();
        return {
          result: {
            kind: 'validated',
            action: changed ? (cleared ? 'would_clear' : 'would_update') : 'would_be_unchanged',
            dry_run: true,
          },
        };
      }

      if (!changed && current?.record.configurationVersion) {
        await notificationPlan?.discardCredentials();
        return {
          result: {
            ...currentResult(current.record),
            kind: 'applied',
            action: 'unchanged',
            dry_run: false,
          },
        };
      }

      const principalId = current?.record.principalId ?? resolved.principal_record_id ?? issuePrincipalId(scope);
      assertOpaqueId(principalId, 'principal id');
      const record: StoredPrincipalRecord = {
        schemaVersion: 1,
        tenantId: scope.tenantId,
        scopePrincipalId: scope.principalId,
        principalId,
        principalKind: resolved.principal_kind,
        configurationVersion: issueConfigurationVersion(),
        configuration: nextConfiguration,
        notificationGeneration: notificationPlan?.nextGeneration ?? current?.record.notificationGeneration,
        notificationSubscriptions:
          notificationPlan?.subscriptions ?? structuredClone(current?.record.notificationSubscriptions ?? []),
        reportingGenerations,
        pendingNotifications: structuredClone(current?.record.pendingNotifications ?? []),
      };
      const persisted = await options.store.replace({
        scope,
        expectedRevision: current?.revision ?? null,
        record,
      });
      if (persisted.outcome === 'conflict') {
        await notificationPlan?.discardCredentials();
        return syncFailure('CONFLICT', 'The principal configuration changed; read current state and retry');
      }
      await notificationPlan?.commitCredentials();
      return {
        result: {
          ...currentResult(persisted.value.record),
          kind: 'applied',
          action: cleared ? 'cleared' : 'updated',
          dry_run: false,
        },
      };
    } catch (error) {
      await notificationPlan?.discardCredentials();
      if (error instanceof NotificationSubscriptionValidationError) {
        return syncFailure('INVALID_REQUEST', error.message);
      }
      if (error instanceof UnsupportedPrincipalFeatureError) {
        return syncFailure('UNSUPPORTED_FEATURE', error.message);
      }
      if (error instanceof PrincipalStateConflictError) {
        return syncFailure('CONFLICT', error.message);
      }
      throw error;
    }
  }

  async function buildConfiguration(
    scope: Readonly<PrincipalStoreScope>,
    current: PrincipalConfiguration | undefined,
    input: PrincipalConfigurationInput,
    notifications: PreparedNotificationReplacement | undefined,
    dryRun: boolean
  ): Promise<PrincipalConfiguration> {
    const next: PrincipalConfiguration = structuredClone(
      current ?? {
        notification_configs: [],
        ...(options.prepareReportingDestination ? { reporting_destinations: [], retired_destinations: [] } : {}),
        ...(options.declarations ? { declarations: intersectDeclarations({}, options.declarations) } : {}),
      }
    );
    if (input.notification_configs !== undefined) {
      next.notification_configs = projectNotificationSubscriptionReadback(
        notifications?.notificationConfigs ?? []
      ) as PrincipalConfiguration['notification_configs'];
    }
    if (input.reporting_destinations !== undefined) {
      if (!options.prepareReportingDestination) {
        throw new UnsupportedPrincipalFeatureError('reporting_destinations are not supported by this seller');
      }
      const reporting = await prepareReportingDestinations(
        scope,
        current?.reporting_destinations ?? [],
        current?.retired_destinations ?? [],
        input.reporting_destinations,
        dryRun
      );
      next.reporting_destinations = reporting.current;
      next.retired_destinations = reporting.retired;
    }
    if (input.declarations !== undefined) {
      if (!options.declarations) {
        throw new UnsupportedPrincipalFeatureError('declarations are not supported by this seller');
      }
      next.declarations = intersectDeclarations(input.declarations, options.declarations);
    }
    enforceWebhookDeclarationCompatibility(next);
    return next;
  }

  async function prepareReportingDestinations(
    scope: Readonly<PrincipalStoreScope>,
    current: readonly PrincipalReportingDestination[],
    retired: NonNullable<PrincipalConfiguration['retired_destinations']>,
    desired: readonly PrincipalReportingDestinationInput[],
    dryRun: boolean
  ): Promise<{
    current: PrincipalReportingDestination[];
    retired: NonNullable<PrincipalConfiguration['retired_destinations']>;
  }> {
    const seen = new Set<string>();
    const priorById = new Map(current.map(item => [item.destination_id, item]));
    const next: PrincipalReportingDestination[] = [];
    for (const destination of desired) {
      if (seen.has(destination.destination_id)) {
        throw new NotificationSubscriptionValidationError(
          `Duplicate reporting destination_id ${JSON.stringify(destination.destination_id)}`,
          'configuration.reporting_destinations'
        );
      }
      seen.add(destination.destination_id);
      const prior = priorById.get(destination.destination_id);
      if (destination.active === false) {
        const preparation = await options.prepareReportingDestination!({
          scope: structuredClone(scope),
          destination: structuredClone(destination),
          ...(prior ? { previous: structuredClone(prior) } : {}),
          dryRun,
        });
        if (
          !preparation ||
          preparation.configuration.destination_id !== destination.destination_id ||
          preparation.configuration.active !== false
        ) {
          throw new NotificationSubscriptionValidationError(
            'prepareReportingDestination changed destination identity or active state',
            'configuration.reporting_destinations'
          );
        }
        next.push({
          destination_id: destination.destination_id,
          destination_ref: prior?.destination_ref ?? issueDestinationRef(),
          ...(prior?.prior_destination_refs ? { prior_destination_refs: [...prior.prior_destination_refs] } : {}),
          state: 'inactive',
          configuration: structuredClone(preparation.configuration),
        });
        continue;
      }
      if (
        prior &&
        canonicalJsonSha256(prior.configuration) === canonicalJsonSha256(destination) &&
        prior.state !== 'rejected' &&
        !setupExpired(prior, now())
      ) {
        next.push(structuredClone(prior));
        continue;
      }
      const preparation = await options.prepareReportingDestination!({
        scope: structuredClone(scope),
        destination: structuredClone(destination),
        ...(prior ? { previous: structuredClone(prior) } : {}),
        dryRun,
      });
      if (!preparation || !['validating', 'action_required', 'rejected'].includes(preparation.state)) {
        throw new NotificationSubscriptionValidationError(
          'prepareReportingDestination returned an invalid state',
          'configuration.reporting_destinations'
        );
      }
      if (preparation.state === 'action_required' && preparation.setup === undefined) {
        throw new NotificationSubscriptionValidationError(
          'prepareReportingDestination must return setup for action_required',
          'configuration.reporting_destinations'
        );
      }
      if (
        preparation.configuration.destination_id !== destination.destination_id ||
        preparation.configuration.active === false
      ) {
        throw new NotificationSubscriptionValidationError(
          'prepareReportingDestination changed destination identity or active state',
          'configuration.reporting_destinations'
        );
      }
      const changedTuple =
        !prior || canonicalJsonSha256(prior.configuration) !== canonicalJsonSha256(preparation.configuration);
      // Rejected and expired proof attempts are dead authorization generations,
      // even when the caller resubmits an identical destination tuple.
      const requiresFreshGeneration =
        !prior || changedTuple || prior.state === 'rejected' || setupExpired(prior, now());
      const priorDestinationRefs = prior ? [prior.destination_ref, ...(prior.prior_destination_refs ?? [])] : [];
      if (requiresFreshGeneration && priorDestinationRefs.length > 32) {
        throw new PrincipalStateConflictError(
          `Reporting destination ${JSON.stringify(destination.destination_id)} has reached its retained generation limit`
        );
      }
      next.push({
        destination_id: destination.destination_id,
        destination_ref: requiresFreshGeneration ? issueDestinationRef() : prior.destination_ref,
        ...(prior
          ? {
              prior_destination_refs: requiresFreshGeneration
                ? priorDestinationRefs
                : [...(prior.prior_destination_refs ?? [])],
            }
          : {}),
        state: preparation.state,
        configuration: structuredClone(preparation.configuration),
        ...(preparation.setup ? { setup: structuredClone(preparation.setup) } : {}),
        ...(preparation.issues ? { issues: structuredClone(preparation.issues) } : {}),
      });
    }

    const nextRetired = structuredClone(retired);
    for (const previous of current) {
      if (seen.has(previous.destination_id)) continue;
      const refs = [previous.destination_ref, ...(previous.prior_destination_refs ?? [])];
      const existing = nextRetired.find(item => item.destination_id === previous.destination_id);
      const destinationRefs = [...new Set([...refs, ...(existing?.destination_refs ?? [])])].slice(0, 32);
      const entry = {
        destination_id: previous.destination_id,
        destination_refs: destinationRefs,
        revoked_at: now().toISOString(),
      };
      const index = nextRetired.findIndex(item => item.destination_id === previous.destination_id);
      if (index === -1) nextRetired.push(entry);
      else nextRetired[index] = entry;
    }
    next.sort((a, b) => a.destination_id.localeCompare(b.destination_id));
    nextRetired.sort((a, b) => (b.revoked_at ?? '').localeCompare(a.revoked_at ?? ''));
    return { current: next, retired: nextRetired.slice(0, 64) };
  }

  async function syncAgentNotificationConfigs(
    params: SyncAgentNotificationConfigsRequest,
    ctx: HandlerContext<TAccount>
  ): Promise<ServerPayload<SyncAgentNotificationConfigsResponse>> {
    const resolved = await resolve(ctx);
    const response = await syncConfiguration(resolved, {
      idempotency_key: params.idempotency_key,
      configuration: { notification_configs: params.notification_configs ?? [] },
      ...(params.dry_run === undefined ? {} : { dry_run: params.dry_run }),
    });
    const result = response.result;
    if (result.kind === 'failed') {
      const current = await options.notifications.read(notificationScope(storeScope(resolved)));
      return {
        action: 'failed',
        dry_run: params.dry_run === true,
        notification_configs: projectNotificationSubscriptionReadback(
          current.notificationConfigs
        ) as SyncAgentNotificationConfigsResponse['notification_configs'],
        errors: result.errors,
      };
    }
    if (result.kind === 'validated') {
      const preview = await options.notifications.prepareReplacement!(
        notificationScope(storeScope(resolved)),
        params.notification_configs ?? [],
        { dryRun: true }
      );
      if (preview.outcome === 'conflict') throw new Error('Dry-run notification preparation conflicted');
      if (preview.outcome === 'proof_failed') throw new Error('Dry-run notification preparation attempted proof');
      const configs = projectNotificationSubscriptionReadback(preview.plan.notificationConfigs);
      await preview.plan.discardCredentials();
      return {
        action:
          result.action === 'would_be_unchanged'
            ? 'unchanged'
            : result.action === 'would_clear'
              ? 'cleared'
              : 'updated',
        dry_run: true,
        notification_configs: configs as SyncAgentNotificationConfigsResponse['notification_configs'],
      };
    }
    return {
      action: result.action,
      dry_run: false,
      notification_configs: result.configuration.notification_configs ?? [],
    };
  }

  async function recognizePrincipal(input: {
    scope: PrincipalStoreScope;
    principalId: string;
    principalKind: PrincipalKind;
  }): Promise<void> {
    assertStoreScope(input.scope);
    assertOpaqueId(input.principalId, 'principal id');
    const current = await options.store.get(input.scope);
    if (current) {
      if (current.record.principalId !== input.principalId || current.record.principalKind !== input.principalKind) {
        throw new Error('Principal identity continuity violation');
      }
      return;
    }
    const record = emptyRecord(input.scope, input.principalId, input.principalKind);
    const result = await options.store.replace({ scope: input.scope, expectedRevision: null, record });
    if (result.outcome === 'conflict')
      throw new Error('Principal identity was created concurrently; retry recognition');
  }

  async function transitionDestination(
    scope: Readonly<PrincipalStoreScope>,
    transition: Readonly<PrincipalDestinationTransition>,
    transitionOptions: { deferNotification?: boolean } = {}
  ): Promise<PrincipalConfiguration> {
    assertStoreScope(scope);
    for (let attempt = 0; attempt < maxCasAttempts; attempt++) {
      const current = await options.store.get(scope);
      if (!current?.record.configuration || !current.record.configurationVersion) {
        throw new Error('Principal configuration does not exist');
      }
      const record = structuredClone(current.record);
      const configuration = record.configuration!;
      const destinations = configuration.reporting_destinations ?? [];
      const index = destinations.findIndex(item => item.destination_id === transition.destinationId);
      const destination = destinations[index];
      if (!destination || destination.destination_ref !== transition.destinationRef) {
        throw new Error('Reporting destination generation is not current for this principal');
      }
      if (destination.configuration.active === false) {
        throw new Error('Suspended reporting destinations cannot transition to an active setup state');
      }
      if (!['validating', 'ready', 'action_required', 'rejected'].includes(transition.state)) {
        throw new Error('Reporting destination transition state is invalid');
      }
      if (destination.state === 'rejected') {
        throw new Error('Rejected reporting destination generations cannot transition');
      }
      if (transition.state === 'ready' && setupExpired(destination, now())) {
        throw new Error('Expired reporting destination setup cannot transition to ready');
      }
      if (transition.state === 'action_required' && transition.setup === undefined) {
        throw new Error('action_required reporting destination transitions require setup');
      }
      const updated = {
        ...destination,
        state: transition.state,
      } as PrincipalReportingDestination;
      delete updated.setup;
      delete updated.issues;
      if (transition.setup !== undefined) updated.setup = structuredClone(transition.setup);
      if (transition.issues !== undefined) updated.issues = structuredClone(transition.issues);
      if (canonicalJsonSha256(destination) === canonicalJsonSha256(updated)) {
        return structuredClone(record.configuration!);
      }
      destinations[index] = updated;
      const storedGeneration = record.reportingGenerations?.find(
        generation => generation.destinationRef === transition.destinationRef
      );
      if (!storedGeneration) throw new Error('Reporting destination generation record is missing');
      storedGeneration.state = transition.state;
      storedGeneration.updatedAt = now().toISOString();
      const timestamp = now().toISOString();
      enqueuePrincipalNotification(
        record,
        {
          notificationId: `principal_${randomUUID()}`,
          emissionId: randomUUID(),
          changedAt: timestamp,
          firedAt: timestamp,
          reason: transition.reason ?? 'destination_state_changed',
          destinationId: transition.destinationId,
          recipients: principalNotificationRecipients(record, scope),
        },
        maxPendingNotifications
      );
      const result = await options.store.replace({
        scope,
        expectedRevision: current.revision,
        record,
      });
      if (result.outcome === 'conflict') continue;
      if (!transitionOptions.deferNotification) await flushPrincipalNotifications(scope);
      return structuredClone(result.value.record.configuration!);
    }
    throw new Error('Principal destination transition conflicted repeatedly');
  }

  async function flushPrincipalNotifications(scope: Readonly<PrincipalStoreScope>): Promise<void> {
    assertStoreScope(scope);
    let casConflicts = 0;
    for (let processed = 0; processed < maxNotificationsPerFlush; processed++) {
      const current = await options.store.get(scope);
      const pending = current?.record.pendingNotifications[0];
      if (!current || !pending) return;
      const result = await options.notifications.emit({
        emissionId: pending.emissionId,
        notificationId: pending.notificationId,
        notificationType: 'principal.changed',
        anchor: 'caller',
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        freezeRecipients: () => structuredClone(pending.recipients ?? []),
        payload: {
          idempotency_key: pending.emissionId,
          fired_at: pending.firedAt,
          agent_url: agentUrl.toString(),
          changed_at: pending.changedAt,
          reason: pending.reason,
          ...(pending.destinationId ? { destination_id: pending.destinationId } : {}),
        },
      });
      if (
        result.deliveries.some(
          delivery =>
            (delivery.failure !== undefined && delivery.failure.terminal !== true) ||
            (delivery.result !== undefined && !delivery.result.delivered && delivery.result.terminal !== true)
        )
      ) {
        return;
      }
      const latest = await options.store.get(scope);
      if (!latest) return;
      const index = latest.record.pendingNotifications.findIndex(
        item => item.notificationId === pending.notificationId && item.emissionId === pending.emissionId
      );
      if (index === -1) continue;
      const record = structuredClone(latest.record);
      record.pendingNotifications.splice(index, 1);
      if (pending.reason === 'declarations_intersection_changed') {
        for (const subscription of record.notificationSubscriptions) {
          if (subscription.deactivationNotificationId !== pending.notificationId) continue;
          subscription.active = false;
          delete subscription.deactivationNotificationId;
        }
      }
      const removed = await options.store.replace({ scope, expectedRevision: latest.revision, record });
      if (removed.outcome === 'conflict') {
        casConflicts++;
        if (casConflicts >= maxCasAttempts) {
          throw new Error('Principal notification flush conflicted repeatedly');
        }
        processed--;
      }
    }
  }

  async function recoverPrincipalNotifications(
    recoveryOptions: { limit?: number; cursor?: string } = {}
  ): Promise<PrincipalNotificationRecoveryResult> {
    const limit = recoveryOptions.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new TypeError('principal notification recovery limit must be 1 through 10000');
    }
    const page = await options.store.findPendingNotificationScopes({
      limit,
      ...(recoveryOptions.cursor === undefined ? {} : { cursor: recoveryOptions.cursor }),
    });
    let failedScopes = 0;
    for (const scope of page.scopes) {
      try {
        await flushPrincipalNotifications(scope);
      } catch {
        failedScopes++;
      }
    }
    return {
      processedScopes: page.scopes.length,
      failedScopes,
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }

  async function resolveReportingDestination(
    scope: Readonly<PrincipalStoreScope>,
    destinationRef: string
  ): Promise<ResolvedReportingDestination | null> {
    assertStoreScope(scope);
    assertOpaqueId(destinationRef, 'destination ref');
    const current = await options.store.get(scope);
    const generation = current?.record.reportingGenerations.find(item => item.destinationRef === destinationRef);
    if (!generation) return null;
    return {
      destinationId: generation.destinationId,
      destinationRef: generation.destinationRef,
      configuration: structuredClone(generation.configuration),
      state: generation.state,
      lifecycle: generation.lifecycle,
      deliveryEligible: generation.lifecycle !== 'retired' && !generation.suspended && generation.state === 'ready',
    };
  }

  async function reconcileDeclarations(
    scope: Readonly<PrincipalStoreScope>,
    reconcileOptions: { deferNotification?: boolean } = {}
  ): Promise<PrincipalConfiguration> {
    assertStoreScope(scope);
    if (!options.declarations) throw new Error('Principal declarations are not supported by this seller');
    for (let attempt = 0; attempt < maxCasAttempts; attempt++) {
      const current = await options.store.get(scope);
      const declarations = current?.record.configuration?.declarations;
      if (!current?.record.configuration || !declarations) {
        throw new Error('Principal declarations do not exist');
      }
      const replacement = intersectDeclarations(declarations.declared, options.declarations);
      const mustDeactivateSubscribers =
        declarations.declared.webhook_signing_algorithms !== undefined &&
        replacement.accepted.webhook_signing_algorithms === undefined &&
        current.record.notificationSubscriptions.some(
          subscription => subscription.active && subscription.deactivationNotificationId === undefined
        );
      if (!mustDeactivateSubscribers && canonicalJsonSha256(replacement) === canonicalJsonSha256(declarations)) {
        return structuredClone(current.record.configuration);
      }
      const record = structuredClone(current.record);
      const recipients = principalNotificationRecipients(record, scope);
      record.configuration!.declarations = replacement;
      const notificationId = `principal_${randomUUID()}`;
      if (mustDeactivateSubscribers) {
        for (const subscription of record.notificationSubscriptions) {
          if (subscription.active) subscription.deactivationNotificationId = notificationId;
        }
        record.configuration!.notification_configs = projectStoredNotificationSubscriptionReadback(
          record.notificationSubscriptions
        ) as PrincipalConfiguration['notification_configs'];
      }
      const timestamp = now().toISOString();
      enqueuePrincipalNotification(
        record,
        {
          notificationId,
          emissionId: randomUUID(),
          changedAt: timestamp,
          firedAt: timestamp,
          reason: 'declarations_intersection_changed',
          recipients,
        },
        maxPendingNotifications
      );
      const persisted = await options.store.replace({
        scope,
        expectedRevision: current.revision,
        record,
      });
      if (persisted.outcome === 'conflict') continue;
      if (!reconcileOptions.deferNotification) await flushPrincipalNotifications(scope);
      return structuredClone(persisted.value.record.configuration!);
    }
    throw new Error('Principal declaration reconciliation conflicted repeatedly');
  }

  const resolveProtocolScope = async (ctx: HandlerContext<TAccount>) => {
    return resolve(ctx);
  };
  const protocol: PrincipalLifecycleRuntime<TAccount>['protocol'] = {
    resolvePrincipalScope: resolveProtocolScope,
    getPrincipal,
    syncPrincipal: syncPrincipal as unknown as NonNullable<ProtocolHandlers<TAccount>['syncPrincipal']>,
    ...(options.includeCompatibilityNotificationTask
      ? {
          resolveScope: resolveProtocolScope,
          syncAgentNotificationConfigs: syncAgentNotificationConfigs as unknown as NonNullable<
            ProtocolHandlers<TAccount>['syncAgentNotificationConfigs']
          >,
        }
      : {}),
  };

  return {
    protocol,
    recognizePrincipal,
    transitionDestination,
    flushPrincipalNotifications,
    recoverPrincipalNotifications,
    resolveReportingDestination,
    reconcileDeclarations,
  };
}

function storeScope(resolved: Readonly<ResolvedPrincipalScope>): PrincipalStoreScope {
  return { tenantId: resolved.tenant_id, principalId: resolved.principal_id };
}

function notificationScope(scope: Readonly<PrincipalStoreScope>) {
  return { kind: 'caller' as const, tenantId: scope.tenantId, principalId: scope.principalId };
}

function currentResult(record: Readonly<StoredPrincipalRecord>) {
  if (!record.configuration || !record.configurationVersion) throw new Error('Principal record is not configured');
  return {
    kind: 'current' as const,
    principal_id: record.principalId,
    principal_kind: record.principalKind,
    configuration_version: record.configurationVersion,
    configuration: structuredClone(record.configuration),
  };
}

function syncFailure(
  code: 'CONFLICT' | 'VALIDATION_ERROR' | 'INVALID_REQUEST' | 'UNSUPPORTED_FEATURE',
  message: string
): ServerPayload<SyncPrincipalResponse> {
  return {
    status: 'failed',
    result: { kind: 'failed', errors: [{ code, message }] },
  } as unknown as ServerPayload<SyncPrincipalResponse>;
}

class UnsupportedPrincipalFeatureError extends Error {}
class PrincipalStateConflictError extends Error {}

function emptyRecord(
  scope: Readonly<PrincipalStoreScope>,
  principalId: string,
  principalKind: PrincipalKind
): StoredPrincipalRecord {
  return {
    schemaVersion: 1,
    tenantId: scope.tenantId,
    scopePrincipalId: scope.principalId,
    principalId,
    principalKind,
    notificationSubscriptions: [],
    reportingGenerations: [],
    pendingNotifications: [],
  };
}

function assertResolvedPrincipal(value: unknown): asserts value is ResolvedPrincipalScope {
  if (!value || typeof value !== 'object') throw new Error('resolvePrincipal returned no stable principal');
  const scope = value as Partial<ResolvedPrincipalScope>;
  assertOpaqueId(scope.tenant_id, 'tenant id');
  assertOpaqueId(scope.principal_id, 'stable principal scope');
  if (scope.principal_kind !== 'buyer_agent' && scope.principal_kind !== 'operator') {
    throw new Error('resolvePrincipal returned an invalid principal kind');
  }
  if (scope.principal_record_id !== undefined) assertOpaqueId(scope.principal_record_id, 'principal record id');
}

function assertStoreScope(scope: Readonly<PrincipalStoreScope>): void {
  assertOpaqueId(scope.tenantId, 'tenant id');
  assertOpaqueId(scope.principalId, 'stable principal scope');
}

function assertOpaqueId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255) {
    throw new Error(`${label} must contain 1 through 255 characters`);
  }
}

function assertIdentityContinuity(
  record: Readonly<StoredPrincipalRecord>,
  resolved: Readonly<ResolvedPrincipalScope>
): void {
  if (
    record.tenantId !== resolved.tenant_id ||
    record.scopePrincipalId !== resolved.principal_id ||
    record.principalKind !== resolved.principal_kind ||
    (resolved.principal_record_id !== undefined && record.principalId !== resolved.principal_record_id)
  ) {
    throw new Error('Principal identity continuity violation');
  }
}

function submittedSectionsAreEmpty(input: PrincipalConfigurationInput): boolean {
  const entries = Object.entries(input);
  return entries.length > 0 && entries.every(([, value]) => Array.isArray(value) && value.length === 0);
}

function intersectDeclarations(
  declared: PrincipalDeclarations,
  support: PrincipalDeclarationSupport | undefined
): PrincipalDeclarationsState {
  const accepted: PrincipalDeclarations = {};
  const exclusions: NonNullable<PrincipalDeclarationsState['exclusions']> = [];
  const axes = [
    ['async_adcp_versions', declared.async_adcp_versions, support?.asyncAdcpVersions],
    ['webhook_signing_algorithms', declared.webhook_signing_algorithms, support?.webhookSigningAlgorithms],
    ['experimental_features', declared.experimental_features, support?.experimentalFeatures],
  ] as const;
  for (const [axis, values, supported] of axes) {
    if (!values) continue;
    const supportedSet = new Set<string>(supported ?? []);
    const intersection = values.filter(value => supportedSet.has(value));
    if (intersection.length > 0) (accepted as Record<string, unknown>)[axis] = intersection;
    for (const value of values) {
      if (supportedSet.has(value)) continue;
      exclusions.push({
        axis,
        value,
        reason: support?.exclusionReason?.(axis, value) ?? 'Not supported by this seller',
      });
    }
  }
  const versions = accepted.async_adcp_versions ?? [];
  const selected = support?.selectAsyncAdcpVersion?.(versions) ?? highestVersion(versions);
  if (selected !== undefined && !versions.includes(selected)) {
    throw new Error('selectAsyncAdcpVersion returned a version outside the accepted intersection');
  }
  return {
    declared: structuredClone(declared),
    accepted,
    ...(selected === undefined ? {} : { selected_async_adcp_version: selected }),
    ...(exclusions.length === 0 ? {} : { exclusions }),
  };
}

function highestVersion(versions: readonly string[]): string | undefined {
  return [...versions].sort((left, right) => {
    const normalizedLeft = normalizedReleaseSemver(left);
    const normalizedRight = normalizedReleaseSemver(right);
    if (normalizedLeft && normalizedRight) return compareSemver(normalizedRight, normalizedLeft);
    return right.localeCompare(left, undefined, { numeric: true });
  })[0];
}

function normalizedReleaseSemver(value: string): string | undefined {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) return undefined;
  return `${match[1]}.${match[2]}.${match[3] ?? '0'}${match[4] ?? ''}`;
}

function setupExpired(destination: Readonly<PrincipalReportingDestination>, now: Date): boolean {
  if (!destination.setup?.expires_at) return false;
  const expiry = Date.parse(destination.setup.expires_at);
  return Number.isFinite(expiry) && expiry <= now.getTime();
}

function enforceWebhookDeclarationCompatibility(configuration: Readonly<PrincipalConfiguration>): void {
  const hasActiveSubscriber = configuration.notification_configs?.some(item => item.active !== false) === true;
  if (!hasActiveSubscriber || !configuration.declarations) return;
  const signingDeclared = configuration.declarations.declared.webhook_signing_algorithms;
  if (signingDeclared && (configuration.declarations.accepted.webhook_signing_algorithms?.length ?? 0) === 0) {
    throw new UnsupportedPrincipalFeatureError(
      'Active webhook subscribers require an accepted webhook signing algorithm'
    );
  }
}

function principalNotificationRecipients(
  record: Readonly<StoredPrincipalRecord>,
  scope: Readonly<PrincipalStoreScope>
) {
  return record.notificationSubscriptions
    .filter(
      subscription =>
        subscription.active &&
        subscription.proofGeneration === subscription.destinationGeneration &&
        subscription.eventTypes.includes('principal.changed')
    )
    .map(subscription => ({
      scope: notificationScope(scope),
      subscriberId: subscription.subscriberId,
      destinationGeneration: subscription.destinationGeneration,
    }));
}

function mergeReportingGenerations(
  stored: readonly StoredReportingDestinationGeneration[],
  previousCurrent: readonly PrincipalReportingDestination[],
  nextCurrent: readonly PrincipalReportingDestination[],
  sectionSubmitted: boolean,
  now: Date,
  maxGenerations: number
): StoredReportingDestinationGeneration[] {
  if (!sectionSubmitted) return stored.map(item => structuredClone(item));
  const timestamp = now.toISOString();
  const generations: StoredReportingDestinationGeneration[] = stored.map(item => structuredClone(item));
  for (const previous of previousCurrent) {
    if (generations.some(item => item.destinationRef === previous.destination_ref)) continue;
    generations.push({
      destinationId: previous.destination_id,
      destinationRef: previous.destination_ref,
      configuration: structuredClone(previous.configuration),
      state: previous.state,
      lifecycle: 'current',
      suspended: previous.configuration.active === false,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
  const nextById = new Map(nextCurrent.map(destination => [destination.destination_id, destination]));
  for (const generation of generations) {
    const next = nextById.get(generation.destinationId);
    if (!next) {
      generation.lifecycle = 'retired';
      generation.suspended = true;
      generation.updatedAt = timestamp;
      continue;
    }
    if (generation.lifecycle === 'retired') continue;
    if (generation.destinationRef === next.destination_ref) {
      generation.lifecycle = 'current';
      generation.configuration = structuredClone(next.configuration);
      generation.state = next.state;
      generation.suspended = next.configuration.active === false;
      generation.updatedAt = timestamp;
    } else {
      if (generation.lifecycle === 'current') generation.lifecycle = 'superseded';
      // Suspension revokes every extant generation. A later reauthorization
      // creates a fresh current reference and must not reactivate older ones.
      if (next.configuration.active === false) generation.suspended = true;
      generation.updatedAt = timestamp;
    }
  }
  for (const next of nextCurrent) {
    if (generations.some(item => item.destinationRef === next.destination_ref)) continue;
    generations.push({
      destinationId: next.destination_id,
      destinationRef: next.destination_ref,
      configuration: structuredClone(next.configuration),
      state: next.state,
      lifecycle: 'current',
      suspended: next.configuration.active === false,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
  if (generations.length <= maxGenerations) return generations;
  const retained = generations.filter(item => item.lifecycle !== 'retired');
  if (retained.length > maxGenerations) {
    throw new PrincipalStateConflictError(
      'Reporting destination history has reached its retention limit; revoke old destinations before rotating'
    );
  }
  const retired = generations
    .filter(item => item.lifecycle === 'retired')
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, maxGenerations - retained.length);
  return [...retained, ...retired];
}

function enqueuePrincipalNotification(
  record: StoredPrincipalRecord,
  notification: PendingPrincipalNotification,
  limit: number
): void {
  record.pendingNotifications.push(notification);
  while (record.pendingNotifications.length > limit) {
    const protectedIds = new Set(
      record.notificationSubscriptions
        .map(subscription => subscription.deactivationNotificationId)
        .filter((value): value is string => value !== undefined)
    );
    const removable = record.pendingNotifications.findIndex(item => !protectedIds.has(item.notificationId));
    if (removable === -1) {
      throw new PrincipalStateConflictError(
        'Principal notification outbox is full of required deactivation invalidations; recover it before retrying'
      );
    }
    record.pendingNotifications.splice(removable, 1);
  }
}

function boundedOption(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 10_000) {
    throw new TypeError(`${name} must be 1 through 10000`);
  }
  return resolved;
}
