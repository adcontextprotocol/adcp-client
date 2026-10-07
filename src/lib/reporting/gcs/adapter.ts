import { createHash } from 'node:crypto';
import type { Storage } from '@google-cloud/storage';
import { canonicalize } from '../../utils/jcs';
import type { ReportingResource, ReportingVerification } from '../../types';
import { createReportingManifestInspector } from '../inspection';
import type { ReportingInspectionContext, ExpectedReportingPeriod } from '../reconciliation';
import { createReportingStatusHandler } from '../ledger/handler';
import type { ReportingManagedDeliveryAdapterV1, ReportingManagedDeliveryStore } from '../ledger/managed';
import type { ReportingLedgerStore, ReportingManagedDeliveryBindingV1 } from '../ledger/types';
import {
  reportingObjectWriteName,
  reportingObjectWriteScopeKey,
  type ReportingObjectWriteAuthorityStoreV1,
} from '../ledger/object-writes';
import { createGcsReportingObjectFenceV1 } from './fence';
import { ReportingGcsFenceError } from './errors';
import { activeGcsSignal, withGcsDeadline } from './io';
import { assertExpectedBinding } from './validation';
import {
  createGcsReportingResourceReaderV1,
  createGcsReportingReferenceResolverV1,
  createGcsScopedObjectReadV1,
  type GcsReportingReaderOptionsV1,
  type GcsReportingReadAuthorizationV1,
} from './reader';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
type DeliveryInput = Parameters<ReportingManagedDeliveryAdapterV1['deliver']>[0];
type ReadInput = Parameters<ReportingManagedDeliveryAdapterV1['read']>[0];
const scopeFor = (binding: ReportingManagedDeliveryBindingV1) => ({
  account_id: binding.account_id,
  destination_ref: binding.destination_ref,
  generation: binding.authorization_generation,
});
function deliveryIdentity(input: Pick<DeliveryInput, 'materialization' | 'binding'>): string {
  return hash(
    canonicalize([
      input.binding.configurationId,
      input.binding.delivery_config_id,
      input.binding.delivery_config_version,
      input.materialization.reporting_materialization_id,
      input.materialization.reporting_revision_id,
      input.materialization.reporting_obligation_id,
    ])
  );
}
function matchingBinding(input: Pick<DeliveryInput, 'materialization' | 'binding'>): void {
  const { materialization: m, binding: b } = input;
  if (
    b.method !== 'file_transfer' ||
    b.transport !== 'gcs' ||
    m.method !== b.method ||
    m.transport !== b.transport ||
    m.destination_ref !== b.destination_ref ||
    m.delivery_config_id !== b.delivery_config_id ||
    m.delivery_config_version !== b.delivery_config_version ||
    m.feed_purpose !== b.feed_purpose ||
    !['manifest_checksums', 'canonical_digest'].includes(b.verification_profile) ||
    !Number.isSafeInteger(b.resource_retention_days) ||
    b.resource_retention_days < 1 ||
    b.resource_retention_days > 3650
  )
    throw new ReportingGcsFenceError('INVALID_INPUT');
}

export interface CreateGcsReportingManagedDeliveryAdapterOptionsV1 {
  storage: Storage;
  coreStore: ReportingLedgerStore;
  store: ReportingManagedDeliveryStore & ReportingObjectWriteAuthorityStoreV1;
  bucket: string;
  namespace: string;
  /** Bucket was dedicated and safe before any reporting bytes existed; its policy remains host-controlled. */
  acknowledgeDedicatedFreshBucket: true;
  /** Independently selected contract from authenticated saved host configuration, not returned producer evidence. */
  resolveExpectedPeriod(input: DeliveryInput, context: { signal: AbortSignal }): Promise<ExpectedReportingPeriod>;
  /** Exact saved private-contract scope, with principal and bucket/prefix ownership checks. */
  resolveContractReader(input: DeliveryInput, context: { signal: AbortSignal }): Promise<GcsReportingReaderOptionsV1>;
  operationDeadlineMilliseconds?: number;
  minimumResourceRetentionDays?: number;
}

