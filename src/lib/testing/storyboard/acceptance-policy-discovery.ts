import {
  resolveAcceptancePolicyCatalog,
  resolveAcceptancePolicyProfiles,
  resolveVerifiedAcceptancePolicyProfiles,
  type AcceptancePolicyCatalog,
  type AcceptancePolicyCatalogIssue,
  type AcceptancePolicyDiscoveryCapability,
  type AcceptancePolicyRegistryResolver,
} from '../../acceptance-policy';
import { RegistryClient } from '../../registry';
import type { TaskResult } from '../types';
import type { ValidationResult } from './types';

const STORYBOARD_ID = 'media_buy_seller/acceptance_policy_discovery';
const CAPABILITY_STEP_ID = 'get_acceptance_policy_capability';
const PRODUCTS_STEP_ID = 'get_contextual_products';
const REGISTRY_PROFILE_BATCH_SIZE = 32;
const MAX_REGISTRY_PROFILES_PER_STEP = 1024;
const REGISTRY_VERIFICATION_TIMEOUT_MS = 5_000;

export interface AcceptancePolicyDiscoveryRunState {
  catalog?: AcceptancePolicyCatalog;
  registryResolver?: AcceptancePolicyRegistryResolver;
}

export interface AcceptancePolicyDiscoveryDependencies {
  enabled?: boolean;
  registryResolver?: AcceptancePolicyRegistryResolver;
  resolveCatalog?: typeof resolveAcceptancePolicyCatalog;
  resolveProfiles?: typeof resolveVerifiedAcceptancePolicyProfiles;
  /** Monotonic clock seam for deterministic deadline tests. */
  now?: () => number;
}

