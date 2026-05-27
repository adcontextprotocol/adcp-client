import { lookupV1Format, projectV1ProductToV2 } from '../../v2/projection';
import type { V1FormatId, V2ProductFormatDeclaration } from '../../v2/projection';
import type { TaskResult } from '../types';
import type { RunnerRequestRecord, StoryboardContext, StoryboardValidation, ValidationResult } from './types';
import { resolvePath, toJsonPointer } from './path';

type BugClass = 'normalization' | 'directionality' | 'range_containment' | 'closed_set' | 'authoring';

interface SatisfactionVerdict {
  satisfied: boolean;
  bug_class: BugClass;
  detail: string;
  json_pointer: string | null;
  actual?: unknown;
  observations?: unknown[];
}

interface CanonicalSelector {
  format_kind: string;
  params: Record<string, unknown>;
  pointer: string;
}

const FORMAT_IDENTITY_KEYS = ['agent_url', 'id', 'width', 'height', 'duration_ms'] as const;
const HANDLED_CANONICAL_PARAM_KEYS = new Set([
  'width',
  'height',
  'sizes',
  'min_width',
  'max_width',
  'min_height',
  'max_height',
  'duration_ms',
  'duration_ms_exact',
  'duration_ms_range',
]);
const ARRAY_SUBSET_PARAM_KEYS = new Set(['video_codecs', 'audio_codecs', 'mime_types', 'file_types', 'formats']);

export function validateCanonicalFormatSatisfaction(
  validation: StoryboardValidation,
  request: RunnerRequestRecord | undefined,
  context: StoryboardContext | undefined,
  taskResult: TaskResult
): ValidationResult {
  if (typeof validation.value !== 'boolean') {
    return {
      check: validation.check,
      passed: false,
      description: validation.description,
      error:
        'canonical_format_satisfaction requires boolean `value` (true = request should be accepted, false = rejected)',
      json_pointer: null,
      expected: 'boolean validation.value',
      actual: validation.value ?? null,
    };
  }

  const expectedAccepted = validation.value;
  const taskAccepted = taskResult.success === true;
  const requestPayload = request?.payload;
  if (!isRecord(requestPayload)) {
    return {
      check: validation.check,
      passed: false,
      description: validation.description,
      error: 'canonical_format_satisfaction requires the runner request payload, but none was recorded',
      json_pointer: null,
      expected: 'create_media_buy request payload',
      actual: requestPayload ?? null,
    };
  }

  const packages = resolvePackages(requestPayload, validation.path);
  if (!packages.ok) {
    return {
      check: validation.check,
      passed: false,
      description: validation.description,
      error: packages.error,
      path: validation.path,
      json_pointer: packages.pointer,
      expected: 'one PackageRequest object or packages[] array',
      actual: packages.actual,
    };
  }

  const products = Array.isArray(context?.products) ? (context!.products as unknown[]) : [];
  const packageVerdicts = packages.packages.map(({ value, pointer }, index) =>
    evaluatePackage(value, pointer, index, products)
  );
  const localSatisfied = packageVerdicts.every(v => v.satisfied);
  const firstFailure = packageVerdicts.find(v => !v.satisfied);
  const primary = firstFailure ?? packageVerdicts[0];

  const localMatchesExpectation = localSatisfied === expectedAccepted;
  const observedMatchesExpectation = taskAccepted === expectedAccepted;
  const rejection = extractRejectionInfo(taskResult);
  const negativeRejectionMatches =
    expectedAccepted || taskAccepted || localSatisfied ? true : rejectionSupportsFormatFailure(rejection);
  const passed = localMatchesExpectation && observedMatchesExpectation && negativeRejectionMatches;
  if (passed) {
    return {
      check: validation.check,
      passed: true,
      description: validation.description,
      path: validation.path,
      json_pointer: primary?.json_pointer ?? null,
      expected: { accepted: expectedAccepted, local_satisfied: expectedAccepted },
      actual: {
        accepted: taskAccepted,
        local_satisfied: localSatisfied,
        ...(!taskAccepted && rejection && { rejection }),
      },
      observations: packageVerdicts.map(v => ({
        satisfied: v.satisfied,
        bug_class: v.bug_class,
        detail: v.detail,
        json_pointer: v.json_pointer,
      })),
    };
  }

  const likely = classifyLikelyFailure(expectedAccepted, taskAccepted, localSatisfied, primary);
  const error =
    !expectedAccepted && !taskAccepted && !localSatisfied && !negativeRejectionMatches
      ? `Expected request to be rejected for canonical format satisfaction, and local matching says it does not satisfy the product, but the agent rejection did not identify a format-selector cause. Observed rejection: ${formatRejectionInfo(rejection)}`
      : likely;
  return {
    check: validation.check,
    passed: false,
    description: validation.description,
    path: validation.path,
    error,
    json_pointer: primary?.json_pointer ?? null,
    expected: { accepted: expectedAccepted, local_satisfied: expectedAccepted },
    actual: {
      accepted: taskAccepted,
      local_satisfied: localSatisfied,
      ...(!taskAccepted && rejection && { rejection }),
      bug_class: primary?.bug_class ?? 'authoring',
      detail: primary?.detail ?? 'No package verdict was produced',
    },
    remediation: remediationFor(primary?.bug_class),
    observations: packageVerdicts.map(v => ({
      satisfied: v.satisfied,
      bug_class: v.bug_class,
      detail: v.detail,
      json_pointer: v.json_pointer,
      ...(v.actual !== undefined && { actual: v.actual }),
      ...(v.observations && { observations: v.observations }),
    })),
  };
}

