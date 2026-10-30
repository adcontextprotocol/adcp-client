/**
 * Grants and reporting subscriptions (experimental `media_buy.reporting_subscriptions`, AdCP 3.3),
 * through the real server dispatch. Access means access: a full revocation makes the account
 * unknown to every task, receipts and statuses included. A reduced reconciliation grant keeps
 * statuses (and receipts) and coverage, because it still lists get_reporting_status; a grant
 * without get_reporting_status ends coverage like a loss of authority.
 */
const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

process.env.NODE_ENV = 'test';

const { createReliableReportingService } = require('../../dist/lib/reporting/service/index.js');
const {
  createInMemoryReportingSubscriptionEngineStoreV1,
  createReportingSubscriptionEngineV1,
  reportingSubscriptionCoverageGrantedV1,
} = require('../../dist/lib/reporting/advanced/index.js');
const {
  createSyncReportingReceiptsHandler,
  reportingSubscriptionReceiptAdmissibleV1,
} = require('../../dist/lib/reporting/ledger/index.js');
const {
  redactedReportingSourceOfferingV1,
  redactedReportingSourceRequestV1,
} = require('../../dist/lib/reporting/source/index.js');
const { createAdcpServerFromPlatform } = require('../../dist/lib/server/decisioning/runtime/from-platform.js');
const { MemoryLedgerStore } = require('../helpers/memory-reporting-ledger-store.js');
const { createTestPrincipalLifecycle } = require('../helpers/principal-runtime.js');

const DAY = 86_400_000;
const ACCOUNT = 'account-a';
const TENANT = 'tenant-1';
const A = { tenantId: TENANT, principalId: 'principal-a' };
const B = { tenantId: TENANT, principalId: 'principal-b' };
const CLIENTS = { 'buyer-a': A, 'buyer-b': B };
const offeringId = redactedReportingSourceOfferingV1.offeringId;

function deliveryOffering() {
  const source = redactedReportingSourceOfferingV1;
  return {
    offering_id: source.offeringId,
    feed_purpose: 'analytics',
    report_definition_id: source.contract.report_definition_id,
    report_definition_uri: source.contract.reportDefinitionUri,
    report_definition_sha256: source.contract.reportDefinitionSha256,
    reporting_profile: {
      id: source.contract.reportingProfile,
      version: source.contract.schemaVersion,
      schema_uri: source.contract.schemaUri,
      schema_sha256: source.contract.schemaSha256,
      schema_dialect: source.contract.schemaDialect,
      schema_ref_policy: source.contract.schemaRefPolicy,
      grain: source.grain,
      primary_keys: ['media_buy_id'],
    },
    schedule: { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'PT0S' },
    supported_finality: ['snapshot'],
    reconciliation_mode: 'delivery_only',
    standard_dimensions: [],
  };
}

