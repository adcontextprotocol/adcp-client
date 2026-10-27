import type { ErrorObject } from 'ajv';
import { TextDecoder } from 'node:util';
import type { MCPWebhookPayload } from '../types/core.generated';
import type { MediaBuyDeliveryReport } from '../types/media-buy-delivery-report';
import { assertAccountChangeJsonSize } from '../client/account-change-json';
import { ConfigurationError } from '../errors';
import { isPre31AdcpVersion, resolveAdcpVersion } from '../utils/adcp-version-config';
import { getMediaBuyDeliveryEnvelopeValidator, getSchemaValidatorByRef } from '../validation/schema-loader';

export interface ParseMediaBuyDeliveryWebhookOptions {
  /** Trusted release negotiated with the seller. Defaults to the SDK pin; never read from the body. */
  adcpVersion?: string;
  /** Accept an unenveloped report and mark its wire format. Defaults to false. */
  acceptBareDeliveryReport?: boolean;
}

/** AdCP 3.0 permits operation_id to be absent. No missing envelope fields are synthesized. */
export type MediaBuyDeliveryWebhookEnvelope = Omit<MCPWebhookPayload, 'result' | 'task_type' | 'operation_id'> & {
  task_type: 'media_buy_delivery';
  operation_id?: string;
  result: MediaBuyDeliveryReport;
};

export type MediaBuyDeliveryWebhookParseErrorCode =
  | 'webhook_envelope_invalid'
  | 'webhook_result_invalid'
  | 'webhook_unsupported_payload';

export type MediaBuyDeliveryWebhookParseResult =
  | {
      ok: true;
      wireFormat: 'mcp_envelope';
      adcpVersion: string;
      envelope: MediaBuyDeliveryWebhookEnvelope;
      result: MediaBuyDeliveryReport;
    }
  | {
      ok: true;
      wireFormat: 'bare_delivery_report';
      adcpVersion: string;
      envelope?: undefined;
      result: MediaBuyDeliveryReport;
    }
  | { ok: false; code: MediaBuyDeliveryWebhookParseErrorCode; message: string; errors: readonly string[] };

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const ENVELOPE_FIELDS = ['result', 'task_type', 'task_id', 'operation_id', 'idempotency_key', 'timestamp'];

/** @internal Prepare trusted configuration before a receiver consumes a signature nonce. */
export function prepareMediaBuyDeliveryWebhookValidation(version?: string) {
  const adcpVersion = resolveAdcpVersion(version);
  const validateEnvelope = getMediaBuyDeliveryEnvelopeValidator(adcpVersion);
  const validateResult = getSchemaValidatorByRef(
    isPre31AdcpVersion(adcpVersion)
      ? 'media-buy/get-media-buy-delivery-response.json'
      : 'media-buy/media-buy-delivery-webhook-result.json',
    adcpVersion
  );
  if (!validateEnvelope || !validateResult) {
    throw new ConfigurationError('Bundled delivery webhook schemas are unavailable.', 'adcpVersion');
  }
  return { adcpVersion, validateEnvelope, validateResult };
}

/**
 * Validate an ALREADY AUTHENTICATED delivery webhook. This performs no signature,
 * sender, registration, or replay verification. Verify the original request bytes
 * first and select adcpVersion from trusted seller/buy state. Malformed bodies
 * return diagnostics; invalid version configuration throws ConfigurationError.
 *
 * Envelope status follows the selected release's task-status enum. A delayed
 * notification may use working; notification_type is independent of task status.
 */
export function parseMediaBuyDeliveryWebhook(
  body: unknown,
  options: ParseMediaBuyDeliveryWebhookOptions = {}
): MediaBuyDeliveryWebhookParseResult {
  const { adcpVersion, validateEnvelope, validateResult } = prepareMediaBuyDeliveryWebhookValidation(
    options.adcpVersion
  );
  let parsed: unknown;
  try {
    if (typeof body === 'string' || body instanceof Uint8Array) {
      if ((typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength) > MAX_BODY_BYTES) {
        throw new Error('Body is too large');
      }
      parsed = JSON.parse(
        typeof body === 'string' ? body : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body)
      );
    } else {
      parsed = body;
    }
    assertAccountChangeJsonSize(parsed, MAX_BODY_BYTES);
    parsed = structuredClone(parsed);
  } catch {
    return failure('webhook_envelope_invalid', [
      'Webhook body must be valid JSON within 16 MiB and 64 nesting levels.',
    ]);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return failure('webhook_envelope_invalid', ['Webhook body must be an object.']);
  }
  const envelope = parsed as Record<string, unknown>;
  const bare =
    Object.hasOwn(envelope, 'media_buy_deliveries') && !ENVELOPE_FIELDS.some(field => Object.hasOwn(envelope, field));
  if (bare && options.acceptBareDeliveryReport !== true) {
    return failure('webhook_unsupported_payload', [
      'Bare delivery reports require acceptBareDeliveryReport: true; the default expects an MCP envelope with result.',
    ]);
  }
  if (!bare) {
    if (typeof envelope.task_type === 'string' && envelope.task_type !== 'media_buy_delivery') {
      return failure('webhook_unsupported_payload', ['task_type must be media_buy_delivery.']);
    }
    if (!validateEnvelope(envelope)) return failure('webhook_envelope_invalid', diagnostics(validateEnvelope.errors));
  }
  const result = bare ? envelope : envelope.result;
  if (!validateResult(result))
    return failure('webhook_result_invalid', diagnostics(validateResult.errors, bare ? '' : 'result'));
  if (bare)
    return { ok: true, wireFormat: 'bare_delivery_report', adcpVersion, result: result as MediaBuyDeliveryReport };
  return {
    ok: true,
    wireFormat: 'mcp_envelope',
    adcpVersion,
    envelope: envelope as unknown as MediaBuyDeliveryWebhookEnvelope,
    result: result as MediaBuyDeliveryReport,
  };
}

function failure(
  code: MediaBuyDeliveryWebhookParseErrorCode,
  errors: readonly string[]
): Extract<MediaBuyDeliveryWebhookParseResult, { ok: false }> {
  return { ok: false, code, message: errors.join('; '), errors };
}

function diagnostics(errors: ErrorObject[] | null | undefined, prefix = ''): string[] {
  if (!errors?.length) return [`${prefix || 'body'} is invalid`];
  return errors.slice(0, 20).map(error => {
    const fields = error.instancePath
      .split('/')
      .slice(1)
      .map(field => field.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (error.keyword === 'required' && typeof error.params.missingProperty === 'string')
      fields.push(error.params.missingProperty);
    if (error.keyword === 'additionalProperties' && typeof error.params.additionalProperty === 'string')
      fields.push(error.params.additionalProperty);
    let path = prefix;
    for (const field of fields) {
      const bounded = field.length > 80 ? field.slice(0, 80) + '…' : field;
      path += /^(0|[1-9][0-9]*)$/.test(bounded)
        ? `[${bounded}]`
        : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(bounded)
          ? `${path ? '.' : ''}${bounded}`
          : `[${JSON.stringify(bounded)}]`;
    }
    return `${path || 'body'} ${error.keyword === 'required' ? 'is required' : (error.message ?? 'is invalid')}`;
  });
}
