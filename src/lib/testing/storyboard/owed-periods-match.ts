/**
 * `check: owed_periods_match` (experimental, `media_buy.reporting_subscriptions`): the storyboard
 * runner computes the periods one reporting subscription owes one account from wire state alone,
 * with the SDK's coverage function, and compares them with the seller's obligations for that
 * subscription in a `get_reporting_status` periods-view response. Defined by the runner contract
 * (`storyboard-schema.yaml`, "Owed periods"):
 *
 * - Before grading, the runner reads as the same caller `get_principal` (paging `prior_versions`),
 *   `list_accounts`, `get_media_buys` and `get_adcp_capabilities`, and takes the subscription's
 *   `subscription_coverage` entry from this response.
 * - `now` is the response's `ledger_as_of`. Periods are kept when they start at or after
 *   `scope.ledger_retained_from` and fall inside the request's `period` when one is set.
 * - It passes when the owed set equals the response's obligations whose `delivery_config_id` is the
 *   subscription id: one per (`delivery_config_version`, `offering_id`, `period.start`,
 *   `period.end`), with the same `media_buy_ids` and `stub` flag, compared as instants. A response
 *   with `pagination.has_more` fails as unverifiable.
 */
import { owedObligationsFromWire } from '../../principal/reporting-reconcile';
import type { StoryboardValidation, ValidationResult } from './types';

type Json = Record<string, unknown>;

/** What the runner computed before grading, per `subscription_id`. */
export type OwedPeriodsComputation =
  | { kind: 'computed'; expected: OwedKey[]; observed: OwedKey[] }
  | { kind: 'unverifiable'; error: string };

export interface OwedKey {
  delivery_config_version: number;
  offering_id: string | null;
  period_start: string;
  period_end: string;
  media_buy_ids: string[];
  stub: boolean;
}

const CHECK = 'owed_periods_match';

