import { createHash } from 'node:crypto';

import type { ReportingAdjustmentReceipt, ReportingReceipt, SyncReportingReceiptsResponse } from '../../types';
import { canonicalize } from '../../utils/jcs';
import { isReportingAdjustmentReceiptEvidence, isReportingReceiptEvidence } from '../evidence';
import type { AdcpToolMap } from '../../server/create-adcp-server';
import { AdcpError } from '../../server/decisioning/async-outcome';
import type { PrincipalRef, ReportingManagedDeliveryBindingV1, ReportingSubscriptionReceiptAdmissionV1 } from './types';

/** RC3 `maxItems` on `receipts` and on `adjustment_receipts`, applied separately. */
const MAX_RECEIPTS_PER_ARRAY = 100;
/** RC3 `maxItems` on the response `results` array. */
const MAX_RECEIPT_RESULTS = 100;
/** Maximum serialized size of one receipt evidence item. */
const MAX_RECEIPT_EVIDENCE_BYTES = 64 * 1024;

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export type ReportingReceiptBatchEntryV1 =
  | { kind: 'revision'; receipt: ReportingReceipt }
  | { kind: 'adjustment'; receipt: ReportingAdjustmentReceipt };

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingReceiptBatchInputV1 {
  account_id: string;
  consumer_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  entries: ReportingReceiptBatchEntryV1[];
  received_at: string;
  /**
   * Who may file against which obligation (experimental, AdCP 3.3). A store that sets
   * `receiptAdmission` applies `reportingSubscriptionReceiptAdmissibleV1` to every entry after
   * resolving its obligation and revision, and answers a refused entry exactly like an unknown
   * reference. Absent when subscriptions are off.
   */
  admission?: ReportingSubscriptionReceiptAdmissionV1;
}

/** The `sync_reporting_receipts` request as the server framework hands it to a handler. */
export type SyncReportingReceiptsParamsV1 = AdcpToolMap['sync_reporting_receipts']['params'];

/**
 * The one store method `sync_reporting_receipts` needs. A managed-delivery store implements it as
 * part of its full contract; the protocol handler depends on nothing else, so it works against any
 * store that can record receipts.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingReceiptSyncStoreV1 {
  syncReceiptBatch(input: ReportingReceiptBatchInputV1): Promise<SyncReportingReceiptsResponse['results']>;
  /** True when the store enforces `ReportingReceiptBatchInputV1.admission`. */
  readonly receiptAdmission?: true;
}

/**
 * Protocol handler for `sync_reporting_receipts`. Works against any `ReportingReceiptSyncStoreV1`.
 *
 * With `resolveSubscriptionPrincipal` (experimental, AdCP 3.3), a subscription obligation accepts
 * receipts only from its owning principal; see `reportingSubscriptionReceiptAdmissibleV1`. The
 * host's account resolution and `allowed_tasks` still decide who reaches the handler at all.
 */
