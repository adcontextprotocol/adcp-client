'use strict';

const {
  createAdcpServer,
  createIdempotencyStore,
  InMemoryStateStore,
  memoryBackend,
  registerTestController,
} = require('@adcp/sdk/server/legacy/v5');
const {
  createReportingDeliveryHandler,
  createReportingProducer,
  createReportingStatusHandler,
  createSyncReportingStatusHandler,
  PostgresReportingLedgerStore,
} = require('@adcp/sdk/reporting/ledger');
const {
  createInlineReportingSourceExecutor,
  redactedReportingSourceOfferingV1,
} = require('@adcp/sdk/reporting/source');

function createSimulatedReportingSource(options = {}) {
  const state = {
    mode: 'ready',
    rows: [{ media_buy_id: 'fixture-media-buy', impressions: 10, spend: '1.00' }],
    revision: 1,
    isFinal: false,
  };
  const offering = options.offering ?? structuredClone(redactedReportingSourceOfferingV1);
  const executor = createInlineReportingSourceExecutor(input => {
    if (state.mode === 'not-ready') return null;
    if (state.mode === 'failure') throw new Error('simulated reporting source failure');
    return {
      reporting_period: { start: input.start_date, end: input.end_date },
      currency: 'USD',
      reporting_rows: structuredClone(state.rows),
      data_through: input.end_date,
      observed_at: input.end_date,
      ...(offering.publicationClass === 'AUTHORITATIVE'
        ? { is_final: state.isFinal, notification_type: state.revision === 1 ? 'final' : 'adjusted' }
        : {}),
    };
  }, offering);
  const execute = executor.execute.bind(executor);
  executor.execute = async (...args) => {
    const result = await execute(...args);
    state.lastExecution = result.ok ? { ok: true } : { ok: false, error: result.error };
    return result;
  };
  return {
    executor,
    offering,
    state,
    notReady() {
      state.mode = 'not-ready';
    },
    fail() {
      state.mode = 'failure';
    },
    ready(rows = state.rows) {
      state.mode = 'ready';
      state.rows = structuredClone(rows);
    },
    zero() {
      this.ready([]);
    },
    restate(rows) {
      state.revision += 1;
      this.ready(rows);
    },
    finalize(rows = state.rows) {
      state.isFinal = true;
      this.restate(rows);
    },
  };
}

