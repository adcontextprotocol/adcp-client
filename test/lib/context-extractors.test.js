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

  describe('check_governance', () => {
    it('extracts governance_context, check_id, plan_id, and status', () => {
      const data = {
        status: 'approved',
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
      const data = { status: 'denied' };
      const result = extractContext('check_governance', data);
      assert.deepStrictEqual(result, { governance_status: 'denied' });
    });

    it('returns empty object for empty data', () => {
      assert.deepStrictEqual(extractContext('check_governance', {}), {});
    });
  });

  describe('report_plan_outcome', () => {
    it('extracts outcome_id and outcome_status', () => {
      const data = { status: 'completed', outcome_id: 'out_456' };
      const result = extractContext('report_plan_outcome', data);
      assert.deepStrictEqual(result, { outcome_id: 'out_456', outcome_status: 'completed' });
    });

    it('returns empty object when status is missing', () => {
      assert.deepStrictEqual(extractContext('report_plan_outcome', {}), {});
    });
  });
});
