import { createHmac } from 'node:crypto';
import { signWebhook, type RequestLike, type SignerKey } from '../signing/client';
import { mintEphemeralEd25519Key } from '../signing/testing';
import type { AdcpJsonWebKey } from '../signing/types';
import type {
  RunWebhookConformanceOptions,
  WebhookConformanceCase,
  WebhookConformanceReport,
  WebhookConformanceSigningOptions,
  WebhookConformanceVerdict,
} from './types';

type WebhookExpectation = 'accept' | 'reject';
type ResolvedWebhookConformanceSigningOptions =
  | Exclude<WebhookConformanceSigningOptions, { mode: 'rfc9421' }>
  | (Extract<WebhookConformanceSigningOptions, { mode: 'rfc9421' }> & { key: SignerKey });

interface WebhookCaseDefinition {
  name: string;
  description: string;
  expected: WebhookExpectation;
  body: Record<string, unknown>;
  signatureMutation?: 'stale_timestamp' | 'invalid_signature' | 'mismatched_target';
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DUPLICATE_IDEMPOTENCY_KEY = 'whk_conformance_retry_000001';

/**
 * Replay canonical buyer-receiver webhook cases against an inbound webhook URL.
 *
 * This runner intentionally tests the transport envelope, not seller tool
 * responses. It posts complete MCP webhook envelopes for accepted cases and
 * malformed top-level bodies for rejection cases. When `options.signing` is
 * provided, requests are signed over the exact raw JSON bytes sent on the wire.
 */
export async function runWebhookConformance(
  buyerReceiverUrl: string,
  options: RunWebhookConformanceOptions = {}
): Promise<WebhookConformanceReport> {
  const startedAt = new Date();
  const fetchImpl = options.fetchImpl ?? fetch;
  const { signing, publicKey } = await resolveSigning(options.signing ?? { mode: 'none' });
  const cases = buildCases(signing);
  const results: WebhookConformanceCase[] = [];

  for (const testCase of cases) {
    const body = JSON.stringify(testCase.body);
    const headers = await headersForCase(buyerReceiverUrl, body, signing, options.headers, testCase.signatureMutation);

    try {
      const response = await postWithTimeout(
        fetchImpl,
        buyerReceiverUrl,
        {
          method: 'POST',
          headers,
          body,
        },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      );
      const responseBody = await safeReadResponseBody(response);
      results.push({
        name: testCase.name,
        description: testCase.description,
        expected: testCase.expected,
        verdict: classifyResponse(testCase.expected, response.status),
        request: {
          body: testCase.body,
          idempotencyKey: typeof testCase.body.idempotency_key === 'string' ? testCase.body.idempotency_key : undefined,
        },
        response: {
          status: response.status,
          ...(responseBody ? { body: responseBody } : {}),
        },
      });
    } catch (error) {
      results.push({
        name: testCase.name,
        description: testCase.description,
        expected: testCase.expected,
        verdict: testCase.expected === 'reject' ? 'rejected_correctly' : 'false_reject',
        request: {
          body: testCase.body,
          idempotencyKey: typeof testCase.body.idempotency_key === 'string' ? testCase.body.idempotency_key : undefined,
        },
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const completedAt = new Date();
  return {
    receiverUrl: buyerReceiverUrl,
    totalCases: results.length,
    totalFailures: results.filter(result => result.verdict === 'false_accept' || result.verdict === 'false_reject')
      .length,
    cases: results,
    signing: { mode: signing.mode, ...(publicKey ? { publicKey } : {}) },
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
  };
}

async function resolveSigning(
  signing: WebhookConformanceSigningOptions
): Promise<{ signing: ResolvedWebhookConformanceSigningOptions; publicKey?: AdcpJsonWebKey }> {
  if (signing.mode !== 'rfc9421' || signing.key) {
    return { signing: signing as ResolvedWebhookConformanceSigningOptions };
  }
  const keypair = await mintEphemeralEd25519Key({ adcp_use: 'webhook-signing' });
  return {
    signing: {
      ...signing,
      key: {
        keyid: keypair.kid,
        alg: keypair.algorithm,
        privateKey: keypair.privateKey,
      },
    },
    publicKey: keypair.publicKey,
  };
}

function buildCases(signing: ResolvedWebhookConformanceSigningOptions): WebhookCaseDefinition[] {
  const canonical = canonicalDeliveryEnvelope(DUPLICATE_IDEMPOTENCY_KEY);
  const cases: WebhookCaseDefinition[] = [
    {
      name: 'canonical_mcp_delivery_envelope',
      description: 'Accepts a complete MCP webhook envelope with a delivery report nested under result.',
      expected: 'accept',
      body: canonical,
    },
    {
      name: 'retry_preserves_idempotency_key',
      description: 'Accepts a retry of the same logical event with the same idempotency_key.',
      expected: 'accept',
      body: { ...canonical, timestamp: '2026-05-26T09:00:45.582Z' },
    },
    {
      name: 'reject_bare_delivery_result',
      description: 'Rejects delivery report content sent directly as the top-level POST body.',
      expected: 'reject',
      body: canonical.result as Record<string, unknown>,
    },
    {
      name: 'reject_missing_envelope_fields',
      description: 'Rejects an MCP-like envelope missing required transport fields.',
      expected: 'reject',
      body: {
        task_id: 'delivery_report_67_2026-04_000031',
        task_type: 'media_buy_delivery',
        status: 'completed',
        result: canonical.result,
      },
    },
    {
      name: 'reject_unsupported_status',
      description: 'Rejects malformed top-level async task status values.',
      expected: 'reject',
      body: {
        ...canonical,
        idempotency_key: 'whk_conformance_bad_status_0001',
        status: 'done',
      },
    },
  ];

  if (signing.mode !== 'none') {
    cases.push(
      {
        name: 'reject_stale_signature_timestamp',
        description: 'Rejects a request whose signature timestamp is outside the allowed freshness window.',
        expected: 'reject',
        body: {
          ...canonical,
          idempotency_key: 'whk_conformance_stale_sig_0001',
        },
        signatureMutation: 'stale_timestamp',
      },
      {
        name: 'reject_invalid_signature',
        description: 'Rejects a request whose signature does not cover the exact raw request body.',
        expected: 'reject',
        body: {
          ...canonical,
          idempotency_key: 'whk_conformance_bad_sig_00001',
        },
        signatureMutation: 'invalid_signature',
      }
    );
  }

  if (signing.mode === 'rfc9421') {
    cases.push({
      name: 'reject_mismatched_signature_target',
      description: 'Rejects a valid signature that covers a different webhook target URI.',
      expected: 'reject',
      body: {
        ...canonical,
        idempotency_key: 'whk_conformance_bad_target_01',
      },
      signatureMutation: 'mismatched_target',
    });
  }

  return cases;
}

function canonicalDeliveryEnvelope(idempotencyKey: string): Record<string, unknown> {
  return {
    idempotency_key: idempotencyKey,
    operation_id: 'delivery_report_67_2026-04',
    task_id: 'delivery_report_67_2026-04_000031',
    task_type: 'media_buy_delivery',
    status: 'completed',
    timestamp: '2026-05-26T09:00:44.582Z',
    message: 'Scheduled media buy delivery report available',
    result: {
      notification_type: 'scheduled',
      sequence_number: 31,
      reporting_period: {
        start: '2026-05-25T00:00:00Z',
        end: '2026-05-25T23:59:00Z',
      },
      currency: 'USD',
      media_buy_deliveries: [],
    },
  };
}

async function headersForCase(
  receiverUrl: string,
  body: string,
  signing: ResolvedWebhookConformanceSigningOptions,
  extraHeaders: Record<string, string> | undefined,
  mutation: WebhookCaseDefinition['signatureMutation']
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...extraHeaders,
  };

  if (signing.mode === 'none') {
    return headers;
  }

  if (signing.mode === 'hmac') {
    const now = signing.now ? signing.now() : Math.floor(Date.now() / 1000);
    const timestamp = mutation === 'stale_timestamp' ? now - 600 : now;
    const signedBody = mutation === 'invalid_signature' ? `${body}\n` : body;
    const hmac = createHmac('sha256', signing.secret);
    hmac.update(String(timestamp), 'utf8');
    hmac.update('.', 'utf8');
    hmac.update(signedBody, 'utf8');
    return {
      ...headers,
      'x-adcp-timestamp': String(timestamp),
      'x-adcp-signature': `sha256=${hmac.digest('hex')}`,
    };
  }

  const now = signing.now ? signing.now() : Math.floor(Date.now() / 1000);
  const targetUrl =
    mutation === 'mismatched_target' ? mismatchedTargetUrl(receiverUrl) : (signing.targetUrl ?? receiverUrl);
  const request: RequestLike = {
    method: 'POST',
    url: targetUrl,
    headers,
    body: mutation === 'invalid_signature' ? `${body}\n` : body,
  };
  const signed = signWebhook(request, signing.key, {
    now: () => (mutation === 'stale_timestamp' ? now - 600 : now),
  });
  return { ...headers, ...signed.headers };
}

function mismatchedTargetUrl(receiverUrl: string): string {
  const url = new URL(receiverUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/mismatched-target`;
  return url.toString();
}

function classifyResponse(expected: WebhookExpectation, status: number): WebhookConformanceVerdict {
  if (expected === 'accept') {
    return status >= 200 && status < 300 ? 'accepted' : 'false_reject';
  }
  return status >= 400 && status < 500 ? 'rejected_correctly' : 'false_accept';
}

async function postWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function safeReadResponseBody(response: Response): Promise<string | undefined> {
  try {
    const body = await response.text();
    return body.length > 0 ? body.slice(0, 4096) : undefined;
  } catch {
    return undefined;
  }
}
