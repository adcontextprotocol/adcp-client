import { ConfigurationError } from '../errors';
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
   * conflicting live registration for the same key MUST reject.
   */
  putIfAbsent(registration: WebhookRegistration): Promise<void>;
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
    this.entries.set(key, Object.freeze({ ...registration }));
  }

  async delete(agentId: string, operationId: string): Promise<void> {
    this.entries.delete(registrationKey(agentId, operationId));
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
  const callback = new URL(registration.callbackUrl);
  if (callback.username || callback.password || callback.hash) {
    throw new TypeError('Webhook callbackUrl cannot contain userinfo or a fragment.');
  }
  if (callback.protocol !== 'https:' && !isWebhookLoopbackHost(callback.hostname)) {
    throw new TypeError('Webhook callbackUrl must use HTTPS (except loopback development URLs).');
  }
  if (registration.expiresAt <= registration.createdAt) {
    throw new TypeError('Webhook registration expiresAt must be later than createdAt.');
  }
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
    a.mode === b.mode
  );
}
