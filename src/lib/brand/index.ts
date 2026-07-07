import type { RegistryClient, SaveBrandResponse } from '../registry';
import type { GetBrandIdentitySuccess } from '../types/core.generated';

export type BrandJsonRecord = Record<string, unknown>;
type ProtocolBrandLogo = NonNullable<GetBrandIdentitySuccess['logos']>[number];

export type BrandWebsiteAliasRelationship = 'owned';
export type BrandWebsiteAliasSource = 'brand_json_property';

export type BrandLogoOrientation = ProtocolBrandLogo['orientation'];
export type BrandLogoBackground = ProtocolBrandLogo['background'];
export type BrandLogoVariant = ProtocolBrandLogo['variant'];

export type BrandAssetExtractionMethod = 'embedded_pdf_image' | 'rendered_page_crop' | 'uploaded_asset' | 'manual';

export interface BrandAssetCropBox {
  x: number;
  y: number;
  width: number;
  height: number;
  coordinate_space?: 'pixels' | 'normalized_1000';
}

export interface BrandAssetCandidate {
  asset_id: string;
  asset_group_id?: string;
  url?: string;
  file?: string;
  source_page?: number;
  extraction_method?: BrandAssetExtractionMethod;
  width?: number;
  height?: number;
  crop_box?: BrandAssetCropBox;
  metadata?: BrandJsonRecord;
}

export type BrandAssetMappingTarget = 'logos[]';
export type BrandAssetReviewStatus = 'needs_review' | 'approved' | 'rejected';

export interface BrandLogoProposal extends Omit<ProtocolBrandLogo, 'url'> {
  id: string;
  url?: string;
  slots?: string[];
  [key: string]: unknown;
}

export interface BrandAssetMapping {
  asset_id: string;
  target: BrandAssetMappingTarget;
  review_status?: BrandAssetReviewStatus;
  confidence?: number;
  proposed_logo?: BrandLogoProposal;
  evidence?: BrandJsonRecord;
}

export interface BrandAssetMappingIssue {
  asset_id?: string;
  message: string;
}

export interface BrandAssetMappingValidationResult {
  valid: boolean;
  errors: BrandAssetMappingIssue[];
  warnings: BrandAssetMappingIssue[];
  approvedMappings: BrandAssetMapping[];
}

export type ResolveBrandAssetUrl = (
  candidate: BrandAssetCandidate | undefined,
  mapping: BrandAssetMapping
) => string | undefined;

export interface ApplyBrandAssetMappingsOptions {
  candidates?: BrandAssetCandidate[];
  mappings: BrandAssetMapping[];
  brandId?: string;
  assetsBaseUrl?: string;
  resolveAssetUrl?: ResolveBrandAssetUrl;
  approvedOnly?: boolean;
}

export interface AppliedBrandAssetMapping {
  asset_id: string;
  target: BrandAssetMappingTarget;
  logo_id: string;
  url: string;
}

export interface SkippedBrandAssetMapping {
  asset_id?: string;
  target?: BrandAssetMappingTarget;
  reason: string;
}

export interface ApplyBrandAssetMappingsResult<TBrandJson extends BrandJsonRecord = BrandJsonRecord> {
  brandJson: TBrandJson;
  appliedMappings: AppliedBrandAssetMapping[];
  skippedMappings: SkippedBrandAssetMapping[];
  warnings: BrandAssetMappingIssue[];
  errors: BrandAssetMappingIssue[];
}

export interface LogoSelectionOptions {
  requestedSlot: string;
  brandId?: string;
  background?: BrandLogoBackground;
  preferredVariant?: BrandLogoVariant;
}

export interface LogoSlotCoverageOptions {
  brandId?: string;
}

export interface LogoSlotCoverage {
  present: string[];
  missing: string[];
}

export interface UpdateBrandJsonFromMappingsOptions {
  registryClient: Pick<RegistryClient, 'getBrandJson' | 'saveBrand'>;
  domain: string;
  brandName?: string;
  existingBrandJson?: BrandJsonRecord | null;
  candidates?: BrandAssetCandidate[];
  mappings: BrandAssetMapping[];
  brandId?: string;
  assetsBaseUrl?: string;
  resolveAssetUrl?: ResolveBrandAssetUrl;
  dryRun?: boolean;
}

