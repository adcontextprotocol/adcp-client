import { z } from 'zod';

import { ReportingExternalIdV1Schema } from './manifest';

const productIds = z.array(ReportingExternalIdV1Schema).min(1).max(10_000);
const constituentKinds = z
  .array(z.enum(['product', 'package_item', 'media_buy']))
  .min(1)
  .max(3);

// Preserve legacy declarations byte-for-byte: rewriting them would change
// capability hashes and the immutable lineage of existing configurations.
export const ReportingSourceApplicabilityV1Schema = z.union([
  z.strictObject({ productIds, constituentKinds, products: z.never().optional() }),
  z.strictObject({
    // Keep the required string[] property for existing TypeScript readers.
    // An empty list makes older allowlist-only readers fail closed.
    productIds: z.array(ReportingExternalIdV1Schema).length(0),
    products: z.strictObject({ kind: z.literal('host_attested') }),
    constituentKinds,
  }),
]);

export type ReportingSourceApplicabilityV1 = z.output<typeof ReportingSourceApplicabilityV1Schema>;

/** Undefined means the trusted host attests product eligibility per configuration. */
export function listedReportingSourceProductIdsV1(
  applicability: ReportingSourceApplicabilityV1
): readonly string[] | undefined {
  return applicability.products?.kind === 'host_attested' ? undefined : applicability.productIds;
}
