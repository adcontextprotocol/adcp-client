/**
 * `media_buy.reporting_delivery` registration capabilities for AdCP 3.3.
 *
 * `configuration_tasks[]` lists every task a seller accepts reporting registrations
 * through. `configuration_task: "sync_accounts"` is deprecated but kept for callers pinned
 * below 3.3, and is present when and only when `configuration_tasks` lists `sync_accounts`
 * or is absent. Advertising `subscriptions` requires `sync_principal` in
 * `configuration_tasks`, and vice versa (`core/reporting-delivery-capabilities.json`).
 */
import { PlatformConfigError } from '../../server/decisioning/runtime/validate-platform';
import type { ReportingDeliveryCapabilities } from '../../types/tools.generated';

/** @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md */
export interface ReportingConfigurationCapabilitiesInputV1 {
  /**
   * Accept principal-level reporting subscriptions through `sync_principal`. Absent keeps
   * the pre-3.3 shape exactly: `configuration_task: "sync_accounts"` and nothing else.
   */
  subscriptions?: {
    /** Most accounts one subscription serves; beyond it accounts get a `capacity` exception. */
    maxAccounts?: number;
    /** Whether periods missed during a loss of authority are delivered after re-grant. */
    backfillOnRegrant?: boolean;
    /** Standard dimensions the seller maps its report definitions onto. */
    dimensions?: readonly string[];
  };
  /**
   * Keep serving account-level `sync_accounts` `reporting_delivery_configs`. Defaults to
   * true; set false to list `sync_principal` alone, which serves reporting registration to
   * 3.3 callers only.
   */
  accountConfigurations?: boolean;
}

/** @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md */
export type ReportingConfigurationCapabilitiesV1 = Pick<
  ReportingDeliveryCapabilities,
  'configuration_task' | 'configuration_tasks' | 'subscriptions'
>;

/**
 * The registration fields of a `reporting_delivery` capability block.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function reportingConfigurationCapabilitiesV1(
  input: ReportingConfigurationCapabilitiesInputV1 = {}
): ReportingConfigurationCapabilitiesV1 {
  const accountConfigurations = input.accountConfigurations ?? true;
  if (input.subscriptions === undefined) {
    if (!accountConfigurations) {
      throw new PlatformConfigError(
        'Reporting registration requires sync_accounts, sync_principal subscriptions, or both. Enable subscriptions or keep accountConfigurations.',
        { configField: 'accountConfigurations' }
      );
    }
    return { configuration_task: 'sync_accounts' };
  }
  const { maxAccounts, backfillOnRegrant, dimensions } = input.subscriptions;
  if (maxAccounts !== undefined && (!Number.isSafeInteger(maxAccounts) || maxAccounts < 1)) {
    throw new PlatformConfigError(
      'subscriptions.maxAccounts must be a positive integer. Set a positive integer or omit it.',
      {
        configField: 'subscriptions.maxAccounts',
      }
    );
  }
  if (dimensions !== undefined) {
    if (
      dimensions.length === 0 ||
      new Set(dimensions).size !== dimensions.length ||
      dimensions.some(value => typeof value !== 'string' || !/^[a-z][a-z0-9_]*$/.test(value))
    ) {
      throw new PlatformConfigError(
        'subscriptions.dimensions must be unique reporting-dimension values. List each standard dimension once, in snake_case.',
        { configField: 'subscriptions.dimensions' }
      );
    }
  }
  return {
    ...(accountConfigurations ? { configuration_task: 'sync_accounts' as const } : {}),
    configuration_tasks: accountConfigurations
      ? (['sync_principal', 'sync_accounts'] as ['sync_principal', 'sync_accounts'])
      : (['sync_principal'] as ['sync_principal']),
    subscriptions: {
      supported: true,
      ...(maxAccounts !== undefined ? { max_accounts: maxAccounts } : {}),
      ...(backfillOnRegrant !== undefined ? { backfill_on_regrant: backfillOnRegrant } : {}),
      ...(dimensions !== undefined
        ? { dimensions: [...dimensions] as NonNullable<ReportingDeliveryCapabilities['subscriptions']>['dimensions'] }
        : {}),
    },
  };
}
