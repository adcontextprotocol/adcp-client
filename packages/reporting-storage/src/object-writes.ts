import { createHash } from 'node:crypto';
import { canonicalize } from '@adcp/sdk';

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export class ReportingObjectWriteConflictError extends Error {
  constructor() {
    super('Reporting object-write plan conflict');
    this.name = 'ReportingObjectWriteConflictError';
    Object.defineProperty(this, Symbol.for('adcp.reporting.objectWriteConflict'), { value: true });
  }
}

/**
 * Symbol branding preserves errors when CJS stores are paired with ESM fences.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function isReportingObjectWriteConflictError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as Record<symbol, unknown>)[Symbol.for('adcp.reporting.objectWriteConflict')] === true
  );
}

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export class ReportingObjectWriteNotRevokedError extends Error {
  constructor() {
    super('Reporting object-write generation is not revoked');
    this.name = 'ReportingObjectWriteNotRevokedError';
    Object.defineProperty(this, Symbol.for('adcp.reporting.objectWriteNotRevoked'), { value: true });
  }
}

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function isReportingObjectWriteNotRevokedError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as Record<symbol, unknown>)[Symbol.for('adcp.reporting.objectWriteNotRevoked')] === true
  );
}

/**
 * Non-secret destination identity, scoped to the store's isolated tenant database.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingObjectWriteScopeV1 {
  account_id: string;
  destination_ref: string;
  generation: number;
}

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingObjectWriteV1 {
  bucket: string;
  object_name: string;
  sha256: string;
  size_bytes: number;
}

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingObjectWriteBindingV1 {
  bucket: string;
  /** SHA-256 of a host-owned deployment namespace; immutable per authorization generation. */
  namespace_key: string;
}

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingObjectWriteContextV1 {
  signal?: AbortSignal;
}

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function reportingObjectWriteScopeKey(scope: ReportingObjectWriteScopeV1): string {
  assertReportingObjectWriteScope(scope);
  return createHash('sha256')
    .update(JSON.stringify([scope.account_id, scope.destination_ref, scope.generation]))
    .digest('hex');
}

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
/**
 * Object name of one write. `adcp-reporting/{namespace_key}/{scope_key}/` is the collision-free,
 * account- and generation-scoped prefix every reader and cleanup is fenced to, and
 * `{plan_id}/{index}` keeps each logical delivery distinct across retries. A subscription
 * delivery's expanded `path_template` (`delivery_path`) goes between them:
 * `adcp-reporting/{namespace_key}/{scope_key}/{delivery_path}/{plan_id}/{index}`, so the template
 * names where the data sits inside the generation's prefix without ever escaping it or making
 * two deliveries collide.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function reportingObjectWriteName(
  scope: ReportingObjectWriteScopeV1,
  binding: ReportingObjectWriteBindingV1,
  planId: string,
  index: number,
  path?: string
): string {
  const prefix = `adcp-reporting/${binding.namespace_key}/${reportingObjectWriteScopeKey(scope)}/`;
  if (path === undefined) return `${prefix}${planId}/${index}`;
  assertReportingObjectWritePath(path);
  return `${prefix}${path}/${planId}/${index}`;
}

/**
 * Whether `name` is the object name of write `index` of plan `planId` in this scope, with or
 * without a delivery path. Cleanup and readers use it instead of recomputing a name.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function isReportingObjectWriteName(
  scope: ReportingObjectWriteScopeV1,
  binding: ReportingObjectWriteBindingV1,
  planId: string,
  index: number,
  name: string
): boolean {
  if (typeof name !== 'string') return false;
  if (name === reportingObjectWriteName(scope, binding, planId, index)) return true;
  const prefix = `adcp-reporting/${binding.namespace_key}/${reportingObjectWriteScopeKey(scope)}/`;
  const suffix = `/${planId}/${index}`;
  if (!name.startsWith(prefix) || !name.endsWith(suffix) || name.length <= prefix.length + suffix.length) return false;
  try {
    assertReportingObjectWritePath(name.slice(prefix.length, name.length - suffix.length));
    return true;
  } catch {
    return false;
  }
}

/** A relative path of non-empty segments, none `.` or `..`, from the expanded-template alphabet. */
function assertReportingObjectWritePath(path: string): void {
  if (
    typeof path !== 'string' ||
    path.length < 1 ||
    path.length > 1024 ||
    path
      .split('/')
      .some(segment => !/^[A-Za-z0-9\-._~!$&'()*+,;=:@%]+$/.test(segment) || segment === '.' || segment === '..')
  ) {
    throw new TypeError('Reporting object-write path must be relative segments without . or ..');
  }
}

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingObjectWritePlanV1 extends ReportingObjectWriteScopeV1 {
  provider: ReportingObjectWriteBindingV1;
  /** Stable opaque identity for the same logical delivery across retries. */
  plan_id: string;
  objects: readonly ReportingObjectWriteV1[];
}

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingObjectWriteCursorV1 {
  plan_id: string;
  object_index: number;
}

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
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

/**
 * Apply after REPORTING_MANAGED_DELIVERY_MIGRATION. Additive and independently opt-in.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 * @deprecated Applied by the versioned migrations: run `npx adcp-reporting-storage migrate` (or `migrate(pool)`), which records each version and lets `postgresStorage().checkSchema()` refuse a schema that is behind. Kept for one beta.
 */
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

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function assertReportingObjectWriteScope(scope: ReportingObjectWriteScopeV1): void {
  if (
    !scope ||
    ![scope.account_id, scope.destination_ref].every(v => typeof v === 'string' && v.length > 0 && v.length <= 255) ||
    !Number.isSafeInteger(scope.generation) ||
    scope.generation < 1
  )
    throw new Error('Invalid reporting object-write scope');
}

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
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

/**
 * Opt-in authority for complete provider adapters; the original primitive store port is unchanged.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingObjectWriteAuthorityStoreV1 extends ReportingObjectWriteStoreV1 {
  probeObjectWriteAuthority(context?: ReportingObjectWriteContextV1): Promise<boolean>;
  getObjectWriteAuthorityId(context?: ReportingObjectWriteContextV1): Promise<string>;
  getAuthorizedObjectWriteBinding(
    scope: ReportingObjectWriteScopeV1,
    context?: ReportingObjectWriteContextV1
  ): Promise<ReportingObjectWriteBindingV1 | null>;
  getObjectWritePlan(
    scope: ReportingObjectWriteScopeV1,
    planId: string,
    context?: ReportingObjectWriteContextV1
  ): Promise<ReportingObjectWritePlanV1 | null>;
}

/**
 * PostgreSQL 13+; apply after REPORTING_OBJECT_WRITE_MIGRATION. Identity survives replica/worker restart.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 * @deprecated Applied by the versioned migrations: run `npx adcp-reporting-storage migrate` (or `migrate(pool)`), which records each version and lets `postgresStorage().checkSchema()` refuse a schema that is behind. Kept for one beta.
 */
export const REPORTING_OBJECT_WRITE_AUTHORITY_MIGRATION = `
CREATE TABLE IF NOT EXISTS adcp_reporting_object_write_authority (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  installation_id UUID NOT NULL DEFAULT gen_random_uuid(),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1)
);
INSERT INTO adcp_reporting_object_write_authority (singleton) VALUES (TRUE) ON CONFLICT DO NOTHING;
`;