function resolvePackages(
  requestPayload: Record<string, unknown>,
  path?: string
):
  | { ok: true; packages: Array<{ value: Record<string, unknown>; pointer: string }> }
  | { ok: false; error: string; pointer: string | null; actual: unknown } {
  if (path) {
    const resolved = resolvePath(requestPayload, path);
    const pointer = toJsonPointer(path);
    if (Array.isArray(resolved)) {
      if (resolved.length === 0) {
        return {
          ok: false,
          error: `Path "${path}" resolved to an empty package array`,
          pointer,
          actual: [],
        };
      }
      const packages = resolved
        .map((item, i) => (isRecord(item) ? { value: item, pointer: `${pointer}/${i}` } : undefined))
        .filter((p): p is { value: Record<string, unknown>; pointer: string } => Boolean(p));
      if (packages.length === resolved.length) return { ok: true, packages };
    }
    if (isRecord(resolved)) return { ok: true, packages: [{ value: resolved, pointer }] };
    return {
      ok: false,
      error: `Path "${path}" did not resolve to a package object or array of package objects`,
      pointer,
      actual: resolved ?? null,
    };
  }

  const rawPackages = requestPayload.packages;
  if (!Array.isArray(rawPackages) || rawPackages.length === 0) {
    return {
      ok: false,
      error:
        'canonical_format_satisfaction requires create_media_buy.packages[] unless validation.path selects a package',
      pointer: '/packages',
      actual: rawPackages ?? null,
    };
  }

  const packages = rawPackages
    .map((item, i) => (isRecord(item) ? { value: item, pointer: `/packages/${i}` } : undefined))
    .filter((p): p is { value: Record<string, unknown>; pointer: string } => Boolean(p));
  if (packages.length === rawPackages.length) return { ok: true, packages };
  return {
    ok: false,
    error: 'create_media_buy.packages[] contains a non-object entry',
    pointer: '/packages',
    actual: rawPackages,
  };
}

function evaluatePackage(
  pkg: Record<string, unknown>,
  pointer: string,
  index: number,
  products: unknown[]
): SatisfactionVerdict {
  const productId = typeof pkg.product_id === 'string' ? pkg.product_id : undefined;
  const product = products.find(p => isRecord(p) && p.product_id === productId);
  if (!isRecord(product)) {
    return {
      satisfied: false,
      bug_class: 'authoring',
      detail: `No prior get_products context product matched packages[${index}].product_id=${JSON.stringify(productId)}`,
      json_pointer: `${pointer}/product_id`,
      actual: productId ?? null,
    };
  }

  const formatOptionRefs = Array.isArray(pkg.format_option_refs) ? pkg.format_option_refs : [];
  if (formatOptionRefs.length > 0) {
    return evaluateFormatOptionRefs(formatOptionRefs, product, pointer);
  }

  const formatIds = Array.isArray(pkg.format_ids) ? pkg.format_ids : [];
  if (formatIds.length > 0) {
    return evaluateLegacyFormatIds(formatIds, product, pointer, productId!);
  }

  const canonicalSelectors = extractCanonicalSelectors(pkg, pointer);
  if (canonicalSelectors.length > 0) {
    return evaluateCanonicalSelectors(canonicalSelectors, product);
  }

  return {
    satisfied: true,
    bug_class: 'directionality',
    detail: 'Package omitted format selectors; per PackageRequest semantics the seller default is all product formats',
    json_pointer: pointer,
  };
}

