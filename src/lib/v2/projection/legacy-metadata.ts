import type { ProductFormatDeclaration } from '../../types/tools.generated';
import type { V1FormatId, V2ProductFormatDeclaration } from './types';
import { canonicalize } from '../../utils/jcs';
import type { VersionDrift } from '../../adapters/version/types';

type Json = Record<string, unknown>;
export interface LegacyPixelTracker {
  asset: Json;
  assetId: string;
  lostFields: string[];
}

const diagnostics = new WeakMap<object, readonly VersionDrift[]>();

/** Apply the AdCP 3.1 pixel-tracker schema's normative 3.0 downgrade table. */
export function downgradePixelTracker(value: unknown): LegacyPixelTracker | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const asset = value as Json;
  if (asset.asset_type !== 'pixel_tracker' || typeof asset.url !== 'string') return undefined;
  if (asset.method !== undefined && asset.method !== 'img' && asset.method !== 'js') return undefined;
  let assetId: string;
  const lostFields: string[] = [];
  switch (asset.event) {
    case 'impression':
      assetId = 'impression_tracker';
      break;
    case 'click':
      assetId = 'click_tracker';
      break;
    case 'viewable_mrc_50':
    case 'viewable_mrc_100':
    case 'viewable_video_50':
    case 'audible_video_complete':
      assetId = 'viewability_tracker';
      lostFields.push('event');
      break;
    case 'custom':
      if (typeof asset.custom_event_name !== 'string' || asset.custom_event_name.length === 0) return undefined;
      assetId = 'impression_tracker';
      lostFields.push('event', 'custom_event_name');
      break;
    default:
      return undefined;
  }
  if (asset.method === 'js') lostFields.push('method');
  const { event: _event, method: _method, custom_event_name: _custom, ...rest } = asset;
  return { asset: { ...rest, asset_type: 'url', url_type: 'tracker_pixel' }, assetId, lostFields };
}

export function pixelTrackerDrift(path: string, tracker: LegacyPixelTracker): VersionDrift | undefined {
  if (tracker.lostFields.length === 0) return undefined;
  return {
    type: 'PIXEL_TRACKER_LOSSY_DOWNGRADE',
    message:
      `${path} converted to a legacy URL tracker. ` +
      (tracker.lostFields.includes('event') ? 'The original event variant or custom timing is not represented. ' : '') +
      (tracker.lostFields.includes('method')
        ? 'The URL is requested as an image; its JavaScript does not execute. '
        : '') +
      'AdCP 3.0 cannot preserve these tracker semantics.',
    strippedFields: tracker.lostFields.map(field => `${path}.${field}`),
  };
}

/** Keep delivery advisories out of creative JSON sent to the seller. */
export function rememberCreativeDeliveryDiagnostics(value: object, entries: readonly VersionDrift[]): void {
  if (entries.length === 0) return;
  const combined = [...(diagnostics.get(value) ?? []), ...entries];
  diagnostics.set(value, [...new Map(combined.map(entry => [JSON.stringify(entry), entry])).values()]);
}

export function transferCreativeDeliveryDiagnostics(source: object, target: object): void {
  const entries = diagnostics.get(source);
  if (entries) diagnostics.set(target, entries);
}

/**
 * Read advisories from a projected creative or a sync/create/update request.
 * Pure projection callers can surface these alongside the returned wire object.
 * SingleAgentClient includes them in the task's debug logs automatically.
 */
export function getCreativeDeliveryDiagnostics(value: unknown): VersionDrift[] {
  const result: VersionDrift[] = [];
  const append = (creative: unknown, prefix: string): void => {
    if (!creative || typeof creative !== 'object') return;
    for (const entry of diagnostics.get(creative) ?? []) {
      result.push({
        ...entry,
        message: prefix ? `${prefix}: ${entry.message}` : entry.message,
        strippedFields: entry.strippedFields?.map(field => `${prefix}${prefix ? '.' : ''}${field}`),
      });
    }
  };
  append(value, '');
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  const request = value as Json;
  const creatives = (items: unknown, prefix: string): void => {
    if (Array.isArray(items)) items.forEach((item, index) => append(item, `${prefix}[${index}]`));
  };
  creatives(request.creatives, 'creatives');
  for (const field of ['packages', 'new_packages']) {
    const packages = request[field];
    if (!Array.isArray(packages)) continue;
    packages.forEach((pkg, index) => {
      if (pkg && typeof pkg === 'object') creatives((pkg as Json).creatives, `${field}[${index}].creatives`);
    });
  }
  return result;
}

