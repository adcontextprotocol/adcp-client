import { parseMediaBuyDeliveryWebhook, type MediaBuyDeliveryReport } from '../lib/webhooks';
import { MediaBuyDeliveryReportSchema, MediaBuyDeliveryWebhookResultSchema } from '../lib/schemas';
import type { GetMediaBuyDeliveryResponse } from '../lib/types';
import type { MediaBuyDeliveryWebhookResult } from '../lib/types';

declare const response: GetMediaBuyDeliveryResponse;
const common: MediaBuyDeliveryReport = response;
const parsedBody: MediaBuyDeliveryReport = MediaBuyDeliveryReportSchema.parse({});
const webhook: MediaBuyDeliveryWebhookResult = MediaBuyDeliveryWebhookResultSchema.parse({});
const row: MediaBuyDeliveryReport['media_buy_deliveries'][number] = {
  media_buy_id: 'mb1',
  status: 'active',
  currency: 'USD',
  totals: { spend: 1 },
  by_package: [{ package_id: 'p', spend: 1, currency: 'USD', pricing_model: 'cpm', rate: 1 }],
};
const rows: MediaBuyDeliveryReport['media_buy_deliveries'] = [row];
// @ts-expect-error A delivery body does not supply the poll task envelope status.
const poll: GetMediaBuyDeliveryResponse = parsedBody;
// @ts-expect-error Package breakdown is required on every report row.
const noPackages: MediaBuyDeliveryReport['media_buy_deliveries'][number] = {
  media_buy_id: 'mb1',
  status: 'active',
  totals: { spend: 1 },
};
const parsed = parseMediaBuyDeliveryWebhook('{}', { adcpVersion: '3.1', acceptBareDeliveryReport: true });
if (parsed.ok) {
  const report: MediaBuyDeliveryReport = parsed.result;
  if (parsed.wireFormat === 'mcp_envelope') {
    const operation: string | undefined = parsed.envelope.operation_id;
    void operation;
  } else {
    const noEnvelope: undefined = parsed.envelope;
    void noEnvelope;
  }
  void report;
} else {
  const errors: readonly string[] = parsed.errors;
  void errors;
}
void [common, parsedBody, webhook, poll, noPackages, rows];
