import { createHash } from 'node:crypto';
import { canonicalize } from '../../utils/jcs';

export class ReportingObjectWriteConflictError extends Error {
  constructor() {
    super('Reporting object-write plan conflict');
    this.name = 'ReportingObjectWriteConflictError';
    Object.defineProperty(this, Symbol.for('adcp.reporting.objectWriteConflict'), { value: true });
  }
}

/** Symbol branding preserves errors when CJS stores are paired with ESM fences. */
export function isReportingObjectWriteConflictError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as Record<symbol, unknown>)[Symbol.for('adcp.reporting.objectWriteConflict')] === true
  );
}

export class ReportingObjectWriteNotRevokedError extends Error {
  constructor() {
    super('Reporting object-write generation is not revoked');
    this.name = 'ReportingObjectWriteNotRevokedError';
    Object.defineProperty(this, Symbol.for('adcp.reporting.objectWriteNotRevoked'), { value: true });
  }
}

export function isReportingObjectWriteNotRevokedError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as Record<symbol, unknown>)[Symbol.for('adcp.reporting.objectWriteNotRevoked')] === true
  );
}

/** Non-secret destination identity, scoped to the store's isolated tenant database. */
export interface ReportingObjectWriteScopeV1 {
  account_id: string;
  destination_ref: string;
  generation: number;
}

export interface ReportingObjectWriteV1 {
  bucket: string;
  object_name: string;
  sha256: string;
  size_bytes: number;
}

export interface ReportingObjectWriteBindingV1 {
  bucket: string;
  /** SHA-256 of a host-owned deployment namespace; immutable per authorization generation. */
  namespace_key: string;
}

export interface ReportingObjectWriteContextV1 {
  signal?: AbortSignal;
}

export function reportingObjectWriteScopeKey(scope: ReportingObjectWriteScopeV1): string {
  assertReportingObjectWriteScope(scope);
  return createHash('sha256')
    .update(JSON.stringify([scope.account_id, scope.destination_ref, scope.generation]))
    .digest('hex');
}

export function reportingObjectWriteName(
  scope: ReportingObjectWriteScopeV1,
  binding: ReportingObjectWriteBindingV1,
  planId: string,
  index: number
): string {
  return `adcp-reporting/${binding.namespace_key}/${reportingObjectWriteScopeKey(scope)}/${planId}/${index}`;
}

export interface ReportingObjectWritePlanV1 extends ReportingObjectWriteScopeV1 {
  provider: ReportingObjectWriteBindingV1;
  /** Stable opaque identity for the same logical delivery across retries. */
  plan_id: string;
  objects: readonly ReportingObjectWriteV1[];
}

export interface ReportingObjectWriteCursorV1 {
  plan_id: string;
  object_index: number;
}

export interface ReportingObjectWriteStoreV1 {
  /** Registration and destination revocation MUST share one authority/lock boundary. */
  registerObjectWritePlan(
    plan: ReportingObjectWritePlanV1,
    context?: ReportingObjectWriteContextV1
  ): Promise<'registered' | 'unchanged' | 'revoked'>;
  /** Authoritative cleanup routing, available only for a closed generation. */
  getObjectWriteBinding(
    scope: ReportingObjectWriteScopeV1,
    context?: ReportingObjectWriteContextV1
  ): Promise<ReportingObjectWriteBindingV1 | null>;
  /** Only reads closed (revoked) generations; inventory never prunes automatically. */
  listRevokedObjectWrites(
    scope: ReportingObjectWriteScopeV1,
    options?: { after?: ReportingObjectWriteCursorV1; limit?: number },
    context?: ReportingObjectWriteContextV1
  ): Promise<Array<ReportingObjectWriteV1 & ReportingObjectWriteCursorV1>>;
  /** Trusted provider code calls this only after verifying a persistent tombstone. */
  markObjectWriteFenced(
    input: ReportingObjectWriteScopeV1 & ReportingObjectWriteCursorV1 & { tombstone_generation: string },
    context?: ReportingObjectWriteContextV1
  ): Promise<void>;
}