/**
 * SDK-private projection metadata held out-of-band. WeakMaps keep seller
 * origin evidence and legacy routing identifiers absent from canonical objects
 * even under reflective inspection while still allowing object-spread package authoring.
 */

export type CanonicalFormatDeclaration = Omit<V2ProductFormatDeclaration, 'v1_format_ref'> & {
  v1_format_ref?: never;
};

type DeclarationWithMetadata = CanonicalFormatDeclaration;

export type PackageSelectionMetadata = {
  format_option_refs?: readonly unknown[];
};

const legacyRefsByDeclaration = new WeakMap<object, readonly V1FormatId[]>();
const selectedOptionsByRefs = new WeakMap<object, readonly DeclarationWithMetadata[]>();
const sellerDeclaredByDeclaration = new WeakMap<object, boolean | 'synthesized'>();
export interface SellerFormatEvidence {
  scopeKey: string;
  accountScope: string;
  productId: string;
  expiresAt: number;
}
const sellerEvidenceByDeclaration = new WeakMap<object, SellerFormatEvidence & { fingerprint: string }>();

/** Positive evidence is client/account-bound and cannot survive a JSON round trip on its own. */
export function rememberSellerFormatEvidence(declaration: object, evidence: SellerFormatEvidence): void {
  try {
    sellerEvidenceByDeclaration.set(
      declaration,
      Object.freeze({ ...evidence, fingerprint: canonicalize(declaration) })
    );
  } catch {
    // Malformed declarations cannot establish wire support.
  }
}

export function sellerFormatEvidence(declaration: object): SellerFormatEvidence | undefined {
  const evidence = sellerEvidenceByDeclaration.get(declaration);
  try {
    return evidence?.fingerprint === canonicalize(declaration) ? evidence : undefined;
  } catch {
    return undefined;
  }
}

/** Keep seller-origin evidence private while canonical products pass through the cache. */
export function rememberSellerDeclaredFormatOption(declaration: object, declared: boolean): void {
  sellerDeclaredByDeclaration.set(declaration, declared);
}

export function sellerDeclaredFormatOption(declaration: object): boolean | undefined {
  const origin = sellerDeclaredByDeclaration.get(declaration);
  return typeof origin === 'boolean' ? origin : undefined;
}

/** A pure legacy projection cannot establish what the original seller advertised. */
export function rememberSynthesizedFormatOption(declaration: object): void {
  sellerDeclaredByDeclaration.set(declaration, 'synthesized');
}

export function isSynthesizedFormatOption(declaration: object): boolean {
  return sellerDeclaredByDeclaration.get(declaration) === 'synthesized';
}

export function concealLegacyFormatRefs(
  declaration: ProductFormatDeclaration | V2ProductFormatDeclaration | CanonicalFormatDeclaration
): DeclarationWithMetadata {
  const { v1_format_ref: refs, ...canonical } = declaration as ProductFormatDeclaration;
  const existingHidden = legacyRefsByDeclaration.get(declaration as object);
  const refsToConceal = Array.isArray(existingHidden) && existingHidden.length > 0 ? existingHidden : refs;
  const declared = sellerDeclaredByDeclaration.get(declaration as object);
  if (declared !== undefined) sellerDeclaredByDeclaration.set(canonical, declared);
  const evidence = sellerEvidenceByDeclaration.get(declaration as object);
  if (evidence) sellerEvidenceByDeclaration.set(canonical, evidence);
  if (Array.isArray(refsToConceal) && refsToConceal.length > 0) {
    legacyRefsByDeclaration.set(
      canonical,
      refsToConceal.map(ref => ({ ...ref }))
    );
  }
  return canonical as DeclarationWithMetadata;
}

