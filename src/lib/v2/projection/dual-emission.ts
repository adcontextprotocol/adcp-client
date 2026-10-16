import type { V1FormatId, V2ProductFormatDeclaration } from './types';
import {
  concealLegacyFormatRefs,
  legacyFormatRefsForDeclaration,
  transferLegacyCreativeMetadata,
} from './legacy-metadata';
import { canonicalDeclarationFromBareId } from './v1-to-v2';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sameIdentity(left: V1FormatId, right: V1FormatId): boolean {
  const url = (value: string): string => {
    try {
      return new URL(value).href;
    } catch {
      return value;
    }
  };
  return (
    url(left.agent_url) === url(right.agent_url) &&
    left.id === right.id &&
    ['width', 'height', 'duration_ms'].every(key => {
      const field = key as 'width' | 'height' | 'duration_ms';
      return left[field] === undefined || right[field] === undefined || left[field] === right[field];
    })
  );
}

function compatible(option: Record<string, unknown>, ref: V1FormatId): boolean {
  const known = canonicalDeclarationFromBareId(ref.id, { agentUrl: ref.agent_url });
  if (known && known.format_kind !== option.format_kind) return false;
  const params = record(option.params) ?? {};
  const knownParams = record(known?.params) ?? {};
  const constraints = {
    width: ref.width ?? knownParams.width,
    height: ref.height ?? knownParams.height,
    duration_ms_exact: ref.duration_ms ?? knownParams.duration_ms_exact,
  };
  if (
    Object.entries(constraints).some(
      ([key, value]) => typeof value === 'number' && typeof params[key] === 'number' && value !== params[key]
    )
  ) {
    return false;
  }
  if (Array.isArray(params.sizes) && params.sizes.length > 0) {
    return params.sizes.some(value => {
      const size = record(value);
      return (
        size &&
        ['width', 'height'].every(key => {
          const actual = constraints[key as 'width' | 'height'];
          return typeof actual !== 'number' || typeof size[key] !== 'number' || actual === size[key];
        })
      );
    });
  }
  return true;
}

/** Preserve index pairing only when the whole seller-authored alignment is credible. */
export function withDualEmissionLegacyRefs<T>(formatOptions: T[], formatIds: unknown): T[] {
  if (!Array.isArray(formatIds) || formatIds.length !== formatOptions.length) return formatOptions;
  const aligned = formatOptions.every((value, index) => {
    const option = record(value);
    const ref = record(formatIds[index]);
    if (
      !option ||
      typeof option.format_kind !== 'string' ||
      option.canonical_formats_only === true ||
      !ref ||
      typeof ref.agent_url !== 'string' ||
      ref.agent_url.length === 0 ||
      typeof ref.id !== 'string' ||
      ref.id.length === 0
    ) {
      return false;
    }
    const typedRef = ref as unknown as V1FormatId;
    const explicit = legacyFormatRefsForDeclaration(option);
    return explicit.length > 0
      ? explicit.some(existing => sameIdentity(existing, typedRef))
      : compatible(option, typedRef);
  });
  if (!aligned) return formatOptions;
  return formatOptions.map((value, index) => {
    if (legacyFormatRefsForDeclaration(value).length > 0) return value;
    const paired = concealLegacyFormatRefs({
      ...value,
      v1_format_ref: [{ ...formatIds[index] }],
    } as unknown as V2ProductFormatDeclaration);
    transferLegacyCreativeMetadata(value as object, paired);
    return paired as T;
  });
}