export interface UpdateBrandJsonFromMappingsResult extends ApplyBrandAssetMappingsResult {
  saved: boolean;
  saveResponse?: SaveBrandResponse;
}

export interface BrandWebsiteAlias {
  /** Normalized hostname/domain claimed by an owned website property. */
  domain: string;
  /** Where this alias was derived from. */
  source: BrandWebsiteAliasSource;
  /** Manifest path of the source property, e.g. `brands[0].properties[1]`. */
  path: string;
  /** Portfolio-local brand id when the alias came from `brands[]`. */
  brandId?: string;
  /** Human-readable brand name inferred from `name`, `brand_name`, or `names[]`. */
  brandName?: string;
  /** Property display name, when published. */
  propertyName?: string;
  /** Whether the source property was marked primary. */
  primary?: boolean;
  /** Only owned website properties are surfaced as brand aliases. */
  relationship: BrandWebsiteAliasRelationship;
}

export interface ExtractBrandWebsiteAliasesOptions {
  /** Restrict extraction to one `brands[]` entry. */
  brandId?: string;
  /**
   * Also inspect non-canonical compatibility fields (`domain`, `url`, and
   * `identifiers[]`). Defaults to false because brand.json property ownership
   * is attached to the canonical `identifier` field.
   */
  includeCompatibilityFields?: boolean;
}

export const COMMON_LOGO_SLOTS = [
  'logo_card_light',
  'logo_card_dark',
  'nav_header',
  'marketplace_listing',
  'ad_end_card',
] as const;

export function validateBrandAssetMappings(input: {
  candidates?: BrandAssetCandidate[];
  mappings: BrandAssetMapping[];
}): BrandAssetMappingValidationResult {
  const errors: BrandAssetMappingIssue[] = [];
  const warnings: BrandAssetMappingIssue[] = [];
  const candidatesById = indexCandidates(input.candidates ?? [], errors);
  const hasCandidates = (input.candidates?.length ?? 0) > 0;
  const approvedMappings: BrandAssetMapping[] = [];

  for (const mapping of input.mappings) {
    if (!mapping.asset_id?.trim()) {
      errors.push({ message: 'mapping.asset_id is required' });
      continue;
    }

    if (hasCandidates && !candidatesById.has(mapping.asset_id)) {
      errors.push({ asset_id: mapping.asset_id, message: 'mapping asset_id does not match a candidate asset_id' });
    }

    if (mapping.target !== 'logos[]') {
      errors.push({ asset_id: mapping.asset_id, message: `unsupported mapping target: ${String(mapping.target)}` });
      continue;
    }

    if (mapping.review_status === 'approved') {
      if (!mapping.proposed_logo) {
        errors.push({ asset_id: mapping.asset_id, message: 'approved logo mapping requires proposed_logo' });
        continue;
      }
      let approvedMappingIsUsable = true;
      if (!mapping.proposed_logo.id?.trim()) {
        errors.push({ asset_id: mapping.asset_id, message: 'approved logo mapping requires proposed_logo.id' });
        approvedMappingIsUsable = false;
      }
      if (approvedMappingIsUsable) approvedMappings.push(mapping);
    } else if (!mapping.review_status) {
      warnings.push({
        asset_id: mapping.asset_id,
        message: 'review_status is missing; mapping will not be applied by default',
      });
    }
  }

  return { valid: errors.length === 0, errors, warnings, approvedMappings };
}

