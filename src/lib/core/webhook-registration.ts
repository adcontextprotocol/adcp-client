import { createHash } from 'node:crypto';
import { ConfigurationError } from '../errors';
import type {
  AuthorizedOperatorScope,
  DelegatedOperatorAuthorizationContext,
} from '../signing/agent-resolver/resolve-agent';
import { isWebhookLoopbackHost } from '../signing/webhook-verifier';

export type WebhookAuthenticationMode = 'hmac-sha256' | 'rfc9421';

/**
 * Trusted provenance for an outbound task-status webhook registration.
 *
 * Registrations contain routing and mode provenance only, never callback
 * credentials. Stores should still treat seller and callback URLs as
 * operationally sensitive and omit them from public diagnostics.
 */
export interface WebhookRegistration {
  agentId: string;
  agentUrl: string;
  protocol: 'mcp' | 'a2a';
  operationId: string;
  taskType: string;
  callbackUrl: string;
  method: 'POST';
  mode: WebhookAuthenticationMode;
  /** Versioned marker distinguishing tuple-aware registrations from legacy rows. */
  authorizationContextVersion?: 1;
  /** Trusted local tuple used to re-authorize delegated seller keys after restart. */
  delegatedOperatorAuthorization?: Readonly<DelegatedOperatorAuthorizationContext>;
  /** Originating preview API, persisted so async routing survives races and restarts. */
  previewMode?: 'canonical' | 'legacy';
  /** Callback must fail closed unless a durable mutation-settlement route is recoverable. */
  requiresDurableSettlement?: boolean;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface WebhookRegistrationStore {
  /** Return no record when `expiresAt` is at or before the current time. */
  get(agentId: string, operationId: string): Promise<Readonly<WebhookRegistration> | undefined>;
  /**
   * Atomically create a registration. An identical retry is idempotent; a
   * conflicting live registration for the same key MUST reject. A successful
   * return MUST provide immediate read-your-writes consistency through `get()`
   * so the SDK can verify trusted authorization provenance before dispatch.
   */
  putIfAbsent(registration: WebhookRegistration): Promise<void>;
  /**
   * Atomically mark a live registration as requiring durable mutation
   * settlement. The update MUST be immediately visible through `get()`.
   */
  markRequiresDurableSettlement?(agentId: string, operationId: string): Promise<void>;
  /** Remove provenance after a definitively synchronous terminal response. */
  delete?(agentId: string, operationId: string): Promise<void>;
}

export interface InMemoryWebhookRegistrationStoreOptions {
  /** Maximum number of live registrations. Defaults to 100,000. */
  maxEntries?: number;
  /** Current time in epoch milliseconds, for deterministic tests. */
  now?: () => number;
}

/** @internal Durable state exists but cannot be trusted as a registration. */
export class WebhookRegistrationIntegrityError extends Error {
  override readonly name = 'WebhookRegistrationIntegrityError';
}

/**
 * Process-local registration store. Multi-process or restart-safe receivers
 * must inject a shared durable implementation.
 */
export class InMemoryWebhookRegistrationStore implements WebhookRegistrationStore {
  private readonly entries = new Map<string, Readonly<WebhookRegistration>>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: InMemoryWebhookRegistrationStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? 100_000;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new TypeError('maxEntries must be a positive safe integer.');
    }
  }

  async get(agentId: string, operationId: string): Promise<Readonly<WebhookRegistration> | undefined> {
    validateWebhookRegistrationKey(agentId, operationId);
    const key = registrationKey(agentId, operationId);
    const registration = this.entries.get(key);
    if (!registration) return undefined;
    if (registration.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return registration;
  }

  async putIfAbsent(registration: WebhookRegistration): Promise<void> {
    const parsed = parseWebhookRegistration(registration);
    this.pruneExpired();
    if (parsed.expiresAt <= this.now()) {
      throw new TypeError('Webhook registration must not already be expired.');
    }
    const key = registrationKey(parsed.agentId, parsed.operationId);
    const existing = this.entries.get(key);
    if (existing) {
      if (sameWebhookRegistration(existing, parsed)) return;
      throw new ConfigurationError(
        'Webhook operation id is already registered with different trusted provenance.',
        'operationId'
      );
    }
    if (this.entries.size >= this.maxEntries) {
      throw new Error('Webhook registration store capacity reached; refusing to dispatch an untracked callback.');
    }
    this.entries.set(key, parsed);
  }

  async delete(agentId: string, operationId: string): Promise<void> {
    validateWebhookRegistrationKey(agentId, operationId);
    this.entries.delete(registrationKey(agentId, operationId));
  }

  async markRequiresDurableSettlement(agentId: string, operationId: string): Promise<void> {
    validateWebhookRegistrationKey(agentId, operationId);
    const key = registrationKey(agentId, operationId);
    const registration = this.entries.get(key);
    if (!registration || registration.expiresAt <= this.now()) {
      this.entries.delete(key);
      throw new Error('Cannot mark a missing or expired webhook registration for durable settlement.');
    }
    this.entries.set(key, freezeWebhookRegistration({ ...registration, requiresDurableSettlement: true }));
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, registration] of this.entries) {
      if (registration.expiresAt <= now) this.entries.delete(key);
    }
  }
}

