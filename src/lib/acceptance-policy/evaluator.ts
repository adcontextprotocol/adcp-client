/** Conservative, advisory evaluation of already-verified acceptance profiles. */

import type { AcceptanceContext } from '../types/core.generated';
import { getSchemaValidatorByRef } from '../validation/schema-loader';
import { ADCP_VERSION } from '../version';
import type {
  AcceptancePolicyProfile,
  AcceptancePolicyProfileResolution,
  AcceptancePolicyRequirement,
  AcceptancePolicyRule,
  AcceptancePolicySurface,
} from './index';

const CONTEXT_SCHEMA_REF = 'media-buy/acceptance-context.json';
const PROFILE_SCHEMA_REF = 'media-buy/acceptance-policy-profile.json';
const MAX_ASSESSMENT_PROFILES = 1024;
const MAX_ASSESSMENT_RULES = 10_000;
const MAX_ASSESSMENT_CONTEXT_VALUES = 4096;
const MAX_ASSESSMENT_JSON_NODES = 100_000;
const MAX_ASSESSMENT_STRING_CODE_UNITS = 1024 * 1024;
const MAX_ASSESSMENT_JSON_DEPTH = 64;
const MAX_ASSESSMENT_DIAGNOSTICS = 32;
const SURFACES = new Set<AcceptancePolicySurface>([
  'account',
  'media_buy',
  'creative',
  'landing_page',
  'targeting',
  'delivery',
  'format',
]);

const REVIEW_REQUIREMENTS = new Set<string>([
  'prior_authorization',
  'sales_assisted',
  'funding_restriction',
  'targeting_restriction',
  'creative_restriction',
  'destination_restriction',
  'format_restriction',
  'time_restriction',
  'custom',
]);

const SETUP_REQUIREMENTS = new Set<string>([
  'advertiser_verification',
  'advertiser_eligibility',
  'certification',
  'license',
  'account_setup',
]);

const DISCLOSURE_REQUIREMENTS = new Set<string>(['category_declaration', 'disclosure', 'transparency_reporting']);

export type AcceptancePolicyOutcome =
  | 'allowed'
  | 'prohibited'
  | 'requires_disclosure'
  | 'requires_setup'
  | 'requires_review'
  | 'unknown';

export type AcceptancePolicyAssessmentDiagnosticCode =
  | 'profile_unresolved'
  | 'profile_conflict'
  | 'invalid_profile'
  | 'assessment_limit_exceeded'
  | 'partial_coverage'
  | 'incomplete_context'
  | 'invalid_context'
  | 'invalid_evaluation_time'
  | 'schema_unavailable';

export interface AcceptancePolicyAssessmentDiagnostic {
  code: AcceptancePolicyAssessmentDiagnosticCode;
  profileId?: string;
  ruleId?: string;
}

export interface AssessAcceptancePolicyInput {
  /** Seller-default and product profiles to compose. Unresolved entries fail closed. */
  profiles: readonly AcceptancePolicyProfileResolution[];
  acceptanceContext: AcceptanceContext;
  appliesTo: AcceptancePolicySurface;
  /** Evaluation instant for rule windows. Defaults to the current time. */
  evaluatedAt?: Date | string;
  /** Schema bundle used to validate acceptanceContext and each resolved profile. Defaults to the SDK pin. */
  adcpVersion?: string;
}

export interface AcceptancePolicyAssessment {
  /** Advisory only. The seller's response to an exact request remains authoritative. */
  advisory: true;
  outcome: AcceptancePolicyOutcome;
  profileIds: string[];
  matchingRuleIds: string[];
  matchedRules: AcceptancePolicyMatchedRule[];
  requirements: AcceptancePolicyRequirement[];
  diagnostics: AcceptancePolicyAssessmentDiagnostic[];
}

export interface AcceptancePolicyMatchedRule {
  profileId: string;
  ruleId: string;
  disposition: AcceptancePolicyRule['disposition'];
  policyIds: string[];
  requirements: AcceptancePolicyRequirement[];
}

