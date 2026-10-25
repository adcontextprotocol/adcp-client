import type { ReportingSourceOfferingV1 } from '../lib/reporting/source';

type Applicability = ReportingSourceOfferingV1['applicability'];

const legacy: Applicability = { constituentKinds: ['media_buy'], productIds: ['fixed-product'] };
const hostAttested: Applicability = {
  constituentKinds: ['media_buy'],
  productIds: [],
  products: { kind: 'host_attested' },
};

// Existing readers retain their required string[] property and array methods.
function legacyReader(offering: ReportingSourceOfferingV1, productId: string): boolean {
  const ids: string[] = offering.applicability.productIds;
  return ids.includes(productId);
}

// @ts-expect-error The existing productIds property remains required in both modes.
const missingProductIds: Applicability = {
  constituentKinds: ['media_buy'],
  products: { kind: 'host_attested' },
};

void [legacy, hostAttested, legacyReader, missingProductIds];