function registrationKey(agentId: string, operationId: string): string {
  return `${agentId}\x00${operationId}`;
}

const MAX_IDENTIFIER_BYTES = 512;
const MAX_URL_BYTES = 8 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_EPOCH_MS = 253_402_300_799_999;

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function requireBoundedString(label: string, value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`Webhook registration ${label} must be a non-empty string.`);
  }
  if (value.includes('\0')) throw new TypeError(`Webhook registration ${label} cannot contain NUL characters.`);
  if (hasUnpairedSurrogate(value)) {
    throw new TypeError(`Webhook registration ${label} cannot contain unpaired surrogates.`);
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new TypeError(`Webhook registration ${label} must be at most ${maxBytes} UTF-8 bytes.`);
  }
  return value;
}

function requireEpochMs(label: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_EPOCH_MS) {
    throw new TypeError(`Webhook registration ${label} must be a safe epoch-millisecond integer.`);
  }
  return value as number;
}

/** @internal Validate the exact logical key used by every registration backend. */
export function validateWebhookRegistrationKey(agentId: string, operationId: string): void {
  requireBoundedString('agentId', agentId, MAX_IDENTIFIER_BYTES);
  requireBoundedString('operationId', operationId, MAX_IDENTIFIER_BYTES);
}

/** @internal Parse untrusted durable state into a detached, deeply frozen registration. */
export function parseWebhookRegistration(
  value: unknown,
  expectedKey?: Readonly<{ agentId: string; operationId: string }>
): Readonly<WebhookRegistration> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Webhook registration record must be an object.');
  }
  const input = value as Record<string, unknown>;
  const agentId = requireBoundedString('agentId', input.agentId, MAX_IDENTIFIER_BYTES);
  const operationId = requireBoundedString('operationId', input.operationId, MAX_IDENTIFIER_BYTES);
  validateWebhookRegistrationKey(agentId, operationId);
  if (expectedKey && (agentId !== expectedKey.agentId || operationId !== expectedKey.operationId)) {
    throw new TypeError('Webhook registration record does not match the requested key.');
  }
  const taskType = requireBoundedString('taskType', input.taskType, MAX_IDENTIFIER_BYTES);
  const agentUrl = requireBoundedString('agentUrl', input.agentUrl, MAX_URL_BYTES);
  const callbackUrl = requireBoundedString('callbackUrl', input.callbackUrl, MAX_URL_BYTES);
  if (input.protocol !== 'mcp' && input.protocol !== 'a2a') {
    throw new TypeError('Webhook registration protocol must be mcp or a2a.');
  }
  if (input.method !== 'POST') throw new TypeError('Webhook registration method must be POST.');
  if (input.mode !== 'hmac-sha256' && input.mode !== 'rfc9421') {
    throw new TypeError('Webhook registration mode is invalid.');
  }
  if (input.previewMode !== undefined && input.previewMode !== 'canonical' && input.previewMode !== 'legacy') {
    throw new TypeError('Webhook registration previewMode must be canonical or legacy.');
  }
  if (input.requiresDurableSettlement !== undefined && typeof input.requiresDurableSettlement !== 'boolean') {
    throw new TypeError('Webhook registration requiresDurableSettlement must be boolean.');
  }
  const createdAt = requireEpochMs('createdAt', input.createdAt);
  const expiresAt = requireEpochMs('expiresAt', input.expiresAt);
  if (expiresAt <= createdAt) {
    throw new TypeError('Webhook registration expiresAt must be later than createdAt.');
  }

  const authorization = {
    authorizationContextVersion: input.authorizationContextVersion,
    delegatedOperatorAuthorization: input.delegatedOperatorAuthorization,
  } as Pick<WebhookRegistration, 'authorizationContextVersion' | 'delegatedOperatorAuthorization'>;
  validateWebhookRegistrationAuthorization(authorization);
  const delegatedOperatorAuthorization = authorization.delegatedOperatorAuthorization;

  let callback: URL;
  let agent: URL;
  try {
    callback = new URL(callbackUrl);
    agent = new URL(agentUrl);
  } catch {
    throw new TypeError('Webhook registration contains an invalid URL.');
  }
  if (callback.username || callback.password || callback.hash) {
    throw new TypeError('Webhook callbackUrl cannot contain userinfo or a fragment.');
  }
  if (callback.protocol !== 'https:' && !isWebhookLoopbackHost(callback.hostname)) {
    throw new TypeError('Webhook callbackUrl must use HTTPS (except loopback development URLs).');
  }
  if (agent.username || agent.password || agent.hash) {
    throw new TypeError('Webhook agentUrl cannot contain userinfo credentials or a fragment.');
  }

  const parsed: WebhookRegistration = {
    agentId,
    agentUrl,
    protocol: input.protocol,
    operationId,
    taskType,
    callbackUrl,
    method: 'POST',
    mode: input.mode,
    ...(input.authorizationContextVersion === 1 && { authorizationContextVersion: 1 }),
    ...(delegatedOperatorAuthorization !== undefined && {
      delegatedOperatorAuthorization: { ...delegatedOperatorAuthorization },
    }),
    ...(input.previewMode !== undefined && { previewMode: input.previewMode }),
    ...(input.requiresDurableSettlement !== undefined && {
      requiresDurableSettlement: input.requiresDurableSettlement,
    }),
    createdAt,
    expiresAt,
  };
  const serialized = JSON.stringify(parsed);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_BYTES) {
    throw new TypeError(`Webhook registration record must be at most ${MAX_RECORD_BYTES} UTF-8 bytes.`);
  }
  return Object.freeze({
    ...parsed,
    ...(parsed.delegatedOperatorAuthorization !== undefined && {
      delegatedOperatorAuthorization: Object.freeze({ ...parsed.delegatedOperatorAuthorization }),
    }),
  });
}