export function createSyncReportingReceiptsHandler<TContext extends { account?: unknown }>(
  store: ReportingReceiptSyncStoreV1,
  resolveConsumerId: (context: TContext) => string | Promise<string>,
  now: () => Date = () => new Date(),
  options: {
    resolveSubscriptionPrincipal?: (context: TContext) => PrincipalRef | Promise<PrincipalRef>;
  } = {}
) {
  if (options.resolveSubscriptionPrincipal && store.receiptAdmission !== true) {
    throw new TypeError('Scoping receipts to subscription owners requires a store that enforces receipt admission');
  }
  return async (request: SyncReportingReceiptsParamsV1, context: TContext): Promise<SyncReportingReceiptsResponse> => {
    const account_id = resolvedAccountId(context.account);
    let admission: ReportingSubscriptionReceiptAdmissionV1 | undefined;
    if (options.resolveSubscriptionPrincipal) {
      const resolved = await options.resolveSubscriptionPrincipal(context);
      admission = { principal: { tenantId: resolved.tenantId, principalId: resolved.principalId } };
    }
    const consumer_id = await resolveConsumerId(context);
    if (!consumer_id || consumer_id.length > 255) {
      throw new TypeError('resolveConsumerId must return a durable authenticated principal of at most 255 characters');
    }
    // These handlers are exported and adopters call them directly, and
    // `requestValidationMode` defaults to 'off' in production, so the framework
    // cannot be assumed to have shape-checked anything. Refuse a malformed
    // request with the repository's typed envelope instead of letting a
    // TypeError escape from `.map` or a destructure.
    if (request.receipts !== undefined && !Array.isArray(request.receipts)) {
      throw new AdcpError('VALIDATION_ERROR', { message: 'sync_reporting_receipts receipts must be an array' });
    }
    if (request.adjustment_receipts !== undefined && !Array.isArray(request.adjustment_receipts)) {
      throw new AdcpError('VALIDATION_ERROR', {
        message: 'sync_reporting_receipts adjustment_receipts must be an array',
      });
    }
    const revisionReceipts = request.receipts ?? [];
    const adjustmentReceipts = request.adjustment_receipts ?? [];
    if (!revisionReceipts.every(isRecord) || !adjustmentReceipts.every(isRecord)) {
      throw new AdcpError('VALIDATION_ERROR', {
        message: 'sync_reporting_receipts entries must be objects',
      });
    }
    // RC3 caps `receipts` and `adjustment_receipts` at 100 each in JSON Schema,
    // so each array is checked against its own cap. An over-cap array cannot be
    // answered per item either, because `results` is itself capped at 100, so
    // it is refused as a request error rather than as a non-conformant body.
    // The separate combined bound is enforced below.
    if (revisionReceipts.length > MAX_RECEIPTS_PER_ARRAY || adjustmentReceipts.length > MAX_RECEIPTS_PER_ARRAY) {
      throw new AdcpError('VALIDATION_ERROR', {
        message:
          `sync_reporting_receipts accepts at most ${MAX_RECEIPTS_PER_ARRAY} receipts and ` +
          `${MAX_RECEIPTS_PER_ARRAY} adjustment receipts per request`,
      });
    }
    // `received_at` is server-authoritative: the request schema does not
    // allow it, and this handler stamps it from the database clock. Stripping
    // a caller-supplied one before validating meant a payload the schema
    // forbids — `received_at: 'invalid'` beside an otherwise valid receipt —
    // was silently repaired and stored. Refuse the request instead; sanitising
    // input the contract rejects hides the caller's bug and makes the two
    // validation paths disagree about what a valid request is.
    if ([...revisionReceipts, ...adjustmentReceipts].some(receipt => 'received_at' in receipt)) {
      throw new AdcpError('VALIDATION_ERROR', {
        message: 'sync_reporting_receipts receipts must not carry received_at; it is assigned by the server',
      });
    }
    const entries: ReportingReceiptBatchEntryV1[] = [
      ...revisionReceipts.map(receipt => ({ kind: 'revision' as const, receipt: receipt as ReportingReceipt })),
      ...adjustmentReceipts.map(receipt => ({
        kind: 'adjustment' as const,
        receipt: receipt as ReportingAdjustmentReceipt,
      })),
    ];
    // RC3 bounds the batch as a whole too, in the request's
    // `x-adcp-validation.batch_identity`: receipt ids "MUST be unique across
    // receipts and adjustment_receipts, whose combined length MUST NOT exceed
    // 100". That bound is normative prose: JSON Schema encodes only the two
    // per-array caps, and `x-adcp-validation` is registered as an AJV keyword
    // for commercial-terms only, not on the reporting validation path. So this
    // check is the only thing enforcing it — do not delete it as redundant
    // with schema validation. A 200-entry request is schema-clean but
    // spec-invalid, and unanswerable regardless, since `results` is capped at
    // 100 while one result per submitted receipt is required.
    if (entries.length > MAX_RECEIPT_RESULTS) {
      throw new AdcpError('VALIDATION_ERROR', {
        message:
          `sync_reporting_receipts can return at most ${MAX_RECEIPT_RESULTS} results, so a request may carry at most ` +
          `${MAX_RECEIPT_RESULTS} receipts and adjustment receipts in total`,
      });
    }
    // RC3 requires `results` minItems 1 and the request anyOf requires a
    // non-empty array, so an empty batch has no legal response body either.
    // This is checked before every per-entry refusal below, because those
    // answer with one result per entry: an empty batch that also named the
    // wrong account returned `results: []`, which is schema-invalid, so the
    // caller got a malformed body instead of a typed error.
    if (!entries.length) {
      throw new AdcpError('VALIDATION_ERROR', {
        message: 'sync_reporting_receipts requires at least one receipt or adjustment receipt',
      });
    }
    if (request.account && 'account_id' in request.account && request.account.account_id !== account_id) {
      return receiptBatchFailure(entries, 'PERMISSION_DENIED', 'Reporting receipt account is unavailable');
    }
    if (!/^[A-Za-z0-9_.:-]{16,255}$/.test(request.idempotency_key)) {
      return receiptBatchFailure(entries, 'VALIDATION_ERROR', 'sync_reporting_receipts idempotency_key is invalid');
    }
    // Duplicate identity is a property of the submitted batch, not of the
    // subset that happens to be well formed. Checking it after filtering let
    // one valid and one malformed entry share a receipt id and still mutate
    // state, which is exactly the collision the rule exists to stop.
    const submittedIds = entries.map(entry =>
      isRecord(entry.receipt) && typeof entry.receipt.reporting_receipt_id === 'string'
        ? entry.receipt.reporting_receipt_id
        : ''
    );
    const duplicateSubmittedIds = new Set(
      submittedIds.filter((value, index) => value !== '' && submittedIds.indexOf(value) !== index)
    );
    if (duplicateSubmittedIds.size) {
      return receiptBatchFailure(
        entries,
        'VALIDATION_ERROR',
        'sync_reporting_receipts receipt IDs must be unique across the batch'
      );
    }
    const evidenceValid = entries.map(entry =>
      entry.kind === 'revision'
        ? isReportingReceiptEvidence(entry.receipt)
        : isReportingAdjustmentReceiptEvidence(entry.receipt)
    );
    const oversized = entries.map(
      entry => Buffer.byteLength(JSON.stringify(entry.receipt), 'utf8') > MAX_RECEIPT_EVIDENCE_BYTES
    );
    const valid = entries.map((_, index) => evidenceValid[index] && !oversized[index]);
    const validEntries = entries.filter((_, index) => valid[index]);
    const request_fingerprint = sha256({ entries });
    const stored = validEntries.length
      ? await store.syncReceiptBatch({
          account_id,
          consumer_id,
          idempotency_key: request.idempotency_key,
          request_fingerprint,
          entries: validEntries,
          received_at: now().toISOString(),
          ...(admission ? { admission } : {}),
        })
      : [];
    let storedIndex = 0;
    return {
      status: 'completed',
      results: entries.map((entry, index) => {
        if (valid[index]) return stored[storedIndex++]!;
        const field =
          entry.kind === 'revision' ? `receipts[${index}]` : `adjustment_receipts[${index - revisionReceipts.length}]`;
        return oversized[index]
          ? receiptFailure(
              reflectableReceiptId(entry.receipt.reporting_receipt_id, index),
              'VALIDATION_ERROR',
              'Reporting receipt evidence exceeds the 64 KiB limit',
              {
                field,
                suggestion: `Reduce ${field} to 64 KiB or less and retry.`,
              }
            )
          : receiptFailure(
              reflectableReceiptId(entry.receipt.reporting_receipt_id, index),
              'VALIDATION_ERROR',
              'Reporting receipt evidence is malformed',
              {
                field,
                suggestion: `Correct ${field} to satisfy the reporting receipt evidence schema and retry.`,
              }
            );
      }),
    };
  };
}

