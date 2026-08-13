import { decodeBodyAsJsonOrText, ssrfSafeFetch } from '../../net';
import { redactSecrets } from '../../utils/redact-secrets';
import type {
  HttpProbeResult,
  TrustedMatchPublisherAuthRunner,
  TrustedMatchPublisherAuthOperation,
  TrustedMatchPublisherCredentialState,
} from './types';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export const TRUSTED_MATCH_PUBLISHER_AUTH_TASK_MAPPING = Object.freeze({
  trusted_match_missing_auth_context_probe: Object.freeze({
    endpoint: 'contextEndpoint',
    operation: 'context',
    credentialState: 'absent',
  }),
  trusted_match_invalid_auth_context_probe: Object.freeze({
    endpoint: 'contextEndpoint',
    operation: 'context',
    credentialState: 'invalid',
  }),
  trusted_match_missing_auth_identity_probe: Object.freeze({
    endpoint: 'identityEndpoint',
    operation: 'identity',
    credentialState: 'absent',
  }),
  trusted_match_invalid_auth_identity_probe: Object.freeze({
    endpoint: 'identityEndpoint',
    operation: 'identity',
    credentialState: 'invalid',
  }),
} as const);

export type TrustedMatchPublisherAuthTask = keyof typeof TRUSTED_MATCH_PUBLISHER_AUTH_TASK_MAPPING;

export const TRUSTED_MATCH_PUBLISHER_AUTH_TASKS: ReadonlySet<string> = new Set(
  Object.keys(TRUSTED_MATCH_PUBLISHER_AUTH_TASK_MAPPING)
);

export interface PreparedTrustedMatchPublisherAuthProbe {
  endpoint: string;
  operation: TrustedMatchPublisherAuthOperation;
  credentialState: TrustedMatchPublisherCredentialState;
  credentialHeaders: Record<string, string>;
  tls: {
    clientCertificatePem?: string;
    privateKeyPem?: string;
    privateKeyPassphrase?: string;
    caCertificatePem?: string;
  };
}

export type PreparedTrustedMatchPublisherAuthProbes = Record<
  TrustedMatchPublisherAuthTask,
  PreparedTrustedMatchPublisherAuthProbe
>;

/**
 * Resolve and validate every adapter state before the storyboard starts. This
 * makes incomplete operator configuration a single requirement_unmet result,
 * rather than four misleading task failures after execution has begun.
 */
export async function prepareTrustedMatchPublisherAuthProbes(
  runner: TrustedMatchPublisherAuthRunner
): Promise<PreparedTrustedMatchPublisherAuthProbes> {
  assertRunnerShape(runner);
  const prepared = {} as PreparedTrustedMatchPublisherAuthProbes;
  for (const [task, mapping] of Object.entries(TRUSTED_MATCH_PUBLISHER_AUTH_TASK_MAPPING) as Array<
    [TrustedMatchPublisherAuthTask, (typeof TRUSTED_MATCH_PUBLISHER_AUTH_TASK_MAPPING)[TrustedMatchPublisherAuthTask]]
  >) {
    const endpoint = runner[mapping.endpoint];
    validateEndpoint(endpoint, mapping.endpoint);
    let raw: unknown;
    try {
      raw = await runner.preparePublisherAuthProbe({
        operation: mapping.operation,
        credentialState: mapping.credentialState,
      });
    } catch (error) {
      throw new Error(
        `preparePublisherAuthProbe failed for ${mapping.operation}/${mapping.credentialState}: ${safeError(error)}`
      );
    }
    const config = validateAdapterConfiguration(raw, mapping.operation, mapping.credentialState);
    prepared[task] = {
      endpoint,
      operation: mapping.operation,
      credentialState: mapping.credentialState,
      credentialHeaders: config.credentialHeaders,
      tls: config.tls,
    };
  }
  return prepared;
}

