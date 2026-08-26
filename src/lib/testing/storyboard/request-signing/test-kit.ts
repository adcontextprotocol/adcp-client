import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { getComplianceCacheDir } from '../compliance';

export interface RunnerSigningKey {
  keyid: string;
  alg: 'ed25519' | 'ecdsa-p256-sha256';
}

export interface ReplayWindowContract {
  vector_id: string;
  black_box_behavior: 'repeat_request';
  max_interval_seconds: number;
  min_replay_ttl_seconds: number;
}

export interface RevocationContract {
  vector_id: string;
  pre_revoked_keyid: string;
}

export interface RateAbuseContract {
  vector_id: string;
  grading_target_per_keyid_cap_requests: number;
  production_min_per_keyid_cap_requests: number;
  window_seconds: number;
}

export interface FunctionalDispatchContract {
  signing_keyid: string;
  signer_agent_url: string;
  operation_selection: {
    capability_path: 'request_signing';
    sign_required_for: boolean;
    sign_supported_for: boolean;
  };
  content_digest_policy_source: 'request_signing.covers_content_digest';
  preserve_transport_auth: boolean;
  fresh_signature_per_dispatch: boolean;
  bootstrap_operations_unsigned: string[];
  unavailable_behavior: 'not_applicable';
}

export interface SignedRequestsRunnerContract {
  id: string;
  endpoint_scope: 'sandbox' | string;
  harness_mode: 'black_box' | 'white_box';
  runner_signing_keys: RunnerSigningKey[];
  functional_dispatch?: FunctionalDispatchContract;
  stateful_vector_contract: {
    replay_window: ReplayWindowContract;
    revocation: RevocationContract;
    rate_abuse: RateAbuseContract;
  };
}

export interface LoadTestKitOptions {
  complianceDir?: string;
  version?: string;
}

/**
 * Load and parse `test-kits/signed-requests-runner.yaml` from the compliance
 * cache. Returns undefined when the file is absent (upstream pre-adcp#2353
 * caches, or a sync in progress) — callers must decide how to degrade.
 */
export function loadSignedRequestsRunnerContract(
  options: LoadTestKitOptions = {}
): SignedRequestsRunnerContract | undefined {
  const cacheDir = getComplianceCacheDir(options);
  const path = join(cacheDir, 'test-kits', 'signed-requests-runner.yaml');
  if (!existsSync(path)) return undefined;
  const raw = parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  const functionalDispatch = parseFunctionalDispatch(raw.functional_dispatch);
  return {
    id: assertString(raw.id, 'id'),
    endpoint_scope: assertString(raw.endpoint_scope, 'endpoint_scope'),
    harness_mode: parseHarnessMode(raw.harness_mode),
    runner_signing_keys: parseSigningKeys(raw.runner_signing_keys),
    ...(functionalDispatch && { functional_dispatch: functionalDispatch }),
    stateful_vector_contract: parseStatefulContracts(raw.stateful_vector_contract),
  };
}

function parseFunctionalDispatch(raw: unknown): FunctionalDispatchContract | undefined {
  if (raw === undefined) return undefined;
  const r = asObject(raw, 'functional_dispatch');
  const selection = asObject(r.operation_selection, 'functional_dispatch.operation_selection');
  const capabilityPath = assertString(
    selection.capability_path,
    'functional_dispatch.operation_selection.capability_path'
  );
  if (capabilityPath !== 'request_signing') {
    throw new Error('functional_dispatch.operation_selection.capability_path must be "request_signing"');
  }
  const digestSource = assertString(r.content_digest_policy_source, 'functional_dispatch.content_digest_policy_source');
  if (digestSource !== 'request_signing.covers_content_digest') {
    throw new Error('functional_dispatch.content_digest_policy_source must be "request_signing.covers_content_digest"');
  }
  const unavailable = assertString(r.unavailable_behavior, 'functional_dispatch.unavailable_behavior');
  if (unavailable !== 'not_applicable') {
    throw new Error('functional_dispatch.unavailable_behavior must be "not_applicable"');
  }
  return {
    signing_keyid: assertString(r.signing_keyid, 'functional_dispatch.signing_keyid'),
    signer_agent_url: assertString(r.signer_agent_url, 'functional_dispatch.signer_agent_url'),
    operation_selection: {
      capability_path: 'request_signing',
      sign_required_for: assertBoolean(
        selection.sign_required_for,
        'functional_dispatch.operation_selection.sign_required_for'
      ),
      sign_supported_for: assertBoolean(
        selection.sign_supported_for,
        'functional_dispatch.operation_selection.sign_supported_for'
      ),
    },
    content_digest_policy_source: 'request_signing.covers_content_digest',
    preserve_transport_auth: assertBoolean(r.preserve_transport_auth, 'functional_dispatch.preserve_transport_auth'),
    fresh_signature_per_dispatch: assertBoolean(
      r.fresh_signature_per_dispatch,
      'functional_dispatch.fresh_signature_per_dispatch'
    ),
    bootstrap_operations_unsigned: assertStringArray(
      r.bootstrap_operations_unsigned,
      'functional_dispatch.bootstrap_operations_unsigned'
    ),
    unavailable_behavior: 'not_applicable',
  };
}

