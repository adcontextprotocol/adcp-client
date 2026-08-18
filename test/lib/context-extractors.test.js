const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { extractContext, extractContextWithProvenance } = require('../../dist/lib/testing/storyboard/context.js');
const { proposalTermsDigest } = require('../../dist/lib/negotiation/verification.js');

describe('context extractors', () => {
  describe('build_creative', () => {
    it('preserves single creative_manifest extraction', () => {
      const data = {
        creative_manifest: {
          format_id: { agent_url: 'https://creative.example', id: 'display_300x250' },
          assets: [],
        },
      };

      const result = extractContext('build_creative', data);
      assert.deepStrictEqual(result.creative_manifest, data.creative_manifest);
      assert.deepStrictEqual(result.format_id, data.creative_manifest.format_id);
    });

    it('extracts variant groups and first variant context', () => {
      const firstManifest = {
        format_id: { agent_url: 'https://creative.example', id: 'display_300x250' },
        assets: [{ slot: 'image', url: 'https://cdn.example/one.png' }],
      };
      const secondManifest = {
        format_id: { agent_url: 'https://creative.example', id: 'display_728x90' },
        assets: [{ slot: 'image', url: 'https://cdn.example/two.png' }],
      };
      const data = {
        creatives: [
          {
            creative_ref: 'summer',
            variants: [{ build_variant_id: 'bv_1', creative_manifest: firstManifest }],
          },
          {
            creative_ref: 'winter',
            variants: [{ build_variant_id: 'bv_2', creative_manifest: secondManifest }],
          },
        ],
      };

      const result = extractContext('build_creative', data);
      assert.deepStrictEqual(result.creatives, data.creatives);
      assert.deepStrictEqual(result.variants, [data.creatives[0].variants[0], data.creatives[1].variants[0]]);
      assert.equal(result.build_variant_id, 'bv_1');
      assert.deepStrictEqual(result.creative_manifest, firstManifest);
      assert.deepStrictEqual(result.format_id, firstManifest.format_id);
    });

    it('retains creatives even when no variants are present', () => {
      const data = { creatives: [{ creative_ref: 'summer', status: 'failed' }] };

      const result = extractContext('build_creative', data);
      assert.deepStrictEqual(result.creatives, data.creatives);
      assert.equal(result.variants, undefined);
      assert.equal(result.build_variant_id, undefined);
    });
  });

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
        media_buys: [
          {
            media_buy_id: 'mb_1',
            status: 'completed',
            media_buy_status: 'active',
            revision: 4,
            available_actions: [{ action: 'pause' }],
          },
        ],
      });

      assert.deepStrictEqual(result, {
        media_buy_id: 'mb_1',
        media_buy_status: 'active',
        revision: 4,
        media_buy_revision: 4,
        available_actions: [{ action: 'pause' }],
      });
    });
  });

  describe('compact 3.2 lifecycle extraction', () => {
    it('captures one coherent product snapshot from list_products', () => {
      const product = {
        product_id: 'prod_1',
        name: 'Homepage display',
        pricing_options: [{ pricing_option_id: 'price_1', pricing_model: 'cpm', currency: 'USD', fixed_price: 10 }],
      };

      const result = extractContext('list_products', {
        outcome: 'listed',
        products: [product],
        feed_version: 'feed_7',
        pricing_version: 'pricing_3',
        cache_scope: 'public',
      });

      assert.deepStrictEqual(result, {
        product_id: 'prod_1',
        pricing_option_id: 'price_1',
        feed_version: 'feed_7',
        pricing_version: 'pricing_3',
      });
    });

    it('replaces product snapshots atomically when optional pricing disappears', () => {
      const context = extractContext('list_products', {
        outcome: 'listed',
        products: [
          {
            product_id: 'prod_a',
            name: 'Product A',
            pricing_options: [{ pricing_option_id: 'price_a', pricing_model: 'cpm', currency: 'USD', fixed_price: 10 }],
          },
        ],
        feed_version: 'feed_a',
        pricing_version: 'pricing_a',
        cache_scope: 'public',
      });
      const write = extractContextWithProvenance(
        'list_products',
        {
          outcome: 'listed',
          products: [{ product_id: 'prod_b', name: 'Product B' }],
          feed_version: 'feed_b',
          cache_scope: 'public',
        },
        'list_b'
      );

      for (const group of write.clearGroups) {
        for (const key of group.keys) delete context[key];
      }
      Object.assign(context, write.values);

      assert.deepStrictEqual(context, { product_id: 'prod_b', feed_version: 'feed_b' });
      assert.equal(write.provenance.product_id.source_step_id, 'list_b');
    });

    it('captures draft and finalized proposal snapshots for acceptance', () => {
      const commercialTerms = {
        brand: { domain: 'example.com' },
        purchases: [
          {
            product_id: 'prod_1',
            pricing_option_id: 'price_1',
            pricing: {
              pricing_option_id: 'price_1',
              pricing_model: 'cpm',
              currency: 'USD',
              fixed_price: 10,
            },
            start_time: '2026-09-01T00:00:00Z',
            end_time: '2026-10-01T00:00:00Z',
          },
        ],
        start_time: '2026-09-01T00:00:00Z',
        end_time: '2026-10-01T00:00:00Z',
      };
      const draft = {
        proposal_id: 'proposal_draft',
        proposal_kind: 'new_media_buy',
        proposal_status: 'draft',
        expires_at: '2026-08-30T00:00:00Z',
        name: 'Draft homepage campaign',
        commercial_terms: commercialTerms,
        terms_digest: proposalTermsDigest(commercialTerms),
      };
      assert.deepStrictEqual(
        extractContext('request_proposals', {
          outcome: 'proposed',
          products: [{ product_id: 'prod_1', name: 'Homepage display' }],
          proposals: [draft],
        }),
        {
          proposal_id: 'proposal_draft',
          proposal_kind: 'new_media_buy',
          proposal_status: 'draft',
          terms_digest: draft.terms_digest,
          proposal_terms_digest: draft.terms_digest,
        }
      );

      const committed = {
        ...draft,
        proposal_id: 'proposal_committed',
        parent_proposal_id: draft.proposal_id,
        proposal_status: 'committed',
        expires_at: '2026-08-31T00:00:00Z',
        terms_digest: draft.terms_digest,
      };
      assert.deepStrictEqual(
        extractContext('refine_proposals', {
          products: [{ product_id: 'prod_1', name: 'Homepage display' }],
          results: [{ source_proposal_id: draft.proposal_id, outcome: 'finalized', proposal: committed }],
        }),
        {
          proposal_id: 'proposal_committed',
          proposal_kind: 'new_media_buy',
          proposal_status: 'committed',
          terms_digest: committed.terms_digest,
          proposal_terms_digest: committed.terms_digest,
        }
      );

      const revised = {
        ...draft,
        proposal_id: 'proposal_revised',
        parent_proposal_id: draft.proposal_id,
        terms_digest: draft.terms_digest,
      };
      assert.equal(
        extractContext('refine_proposals', {
          products: [{ product_id: 'prod_1', name: 'Homepage display' }],
          results: [{ source_proposal_id: draft.proposal_id, outcome: 'revised', proposals: [revised] }],
        }).proposal_id,
        revised.proposal_id
      );
      assert.equal(
        extractContextWithProvenance(
          'refine_proposals',
          { status: 'submitted', task_id: 'task_refine' },
          'refine_submitted'
        ).clearGroups,
        undefined
      );
    });

    it('captures media-buy identity and revision across buy, accept, and control', () => {
      const commercialTerms = {
        brand: { domain: 'example.com' },
        purchases: [
          {
            product_id: 'prod_1',
            pricing_option_id: 'price_1',
            pricing: {
              pricing_option_id: 'price_1',
              pricing_model: 'cpm',
              currency: 'USD',
              fixed_price: 10,
            },
            start_time: '2026-09-01T00:00:00Z',
            end_time: '2026-10-01T00:00:00Z',
          },
        ],
        start_time: '2026-09-01T00:00:00Z',
        end_time: '2026-10-01T00:00:00Z',
      };
      const termsDigest = proposalTermsDigest(commercialTerms);
      const acceptedProposal = {
        proposal_id: 'proposal_accepted',
        proposal_kind: 'new_media_buy',
        proposal_status: 'accepted',
        media_buy_id: 'mb_compact',
        accepted_at: '2026-08-18T10:00:00Z',
        name: 'Accepted homepage campaign',
        commercial_terms: commercialTerms,
        terms_digest: termsDigest,
      };
      const commitment = {
        status: 'completed',
        media_buy_id: 'mb_compact',
        media_buy_status: 'pending_creatives',
        revision: 2,
        accepted_proposal: acceptedProposal,
        purchase_bindings: [{ purchase_index: 0, product_id: 'prod_1', package_id: 'pkg_1' }],
        available_actions: [],
      };
      const expected = {
        media_buy_id: 'mb_compact',
        media_buy_status: 'pending_creatives',
        revision: 2,
        media_buy_revision: 2,
        proposal_id: 'proposal_accepted',
        proposal_kind: 'new_media_buy',
        proposal_status: 'accepted',
        terms_digest: termsDigest,
        proposal_terms_digest: termsDigest,
        available_actions: [],
      };

      assert.deepStrictEqual(extractContext('buy_products', commitment), expected);
      assert.deepStrictEqual(extractContext('accept_proposal', commitment), expected);
      assert.deepStrictEqual(extractContext('control_media_buy', { ...commitment, accepted_proposal: undefined }), {
        media_buy_id: 'mb_compact',
        media_buy_status: 'pending_creatives',
        revision: 2,
        media_buy_revision: 2,
        available_actions: [],
      });
      assert.deepStrictEqual(
        extractContext('control_media_buy', {
          status: 'completed',
          media_buy_id: 'mb_compact',
          revision: 3,
        }),
        {
          media_buy_id: 'mb_compact',
          revision: 3,
          media_buy_revision: 3,
        },
        'compact task-envelope status must not be mistaken for lifecycle status'
      );
      assert.deepStrictEqual(extractContext('buy_products', { status: 'submitted', task_id: 'task_1' }), {});
      assert.deepStrictEqual(
        extractContext('accept_proposal', {
          status: 'failed',
          errors: [{ code: 'INVALID_STATE', message: 'Proposal is no longer committed' }],
        }),
        {}
      );
    });

    it('clears proposal aliases after a decline without retaining response details', () => {
      const results = [{ proposal_id: 'proposal_1', outcome: 'declined' }];
      assert.deepStrictEqual(extractContext('decline_proposals', { results }), {});
      assert.deepStrictEqual(extractContext('decline_proposals', { results: [] }), {});
      const write = extractContextWithProvenance('decline_proposals', { results }, 'decline');
      const context = {
        proposal_id: 'proposal_1',
        proposal_status: 'draft',
        proposal_terms_digest: `sha256:${'E'.repeat(43)}`,
      };
      for (const group of write.clearGroups) {
        for (const key of group.keys) delete context[key];
      }
      Object.assign(context, write.values);
      assert.deepStrictEqual(context, {});
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