function evaluateFormatOptionRefs(
  refs: unknown[],
  product: Record<string, unknown>,
  packagePointer: string
): SatisfactionVerdict {
  const declarations = productFormatOptions(product);
  if (declarations.length === 0) {
    return {
      satisfied: false,
      bug_class: 'closed_set',
      detail: 'Request used format_option_refs but the target product has no format_options[] closed set',
      json_pointer: `${packagePointer}/format_option_refs`,
      actual: refs,
    };
  }

  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    if (!isRecord(ref)) {
      return {
        satisfied: false,
        bug_class: 'authoring',
        detail: `format_option_refs[${i}] is not an object`,
        json_pointer: `${packagePointer}/format_option_refs/${i}`,
        actual: ref,
      };
    }
    if (ref.scope !== undefined && ref.scope !== 'product' && ref.scope !== 'publisher') {
      return {
        satisfied: false,
        bug_class: 'authoring',
        detail: `format_option_refs[${i}].scope must be "product" or "publisher" when present`,
        json_pointer: `${packagePointer}/format_option_refs/${i}/scope`,
        actual: ref.scope,
      };
    }
    if (ref.scope === 'publisher' && typeof ref.publisher_domain !== 'string') {
      return {
        satisfied: false,
        bug_class: 'authoring',
        detail: `format_option_refs[${i}] with scope="publisher" requires publisher_domain`,
        json_pointer: `${packagePointer}/format_option_refs/${i}/publisher_domain`,
        actual: ref,
      };
    }
    const match = declarations.find(decl => {
      if (ref.scope === 'publisher') {
        return (
          decl.publisher_domain === ref.publisher_domain &&
          decl.format_option_id === ref.format_option_id &&
          typeof ref.publisher_domain === 'string'
        );
      }
      return decl.format_option_id === ref.format_option_id && !decl.publisher_domain;
    });
    if (!match) {
      return {
        satisfied: false,
        bug_class: 'closed_set',
        detail: `format_option_refs[${i}] does not resolve to the target product's format_options[] closed set`,
        json_pointer: `${packagePointer}/format_option_refs/${i}`,
        actual: ref,
        observations: [{ available_format_option_ids: declarations.map(declarationLabel).filter(Boolean) }],
      };
    }
  }

  return {
    satisfied: true,
    bug_class: 'directionality',
    detail: 'Every format_option_refs[] entry resolved to the target product format_options[] closed set',
    json_pointer: `${packagePointer}/format_option_refs`,
  };
}

function evaluateLegacyFormatIds(
  refs: unknown[],
  product: Record<string, unknown>,
  packagePointer: string,
  productId: string
): SatisfactionVerdict {
  const declarations = productFormatOptions(product);
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    if (!isFormatId(ref)) {
      return {
        satisfied: false,
        bug_class: 'authoring',
        detail: `format_ids[${i}] is not a structured FormatId object`,
        json_pointer: `${packagePointer}/format_ids/${i}`,
        actual: ref,
      };
    }

    const direct = declarations.find(decl => (decl.v1_format_ref ?? []).some(v1 => sameFormatId(v1, ref)));
    if (direct) continue;

    const projected = projectLegacyRef(ref, productId, `${packagePointer}/format_ids/${i}`);
    if (projected) {
      const match = declarations.find(decl => canonicalSelectorSatisfiesDeclaration(projected, decl).ok);
      if (match) continue;
    }

    if (
      declarations.length === 0 &&
      Array.isArray(product.format_ids) &&
      product.format_ids.some(fid => isFormatId(fid) && sameFormatId(fid, ref))
    ) {
      continue;
    }

    return {
      satisfied: false,
      bug_class: 'normalization',
      detail:
        `Legacy format_ids[${i}] did not normalize to any canonical declaration on product ${JSON.stringify(productId)}. ` +
        `Check v1_format_ref links and v1→canonical registry/catalog projection.`,
      json_pointer: `${packagePointer}/format_ids/${i}`,
      actual: ref,
      observations: [{ projected }],
    };
  }

  return {
    satisfied: true,
    bug_class: 'normalization',
    detail: 'Every legacy format_id normalized to a product canonical declaration or product legacy format_id',
    json_pointer: `${packagePointer}/format_ids`,
  };
}