export interface VerifyAcceptancePolicyDiscoveryStepInput {
  storyboardId: string;
  stepId: string;
  taskResult: TaskResult;
  state: AcceptancePolicyDiscoveryRunState;
  adcpVersion?: string;
  signal?: AbortSignal;
  dependencies?: AcceptancePolicyDiscoveryDependencies;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(description: string, issue: AcceptancePolicyCatalogIssue, expected: string): ValidationResult {
  return {
    check: 'acceptance_policy_discovery',
    passed: false,
    severity: 'required',
    description,
    error: issue.message,
    json_pointer: issue.pointer,
    expected,
    actual: {
      code: issue.code,
      ...(issue.retryable !== undefined && { retryable: issue.retryable }),
      ...(issue.httpStatus !== undefined && { http_status: issue.httpStatus }),
      ...(issue.keyword !== undefined && { keyword: issue.keyword }),
    },
  };
}

function unresolvedIssue(pointer: string): AcceptancePolicyCatalogIssue {
  return {
    code: 'unresolved_profile_id',
    message: 'An advertised acceptance-policy profile could not be resolved and verified',
    pointer,
  };
}

function capabilityFromResult(taskResult: TaskResult): AcceptancePolicyDiscoveryCapability | undefined {
  if (!taskResult.success || !isRecord(taskResult.data)) return undefined;
  const mediaBuy = taskResult.data.media_buy;
  if (!isRecord(mediaBuy)) return undefined;
  const capability = mediaBuy.acceptance_policy_discovery;
  return isRecord(capability) ? (capability as unknown as AcceptancePolicyDiscoveryCapability) : undefined;
}

function collectProductProfileIds(taskResult: TaskResult): string[] | undefined {
  if (!taskResult.success || !isRecord(taskResult.data) || !Array.isArray(taskResult.data.products)) return undefined;
  const ids = new Set<string>();
  for (const product of taskResult.data.products) {
    if (!isRecord(product) || product.acceptance_policy_profile_ids === undefined) continue;
    if (!Array.isArray(product.acceptance_policy_profile_ids)) return undefined;
    for (const profileId of product.acceptance_policy_profile_ids) {
      if (typeof profileId !== 'string' || profileId.length === 0) return undefined;
      ids.add(profileId);
    }
  }
  return [...ids];
}

async function verifyRegistryProfileBatches(input: {
  catalog: AcceptancePolicyCatalog;
  profileIds: string[];
  pointer: string;
  registryResolver: AcceptancePolicyRegistryResolver;
  resolveProfiles: typeof resolveVerifiedAcceptancePolicyProfiles;
  now: () => number;
  adcpVersion?: string;
  signal?: AbortSignal;
}): Promise<AcceptancePolicyCatalogIssue | undefined> {
  if (input.profileIds.length > MAX_REGISTRY_PROFILES_PER_STEP) {
    return {
      code: 'registry_resolution_limit_exceeded',
      message: 'The advertised registry profile count exceeds the compliance-run resource limit',
      pointer: input.pointer,
    };
  }

  const deadlineAt = input.now() + REGISTRY_VERIFICATION_TIMEOUT_MS;
  for (let offset = 0; offset < input.profileIds.length; offset += REGISTRY_PROFILE_BATCH_SIZE) {
    input.signal?.throwIfAborted();
    const remainingMs = Math.floor(deadlineAt - input.now());
    if (remainingMs <= 0) {
      return {
        code: 'registry_timeout',
        message: 'Registry profile resolution exceeded the overall deadline',
        pointer: input.pointer,
        retryable: true,
      };
    }

    let result;
    try {
      result = await input.resolveProfiles(
        input.catalog,
        input.profileIds.slice(offset, offset + REGISTRY_PROFILE_BATCH_SIZE),
        {
          registryResolver: input.registryResolver,
          ...(input.adcpVersion !== undefined && { adcpVersion: input.adcpVersion }),
          timeoutMs: remainingMs,
          ...(input.signal !== undefined && { signal: input.signal }),
        }
      );
    } catch {
      input.signal?.throwIfAborted();
      return {
        code: 'registry_fetch_failed',
        message: 'Acceptance-policy profile resolution failed safely',
        pointer: input.pointer,
        retryable: false,
      };
    }
    input.signal?.throwIfAborted();
    if (!result.ok) return result.error;
    if (result.profiles.some(profile => profile.resolution !== 'resolved') || result.issues?.length) {
      return result.issues?.[0] ?? unresolvedIssue(input.pointer);
    }
  }
  return undefined;
}

/** Execute the remote integrity checks required by the discovery storyboard. */
export async function verifyAcceptancePolicyDiscoveryStep({
  storyboardId,
  stepId,
  taskResult,
  state,
  adcpVersion,
  signal,
  dependencies = {},
}: VerifyAcceptancePolicyDiscoveryStepInput): Promise<ValidationResult[]> {
  if (storyboardId !== STORYBOARD_ID) return [];

  if (dependencies.enabled === false && (stepId === CAPABILITY_STEP_ID || stepId === PRODUCTS_STEP_ID)) {
    if (stepId === CAPABILITY_STEP_ID) state.catalog = undefined;
    return [
      {
        check: 'acceptance_policy_discovery',
        passed: true,
        severity: 'advisory',
        not_applicable: true,
        description: 'Remote acceptance-policy verification was disabled by the runner operator',
        note: 'Only the storyboard-authored in-band capability and product validations were graded.',
      },
    ];
  }

  const registryResolver =
    dependencies.registryResolver ??
    state.registryResolver ??
    (state.registryResolver = new RegistryClient({ apiKey: '' }));

  if (stepId === CAPABILITY_STEP_ID) {
    state.catalog = undefined;
    const capability = capabilityFromResult(taskResult);
    if (!capability) {
      return [
        failure(
          'Resolve the advertised acceptance-policy catalog and seller defaults',
          {
            code: 'invalid_capability',
            message: 'The successful capability response did not contain acceptance-policy discovery metadata',
            pointer: '/media_buy/acceptance_policy_discovery',
          },
          'digest-pinned, schema-valid catalog with fully resolved default profiles'
        ),
      ];
    }

    let result;
    try {
      result = await (dependencies.resolveCatalog ?? resolveAcceptancePolicyCatalog)(capability, {
        ...(adcpVersion !== undefined && { adcpVersion }),
        signal,
      });
    } catch {
      signal?.throwIfAborted();
      return [
        failure(
          'Resolve the advertised acceptance-policy catalog and seller defaults',
          {
            code: 'fetch_failed',
            message: 'Acceptance-policy catalog resolution failed safely',
            pointer: '/media_buy/acceptance_policy_discovery/catalog_url',
            retryable: false,
          },
          'digest-pinned, schema-valid catalog with fully resolved default profiles'
        ),
      ];
    }
    signal?.throwIfAborted();
    if (!result.ok) {
      return [
        failure(
          'Resolve the advertised acceptance-policy catalog and seller defaults',
          result.error,
          'digest-pinned, schema-valid catalog with fully resolved default profiles'
        ),
      ];
    }

    if (result.issues?.length) {
      return [
        failure(
          'Resolve the advertised acceptance-policy catalog and seller defaults',
          result.issues?.[0] ?? unresolvedIssue('/media_buy/acceptance_policy_discovery/default_profile_ids'),
          'digest-pinned, schema-valid catalog with fully resolved default profiles'
        ),
      ];
    }

    const defaultProfileIds = capability.default_profile_ids ?? [];
    const classifiedDefaults = resolveAcceptancePolicyProfiles(result.catalog, defaultProfileIds);
    if (classifiedDefaults.some(profile => profile.resolution === 'missing')) {
      return [
        failure(
          'Resolve the advertised acceptance-policy catalog and seller defaults',
          unresolvedIssue('/media_buy/acceptance_policy_discovery/default_profile_ids'),
          'digest-pinned, schema-valid catalog with fully resolved default profiles'
        ),
      ];
    }
    const registryDefaultIds = classifiedDefaults
      .filter(profile => profile.source === 'registry')
      .map(profile => profile.profileId);
    const defaultIssue = await verifyRegistryProfileBatches({
      catalog: result.catalog,
      profileIds: registryDefaultIds,
      pointer: '/media_buy/acceptance_policy_discovery/default_profile_ids',
      registryResolver,
      resolveProfiles: dependencies.resolveProfiles ?? resolveVerifiedAcceptancePolicyProfiles,
      now: dependencies.now ?? performance.now.bind(performance),
      ...(adcpVersion !== undefined && { adcpVersion }),
      ...(signal !== undefined && { signal }),
    });
    if (defaultIssue) {
      return [
        failure(
          'Resolve the advertised acceptance-policy catalog and seller defaults',
          defaultIssue,
          'digest-pinned, schema-valid catalog with fully resolved default profiles'
        ),
      ];
    }

    state.catalog = result.catalog;
    return [
      {
        check: 'acceptance_policy_discovery',
        passed: true,
        severity: 'required',
        description: 'Advertised acceptance-policy catalog bytes, schema, and seller defaults verify',
      },
    ];
  }

  if (stepId !== PRODUCTS_STEP_ID) return [];
  if (!state.catalog) {
    return [
      failure(
        'Resolve every advertised product acceptance-policy profile',
        {
          code: 'unresolved_profile_id',
          message: 'The verified acceptance-policy catalog is unavailable for product profile resolution',
          pointer: '/products',
        },
        'every advertised product profile resolves with valid policy and profile pins'
      ),
    ];
  }

  const profileIds = collectProductProfileIds(taskResult);
  if (!profileIds) {
    return [
      failure(
        'Resolve every advertised product acceptance-policy profile',
        {
          code: 'unresolved_profile_id',
          message: 'The successful products response did not contain valid product profile identifiers',
          pointer: '/products',
        },
        'every advertised product profile resolves with valid policy and profile pins'
      ),
    ];
  }

  const classified = resolveAcceptancePolicyProfiles(state.catalog, profileIds);
  if (classified.some(profile => profile.resolution === 'missing')) {
    return [
      failure(
        'Resolve every advertised product acceptance-policy profile',
        unresolvedIssue('/products'),
        'every advertised product profile resolves with valid policy and profile pins'
      ),
    ];
  }

  const registryProfileIds = classified
    .filter(profile => profile.source === 'registry')
    .map(profile => profile.profileId);
  const productIssue = await verifyRegistryProfileBatches({
    catalog: state.catalog,
    profileIds: registryProfileIds,
    pointer: '/products',
    registryResolver,
    resolveProfiles: dependencies.resolveProfiles ?? resolveVerifiedAcceptancePolicyProfiles,
    now: dependencies.now ?? performance.now.bind(performance),
    ...(adcpVersion !== undefined && { adcpVersion }),
    ...(signal !== undefined && { signal }),
  });
  if (productIssue) {
    return [
      failure(
        'Resolve every advertised product acceptance-policy profile',
        productIssue,
        'every advertised product profile resolves with valid policy and profile pins'
      ),
    ];
  }

  return [
    {
      check: 'acceptance_policy_discovery',
      passed: true,
      severity: 'required',
      description: 'Every advertised product acceptance-policy profile and immutable pin verifies',
    },
  ];
}
