/**
 * `adcp reporting doctor`: checks a seller's reporting-subscription wiring from the wire, as a buyer
 * sees it, and names a fix for every failure (experimental, AdCP 3.3).
 *
 * @experimental
 */
type Json = Record<string, unknown>;
type Task = (params: Json) => Promise<{ success: boolean; data?: unknown; error?: string }>;

/** The client calls the doctor makes. `AgentClient` has them all. */
export interface ReportingDoctorClient {
  getAdcpCapabilities?: Task;
  getPrincipal?: Task;
  listAccounts?: Task;
  getMediaBuys?: Task;
  complyTestController?: Task;
}

/** One check. `warn` never fails the run; `fail` does. */
export interface ReportingDoctorCheck {
  id: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  /** What to change, when the check did not pass. */
  fix?: string;
}

export interface ReportingDoctorReport {
  ok: boolean;
  checks: ReportingDoctorCheck[];
}

const IANA = (value: unknown): boolean => {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

async function read(task: Task | undefined, name: string, params: Json): Promise<Json> {
  if (!task) throw new Error(`the client has no ${name} method`);
  const result = await task(params);
  if (!result.success || !result.data) throw new Error(`${name} failed: ${result.error ?? 'no response'}`);
  return result.data as Json;
}

/**
 * Run every check. Never throws for a seller problem: each one is a `fail` with its fix.
 *
 * @experimental
 */
export async function runReportingDoctor(client: ReportingDoctorClient): Promise<ReportingDoctorReport> {
  const checks: ReportingDoctorCheck[] = [];
  const add = (check: ReportingDoctorCheck) => checks.push(check);

  // 1. Capabilities: offerings with standard_dimensions, subscriptions, retention.
  let accountsToProbe: Json[] = [];
  try {
    const capabilities = await read(client.getAdcpCapabilities?.bind(client), 'get_adcp_capabilities', {});
    const delivery = ((capabilities.media_buy as Json | undefined)?.reporting_delivery ?? {}) as Json;
    const offerings = (delivery.offerings as Json[] | undefined) ?? [];
    const subscribable = offerings.filter(item => Array.isArray(item.standard_dimensions));
    if (offerings.length === 0) {
      add({
        id: 'capabilities.offerings',
        status: 'fail',
        message: 'get_adcp_capabilities advertises no media_buy.reporting_delivery offerings.',
        fix: 'Pass adapters (one per offering) to createReliableReportingService and install it on the platform.',
      });
    } else if (subscribable.length === 0) {
      add({
        id: 'capabilities.offerings',
        status: 'fail',
        message: `None of the ${offerings.length} offerings declares standard_dimensions, so no subscription selector can match.`,
        fix: 'Publish standard_dimensions on each offering a subscription may select (SUBSCRIPTIONS_REQUIRE_STANDARD_DIMENSIONS).',
      });
    } else {
      add({
        id: 'capabilities.offerings',
        status: 'pass',
        message: `${subscribable.length} subscribable offering(s): ${subscribable.map(item => item.offering_id).join(', ')}.`,
      });
    }
    if (!delivery.subscriptions) {
      add({
        id: 'capabilities.subscriptions',
        status: 'fail',
        message: 'media_buy.reporting_delivery.subscriptions is absent: buyers cannot discover subscription support.',
        fix: 'Add the subscriptions block to createReliableReportingService; the service advertises it.',
      });
    } else {
      add({ id: 'capabilities.subscriptions', status: 'pass', message: 'Subscriptions are advertised.' });
    }
    add(
      typeof delivery.status_retention_days === 'number'
        ? {
            id: 'capabilities.retention',
            status: 'pass',
            message: `status_retention_days is ${delivery.status_retention_days}.`,
          }
        : {
            id: 'capabilities.retention',
            status: 'warn',
            message: 'status_retention_days is not advertised; buyers cannot tell when a re-grant continues a chain.',
            fix: 'Set statusRetentionDays on createReliableReportingService.',
          }
    );
  } catch (error) {
    add({
      id: 'capabilities',
      status: 'fail',
      message: `get_adcp_capabilities could not be read: ${(error as Error).message}.`,
      fix: 'Check the agent URL and credentials.',
    });
  }

  // 2. The principal lifecycle.
  try {
    await read(client.getPrincipal?.bind(client), 'get_principal', {});
    add({ id: 'principal', status: 'pass', message: 'get_principal answers.' });
  } catch (error) {
    add({
      id: 'principal',
      status: 'fail',
      message: `get_principal failed: ${(error as Error).message}.`,
      fix: 'Pass subscriptions.principal (resolvePrincipal) to createReliableReportingService; it installs get_principal and sync_principal.',
    });
  }

  // 3. The roster: every account needs an IANA timezone and an authorization.authorized_at.
  try {
    const listed = await read(client.listAccounts?.bind(client), 'list_accounts', {});
    const accounts = (listed.accounts as Json[] | undefined) ?? [];
    accountsToProbe = accounts.slice(0, 3);
    const noZone = accounts.filter(item => !IANA(item.timezone));
    const noGrant = accounts.filter(
      item => typeof (item.authorization as Json | undefined)?.authorized_at !== 'string'
    );
    if (accounts.length === 0) {
      add({
        id: 'accounts',
        status: 'warn',
        message: 'list_accounts lists no account for this caller, so nothing can be covered.',
        fix: 'Grant the caller an account, or check that accounts.list returns the principal’s accounts.',
      });
    } else {
      add(
        noZone.length > 0
          ? {
              id: 'accounts.timezone',
              status: 'fail',
              message: `${noZone.length} account(s) have no IANA timezone (${noZone
                .slice(0, 5)
                .map(item => item.account_id)
                .join(', ')}); their subscriptions are isolated with COVERAGE_INPUT_INCOMPLETE.`,
              fix: 'Return Account.timezone (IANA) from accounts.list; the SDK never defaults a zone.',
            }
          : { id: 'accounts.timezone', status: 'pass', message: `${accounts.length} account(s) carry a timezone.` }
      );
      add(
        noGrant.length > 0
          ? {
              id: 'accounts.authorization',
              status: 'fail',
              message: `${noGrant.length} account(s) have no authorization.authorized_at; coverage cannot start.`,
              fix: 'Report grants to the SDK (service.grants) so it projects authorization.authorized_at onto list_accounts.',
            }
          : {
              id: 'accounts.authorization',
              status: 'pass',
              message: 'Every account carries authorization.authorized_at.',
            }
      );
    }
  } catch (error) {
    add({
      id: 'accounts',
      status: 'fail',
      message: `list_accounts failed: ${(error as Error).message}.`,
      fix: 'Implement accounts.list on the platform; the subscription roster derives from it (SUBSCRIPTION_ROSTER_UNAVAILABLE).',
    });
  }

  // 4. Buys, on a sample account.
  for (const account of accountsToProbe.slice(0, 1)) {
    try {
      const data = await read(client.getMediaBuys?.bind(client), 'get_media_buys', {
        account: { account_id: account.account_id },
      });
      const buys = (data.media_buys as Json[] | undefined) ?? [];
      const unlisted = buys.filter(buy =>
        ((buy.packages as Json[] | undefined) ?? []).some(pkg => !Array.isArray(pkg.reporting_delivery_offering_ids))
      );
      add(
        unlisted.length > 0
          ? {
              id: 'buys.offerings',
              status: 'warn',
              message: `${unlisted.length} buy(s) on ${String(account.account_id)} have packages without reporting_delivery_offering_ids; the spec default (every offering) applies.`,
              fix: 'Return packages[].reporting_delivery_offering_ids from getMediaBuys when packages report through a subset.',
            }
          : {
              id: 'buys',
              status: 'pass',
              message: `get_media_buys answers for ${String(account.account_id)} (${buys.length} buy(s)).`,
            }
      );
    } catch (error) {
      add({
        id: 'buys',
        status: 'fail',
        message: `get_media_buys failed for ${String(account.account_id)}: ${(error as Error).message}.`,
        fix: 'Implement sales.getMediaBuys; owed periods derive from each buy’s confirmed_at and flight.',
      });
    }
  }

  // 5. The conformance probe (advisory).
  try {
    const listed = await read(client.complyTestController?.bind(client), 'comply_test_controller', {
      scenario: 'list_scenarios',
    });
    const scenarios = (listed.scenarios as string[] | undefined) ?? [];
    add(
      scenarios.includes('reporting_subscription_probe')
        ? {
            id: 'controller.probe',
            status: 'pass',
            message: 'comply_test_controller advertises reporting_subscription_probe.',
          }
        : {
            id: 'controller.probe',
            status: 'warn',
            message:
              'comply_test_controller does not advertise reporting_subscription_probe, so grant and time storyboards grade not_applicable.',
            fix: 'Wire complyTest.reportingSubscriptionProbe in sandbox deployments.',
          }
    );
  } catch {
    add({
      id: 'controller.probe',
      status: 'warn',
      message: 'No comply_test_controller for this caller: grant and time storyboards grade not_applicable.',
      fix: 'Wire complyTest with reportingSubscriptionProbe for sandbox principals.',
    });
  }

  return { ok: checks.every(check => check.status !== 'fail'), checks };
}