export async function probeTrustedMatchPublisherAuth(
  prepared: PreparedTrustedMatchPublisherAuthProbe,
  request: Record<string, unknown>,
  options: { allowPrivateIp?: boolean; signal?: AbortSignal } = {}
): Promise<HttpProbeResult> {
  const body = JSON.stringify(request);
  const sensitiveValues = collectSensitiveValues(prepared);
  try {
    const response = await ssrfSafeFetch(prepared.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/plain;q=0.9, */*;q=0.1',
        ...prepared.credentialHeaders,
      },
      body,
      allowPrivateIp: options.allowPrivateIp === true,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxBodyBytes: MAX_RESPONSE_BYTES,
      ...(options.signal && { signal: options.signal }),
      tls: {
        ...(prepared.tls.clientCertificatePem !== undefined && { cert: prepared.tls.clientCertificatePem }),
        ...(prepared.tls.privateKeyPem !== undefined && { key: prepared.tls.privateKeyPem }),
        ...(prepared.tls.privateKeyPassphrase !== undefined && { passphrase: prepared.tls.privateKeyPassphrase }),
        ...(prepared.tls.caCertificatePem !== undefined && { ca: prepared.tls.caCertificatePem }),
      },
    });
    const result: HttpProbeResult = {
      url: prepared.endpoint,
      status: response.status,
      headers: Object.fromEntries(
        Object.entries(response.headers).map(([name, value]) => [name, redactKnownValuesInText(value, sensitiveValues)])
      ),
      body: redactProbeBody(
        decodeBodyAsJsonOrText(
          redactKnownValuesInBytes(response.body, sensitiveValues),
          response.headers['content-type']
        )
      ),
    };
    if (response.status >= 300 && response.status < 400) {
      result.error = `Trusted Match publisher-auth probe rejected redirect response (HTTP ${response.status}); redirects are forbidden.`;
    }
    return result;
  } catch (error) {
    return {
      url: prepared.endpoint,
      status: 0,
      headers: {},
      body: null,
      error: safeError(error, sensitiveValues),
    };
  }
}

function assertRunnerShape(runner: TrustedMatchPublisherAuthRunner): void {
  if (!runner || typeof runner !== 'object') {
    throw new Error('trusted_match_publisher_auth_runner must be an object.');
  }
  if (typeof runner.preparePublisherAuthProbe !== 'function') {
    throw new Error('trusted_match_publisher_auth_runner.preparePublisherAuthProbe must be a function.');
  }
}

function validateEndpoint(value: unknown, field: 'contextEndpoint' | 'identityEndpoint'): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`trusted_match_publisher_auth_runner.${field} must be a non-empty HTTPS URL.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`trusted_match_publisher_auth_runner.${field} must be an absolute HTTPS URL.`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`trusted_match_publisher_auth_runner.${field} must use HTTPS.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`trusted_match_publisher_auth_runner.${field} must not embed credentials in the URL.`);
  }
  if (parsed.hash) {
    throw new Error(`trusted_match_publisher_auth_runner.${field} must not contain a URL fragment.`);
  }
}

function validateAdapterConfiguration(
  value: unknown,
  operation: TrustedMatchPublisherAuthOperation,
  credentialState: TrustedMatchPublisherCredentialState
): { credentialHeaders: Record<string, string>; tls: PreparedTrustedMatchPublisherAuthProbe['tls'] } {
  if (!isRecord(value)) {
    throw new Error(`preparePublisherAuthProbe(${operation}/${credentialState}) must return an object.`);
  }
  rejectUnknownKeys(value, new Set(['credentialHeaders', 'tls']), `adapter result for ${operation}/${credentialState}`);

  const credentialHeaders = validateCredentialHeaders(value.credentialHeaders, operation, credentialState);
  const tls = validateTls(value.tls, operation, credentialState);
  const hasClientCredential = tls.clientCertificatePem !== undefined || tls.privateKeyPem !== undefined;

  if (credentialState === 'absent' && (Object.keys(credentialHeaders).length > 0 || hasClientCredential)) {
    throw new Error(
      `preparePublisherAuthProbe(${operation}/absent) must not return credential headers or client-certificate material.`
    );
  }
  if (credentialState === 'invalid' && Object.keys(credentialHeaders).length === 0 && !hasClientCredential) {
    throw new Error(
      `preparePublisherAuthProbe(${operation}/invalid) must return credential headers or a client certificate/private key known to be invalid.`
    );
  }
  return { credentialHeaders, tls };
}

function validateCredentialHeaders(
  value: unknown,
  operation: TrustedMatchPublisherAuthOperation,
  credentialState: TrustedMatchPublisherCredentialState
): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new Error(`credentialHeaders for ${operation}/${credentialState} must be a string record.`);
  }
  const result: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [name, headerValue] of Object.entries(value)) {
    const lower = name.toLowerCase();
    if (!HTTP_TOKEN.test(name) || isReservedCredentialHeader(lower)) {
      throw new Error(
        `credentialHeaders for ${operation}/${credentialState} contains forbidden header ${JSON.stringify(name)}.`
      );
    }
    if (seen.has(lower)) {
      throw new Error(
        `credentialHeaders for ${operation}/${credentialState} contains duplicate header ${JSON.stringify(name)}.`
      );
    }
    if (typeof headerValue !== 'string' || headerValue.length === 0 || !HEADER_VALUE.test(headerValue)) {
      throw new Error(
        `credentialHeaders.${name} for ${operation}/${credentialState} must be a non-empty printable string.`
      );
    }
    if (headerValue.trim() !== headerValue) {
      throw new Error(
        `credentialHeaders.${name} for ${operation}/${credentialState} must not contain leading or trailing whitespace.`
      );
    }
    seen.add(lower);
    result[lower] = headerValue;
  }
  return result;
}

function validateTls(
  value: unknown,
  operation: TrustedMatchPublisherAuthOperation,
  credentialState: TrustedMatchPublisherCredentialState
): PreparedTrustedMatchPublisherAuthProbe['tls'] {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`tls for ${operation}/${credentialState} must be an object.`);
  rejectUnknownKeys(
    value,
    new Set(['clientCertificatePem', 'privateKeyPem', 'privateKeyPassphrase', 'caCertificatePem']), // ggignore
    `tls for ${operation}/${credentialState}`
  );
  const result: PreparedTrustedMatchPublisherAuthProbe['tls'] = {};
  for (const key of [
    'clientCertificatePem',
    'privateKeyPem',
    'privateKeyPassphrase', // ggignore
    'caCertificatePem',
  ] as const) {
    const entry = value[key];
    if (entry === undefined) continue;
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new Error(`tls.${key} for ${operation}/${credentialState} must be a non-empty string.`);
    }
    result[key] = entry;
  }
  const hasCert = result.clientCertificatePem !== undefined;
  const hasKey = result.privateKeyPem !== undefined;
  if (hasCert !== hasKey) {
    throw new Error(
      `tls clientCertificatePem and privateKeyPem must be supplied together for ${operation}/${credentialState}.`
    );
  }
  if (result.privateKeyPassphrase !== undefined && !hasKey) {
    throw new Error(`tls.privateKeyPassphrase requires privateKeyPem for ${operation}/${credentialState}.`);
  }
  if (hasCert && !result.clientCertificatePem!.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error(`tls.clientCertificatePem for ${operation}/${credentialState} must be PEM encoded.`);
  }
  if (hasKey && !/-----BEGIN (?:ENCRYPTED |RSA |EC )?PRIVATE KEY-----/.test(result.privateKeyPem!)) {
    throw new Error(`tls.privateKeyPem for ${operation}/${credentialState} must be PEM encoded.`);
  }
  if (result.caCertificatePem !== undefined && !result.caCertificatePem.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error(`tls.caCertificatePem for ${operation}/${credentialState} must be PEM encoded.`);
  }
  return result;
}

const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
const RESERVED_HEADERS = new Set([
  'host',
  'content-type',
  'content-length',
  'content-encoding',
  'content-range',
  'range',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
  'expect',
  'accept',
  'forwarded',
  'forwarded-for',
  'proxy',
  'via',
  'x-real-ip',
  'x-client-ip',
  'client-ip',
  'true-client-ip',
  'cf-connecting-ip',
  'fastly-client-ip',
  'x-host',
  'x-adcp-tenant',
  'x-tenant',
  'x-tenant-id',
  'x-route',
  'x-routing-key',
  'x-upstream',
  'x-backend',
  'x-destination',
  'x-target-url',
  'x-url',
  'x-sni',
  'x-http-method-override',
  'x-method-override',
]);

function isReservedCredentialHeader(name: string): boolean {
  return (
    RESERVED_HEADERS.has(name) ||
    name.startsWith('proxy-') ||
    name.startsWith('x-proxy-') ||
    name === 'x-forwarded' ||
    name.startsWith('x-forwarded-') ||
    name.startsWith('x-original-') ||
    name.startsWith('x-rewrite-') ||
    name.startsWith('x-envoy-original-') ||
    /(?:^|-)(?:host|route|routing|upstream|backend|destination|tenant|proxy|forwarded|forwarding)(?:-|$)/.test(name)
  );
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains forbidden field(s): ${unknown.sort().join(', ')}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeError(error: unknown, sensitiveValues: readonly string[] = []): string {
  const raw = redactKnownValuesInText(error instanceof Error ? error.message : String(error), sensitiveValues);
  return redactUrlsInText(
    raw
      .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[redacted PEM]')
      .replace(/(\b(?:authorization|cookie)\s*:\s*)[^\r\n]*/gi, '$1[redacted]')
      .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, '$1 [redacted]')
      .replace(
        /(\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|private[_ -]?key|passphrase|password|secret)\s*[=:]\s*)[^\s,;&"']+/gi,
        '$1[redacted]'
      )
  ).slice(0, 1_000);
}

