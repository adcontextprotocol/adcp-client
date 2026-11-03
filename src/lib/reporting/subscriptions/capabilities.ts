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

/**
 * One offering that breaks a rule a seller must satisfy before it advertises reporting subscriptions,
 * with the frozen code from the spec's `error-codes.json`.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export type ReportingSubscriptionOfferingCheckFailureV1 =
  | { code: 'SUBSCRIPTIONS_REQUIRE_STANDARD_DIMENSIONS'; offering_id: string }
  | { code: 'SUBSCRIPTIONS_REQUIRE_ACCOUNT_ID_KEY'; offering_id: string; missing: 'primary_key' | 'row_schema' };

/**
 * The seller-side offering checks for reporting subscriptions (the spec's `offering-checks.json`
 * vectors, adcp#8718). Returns every failure, in offering order and, per offering:
 *
 * 1. `SUBSCRIPTIONS_REQUIRE_STANDARD_DIMENSIONS`: the offering publishes no `standard_dimensions`.
 * 2. `SUBSCRIPTIONS_REQUIRE_ACCOUNT_ID_KEY`, `missing: 'primary_key'`: a managed-delivery offering
 *    (one with `method`) whose `reporting_profile.primary_keys` lacks `account_id`.
 * 3. `SUBSCRIPTIONS_REQUIRE_ACCOUNT_ID_KEY`, `missing: 'row_schema'`: its row schema, when
 *    `rowSchemas` has the one for `reporting_profile.schema_uri`, does not declare `account_id` as
 *    a required string property. A schema not supplied is not checked.
 *
 * Core offerings (no `method`) are exempt from the `account_id` rule. Empty means the offerings pass.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function checkReportingSubscriptionOfferingsV1(
  offerings: ReadonlyArray<{
    offering_id: string;
    standard_dimensions?: readonly string[] | undefined;
    method?: unknown;
    reporting_profile?: { schema_uri?: string; primary_keys?: readonly string[] } | undefined;
  }>,
  rowSchemas: Readonly<Record<string, unknown>> = {}
): ReportingSubscriptionOfferingCheckFailureV1[] {
  const failures: ReportingSubscriptionOfferingCheckFailureV1[] = [];
  for (const offering of offerings) {
    if (!Array.isArray(offering.standard_dimensions)) {
      failures.push({ code: 'SUBSCRIPTIONS_REQUIRE_STANDARD_DIMENSIONS', offering_id: offering.offering_id });
    }
    if (offering.method === undefined) continue;
    const profile = offering.reporting_profile ?? {};
    if (!(profile.primary_keys ?? []).includes('account_id')) {
      failures.push({
        code: 'SUBSCRIPTIONS_REQUIRE_ACCOUNT_ID_KEY',
        offering_id: offering.offering_id,
        missing: 'primary_key',
      });
    }
    const rowSchema =
      profile.schema_uri !== undefined && Object.prototype.hasOwnProperty.call(rowSchemas, profile.schema_uri)
        ? rowSchemas[profile.schema_uri]
        : undefined;
    if (rowSchema !== undefined && !declaresRequiredString(rowSchema, 'account_id')) {
      failures.push({
        code: 'SUBSCRIPTIONS_REQUIRE_ACCOUNT_ID_KEY',
        offering_id: offering.offering_id,
        missing: 'row_schema',
      });
    }
  }
  return failures;
}

function declaresRequiredString(schema: unknown, name: string): boolean {
  const object = schema as { required?: unknown; properties?: Record<string, { type?: unknown } | undefined> } | null;
  return (
    Array.isArray(object?.required) &&
    object.required.includes(name) &&
    object.properties?.[name]?.type === 'string'
  );
}