type RuleMatch = true | false | 'unknown';
interface IndexedSubjects {
  facets: ReadonlySet<string>;
  hasMissingFacets: boolean;
}

interface AcceptanceContextIndex {
  hasSubjects: boolean;
  subjectsByCategory: ReadonlyMap<string, IndexedSubjects>;
  advertiserRoles: ReadonlySet<string>;
  deliveryJurisdictions: ReadonlySet<string>;
}

function diagnostic(
  code: AcceptancePolicyAssessmentDiagnosticCode,
  profileId?: string,
  ruleId?: string
): AcceptancePolicyAssessmentDiagnostic {
  return {
    code,
    ...(profileId !== undefined && { profileId }),
    ...(ruleId !== undefined && { ruleId }),
  };
}

function dedupeDiagnostics(
  diagnostics: AcceptancePolicyAssessmentDiagnostic[]
): AcceptancePolicyAssessmentDiagnostic[] {
  const seen = new Set<string>();
  const result: AcceptancePolicyAssessmentDiagnostic[] = [];
  for (const value of diagnostics) {
    const key = `${value.code}\0${value.profileId ?? ''}\0${value.ruleId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= MAX_ASSESSMENT_DIAGNOSTICS) break;
  }
  return result;
}

function unknownAssessment(
  profileIds: string[],
  diagnostics: AcceptancePolicyAssessmentDiagnostic[]
): AcceptancePolicyAssessment {
  return {
    advisory: true,
    outcome: 'unknown',
    profileIds,
    matchingRuleIds: [],
    matchedRules: [],
    requirements: [],
    diagnostics: dedupeDiagnostics(diagnostics),
  };
}

function expandedJurisdictions(profile: AcceptancePolicyProfile, groups: readonly string[]): Set<string> {
  const jurisdictions = new Set<string>();
  for (const group of groups) {
    if (!Object.prototype.hasOwnProperty.call(profile.region_aliases ?? {}, group)) continue;
    for (const jurisdiction of profile.region_aliases?.[group] ?? []) jurisdictions.add(jurisdiction);
  }
  return jurisdictions;
}

function profileAliasesResolve(profile: AcceptancePolicyProfile): boolean {
  const aliases = profile.region_aliases ?? {};
  const groups = [
    ...(profile.scope?.jurisdiction_groups ?? []),
    ...profile.rules.flatMap(rule => rule.jurisdiction_groups ?? []),
  ];
  return groups.every(group => Object.prototype.hasOwnProperty.call(aliases, group));
}

function completeScopeCovers(
  profile: AcceptancePolicyProfile,
  context: AcceptanceContext,
  appliesTo: AcceptancePolicySurface
): boolean {
  const scope = profile.scope;
  if (!scope?.applies_to?.includes(appliesTo)) return false;
  if (!context.subjects?.length || !scope.subject_categories?.length) return false;
  const scopedCategories = new Set(scope.subject_categories);
  if (context.subjects.some(subject => !scopedCategories.has(subject.subject_category))) return false;
  if (scope.all_jurisdictions === true) return true;
  if (!context.delivery_jurisdictions?.length) return false;
  const covered = new Set(scope.jurisdictions ?? []);
  for (const jurisdiction of expandedJurisdictions(profile, scope.jurisdiction_groups ?? [])) {
    covered.add(jurisdiction);
  }
  return context.delivery_jurisdictions.every(jurisdiction => covered.has(jurisdiction));
}

function ruleMatches(
  profile: AcceptancePolicyProfile,
  rule: AcceptancePolicyRule,
  contextIndex: AcceptanceContextIndex,
  appliesTo: AcceptancePolicySurface,
  evaluatedAtMs: number
): RuleMatch {
  if (!rule.applies_to.includes(appliesTo)) return false;
  let uncertain = false;
  if (rule.effective_at !== undefined) {
    const effectiveAtMs = Date.parse(rule.effective_at);
    if (!Number.isFinite(effectiveAtMs)) uncertain = true;
    else if (evaluatedAtMs < effectiveAtMs) return false;
  }
  if (rule.expires_at !== undefined) {
    const expiresAtMs = Date.parse(rule.expires_at);
    if (!Number.isFinite(expiresAtMs)) uncertain = true;
    else if (evaluatedAtMs >= expiresAtMs) return false;
  }

  const subjects = contextIndex.subjectsByCategory.get(rule.subject_category);
  if (!contextIndex.hasSubjects) {
    uncertain = true;
  } else if (!subjects) {
    return false;
  }

  if (subjects && rule.subject_facets?.length) {
    if (!rule.subject_facets.some(facet => subjects.facets.has(facet))) {
      if (!subjects.hasMissingFacets) return false;
      uncertain = true;
    }
  }

  if (rule.advertiser_roles?.length) {
    if (contextIndex.advertiserRoles.size === 0) {
      uncertain = true;
    } else if (!rule.advertiser_roles.some(role => contextIndex.advertiserRoles.has(role))) {
      return false;
    }
  }

  if (rule.jurisdictions?.length || rule.jurisdiction_groups?.length) {
    if (
      rule.jurisdiction_groups?.some(
        group => !Object.prototype.hasOwnProperty.call(profile.region_aliases ?? {}, group)
      )
    ) {
      return 'unknown';
    }
    if (contextIndex.deliveryJurisdictions.size === 0) {
      uncertain = true;
    } else {
      const expected = new Set(rule.jurisdictions ?? []);
      for (const jurisdiction of expandedJurisdictions(profile, rule.jurisdiction_groups ?? [])) {
        expected.add(jurisdiction);
      }
      if (![...expected].some(jurisdiction => contextIndex.deliveryJurisdictions.has(jurisdiction))) return false;
    }
  }

  return uncertain ? 'unknown' : true;
}

function requirementsOutcome(requirements: readonly AcceptancePolicyRequirement[]): AcceptancePolicyOutcome {
  const kinds = new Set<string>(requirements.map(requirement => String(requirement.kind)));
  if ([...kinds].some(kind => REVIEW_REQUIREMENTS.has(kind))) return 'requires_review';
  if ([...kinds].some(kind => SETUP_REQUIREMENTS.has(kind))) return 'requires_setup';
  if ([...kinds].every(kind => DISCLOSURE_REQUIREMENTS.has(kind))) return 'requires_disclosure';
  return 'requires_review';
}

function cloneRequirement(requirement: AcceptancePolicyRequirement): AcceptancePolicyRequirement {
  return JSON.parse(JSON.stringify(requirement)) as AcceptancePolicyRequirement;
}

function consumeAssessmentComplexity(
  value: unknown,
  budget: { nodes: number; stringCodeUnits: number }
): 'valid' | 'invalid' | 'limit' {
  const pending: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }];
  const ancestors = new WeakSet<object>();
  let queuedNodes = 1;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.exit) {
      ancestors.delete(current.value as object);
      continue;
    }
    queuedNodes -= 1;
    budget.nodes += 1;
    if (budget.nodes > MAX_ASSESSMENT_JSON_NODES) return 'limit';
    if (current.depth > MAX_ASSESSMENT_JSON_DEPTH) return 'invalid';
    if (typeof current.value === 'string') {
      budget.stringCodeUnits += current.value.length;
      if (budget.stringCodeUnits > MAX_ASSESSMENT_STRING_CODE_UNITS) return 'limit';
      continue;
    }
    if (current.value === null || typeof current.value !== 'object') continue;
    if (ancestors.has(current.value)) return 'invalid';
    ancestors.add(current.value);
    pending.push({ ...current, exit: true });
    if (Array.isArray(current.value)) {
      if (budget.nodes + queuedNodes + current.value.length > MAX_ASSESSMENT_JSON_NODES) return 'limit';
      queuedNodes += current.value.length;
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    const record = current.value as Record<string, unknown>;
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      budget.stringCodeUnits += key.length;
      if (budget.stringCodeUnits > MAX_ASSESSMENT_STRING_CODE_UNITS) return 'limit';
      if (budget.nodes + queuedNodes + 1 > MAX_ASSESSMENT_JSON_NODES) return 'limit';
      queuedNodes += 1;
      pending.push({ value: record[key], depth: current.depth + 1 });
    }
  }
  return 'valid';
}

function exceedsContextValueLimit(context: AcceptanceContext): boolean {
  const subjects = Array.isArray(context.subjects) ? context.subjects : [];
  const advertiserRoles = Array.isArray(context.advertiser_roles) ? context.advertiser_roles : [];
  const deliveryJurisdictions = Array.isArray(context.delivery_jurisdictions) ? context.delivery_jurisdictions : [];
  if (
    subjects.length > MAX_ASSESSMENT_CONTEXT_VALUES ||
    advertiserRoles.length > MAX_ASSESSMENT_CONTEXT_VALUES ||
    deliveryJurisdictions.length > MAX_ASSESSMENT_CONTEXT_VALUES
  ) {
    return true;
  }
  let values = subjects.length + advertiserRoles.length + deliveryJurisdictions.length;
  for (const subject of subjects) {
    if (!subject || typeof subject !== 'object' || !Array.isArray(subject.subject_facets)) continue;
    values += subject.subject_facets.length;
    if (values > MAX_ASSESSMENT_CONTEXT_VALUES) return true;
  }
  return values > MAX_ASSESSMENT_CONTEXT_VALUES;
}

/**
 * Compose verified seller-default and product acceptance profiles
 * restrictively for one decision surface.
 *
 * The result is preflight guidance, not authorization. Missing profiles,
 * partial coverage, out-of-scope complete profiles, and omitted buyer facts
 * remain `unknown`; an explicit matching prohibition still wins.
 */
export function assessAcceptancePolicy(input: AssessAcceptancePolicyInput): AcceptancePolicyAssessment {
  if (!input || typeof input !== 'object' || !Array.isArray(input.profiles)) {
    return unknownAssessment([], [diagnostic('invalid_profile')]);
  }
  if (input.profiles.length > MAX_ASSESSMENT_PROFILES) {
    return unknownAssessment([], [diagnostic('assessment_limit_exceeded')]);
  }
  const profileIds = [
    ...new Set(
      input.profiles.flatMap(value =>
        value && typeof value === 'object' && value.resolution === 'resolved' && typeof value.profileId === 'string'
          ? [value.profileId]
          : []
      )
    ),
  ];
  if (input.profiles.length === 0) {
    return unknownAssessment(profileIds, [diagnostic('profile_unresolved')]);
  }
  if (!input.acceptanceContext || typeof input.acceptanceContext !== 'object') {
    return unknownAssessment(profileIds, [diagnostic('invalid_context')]);
  }
  if (!SURFACES.has(input.appliesTo)) {
    return unknownAssessment(profileIds, [diagnostic('incomplete_context')]);
  }
  if (exceedsContextValueLimit(input.acceptanceContext)) {
    return unknownAssessment(profileIds, [diagnostic('assessment_limit_exceeded')]);
  }
  const contextComplexity = consumeAssessmentComplexity(input.acceptanceContext, {
    nodes: 0,
    stringCodeUnits: 0,
  });
  if (contextComplexity === 'limit') {
    return unknownAssessment(profileIds, [diagnostic('assessment_limit_exceeded')]);
  }
  if (contextComplexity === 'invalid') {
    return unknownAssessment(profileIds, [diagnostic('invalid_context')]);
  }

  let contextValidator;
  let profileValidator;
  try {
    const adcpVersion = input.adcpVersion ?? ADCP_VERSION;
    contextValidator = getSchemaValidatorByRef(CONTEXT_SCHEMA_REF, adcpVersion);
    profileValidator = getSchemaValidatorByRef(PROFILE_SCHEMA_REF, adcpVersion);
  } catch {
    return unknownAssessment(profileIds, [diagnostic('schema_unavailable')]);
  }
  if (!contextValidator || !profileValidator) {
    return unknownAssessment(profileIds, [diagnostic('schema_unavailable')]);
  }
  if (!contextValidator(input.acceptanceContext)) {
    return unknownAssessment(profileIds, [diagnostic('invalid_context')]);
  }
  const mutableSubjectsByCategory = new Map<string, { facets: Set<string>; hasMissingFacets: boolean }>();
  for (const subject of input.acceptanceContext.subjects ?? []) {
    const indexed = mutableSubjectsByCategory.get(subject.subject_category) ?? {
      facets: new Set<string>(),
      hasMissingFacets: false,
    };
    if (!subject.subject_facets?.length) indexed.hasMissingFacets = true;
    else for (const facet of subject.subject_facets) indexed.facets.add(facet);
    mutableSubjectsByCategory.set(subject.subject_category, indexed);
  }
  const contextIndex: AcceptanceContextIndex = {
    hasSubjects: (input.acceptanceContext.subjects?.length ?? 0) > 0,
    subjectsByCategory: mutableSubjectsByCategory,
    advertiserRoles: new Set(input.acceptanceContext.advertiser_roles ?? []),
    deliveryJurisdictions: new Set(input.acceptanceContext.delivery_jurisdictions ?? []),
  };

  const evaluatedAt = input.evaluatedAt ?? new Date();
  const evaluatedAtMs = evaluatedAt instanceof Date ? evaluatedAt.getTime() : Date.parse(evaluatedAt);
  if (!Number.isFinite(evaluatedAtMs)) {
    return unknownAssessment(profileIds, [diagnostic('invalid_evaluation_time')]);
  }

  const diagnostics: AcceptancePolicyAssessmentDiagnostic[] = [];
  const matchingRules: Array<{ profileId: string; rule: AcceptancePolicyRule }> = [];
  let uncertain = false;
  const profiles: AcceptancePolicyProfile[] = [];
  const profileIdentities = new Map<string, { version: string; contentDigest: string }>();
  const seenProfileIdentities = new Set<string>();
  const countedProfileIdentities = new Set<string>();
  const measuredProfileObjects = new WeakSet<object>();
  const invalidProfileObjects = new WeakSet<object>();
  const profileValidationResults = new WeakMap<object, boolean>();
  const profileAliasResults = new WeakMap<object, boolean>();
  const complexityBudget = { nodes: 0, stringCodeUnits: 0 };
  let candidateRuleCount = 0;
  for (const value of input.profiles) {
    if (!value || typeof value !== 'object' || typeof value.profileId !== 'string') {
      uncertain = true;
      diagnostics.push(diagnostic('invalid_profile'));
      continue;
    }
    if (value.resolution !== 'resolved') {
      uncertain = true;
      diagnostics.push(
        value.resolution === 'missing' || value.resolution === 'unresolved'
          ? diagnostic('profile_unresolved', value.profileId)
          : diagnostic('invalid_profile', value.profileId)
      );
      continue;
    }
    const profileValue: unknown = value.profile;
    if (profileValue && typeof profileValue === 'object' && invalidProfileObjects.has(profileValue)) {
      uncertain = true;
      diagnostics.push(diagnostic('invalid_profile', value.profileId));
      continue;
    }
    if (profileValue && typeof profileValue === 'object' && !measuredProfileObjects.has(profileValue)) {
      measuredProfileObjects.add(profileValue);
      const complexity = consumeAssessmentComplexity(profileValue, complexityBudget);
      if (complexity === 'limit') {
        return unknownAssessment(profileIds, [...diagnostics, diagnostic('assessment_limit_exceeded')]);
      }
      if (complexity === 'invalid') {
        invalidProfileObjects.add(profileValue);
        uncertain = true;
        diagnostics.push(diagnostic('invalid_profile', value.profileId));
        continue;
      }
    }
    const candidateIdentityKey =
      typeof value.profile?.version === 'string' && typeof value.profile?.content_digest === 'string'
        ? `${value.profileId}\0${value.profile.version}\0${value.profile.content_digest}`
        : undefined;
    if (
      (candidateIdentityKey === undefined || !countedProfileIdentities.has(candidateIdentityKey)) &&
      Array.isArray(value.profile?.rules)
    ) {
      if (candidateIdentityKey !== undefined) countedProfileIdentities.add(candidateIdentityKey);
      candidateRuleCount += value.profile.rules.length;
      if (candidateRuleCount > MAX_ASSESSMENT_RULES) {
        return unknownAssessment(profileIds, [...diagnostics, diagnostic('assessment_limit_exceeded')]);
      }
    }
    let validProfile = false;
    if (profileValue && typeof profileValue === 'object' && profileValidationResults.has(profileValue)) {
      validProfile = profileValidationResults.get(profileValue) ?? false;
    } else {
      try {
        validProfile = profileValidator(value.profile);
      } catch {
        validProfile = false;
      }
      if (profileValue && typeof profileValue === 'object') {
        profileValidationResults.set(profileValue, validProfile);
      }
    }
    if (!validProfile || value.profile.profile_id !== value.profileId) {
      uncertain = true;
      diagnostics.push(diagnostic('invalid_profile', value.profileId));
      continue;
    }
    let aliasesValid = profileAliasResults.get(profileValue as object);
    if (aliasesValid === undefined) {
      aliasesValid = profileAliasesResolve(value.profile);
      profileAliasResults.set(profileValue as object, aliasesValid);
    }
    if (!aliasesValid) {
      uncertain = true;
      diagnostics.push(diagnostic('invalid_profile', value.profileId));
      continue;
    }
    const identityKey = `${value.profileId}\0${value.profile.version}\0${value.profile.content_digest}`;
    if (seenProfileIdentities.has(identityKey)) continue;
    seenProfileIdentities.add(identityKey);
    const knownIdentity = profileIdentities.get(value.profileId);
    if (
      knownIdentity &&
      (knownIdentity.version !== value.profile.version || knownIdentity.contentDigest !== value.profile.content_digest)
    ) {
      uncertain = true;
      diagnostics.push(diagnostic('profile_conflict', value.profileId));
      profiles.push(value.profile);
      continue;
    }
    if (knownIdentity) continue;
    profileIdentities.set(value.profileId, {
      version: value.profile.version,
      contentDigest: value.profile.content_digest,
    });
    profiles.push(value.profile);
  }

  for (const profile of profiles) {
    if (profile.coverage === 'partial') {
      uncertain = true;
      diagnostics.push(diagnostic('partial_coverage', profile.profile_id));
    } else if (!completeScopeCovers(profile, input.acceptanceContext, input.appliesTo)) {
      uncertain = true;
      diagnostics.push(diagnostic('incomplete_context', profile.profile_id));
    }

    for (const rule of profile.rules) {
      const match = ruleMatches(profile, rule, contextIndex, input.appliesTo, evaluatedAtMs);
      if (match === true) matchingRules.push({ profileId: profile.profile_id, rule });
      if (match === 'unknown') {
        uncertain = true;
        diagnostics.push(diagnostic('incomplete_context', profile.profile_id, rule.rule_id));
      }
    }
  }

  const requirements = matchingRules.flatMap(value => value.rule.requirements ?? []);
  const outcome: AcceptancePolicyOutcome = matchingRules.some(value => value.rule.disposition === 'prohibited')
    ? 'prohibited'
    : uncertain
      ? 'unknown'
      : requirements.length > 0
        ? requirementsOutcome(requirements)
        : 'allowed';

  return {
    advisory: true,
    outcome,
    profileIds: [...profileIdentities.keys()],
    matchingRuleIds: matchingRules.map(value => value.rule.rule_id),
    matchedRules: matchingRules.map(({ profileId, rule }) => ({
      profileId,
      ruleId: rule.rule_id,
      disposition: rule.disposition,
      policyIds: [...(rule.policy_ids ?? [])],
      requirements: (rule.requirements ?? []).map(cloneRequirement),
    })),
    requirements: requirements.map(cloneRequirement),
    diagnostics: dedupeDiagnostics(diagnostics),
  };
}