function evaluateCanonicalSelectors(
  selectors: CanonicalSelector[],
  product: Record<string, unknown>
): SatisfactionVerdict {
  const declarations = productFormatOptions(product);
  if (declarations.length === 0) {
    return {
      satisfied: false,
      bug_class: 'closed_set',
      detail: 'Request used canonical format selectors but the target product has no format_options[] closed set',
      json_pointer: selectors[0]?.pointer ?? null,
      actual: selectors,
    };
  }

  for (const selector of selectors) {
    const candidates = declarations.filter(decl => decl.format_kind === selector.format_kind);
    if (candidates.length === 0) {
      return {
        satisfied: false,
        bug_class: 'closed_set',
        detail: `Canonical selector format_kind=${JSON.stringify(selector.format_kind)} is outside the product format_options[] closed set`,
        json_pointer: selector.pointer,
        actual: selector,
      };
    }

    const checks = candidates.map(decl => canonicalSelectorSatisfiesDeclaration(selector, decl));
    if (checks.some(c => c.ok)) continue;
    const primary = checks.find(c => c.bug_class === 'range_containment') ?? checks[0]!;
    return {
      satisfied: false,
      bug_class: primary.bug_class,
      detail: primary.detail,
      json_pointer: selector.pointer,
      actual: selector,
      observations: checks.map(c => ({ ok: c.ok, bug_class: c.bug_class, detail: c.detail })),
    };
  }

  return {
    satisfied: true,
    bug_class: 'directionality',
    detail: 'Every canonical selector satisfies at least one product format_options[] declaration',
    json_pointer: selectors[0]?.pointer ?? null,
  };
}

function canonicalSelectorSatisfiesDeclaration(
  selector: CanonicalSelector,
  decl: V2ProductFormatDeclaration
): { ok: true; detail: string; bug_class: BugClass } | { ok: false; detail: string; bug_class: BugClass } {
  if (selector.format_kind !== decl.format_kind) {
    return {
      ok: false,
      bug_class: 'closed_set',
      detail: `format_kind ${JSON.stringify(selector.format_kind)} does not match product declaration ${JSON.stringify(decl.format_kind)}`,
    };
  }
  const productParams = isRecord(decl.params) ? decl.params : {};
  const requestParams = selector.params;

  const fixedSize = requireFixedSize(productParams, requestParams);
  if (!fixedSize.ok) return fixedSize;

  const sizeList = requireSizeList(productParams, requestParams);
  if (!sizeList.ok) return sizeList;

  const dimensionRanges = requireNumericRangeContainment(
    productParams,
    requestParams,
    'width',
    'min_width',
    'max_width'
  );
  if (!dimensionRanges.ok) return dimensionRanges;
  const heightRanges = requireNumericRangeContainment(
    productParams,
    requestParams,
    'height',
    'min_height',
    'max_height'
  );
  if (!heightRanges.ok) return heightRanges;

  const duration = requireDurationContainment(productParams, requestParams);
  if (!duration.ok) return duration;

  const remainingParams = requireRemainingParamContainment(productParams, requestParams);
  if (!remainingParams.ok) return remainingParams;

  return {
    ok: true,
    bug_class: 'directionality',
    detail: 'Selector constraints satisfy product declaration constraints',
  };
}

function requireFixedSize(
  productParams: Record<string, unknown>,
  requestParams: Record<string, unknown>
): { ok: true } | { ok: false; bug_class: BugClass; detail: string } {
  const hasFixedWidth = typeof productParams.width === 'number';
  const hasFixedHeight = typeof productParams.height === 'number';
  if (!hasFixedWidth && !hasFixedHeight) return { ok: true };

  for (const key of ['width', 'height'] as const) {
    if (typeof productParams[key] !== 'number') continue;
    if (requestParams[key] === undefined) {
      return {
        ok: false,
        bug_class: 'directionality',
        detail: `Under-specified selector: product fixes params.${key}=${productParams[key]}, but the request selector omits ${key}`,
      };
    }
    if (requestParams[key] !== productParams[key]) {
      return {
        ok: false,
        bug_class: 'directionality',
        detail: `Selector params.${key}=${JSON.stringify(requestParams[key])} does not equal fixed product params.${key}=${productParams[key]}`,
      };
    }
  }
  return { ok: true };
}

