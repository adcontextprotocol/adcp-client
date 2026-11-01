/**
 * Reference seller for principal-level reporting subscriptions (experimental
 * `media_buy.reporting_subscriptions`, AdCP 3.3), on the managed path: one `subscriptions` block on
 * the Reliable Reporting service, and a platform that serves `accounts.list` and `getMediaBuys`. The
 * SDK derives the roster, buys, report content and grant journal, reconciles on writes, and plans
 * obligations in `runCycle`. It passes `examples/storyboards/reporting-subscriptions.yaml`.
 *
 * In production pass `storage: postgresStorage({ pool })` from `@adcp/reporting-storage` and a
 * `notifications` runtime in `subscriptions.principal`. `npx adcp reference-seller reporting` serves it.
 */
import { createAdcpServerFromPlatform } from '@adcp/sdk/server';
import { createReliableReportingService } from '@adcp/sdk/reporting/service';
import { redactedReportingSourceOfferingV1 as source } from '@adcp/sdk/reporting/source';
import { memoryStorage } from '@adcp/sdk/storage';
import { offerings } from '@adcp/sdk/testing/reporting';

export const REFERENCE_TENANT = 'reference-seller';
export const REFERENCE_ACCOUNT_ID = 'acct-reference';
const DAY = 86_400_000;

export function createReportingSubscriptionsSeller({
  storage = memoryStorage(),
  now = () => new Date(),
  wrapProtocol = p => p,
} = {}) {
  const day = n => new Date((Math.floor(now().getTime() / DAY) + n) * DAY).toISOString();
  const offering = offerings.dailyAnalytics();
  const account = {
    id: REFERENCE_ACCOUNT_ID,
    name: 'Reference advertiser',
    status: 'active',
    timezone: 'UTC',
    ctx_metadata: {},
  };
  const buy = {
    media_buy_id: 'mb-reference',
    status: 'active',
    currency: 'USD',
    total_budget: 1000,
    revision: 1,
    confirmed_at: day(-3),
    start_time: day(-2),
    end_time: day(30),
    packages: [{ package_id: 'pkg-1', reporting_delivery_offering_ids: [offering.offering_id] }],
  };
  const service = createReliableReportingService({
    storage,
    adapters: {
      reference: {
        sourceOffering: {
          ...source,
          cadence: { ...source.cadence, expectedAvailabilityLag: 'PT0S', worstCaseAvailabilityLag: 'PT0S' },
        },
        deliveryOffering: offering,
        fetchSlice: slice => ({
          reporting_period: { start: slice.start_date, end: slice.end_date },
          currency: 'USD',
          reporting_rows: slice.media_buy_ids.map(media_buy_id => ({ media_buy_id, impressions: 1, spend: '1.00' })),
        }),
      },
    },
    contact: { name: 'Reporting operations', email: 'reporting@reference-seller.example' },
    automatedRecoveryWindowSeconds: 86_400,
    statusRetentionDays: source.retentionDays,
    resolveSource: a => ({
      adapterId: 'reference',
      sourceScope: { network_id: `network-${a.id}` },
      sourceTimezone: 'UTC',
    }),
    resolveCurrency: () => 'USD',
    resolveCoverage: () => ({ constituents: [] }),
    subscriptions: {
      principal: {
        agentUrl: 'https://reference-seller.example/mcp',
        now,
        resolvePrincipal: ctx => ({
          tenant_id: REFERENCE_TENANT,
          principal_id: ctx.callerMutationScope?.principal_id ?? ctx.authInfo.clientId,
          principal_kind: 'buyer_agent',
        }),
      },
      maxAccounts: 100,
      accountConfiguration: false, // principal-level registrations only
      now,
    },
  });
  const platform = service.install({
    capabilities: { specialisms: [], config: {} },
    accounts: {
      resolution: 'explicit',
      resolve: async ref => (ref?.account_id === account.id ? account : null),
      upsert: async () => [],
      list: async () => ({
        items: [{ ...account, authorization: { allowed_tasks: ['get_reporting_status', 'get_media_buys'] } }],
      }),
    },
    sales: { getMediaBuys: async () => ({ media_buys: [buy] }) },
  });
  const createServer = () =>
    createAdcpServerFromPlatform(platform, {
      name: 'reporting-subscriptions-reference-seller',
      version: '1.0.0',
      protocol: wrapProtocol(service.principals.protocol),
      validation: { requests: 'strict', responses: 'strict' },
    });
  return { createServer, service, storage };
}
