const { describe, test } = require('node:test');
const assert = require('node:assert');

const { runValidations } = require('../../dist/lib/testing/storyboard/validations');

const AAO = 'https://creative.adcontextprotocol.org/';

function formatRejection(field = 'packages[0].format_options') {
  return {
    errors: [{ code: 'VALIDATION_ERROR', field, message: 'format selector does not satisfy product format_options' }],
  };
}

function run(validation, { request, products, success, data, error, adcp_error, taskName = 'create_media_buy' }) {
  return runValidations([validation], {
    taskName,
    taskResult: {
      success,
      data: data ?? (success ? { media_buy_id: 'mb_1' } : formatRejection()),
      ...(error && { error }),
      ...(adcp_error && { adcp_error }),
    },
    request: {
      transport: 'mcp',
      operation: taskName,
      payload: request,
      timestamp: '2026-05-27T00:00:00.000Z',
    },
    storyboardContext: { products },
    agentUrl: 'https://seller.example/mcp',
    contributions: new Set(),
  })[0];
}

function check(value, overrides = {}) {
  return {
    check: 'canonical_format_satisfaction',
    value,
    description: value ? 'selector should satisfy product' : 'selector should not satisfy product',
    ...overrides,
  };
}

const mrecProduct = {
  product_id: 'canonical_mrec',
  format_ids: [{ agent_url: AAO, id: 'display_300x250_image' }],
  format_options: [
    {
      format_kind: 'image',
      format_option_id: 'image_mrec',
      v1_format_ref: [{ agent_url: AAO, id: 'display_300x250_image' }],
      params: { width: 300, height: 250 },
    },
  ],
};

const videoRangeProduct = {
  product_id: 'video_range',
  format_options: [
    {
      format_kind: 'video_hosted',
      format_option_id: 'video_15_30',
      params: { duration_ms_range: [15000, 30000] },
    },
  ],
};

