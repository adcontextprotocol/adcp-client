import type { ProductFormatDeclaration } from '../../types/tools.generated';
import type { V1FormatId, V2ProductFormatDeclaration } from './types';

/**
 * SDK-private downgrade metadata held out-of-band. WeakMaps keep legacy
 * routing identifiers absent from canonical objects even under reflective
 * inspection while still allowing object-spread package authoring.
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

export function concealLegacyFormatRefs(
  declaration: ProductFormatDeclaration | V2ProductFormatDeclaration | CanonicalFormatDeclaration
): DeclarationWithMetadata {
  const { v1_format_ref: refs, ...canonical } = declaration as ProductFormatDeclaration;
  const existingHidden = legacyRefsByDeclaration.get(declaration as object);
  const refsToConceal = Array.isArray(existingHidden) && existingHidden.length > 0 ? existingHidden : refs;
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
  const refs = legacyRefsByDeclaration.get(source);
  if (refs) legacyRefsByDeclaration.set(target, refs);
  const selected = selectedOptionsByRefs.get(source);
  if (selected) selectedOptionsByRefs.set(target, selected);
}
