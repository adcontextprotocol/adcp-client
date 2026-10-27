import { parseMediaBuyDeliveryWebhook, type MediaBuyDeliveryReport } from '@adcp/sdk/webhooks';
import { MediaBuyDeliveryReportSchema, getSchemaValidatorByRef } from '@adcp/sdk/schemas';
import { MediaBuyDeliveryReportSchema as BrowserReportSchema } from '@adcp/sdk/schemas/browser';
import type { MediaBuyDeliveryReport as RootReport } from '@adcp/sdk';
import type { MediaBuyDeliveryReport as TypesReport } from '@adcp/sdk/types';
import type { z } from 'zod';

declare const body: z.output<typeof MediaBuyDeliveryReportSchema>;
const report: MediaBuyDeliveryReport = body;
const root: RootReport = report;
const types: TypesReport = root;
const browser: z.output<typeof BrowserReportSchema> = types;
const parsed = parseMediaBuyDeliveryWebhook(browser, { adcpVersion: '3.2' });
if (parsed.ok && parsed.wireFormat === 'mcp_envelope') {
  const operation: string | undefined = parsed.envelope.operation_id;
  const nested: MediaBuyDeliveryReport = parsed.result;
  void [operation, nested];
} else if (parsed.ok) {
  const absent: undefined = parsed.envelope;
  void absent;
} else {
  const errors: readonly string[] = parsed.errors;
  void errors;
}
void getSchemaValidatorByRef('media-buy/media-buy-delivery-webhook-result.json', '3.2');