async function world() {
  const origin = Math.floor(Date.now() / DAY) * DAY - 10 * DAY;
  const day = n => new Date(origin + n * DAY).toISOString();
  const clock = { now: new Date(day(0.5)) };
  const { lifecycle } = createTestPrincipalLifecycle({ clock, reportingSubscriptions: {} });
  let key = 0;
  for (const principal of [A, B]) {
    const response = await lifecycle.protocol.syncPrincipal(
      {
        idempotency_key: `subscription-post-loss-${String(++key).padStart(4, '0')}`,
        configuration: {
          reporting_subscriptions: [
            {
              subscription_id: 'analytics-daily',
              subscription_version: 1,
              active: true,
              scope: { all_authorized_accounts: true },
              selector: { feed_purpose: 'analytics', period_duration: 'P1D', required_finality: 'snapshot' },
              reconciliation_mode: 'delivery_only',
            },
          ],
        },
      },
      {
        callerMutationScope: { tenant_id: TENANT, principal_id: principal.principalId, principal_kind: 'buyer_agent' },
      }
    );
    assert.equal(response.result.kind, 'applied', JSON.stringify(response));
  }
  // The seller's grants: absent from the map means revoked; `undefined` tasks means unrestricted.
  const grants = new Map([
    ['principal-a', undefined],
    ['principal-b', undefined],
  ]);
  const permits = (principalId, task) =>
    grants.has(principalId) && (grants.get(principalId) === undefined || grants.get(principalId).includes(task));
  const engine = createReportingSubscriptionEngineV1({
    principal: lifecycle,
    offerings: [deliveryOffering()],
    store: createInMemoryReportingSubscriptionEngineStoreV1(),
    statusRetentionDays: redactedReportingSourceOfferingV1.retentionDays,
    now: () => clock.now,
    hooks: {
      listAuthorizedAccounts: principal => ({
        accounts: grants.has(principal.principalId)
          ? [
              {
                account_id: ACCOUNT,
                authorized_at: new Date(origin - 30 * DAY).toISOString(),
                ...(grants.get(principal.principalId) ? { allowed_tasks: grants.get(principal.principalId) } : {}),
              },
            ]
          : [],
      }),
      listAccountBuys: principal => [
        {
          media_buy_id: `mb-${principal.principalId}`,
          confirmed_at: day(1.5),
          start_time: day(3),
          end_time: day(4),
          packages: [{ package_id: 'pkg', reporting_delivery_offering_ids: [offeringId] }],
        },
      ],
      resolveRevocationInstant: (_principal, _account, input) => input.observedAt,
      isPeriodDelivered: () => false,
    },
  });
  const request = redactedReportingSourceRequestV1();
  const [template] = request.coverage.constituents;
  const constituent = mediaBuyId => ({
    ...structuredClone(template),
    constituentId: `constituent-${mediaBuyId}`,
    mediaBuyId,
    productBinding: { ...structuredClone(template.productBinding), mediaBuyId, bindingId: `binding-${mediaBuyId}` },
  });
  const sourceOffering = structuredClone(redactedReportingSourceOfferingV1);
  sourceOffering.cadence = {
    ...sourceOffering.cadence,
    expectedAvailabilityLag: 'PT0S',
    worstCaseAvailabilityLag: 'PT0S',
  };
  const store = new MemoryLedgerStore();
  const { currency: _currency, ...sourceSettings } = request.sourceSettings;
  const principalOf = context => CLIENTS[context.authInfo?.clientId];
  const service = createReliableReportingService({
    store,
    adapters: {
      fixture: {
        sourceOffering,
        deliveryOffering: deliveryOffering(),
        fetchSlice: slice => ({
          reporting_period: { start: slice.start_date, end: slice.end_date },
          currency: 'USD',
          reporting_rows: slice.media_buy_ids.map(mediaBuyId => ({
            media_buy_id: mediaBuyId,
            impressions: 1,
            spend: '1.00',
          })),
        }),
      },
    },
    contact: { name: 'Reporting operations', email: 'reporting@example.com' },
    automatedRecoveryWindowSeconds: 86_400,
    statusRetentionDays: redactedReportingSourceOfferingV1.retentionDays,
    resolveSource: account => ({
      adapterId: 'fixture',
      sourceScope: { network_id: `network-${account.id}` },
      sourceTimezone: 'UTC',
    }),
    resolveCurrency: () => 'USD',
    resolveCoverage: () => ({ constituents: ['mb-principal-a', 'mb-principal-b'].map(constituent) }),
    resolveConsumerId: context => context.authInfo.clientId,
    subscriptions: {
      engine,
      resolvePrincipal: principalOf,
      listSubscriptionPrincipals: () => [A, B],
      resolveSubscriptionConfiguration: () => ({
        requestedMetrics: request.requestedMetrics,
        requestedDimensions: request.requestedDimensions,
        sourceSettings,
      }),
    },
  });
  const platform = service.install({
    capabilities: { specialisms: [], config: {}, principal: lifecycle.capabilities },
    accounts: {
      resolution: 'explicit',
      // The seller's own resolver enforces its grants per task: no grant for the task, no account.
      resolve: async (ref, ctx) =>
        ref?.account_id === ACCOUNT && permits(principalOf(ctx)?.principalId, ctx.toolName)
          ? { id: ACCOUNT, name: 'Account A', status: 'active', ctx_metadata: {} }
          : null,
      upsert: async () => [],
    },
  });
  const server = createAdcpServerFromPlatform(platform, {
    name: 'reporting-subscription-post-loss',
    version: '1.0.0',
    protocol: lifecycle.protocol,
    validation: { requests: 'strict', responses: 'strict' },
  });
  const call = (clientId, name, args) =>
    server.dispatchTestRequest(
      { method: 'tools/call', params: { name, arguments: { account: { account_id: ACCOUNT }, ...args } } },
      { authInfo: { clientId } }
    );
  clock.now = new Date();
  await engine.reconcile(A);
  await engine.reconcile(B);
  const cycle = await service.runCycle({ accountId: ACCOUNT });
  assert.equal(cycle.revisionsCommitted, 2, JSON.stringify(cycle));
  const revisionOf = principal =>
    [...store.revisions.values()].find(
      value => store.obligations.get(value.reporting_obligation_id).subscription.principalId === principal.principalId
    );
  const statusFor = (principal, id) => {
    const revision = revisionOf(principal);
    const obligation = store.obligations.get(revision.reporting_obligation_id);
    return {
      reporting_status_id: `post-loss-status-${id}`,
      delivery_config_id: 'analytics-daily',
      delivery_config_version: 1,
      report_definition_id: obligation.report_definition_id,
      reporting_obligation_id: obligation.reporting_obligation_id,
      reporting_revision_id: revision.reporting_revision_id,
      observed_revision_content_sha256: revision.wireRevision.revision_content_sha256,
      period: {
        start: obligation.period.start,
        end: obligation.period.end,
        source_timezone: obligation.period.sourceTimezone,
      },
      consumer_status: 'received',
      status_as_of: new Date().toISOString(),
    };
  };
  const syncStatus = (clientId, status) =>
    call(clientId, 'sync_reporting_status', {
      idempotency_key: `post-loss-batch-${status.reporting_status_id}`,
      statuses: [status],
    });
  const reconcileAt = async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    clock.now = new Date();
    await engine.reconcile(A);
  };
  return {
    clock,
    engine,
    lifecycle,
    service,
    store,
    server,
    call,
    syncStatus,
    statusFor,
    revisionOf,
    grants,
    reconcileAt,
  };
}

