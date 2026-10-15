/**
 * The experimental AdCP 3.3 identity preview types must stay compatible with
 * whatever the pinned schemas generate. The spec repo's "Generate TypeScript
 * SDK" check builds this SDK against each spec PR's schemas, so a preview type
 * that only matches today's pin breaks spec PRs that move the generated shape
 * (adcp#8177, adcp#8170). These checks cover both the pinned schemas and
 * fixtures of the newer generated shapes.
 */
import type {
  AgentOnboarding,
  AgentOnboardingRequirement,
  AgentOnboardingTier,
  ObservedAgentOnboardingRequirement,
} from '../lib/identity-3.3';
import { evaluateOnboardingRequirements } from '../lib/identity-3.3';
import type {
  GeneratedAccountCapabilities,
  OptionalPropertyOf,
  ResolveAgentOnboarding,
} from '../lib/identity-3.3/generated-compat';
import type {
  CanonicalCreateMediaBuyInput,
  CanonicalCreateMediaBuyRequest,
  ClientReportingWebhookInputFor,
} from '../lib/v2/projection/creative-delivery';
import type { MutatingRequestInput } from '../lib';
import type { ReportingWebhook, AuthenticationScheme } from '../lib/types/tools.generated';

type Assert<T extends true> = T;
type Extends<A, B> = [A] extends [B] ? true : false;
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// ---------------------------------------------------------------------------
// Reporting webhook authentication (adcp#8177)
// ---------------------------------------------------------------------------

// Pinned schemas: every wire request is a valid client input.
export type PinnedCreateRequestIsClientInput = Assert<
  Extends<MutatingRequestInput<CanonicalCreateMediaBuyRequest>, MutatingRequestInput<CanonicalCreateMediaBuyInput>>
>;

/** adcp#8177: `authentication` becomes optional from 3.3. */
type ReportingWebhook33 = Omit<ReportingWebhook, 'authentication'> & {
  authentication?: { schemes: [AuthenticationScheme]; credentials: string };
};
/** A later release that drops legacy `authentication` entirely. */
type ReportingWebhookWithoutAuthentication = Omit<ReportingWebhook, 'authentication'>;

export type PinnedWebhookIsClientInput = Assert<
  Extends<ReportingWebhook, ClientReportingWebhookInputFor<ReportingWebhook>>
>;
export type OptionalAuthWebhookIsClientInput = Assert<
  Extends<ReportingWebhook33, ClientReportingWebhookInputFor<ReportingWebhook33>>
>;
export type NoAuthWebhookIsClientInput = Assert<
  Extends<ReportingWebhookWithoutAuthentication, ClientReportingWebhookInputFor<ReportingWebhookWithoutAuthentication>>
>;

// A caller may omit `authentication` alongside its own URL; the client enforces
// it at runtime below 3.3.
const callerUrlWithoutAuthentication: NonNullable<CanonicalCreateMediaBuyInput['reporting_webhook']> = {
  url: 'https://buyer.example/reporting',
  reporting_frequency: 'daily',
};
void callerUrlWithoutAuthentication;
const callerUrlWithoutAuthentication33: ClientReportingWebhookInputFor<ReportingWebhook33> = {
  url: 'https://buyer.example/reporting',
  reporting_frequency: 'daily',
};
void callerUrlWithoutAuthentication33;

// Authentication stays atomic: `schemes` cannot be paired with credentials from
// another source.
const partialAuthentication33: ClientReportingWebhookInputFor<ReportingWebhook33> = {
  reporting_frequency: 'daily',
  // @ts-expect-error `credentials` is required whenever `authentication` is present.
  authentication: { schemes: ['HMAC-SHA256'] },
};
void partialAuthentication33;

// ---------------------------------------------------------------------------
// Seller onboarding posture (adcp#8170)
// ---------------------------------------------------------------------------

// Pinned schemas: when they define `account.agent_onboarding`, the preview type
// IS the generated type, so `createAdcpServer` can emit it into the generated
// capabilities response.
type PinnedGeneratedOnboarding = OptionalPropertyOf<GeneratedAccountCapabilities, 'agent_onboarding'>;
export type PinnedOnboardingMatchesGenerated = Assert<
  unknown extends PinnedGeneratedOnboarding
    ? true
    : MutuallyAssignable<AgentOnboarding, NonNullable<PinnedGeneratedOnboarding>>
>;

/**
 * Fixture modelled on the shape adcp#8170 generates at 7e1b79a13: one mode enum,
 * no agent_identity kind, `verified_specialisms`, no `documentation_url`, and
 * billing tiers keyed by an index signature.
 */
type FixtureOnboardingMode = 'open' | 'application' | 'invite_only';
type FixtureRequirementKind =
  | 'grant'
  | 'billing_entity'
  | 'contract'
  | 'credit_application'
  | 'aao_verified'
  | 'storyboard'
  | 'sandbox'
  | 'experimental_feature';
interface FixtureRequirement {
  kind: FixtureRequirementKind;
  role?: string;
  verification_modes?: [string, ...string[]];
  verified_specialisms?: [string, ...string[]];
  adcp_version?: string;
  id?: string;
  ext?: { [k: string]: unknown };
}
interface FixtureTier {
  mode: FixtureOnboardingMode;
  url?: string;
  requirements?: FixtureRequirement[];
  ext?: { [k: string]: unknown };
}
interface FixturePosture {
  sandbox?: FixtureTier;
  billing?: { [k: string]: FixtureTier | undefined };
  url?: string;
  message?: string;
  ext?: { [k: string]: unknown };
}
interface FixtureAccount {
  supported_billing: ('operator' | 'agent' | 'advertiser')[];
  sandbox?: boolean;
  agent_onboarding?: FixturePosture;
}
interface FixtureDraft {
  draft: true;
}

// The generated shape wins over the draft whenever the schemas define it...
export type FixtureOnboardingIsGenerated = Assert<
  MutuallyAssignable<ResolveAgentOnboarding<FixtureAccount, FixtureDraft>, FixturePosture>
>;
// ...and the draft applies only while they do not.
export type DraftWhenUndeclared = Assert<
  MutuallyAssignable<ResolveAgentOnboarding<Omit<FixtureAccount, 'agent_onboarding'>, FixtureDraft>, FixtureDraft>
>;

// Requirements read off the wire may carry kinds this SDK does not know; the
// evaluator accepts them, and every derived requirement, pinned or fixture.
export type PinnedRequirementIsObservable = Assert<
  Extends<AgentOnboardingRequirement, ObservedAgentOnboardingRequirement>
>;
export type FixtureRequirementIsObservable = Assert<Extends<FixtureRequirement, ObservedAgentOnboardingRequirement>>;
declare const tier: AgentOnboardingTier;
void evaluateOnboardingRequirements(tier.requirements ?? [], 'seller', async () => true);
void evaluateOnboardingRequirements(
  [{ kind: 'future_requirement_kind' }, { kind: 'storyboard', id: 'sales' }],
  'buyer',
  async requirement => requirement.kind === 'storyboard'
);
declare const fixtureRequirements: FixtureRequirement[];
void evaluateOnboardingRequirements(fixtureRequirements, 'seller', async requirement => requirement.kind === 'grant');

// Billing tiers and the sandbox tier share one derived tier type.
declare const onboarding: AgentOnboarding;
const operatorTier: AgentOnboardingTier | undefined = onboarding.billing?.operator;
void operatorTier;