function parseHarnessMode(raw: unknown): 'black_box' | 'white_box' {
  const s = assertString(raw, 'harness_mode');
  if (s !== 'black_box' && s !== 'white_box') {
    throw new Error(`test-kit harness_mode must be "black_box" or "white_box", got "${s}"`);
  }
  return s;
}

function parseSigningKeys(raw: unknown): RunnerSigningKey[] {
  if (!Array.isArray(raw)) throw new Error('runner_signing_keys must be an array');
  return raw.map((entry, i) => {
    const r = entry as Record<string, unknown>;
    const alg = assertString(r.alg, `runner_signing_keys[${i}].alg`);
    if (alg !== 'ed25519' && alg !== 'ecdsa-p256-sha256') {
      throw new Error(`runner_signing_keys[${i}].alg: unsupported "${alg}"`);
    }
    return { keyid: assertString(r.keyid, `runner_signing_keys[${i}].keyid`), alg };
  });
}

function parseStatefulContracts(raw: unknown): SignedRequestsRunnerContract['stateful_vector_contract'] {
  if (!raw || typeof raw !== 'object') {
    throw new Error('stateful_vector_contract block missing');
  }
  const r = raw as Record<string, unknown>;
  return {
    replay_window: parseReplay(r.replay_window),
    revocation: parseRevocation(r.revocation),
    rate_abuse: parseRateAbuse(r.rate_abuse),
  };
}

function parseReplay(raw: unknown): ReplayWindowContract {
  const r = asObject(raw, 'stateful_vector_contract.replay_window');
  const behavior = assertString(r.black_box_behavior, 'replay_window.black_box_behavior');
  if (behavior !== 'repeat_request') {
    throw new Error(`replay_window.black_box_behavior must be "repeat_request", got "${behavior}"`);
  }
  return {
    vector_id: assertString(r.vector_id, 'replay_window.vector_id'),
    black_box_behavior: 'repeat_request',
    max_interval_seconds: assertNumber(r.max_interval_seconds, 'replay_window.max_interval_seconds'),
    min_replay_ttl_seconds: assertNumber(r.min_replay_ttl_seconds, 'replay_window.min_replay_ttl_seconds'),
  };
}

function parseRevocation(raw: unknown): RevocationContract {
  const r = asObject(raw, 'stateful_vector_contract.revocation');
  return {
    vector_id: assertString(r.vector_id, 'revocation.vector_id'),
    pre_revoked_keyid: assertString(r.pre_revoked_keyid, 'revocation.pre_revoked_keyid'),
  };
}

function parseRateAbuse(raw: unknown): RateAbuseContract {
  const r = asObject(raw, 'stateful_vector_contract.rate_abuse');
  return {
    vector_id: assertString(r.vector_id, 'rate_abuse.vector_id'),
    grading_target_per_keyid_cap_requests: assertNumber(
      r.grading_target_per_keyid_cap_requests,
      'rate_abuse.grading_target_per_keyid_cap_requests'
    ),
    production_min_per_keyid_cap_requests: assertNumber(
      r.production_min_per_keyid_cap_requests,
      'rate_abuse.production_min_per_keyid_cap_requests'
    ),
    window_seconds: assertNumber(r.window_seconds, 'rate_abuse.window_seconds'),
  };
}

function asObject(raw: unknown, where: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') throw new Error(`${where} missing or not an object`);
  return raw as Record<string, unknown>;
}

function assertString(v: unknown, where: string): string {
  if (typeof v !== 'string') throw new Error(`${where} must be string`);
  return v;
}

function assertNumber(v: unknown, where: string): number {
  if (typeof v !== 'number') throw new Error(`${where} must be number`);
  return v;
}

function assertBoolean(v: unknown, where: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`${where} must be boolean`);
  return v;
}

function assertStringArray(v: unknown, where: string): string[] {
  if (!Array.isArray(v) || v.some(item => typeof item !== 'string')) {
    throw new Error(`${where} must be string[]`);
  }
  return v;
}
