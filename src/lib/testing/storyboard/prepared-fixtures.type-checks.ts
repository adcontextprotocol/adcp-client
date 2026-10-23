/**
 * Compile-time checks for the prepared-fixture output contract.
 *
 * Excluded from the lib build by `tsconfig.lib.json`; checked by
 * `npm run typecheck`.
 *
 * `PreparedFixturesRefusalCode` is what a report consumer switches on when
 * reading `prepared_fixtures_authorization.actual`. The runner emits one
 * value — `unauthorized_metadata` — from its own pre-contact screen rather
 * than from `resolvePreparedFixtures`, so nothing in the implementation
 * forces the union to list it. An exhaustive switch does.
 */

import type {
  PreparedFixtureBinding,
  PreparedFixturesAuthorizer,
  PreparedFixturesDecision,
  PreparedFixturesPreparationAuthorizer,
  PreparedFixturesPreparationLookup,
  PreparedFixturesLookup,
  PreparedFixturesReference,
  PreparedFixturesRefusalCode,
  PreparedStoryboardFixtures,
} from './prepared-fixtures';
import type { StoryboardRunOptions, PrepareStoryboardFixturesOptions } from './types';
import type { CollectionSelectionSelector, CollectionSelectionWitness } from './collection-selection';

function describeRefusal(code: PreparedFixturesRefusalCode): string {
  switch (code) {
    case 'untrusted_state':
      return 'not produced by prepareStoryboardFixtures in this process';
    case 'contract_version_mismatch':
      return 'prepared against a different contract version';
    case 'authorizer_required':
      return 'reuse requested with no authorizer';
    case 'authorizer_denied':
      return 'the host authorizer refused';
    case 'binding_mismatch':
      return 'authorized, but bound to a different scope';
    case 'unauthorized_metadata':
      return 'caller metadata carried a reserved or prototype-sensitive key';
    default: {
      // Adding a code without updating the guide's output inventory and
      // every consumer's switch fails here rather than at a renderer.
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

export const refusalDescriptions: string[] = (
  [
    'untrusted_state',
    'contract_version_mismatch',
    'authorizer_required',
    'authorizer_denied',
    'binding_mismatch',
    'unauthorized_metadata',
  ] satisfies PreparedFixturesRefusalCode[]
).map(describeRefusal);

// @ts-expect-error - the union is closed; a renderer cannot invent a code.
export const invented: PreparedFixturesRefusalCode = 'definitely_not_a_refusal';

// ── Guide § 4: the hosted-integrator snippets, verbatim in shape ──
//
// These are the only hand-written TypeScript the guide shows, and the ones
// a hosted integrator pastes. The YAML-equivalent forms are covered by
// `collection-selection.type-checks.ts`; these were not covered by
// anything, which is backwards — a signature change breaks them first.

declare const hostStore: { get(ref: string): PreparedStoryboardFixtures | undefined };
declare const grants: {
  lookupLive(
    tenant: string,
    ref: string | undefined
  ): Promise<{ revoked: boolean; accountScope: string; allowsProbeSteps: boolean } | undefined>;
};
declare const session: { tenantId: string };

export const canonicalReuseOptions: Pick<StoryboardRunOptions, 'prepared_fixtures' | 'prepared_fixtures_authorizer'> = {
  prepared_fixtures: { ref: 'opaque-1', resolve: ref => hostStore.get(ref) } satisfies PreparedFixturesReference,
  prepared_fixtures_authorizer: async ({ binding, current, step_id, reference, gate }) => {
    void binding;
    void step_id;
    void gate;
    const grant = await grants.lookupLive(session.tenantId, reference);
    if (!grant || grant.revoked) return { authorized: false, detail: 'grant revoked' };
    if (grant.accountScope !== current.account_scope) return { authorized: false, detail: 'account mismatch' };
    if (current.step_auth_kind && !grant.allowsProbeSteps) {
      return { authorized: false, detail: `step overrides the run credential (${current.step_auth_kind})` };
    }
    return { authorized: true };
  },
};

// The nonsecret fields an authorizer branches on must all be readable from
// `current` without a cast.
export function readEffectiveScope(lookup: PreparedFixturesLookup): string[] {
  const current: PreparedFixtureBinding = lookup.current;
  return [
    current.account_scope,
    current.brand_scope,
    current.request_account_scope ?? '(no step override)',
    current.step_route ?? '(not routed)',
    current.step_auth_kind ?? '(inherits)',
    current.credential_fingerprint,
    String(current.sandbox),
    lookup.gate ?? '(unspecified)',
  ];
}

// An always-allow authorizer is the documented escape hatch, so it must be
// assignable without ceremony.
export const alwaysAllow: PreparedFixturesAuthorizer = () => ({ authorized: true });

// Stable16 reuse callbacks retain their required binding and closed gate union.
export const compatibleReuse: PreparedFixturesAuthorizer = lookup => {
  const digest: string = lookup.binding.storyboard_digest;
  const gate = lookup.gate;
  switch (gate) {
    case undefined:
    case 'run':
    case 'pass':
    case 'step':
      return digest.length > 0 ? { authorized: true } : { authorized: false, detail: 'missing digest' };
    default: {
      const exhaustive: never = gate;
      return exhaustive;
    }
  }
};
export const preparationOptions: PrepareStoryboardFixturesOptions = {
  prepared_fixtures_preparation_authorizer: lookup => {
    const gate: 'prepare' = lookup.gate;
    // @ts-expect-error - no stored binding exists during fresh preparation.
    void lookup.binding;
    return gate === 'prepare' && lookup.current.storyboard_digest.length > 0
      ? { authorized: true }
      : { authorized: false, detail: 'missing scope' };
  },
};
// A host may explicitly use one union-aware implementation for both hooks.
export const hostAuthorization = (
  lookup: PreparedFixturesLookup | PreparedFixturesPreparationLookup
): PreparedFixturesDecision => {
  const authorized =
    lookup.gate === 'prepare' ? lookup.current.sandbox : lookup.binding.sandbox && lookup.current.sandbox;
  return authorized ? { authorized: true } : { authorized: false, detail: 'sandbox required' };
};
export const sharedPreparation: PreparedFixturesPreparationAuthorizer = hostAuthorization;
export const sharedReuse: PreparedFixturesAuthorizer = hostAuthorization;
// @ts-expect-error - a reuse-only authorizer cannot receive preparation lookups.
export const wrongPreparation: PreparedFixturesPreparationAuthorizer = compatibleReuse;
export const invalidRunOptions: StoryboardRunOptions = {
  // @ts-expect-error - preparation-only authority is not accepted as a run option.
  prepared_fixtures_preparation_authorizer: sharedPreparation,
};

// ── Known assignability hazard, pinned so the next reader sees it ──
//
// `CollectionSelectionWitness.collection_targeting` is 'selectable' | 'fixed',
// a subset of the selector's 'selectable' | 'fixed' | 'any', and the
// selector's other two fields are optional — so a witness structurally
// satisfies the selector and this compiles. An agent holding a witness and
// asked to "re-check eligibility" will write exactly this, and it would
// silently evaluate with `minimum_pairs: 1`. `evaluateCollectionSelection`
// refuses a witness-shaped operand at runtime; this records WHY the compiler
// does not.
declare const someWitness: CollectionSelectionWitness;
export const witnessIsStructurallyASelector: CollectionSelectionSelector = someWitness;
