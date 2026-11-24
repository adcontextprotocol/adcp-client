import type { VersionAdapter } from '../types';
import { withSellerIdOnly } from '../../../utils/platform-id';

function sellerIdOnlyAdapter(toolName: string, rows: string): VersionAdapter {
  return {
    toolName,
    /**
     * AdCP 3.3 renamed the row's platform identifier to `platform_id` and
     * kept `seller_id` as an alias. AdCP 3.2 defines `seller_id` only, so
     * carry the identifier there before the schema projection removes
     * `platform_id`. This also covers stored results written with
     * `platform_id` alone.
     */
    downgradeResponse(data) {
      const converted = withSellerIdOnly(data);
      if (converted === data) return { data };
      return {
        data: converted,
        drift: {
          type: 'platform_id_to_seller_id',
          message: `${rows}[].platform_id carried as seller_id, the only name AdCP 3.2 defines.`,
          movedFields: [{ from: `${rows}[].platform_id`, to: `${rows}[].seller_id` }],
        },
      };
    },
  };
}

export const syncEventSourcesAdapter = sellerIdOnlyAdapter('sync_event_sources', 'event_sources');
export const syncAudiencesAdapter = sellerIdOnlyAdapter('sync_audiences', 'audiences');