export function applyBrandAssetMappings<TBrandJson extends BrandJsonRecord>(
  brandJson: TBrandJson,
  options: ApplyBrandAssetMappingsOptions
): ApplyBrandAssetMappingsResult<TBrandJson> {
  const result = cloneJson(brandJson);
  const warnings: BrandAssetMappingIssue[] = [];
  const errors: BrandAssetMappingIssue[] = [];
  const skippedMappings: SkippedBrandAssetMapping[] = [];
  const appliedMappings: AppliedBrandAssetMapping[] = [];
  const candidatesById = indexCandidates(options.candidates ?? [], errors);
  const targetBrand = resolveWritableBrandRecord(result, options.brandId);

  if (!targetBrand.record) {
    return {
      brandJson: result,
      appliedMappings,
      skippedMappings: options.mappings.map(mapping => ({
        asset_id: mapping.asset_id,
        target: mapping.target,
        reason: 'brand record not found',
      })),
      warnings,
      errors: [{ message: targetBrand.reason }],
    };
  }

  for (const mapping of options.mappings) {
    if (options.approvedOnly !== false && mapping.review_status !== 'approved') {
      skippedMappings.push({ asset_id: mapping.asset_id, target: mapping.target, reason: 'mapping is not approved' });
      continue;
    }

    if (mapping.target !== 'logos[]') {
      skippedMappings.push({
        asset_id: mapping.asset_id,
        target: mapping.target,
        reason: 'unsupported mapping target',
      });
      continue;
    }

    if (!mapping.proposed_logo?.id?.trim()) {
      skippedMappings.push({ asset_id: mapping.asset_id, target: mapping.target, reason: 'missing proposed_logo.id' });
      continue;
    }

    const candidate = candidatesById.get(mapping.asset_id);
    if (!candidate && (options.candidates?.length ?? 0) > 0) {
      skippedMappings.push({
        asset_id: mapping.asset_id,
        target: mapping.target,
        reason: 'candidate asset_id not found',
      });
      continue;
    }

    const url = resolveLogoUrl(candidate, mapping, options);
    if (!url) {
      skippedMappings.push({
        asset_id: mapping.asset_id,
        target: mapping.target,
        reason: 'no durable URL resolved for logo',
      });
      warnings.push({
        asset_id: mapping.asset_id,
        message: 'logo mapping needs proposed_logo.url, candidate.url, or assetsBaseUrl',
      });
      continue;
    }

    if (!url.startsWith('https://')) {
      warnings.push({ asset_id: mapping.asset_id, message: 'logo URL is not HTTPS' });
    }

    const logo = buildLogoRecord(mapping.proposed_logo, candidate, url);
    upsertLogo(targetBrand.record, logo);
    appliedMappings.push({
      asset_id: mapping.asset_id,
      target: mapping.target,
      logo_id: mapping.proposed_logo.id,
      url,
    });
  }

  return { brandJson: result, appliedMappings, skippedMappings, warnings, errors };
}

export function selectLogoForSlot(
  brandJsonOrBrand: BrandJsonRecord,
  options: LogoSelectionOptions
): BrandJsonRecord | null {
  const brand = resolveReadableBrandRecord(brandJsonOrBrand, options.brandId);
  if (!brand.record) return null;

  const logos = readLogos(brand.record);
  let best: { logo: BrandJsonRecord; score: number } | null = null;

  for (const logo of logos) {
    const slotScore = scoreLogoForSlot(logo, options.requestedSlot);
    if (slotScore == null) continue;

    let score = slotScore;
    if (options.background && logo.background === options.background) score += 30;
    if (options.preferredVariant && logo.variant === options.preferredVariant) score += 10;

    if (!best || score > best.score) best = { logo, score };
  }

  return best?.logo ?? null;
}

export function checkLogoSlotCoverage(
  brandJsonOrBrand: BrandJsonRecord,
  requiredSlots: string[],
  options?: LogoSlotCoverageOptions
): LogoSlotCoverage {
  const present = new Set(
    requiredSlots.filter(slot =>
      selectLogoForSlot(brandJsonOrBrand, { requestedSlot: slot, brandId: options?.brandId })
    )
  );

  return {
    present: requiredSlots.filter(slot => present.has(slot)),
    missing: requiredSlots.filter(slot => !present.has(slot)),
  };
}

export async function updateBrandJsonFromMappings(
  options: UpdateBrandJsonFromMappingsOptions
): Promise<UpdateBrandJsonFromMappingsResult> {
  if (!options.domain?.trim()) throw new Error('domain is required');

  const existingBrandJson =
    options.existingBrandJson !== undefined
      ? options.existingBrandJson
      : await options.registryClient.getBrandJson(options.domain);
  const baseBrandJson = existingBrandJson ?? { domain: options.domain, name: options.brandName ?? options.domain };

  const applied = applyBrandAssetMappings(baseBrandJson, {
    candidates: options.candidates,
    mappings: options.mappings,
    brandId: options.brandId,
    assetsBaseUrl: options.assetsBaseUrl,
    resolveAssetUrl: options.resolveAssetUrl,
  });

  if (options.dryRun || applied.errors.length > 0) {
    return { ...applied, saved: false };
  }

  const brandName = options.brandName ?? inferBrandName(applied.brandJson, options.brandId) ?? options.domain;
  const saveResponse = await options.registryClient.saveBrand({
    domain: options.domain,
    brand_name: brandName,
    brand_manifest: applied.brandJson,
  });

  return { ...applied, saved: true, saveResponse };
}

