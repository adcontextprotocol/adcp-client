import { describe, it, expect } from 'vitest';
import { createMediaBuyStore, type MediaBuyStore } from './media-buy-store';
import { InMemoryStateStore } from './state-store';
import type { TargetingOverlay } from '../types/core.generated';

function setup(): { store: MediaBuyStore; backing: InMemoryStateStore } {
  const backing = new InMemoryStateStore();
  return { store: createMediaBuyStore({ store: backing }), backing };
}

const PROPERTY_LIST: TargetingOverlay['property_list'] = {
  list_id: 'acme_outdoor_allowlist_v1',
  agent_url: 'https://lists.example.com',
};

const COLLECTION_LIST: TargetingOverlay['collection_list'] = {
  list_id: 'sports_collections_v3',
  agent_url: 'https://lists.example.com',
};

describe('createMediaBuyStore — persistFromCreate + backfill', () => {
  it('persists targeting_overlay from request and echoes it on get', async () => {
    const { store } = setup();
    await store.persistFromCreate(
      'acct_a',
      {
        packages: [
          {
            buyer_ref: 'pkg_a',
            targeting_overlay: { property_list: PROPERTY_LIST, collection_list: COLLECTION_LIST },
          },
        ],
      },
      {
        media_buy_id: 'mb_1',
        packages: [{ package_id: 'seller_pkg_001', buyer_ref: 'pkg_a' }],
      }
    );

    const result = await store.backfill('acct_a', {
      media_buys: [{ media_buy_id: 'mb_1', packages: [{ package_id: 'seller_pkg_001' }] }],
    });

    expect(result.media_buys?.[0]?.packages?.[0]?.targeting_overlay).toEqual({
      property_list: PROPERTY_LIST,
      collection_list: COLLECTION_LIST,
    });
  });

  it('falls back to positional matching when buyer_ref is absent', async () => {
    const { store } = setup();
    await store.persistFromCreate(
      'acct_a',
      {
        packages: [{ targeting_overlay: { property_list: PROPERTY_LIST } }],
      },
      {
        media_buy_id: 'mb_1',
        packages: [{ package_id: 'seller_pkg_001' }],
      }
    );

    const result = await store.backfill('acct_a', {
      media_buys: [{ media_buy_id: 'mb_1', packages: [{ package_id: 'seller_pkg_001' }] }],
    });

    expect(result.media_buys?.[0]?.packages?.[0]?.targeting_overlay).toEqual({
      property_list: PROPERTY_LIST,
    });
  });

  it('persists the seller-normalized targeting_overlay from the response when present, not the buyer-supplied request copy', async () => {
    const { store } = setup();
    const buyerSupplied: TargetingOverlay = {
      property_list: { list_id: 'acme_outdoor_allowlist_v1', agent_url: 'https://buyer.example/lists' },
    };
    // Sellers commonly resolve `agent_url` to a canonical resolver,
    // strip unknown fields, or rewrite list_ids to the seller's
    // namespace before persisting. Per spec, the echoed overlay MUST
    // reflect what the seller persisted — the buyer-supplied copy is
    // not authoritative once the seller normalizes.
    const sellerNormalized: TargetingOverlay = {
      property_list: { list_id: 'acme_outdoor_allowlist_v1', agent_url: 'https://lists.canonical.example' },
    };

    await store.persistFromCreate(
      'acct_a',
      { packages: [{ buyer_ref: 'pkg_a', targeting_overlay: buyerSupplied }] },
      {
        media_buy_id: 'mb_1',
        packages: [{ package_id: 'seller_pkg_001', buyer_ref: 'pkg_a', targeting_overlay: sellerNormalized }],
      }
    );

    const result = await store.backfill('acct_a', {
      media_buys: [{ media_buy_id: 'mb_1', packages: [{ package_id: 'seller_pkg_001' }] }],
    });

    expect(result.media_buys?.[0]?.packages?.[0]?.targeting_overlay).toEqual(sellerNormalized);
  });

  it('does not overwrite a targeting_overlay the seller already echoed', async () => {
    const { store } = setup();
    const sellerEchoed: TargetingOverlay = { geo_countries: ['US'] };

    await store.persistFromCreate(
      'acct_a',
      { packages: [{ buyer_ref: 'pkg_a', targeting_overlay: { property_list: PROPERTY_LIST } }] },
      { media_buy_id: 'mb_1', packages: [{ package_id: 'seller_pkg_001', buyer_ref: 'pkg_a' }] }
    );

    const result = await store.backfill('acct_a', {
      media_buys: [
        {
          media_buy_id: 'mb_1',
          packages: [{ package_id: 'seller_pkg_001', targeting_overlay: sellerEchoed }],
        },
      ],
    });

    expect(result.media_buys?.[0]?.packages?.[0]?.targeting_overlay).toBe(sellerEchoed);
  });

  it('account-scopes records — same media_buy_id in different accounts does not collide', async () => {
    const { store } = setup();
    const overlayA: TargetingOverlay = { property_list: PROPERTY_LIST };
    const overlayB: TargetingOverlay = { collection_list: COLLECTION_LIST };

    await store.persistFromCreate(
      'acct_a',
      { packages: [{ buyer_ref: 'pkg', targeting_overlay: overlayA }] },
      { media_buy_id: 'mb_1', packages: [{ package_id: 'seller_pkg_001', buyer_ref: 'pkg' }] }
    );
    await store.persistFromCreate(
      'acct_b',
      { packages: [{ buyer_ref: 'pkg', targeting_overlay: overlayB }] },
      { media_buy_id: 'mb_1', packages: [{ package_id: 'seller_pkg_001', buyer_ref: 'pkg' }] }
    );

    const a = await store.backfill('acct_a', {
      media_buys: [{ media_buy_id: 'mb_1', packages: [{ package_id: 'seller_pkg_001' }] }],
    });
    const b = await store.backfill('acct_b', {
      media_buys: [{ media_buy_id: 'mb_1', packages: [{ package_id: 'seller_pkg_001' }] }],
    });

    expect(a.media_buys?.[0]?.packages?.[0]?.targeting_overlay).toEqual(overlayA);
    expect(b.media_buys?.[0]?.packages?.[0]?.targeting_overlay).toEqual(overlayB);
  });
});

