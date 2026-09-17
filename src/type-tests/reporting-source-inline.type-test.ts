import type {
  InlineReportingAvailabilityEvidenceV1,
  InlineReportingDeliveryFetchV1,
  InlineReportingMetricEvidenceV1,
} from '../lib/reporting/source/inline';

const present: InlineReportingMetricEvidenceV1 = {
  constituent_id: 'constituent-1',
  metric: 'impressions',
  status: 'present',
  data_through: '2026-09-02T00:00:00.000Z',
};

const delayed: InlineReportingMetricEvidenceV1 = {
  constituent_id: 'constituent-1',
  metric: 'viewability',
  status: 'delayed',
  reason: 'Provider processing is delayed',
};

const evidence: InlineReportingAvailabilityEvidenceV1 = {
  version: '1.0',
  cells: [present, delayed],
};

const fetch: InlineReportingDeliveryFetchV1 = input => ({
  reporting_period: { start: input.start_date, end: input.end_date },
  reporting_rows: [],
  availability_evidence: {
    ...evidence,
    cells: evidence.cells.map(cell => ({
      ...cell,
      constituent_id: input.constituents[0]!.constituent_id,
    })),
  },
});

void fetch;

// @ts-expect-error Present evidence requires an exact data-through watermark.
const presentWithoutWatermark: InlineReportingMetricEvidenceV1 = {
  constituent_id: 'constituent-1',
  metric: 'impressions',
  status: 'present',
};

// @ts-expect-error Delayed evidence requires a bounded reason.
const delayedWithoutReason: InlineReportingMetricEvidenceV1 = {
  constituent_id: 'constituent-1',
  metric: 'viewability',
  status: 'delayed',
};

void presentWithoutWatermark;
void delayedWithoutReason;