export function extractBrandWebsiteAliases(
  brandJsonOrBrand: BrandJsonRecord,
  options?: ExtractBrandWebsiteAliasesOptions
): BrandWebsiteAlias[] {
  const aliases: BrandWebsiteAlias[] = [];
  const seen = new Set<string>();

  for (const brand of iterateBrandRecords(brandJsonOrBrand, options?.brandId)) {
    const properties = Array.isArray(brand.record.properties) ? brand.record.properties : [];
    for (let propertyIndex = 0; propertyIndex < properties.length; propertyIndex++) {
      const property = properties[propertyIndex];
      if (!isRecord(property)) continue;
      if (!isOwnedWebsiteProperty(property)) continue;

      for (const domain of extractWebsitePropertyDomains(property, {
        includeCompatibilityFields: options?.includeCompatibilityFields === true,
      })) {
        if (seen.has(domain)) continue;
        seen.add(domain);
        aliases.push({
          domain,
          source: 'brand_json_property',
          path: propertyPath(brand.path, propertyIndex),
          ...(brand.id ? { brandId: brand.id } : {}),
          ...(brand.name ? { brandName: brand.name } : {}),
          ...(typeof property.name === 'string' && property.name.trim() ? { propertyName: property.name } : {}),
          ...(property.primary === true ? { primary: true } : {}),
          relationship: 'owned',
        });
      }
    }
  }

  return aliases;
}

export function extractBrandWebsiteAliasDomains(
  brandJsonOrBrand: BrandJsonRecord,
  options?: ExtractBrandWebsiteAliasesOptions
): string[] {
  return extractBrandWebsiteAliases(brandJsonOrBrand, options).map(alias => alias.domain);
}

function indexCandidates(
  candidates: BrandAssetCandidate[],
  errors: BrandAssetMappingIssue[]
): Map<string, BrandAssetCandidate> {
  const indexed = new Map<string, BrandAssetCandidate>();

  for (const candidate of candidates) {
    if (!candidate.asset_id?.trim()) {
      errors.push({ message: 'candidate.asset_id is required' });
      continue;
    }
    if (indexed.has(candidate.asset_id)) {
      errors.push({ asset_id: candidate.asset_id, message: 'duplicate candidate asset_id' });
      continue;
    }
    indexed.set(candidate.asset_id, candidate);
  }

  return indexed;
}

function cloneJson<TBrandJson extends BrandJsonRecord>(value: TBrandJson): TBrandJson {
  return JSON.parse(JSON.stringify(value)) as TBrandJson;
}

function resolveWritableBrandRecord(
  root: BrandJsonRecord,
  brandId?: string
): { record: BrandJsonRecord | null; reason: string } {
  if (isNonEditableBrandJsonVariant(root)) {
    return { record: null, reason: 'brand.json variant is not editable by logo asset mappings' };
  }

  if (Array.isArray(root.brands)) {
    const brands = root.brands.filter(isRecord);
    if (brandId) {
      const brand = brands.find(matchesBrandId(brandId)) ?? null;
      return { record: brand, reason: brand ? '' : `brand not found for brandId: ${brandId}` };
    }
    if (Array.isArray(root.logos)) return { record: root, reason: '' };
    if (brands.length === 1) return { record: brands[0] ?? null, reason: '' };
    return { record: null, reason: 'brandId is required for multi-brand brand.json documents' };
  }

  if (Array.isArray(root.logos)) return { record: root, reason: '' };

  if (!isTopLevelBrandIdentity(root)) {
    return { record: null, reason: 'brand record not found' };
  }
  root.logos = [];
  return { record: root, reason: '' };
}

function resolveLogoUrl(
  candidate: BrandAssetCandidate | undefined,
  mapping: BrandAssetMapping,
  options: ApplyBrandAssetMappingsOptions
): string | undefined {
  const resolved = options.resolveAssetUrl?.(candidate, mapping);
  if (resolved) return resolved;
  if (mapping.proposed_logo?.url) return mapping.proposed_logo.url;
  if (candidate?.url) return candidate.url;

  const baseUrl = removeTrailingSlashes(options.assetsBaseUrl);
  if (!baseUrl || !candidate) return undefined;

  const path = candidate.file ?? candidate.asset_id;
  return `${baseUrl}/${path
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/')}`;
}