const RECONCILIATION = ['get_reporting_status', 'sync_reporting_receipts', 'sync_reporting_status'];
const unauthorizedOf = async (lifecycle, principal) =>
  (await lifecycle.listReportingSubscriptions(principal)).states[0].accounts_unauthorized ?? [];

describe('grants and reporting subscriptions', () => {
  test('a reduced reconciliation grant keeps statuses and coverage', async () => {
    const { engine, lifecycle, syncStatus, statusFor, grants, reconcileAt, call } = await world();
    grants.set('principal-a', RECONCILIATION);
    await reconcileAt();
    const accepted = await syncStatus('buyer-a', statusFor(A, 'reduced-grant-status-1'));
    assert.notEqual(accepted.isError, true, JSON.stringify(accepted.structuredContent));
    assert.equal(accepted.structuredContent.results[0].result, 'recorded', JSON.stringify(accepted.structuredContent));
    assert.equal((await engine.subscriptionCoverage(A, ACCOUNT)).length, 1, 'coverage continues');
    assert.equal(await engine.isAuthorized(A, ACCOUNT), true);
    assert.deepEqual(await unauthorizedOf(lifecycle, A), []);
    const read = await call('buyer-a', 'get_reporting_status', { view: 'summary' });
    assert.notEqual(read.isError, true, JSON.stringify(read.structuredContent));
    // A task the grant leaves out is refused by the seller's own resolver.
    const refused = await call('buyer-a', 'get_media_buy_delivery', { reporting_revision_id: 'unused' });
    assert.equal(
      refused.structuredContent.adcp_error?.code ?? refused.structuredContent.errors?.[0]?.code,
      'ACCOUNT_NOT_FOUND'
    );
  });

  test('a full revocation makes the account unknown to statuses too', async () => {
    const { engine, lifecycle, syncStatus, statusFor, grants, reconcileAt } = await world();
    grants.delete('principal-a');
    await reconcileAt();
    const refused = await syncStatus('buyer-a', statusFor(A, 'revoked-grant-status1'));
    assert.equal(
      refused.structuredContent.adcp_error?.code ?? refused.structuredContent.errors?.[0]?.code,
      'ACCOUNT_NOT_FOUND',
      JSON.stringify(refused.structuredContent)
    );
    assert.equal(await engine.isAuthorized(A, ACCOUNT), false);
    assert.equal((await unauthorizedOf(lifecycle, A)).length, 1);
  });

  test('a grant without get_reporting_status ends coverage like a loss of authority', async () => {
    const { engine, lifecycle, syncStatus, statusFor, grants, reconcileAt } = await world();
    grants.set('principal-a', ['sync_reporting_status']);
    await reconcileAt();
    assert.equal(await engine.isAuthorized(A, ACCOUNT), false);
    assert.deepEqual(await engine.subscriptionCoverage(A, ACCOUNT), []);
    const [lost] = await unauthorizedOf(lifecycle, A);
    assert.equal(lost.account_id, ACCOUNT);
    // The seller still lets the status through by its grant; the obligation stays the owner's.
    const accepted = await syncStatus('buyer-a', statusFor(A, 'status-only-grant-001'));
    assert.equal(accepted.structuredContent.results[0].result, 'recorded', JSON.stringify(accepted.structuredContent));
    // B, with an unrestricted grant, is unaffected; and B cannot report on A's obligation.
    assert.equal(await engine.isAuthorized(B, ACCOUNT), true);
    const foreign = await syncStatus('buyer-b', statusFor(A, 'foreign-obligation-01'));
    assert.equal(foreign.structuredContent.results[0].result, 'failed', JSON.stringify(foreign.structuredContent));
  });

  test('the coverage grant rule and the receipt admission rule', async () => {
    assert.equal(reportingSubscriptionCoverageGrantedV1({}), true, 'no task restriction is every task');
    assert.equal(reportingSubscriptionCoverageGrantedV1({ allowed_tasks: RECONCILIATION }), true);
    assert.equal(reportingSubscriptionCoverageGrantedV1({ allowed_tasks: ['sync_reporting_receipts'] }), false);
    const owned = { subscription: { ...A, subscriptionId: 's', offeringId: 'o', ownership: 'owed_set' } };
    assert.equal(reportingSubscriptionReceiptAdmissibleV1({ obligation: owned }), true, 'subscriptions off: unscoped');
    assert.equal(reportingSubscriptionReceiptAdmissibleV1({ obligation: {}, admission: { principal: B } }), true);
    assert.equal(reportingSubscriptionReceiptAdmissibleV1({ obligation: owned, admission: { principal: B } }), false);
    assert.equal(reportingSubscriptionReceiptAdmissibleV1({ obligation: owned, admission: { principal: A } }), true);
    // The receipt handler sends the caller's principal to a store that enforces it.
    const seen = [];
    const store = { receiptAdmission: true, syncReceiptBatch: async input => (seen.push(input.admission), []) };
    assert.throws(() =>
      createSyncReportingReceiptsHandler({ syncReceiptBatch: async () => [] }, () => 'consumer', undefined, {
        resolveSubscriptionPrincipal: () => A,
      })
    );
    const handler = createSyncReportingReceiptsHandler(store, () => 'buyer-a', undefined, {
      resolveSubscriptionPrincipal: () => A,
    });
    await handler(
      {
        idempotency_key: 'receipt-grant-batch-0001',
        receipts: [
          {
            reporting_receipt_id: 'receipt-grant-00000001',
            reporting_obligation_id: 'obligation-1',
            reporting_revision_id: 'revision-1',
            reporting_materialization_id: 'materialization-1',
            status: 'accepted',
            verification_profile: 'canonical_digest',
            observed_row_count: 1,
            observed_control_totals: [{ name: 'impressions', value: '4', value_type: 'integer', unit: 'impressions' }],
            observed_canonical_content_digest: {
              algorithm: 'sha256',
              value: '6'.repeat(64),
              canonicalization_id: 'analytics-rows-v1',
              canonicalization_uri: 'https://schemas.fixture.example/canonicalization.json',
              canonicalization_sha256: 'c'.repeat(64),
            },
            observed_manifest_sha256: 'f'.repeat(64),
            observed_at: '2026-09-30T00:00:00.000Z',
          },
        ],
      },
      { account: { id: ACCOUNT } }
    );
    assert.deepEqual(seen, [{ principal: A }]);
  });
});
