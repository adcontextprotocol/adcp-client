import { injectLegacyEnvelopeStatus } from '../../../utils/envelope-status-compat';
import type { VersionAdapter, VersionDrift } from '../types';

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * AdCP 3.2's `bidding.bid_amount` replaces the 3.1 package `bid_price`. The
 * 3.2 schema's legacy normalization maps `bid_price` to `bidding.max_bid`
 * when the selected pricing option has `max_bid: true` and to
 * `bidding.bid_amount` otherwise. Only `bid_amount` is moved back: a 3.1
 * seller reads `bid_price` as the exact bid unless the option says ceiling,
 * so the amount is never charged above what the buyer authored. A
 * `max_bid` block has no safe 3.1 form without knowing the option's flag
 * (an exact bid at the ceiling price), and neither do `automatic`,
 * `cost_per` or `roas`. Those are left for the projection, which refuses
 * them on a mutation.
 */
function legacyBidPrice(bidding: unknown): number | undefined {
  if (!isObject(bidding)) return undefined;
  const keys = Object.keys(bidding).filter(key => bidding[key] !== undefined);
  if (keys.length !== 1 || keys[0] !== 'bid_amount') return undefined;
  return typeof bidding.bid_amount === 'number' ? bidding.bid_amount : undefined;
}

function adaptPackages(
  packages: unknown,
  inherited: number | undefined,
  moved: Array<{ from: string; to: string }>,
  inheritedPath: string
): unknown {
  if (!Array.isArray(packages)) return packages;
  let changed = false;
  const adapted = packages.map((pkg, index) => {
    if (!isObject(pkg) || pkg.bid_price !== undefined) return pkg;
    const own = pkg.bidding === undefined ? undefined : legacyBidPrice(pkg.bidding);
    if (own !== undefined) {
      changed = true;
      const { bidding: _, ...rest } = pkg;
      moved.push({ from: `packages[${index}].bidding`, to: `packages[${index}].bid_price` });
      return { ...rest, bid_price: own };
    }
    if (pkg.bidding === undefined && inherited !== undefined) {
      changed = true;
      moved.push({ from: inheritedPath, to: `packages[${index}].bid_price` });
      return { ...pkg, bid_price: inherited };
    }
    return pkg;
  });
  return changed ? adapted : packages;
}

function bidDrift(moved: Array<{ from: string; to: string }>): VersionDrift {
  return {
    type: 'bidding_moved_to_bid_price',
    message:
      'bidding.bid_amount rewritten as package bid_price: AdCP 3.1 has no bidding block. ' +
      'The seller reads bid_price as the exact bid, or as a ceiling when the selected pricing option sets max_bid.',
    movedFields: moved,
  };
}

export const createMediaBuyAdapter: VersionAdapter = {
  toolName: 'create_media_buy',
  adaptRequest(params) {
    if (!isObject(params)) return { params };
    const moved: Array<{ from: string; to: string }> = [];
    // A media-buy bidding block is the default each package inherits unless
    // the package authors its own.
    const inherited = legacyBidPrice(params.bidding);
    const packages = adaptPackages(params.packages, inherited, moved, 'bidding');
    if (moved.length === 0) return { params };
    const adapted: Json = { ...params, packages };
    // Every package now carries the inherited amount explicitly.
    if (inherited !== undefined && moved.some(m => m.from === 'bidding')) delete adapted.bidding;
    return { params: adapted, drift: bidDrift(moved) };
  },
  adaptResponse: adaptMediaBuyStatus('create_media_buy'),
};

export const updateMediaBuyAdapter: VersionAdapter = {
  toolName: 'update_media_buy',
  adaptRequest(params) {
    if (!isObject(params)) return { params };
    const moved: Array<{ from: string; to: string }> = [];
    // An update's media-buy bidding applies to packages the request does not
    // list, so it cannot be folded into the listed package updates.
    const packages = adaptPackages(params.packages, undefined, moved, 'bidding');
    if (moved.length === 0) return { params };
    return { params: { ...params, packages }, drift: bidDrift(moved) };
  },
  adaptResponse: adaptMediaBuyStatus('update_media_buy'),
};

/**
 * AdCP 3.1 media-buy responses may carry the media-buy lifecycle state in the
 * deprecated top-level `status` alias, which 3.2 removed in favor of
 * `media_buy_status`. Move it so 3.2 callers read one field.
 */
function adaptMediaBuyStatus(toolName: string): NonNullable<VersionAdapter['adaptResponse']> {
  return data => {
    if (!isObject(data)) return { data };
    const adapted = injectLegacyEnvelopeStatus(data, { toolName });
    if (adapted === data || adapted.media_buy_status === data.media_buy_status) return { data };
    return {
      data: adapted,
      drift: {
        type: 'media_buy_status_alias_moved',
        message: 'Legacy top-level media-buy status moved to media_buy_status for the AdCP 3.2 response shape.',
        movedFields: [{ from: 'status', to: 'media_buy_status' }],
      },
    };
  };
}