function removeTrailingSlashes(value: string | undefined): string | undefined {
  if (!value) return value;

  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

function buildLogoRecord(
  proposal: BrandLogoProposal,
  candidate: BrandAssetCandidate | undefined,
  url: string
): BrandJsonRecord {
  const logo: BrandJsonRecord = { ...proposal, url };
  if (logo.width === undefined && candidate?.width !== undefined) logo.width = candidate.width;
  if (logo.height === undefined && candidate?.height !== undefined) logo.height = candidate.height;
  return logo;
}

function upsertLogo(brand: BrandJsonRecord, logo: BrandJsonRecord): void {
  const currentLogos = Array.isArray(brand.logos) ? brand.logos : [];
  const logos = currentLogos.filter(isRecord);
  const logoId = typeof logo.id === 'string' ? logo.id : undefined;
  const existingIndex = logoId ? logos.findIndex(existing => existing.id === logoId) : -1;

  if (existingIndex >= 0) {
    logos[existingIndex] = { ...logos[existingIndex], ...logo };
  } else {
    logos.push(logo);
  }

  brand.logos = logos;
}

function readLogos(brandJsonOrBrand: BrandJsonRecord): BrandJsonRecord[] {
  if (Array.isArray(brandJsonOrBrand.logos)) return brandJsonOrBrand.logos.filter(isRecord);
  return [];
}

function iterateBrandRecords(
  root: BrandJsonRecord,
  brandId?: string
): Array<{ record: BrandJsonRecord; path: string; id?: string; name?: string }> {
  if (!Array.isArray(root.brands)) {
    return [{ record: root, path: '', id: readBrandId(root), name: inferBrandName(root) }];
  }

  const records: Array<{ record: BrandJsonRecord; path: string; id?: string; name?: string }> = [];
  for (let brandIndex = 0; brandIndex < root.brands.length; brandIndex++) {
    const brand = root.brands[brandIndex];
    if (!isRecord(brand)) continue;
    if (brandId && !matchesBrandId(brandId)(brand)) continue;
    records.push({ record: brand, path: `brands[${brandIndex}]`, id: readBrandId(brand), name: inferBrandName(brand) });
  }
  return records;
}

function propertyPath(brandPath: string, propertyIndex: number): string {
  return brandPath ? `${brandPath}.properties[${propertyIndex}]` : `properties[${propertyIndex}]`;
}

function readBrandId(brand: BrandJsonRecord): string | undefined {
  if (typeof brand.id === 'string' && brand.id.trim()) return brand.id;
  if (typeof brand.brand_id === 'string' && brand.brand_id.trim()) return brand.brand_id;
  return undefined;
}

function isOwnedWebsiteProperty(property: BrandJsonRecord): boolean {
  const propertyType = property.type ?? property.property_type;
  if (propertyType !== 'website') return false;

  const relationship = property.relationship;
  if (relationship !== undefined && relationship !== 'owned') return false;

  const delegationType = property.delegation_type;
  if (delegationType === 'direct' || delegationType === 'delegated' || delegationType === 'ad_network') return false;

  return true;
}

function extractWebsitePropertyDomains(
  property: BrandJsonRecord,
  options: { includeCompatibilityFields: boolean }
): string[] {
  const domains: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    const domain = normalizeWebsiteDomain(value);
    if (!domain || seen.has(domain)) return;
    seen.add(domain);
    domains.push(domain);
  };

  add(property.identifier);

  if (!options.includeCompatibilityFields) return domains;

  add(property.domain);
  add(property.url);

  if (Array.isArray(property.identifiers)) {
    for (const identifier of property.identifiers) {
      if (!isRecord(identifier)) continue;
      if (identifier.type !== 'domain' && identifier.type !== 'subdomain') continue;
      add(identifier.value);
      add(identifier.identifier);
      add(identifier.domain);
      add(identifier.url);
    }
  }

  return domains;
}

