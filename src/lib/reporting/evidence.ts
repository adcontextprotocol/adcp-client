const CONTROL_TOTAL_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const CANONICAL_DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const SHA256_HEX = /^[A-Fa-f0-9]{64}$/;
const SHA512_HEX = /^[A-Fa-f0-9]{128}$/;
const REPORTING_ID = /^[A-Za-z0-9_.:-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => value[key] !== undefined) && Object.keys(value).every(key => allowed.has(key));
}

function isOffsetDateTime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.includes('T') &&
    /(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function isReportingControlTotals(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const names = new Set<string>();
  for (const total of value) {
    if (
      !isRecord(total) ||
      !hasExactKeys(total, ['name', 'value', 'value_type'], ['unit']) ||
      typeof total.name !== 'string' ||
      !CONTROL_TOTAL_NAME.test(total.name) ||
      names.has(total.name) ||
      typeof total.value !== 'string' ||
      !CANONICAL_DECIMAL.test(total.value) ||
      !['integer', 'decimal'].includes(String(total.value_type)) ||
      (total.value_type === 'integer' && total.value.includes('.')) ||
      (total.unit !== undefined && (typeof total.unit !== 'string' || total.unit.length < 1 || total.unit.length > 32))
    ) {
      return false;
    }
    names.add(total.name);
  }
  return true;
}

export function isReportingCanonicalDigest(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'algorithm',
      'value',
      'canonicalization_id',
      'canonicalization_uri',
      'canonicalization_sha256',
    ]) &&
    value.algorithm === 'sha256' &&
    typeof value.value === 'string' &&
    SHA256_HEX.test(value.value) &&
    typeof value.canonicalization_id === 'string' &&
    value.canonicalization_id.length >= 1 &&
    value.canonicalization_id.length <= 128 &&
    typeof value.canonicalization_uri === 'string' &&
    value.canonicalization_uri.startsWith('https://') &&
    typeof value.canonicalization_sha256 === 'string' &&
    SHA256_HEX.test(value.canonicalization_sha256)
  );
}

function isPhysicalChecksums(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      checksum =>
        isRecord(checksum) &&
        hasExactKeys(checksum, ['object_ref', 'algorithm', 'value']) &&
        typeof checksum.object_ref === 'string' &&
        checksum.object_ref.length >= 1 &&
        checksum.object_ref.length <= 1024 &&
        ((checksum.algorithm === 'sha256' && typeof checksum.value === 'string' && SHA256_HEX.test(checksum.value)) ||
          (checksum.algorithm === 'sha512' && typeof checksum.value === 'string' && SHA512_HEX.test(checksum.value)))
    )
  );
}

export function isReportingVerificationEvidence(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['verified_at', 'verification_path', 'verification_profile', 'row_count', 'control_totals'],
      ['canonical_content_digest', 'physical_checksums', 'native_commit_evidence']
    ) ||
    !isOffsetDateTime(value.verified_at) ||
    !['producer', 'representative_consumer', 'destination'].includes(String(value.verification_path)) ||
    !['native_commit', 'manifest_checksums', 'canonical_digest'].includes(String(value.verification_profile)) ||
    !Number.isSafeInteger(value.row_count) ||
    Number(value.row_count) < 0 ||
    !isReportingControlTotals(value.control_totals) ||
    (value.canonical_content_digest !== undefined && !isReportingCanonicalDigest(value.canonical_content_digest)) ||
    (value.physical_checksums !== undefined && !isPhysicalChecksums(value.physical_checksums))
  ) {
    return false;
  }
  if (value.native_commit_evidence !== undefined) {
    const native = value.native_commit_evidence;
    if (
      !isRecord(native) ||
      !hasExactKeys(native, ['native_version_ref', 'observed_through']) ||
      typeof native.native_version_ref !== 'string' ||
      native.native_version_ref.length < 1 ||
      native.native_version_ref.length > 512 ||
      !['representative_consumer', 'destination'].includes(String(native.observed_through))
    ) {
      return false;
    }
  }
  if (value.verification_profile === 'native_commit') return value.native_commit_evidence !== undefined;
  if (value.verification_profile === 'manifest_checksums') return isPhysicalChecksums(value.physical_checksums);
  return isReportingCanonicalDigest(value.canonical_content_digest);
}

export function isReportingReceiptEvidence(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        'reporting_receipt_id',
        'reporting_obligation_id',
        'reporting_revision_id',
        'reporting_materialization_id',
        'status',
        'verification_profile',
        'observed_row_count',
        'observed_control_totals',
        'observed_at',
      ],
      [
        'observed_canonical_content_digest',
        'observed_manifest_sha256',
        'observed_native_version_ref',
        'consumer_commit_ref',
        'rejection_codes',
        'received_at',
      ]
    )
  ) {
    return false;
  }
  const ids = [
    value.reporting_receipt_id,
    value.reporting_obligation_id,
    value.reporting_revision_id,
    value.reporting_materialization_id,
  ];
  if (
    !ids.every(id => typeof id === 'string' && id.length >= 1 && id.length <= 255 && REPORTING_ID.test(id)) ||
    typeof value.reporting_receipt_id !== 'string' ||
    value.reporting_receipt_id.length < 16 ||
    !['accepted', 'rejected'].includes(String(value.status)) ||
    !['native_commit', 'manifest_checksums', 'canonical_digest'].includes(String(value.verification_profile)) ||
    !Number.isSafeInteger(value.observed_row_count) ||
    Number(value.observed_row_count) < 0 ||
    !isReportingControlTotals(value.observed_control_totals) ||
    !isOffsetDateTime(value.observed_at) ||
    (value.received_at !== undefined && !isOffsetDateTime(value.received_at)) ||
    (value.observed_canonical_content_digest !== undefined &&
      !isReportingCanonicalDigest(value.observed_canonical_content_digest)) ||
    (value.observed_manifest_sha256 !== undefined &&
      (typeof value.observed_manifest_sha256 !== 'string' || !SHA256_HEX.test(value.observed_manifest_sha256))) ||
    (value.observed_native_version_ref !== undefined &&
      (typeof value.observed_native_version_ref !== 'string' ||
        value.observed_native_version_ref.length < 1 ||
        value.observed_native_version_ref.length > 512)) ||
    (value.consumer_commit_ref !== undefined &&
      (typeof value.consumer_commit_ref !== 'string' ||
        value.consumer_commit_ref.length < 1 ||
        value.consumer_commit_ref.length > 512))
  ) {
    return false;
  }
  if (value.status === 'rejected') {
    return (
      Array.isArray(value.rejection_codes) &&
      value.rejection_codes.length > 0 &&
      new Set(value.rejection_codes).size === value.rejection_codes.length &&
      value.rejection_codes.every(code => typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(code))
    );
  }
  if (value.verification_profile === 'canonical_digest') {
    return isReportingCanonicalDigest(value.observed_canonical_content_digest);
  }
  if (value.verification_profile === 'manifest_checksums') {
    return typeof value.observed_manifest_sha256 === 'string' && SHA256_HEX.test(value.observed_manifest_sha256);
  }
  return (
    typeof value.observed_native_version_ref === 'string' &&
    value.observed_native_version_ref.length >= 1 &&
    value.observed_native_version_ref.length <= 512
  );
}