const AUTHORIZED_OPERATOR_SCOPES = new Set<AuthorizedOperatorScope>([
  'media_buying',
  'creative_generation',
  'rights_clearance',
  'governance',
  'measurement',
  'agent_operations',
]);

/** @internal Validate trusted registration state before using it as authorization policy. */
export function validateDelegatedOperatorAuthorizationContext(
  value: Readonly<DelegatedOperatorAuthorizationContext> | undefined
): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('delegatedOperatorAuthorization must be an object.');
  }
  const unknown = Object.keys(value).filter(key => !['brand', 'scope', 'country'].includes(key));
  if (unknown.length > 0) {
    throw new TypeError('delegatedOperatorAuthorization contains unsupported fields.');
  }
  if (
    value.brand !== undefined &&
    (typeof value.brand !== 'string' ||
      !/^[a-z0-9_]+$/.test(value.brand) ||
      Buffer.byteLength(value.brand, 'utf8') > 4096)
  ) {
    throw new TypeError('delegatedOperatorAuthorization.brand must be a protocol brand id.');
  }
  if (value.scope !== undefined && (typeof value.scope !== 'string' || !AUTHORIZED_OPERATOR_SCOPES.has(value.scope))) {
    throw new TypeError('delegatedOperatorAuthorization.scope is not an authorized-operator scope.');
  }
  if (value.country !== undefined && (typeof value.country !== 'string' || !/^[A-Z]{2}$/.test(value.country))) {
    throw new TypeError('delegatedOperatorAuthorization.country must be an uppercase ISO alpha-2 code.');
  }
  if (value.brand === undefined && value.scope === undefined && value.country === undefined) {
    throw new TypeError('delegatedOperatorAuthorization must select at least one authorization dimension.');
  }
}

