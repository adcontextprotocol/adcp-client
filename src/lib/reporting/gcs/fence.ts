import { createHash } from 'node:crypto';
import type { Storage, Bucket } from '@google-cloud/storage';
import {
  assertReportingObjectWriteScope,
  reportingObjectWritePlanFingerprint,
  reportingObjectWriteName,
  reportingObjectWriteScopeKey,
  type ReportingObjectWriteScopeV1,
  type ReportingObjectWritePlanV1,
  type ReportingObjectWriteStoreV1,
} from '../ledger/object-writes';

import { ReportingGcsFenceError, isReportingGcsFenceError } from './errors';
import { activeGcsSignal as active, withGcsDeadline, readGcsBytes } from './io';
import { assertGcsReportingBucketPolicy } from './bucket-policy';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

const TOMBSTONE = 'adcp_reporting_tombstone';

export { ReportingGcsFenceError } from './errors';
export interface GcsReportingObjectFenceV1 {
  probe(context?: { signal?: AbortSignal }): Promise<void>;
  register(
    scope: ReportingObjectWriteScopeV1,
    deliveryId: string,
    bodies: readonly Uint8Array[],
    context?: { signal?: AbortSignal }
  ): Promise<ReportingObjectWritePlanV1>;
  write(
    plan: ReportingObjectWritePlanV1,
    index: number,
    bytes: Uint8Array,
    context: { signal: AbortSignal }
  ): Promise<void>;
  revoke(
    scope: ReportingObjectWriteScopeV1,
    context: { signal: AbortSignal; maxObjects?: number }
  ): Promise<{ fenced: number; complete: boolean }>;
}

/**
 * Provider-side write fence, not a complete Managed Delivery adapter.
 * Derive scope from authenticated host state; these methods do not authorize callers.
 * Bucket configuration must remain managed exclusively by the trusted host.
 * Tombstones and inventory MUST NOT be deleted while stale requests can execute.
 * Inject the official Storage client with host-owned, keyless credentials.
 */