const instant = (value: unknown): string | null => {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const identity = (key: OwedKey): string =>
  JSON.stringify([key.delivery_config_version, key.offering_id, key.period_start, key.period_end]);

/** Whether a step's request is the periods view for one account, which the check needs. */
function periodsViewAccount(taskName: string, request: Json | undefined): string | undefined {
  if (taskName !== 'get_reporting_status' || request?.view !== 'periods') return undefined;
  const account = request.account as Json | undefined;
  return typeof account?.account_id === 'string' ? account.account_id : undefined;
}

/**
 * Compute every `owed_periods_match` check on a step before the synchronous validators run. Returns
 * `undefined` when the step has none.
 */
export async function prefetchOwedPeriods(
  taskName: string,
  validations: readonly StoryboardValidation[],
  call: (task: string, params: Json) => Promise<{ success: boolean; data?: unknown; error?: string }>,
  request: Json | undefined,
  response: unknown
): Promise<Map<string, OwedPeriodsComputation> | undefined> {
  const checks = validations.filter(item => item.check === CHECK);
  if (checks.length === 0) return undefined;
  const results = new Map<string, OwedPeriodsComputation>();
  const accountId = periodsViewAccount(taskName, request);
  const body = (response ?? {}) as Json;
  for (const check of checks) {
    const subscriptionId = (check as { subscription_id?: unknown }).subscription_id;
    if (typeof subscriptionId !== 'string' || results.has(subscriptionId)) continue;
    const fail = (error: string) => results.set(subscriptionId, { kind: 'unverifiable', error });
    if (!accountId) {
      fail(`${CHECK} applies only to get_reporting_status steps with view: periods for one account_id`);
      continue;
    }
    if ((body.pagination as Json | undefined)?.has_more === true) {
      fail('the periods view has more pages (pagination.has_more); request a page large enough for the window');
      continue;
    }
    const asOf = instant(body.ledger_as_of);
    if (!asOf) {
      fail('the response carries no ledger_as_of to evaluate the owed set at');
      continue;
    }
    const coverage = ((body.subscription_coverage as Json[] | undefined) ?? []).find(
      entry => entry.subscription_id === subscriptionId
    );
    const retainedFrom = instant((body.scope as Json | undefined)?.ledger_retained_from);
    const window = request?.period as { start?: string; end?: string } | undefined;
    const from = instant(window?.start);
    const until = instant(window?.end);
    const keep = (start: string, end: string) =>
      (retainedFrom === null || start >= retainedFrom) &&
      (from === null || start >= from) &&
      (until === null || end <= until);
    try {
      const owed = await owedObligationsFromWire(
        {
          getPrincipal: params => call('get_principal', params ?? {}) as never,
          listAccounts: params => call('list_accounts', params) as never,
          getAdcpCapabilities: params => call('get_adcp_capabilities', params) as never,
          getMediaBuys: params => call('get_media_buys', params) as never,
        },
        { accountId, subscriptionId, now: asOf, ...(coverage ? { coverage } : {}) }
      );
      const expected = owed
        .map(item => ({
          delivery_config_version: item.subscription_version,
          offering_id: item.offering_id,
          period_start: instant(item.period_start)!,
          period_end: instant(item.period_end)!,
          media_buy_ids: [...item.media_buy_ids].sort(),
          stub: item.stub === true,
        }))
        .filter(item => keep(item.period_start, item.period_end));
      const observed = ((body.periods as Json[] | undefined) ?? [])
        .filter(item => item.delivery_config_id === subscriptionId)
        .map(item => {
          const period = (item.period ?? {}) as Json;
          return {
            delivery_config_version: Number(item.delivery_config_version),
            offering_id: typeof item.offering_id === 'string' ? item.offering_id : null,
            period_start: instant(period.start) ?? String(period.start),
            period_end: instant(period.end) ?? String(period.end),
            media_buy_ids: [...((item.media_buy_ids as string[] | undefined) ?? [])].sort(),
            stub: item.stub === true,
          };
        })
        .filter(item => keep(item.period_start, item.period_end));
      results.set(subscriptionId, { kind: 'computed', expected, observed });
    } catch (error) {
      fail(`could not compute the owed set from wire state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return results;
}

/** Grade one `owed_periods_match` check from the prefetched computation. */
export function validateOwedPeriodsMatch(
  validation: StoryboardValidation,
  computations: Map<string, OwedPeriodsComputation> | undefined
): ValidationResult {
  const base = { check: CHECK, description: validation.description ?? 'Owed periods match the obligations' };
  const subscriptionId = (validation as { subscription_id?: unknown }).subscription_id;
  if (typeof subscriptionId !== 'string' || subscriptionId.length === 0) {
    return { ...base, passed: false, error: `${CHECK} requires subscription_id` } as ValidationResult;
  }
  const computed = computations?.get(subscriptionId);
  if (!computed) {
    return { ...base, passed: false, error: `${CHECK} was not computed for this step` } as ValidationResult;
  }
  if (computed.kind === 'unverifiable') {
    return { ...base, passed: false, error: computed.error } as ValidationResult;
  }
  const observedBy = new Map<string, OwedKey[]>();
  for (const item of computed.observed) {
    observedBy.set(identity(item), [...(observedBy.get(identity(item)) ?? []), item]);
  }
  const expectedBy = new Map(computed.expected.map(item => [identity(item), item]));
  const missing = computed.expected.filter(item => !observedBy.has(identity(item)));
  const extra = computed.observed.filter(item => !expectedBy.has(identity(item)));
  const duplicated = [...observedBy.values()].filter(items => items.length > 1).map(items => items[0]!);
  const mismatched = computed.expected.flatMap(item => {
    const seen = observedBy.get(identity(item))?.[0];
    if (!seen) return [];
    const problems: string[] = [];
    if (JSON.stringify(seen.media_buy_ids) !== JSON.stringify(item.media_buy_ids)) {
      problems.push(`media_buy_ids ${JSON.stringify(seen.media_buy_ids)}, owed ${JSON.stringify(item.media_buy_ids)}`);
    }
    if (seen.stub !== item.stub) problems.push(`stub ${seen.stub}, owed ${item.stub}`);
    return problems.length > 0 ? [`${describe(item)}: ${problems.join('; ')}`] : [];
  });
  const passed = missing.length === 0 && extra.length === 0 && duplicated.length === 0 && mismatched.length === 0;
  if (passed) return { ...base, passed: true } as ValidationResult;
  const parts = [
    missing.length > 0 ? `missing ${missing.length}: ${missing.slice(0, 5).map(describe).join(', ')}` : '',
    extra.length > 0 ? `extra ${extra.length}: ${extra.slice(0, 5).map(describe).join(', ')}` : '',
    duplicated.length > 0 ? `duplicated: ${duplicated.slice(0, 5).map(describe).join(', ')}` : '',
    mismatched.length > 0 ? `different: ${mismatched.slice(0, 5).join('; ')}` : '',
  ].filter(Boolean);
  return {
    ...base,
    passed: false,
    error: `The seller's obligations for ${subscriptionId} differ from the owed set computed from wire state (${parts.join('; ')}).`,
    expected: computed.expected,
    actual: computed.observed,
  } as ValidationResult;
}

function describe(key: OwedKey): string {
  return `v${key.delivery_config_version} ${key.offering_id ?? '-'} [${key.period_start}, ${key.period_end})${key.stub ? ' stub' : ''}`;
}
