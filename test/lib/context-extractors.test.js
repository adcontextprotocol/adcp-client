const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { extractContext } = require('../../dist/lib/testing/storyboard/context.js');

describe('context extractors', () => {
  describe('list_creatives', () => {
    it('extracts creative_id and creatives array', () => {
      const data = {
        creatives: [
          { creative_id: 'cr_1', name: 'Banner A' },
          { creative_id: 'cr_2', name: 'Banner B' },
        ],
      };
      const result = extractContext('list_creatives', data);
      assert.equal(result.creative_id, 'cr_1');
      assert.deepStrictEqual(result.creatives, data.creatives);
    });

    it('returns empty object for empty creatives', () => {
      assert.deepStrictEqual(extractContext('list_creatives', { creatives: [] }), {});
    });

    it('returns empty object for undefined data', () => {
      assert.deepStrictEqual(extractContext('list_creatives', undefined), {});
    });

    it('extracts array when first item has no creative_id', () => {
      const data = { creatives: [{ name: 'Banner A' }] };
      const result = extractContext('list_creatives', data);
      assert.deepStrictEqual(result.creatives, data.creatives);
      assert.equal(result.creative_id, undefined);
    });
  });

  describe('sync_catalogs', () => {
    it('extracts catalog_id and catalogs array', () => {
      const data = {
        catalogs: [{ catalog_id: 'cat_menu', action: 'created', item_count: 3 }],
      };
      const result = extractContext('sync_catalogs', data);
      assert.equal(result.catalog_id, 'cat_menu');
      assert.deepStrictEqual(result.catalogs, data.catalogs);
    });

    it('returns empty object for empty catalogs', () => {
      assert.deepStrictEqual(extractContext('sync_catalogs', { catalogs: [] }), {});
    });

    it('returns empty object for undefined data', () => {
      assert.deepStrictEqual(extractContext('sync_catalogs', undefined), {});
    });
  });

  describe('sync_audiences', () => {
    it('extracts audience_id and audiences array', () => {
      const data = {
        audiences: [{ audience_id: 'aud_001', action: 'created', status: 'active' }],
      };
      const result = extractContext('sync_audiences', data);
      assert.equal(result.audience_id, 'aud_001');
      assert.deepStrictEqual(result.audiences, data.audiences);
    });

    it('returns empty object for empty audiences', () => {
      assert.deepStrictEqual(extractContext('sync_audiences', { audiences: [] }), {});
    });

    it('returns empty object for undefined data', () => {
      assert.deepStrictEqual(extractContext('sync_audiences', undefined), {});
    });
  });

  describe('sync_event_sources', () => {
    it('extracts event_source_id and event_sources array', () => {
      const data = {
        event_sources: [{ event_source_id: 'es_website', action: 'created' }],
      };
      const result = extractContext('sync_event_sources', data);
      assert.equal(result.event_source_id, 'es_website');
      assert.deepStrictEqual(result.event_sources, data.event_sources);
    });

    it('returns empty object for empty event_sources', () => {
      assert.deepStrictEqual(extractContext('sync_event_sources', { event_sources: [] }), {});
    });

    it('returns empty object for undefined data', () => {
      assert.deepStrictEqual(extractContext('sync_event_sources', undefined), {});
    });
  });

  describe('media-buy status extraction', () => {
    it('prefers media_buy_status over envelope status on create_media_buy', () => {
      const result = extractContext('create_media_buy', {
        media_buy_id: 'mb_1',
        status: 'completed',
        media_buy_status: 'pending_creatives',
      });

      assert.deepStrictEqual(result, {
        media_buy_id: 'mb_1',
        media_buy_status: 'pending_creatives',
      });
    });

    it('falls back to legacy status on update_media_buy', () => {
      const result = extractContext('update_media_buy', {
        media_buy_id: 'mb_1',
        status: 'paused',
      });

      assert.deepStrictEqual(result, {
        media_buy_id: 'mb_1',
        media_buy_status: 'paused',
      });
    });

    it('does not infer lifecycle status from 3.1 envelope completed status', () => {
      const result = extractContext('create_media_buy', {
        adcp_version: '3.1',
        media_buy_id: 'mb_1',
        status: 'completed',
      });

      assert.deepStrictEqual(result, {
        media_buy_id: 'mb_1',
      });
    });

    it('does not infer update lifecycle status from 3.1 envelope completed status', () => {
      const result = extractContext('update_media_buy', {
        adcp_version: '3.1',
        media_buy_id: 'mb_1',
        status: 'completed',
      });

      assert.deepStrictEqual(result, {
        media_buy_id: 'mb_1',
      });
    });

    it('prefers nested legacy media_buy fields over outer envelope status', () => {
      const result = extractContext('create_media_buy', {
        adcp_version: '3.0.0',
        status: 'completed',
        media_buy: {
          media_buy_id: 'mb_nested',
          status: 'active',
        },
      });

      assert.deepStrictEqual(result, {
        media_buy_id: 'mb_nested',
        media_buy_status: 'active',
      });
    });

    it('prefers media_buy_status on get_media_buys items', () => {
      const result = extractContext('get_media_buys', {
        media_buys: [{ media_buy_id: 'mb_1', status: 'completed', media_buy_status: 'active' }],
      });

      assert.deepStrictEqual(result, {
        media_buy_id: 'mb_1',
        media_buy_status: 'active',
      });
    });
  });

  describe('check_governance', () => {
    it('extracts governance_context, check_id, plan_id, and verdict', () => {
      const data = {
        verdict: 'approved',
        check_id: 'chk_123',
        plan_id: 'plan_1',
        governance_context: 'opaque-ctx-abc123',
      };
      const result = extractContext('check_governance', data);
      assert.deepStrictEqual(result, {
        governance_context: 'opaque-ctx-abc123',
        check_id: 'chk_123',
        plan_id: 'plan_1',
        governance_status: 'approved',
      });
    });

    it('extracts only present fields', () => {
      const data = { verdict: 'denied' };
      const result = extractContext('check_governance', data);
      assert.deepStrictEqual(result, { governance_status: 'denied' });
    });

    it('returns empty object for empty data', () => {
      assert.deepStrictEqual(extractContext('check_governance', {}), {});
    });
  });

  describe('sync_accounts', () => {
    it('extracts account_id, status, and a paired brand/operator account ref', () => {
      const data = {
        accounts: [
          {
            account_id: 'acct_1',
            status: 'active',
            brand: { domain: 'acme.example' },
            operator: 'pinnacle-agency.example',
          },
        ],
      };
      const result = extractContext('sync_accounts', data);
      assert.equal(result.account_id, 'acct_1');
      assert.equal(result.account_status, 'active');
      assert.deepStrictEqual(result.account, {
        brand: { domain: 'acme.example' },
        operator: 'pinnacle-agency.example',
      });
    });

    // Issue #1419 — extractor must not propagate `operator: undefined`. The
    // natural-key arm of AccountReference requires `operator`; an undefined
    // value would JSON.stringify away to a missing field and a strict-
    // validating seller would reject the synthetic ref. The extractor leaves
    // `operator` off the account ref entirely when the response omits it,
    // letting downstream synthesis sites supply a fallback.
    it('omits operator when the response leaves it undefined (no operator: undefined leak)', () => {
      const data = { accounts: [{ brand: { domain: 'acme.example' } }] };
      const result = extractContext('sync_accounts', data);
      assert.deepStrictEqual(result.account, { brand: { domain: 'acme.example' } });
      assert.strictEqual('operator' in result.account, false);
    });
  });

  describe('report_plan_outcome', () => {
    it('extracts outcome_id and outcome_state', () => {
      const data = { outcome_state: 'completed', outcome_id: 'out_456' };
      const result = extractContext('report_plan_outcome', data);
      assert.deepStrictEqual(result, { outcome_id: 'out_456', outcome_status: 'completed' });
    });

    it('returns empty object when outcome_state is missing', () => {
      assert.deepStrictEqual(extractContext('report_plan_outcome', {}), {});
    });
  });
});
