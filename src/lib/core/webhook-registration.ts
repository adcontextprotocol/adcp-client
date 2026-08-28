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
  /** Atomically mark a live registration as requiring durable mutation settlement. */
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
    validateRegistration(registration);
    this.pruneExpired();
    const key = registrationKey(registration.agentId, registration.operationId);
    const existing = this.entries.get(key);
    if (existing) {
      if (sameRegistration(existing, registration)) return;
      throw new ConfigurationError(
        `Webhook operation id '${registration.operationId}' is already registered with different trusted provenance.`,
        'operationId'
      );
    }
    if (this.entries.size >= this.maxEntries) {
      throw new Error('Webhook registration store capacity reached; refusing to dispatch an untracked callback.');
    }
    this.entries.set(key, freezeRegistration(registration));
  }

  async delete(agentId: string, operationId: string): Promise<void> {
    this.entries.delete(registrationKey(agentId, operationId));
  }

  async markRequiresDurableSettlement(agentId: string, operationId: string): Promise<void> {
    const key = registrationKey(agentId, operationId);
    const registration = this.entries.get(key);
    if (!registration || registration.expiresAt <= this.now()) {
      this.entries.delete(key);
      throw new Error('Cannot mark a missing or expired webhook registration for durable settlement.');
    }
    this.entries.set(key, freezeRegistration({ ...registration, requiresDurableSettlement: true }));
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

function validateRegistration(registration: WebhookRegistration): void {
  if (!registration.agentId || !registration.operationId || !registration.taskType) {
    throw new TypeError('Webhook registration requires agentId, operationId, and taskType.');
  }
  if (
    registration.agentId.includes('\0') ||
    registration.operationId.includes('\0') ||
    registration.taskType.includes('\0')
  ) {
    throw new TypeError('Webhook registration identifiers cannot contain NUL characters.');
  }
  if (registration.previewMode !== undefined && !['canonical', 'legacy'].includes(registration.previewMode)) {
    throw new TypeError('Webhook registration previewMode must be canonical or legacy.');
  }
  validateWebhookRegistrationAuthorization(registration);
  const callback = new URL(registration.callbackUrl);
  if (callback.username || callback.password || callback.hash) {
    throw new TypeError('Webhook callbackUrl cannot contain userinfo or a fragment.');
  }
  if (callback.protocol !== 'https:' && !isWebhookLoopbackHost(callback.hostname)) {
    throw new TypeError('Webhook callbackUrl must use HTTPS (except loopback development URLs).');
  }
  const agent = new URL(registration.agentUrl);
  if (agent.username || agent.password) {
    throw new TypeError('Webhook agentUrl cannot contain userinfo credentials.');
  }
  if (registration.expiresAt <= registration.createdAt) {
    throw new TypeError('Webhook registration expiresAt must be later than createdAt.');
  }
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
  if (value.brand !== undefined && (typeof value.brand !== 'string' || !/^[a-z0-9_]+$/.test(value.brand))) {
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

function freezeRegistration(registration: WebhookRegistration): Readonly<WebhookRegistration> {
  const delegatedOperatorAuthorization = registration.delegatedOperatorAuthorization;
  return Object.freeze({
    ...registration,
    ...(delegatedOperatorAuthorization !== undefined && {
      delegatedOperatorAuthorization: Object.freeze({ ...delegatedOperatorAuthorization }),
    }),
  });
}

function sameRegistration(a: Readonly<WebhookRegistration>, b: WebhookRegistration): boolean {
  return (
    a.agentId === b.agentId &&
    a.agentUrl === b.agentUrl &&
    a.protocol === b.protocol &&
    a.operationId === b.operationId &&
    a.taskType === b.taskType &&
    a.callbackUrl === b.callbackUrl &&
    a.method === b.method &&
    a.mode === b.mode &&
    a.previewMode === b.previewMode &&
    a.authorizationContextVersion === b.authorizationContextVersion &&
    canonicalDelegatedOperatorAuthorization(a.delegatedOperatorAuthorization) ===
      canonicalDelegatedOperatorAuthorization(b.delegatedOperatorAuthorization)
  );
}
