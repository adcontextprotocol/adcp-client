import {
  inlineCreativesForPackages,
  inlineCreativesForPackagesLegacy,
  type CanonicalCreativeAsset,
  type CanonicalPackageRequest,
  type CanonicalPackageUpdate,
  type LegacyPackageRequest,
} from '../lib';
import type { LegacyCreativeAsset } from '../lib/v2/projection';

declare const canonicalCreatives: CanonicalCreativeAsset[];
declare const createPackages: CanonicalPackageRequest[];
declare const updatePackages: CanonicalPackageUpdate[];

const canonicalCreatePackages: CanonicalPackageRequest[] = inlineCreativesForPackages(
  createPackages,
  canonicalCreatives
);
const canonicalUpdatePackages: CanonicalPackageUpdate[] = inlineCreativesForPackages(
  updatePackages,
  canonicalCreatives
);

declare const wirePackages: LegacyPackageRequest[];
const legacyPackages = inlineCreativesForPackagesLegacy(wirePackages, canonicalCreatives, {
  creativeFormatWireMode: 'legacy',
});
const legacyCreatives: LegacyCreativeAsset[] | undefined = legacyPackages[0]?.creatives;

// @ts-expect-error Explicit legacy projection is not valid on the canonical primary API.
const legacyPackagesAsCanonical: CanonicalPackageRequest[] = legacyPackages;

declare const legacyCreativeInputs: LegacyCreativeAsset[];

// @ts-expect-error The primary helper does not accept legacy package format_ids.
inlineCreativesForPackages(wirePackages, canonicalCreatives);

// @ts-expect-error The primary helper does not accept legacy creative format_id.
inlineCreativesForPackages(createPackages, legacyCreativeInputs);

// @ts-expect-error Wire-mode overrides are available only on the explicit legacy helper.
inlineCreativesForPackages(createPackages, canonicalCreatives, { creativeFormatWireMode: 'legacy' });

// @ts-expect-error Legacy format_id must not appear in canonical helper output.
const canonicalOutputFormatId = canonicalCreatePackages[0]?.creatives?.[0]?.format_id.id;

void canonicalCreatePackages;
void canonicalUpdatePackages;
void legacyCreatives;
void legacyPackagesAsCanonical;
void canonicalOutputFormatId;
