// AdCP 3.3 initial-start gate: `packages[].start_requires_all_creatives_approved`
// on `control_media_buy` holds a package's first enablement for serving until
// every assigned creative is approved. Opting in requires the seller's
// `media_buy.features.creative_start_policy: true`. Buyers MUST NOT send `true`
// without it, and a seller that does not declare it MUST reject `true` with
// UNSUPPORTED_FEATURE before mutation. `false` is the default and always allowed.
//
// Both halves follow from the seller's declared capabilities, so the SDK applies
// them: the server dispatcher before the handler runs, and the client before
// sending when it has already discovered the seller (#3649). Without the seller
// half, a seller that does not know the field ignores it and the buy starts
// serving before its creatives are approved, the opposite of what the buyer
// asked for.
//
// `create_media_buy` and `update_media_buy` are not gated: AdCP 3.3 withdraws
// the field from their packages (adcontextprotocol/adcp#8767), and their open
// schemas ignore it. The error vocabulary matches adcp-client-python.

/** The package field that opts a package into the initial-start gate. */
export const CREATIVE_START_POLICY_FIELD = 'start_requires_all_creatives_approved';

/** The capability a seller declares to accept `true`. */
export const CREATIVE_START_POLICY_FEATURE = 'media_buy.features.creative_start_policy';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Field paths (`packages[N].start_requires_all_creatives_approved`) of every package that sets the policy to `true`. */
export function creativeStartPolicyOptInFields(params: unknown): string[] {
  const packages = record(params) ? params.packages : undefined;
  if (!Array.isArray(packages)) return [];
  return packages.flatMap((pkg, index) =>
    record(pkg) && pkg[CREATIVE_START_POLICY_FIELD] === true
      ? [`packages[${index}].${CREATIVE_START_POLICY_FIELD}`]
      : []
  );
}

/** Whether a `get_adcp_capabilities` response declares `media_buy.features.creative_start_policy: true`. */
export function declaresCreativeStartPolicy(capabilities: unknown): boolean {
  const mediaBuy = record(capabilities) ? capabilities.media_buy : undefined;
  const features = record(mediaBuy) ? mediaBuy.features : undefined;
  return record(features) && features.creative_start_policy === true;
}

/** Seller-side refusal of an opted-in `control_media_buy`, for `adcpError('UNSUPPORTED_FEATURE', ...)`. */
export function undeclaredCreativeStartPolicyRefusal(fields: readonly string[]) {
  return {
    message: `${CREATIVE_START_POLICY_FIELD}: true requires ${CREATIVE_START_POLICY_FEATURE}, which this seller does not declare`,
    field: fields[0],
    suggestion: `Omit ${CREATIVE_START_POLICY_FIELD} or send false; check ${CREATIVE_START_POLICY_FEATURE} in get_adcp_capabilities before opting in`,
    recovery: 'correctable' as const,
    details: { feature: CREATIVE_START_POLICY_FEATURE, fields: [...fields] },
  };
}
