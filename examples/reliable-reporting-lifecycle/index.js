'use strict';

const { createAdcpServer, InMemoryStateStore, registerTestController } = require('@adcp/sdk/server/legacy/v5');
const {
  createReportingDeliveryHandler,
  createReportingProducer,
  createReportingStatusHandler,
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
  const getReportingStatus = createReportingStatusHandler(store);
  const getMediaBuyDelivery = createReportingDeliveryHandler(store);
  const server = createAdcpServer({
    name: 'Reliable Reporting lifecycle reference seller',
    version: '1.0.0',
    stateStore: new InMemoryStateStore(),
    resolveAccount: async ref => ({ account_id: ref.account_id }),
    resolveAccountFromAuth: async () => ({ account_id: 'fixture-lifecycle-controller' }),
    mediaBuy: { getReportingStatus, getMediaBuyDelivery },
  });
  const controls = {
    scenarios: ['reporting_core_lifecycle_probe'],
    async reportingCoreLifecycleProbe(input) {
      if (!input || typeof input !== 'object') throw new TypeError('probe input must be an object');
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