function requireRemainingParamContainment(
  productParams: Record<string, unknown>,
  requestParams: Record<string, unknown>
): { ok: true } | { ok: false; bug_class: BugClass; detail: string } {
  for (const [key, productValue] of Object.entries(productParams)) {
    if (HANDLED_CANONICAL_PARAM_KEYS.has(key) || productValue === undefined) continue;
    if (Array.isArray(productValue) && productValue.length === 0) continue;

    if (requestParams[key] === undefined) {
      return {
        ok: false,
        bug_class: 'directionality',
        detail: `Under-specified selector: product constrains params.${key}, but the request selector omits ${key}`,
      };
    }

    const requestValue = requestParams[key];
    if (ARRAY_SUBSET_PARAM_KEYS.has(key)) {
      const subset = requireArraySubset(key, productValue, requestValue);
      if (!subset.ok) return subset;
      continue;
    }

    if (!deepEqualJson(requestValue, productValue)) {
      return {
        ok: false,
        bug_class: 'directionality',
        detail: `Selector params.${key}=${JSON.stringify(requestValue)} does not equal product params.${key}=${JSON.stringify(productValue)}`,
      };
    }
  }

  return { ok: true };
}

function requireArraySubset(
  key: string,
  productValue: unknown,
  requestValue: unknown
): { ok: true } | { ok: false; bug_class: BugClass; detail: string } {
  if (!Array.isArray(productValue)) {
    if (deepEqualJson(requestValue, productValue)) return { ok: true };
    return {
      ok: false,
      bug_class: 'directionality',
      detail: `Selector params.${key}=${JSON.stringify(requestValue)} does not equal product params.${key}=${JSON.stringify(productValue)}`,
    };
  }
  if (!Array.isArray(requestValue) || requestValue.length === 0) {
    return {
      ok: false,
      bug_class: 'directionality',
      detail: `Under-specified selector: product constrains params.${key}[], but the request selector omits a non-empty array`,
    };
  }
  const outside = requestValue.find(item => !productValue.some(allowed => deepEqualJson(item, allowed)));
  if (outside !== undefined) {
    return {
      ok: false,
      bug_class: 'closed_set',
      detail: `Selector params.${key} item ${JSON.stringify(outside)} is outside product params.${key}[]`,
    };
  }
  return { ok: true };
}

function requireSizeList(
  productParams: Record<string, unknown>,
  requestParams: Record<string, unknown>
): { ok: true } | { ok: false; bug_class: BugClass; detail: string } {
  const productSizes = parseSizes(productParams.sizes);
  if (!productSizes.length) return { ok: true };
  const requestSizes = parseSizes(requestParams.sizes);
  const requestExact =
    typeof requestParams.width === 'number' && typeof requestParams.height === 'number'
      ? [{ width: requestParams.width, height: requestParams.height }]
      : [];
  const selected = requestSizes.length > 0 ? requestSizes : requestExact;
  if (selected.length === 0) {
    return {
      ok: false,
      bug_class: 'directionality',
      detail:
        'Under-specified selector: product declares params.sizes[], but the request omits sizes or exact width/height',
    };
  }
  const outside = selected.find(s => !productSizes.some(p => p.width === s.width && p.height === s.height));
  if (outside) {
    return {
      ok: false,
      bug_class: 'directionality',
      detail: `Selector size ${outside.width}x${outside.height} is outside product params.sizes[]`,
    };
  }
  return { ok: true };
}

function requireNumericRangeContainment(
  productParams: Record<string, unknown>,
  requestParams: Record<string, unknown>,
  exactKey: string,
  minKey: string,
  maxKey: string
): { ok: true } | { ok: false; bug_class: BugClass; detail: string } {
  const min = typeof productParams[minKey] === 'number' ? productParams[minKey] : undefined;
  const max = typeof productParams[maxKey] === 'number' ? productParams[maxKey] : undefined;
  if (min === undefined && max === undefined) return { ok: true };

  if (typeof requestParams[exactKey] === 'number') {
    const exact = requestParams[exactKey] as number;
    if ((min !== undefined && exact < min) || (max !== undefined && exact > max)) {
      return {
        ok: false,
        bug_class: 'range_containment',
        detail: `Selector ${exactKey}=${exact} is outside product range ${rangeLabel(min, max)}`,
      };
    }
    return { ok: true };
  }

  const reqMin = typeof requestParams[minKey] === 'number' ? (requestParams[minKey] as number) : undefined;
  const reqMax = typeof requestParams[maxKey] === 'number' ? (requestParams[maxKey] as number) : undefined;
  if (reqMin === undefined && reqMax === undefined) {
    return {
      ok: false,
      bug_class: 'directionality',
      detail: `Under-specified selector: product constrains ${exactKey} range ${rangeLabel(min, max)}, but the request omits ${exactKey}/${minKey}/${maxKey}`,
    };
  }
  if ((min !== undefined && (reqMin ?? -Infinity) < min) || (max !== undefined && (reqMax ?? Infinity) > max)) {
    return {
      ok: false,
      bug_class: 'range_containment',
      detail: `Selector ${exactKey} range ${rangeLabel(reqMin, reqMax)} only overlaps or exceeds product range ${rangeLabel(min, max)}; request ranges must be contained`,
    };
  }
  return { ok: true };
}

