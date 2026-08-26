import type { AgentRequestSigningConfig, AdcpPrivateJsonWebKey } from '../../../types/adcp';
import type { TestOptions } from '../../types';
import { loadRequestSigningKeys, findKey } from './vector-loader';
import { loadSignedRequestsRunnerContract } from './test-kit';

export interface FunctionalDispatchLoadOptions {
  complianceDir?: string;
  version?: string;
}

/**
 * Attach the shared compliance signer for ordinary functional dispatch.
 *
 * The bundled private scalar is deliberately public test material, so it is
 * auto-loaded only for an explicit sandbox run. `disable_sandbox` always wins.
 * A caller-provided signer is already operator-authorized. Its identity and
 * provider are preserved; in an in-scope sandbox run, the contract's
 * supported-operation policy is applied without loading the bundled key.
 */
export function applyFunctionalRequestSigning<T extends TestOptions>(
  options: T,
  loadOptions: FunctionalDispatchLoadOptions = {}
): T {
  if (options.sandbox !== true || options.disable_sandbox === true) return options;

  const contract = loadSignedRequestsRunnerContract(loadOptions);
  const dispatch = contract?.functional_dispatch;
  // Older compliance bundles predate functional signing. Keep beta.8's
  // post-dispatch not_applicable compatibility behavior for those bundles.
  if (!dispatch) return options;
  if (contract.endpoint_scope !== 'sandbox') {
    throw new Error(
      `functional request signing refused: signed-requests runner endpoint_scope must be "sandbox", got "${contract.endpoint_scope}"`
    );
  }
  if (!dispatch.operation_selection.sign_required_for) {
    throw new Error('functional request signing contract must enable sign_required_for');
  }
  if (!dispatch.operation_selection.sign_supported_for) {
    throw new Error('functional request signing contract must enable sign_supported_for');
  }
  if (
    dispatch.bootstrap_operations_unsigned.length !== 1 ||
    dispatch.bootstrap_operations_unsigned[0] !== 'get_adcp_capabilities'
  ) {
    throw new Error('functional request signing supports only unsigned bootstrap discovery via get_adcp_capabilities');
  }
  if (!dispatch.preserve_transport_auth || !dispatch.fresh_signature_per_dispatch) {
    throw new Error(
      'functional request signing contract must preserve transport auth and mint a fresh signature per dispatch'
    );
  }

  const suppliedSigning = options.functional_request_signing;
  if (suppliedSigning) {
    if (suppliedSigning.always_sign?.includes('get_adcp_capabilities')) {
      throw new Error('functional request signing requires unsigned bootstrap discovery via get_adcp_capabilities');
    }
    if (suppliedSigning.sign_supported === true) return options;
    return {
      ...options,
      functional_request_signing: { ...suppliedSigning, sign_supported: true },
    };
  }

  const declaredKey = contract.runner_signing_keys.find(entry => entry.keyid === dispatch.signing_keyid);
  if (!declaredKey) {
    throw new Error(
      `functional request signing key "${dispatch.signing_keyid}" is not declared in runner_signing_keys`
    );
  }
  const key = findKey(loadRequestSigningKeys(loadOptions), dispatch.signing_keyid);
  const alg = key.crv === 'Ed25519' ? 'ed25519' : key.crv === 'P-256' ? 'ecdsa-p256-sha256' : undefined;
  if (!alg || alg !== declaredKey.alg) {
    throw new Error(
      `functional request signing key "${key.kid}" does not match declared algorithm "${declaredKey.alg}"`
    );
  }
  if (key.adcp_use !== 'request-signing') {
    throw new Error(`functional request signing key "${key.kid}" must have adcp_use="request-signing"`);
  }
  if (contract.stateful_vector_contract.revocation.pre_revoked_keyid === key.kid) {
    throw new Error(`functional request signing key "${key.kid}" is the contract's pre-revoked key`);
  }

  const privateKey: AdcpPrivateJsonWebKey = {
    kid: key.kid,
    kty: key.kty,
    ...(key.crv && { crv: key.crv }),
    ...(key.alg && { alg: key.alg }),
    ...(key.use && { use: key.use }),
    key_ops: ['sign'],
    ...(key.adcp_use && { adcp_use: key.adcp_use }),
    ...(key.x && { x: key.x }),
    ...(key.y && { y: key.y }),
    d: key.private_d,
  };
  const signing: AgentRequestSigningConfig = {
    kind: 'inline',
    kid: key.kid,
    alg,
    private_key: privateKey,
    agent_url: dispatch.signer_agent_url,
    sign_supported: dispatch.operation_selection.sign_supported_for,
  };
  return { ...options, functional_request_signing: signing };
}