describe('createMediaBuyStore — mergeFromUpdate', () => {
  it('preserves prior fields when patch omits them', async () => {
    const { store } = setup();
    await store.persistFromCreate(
      'acct_a',
      { packages: [{ buyer_ref: 'pkg_a', targeting_overlay: { property_list: PROPERTY_LIST } }] },
      { media_buy_id: 'mb_1', packages: [{ package_id: 'seller_pkg_001', buyer_ref: 'pkg_a' }] }
    );

    await store.mergeFromUpdate('acct_a', 'mb_1', {
      packages: [
        {
          package_id: 'seller_pkg_001',
          targeting_overlay: { collection_list: COLLECTION_LIST },
        },
      ],
    });

    const result = await store.backfill('acct_a', {
      media_buys: [{ media_buy_id: 'mb_1', packages: [{ package_id: 'seller_pkg_001' }] }],
    });

    expect(result.media_buys?.[0]?.packages?.[0]?.targeting_overlay).toEqual({
      property_list: PROPERTY_LIST,
      collection_list: COLLECTION_LIST,
    });
  });

  it('clears a field when patch sets it to null', async () => {
    const { store } = setup();
    await store.persistFromCreate(
      'acct_a',
      {
        packages: [
          {
            buyer_ref: 'pkg_a',
            targeting_overlay: { property_list: PROPERTY_LIST, collection_list: COLLECTION_LIST },
          },
        ],
      },
      { media_buy_id: 'mb_1', packages: [{ package_id: 'seller_pkg_001', buyer_ref: 'pkg_a' }] }
    );

    await store.mergeFromUpdate('acct_a', 'mb_1', {
      packages: [
        {
          package_id: 'seller_pkg_001',
          targeting_overlay: { property_list: null as unknown as TargetingOverlay['property_list'] },
        },
      ],
    });

    const result = await store.backfill('acct_a', {
      media_buys: [{ media_buy_id: 'mb_1', packages: [{ package_id: 'seller_pkg_001' }] }],
    });

    expect(result.media_buys?.[0]?.packages?.[0]?.targeting_overlay).toEqual({
      collection_list: COLLECTION_LIST,
    });
  });

  it('does not modify the persisted overlay when patch omits targeting_overlay key entirely', async () => {
    const { store } = setup();
    const overlay: TargetingOverlay = { property_list: PROPERTY_LIST };
    await store.persistFromCreate(
      'acct_a',
      { packages: [{ buyer_ref: 'pkg_a', targeting_overlay: overlay }] },
      { media_buy_id: 'mb_1', packages: [{ package_id: 'seller_pkg_001', buyer_ref: 'pkg_a' }] }
    );

    await store.mergeFromUpdate('acct_a', 'mb_1', {
      packages: [{ package_id: 'seller_pkg_001' }],
    });

    const result = await store.backfill('acct_a', {
      media_buys: [{ media_buy_id: 'mb_1', packages: [{ package_id: 'seller_pkg_001' }] }],
    });

    expect(result.media_buys?.[0]?.packages?.[0]?.targeting_overlay).toEqual(overlay);
  });

  it('clears the entire overlay when patch sets targeting_overlay to null', async () => {
    const { store } = setup();
    await store.persistFromCreate(
      'acct_a',
      { packages: [{ buyer_ref: 'pkg_a', targeting_overlay: { property_list: PROPERTY_LIST } }] },
      { media_buy_id: 'mb_1', packages: [{ package_id: 'seller_pkg_001', buyer_ref: 'pkg_a' }] }
    );

    await store.mergeFromUpdate('acct_a', 'mb_1', {
      packages: [{ package_id: 'seller_pkg_001', targeting_overlay: null }],
    });

    const result = await store.backfill('acct_a', {
      media_buys: [{ media_buy_id: 'mb_1', packages: [{ package_id: 'seller_pkg_001' }] }],
    });

    expect(result.media_buys?.[0]?.packages?.[0]?.targeting_overlay).toBeUndefined();
  });

  it('persists new_packages from update_media_buy', async () => {
    const { store } = setup();
    await store.persistFromCreate(
      'acct_a',
      { packages: [{ buyer_ref: 'pkg_a', targeting_overlay: { property_list: PROPERTY_LIST } }] },
      { media_buy_id: 'mb_1', packages: [{ package_id: 'seller_pkg_001', buyer_ref: 'pkg_a' }] }
    );

    await store.mergeFromUpdate('acct_a', 'mb_1', {
      new_packages: [
        {
          package_id: 'seller_pkg_002',
          buyer_ref: 'pkg_b',
          targeting_overlay: { collection_list: COLLECTION_LIST },
        },
      ],
    });

    const result = await store.backfill('acct_a', {
      media_buys: [
        {
          media_buy_id: 'mb_1',
          packages: [{ package_id: 'seller_pkg_001' }, { package_id: 'seller_pkg_002' }],
        },
      ],
    });

    expect(result.media_buys?.[0]?.packages?.[0]?.targeting_overlay).toEqual({
      property_list: PROPERTY_LIST,
    });
    expect(result.media_buys?.[0]?.packages?.[1]?.targeting_overlay).toEqual({
      collection_list: COLLECTION_LIST,
    });
  });
});