function requireDurationContainment(
  productParams: Record<string, unknown>,
  requestParams: Record<string, unknown>
): { ok: true } | { ok: false; bug_class: BugClass; detail: string } {
  if (typeof productParams.duration_ms_exact === 'number') {
    const exact = requestDurationExact(requestParams);
    if (exact === undefined) {
      return {
        ok: false,
        bug_class: 'directionality',
        detail: `Under-specified selector: product fixes duration_ms_exact=${productParams.duration_ms_exact}, but the request omits an exact duration`,
      };
    }
    if (exact !== productParams.duration_ms_exact) {
      return {
        ok: false,
        bug_class: 'directionality',
        detail: `Selector duration ${exact} does not equal product duration_ms_exact=${productParams.duration_ms_exact}`,
      };
    }
    return { ok: true };
  }

  const productRange = parseNumberPair(productParams.duration_ms_range);
  if (!productRange) return { ok: true };
  const exact = requestDurationExact(requestParams);
  if (exact !== undefined) {
    if (exact < productRange[0] || exact > productRange[1]) {
      return {
        ok: false,
        bug_class: 'range_containment',
        detail: `Selector exact duration ${exact} is outside product duration_ms_range ${rangeLabel(productRange[0], productRange[1])}`,
      };
    }
    return { ok: true };
  }
  const requestRange = parseNumberPair(requestParams.duration_ms_range);
  if (!requestRange) {
    return {
      ok: false,
      bug_class: 'directionality',
      detail: `Under-specified selector: product constrains duration_ms_range ${rangeLabel(productRange[0], productRange[1])}, but the request omits duration`,
    };
  }
  if (requestRange[0] < productRange[0] || requestRange[1] > productRange[1]) {
    return {
      ok: false,
      bug_class: 'range_containment',
      detail: `Selector duration_ms_range ${rangeLabel(requestRange[0], requestRange[1])} only overlaps or exceeds product range ${rangeLabel(productRange[0], productRange[1])}; request ranges must be contained`,
    };
  }
  return { ok: true };
}

function extractCanonicalSelectors(pkg: Record<string, unknown>, packagePointer: string): CanonicalSelector[] {
  const selectors: CanonicalSelector[] = [];
  const arrays: Array<[unknown, string]> = [
    [pkg.format_options, `${packagePointer}/format_options`],
    [pkg.format_selectors, `${packagePointer}/format_selectors`],
    [pkg.formats, `${packagePointer}/formats`],
  ];
  for (const [value, pointer] of arrays) {
    if (!Array.isArray(value)) continue;
    for (let i = 0; i < value.length; i++) {
      const selector = canonicalSelectorFrom(value[i], `${pointer}/${i}`);
      if (selector) selectors.push(selector);
    }
  }
  const direct = canonicalSelectorFrom(pkg, packagePointer);
  if (direct) selectors.push(direct);
  const single = canonicalSelectorFrom(pkg.format_option, `${packagePointer}/format_option`);
  if (single) selectors.push(single);
  return selectors;
}

function canonicalSelectorFrom(value: unknown, pointer: string): CanonicalSelector | undefined {
  if (!isRecord(value) || typeof value.format_kind !== 'string') return undefined;
  const params = isRecord(value.params) ? { ...value.params } : {};
  for (const key of [
    'width',
    'height',
    'sizes',
    'min_width',
    'max_width',
    'min_height',
    'max_height',
    'duration_ms',
    'duration_ms_exact',
    'duration_ms_range',
    'orientation',
    'aspect_ratio',
    'video_codecs',
    'audio_codecs',
    'mime_types',
    'file_types',
    'formats',
    'slots',
    'platform_extensions',
    'tracking_extensions',
  ]) {
    if (value[key] !== undefined && params[key] === undefined) params[key] = value[key];
  }
  return { format_kind: value.format_kind, params, pointer };
}

function productFormatOptions(product: Record<string, unknown>): V2ProductFormatDeclaration[] {
  if (!Array.isArray(product.format_options)) return [];
  return product.format_options.filter(isRecord) as unknown as V2ProductFormatDeclaration[];
}

