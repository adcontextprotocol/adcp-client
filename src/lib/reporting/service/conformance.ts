import {
  createInlineReportingSourceExecutor,
  runReportingSourceReplayConformanceV1,
  type ReportingSourceManifestV1,
  type ReportingSourceSliceRequestV1,
} from '../source';
import type {
  ReliableReportingAdapterV1,
  ReliableReportingConfigurationInputV1,
  ReliableReportingInstallContextV1,
  ReliableReportingServiceV1,
} from './index';

export interface ReliableReportingServiceConformanceOptionsV1<TCtxMeta = Record<string, unknown>> {
  service: ReliableReportingServiceV1<TCtxMeta>;
  adapter: ReliableReportingAdapterV1;
  replayRequest: ReportingSourceSliceRequestV1;
  primary: {
    context: ReliableReportingInstallContextV1<TCtxMeta>;
    configuration: ReliableReportingConfigurationInputV1 & { expectedCurrency: string };
  };
  isolated: {
    context: ReliableReportingInstallContextV1<TCtxMeta>;
    configuration: ReliableReportingConfigurationInputV1 & { expectedCurrency: string };
  };
}

export interface ReliableReportingServiceConformanceResultV1 {
  checks: readonly [
    'adapter_replay',
    'account_isolation',
    'frozen_currency',
    'lifecycle_start_stop',
    'capability_truthfulness',
  ];
  manifest: ReportingSourceManifestV1;
}

/**
 * Exercise the invariants every Core installation must preserve. Use an
 * isolated conformance ledger: the helper intentionally installs two durable
 * configurations and starts the lifecycle once.
 */
export async function runReliableReportingServiceConformanceV1<TCtxMeta = Record<string, unknown>>(
  options: ReliableReportingServiceConformanceOptionsV1<TCtxMeta>
): Promise<ReliableReportingServiceConformanceResultV1> {
  // An adapter supplying its own durable executor is exercised directly; the
  // replay contract is the same either way.
  const source =
    options.adapter.executor ??
    createInlineReportingSourceExecutor(options.adapter.fetchSlice!, options.adapter.sourceOffering);
  const manifest = await runReportingSourceReplayConformanceV1({
    level: 'basic',
    executor: source,
    objectReader: source,
    request: structuredClone(options.replayRequest),
  });

  const first = await options.service.installConfiguration(options.primary.configuration, options.primary.context);
  const replay = await options.service.installConfiguration(options.primary.configuration, options.primary.context);
  const isolated = await options.service.installConfiguration(options.isolated.configuration, options.isolated.context);
  if (first.configurationId !== replay.configurationId || first.semanticFingerprint !== replay.semanticFingerprint) {
    throw new Error('Reliable reporting configuration replay was not idempotent');
  }
  if (
    first.account.account_id === isolated.account.account_id ||
    first.configurationId === isolated.configurationId ||
    first.account.account_id !== options.primary.context.account.id ||
    isolated.account.account_id !== options.isolated.context.account.id
  ) {
    throw new Error('Reliable reporting configuration identity is not account isolated');
  }
  if (
    first.sourceSettings.currency !== options.primary.configuration.expectedCurrency ||
    isolated.sourceSettings.currency !== options.isolated.configuration.expectedCurrency
  ) {
    throw new Error('Reliable reporting configuration did not freeze trusted currency');
  }

  assertTruthfulCoreCapabilities(options.service);
  options.service.start({ intervalMilliseconds: 60_000, accountIds: [] });
  if (!options.service.running) throw new Error('Reliable reporting lifecycle did not start');
  await options.service.stop();
  if (options.service.running) throw new Error('Reliable reporting lifecycle did not stop');

  return {
    checks: [
      'adapter_replay',
      'account_isolation',
      'frozen_currency',
      'lifecycle_start_stop',
      'capability_truthfulness',
    ],
    manifest,
  };
}

function assertTruthfulCoreCapabilities<TCtxMeta>(service: ReliableReportingServiceV1<TCtxMeta>): void {
  const capabilities = service.capabilities as unknown as Record<string, unknown>;
  for (const forbidden of [
    'managed_delivery',
    'reconciled_billing',
    'receipt_task',
    'readiness_notification',
    'status_notification',
    'ledger_notification',
    'supports_webhook_activity',
  ]) {
    if (capabilities[forbidden] !== undefined) {
      throw new Error(`Reliable Reporting Core must not advertise ${forbidden}`);
    }
  }
  if ((capabilities.consumer_status_task !== undefined) !== (service.platform.syncReportingStatus !== undefined)) {
    throw new Error('Reliable reporting consumer-status capability does not match its installed handler');
  }
  if (
    capabilities.consumer_mismatch_escalation_seconds !== undefined &&
    capabilities.consumer_status_task !== 'sync_reporting_status'
  ) {
    throw new Error('Reliable reporting mismatch escalation requires the consumer-status task');
  }
  if (
    capabilities.status_task !== 'get_reporting_status' ||
    capabilities.revision_content_task !== 'get_media_buy_delivery'
  ) {
    throw new Error('Reliable reporting capability does not match its installed read handlers');
  }
}