/** Apply after REPORTING_MANAGED_DELIVERY_MIGRATION. Additive and independently opt-in. */
export const REPORTING_OBJECT_WRITE_MIGRATION = `
CREATE TABLE IF NOT EXISTS adcp_reporting_object_write_bindings (
  account_id TEXT NOT NULL,
  destination_ref TEXT NOT NULL,
  generation BIGINT NOT NULL,
  bucket TEXT NOT NULL,
  namespace_key TEXT NOT NULL CHECK (namespace_key ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (account_id, destination_ref, generation),
  FOREIGN KEY (account_id, destination_ref, generation)
    REFERENCES adcp_reporting_destination_authorizations(account_id, destination_ref, generation)
);
CREATE TABLE IF NOT EXISTS adcp_reporting_object_write_plans (
  account_id TEXT NOT NULL,
  destination_ref TEXT NOT NULL,
  generation BIGINT NOT NULL,
  plan_id TEXT NOT NULL CHECK (plan_id ~ '^[a-f0-9]{64}$'),
  fingerprint TEXT NOT NULL,
  PRIMARY KEY (account_id, destination_ref, generation, plan_id),
  FOREIGN KEY (account_id, destination_ref, generation)
    REFERENCES adcp_reporting_destination_authorizations(account_id, destination_ref, generation)
);
CREATE TABLE IF NOT EXISTS adcp_reporting_object_writes (
  account_id TEXT NOT NULL,
  destination_ref TEXT NOT NULL,
  generation BIGINT NOT NULL,
  plan_id TEXT NOT NULL,
  object_index INTEGER NOT NULL CHECK (object_index >= 0 AND object_index < 128),
  bucket TEXT NOT NULL,
  object_name TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 67108864),
  fenced_at TIMESTAMPTZ,
  tombstone_generation TEXT,
  PRIMARY KEY (account_id, destination_ref, generation, plan_id, object_index),
  UNIQUE (bucket, object_name),
  FOREIGN KEY (account_id, destination_ref, generation, plan_id)
    REFERENCES adcp_reporting_object_write_plans(account_id, destination_ref, generation, plan_id)
);
`;

export function assertReportingObjectWriteScope(scope: ReportingObjectWriteScopeV1): void {
  if (
    !scope ||
    ![scope.account_id, scope.destination_ref].every(v => typeof v === 'string' && v.length > 0 && v.length <= 255) ||
    !Number.isSafeInteger(scope.generation) ||
    scope.generation < 1
  )
    throw new Error('Invalid reporting object-write scope');
}

export function reportingObjectWritePlanFingerprint(plan: ReportingObjectWritePlanV1): string {
  assertReportingObjectWriteScope(plan);
  if (
    !plan.provider ||
    typeof plan.provider.bucket !== 'string' ||
    !/^[a-z0-9][a-z0-9.-]{1,220}[a-z0-9]$/.test(plan.provider.bucket) ||
    typeof plan.provider.namespace_key !== 'string' ||
    !/^[a-f0-9]{64}$/.test(plan.provider.namespace_key) ||
    typeof plan.plan_id !== 'string' ||
    !/^[a-f0-9]{64}$/.test(plan.plan_id) ||
    !Array.isArray(plan.objects) ||
    plan.objects.length < 1 ||
    plan.objects.length > 128 ||
    plan.objects.some(
      (o, i) =>
        !o ||
        typeof o.bucket !== 'string' ||
        !/^[a-z0-9][a-z0-9.-]{1,220}[a-z0-9]$/.test(o.bucket) ||
        o.bucket !== plan.provider.bucket ||
        o.object_name !== reportingObjectWriteName(plan, plan.provider, plan.plan_id, i) ||
        typeof o.object_name !== 'string' ||
        !/^[A-Za-z0-9/_-]{1,1024}$/.test(o.object_name) ||
        typeof o.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(o.sha256) ||
        !Number.isSafeInteger(o.size_bytes) ||
        o.size_bytes < 0 ||
        o.size_bytes > 64 * 1024 * 1024
    ) ||
    plan.objects.reduce((total, o) => total + o.size_bytes, 0) > 64 * 1024 * 1024 ||
    new Set(plan.objects.map(o => JSON.stringify([o.bucket, o.object_name]))).size !== plan.objects.length
  )
    throw new Error('Invalid reporting object-write plan');
  return createHash('sha256')
    .update(
      canonicalize({
        account_id: plan.account_id,
        destination_ref: plan.destination_ref,
        generation: plan.generation,
        plan_id: plan.plan_id,
        provider: { bucket: plan.provider.bucket, namespace_key: plan.provider.namespace_key },
        objects: plan.objects.map(({ bucket, object_name, sha256, size_bytes }) => ({
          bucket,
          object_name,
          sha256,
          size_bytes,
        })),
      })
    )
    .digest('hex');
}