function projectLegacyRef(ref: V1FormatId, productId: string, pointer: string): CanonicalSelector | undefined {
  const { v2 } = projectV1ProductToV2({
    product_id: productId,
    name: productId,
    description: productId,
    format_ids: [ref],
  });
  const decl = v2.format_options[0];
  if (!decl) return undefined;
  const params = augmentProjectedParamsFromCatalog(ref, isRecord(decl.params) ? decl.params : {});
  return {
    format_kind: decl.format_kind,
    params,
    pointer,
  };
}

function augmentProjectedParamsFromCatalog(
  ref: V1FormatId,
  projectedParams: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...projectedParams };
  const catalogEntry = lookupV1Format(ref);
  if (!catalogEntry) return out;

  if (out.width === undefined || out.height === undefined) {
    const dimensions = firstCatalogDimensions(catalogEntry);
    if (dimensions) {
      if (out.width === undefined) out.width = dimensions.width;
      if (out.height === undefined) out.height = dimensions.height;
    }
  }

  if (out.duration_ms_exact === undefined) {
    const duration = firstCatalogDurationMs(catalogEntry);
    if (duration !== undefined) out.duration_ms_exact = duration;
  }

  return out;
}

function firstCatalogDimensions(catalogEntry: Record<string, unknown>): { width: number; height: number } | undefined {
  const renders = Array.isArray(catalogEntry.renders) ? catalogEntry.renders : [];
  for (const render of renders) {
    if (!isRecord(render) || !isRecord(render.dimensions)) continue;
    const { width, height } = render.dimensions;
    if (typeof width === 'number' && typeof height === 'number') return { width, height };
  }

  const assets = Array.isArray(catalogEntry.assets) ? catalogEntry.assets : [];
  for (const asset of assets) {
    if (!isRecord(asset) || !isRecord(asset.requirements)) continue;
    const { width, height } = asset.requirements;
    if (typeof width === 'number' && typeof height === 'number') return { width, height };
  }
  return undefined;
}

interface RejectionInfo {
  codes: string[];
  fields: string[];
  messages: string[];
}

function extractRejectionInfo(taskResult: TaskResult): RejectionInfo | undefined {
  if (taskResult.success === true) return undefined;
  const codes = new Set<string>();
  const fields = new Set<string>();
  const messages = new Set<string>();
  collectRejectionInfo(taskResult, codes, fields, messages);
  return {
    codes: [...codes],
    fields: [...fields],
    messages: [...messages],
  };
}

function collectRejectionInfo(
  value: unknown,
  codes: Set<string>,
  fields: Set<string>,
  messages: Set<string>,
  depth = 0
): void {
  if (depth > 5) return;
  if (typeof value === 'string') {
    messages.add(value);
    const prefixedCode = value.match(/^([A-Z][A-Z0-9_]+):/);
    if (prefixedCode?.[1]) codes.add(prefixedCode[1]);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectRejectionInfo(item, codes, fields, messages, depth + 1);
    return;
  }
  if (!isRecord(value)) return;

  for (const key of ['code', 'error_code', 'reason'] as const) {
    const maybeCode = value[key];
    if (typeof maybeCode === 'string') codes.add(maybeCode);
  }
  for (const key of ['field', 'path', 'json_pointer'] as const) {
    const maybeField = value[key];
    if (typeof maybeField === 'string') fields.add(maybeField);
  }
  for (const key of ['message', 'error', 'detail', 'suggestion'] as const) {
    const maybeMessage = value[key];
    if (typeof maybeMessage === 'string') messages.add(maybeMessage);
  }
  for (const key of ['adcp_error', 'adcpError', 'data', 'details', 'errors', 'issues'] as const) {
    if (value[key] !== undefined) collectRejectionInfo(value[key], codes, fields, messages, depth + 1);
  }
}

function rejectionSupportsFormatFailure(rejection: RejectionInfo | undefined): boolean {
  if (!rejection) return false;
  if (rejection.codes.some(code => code.startsWith('FORMAT_'))) return true;
  return [...rejection.fields, ...rejection.messages].some(text =>
    /format|format_option|format_id|selector/i.test(text)
  );
}

