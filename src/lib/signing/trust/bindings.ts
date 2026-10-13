import { webBotAuthOrigin } from '../wba/origin';

export interface BindOriginOptions {
  /** The principal already authenticates with the RFC 9421 profile. */
  existingRfc9421Principal?: boolean;
  /** Explicit, out-of-band seller approval for that migration (spec R5 rule 4). */
  migrationApproved?: boolean;
}

/**
 * Application-owned binding lookup. Returns the principal an origin is bound
 * to, or `undefined`. Discovery never writes bindings; only an explicit,
 * audited seller decision does.
 */
export interface OriginBindingResolver {
  principalFor(origin: string): Promise<string | undefined>;
}

/** A resolver that can also record bindings. */
export interface OriginBindingStore extends OriginBindingResolver {
  bind(origin: string, principalId: string, options?: BindOriginOptions): Promise<void>;
}

export class OriginBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OriginBindingError';
  }
}

/**
 * Experimental (AdCP 3.3). In-memory origin → principal bindings for one
 * process; production supplies a durable {@link OriginBindingStore}.
 *
 * - An origin maps to at most one principal and is never rebound (R5 rule 3).
 *   A principal may own several origins.
 * - Binding onto a principal that already uses the RFC 9421 profile requires
 *   `migrationApproved` (R5 rule 4).
 * - A binding is history, not standing authority: authorization re-evaluates
 *   the operator's trust record, and a bound origin is refused on the RFC 9421
 *   profile even after delisting (no downgrade, R4).
 */
export class OriginBindings implements OriginBindingStore {
  private readonly bindings = new Map<string, string>();

  async bind(origin: string, principalId: string, options: BindOriginOptions = {}): Promise<void> {
    this.bindSync(origin, principalId, options);
  }

  /** Synchronous form for configuration code. */
  bindSync(origin: string, principalId: string, options: BindOriginOptions = {}): void {
    const canonical = webBotAuthOrigin(origin);
    if (typeof principalId !== 'string' || principalId.length === 0) {
      throw new OriginBindingError('binding requires a principal ID');
    }
    if (options.existingRfc9421Principal === true && options.migrationApproved !== true) {
      throw new OriginBindingError('binding an existing RFC 9421 principal requires explicit approval');
    }
    const existing = this.bindings.get(canonical);
    if (existing !== undefined && existing !== principalId) {
      throw new OriginBindingError('an origin cannot be rebound to another principal');
    }
    this.bindings.set(canonical, principalId);
  }

  async principalFor(origin: string): Promise<string | undefined> {
    try {
      return this.bindings.get(webBotAuthOrigin(origin));
    } catch {
      return undefined;
    }
  }
}