describe('canonical_format_satisfaction storyboard validation', () => {
  test('passes positive legacy format_id to canonical declaration bridge', () => {
    const result = run(check(true), {
      products: [mrecProduct],
      success: true,
      request: {
        packages: [
          {
            product_id: 'canonical_mrec',
            pricing_option_id: 'cpm',
            budget: 1000,
            format_ids: [{ agent_url: AAO, id: 'display_300x250_image' }],
          },
        ],
      },
    });

    assert.strictEqual(result.passed, true, result.error);
    assert.strictEqual(result.observations[0].bug_class, 'normalization');
  });

  test('normalizes legacy format_id through the catalog projection when v1_format_ref is absent', () => {
    const product = {
      product_id: 'canonical_mrec_no_ref',
      format_options: [
        {
          format_kind: 'image',
          format_option_id: 'image_mrec',
          params: { width: 300, height: 250 },
        },
      ],
    };
    const result = run(check(true), {
      products: [product],
      success: true,
      request: {
        packages: [
          {
            product_id: 'canonical_mrec_no_ref',
            pricing_option_id: 'cpm',
            budget: 1000,
            format_ids: [{ agent_url: AAO, id: 'display_300x250_image' }],
          },
        ],
      },
    });

    assert.strictEqual(result.passed, true, result.error);
    assert.strictEqual(result.observations[0].bug_class, 'normalization');
  });

  test('passes legacy-only products through the format_ids compatibility path', () => {
    const product = {
      product_id: 'legacy_only_mrec',
      format_ids: [{ agent_url: AAO, id: 'display_300x250_image' }],
    };
    const result = run(check(true), {
      products: [product],
      success: true,
      request: {
        packages: [
          {
            product_id: 'legacy_only_mrec',
            pricing_option_id: 'cpm',
            budget: 1000,
            format_ids: [{ agent_url: AAO, id: 'display_300x250_image' }],
          },
        ],
      },
    });

    assert.strictEqual(result.passed, true, result.error);
    assert.strictEqual(result.observations[0].bug_class, 'normalization');
  });

  test('normalization failure message when seller rejects a locally satisfying legacy selector', () => {
    const result = run(check(true), {
      products: [mrecProduct],
      success: false,
      request: {
        packages: [
          {
            product_id: 'canonical_mrec',
            pricing_option_id: 'cpm',
            budget: 1000,
            format_ids: [{ agent_url: AAO, id: 'display_300x250_image' }],
          },
        ],
      },
    });

    assert.strictEqual(result.passed, false);
    assert.match(result.error, /Likely normalization failure/);
    assert.match(result.remediation, /Normalize legacy format_ids/);
  });

  test('does not let divergent legacy format_ids override canonical format_options on dual-emitted products', () => {
    const product = {
      product_id: 'dual_emitted_drift',
      format_ids: [{ agent_url: AAO, id: 'video_standard_30s' }],
      format_options: [
        {
          format_kind: 'image',
          format_option_id: 'image_mrec',
          v1_format_ref: [{ agent_url: AAO, id: 'display_300x250_image' }],
          params: { width: 300, height: 250 },
        },
      ],
    };

    const accepted = run(check(false), {
      products: [product],
      success: true,
      request: {
        packages: [
          {
            product_id: 'dual_emitted_drift',
            pricing_option_id: 'cpm',
            budget: 1000,
            format_ids: [{ agent_url: AAO, id: 'video_standard_30s' }],
          },
        ],
      },
    });
    assert.strictEqual(accepted.passed, false);
    assert.match(accepted.error, /Likely normalization failure/);
    assert.match(accepted.observations[0].detail, /did not normalize/);

    const rejected = run(check(false), {
      products: [product],
      success: false,
      request: {
        packages: [
          {
            product_id: 'dual_emitted_drift',
            pricing_option_id: 'cpm',
            budget: 1000,
            format_ids: [{ agent_url: AAO, id: 'video_standard_30s' }],
          },
        ],
      },
    });
    assert.strictEqual(rejected.passed, true, rejected.error);
  });

  test('passes product-local format_option_refs and ignores compatibility format_ids on dual-write packages', () => {
    const result = run(check(true), {
      products: [mrecProduct],
      success: true,
      request: {
        packages: [
          {
            product_id: 'canonical_mrec',
            pricing_option_id: 'cpm',
            budget: 1000,
            format_option_refs: [{ scope: 'product', format_option_id: 'image_mrec' }],
            format_ids: [{ agent_url: AAO, id: 'video_standard_30s' }],
          },
        ],
      },
    });

    assert.strictEqual(result.passed, true, result.error);
    assert.strictEqual(result.observations[0].bug_class, 'directionality');
    assert.match(result.observations[0].detail, /format_option_refs/);
  });

  test('invalid format_option_refs scope is an authoring failure, not a product-local ref', () => {
    const result = run(check(true), {
      products: [mrecProduct],
      success: false,
      request: {
        packages: [
          {
            product_id: 'canonical_mrec',
            pricing_option_id: 'cpm',
            budget: 1000,
            format_option_refs: [{ scope: 'bogus', format_option_id: 'image_mrec' }],
          },
        ],
      },
    });

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.actual.bug_class, 'authoring');
    assert.match(result.actual.detail, /scope/);
    assert.strictEqual(result.json_pointer, '/packages/0/format_option_refs/0/scope');
  });

  test('passes negative under-specified canonical selector rejection', () => {
    const result = run(check(false), {
      products: [mrecProduct],
      success: false,
      request: {
        packages: [
          {
            product_id: 'canonical_mrec',
            pricing_option_id: 'cpm',
            budget: 1000,
            format_options: [{ format_kind: 'image', params: {} }],
          },
        ],
      },
    });

    assert.strictEqual(result.passed, true, result.error);
    assert.strictEqual(result.observations[0].bug_class, 'directionality');
    assert.match(result.observations[0].detail, /Under-specified selector/);
  });

  test('directionality failure message when seller accepts a bare canonical selector for fixed-size product', () => {
    const result = run(check(false), {
      products: [mrecProduct],
      success: true,
      request: {
        packages: [
          {
            product_id: 'canonical_mrec',
            pricing_option_id: 'cpm',
            budget: 1000,
            format_options: [{ format_kind: 'image', params: {} }],
          },
        ],
      },
    });

    assert.strictEqual(result.passed, false);
    assert.match(result.error, /Likely directionality failure/);
    assert.match(result.remediation, /directional product gating/);
  });

  test('rejects fixed-size canonical selector mismatches', () => {
    const result = run(check(false), {
      products: [mrecProduct],
      success: false,
      request: {
        packages: [
          {
            product_id: 'canonical_mrec',
            pricing_option_id: 'cpm',
            budget: 1000,
            format_options: [{ format_kind: 'image', params: { width: 320, height: 250 } }],
          },
        ],
      },
    });

    assert.strictEqual(result.passed, true, result.error);
    assert.match(result.observations[0].detail, /width/);
  });

  test('valid canonical selector rejection reports the canonical bug class instead of legacy normalization', () => {
    const result = run(check(true), {
      products: [videoRangeProduct],
      success: false,
      request: {
        packages: [
          {
            product_id: 'video_range',
            pricing_option_id: 'cpm',
            budget: 1000,
            format_options: [{ format_kind: 'video_hosted', params: { duration_ms_exact: 20000 } }],
          },
        ],
      },
    });

    assert.strictEqual(result.passed, false);
    assert.match(result.error, /Likely directionality failure/);
    assert.doesNotMatch(result.error, /normalization/);
  });

  test('does not pass negative cases when the agent rejected for an unrelated reason', () => {
    const result = run(check(false), {
      products: [mrecProduct],
      success: false,
      data: {
        errors: [{ code: 'AUTHENTICATION_REQUIRED', field: 'auth', message: 'missing credentials' }],
      },
      error: 'AUTHENTICATION_REQUIRED: missing credentials',
      request: {
        packages: [
          {
            product_id: 'canonical_mrec',
            pricing_option_id: 'cpm',
            budget: 1000,
            format_options: [{ format_kind: 'image', params: {} }],
          },
        ],
      },
    });

    assert.strictEqual(result.passed, false);
    assert.match(result.error, /did not identify a format-selector cause/);
    assert.deepStrictEqual(result.actual.rejection.codes, ['AUTHENTICATION_REQUIRED']);
  });

  test('compares non-size canonical params such as orientation and aspect_ratio', () => {
    const product = {
      product_id: 'vertical_story',
      format_options: [
        {
          format_kind: 'image',
          format_option_id: 'vertical_story_image',
          params: { width: 1080, height: 1920, orientation: 'vertical', aspect_ratio: '9:16' },
        },
      ],
    };

    const result = run(check(false), {
      products: [product],
      success: false,
      request: {
        packages: [
          {
            product_id: 'vertical_story',
            pricing_option_id: 'cpm',
            budget: 1000,
            format_options: [
              { format_kind: 'image', params: { width: 1080, height: 1920, orientation: 'horizontal' } },
            ],
          },
        ],
      },
    });

    assert.strictEqual(result.passed, true, result.error);
    assert.match(result.observations[0].detail, /orientation/);
  });

  test('requires selectors to include richer canonical params such as video_codecs', () => {
    const product = {
      product_id: 'video_codec',
      format_options: [
        {
          format_kind: 'video_hosted',
          format_option_id: 'video_h264',
          params: { duration_ms_range: [15000, 30000], video_codecs: ['h264'] },
        },
      ],
    };

    const omitted = run(check(false), {
      products: [product],
      success: false,
      request: {
        packages: [
          {
            product_id: 'video_codec',
            pricing_option_id: 'cpm',
            budget: 1000,
            format_options: [{ format_kind: 'video_hosted', params: { duration_ms_exact: 15000 } }],
          },
        ],
      },
    });
    assert.strictEqual(omitted.passed, true, omitted.error);
    assert.match(omitted.observations[0].detail, /video_codecs/);

    const selected = run(check(true), {
      products: [product],
      success: true,
      request: {
        packages: [
          {
            product_id: 'video_codec',
            pricing_option_id: 'cpm',
            budget: 1000,
            format_options: [
              { format_kind: 'video_hosted', params: { duration_ms_exact: 15000, video_codecs: ['h264'] } },
            ],
          },
        ],
      },
    });
    assert.strictEqual(selected.passed, true, selected.error);
  });

  test('supports product params.sizes[] using exact width and height selectors', () => {
    const product = {
      product_id: 'multi_size',
      format_options: [
        {
          format_kind: 'image',
          format_option_id: 'image_multi',
          params: {
            sizes: [
              { width: 300, height: 250 },
              { width: 728, height: 90 },
            ],
          },
        },
      ],
    };

    const inside = run(check(true), {
      products: [product],
      success: true,
      request: {
        packages: [
          {
            product_id: 'multi_size',
            pricing_option_id: 'cpm',
            budget: 1000,
            format_options: [{ format_kind: 'image', params: { width: 728, height: 90 } }],
          },
        ],
      },
    });
    assert.strictEqual(inside.passed, true, inside.error);

    const outside = run(check(false), {
      products: [product],
      success: false,
      request: {
        packages: [
          {
            product_id: 'multi_size',
            pricing_option_id: 'cpm',
            budget: 1000,
            format_options: [{ format_kind: 'image', params: { sizes: [{ width: 160, height: 600 }] } }],
          },
        ],
      },
    });
    assert.strictEqual(outside.passed, true, outside.error);
    assert.match(outside.observations[0].detail, /outside product params\.sizes/);
  });

  test('uses containment for width and height ranges', () => {
    const product = {
      product_id: 'responsive_range',
      format_options: [
        {
          format_kind: 'image',
          format_option_id: 'responsive_image',
          params: { min_width: 300, max_width: 728, min_height: 250, max_height: 600 },
        },
      ],
    };

    const exactInside = run(check(true), {
      products: [product],
      success: true,
      request: {
        packages: [
          {
            product_id: 'responsive_range',
            pricing_option_id: 'cpm',
            budget: 1000,
            format_options: [{ format_kind: 'image', params: { width: 300, height: 250 } }],
          },
        ],
      },
    });
    assert.strictEqual(exactInside.passed, true, exactInside.error);

    const rangeExceeds = run(check(false), {
      products: [product],
      success: false,
      request: {
        packages: [
          {
            product_id: 'responsive_range',
            pricing_option_id: 'cpm',
            budget: 1000,
            format_options: [{ format_kind: 'image', params: { min_width: 300, max_width: 1000, height: 250 } }],
          },
        ],
      },
    });
    assert.strictEqual(rangeExceeds.passed, true, rangeExceeds.error);
    assert.match(rangeExceeds.observations[0].detail, /width range/);
  });

  test('supports exact duration declarations', () => {
    const product = {
      product_id: 'video_exact',
      format_options: [
        {
          format_kind: 'video_hosted',
          format_option_id: 'video_30',
          params: { duration_ms_exact: 30000 },
        },
      ],
    };

    const exact = run(check(true), {
      products: [product],
      success: true,
      request: {
        packages: [
          {
            product_id: 'video_exact',
            pricing_option_id: 'cpm',
            budget: 1000,
            format_options: [{ format_kind: 'video_hosted', params: { duration_ms: 30000 } }],
          },
        ],
      },
    });
    assert.strictEqual(exact.passed, true, exact.error);

    const mismatch = run(check(false), {
      products: [product],
      success: false,
      request: {
        packages: [
          {
            product_id: 'video_exact',
            pricing_option_id: 'cpm',
            budget: 1000,
            format_options: [{ format_kind: 'video_hosted', params: { duration_ms_exact: 15000 } }],
          },
        ],
      },
    });
    assert.strictEqual(mismatch.passed, true, mismatch.error);
    assert.match(mismatch.observations[0].detail, /duration/);
  });

  test('duration range uses containment, not overlap', () => {
    const overlap = run(check(false), {
      products: [videoRangeProduct],
      success: true,
      request: {
        packages: [
          {
            product_id: 'video_range',
            pricing_option_id: 'cpm',
            budget: 1000,
            format_options: [{ format_kind: 'video_hosted', params: { duration_ms_range: [10000, 20000] } }],
          },
        ],
      },
    });
    assert.strictEqual(overlap.passed, false);
    assert.match(overlap.error, /Likely range_containment failure/);
    assert.match(overlap.remediation, /ranges/);

    const exactInside = run(check(true), {
      products: [videoRangeProduct],
      success: true,
      request: {
        packages: [
          {
            product_id: 'video_range',
            pricing_option_id: 'cpm',
            budget: 1000,
            format_options: [{ format_kind: 'video_hosted', params: { duration_ms_exact: 15000 } }],
          },
        ],
      },
    });
    assert.strictEqual(exactInside.passed, true, exactInside.error);
  });

  test('validation.path can select one package from a multi-package request', () => {
    const result = run(check(true, { path: 'packages[1]' }), {
      products: [mrecProduct],
      success: true,
      request: {
        packages: [
          {
            product_id: 'canonical_mrec',
            pricing_option_id: 'cpm',
            budget: 1000,
            format_options: [{ format_kind: 'image', params: {} }],
          },
          {
            product_id: 'canonical_mrec',
            pricing_option_id: 'cpm',
            budget: 1000,
            format_options: [{ format_kind: 'image', params: { width: 300, height: 250 } }],
          },
        ],
      },
    });

    assert.strictEqual(result.passed, true, result.error);
    assert.strictEqual(result.json_pointer, '/packages/1/format_options/0');
  });

  test('validation.path resolving to an empty package array is an authoring failure', () => {
    const result = run(check(true, { path: 'packages' }), {
      products: [mrecProduct],
      success: true,
      request: { packages: [] },
    });

    assert.strictEqual(result.passed, false);
    assert.match(result.error, /resolved to an empty package array/);
    assert.strictEqual(result.json_pointer, '/packages');
  });

  test('fails authoring when used outside create_media_buy', () => {
    const result = run(check(true), {
      taskName: 'get_products',
      products: [mrecProduct],
      success: true,
      request: { packages: [{ product_id: 'canonical_mrec' }] },
    });

    assert.strictEqual(result.passed, false);
    assert.match(result.error, /applies only to create_media_buy/);
    assert.strictEqual(result.expected, 'create_media_buy');
    assert.strictEqual(result.actual, 'get_products');
  });
});