function normalizeWebsiteDomain(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  let candidate = trimmed;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) && !candidate.startsWith('//')) {
    candidate = `https://${candidate}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password) return null;

  const hostname = parsed.hostname.toLowerCase();
  return isDomainLikeHost(hostname) ? hostname : null;
}

function isDomainLikeHost(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253 || !hostname.includes('.')) return false;
  if (hostname.startsWith('.') || hostname.endsWith('.')) return false;

  const labels = hostname.split('.');
  return labels.every(label => {
    return label.length > 0 && label.length <= 63 && /^([a-z0-9]|[a-z0-9][a-z0-9-]*[a-z0-9])$/.test(label);
  });
}

function scoreLogoForSlot(logo: BrandJsonRecord, requestedSlot: string): number | null {
  if (arrayOfStrings(logo.slots).includes(requestedSlot)) return 100;

  switch (requestedSlot) {
    case 'logo_card_light':
      return logo.background === 'light-bg' || logo.background === 'transparent-bg' ? 50 : null;
    case 'logo_card_dark':
      return logo.background === 'dark-bg' || logo.background === 'transparent-bg' ? 50 : null;
    case 'nav_header':
      return logo.orientation === 'horizontal' || logo.variant === 'wordmark' || logo.variant === 'full-lockup'
        ? 40
        : null;
    case 'marketplace_listing':
      return logo.variant === 'primary' || logo.variant === 'full-lockup' || logo.variant === 'icon' ? 30 : null;
    case 'ad_end_card':
      return logo.background === 'dark-bg' || logo.background === 'light-bg' || logo.background === 'transparent-bg'
        ? 20
        : null;
    default:
      return null;
  }
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function inferBrandName(brandJson: BrandJsonRecord, brandId?: string): string | undefined {
  const brandRecord = findReadableBrandRecord(brandJson, brandId);
  if (typeof brandRecord?.name === 'string' && brandRecord.name.trim()) return brandRecord.name;
  if (typeof brandRecord?.brand_name === 'string' && brandRecord.brand_name.trim()) return brandRecord.brand_name;
  const localizedBrandName = readLocalizedName(brandRecord?.names);
  if (localizedBrandName) return localizedBrandName;
  if (typeof brandJson.name === 'string' && brandJson.name.trim()) return brandJson.name;
  if (typeof brandJson.brand_name === 'string' && brandJson.brand_name.trim()) return brandJson.brand_name;
  const localizedRootName = readLocalizedName(brandJson.names);
  if (localizedRootName) return localizedRootName;
  return undefined;
}

function findReadableBrandRecord(root: BrandJsonRecord, brandId?: string): BrandJsonRecord | null {
  return resolveReadableBrandRecord(root, brandId).record;
}

function resolveReadableBrandRecord(
  root: BrandJsonRecord,
  brandId?: string
): { record: BrandJsonRecord | null; reason: string } {
  if (Array.isArray(root.brands)) {
    const brands = root.brands.filter(isRecord);
    if (brandId) {
      const brand = brands.find(matchesBrandId(brandId)) ?? null;
      return { record: brand, reason: brand ? '' : `brand not found for brandId: ${brandId}` };
    }
    if (Array.isArray(root.logos)) return { record: root, reason: '' };
    if (brands.length === 1) return { record: brands[0] ?? null, reason: '' };
    return { record: null, reason: 'brandId is required for multi-brand brand.json documents' };
  }

  return { record: root, reason: '' };
}

function matchesBrandId(brandId: string): (brand: BrandJsonRecord) => boolean {
  return brand => brand.id === brandId || brand.brand_id === brandId || brand.domain === brandId;
}

function isNonEditableBrandJsonVariant(root: BrandJsonRecord): boolean {
  if (typeof root.authoritative_location === 'string') return true;
  if (typeof root.house === 'string') return true;

  const hasIdentityFields =
    Array.isArray(root.brands) ||
    Array.isArray(root.logos) ||
    typeof root.domain === 'string' ||
    typeof root.name === 'string' ||
    typeof root.brand_name === 'string' ||
    Array.isArray(root.names);

  return Array.isArray(root.agents) && !hasIdentityFields;
}

function isTopLevelBrandIdentity(root: BrandJsonRecord): boolean {
  return (
    typeof root.domain === 'string' ||
    typeof root.name === 'string' ||
    typeof root.brand_name === 'string' ||
    Array.isArray(root.names)
  );
}

function isRecord(value: unknown): value is BrandJsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readLocalizedName(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;

  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (typeof entry.en === 'string' && entry.en.trim()) return entry.en;
    for (const name of Object.values(entry)) {
      if (typeof name === 'string' && name.trim()) return name;
    }
  }

  return undefined;
}