/** @internal Validate the versioned authorization fields returned by a custom durable store. */
export function validateWebhookRegistrationAuthorization(
  registration: Pick<WebhookRegistration, 'authorizationContextVersion' | 'delegatedOperatorAuthorization'>
): void {
  if (registration.authorizationContextVersion !== undefined && registration.authorizationContextVersion !== 1) {
    throw new TypeError('Webhook registration authorizationContextVersion must be 1 when present.');
  }
  if (registration.delegatedOperatorAuthorization !== undefined && registration.authorizationContextVersion !== 1) {
    throw new TypeError('Webhook registration delegatedOperatorAuthorization requires authorizationContextVersion 1.');
  }
  validateDelegatedOperatorAuthorizationContext(registration.delegatedOperatorAuthorization);
}

/** @internal Canonical collision-safe serialization for resolver and replay partitions. */
export function canonicalDelegatedOperatorAuthorization(
  value: Readonly<DelegatedOperatorAuthorizationContext> | undefined
): string {
  if (value === undefined) return '';
  validateDelegatedOperatorAuthorizationContext(value);
  return JSON.stringify([value.brand ?? null, value.scope ?? null, value.country ?? null]);
}

/** @internal Detach, validate, and deeply freeze a registration before storage. */
export function freezeWebhookRegistration(registration: WebhookRegistration): Readonly<WebhookRegistration> {
  return parseWebhookRegistration(registration);
}

/** @internal Canonical immutable provenance used for create-or-identical storage. */
export function webhookRegistrationFingerprint(registration: Readonly<WebhookRegistration>): string {
  const parsed = parseWebhookRegistration(registration);
  return JSON.stringify([
    parsed.agentId,
    parsed.agentUrl,
    parsed.protocol,
    parsed.operationId,
    parsed.taskType,
    parsed.callbackUrl,
    parsed.method,
    parsed.mode,
    parsed.previewMode ?? null,
    parsed.authorizationContextVersion ?? null,
    canonicalDelegatedOperatorAuthorization(parsed.delegatedOperatorAuthorization),
  ]);
}

/** @internal Compare only immutable trusted provenance, not timestamps or settlement state. */
export function sameWebhookRegistration(a: Readonly<WebhookRegistration>, b: Readonly<WebhookRegistration>): boolean {
  return webhookRegistrationFingerprint(a) === webhookRegistrationFingerprint(b);
}

/** @internal Fixed-length Redis storage digest for the exact logical key. */
export function webhookRegistrationStorageDigest(agentId: string, operationId: string): string {
  validateWebhookRegistrationKey(agentId, operationId);
  return createHash('sha256')
    .update(JSON.stringify([agentId, operationId]))
    .digest('hex');
}
