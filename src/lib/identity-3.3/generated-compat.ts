/**
 * Bridges the experimental AdCP 3.3 preview types to the generated wire types.
 *
 * The released SDK pins an AdCP schema version that predates the 3.3 identity
 * drafts, so the preview types in `./types` start from hand-written drafts. Once
 * the pinned schemas (or a candidate spec bundle built by the spec repo's
 * "Generate TypeScript SDK" check) define a shape, the generated type wins: the
 * preview type becomes an alias of it, so the two cannot drift apart and a
 * server that accepts the preview shape always emits a generated-valid payload.
 *
 * Internal: not re-exported from `@adcp/sdk/identity-3.3`.
 */
import type { GetAdCPCapabilitiesResponse } from '../types/tools.generated';

/**
 * The value type of an optional property `K` on `T`, or `unknown` when `T`
 * does not declare it. An object type without `K` is assignable to
 * `{ K?: V }`, so the absent case infers `unknown` rather than failing.
 */
export type OptionalPropertyOf<T, K extends PropertyKey> = T extends { [P in K]?: infer V } ? V : unknown;

/** `Generated` when the pinned schemas define it, otherwise `Draft`. */
export type PreferGenerated<Generated, Draft> = unknown extends Generated
  ? Draft
  : [NonNullable<Generated>] extends [never]
    ? Draft
    : NonNullable<Generated>;

/**
 * Resolves `account.agent_onboarding` from a `get_adcp_capabilities` account
 * shape, falling back to the draft when that shape does not declare it.
 * Parameterised so type tests can exercise it against fixtures of newer
 * generated shapes without regenerating the SDK.
 */
export type ResolveAgentOnboarding<Account, Draft> = PreferGenerated<
  OptionalPropertyOf<NonNullable<Account>, 'agent_onboarding'>,
  Draft
>;

/** `account` in the pinned `get_adcp_capabilities` response. */
export type GeneratedAccountCapabilities = NonNullable<GetAdCPCapabilitiesResponse['account']>;