function formatRejectionInfo(rejection: RejectionInfo | undefined): string {
  if (!rejection) return 'no structured rejection details';
  return JSON.stringify(rejection);
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function firstCatalogDurationMs(catalogEntry: Record<string, unknown>): number | undefined {
  const assets = Array.isArray(catalogEntry.assets) ? catalogEntry.assets : [];
  for (const asset of assets) {
    if (!isRecord(asset) || !isRecord(asset.requirements)) continue;
    const { duration_ms, duration_seconds } = asset.requirements;
    if (typeof duration_ms === 'number') return duration_ms;
    if (typeof duration_seconds === 'number') return duration_seconds * 1000;
  }
  return undefined;
}

function classifyLikelyFailure(
  expectedAccepted: boolean,
  taskAccepted: boolean,
  localSatisfied: boolean,
  primary: SatisfactionVerdict | undefined
): string {
  const observed = taskAccepted ? 'accepted' : 'rejected';
  const expected = expectedAccepted ? 'accepted' : 'rejected';
  const local = localSatisfied ? 'satisfies' : 'does not satisfy';
  const bugClass = primary?.bug_class ?? 'authoring';
  const detail = primary?.detail ?? 'no local satisfaction verdict';
  if (expectedAccepted && !taskAccepted && localSatisfied) {
    return `Expected request to be accepted and local canonical matching says it satisfies the product, but the agent rejected it. Likely ${bugClass} failure: ${detail}`;
  }
  if (!expectedAccepted && taskAccepted && !localSatisfied) {
    return `Expected request to be rejected because local canonical matching says it does not satisfy the product, but the agent accepted it. Likely ${bugClass} failure: ${detail}`;
  }
  if (!localSatisfied && expectedAccepted) {
    return `Storyboard expected acceptance, but the authored request does not satisfy the product locally (${bugClass}): ${detail}`;
  }
  if (localSatisfied && !expectedAccepted) {
    return `Storyboard expected rejection, but the authored request satisfies the product locally: ${detail}`;
  }
  return `Expected ${expected}, observed ${observed}; local matcher says request ${local}. ${detail}`;
}

function remediationFor(bugClass: BugClass | undefined): string | undefined {
  switch (bugClass) {
    case 'normalization':
      return 'Normalize legacy format_ids through product v1_format_ref, catalog canonical annotations, or the v1-canonical registry before comparing to product format_options.';
    case 'directionality':
      return 'Apply directional product gating: the request selector must contain the product-declared fixed constraints; a bare canonical kind does not satisfy a fixed-size or fixed-duration product.';
    case 'range_containment':
      return 'Use containment for ranges: an exact request must be inside the product range, and a request range must be fully contained by the product range, not merely overlap it.';
    case 'closed_set':
      return 'Treat product format_options[] as a closed set and reject selectors that do not resolve to one of its declarations.';
    default:
      return undefined;
  }
}

function sameFormatId(a: V1FormatId, b: V1FormatId): boolean {
  for (const key of FORMAT_IDENTITY_KEYS) {
    const av = key === 'agent_url' ? normalizeAgentUrl(a[key]) : a[key];
    const bv = key === 'agent_url' ? normalizeAgentUrl(b[key]) : b[key];
    if (av !== bv) return false;
  }
  return true;
}

function normalizeAgentUrl(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    const url = new URL(value);
    url.hash = '';
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
      url.port = '';
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return value.replace(/\/$/, '');
  }
}

function isFormatId(value: unknown): value is V1FormatId {
  return isRecord(value) && typeof value.agent_url === 'string' && typeof value.id === 'string';
}

function declarationLabel(decl: V2ProductFormatDeclaration): string | undefined {
  if (!decl.format_option_id) return undefined;
  return decl.publisher_domain ? `${decl.publisher_domain}/${decl.format_option_id}` : decl.format_option_id;
}

function requestDurationExact(params: Record<string, unknown>): number | undefined {
  if (typeof params.duration_ms_exact === 'number') return params.duration_ms_exact;
  if (typeof params.duration_ms === 'number') return params.duration_ms;
  return undefined;
}

function parseNumberPair(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  return typeof value[0] === 'number' && typeof value[1] === 'number' ? [value[0], value[1]] : undefined;
}

function parseSizes(value: unknown): Array<{ width: number; height: number }> {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => {
      if (!isRecord(item)) return undefined;
      const width = typeof item.width === 'number' ? item.width : typeof item.w === 'number' ? item.w : undefined;
      const height = typeof item.height === 'number' ? item.height : typeof item.h === 'number' ? item.h : undefined;
      return width !== undefined && height !== undefined ? { width, height } : undefined;
    })
    .filter((s): s is { width: number; height: number } => Boolean(s));
}

function rangeLabel(min: unknown, max: unknown): string {
  return `[${min ?? '-infinity'}, ${max ?? 'infinity'}]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