function collectSensitiveValues(prepared: PreparedTrustedMatchPublisherAuthProbe): string[] {
  return [
    ...Object.values(prepared.credentialHeaders),
    prepared.tls.clientCertificatePem,
    prepared.tls.privateKeyPem,
    prepared.tls.privateKeyPassphrase,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .sort((a, b) => b.length - a.length);
}

function redactKnownValuesInBytes(body: Uint8Array, sensitiveValues: readonly string[]): Uint8Array {
  if (sensitiveValues.length === 0) return body;
  const decoded = new TextDecoder().decode(body);
  return new TextEncoder().encode(redactKnownValuesInText(decoded, sensitiveValues));
}

function redactKnownValuesInText(value: string, sensitiveValues: readonly string[]): string {
  let result = value;
  const variants = new Set<string>();
  for (const sensitiveValue of sensitiveValues) {
    if (!sensitiveValue) continue;
    variants.add(sensitiveValue);
    variants.add(JSON.stringify(sensitiveValue).slice(1, -1));
  }
  for (const sensitiveValue of [...variants].sort((a, b) => b.length - a.length)) {
    result = result.split(sensitiveValue).join('[redacted]');
  }
  return result;
}

function redactUrlsInText(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>]+/gi, match => {
    try {
      const parsed = new URL(match);
      parsed.username = '';
      parsed.password = '';
      for (const key of [...parsed.searchParams.keys()]) parsed.searchParams.set(key, 'REDACTED');
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return '[redacted URL]';
    }
  });
}

function redactProbeBody(value: unknown): unknown {
  const structured = redactSecrets(value);
  if (typeof structured !== 'string') return structured;
  return redactUrlsInText(
    structured
      .replace(/(\b(?:authorization|cookie)\s*:\s*)[^\r\n]*/gi, '$1[redacted]')
      .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, '$1 [redacted]')
      .replace(
        /(\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|private[_ -]?key|passphrase|password|secret)\s*[=:]\s*)[^\s,;&"']+/gi,
        '$1[redacted]'
      )
  );
}
