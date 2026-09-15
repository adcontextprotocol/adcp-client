/**
 * Existing-platform targeting boundary for AdCP 3.2.
 *
 * Mutation input is a command shape: omitted dimensions are unchanged, `null`
 * clears, and a value replaces. Provider state and AdCP readback are strict
 * state shapes, so they never retain or return a `null` command.
 */

import {
  applyTargetingInput,
  hasTargetingClears,
  type BuyProductsRequest,
  type ControlMediaBuyRequest,
  type ResolvedTargetingInput,
} from '@adcp/sdk';

type ProductPurchase = BuyProductsRequest['purchases'][number];
type PackageControl = NonNullable<ControlMediaBuyRequest['packages']>[number];

/** Canonical request shapes; derive these instead of copying generated types. */
export type CreateTargetingInput = ProductPurchase['targeting_overlay'];
export type UpdateTargetingInput = PackageControl['targeting_overlay'];
export type AcceptedTargeting = ResolvedTargetingInput<NonNullable<CreateTargetingInput>>;

type ProviderTargetingField = 'countryCodes' | 'metroCodes' | 'languageCodes' | 'keywordTargets' | 'negativeKeywords';

/** One concrete translation into an existing provider's mutation language. */
export type ProviderTargetingOperation =
  | { kind: 'set'; field: ProviderTargetingField; value: unknown }
  | { kind: 'clear'; field: ProviderTargetingField };

export interface ExistingProviderClient {
  /**
   * Atomically applies the exact supplied values or rejects the whole call;
   * omitted dimensions never appear. If a provider normalizes accepted values,
   * change this seam to return its canonical readback and persist that instead.
   */
  applyPackageTargeting(packageId: string, operations: readonly ProviderTargetingOperation[]): Promise<void>;
}

export interface ExistingTargetingStore {
  readAcceptedTargeting(packageId: string): Promise<AcceptedTargeting | undefined>;
  /** Persist only after the provider accepted the replacement. */
  saveAcceptedTargeting(packageId: string, targeting: AcceptedTargeting | undefined): Promise<void>;
}

export class UnsupportedTargetingClearError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`The provider cannot clear targeting dimension ${field}`);
    this.name = 'UnsupportedTargetingClearError';
    this.field = field;
  }
}

export class UnsupportedTargetingDimensionError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`The provider adapter does not translate targeting dimension ${field}`);
    this.name = 'UnsupportedTargetingDimensionError';
    this.field = field;
  }
}

const PROVIDER_FIELD_BY_DIMENSION: Readonly<Record<string, ProviderTargetingField>> = {
  geo_countries: 'countryCodes',
  geo_metros: 'metroCodes',
  language: 'languageCodes',
  keyword_targets: 'keywordTargets',
  negative_keywords: 'negativeKeywords',
};

/**
 * Preserve nullable commands while translating to provider operations. Add a
 * provider mapping here before advertising support for another dimension.
 */
export function toProviderTargetingOperations(
  input: object | undefined,
  clearableDimensions: ReadonlySet<string>,
  fieldPrefix: string
): ProviderTargetingOperation[] {
  if (input === undefined) return [];

  const operations: ProviderTargetingOperation[] = [];
  for (const [dimension, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const field = PROVIDER_FIELD_BY_DIMENSION[dimension];
    if (!field) throw new UnsupportedTargetingDimensionError(`${fieldPrefix}.${dimension}`);
    if (value === null) {
      if (!clearableDimensions.has(dimension)) {
        throw new UnsupportedTargetingClearError(`${fieldPrefix}.${dimension}`);
      }
      operations.push({ kind: 'clear', field });
    } else {
      operations.push({ kind: 'set', field, value });
    }
  }
  return operations;
}

/**
 * Thin orchestration around application-owned provider and durable-store
 * adapters. The outer control handler must serialize/CAS the read-provider-save
 * block using the request revision. A production store should also reconcile a
 * provider success if its subsequent local commit fails.
 */
export class ExistingPlatformTargeting {
  constructor(
    private readonly provider: ExistingProviderClient,
    private readonly store: ExistingTargetingStore,
    /** Dimensions that both product policy and the provider allow clearing. */
    private readonly clearableDimensions: ReadonlySet<string>
  ) {}

  async create(
    packageId: string,
    configuredProductTargeting: AcceptedTargeting | undefined,
    input: CreateTargetingInput
  ): Promise<AcceptedTargeting | undefined> {
    const operations = toProviderTargetingOperations(input, this.clearableDimensions, 'purchases[].targeting_overlay');
    if (operations.length > 0) await this.provider.applyPackageTargeting(packageId, operations);

    // Start with the selected product's strict defaults: omission inherits a
    // default, null suppresses it, and a value replaces it. The provider has
    // now executed every explicit command, so this result is safe to persist.
    const accepted = applyTargetingInput(configuredProductTargeting, input);
    await this.store.saveAcceptedTargeting(packageId, accepted);
    return accepted;
  }

  async update(packageId: string, input: UpdateTargetingInput): Promise<AcceptedTargeting | undefined> {
    const prior = await this.store.readAcceptedTargeting(packageId);

    // Omitted targeting is a true no-op: do not call the provider or rewrite
    // durable state. This differs from an explicit `null` inside the overlay.
    if (input === undefined) return prior;

    const operations = toProviderTargetingOperations(input, this.clearableDimensions, 'packages[].targeting_overlay');
    if (operations.length > 0) await this.provider.applyPackageTargeting(packageId, operations);
    const accepted = applyTargetingInput(prior, input);
    await this.store.saveAcceptedTargeting(packageId, accepted);
    return accepted;
  }

  /** AdCP response handlers read this strict state; no request command leaks. */
  async readback(packageId: string): Promise<AcceptedTargeting | undefined> {
    const targeting = await this.store.readAcceptedTargeting(packageId);
    if (hasTargetingClears(targeting)) throw new Error('Durable targeting state contains a request-only clear command');
    return targeting;
  }
}
