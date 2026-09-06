import type { ServerPayload } from '../../types/server-payload';
import type { AgentNotificationConfig, SyncAgentNotificationConfigsResponse } from '../../types/tools.generated';
import type { ProtocolHandlers } from '../create-adcp-server';
import type {
  NotificationReplacementResult,
  NotificationSubscriptionView,
  PersistentNotificationRuntime,
} from './types';
import { NotificationSubscriptionValidationError } from './types';

type SyncNotificationPayload = ServerPayload<SyncAgentNotificationConfigsResponse>;

/**
 * Wire the specialized compatibility task to one persistent runtime. Passing
 * this object as `protocol` makes the runtime the sole writer, avoiding the
 * double-write race created by layering it behind an adopter handler.
 *
 * `sync_principal` may replace several sections atomically, so applications
 * should call `runtime.replace()` from their broader principal transaction
 * rather than use this single-section helper for that task.
 */
export function createPersistentNotificationProtocolHandlers<TAccount = unknown>(
  runtime: PersistentNotificationRuntime,
  resolveScope: NonNullable<ProtocolHandlers<TAccount>['resolveScope']>
): Pick<ProtocolHandlers<TAccount>, 'resolveScope' | 'syncAgentNotificationConfigs'> {
  return {
    resolveScope,
    async syncAgentNotificationConfigs(params, ctx): Promise<SyncNotificationPayload> {
      const resolved = ctx.callerMutationScope ?? (await resolveScope(ctx, params));
      if (!resolved?.tenant_id || !resolved.principal_id) {
        return failedPayload('INVALID_REQUEST', 'Authenticated caller scope is incomplete');
      }
      const scope = {
        kind: 'caller' as const,
        tenantId: resolved.tenant_id,
        principalId: resolved.principal_id,
      };
      let result: NotificationReplacementResult;
      try {
        result = await runtime.replace(scope, params.notification_configs, {
          dryRun: params.dry_run === true,
        });
      } catch (error) {
        if (error instanceof NotificationSubscriptionValidationError) {
          const current = await runtime.read(scope);
          return failedPayload('INVALID_REQUEST', error.message, current.notificationConfigs, params.dry_run === true);
        }
        throw error;
      }
      return replacementPayload(runtime, scope, result, params.dry_run === true);
    },
  };
}

async function replacementPayload(
  runtime: PersistentNotificationRuntime,
  scope: Parameters<PersistentNotificationRuntime['read']>[0],
  result: NotificationReplacementResult,
  dryRun: boolean
): Promise<SyncNotificationPayload> {
  if (result.outcome === 'conflict') {
    const current = await runtime.read(scope);
    return failedPayload(
      'INVALID_STATE',
      'The subscriber set changed concurrently; read current state and retry the full replacement',
      current.notificationConfigs,
      dryRun
    );
  }
  if (result.outcome === 'proof_failed') {
    const current = await runtime.read(scope);
    return failedPayload(
      'VALIDATION_ERROR',
      `Endpoint proof failed for subscriber ${JSON.stringify(result.subscriberId)}`,
      current.notificationConfigs,
      dryRun
    );
  }
  const action =
    result.outcome === 'validated'
      ? result.wouldChange
        ? result.notificationConfigs.length === 0
          ? 'cleared'
          : 'updated'
        : 'unchanged'
      : result.outcome === 'applied'
        ? 'updated'
        : result.outcome;
  return {
    action,
    dry_run: dryRun,
    notification_configs: result.notificationConfigs.map(toWireConfig),
  };
}

function failedPayload(
  code: 'INVALID_REQUEST' | 'INVALID_STATE' | 'VALIDATION_ERROR',
  message: string,
  configs: readonly NotificationSubscriptionView[] = [],
  dryRun = false
): SyncNotificationPayload {
  return {
    action: 'failed',
    dry_run: dryRun,
    notification_configs: configs.map(toWireConfig),
    errors: [{ code, message }],
  };
}

function toWireConfig(view: Readonly<NotificationSubscriptionView>): AgentNotificationConfig {
  return {
    subscriber_id: view.subscriber_id,
    url: view.url,
    event_types: view.event_types as AgentNotificationConfig['event_types'],
    ...(view.all_authorized_accounts === undefined ? {} : { all_authorized_accounts: view.all_authorized_accounts }),
    ...(view.include_future_event_types === undefined
      ? {}
      : { include_future_event_types: view.include_future_event_types }),
    ...(view.authentication === undefined ? {} : { authentication: view.authentication }),
    active: view.active,
  };
}