/** Complete file-transfer adapter. Availability and cleanup lease commits remain with the managed runtime. */
export async function createGcsReportingManagedDeliveryAdapterV1(
  options: CreateGcsReportingManagedDeliveryAdapterOptionsV1,
  context: { signal?: AbortSignal } = {}
): Promise<ReportingManagedDeliveryAdapterV1> {
  const milliseconds = options.operationDeadlineMilliseconds ?? 60_000;
  const { resolveExpectedPeriod, resolveContractReader, namespace: hostNamespace } = options;
  const minimumDays = options.minimumResourceRetentionDays ?? 1;
  if (
    options.acknowledgeDedicatedFreshBucket !== true ||
    typeof hostNamespace !== 'string' ||
    hostNamespace.length < 1 ||
    hostNamespace.length > 255 ||
    !Number.isSafeInteger(minimumDays) ||
    minimumDays < 1 ||
    minimumDays > 3650 ||
    typeof options.resolveExpectedPeriod !== 'function' ||
    typeof options.resolveContractReader !== 'function'
  )
    throw new ReportingGcsFenceError('INVALID_INPUT');
  const { storage, coreStore, store, bucket } = options;
  const { id, fence } = await withGcsDeadline(
    async signal => {
      if ((await store.probeObjectWriteAuthority({ signal })) !== true)
        throw new ReportingGcsFenceError('STATE_UNAVAILABLE');
      activeGcsSignal(signal);
      if ((await store.probe(coreStore)) !== true) throw new ReportingGcsFenceError('STATE_UNAVAILABLE');
      activeGcsSignal(signal);
      const id = await store.getObjectWriteAuthorityId({ signal });
      activeGcsSignal(signal);
      const fence = createGcsReportingObjectFenceV1({
        storage,
        store,
        bucket,
        namespace: hash(canonicalize([hostNamespace, id])),
        operationDeadlineMilliseconds: milliseconds,
      });
      await fence.probe({ signal });
      activeGcsSignal(signal);
      return { id, fence };
    },
    { signal: context.signal, milliseconds }
  );
  const getStatus = createReportingStatusHandler(coreStore);
  async function readerOptions(
    binding: ReportingManagedDeliveryBindingV1,
    signal: AbortSignal
  ): Promise<GcsReportingReaderOptionsV1> {
    const scope = scopeFor(binding);
    const provider = await store.getAuthorizedObjectWriteBinding(scope, { signal });
    activeGcsSignal(signal);
    if (!provider) throw new ReportingGcsFenceError('REVOKED');
    const prefix = `adcp-reporting/${provider.namespace_key}/${reportingObjectWriteScopeKey(scope)}/`;
    return {
      scope: { ...scope, principal_id: `producer:${id}` },
      bucket: provider.bucket,
      objectPrefix: prefix,
      getStorage: async () => storage,
      authorize: async (request: GcsReportingReadAuthorizationV1, call) => {
        if (
          request.bucket !== provider.bucket ||
          request.objectPrefix !== prefix ||
          request.scope.principal_id !== `producer:${id}` ||
          request.scope.account_id !== scope.account_id ||
          request.scope.destination_ref !== scope.destination_ref ||
          request.scope.generation !== scope.generation
        )
          return false;
        const current = await store.getAuthorizedObjectWriteBinding(scope, { signal: call.signal });
        return current?.bucket === provider.bucket && current.namespace_key === provider.namespace_key;
      },
      operationDeadlineMilliseconds: milliseconds,
    };
  }
  async function trueObligation(
    input: DeliveryInput,
    signal: AbortSignal
  ): Promise<ReportingInspectionContext['obligation']> {
    let cursor: string | undefined;
    for (let page = 0; page < 25; page++) {
      activeGcsSignal(signal);
      const status = await getStatus(
        {
          account: { account_id: input.binding.account_id },
          view: 'periods',
          delivery_config_ids: [input.binding.delivery_config_id],
          period: input.revision.wireRevision.period,
          pagination: { max_results: 100, ...(cursor ? { cursor } : {}) },
        },
        { account: { id: input.binding.account_id, account_id: input.binding.account_id }, signal }
      );
      activeGcsSignal(signal);
      const selected = status.periods?.find(
        value => value.reporting_obligation_id === input.obligation.reporting_obligation_id
      );
      if (selected) return selected;
      cursor = status.pagination?.cursor;
      if (!cursor) break;
    }
    throw new ReportingGcsFenceError('STATE_UNAVAILABLE');
  }
  async function hostCallback<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    try {
      const result = await work();
      activeGcsSignal(signal);
      return result;
    } catch {
      activeGcsSignal(signal);
      throw new ReportingGcsFenceError('HOST_CALLBACK_FAILED');
    }
  }
  return {
    verificationProfiles: Object.freeze(['manifest_checksums', 'canonical_digest'] as const),
    revocationFencesDeliveryGenerations: true,
    async deliver(caller, call) {
      return withGcsDeadline(
        async signal => {
          matchingBinding(caller);
          if (
            !Number.isSafeInteger(caller.maxBytes) ||
            caller.maxBytes < 1 ||
            caller.maxBytes > 64 * 1024 * 1024 ||
            caller.revision.binding.byteCount > caller.maxBytes ||
            caller.revision.rows.length > 100_000
          )
            throw new ReportingGcsFenceError('INVALID_INPUT');
          const input = structuredClone(caller);
          matchingBinding(input);
          if (
            input.revision.rows.length > 100_000 ||
            input.revision.binding.byteCount > input.maxBytes ||
            !Number.isSafeInteger(input.maxBytes) ||
            input.maxBytes < 1 ||
            input.maxBytes > 64 * 1024 * 1024
          )
            throw new ReportingGcsFenceError('INVALID_INPUT');
          const { revision, binding, materialization, obligation } = input;
          if (
            revision.reporting_revision_id !== materialization.reporting_revision_id ||
            revision.reporting_obligation_id !== obligation.reporting_obligation_id ||
            materialization.reporting_obligation_id !== obligation.reporting_obligation_id ||
            obligation.account.account_id !== binding.account_id ||
            obligation.configurationId !== binding.configurationId ||
            obligation.delivery_config_id !== binding.delivery_config_id ||
            obligation.delivery_config_version !== binding.delivery_config_version
          )
            throw new ReportingGcsFenceError('INVALID_INPUT');
          const coreBytes = Buffer.from(
            canonicalize({
              reporting_revision_id: revision.reporting_revision_id,
              row_count: revision.wireRevision.row_count,
              control_totals: revision.wireRevision.control_totals,
              reporting_rows: revision.rows,
            })
          );
          if (
            revision.binding.algorithm !== 'rfc8785_jcs_v1' ||
            coreBytes.length !== revision.binding.byteCount ||
            hash(coreBytes) !== revision.binding.sha256 ||
            revision.wireRevision.revision_content_sha256 !== revision.binding.sha256 ||
            revision.binding.rowCount !== revision.rows.length ||
            revision.wireRevision.row_count !== revision.rows.length
          )
            throw new ReportingGcsFenceError('CONTENT_CONFLICT');
          const expected = await hostCallback(async () => {
            const value = structuredClone(await resolveExpectedPeriod(structuredClone(input), { signal }));
            if (
              !value ||
              typeof value !== 'object' ||
              !Array.isArray(value.mediaBuyIds) ||
              !value.coverage ||
              typeof value.coverage !== 'object' ||
              Array.isArray(value.coverage) ||
              (value.verificationProfile === 'canonical_digest' &&
                (!value.canonicalization || typeof value.canonicalization !== 'object'))
            )
              throw new ReportingGcsFenceError('HOST_CALLBACK_FAILED');
            return value;
          }, signal);
          activeGcsSignal(signal);
          assertExpectedBinding(input, expected);
          const actualObligation = await trueObligation(input, signal);
          const contractOptions = await hostCallback(
            () => resolveContractReader(structuredClone(input), { signal }),
            signal
          );
          activeGcsSignal(signal);
          if (!contractOptions || typeof contractOptions !== 'object' || !contractOptions.scope)
            throw new ReportingGcsFenceError('HOST_CALLBACK_FAILED');
          let contractResolver;
          try {
            contractResolver = createGcsReportingReferenceResolverV1({
              ...contractOptions,
              signal: contractOptions.signal ? AbortSignal.any([signal, contractOptions.signal]) : signal,
            });
          } catch {
            throw new ReportingGcsFenceError('HOST_CALLBACK_FAILED');
          }
          if (
            contractOptions.scope.account_id !== binding.account_id ||
            contractOptions.scope.destination_ref !== binding.destination_ref ||
            contractOptions.scope.generation !== binding.authorization_generation
          )
            throw new ReportingGcsFenceError('INVALID_INPUT');
          const rows = Buffer.from(revision.rows.map(row => canonicalize(row) + '\n').join(''));
          const manifestBytes = Buffer.from(
            canonicalize({
              manifest_version: '1.0',
              complete: true,
              reporting_revision_id: revision.reporting_revision_id,
              reporting_obligation_id: obligation.reporting_obligation_id,
              reporting_materialization_id: materialization.reporting_materialization_id,
              period: revision.wireRevision.period,
              format: 'jsonl',
              compression: 'none',
              files: [
                { object_ref: '0', size_bytes: rows.length, sha256: hash(rows), row_count: revision.rows.length },
              ],
              total_size_bytes: rows.length,
              row_count: revision.rows.length,
              control_totals: revision.wireRevision.control_totals,
              created_at: revision.createdAt,
            })
          );
          if (rows.length + manifestBytes.length > input.maxBytes) throw new ReportingGcsFenceError('INVALID_INPUT');
          const scope = scopeFor(binding);
          const plan = await fence.register(scope, deliveryIdentity(input), [rows, manifestBytes], { signal });
          activeGcsSignal(signal);
          await fence.write(plan, 0, rows, { signal });
          await fence.write(plan, 1, manifestBytes, { signal });
          activeGcsSignal(signal);
          const readerConfig = await readerOptions(binding, signal);
          const location = `https://storage.googleapis.com/${plan.provider.bucket}/${plan.objects[1]!.object_name}`;
          const read = await createGcsScopedObjectReadV1(readerConfig)(location, input.maxBytes, signal);
          activeGcsSignal(signal);
          if (hash(read.body) !== hash(manifestBytes)) throw new ReportingGcsFenceError('CONTENT_CONFLICT');
          const resource: ReportingResource = {
            resource_ref: `gcs:${plan.plan_id}`,
            kind: 'manifest',
            location,
            manifest_version: '1.0',
            manifest_sha256: hash(read.body),
            immutability: 'native_version',
            native_version_ref: read.generation,
            expires_at: new Date(
              Date.now() + Math.max(minimumDays, binding.resource_retention_days) * 86_400_000
            ).toISOString(),
            reader_compatibility: ['jsonl', 'utf-8'],
          };
          const inspectionContext: ReportingInspectionContext = {
            obligation: actualObligation,
            revision: revision.wireRevision,
            materialization: { ...materialization, resource },
            expected,
          };
          const reader = createGcsReportingResourceReaderV1(readerConfig);
          const observedChecksums = new Map<string, NonNullable<ReportingVerification['physical_checksums']>[number]>();
          const inspect = createReportingManifestInspector({
            reader: {
              async read(request) {
                const result = await reader.read({
                  ...request,
                  signal: request.signal ? AbortSignal.any([signal, request.signal]) : signal,
                });
                activeGcsSignal(signal);
                if (request.role === 'object')
                  observedChecksums.set(request.objectRef!, {
                    object_ref: request.objectRef!,
                    algorithm: 'sha256',
                    value: hash(result.body),
                  });
                return result;
              },
            },
            referenceResolver: contractResolver,
            referenceAllowedOrigins: ['https://storage.googleapis.com'],
            maxTotalBytes: input.maxBytes,
            maxObjectBytes: input.maxBytes,
            maxRows: 100_000,
          });
          const observation = await inspect(inspectionContext);
          activeGcsSignal(signal);
          if (!observedChecksums.size) throw new ReportingGcsFenceError('CONTENT_CONFLICT');
          resource.expires_at = new Date(
            Date.now() + Math.max(minimumDays, binding.resource_retention_days) * 86_400_000 + milliseconds
          ).toISOString();
          const checksums = [...observedChecksums.values()];
          if (
            checksums.length !== 1 ||
            checksums[0]!.object_ref !== '0' ||
            checksums[0]!.value !== plan.objects[0]!.sha256
          )
            throw new ReportingGcsFenceError('CONTENT_CONFLICT');
          const verification: ReportingVerification = {
            verified_at: new Date().toISOString(),
            verification_path: 'producer',
            verification_profile: binding.verification_profile,
            row_count: observation.rowCount,
            control_totals: observation.controlTotals,
            physical_checksums: [checksums[0]!, ...checksums.slice(1)],
            ...(observation.canonicalContentDigest
              ? { canonical_content_digest: observation.canonicalContentDigest }
              : {}),
          };
          if (!(await store.getAuthorizedObjectWriteBinding(scope, { signal })))
            throw new ReportingGcsFenceError('REVOKED');
          activeGcsSignal(signal);
          return { status: 'available' as const, resource, verification };
        },
        { signal: call.signal, milliseconds }
      );
    },
    async read(caller: ReadInput, call) {
      return withGcsDeadline(
        async signal => {
          const input = structuredClone(caller);
          matchingBinding(input);
          const planId = hash(deliveryIdentity(input));
          const scope = scopeFor(input.binding);
          const plan = await store.getObjectWritePlan(scope, planId, { signal });
          activeGcsSignal(signal);
          if (!plan) throw new ReportingGcsFenceError('REVOKED');
          const location = `https://storage.googleapis.com/${plan.provider.bucket}/${reportingObjectWriteName(scope, plan.provider, planId, 1)}`;
          if (
            plan.objects.length !== 2 ||
            input.resource.resource_ref !== `gcs:${planId}` ||
            input.resource.location !== location ||
            input.resource.kind !== 'manifest' ||
            input.resource.immutability !== 'native_version' ||
            !input.resource.native_version_ref ||
            !Number.isFinite(Date.parse(input.resource.expires_at ?? '')) ||
            input.resource.manifest_sha256 !== plan.objects[1]?.sha256
          )
            throw new ReportingGcsFenceError('INVALID_INPUT');
          const config = await readerOptions(input.binding, signal);
          const result = await createGcsScopedObjectReadV1(config)(
            location,
            input.maxBytes,
            signal,
            input.resource.native_version_ref
          );
          if (hash(result.body) !== input.resource.manifest_sha256)
            throw new ReportingGcsFenceError('CONTENT_CONFLICT');
          return result.body;
        },
        { signal: call.signal, milliseconds }
      );
    },
    async revoke(input, call) {
      await withGcsDeadline(
        async signal => {
          for (let page = 0; page < 1000; page++) {
            activeGcsSignal(signal);
            const result = await fence.revoke(input.authorization, { signal });
            if (result.complete) return;
            if (result.fenced < 1) throw new ReportingGcsFenceError('STATE_UNAVAILABLE');
          }
          throw new ReportingGcsFenceError('STATE_UNAVAILABLE');
        },
        { signal: call.signal, milliseconds }
      );
    },
  };
}