function receiptBatchFailure(
  entries: ReportingReceiptBatchEntryV1[],
  code: 'PERMISSION_DENIED' | 'VALIDATION_ERROR',
  message: string
): SyncReportingReceiptsResponse {
  return {
    status: 'completed',
    results: entries.map((entry, index) =>
      receiptFailure(reflectableReceiptId(entry.receipt.reporting_receipt_id, index), code, message)
    ),
  };
}

const RECEIPT_ID_PATTERN = /^[A-Za-z0-9_.:-]{16,255}$/;

/**
 * `results[].reporting_receipt_id` is pattern- and length-constrained, so a
 * caller-supplied id can only be echoed when it already satisfies the wire
 * contract. Anything else — absent, non-string, 3,000 characters, or carrying
 * characters outside the class — is replaced by a positional placeholder, which
 * keeps a malformed request from steering the shape of our own response.
 */
function reflectableReceiptId(value: unknown, index: number): string {
  return typeof value === 'string' && RECEIPT_ID_PATTERN.test(value)
    ? value
    : `unidentified-reporting-receipt-${String(index).padStart(3, '0')}`;
}

function receiptFailure(
  reporting_receipt_id: string,
  code: 'PERMISSION_DENIED' | 'VALIDATION_ERROR',
  message: string,
  metadata: { field?: string; suggestion?: string } = {}
): SyncReportingReceiptsResponse['results'][number] {
  return {
    result: 'failed',
    reporting_receipt_id,
    errors: [{ code, message, recovery: 'correctable', ...metadata }],
  };
}

function resolvedAccountId(account: unknown): string {
  if (!account || typeof account !== 'object') throw new Error('Reporting receipts require a resolved account');
  const value = account as { id?: unknown; account_id?: unknown };
  const id = typeof value.id === 'string' ? value.id : typeof value.account_id === 'string' ? value.account_id : '';
  if (!id) throw new Error('Reporting receipts require a resolved account');
  return id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value: unknown): string {
  return createHash('sha256')
    .update(canonicalize(value === undefined ? null : value))
    .digest('hex');
}

/**
 * Stable helper for immutable binding creation.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function reportingManagedDeliveryBindingV1(
  input: Omit<ReportingManagedDeliveryBindingV1, 'created_at' | 'semantic_fingerprint'> & { created_at?: string }
): ReportingManagedDeliveryBindingV1 {
  const created_at = input.created_at ?? new Date().toISOString();
  // Derive from semantic content only. Deriving a new binding by spreading an
  // existing one is the documented pattern, and that carries the predecessor's
  // `semantic_fingerprint` in as an ordinary field — which used to be folded
  // into the digest, so the helper produced a value the store's own
  // `managedBindingFingerprint` could never reproduce. The store now recomputes
  // before it compares anything, so the two must agree exactly.
  const { semantic_fingerprint: _predecessor, ...semantic } = input as typeof input & {
    semantic_fingerprint?: string;
  };
  const semantic_fingerprint = sha256({ ...semantic, created_at: undefined });
  return { ...semantic, created_at, semantic_fingerprint };
}