function createReportingLifecycleReference({ pool, source = createSimulatedReportingSource() }) {
  const store = new PostgresReportingLedgerStore(pool, { acknowledgeIsolatedDatabase: true });
  const producer = createReportingProducer({
    store,
    source: source.executor,
    offerings: [source.offering],
    contact: { name: 'Reporting operations' },
  });
  const resolveConsumerId = context => {
    const credential = context.authInfo?.credential;
    if (credential?.kind === 'api_key' && credential.key_id) return `api_key:${credential.key_id}`;
    if (context.sessionKey) return `session:${context.sessionKey}`;
    throw new TypeError('reporting status requires an authenticated consumer principal');
  };
  const getReportingStatus = createReportingStatusHandler(store, { resolveConsumerId });
  const getMediaBuyDelivery = createReportingDeliveryHandler(store);
  const syncReportingStatus = createSyncReportingStatusHandler(store, { resolveConsumerId });
  const server = createAdcpServer({
    name: 'Reliable Reporting lifecycle reference seller',
    version: '1.0.0',
    stateStore: new InMemoryStateStore(),
    idempotency: createIdempotencyStore({ backend: memoryBackend(), ttlSeconds: 86_400 }),
    resolveAccount: async ref => ({ account_id: ref.account_id }),
    resolveAccountFromAuth: async () => ({ account_id: 'fixture-lifecycle-controller' }),
    mediaBuy: { getReportingStatus, getMediaBuyDelivery, syncReportingStatus },
  });
  const controls = {
    scenarios: ['reporting_core_lifecycle_probe'],
    /**
     * Restate the revision the caller already reported as `received`, so the
     * rc.3 stale-received grace projection is exercisable without waiting on a
     * publication boundary.
     *
     * Mirrors the comply controller's `restate_after_received` operation. The
     * restatement is bound to a *named prior read*: restating into a vacuum
     * would not exercise stale-received at all, because the grace deadline is
     * anchored to the first revision that superseded the one the buyer named.
     * Repeating the operation is convergent — it reports the committed
     * restatement and the same deadline rather than stacking another one, so a
     * seller cannot hold a mismatch below `action_required` by restating on a
     * timer.
     */
    async restateAfterReceived(input) {
      const receivedRevisionId = input?.received_reporting_revision_id;
      if (typeof receivedRevisionId !== 'string' || !receivedRevisionId) {
        throw new TypeError('restate_after_received requires received_reporting_revision_id');
      }
      const advanceTo = input.advance_to ?? 'within_grace';
      if (!['within_grace', 'past_grace'].includes(advanceTo)) {
        throw new RangeError('restate_after_received advance_to must be within_grace or past_grace');
      }
      const obligations = await store.listObligations(input.account_id);
      const obligation =
        obligations.find(candidate => candidate.reporting_obligation_id === input.reporting_obligation_id) ??
        obligations[0];
      if (!obligation) throw new Error('Prepare the reporting fixture before restating a received revision');

      const revisions = await store.listRevisions(obligation.reporting_obligation_id);
      const current = [...revisions].sort((left, right) => right.revisionNumber - left.revisionNumber)[0];
      if (!current) throw new Error('Publish a revision before restating it');
      // Accept either the revision still current, or — on a convergent retry —
      // the one this control already superseded.
      const alreadyRestated = revisions.some(
        revision => revision.supersedes_reporting_revision_id === receivedRevisionId
      );
      if (!alreadyRestated && current.reporting_revision_id !== receivedRevisionId) {
        throw new Error(
          'received_reporting_revision_id must name the revision this caller currently reports as received'
        );
      }

      if (!alreadyRestated) {
        source.restate(input.rows ?? source.state.rows);
        await producer.runWorker({ maxIterations: 4 });
      }

      const afterRestatement = await store.listRevisions(obligation.reporting_obligation_id);
      const firstSuperseding = afterRestatement
        .filter(revision => revision.supersedes_reporting_revision_id === receivedRevisionId)
        .sort(
          (left, right) =>
            Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.revisionNumber - right.revisionNumber
        )[0];
      if (!firstSuperseding) throw new Error('The restated revision is not readable in the fixture ledger');

      // Frozen on the obligation, so later restatements cannot move it.
      const graceMilliseconds =
        obligation.schedule.deliverySlaMilliseconds > 0
          ? obligation.schedule.deliverySlaMilliseconds
          : obligation.schedule.recoveryWindowMilliseconds;
      const graceDeadline = new Date(Date.parse(firstSuperseding.createdAt) + graceMilliseconds).toISOString();
      return {
        success: true,
        simulated: {
          account_id: obligation.account.account_id,
          reporting_obligation_id: obligation.reporting_obligation_id,
          received_reporting_revision_id: receivedRevisionId,
          reporting_revision_id: firstSuperseding.reporting_revision_id,
          supersedes_reporting_revision_id: firstSuperseding.supersedes_reporting_revision_id,
          revision_content_sha256: firstSuperseding.binding.sha256,
          restated_at: firstSuperseding.createdAt,
          stale_received_grace_deadline: graceDeadline,
          // The instant a grader should project the caller-scoped view at to
          // observe each side of the boundary. The store reads `ledger_as_of`
          // from the database clock, so the harness reports the boundary rather
          // than moving the clock underneath a live read.
          project_at:
            advanceTo === 'past_grace'
              ? new Date(Date.parse(graceDeadline) + 1_000).toISOString()
              : firstSuperseding.createdAt,
          expected_mismatch_severity: advanceTo === 'past_grace' ? 'action_required' : 'delayed',
        },
      };
    },
    async reportingCoreLifecycleProbe(input) {
      if (!input || typeof input !== 'object') throw new TypeError('probe input must be an object');
      if (input.operation === 'restate_after_received') return controls.restateAfterReceived(input);
      if (input.operation !== undefined && input.operation !== 'restate_after_received') {
        throw new RangeError('probe operation control is invalid');
      }
      if (
        input.source !== undefined &&
        !['not-ready', 'failure', 'zero', 'ready', 'restate', 'official'].includes(input.source)
      ) {
        throw new RangeError('probe source control is invalid');
      }
      if (input.rows !== undefined && !Array.isArray(input.rows)) throw new TypeError('probe rows must be an array');
      if (input.source === 'not-ready') source.notReady();
      if (input.source === 'failure') source.fail();
      if (input.source === 'zero') source.zero();
      if (input.source === 'ready') source.ready(input.rows ?? source.state.rows);
      if (input.source === 'restate') source.restate(input.rows ?? source.state.rows);
      if (input.source === 'official') source.finalize(input.rows ?? source.state.rows);
      const workerOptions = input.worker_options ? { ...input.worker_options } : undefined;
      if (typeof workerOptions?.now === 'string') {
        const instant = new Date(workerOptions.now);
        if (Number.isNaN(instant.getTime())) throw new RangeError('probe worker_options.now must be an ISO instant');
        workerOptions.now = () => new Date(instant);
      } else if (workerOptions?.now !== undefined && typeof workerOptions.now !== 'function') {
        throw new TypeError('probe worker_options.now must be an ISO instant');
      }
      const worker = input.run_worker ? await producer.runWorker(workerOptions) : undefined;
      return { success: true, simulated: { source: structuredClone(source.state), worker } };
    },
  };
  registerTestController(server, {
    scenarios: controls.scenarios,
    createStore: () => ({
      reportingCoreLifecycleProbe: params => controls.reportingCoreLifecycleProbe(params),
    }),
  });
  return { server, store, producer, source, controls, getReportingStatus, getMediaBuyDelivery };
}

module.exports = { createReportingLifecycleReference, createSimulatedReportingSource };