export function legacyFormatRefsForDeclaration(value: unknown): readonly V1FormatId[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const declaration = value as ProductFormatDeclaration & DeclarationWithMetadata;
  const hidden = legacyRefsByDeclaration.get(declaration);
  if (Array.isArray(hidden)) return hidden;
  return Array.isArray(declaration.v1_format_ref) ? declaration.v1_format_ref : [];
}

export function selectedFormatOptions(value: unknown): readonly DeclarationWithMetadata[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const refs = (value as PackageSelectionMetadata).format_option_refs;
  if (!Array.isArray(refs)) return [];
  const selected = selectedOptionsByRefs.get(refs);
  return Array.isArray(selected) ? selected : [];
}

export function concealSelectedFormatOptions(
  refs: readonly unknown[],
  declarations: readonly DeclarationWithMetadata[]
): void {
  selectedOptionsByRefs.set(refs, declarations);
}

/** Preserve out-of-band downgrade metadata when a canonical sanitizer clones a value. */
export function transferLegacyCreativeMetadata(source: object, target: object): void {
  transferCreativeDeliveryDiagnostics(source, target);
  const refs = legacyRefsByDeclaration.get(source);
  if (refs) legacyRefsByDeclaration.set(target, refs);
  const selected = selectedOptionsByRefs.get(source);
  if (selected) selectedOptionsByRefs.set(target, selected);
  const declared = sellerDeclaredByDeclaration.get(source);
  if (declared !== undefined) sellerDeclaredByDeclaration.set(target, declared);
  const evidence = sellerEvidenceByDeclaration.get(source);
  if (evidence) sellerEvidenceByDeclaration.set(target, evidence);
}

/**
 * Own a caller-provided canonical request without losing the SDK-private
 * downgrade routes attached by `packageRefsForFormatOptions()`.
 *
 * Native `structuredClone()` deliberately copies only the visible data graph;
 * the WeakMap sidecars therefore need to be transferred to each corresponding
 * cloned object after the data snapshot is complete.
 */
export function structuredCloneWithLegacyCreativeMetadata<T>(value: T): T {
  const clone = structuredClone(value);
  const visited = new WeakMap<object, object>();

  const snapshotMetadata = (source: object, target: object): void => {
    transferCreativeDeliveryDiagnostics(source, target);
    const declared = sellerDeclaredByDeclaration.get(source);
    if (declared !== undefined) sellerDeclaredByDeclaration.set(target, declared);
    const evidence = sellerEvidenceByDeclaration.get(source);
    if (evidence) sellerEvidenceByDeclaration.set(target, evidence);
    const refs = legacyRefsByDeclaration.get(source);
    if (refs) legacyRefsByDeclaration.set(target, structuredClone(refs));
    const selected = selectedOptionsByRefs.get(source);
    if (selected) {
      selectedOptionsByRefs.set(
        target,
        selected.map(declaration => {
          const declarationClone = structuredClone(declaration) as DeclarationWithMetadata;
          snapshotMetadata(declaration, declarationClone);
          return declarationClone;
        })
      );
    }
  };

  const transferGraph = (source: unknown, target: unknown): void => {
    if (source === null || target === null || typeof source !== 'object' || typeof target !== 'object') {
      return;
    }
    if (visited.has(source)) return;
    visited.set(source, target);
    snapshotMetadata(source, target);

    for (const key of Reflect.ownKeys(source)) {
      const sourceDescriptor = Object.getOwnPropertyDescriptor(source, key);
      const targetDescriptor = Object.getOwnPropertyDescriptor(target, key);
      if (!sourceDescriptor || !targetDescriptor || !('value' in sourceDescriptor) || !('value' in targetDescriptor)) {
        continue;
      }
      transferGraph(sourceDescriptor.value, targetDescriptor.value);
    }
  };

  transferGraph(value, clone);
  return clone;
}
