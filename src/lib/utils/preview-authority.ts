/**
 * Pure preview-authority selection for AdCP consumers.
 *
 * This module selects already-discovered candidates. It deliberately does not
 * fetch presentation metadata, call preview providers, resolve npm packages,
 * or execute renderer code.
 */

export type PreviewFidelity = 'authoritative' | 'representative';

export interface SellerPreviewCandidate<T> {
  fidelity: PreviewFidelity;
  value: T;
}

export interface PlacementPreviewCandidate<T> {
  placementId: string;
  value: T;
}

export interface PreviewAuthorityInput<TSeller, TProvider, TPresentation, TReference, TManifest> {
  /** Seller preview plus fidelity discovered through creative.preview. */
  sellerPreview?: SellerPreviewCandidate<TSeller>;
  /** Placement currently being represented. Required to select placement-scoped candidates. */
  targetPlacementId?: string;
  /** Preview provider explicitly delegated by the targeted publisher placement. */
  publisherPreviewProvider?: PlacementPreviewCandidate<TProvider>;
  /** Immutable presentation metadata declared by the targeted publisher placement. */
  publisherPresentation?: PlacementPreviewCandidate<TPresentation>;
  /** Prepared output from the community registry's pinned reference renderer. */
  communityReference?: TReference;
  /** Canonical manifest/assets fallback. */
  manifest: TManifest;
}

export type SelectedPreviewAuthority<TSeller, TProvider, TPresentation, TReference, TManifest> =
  | {
      kind: 'serving_platform';
      authoritative: true;
      value: TSeller;
    }
  | {
      kind: 'publisher_preview_provider';
      authoritative: true;
      placementId: string;
      value: TProvider;
    }
  | {
      kind: 'publisher_presentation';
      authoritative: true;
      placementId: string;
      value: TPresentation;
    }
  | {
      kind: 'community_reference';
      authoritative: false;
      value: TReference;
    }
  | {
      kind: 'manifest';
      authoritative: false;
      value: TManifest;
    };

export interface PreviewAuthorityResolution<TSeller, TProvider, TPresentation, TReference, TManifest> {
  selected: SelectedPreviewAuthority<TSeller, TProvider, TPresentation, TReference, TManifest>;
  /**
   * Representative seller output remains available for a clearly labeled
   * secondary view but never displaces publisher-scoped authority.
   */
  representativeSellerPreview?: TSeller;
  /** Placement-scoped inputs ignored because they did not match the target. */
  ignoredPlacementCandidates: Array<'publisher_preview_provider' | 'publisher_presentation'>;
}

function matchingPlacement<T>(
  candidate: PlacementPreviewCandidate<T> | undefined,
  targetPlacementId: string | undefined
): PlacementPreviewCandidate<T> | undefined {
  return candidate !== undefined && targetPlacementId !== undefined && candidate.placementId === targetPlacementId
    ? candidate
    : undefined;
}

/**
 * Resolve the AdCP preview authority order without executing side effects.
 *
 * Placement-scoped candidates fail closed unless their placement ID exactly
 * matches the target. Representative seller output is returned only as a
 * secondary view; it is never inserted into the authoritative chain.
 */
export function resolvePreviewAuthority<TSeller, TProvider, TPresentation, TReference, TManifest>(
  input: PreviewAuthorityInput<TSeller, TProvider, TPresentation, TReference, TManifest>
): PreviewAuthorityResolution<TSeller, TProvider, TPresentation, TReference, TManifest> {
  const ignoredPlacementCandidates: PreviewAuthorityResolution<
    TSeller,
    TProvider,
    TPresentation,
    TReference,
    TManifest
  >['ignoredPlacementCandidates'] = [];
  const matchedProvider = matchingPlacement(input.publisherPreviewProvider, input.targetPlacementId);
  const matchedPresentation = matchingPlacement(input.publisherPresentation, input.targetPlacementId);
  if (input.publisherPreviewProvider && !matchedProvider) {
    ignoredPlacementCandidates.push('publisher_preview_provider');
  }
  if (input.publisherPresentation && !matchedPresentation) {
    ignoredPlacementCandidates.push('publisher_presentation');
  }

  const representativeSellerPreview =
    input.sellerPreview?.fidelity === 'representative' ? input.sellerPreview.value : undefined;
  let selected: PreviewAuthorityResolution<TSeller, TProvider, TPresentation, TReference, TManifest>['selected'];

  if (input.sellerPreview?.fidelity === 'authoritative') {
    selected = {
      kind: 'serving_platform',
      authoritative: true,
      value: input.sellerPreview.value,
    };
  } else if (matchedProvider) {
    selected = {
      kind: 'publisher_preview_provider',
      authoritative: true,
      placementId: matchedProvider.placementId,
      value: matchedProvider.value,
    };
  } else if (matchedPresentation) {
    selected = {
      kind: 'publisher_presentation',
      authoritative: true,
      placementId: matchedPresentation.placementId,
      value: matchedPresentation.value,
    };
  } else if (input.communityReference !== undefined) {
    selected = {
      kind: 'community_reference',
      authoritative: false,
      value: input.communityReference,
    };
  } else {
    selected = {
      kind: 'manifest',
      authoritative: false,
      value: input.manifest,
    };
  }

  return {
    selected,
    ...(representativeSellerPreview === undefined ? {} : { representativeSellerPreview }),
    ignoredPlacementCandidates,
  };
}