export function createGcsReportingObjectFenceV1(options: {
  storage: Storage;
  store: ReportingObjectWriteStoreV1;
  bucket: string;
  /** Opaque deployment identity, separate from account and destination generations. */
  namespace: string;
  operationDeadlineMilliseconds?: number;
}): GcsReportingObjectFenceV1 {
  if (
    !options ||
    typeof options.bucket !== 'string' ||
    !/^[a-z0-9][a-z0-9.-]{1,220}[a-z0-9]$/.test(options.bucket) ||
    typeof options.namespace !== 'string' ||
    options.namespace.length < 1 ||
    options.namespace.length > 255 ||
    !options.storage ||
    typeof options.storage.bucket !== 'function' ||
    !options.store
  )
    throw new ReportingGcsFenceError('INVALID_INPUT');
  const { storage, store, bucket: bucketName, namespace } = options;
  const deadline = options.operationDeadlineMilliseconds ?? 60_000;
  if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 60_000)
    throw new ReportingGcsFenceError('INVALID_INPUT');
  const provider = { bucket: bucketName, namespace_key: hash(namespace) };
  const status = (error: unknown, code: number) =>
    !!error && typeof error === 'object' && 'code' in error && Number(error.code) === code;

  const bounded = <T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) =>
    withGcsDeadline(work, { signal, milliseconds: deadline });

  async function probe(bucket: Bucket, signal: AbortSignal) {
    active(signal);
    try {
      const [metadata] = await bucket.getMetadata();
      active(signal);
      try {
        assertGcsReportingBucketPolicy(metadata);
      } catch {
        throw new ReportingGcsFenceError('UNSAFE_BUCKET');
      }
    } catch (error) {
      active(signal);
      if (isReportingGcsFenceError(error)) throw error;
      throw new ReportingGcsFenceError('PROVIDER_UNAVAILABLE');
    }
  }

  function assertScope(scope: ReportingObjectWriteScopeV1) {
    try {
      assertReportingObjectWriteScope(scope);
    } catch {
      throw new ReportingGcsFenceError('INVALID_INPUT');
    }
  }
  function assertPlan(plan: ReportingObjectWritePlanV1) {
    try {
      reportingObjectWritePlanFingerprint(plan);
    } catch {
      throw new ReportingGcsFenceError('INVALID_INPUT');
    }
    if (plan.provider.bucket !== bucketName || plan.provider.namespace_key !== provider.namespace_key)
      throw new ReportingGcsFenceError('INVALID_INPUT');
  }

  async function register(
    scope: ReportingObjectWriteScopeV1,
    deliveryId: string,
    bodies: readonly Uint8Array[],
    signal: AbortSignal
  ): Promise<ReportingObjectWritePlanV1> {
    assertScope(scope);
    if (
      typeof deliveryId !== 'string' ||
      deliveryId.length < 1 ||
      deliveryId.length > 255 ||
      !Array.isArray(bodies) ||
      bodies.length < 1 ||
      bodies.length > 128 ||
      bodies.some(b => !(b instanceof Uint8Array) || b.byteLength > 64 * 1024 * 1024) ||
      bodies.reduce((total, b) => total + b.byteLength, 0) > 64 * 1024 * 1024
    )
      throw new ReportingGcsFenceError('INVALID_INPUT');
    const scopeCopy = {
      account_id: scope.account_id,
      destination_ref: scope.destination_ref,
      generation: scope.generation,
    };
    const planId = hash(deliveryId);
    const plan: ReportingObjectWritePlanV1 = {
      ...scopeCopy,
      provider: { ...provider },
      plan_id: planId,
      objects: bodies.map((b, i) => ({
        bucket: bucketName,
        object_name: reportingObjectWriteName(scopeCopy, provider, planId, i),
        sha256: hash(b),
        size_bytes: b.byteLength,
      })),
    };
    await probe(storage.bucket(bucketName), signal);
    active(signal);
    const registered = await store.registerObjectWritePlan(plan, { signal });
    active(signal);
    if (registered === 'revoked') throw new ReportingGcsFenceError('REVOKED');
    return plan;
  }

  async function write(input: ReportingObjectWritePlanV1, index: number, inputBytes: Uint8Array, signal: AbortSignal) {
    const plan = structuredClone(input);
    assertPlan(plan);
    const expected = plan.objects[index];
    if (!Number.isInteger(index) || !expected || !(inputBytes instanceof Uint8Array))
      throw new ReportingGcsFenceError('INVALID_INPUT');
    if (inputBytes.byteLength !== expected.size_bytes) throw new ReportingGcsFenceError('CONTENT_CONFLICT');
    const bytes = Buffer.from(inputBytes);
    if (hash(bytes) !== expected.sha256) throw new ReportingGcsFenceError('CONTENT_CONFLICT');
    active(signal);
    const bucket = storage.bucket(bucketName);
    await probe(bucket, signal);
    active(signal);
    const registered = await store.registerObjectWritePlan(plan, { signal });
    active(signal);
    if (registered === 'revoked') throw new ReportingGcsFenceError('REVOKED');
    const file = bucket.file(expected.object_name);
    try {
      await file.save(bytes, {
        resumable: false,
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: { cacheControl: 'no-store' },
      });
      active(signal);
    } catch (error) {
      active(signal);
      if (!status(error, 412)) throw new ReportingGcsFenceError('PROVIDER_UNAVAILABLE');
      // Lost responses replay only exact frozen bytes, never arbitrary existing objects.
      try {
        const [metadata] = await file.getMetadata();
        active(signal);
        if (metadata.metadata?.[TOMBSTONE] !== undefined) throw new ReportingGcsFenceError('REVOKED');
        const existing = await readGcsBytes(
          bucket.file(expected.object_name, { generation: metadata.generation }),
          bytes.length,
          signal
        );
        if (existing.length !== bytes.length || hash(existing) !== expected.sha256)
          throw new ReportingGcsFenceError('CONTENT_CONFLICT');
      } catch (error) {
        active(signal);
        if (status(error, 404)) {
          const current = await store.registerObjectWritePlan(plan, { signal });
          active(signal);
          if (current === 'revoked') throw new ReportingGcsFenceError('REVOKED');
        }
        if (isReportingGcsFenceError(error)) throw error;
        throw new ReportingGcsFenceError('PROVIDER_UNAVAILABLE');
      }
    }
    // A successful upload is not availability settlement; do not report success for closed state.
    active(signal);
    if ((await store.registerObjectWritePlan(plan, { signal })) === 'revoked')
      throw new ReportingGcsFenceError('REVOKED');
    active(signal);
  }

  async function revoke(scopeInput: ReportingObjectWriteScopeV1, maxObjects: number | undefined, signal: AbortSignal) {
    assertScope(scopeInput);
    const scope = {
      account_id: scopeInput.account_id,
      destination_ref: scopeInput.destination_ref,
      generation: scopeInput.generation,
    };
    const limit = maxObjects ?? 10;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new ReportingGcsFenceError('INVALID_INPUT');
    active(signal);
    const binding = await store.getObjectWriteBinding(scope, { signal });
    active(signal);
    const objects = await store.listRevokedObjectWrites(scope, { limit }, { signal });
    active(signal);
    if (!binding) {
      if (objects.length) throw new ReportingGcsFenceError('STATE_UNAVAILABLE');
      return { fenced: 0, complete: true };
    }
    const bucket = storage.bucket(binding.bucket);
    await probe(bucket, signal);
    const scopeKey = reportingObjectWriteScopeKey(scope);
    for (const object of objects) {
      active(signal);
      if (
        object.bucket !== binding.bucket ||
        object.object_name !== reportingObjectWriteName(scope, binding, object.plan_id, object.object_index)
      )
        throw new ReportingGcsFenceError('STATE_UNAVAILABLE');
      const file = bucket.file(object.object_name);
      let fencedGeneration: string | undefined;
      for (let attempt = 0; attempt < 4 && !fencedGeneration; attempt++) {
        active(signal);
        let generation: string | number = 0;
        try {
          const [metadata] = await file.getMetadata();
          active(signal);
          generation = String(metadata.generation);
          if (metadata.metadata?.[TOMBSTONE] === scopeKey && String(metadata.size) === '0') {
            fencedGeneration = String(metadata.generation);
            break;
          }
        } catch (error) {
          active(signal);
          if (!status(error, 404)) throw new ReportingGcsFenceError('PROVIDER_UNAVAILABLE');
        }
        active(signal);
        try {
          await file.save(Buffer.alloc(0), {
            resumable: false,
            preconditionOpts: { ifGenerationMatch: generation },
            metadata: { cacheControl: 'no-store', metadata: { [TOMBSTONE]: scopeKey } },
          });
          active(signal);
          const [verified] = await file.getMetadata();
          active(signal);
          if (verified.metadata?.[TOMBSTONE] !== scopeKey || String(verified.size) !== '0')
            throw new ReportingGcsFenceError('PROVIDER_UNAVAILABLE');
          fencedGeneration = String(verified.generation);
        } catch (error) {
          active(signal);
          if (isReportingGcsFenceError(error)) throw error;
          if (!status(error, 412)) throw new ReportingGcsFenceError('PROVIDER_UNAVAILABLE');
        }
      }
      if (!fencedGeneration) throw new ReportingGcsFenceError('PROVIDER_UNAVAILABLE');
      active(signal);
      await store.markObjectWriteFenced(
        {
          ...scope,
          plan_id: object.plan_id,
          object_index: object.object_index,
          tombstone_generation: fencedGeneration,
        },
        { signal }
      );
      active(signal);
    }
    const remaining = await store.listRevokedObjectWrites(scope, { limit: 1 }, { signal });
    active(signal);
    return { fenced: objects.length, complete: remaining.length === 0 };
  }

  function requireSignal(context: { signal: AbortSignal } | undefined): AbortSignal {
    if (!(context?.signal instanceof AbortSignal)) throw new ReportingGcsFenceError('INVALID_INPUT');
    return context.signal;
  }
  return {
    probe: async (context?: { signal?: AbortSignal }) =>
      bounded(signal => probe(storage.bucket(bucketName), signal), context?.signal),
    register: async (
      scope: ReportingObjectWriteScopeV1,
      deliveryId: string,
      bodies: readonly Uint8Array[],
      context?: { signal?: AbortSignal }
    ) => bounded(signal => register(scope, deliveryId, bodies, signal), context?.signal),
    write: async (
      plan: ReportingObjectWritePlanV1,
      index: number,
      bytes: Uint8Array,
      context: { signal: AbortSignal }
    ) => bounded(signal => write(plan, index, bytes, signal), requireSignal(context)),
    revoke: async (scope: ReportingObjectWriteScopeV1, context: { signal: AbortSignal; maxObjects?: number }) =>
      bounded(signal => revoke(scope, context.maxObjects, signal), requireSignal(context)),
  };
}
