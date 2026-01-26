// Unit tests for pricing adapter utilities
const { test, describe } = require('node:test');
const assert = require('node:assert');

// Import pricing adapter functions
const {
  usesV2PricingFields,
  usesV3PricingFields,
  isFixedPricing,
  getPrice,
  getFloorPrice,
  adaptPricingOptionForV2,
  normalizePricingOption,
  normalizeProductPricing,
  normalizeGetProductsResponse,
} = require('../../dist/lib/utils/pricing-adapter.js');

describe('pricing adapter utilities', () => {
  describe('usesV2PricingFields', () => {
    test('should detect v2 rate field', () => {
      assert.strictEqual(usesV2PricingFields({ rate: 5.00 }), true);
    });

    test('should detect v2 is_fixed field', () => {
      assert.strictEqual(usesV2PricingFields({ is_fixed: true }), true);
      assert.strictEqual(usesV2PricingFields({ is_fixed: false }), true);
    });

    test('should detect v2 price_guidance.floor field', () => {
      assert.strictEqual(usesV2PricingFields({ price_guidance: { floor: 1.00 } }), true);
    });

    test('should return false for v3-only fields', () => {
      assert.strictEqual(usesV2PricingFields({ fixed_price: 5.00 }), false);
      assert.strictEqual(usesV2PricingFields({ floor_price: 1.00 }), false);
    });

    test('should return false for null/undefined', () => {
      assert.strictEqual(usesV2PricingFields(null), false);
      assert.strictEqual(usesV2PricingFields(undefined), false);
    });

    test('should return false for non-objects', () => {
      assert.strictEqual(usesV2PricingFields('string'), false);
      assert.strictEqual(usesV2PricingFields(123), false);
    });
  });

  describe('usesV3PricingFields', () => {
    test('should detect v3 fixed_price field', () => {
      assert.strictEqual(usesV3PricingFields({ fixed_price: 5.00 }), true);
    });

    test('should detect v3 floor_price field', () => {
      assert.strictEqual(usesV3PricingFields({ floor_price: 1.00 }), true);
    });

    test('should return false for v2-only fields', () => {
      assert.strictEqual(usesV3PricingFields({ rate: 5.00 }), false);
      assert.strictEqual(usesV3PricingFields({ is_fixed: true }), false);
    });

    test('should return false for null/undefined', () => {
      assert.strictEqual(usesV3PricingFields(null), false);
      assert.strictEqual(usesV3PricingFields(undefined), false);
    });
  });

  describe('isFixedPricing', () => {
    test('should return true for v3 fixed_price', () => {
      assert.strictEqual(isFixedPricing({ fixed_price: 5.00 }), true);
    });

    test('should return true for v2 is_fixed: true', () => {
      assert.strictEqual(isFixedPricing({ is_fixed: true }), true);
    });

    test('should return false for v2 is_fixed: false', () => {
      assert.strictEqual(isFixedPricing({ is_fixed: false }), false);
    });

    test('should return true for v2 rate (implies fixed)', () => {
      assert.strictEqual(isFixedPricing({ rate: 5.00 }), true);
    });

    test('should return false when no indicators present', () => {
      assert.strictEqual(isFixedPricing({ pricing_model: 'cpm' }), false);
    });
  });

  describe('getPrice', () => {
    test('should return v3 fixed_price', () => {
      assert.strictEqual(getPrice({ fixed_price: 5.00 }), 5.00);
    });

    test('should return v2 rate', () => {
      assert.strictEqual(getPrice({ rate: 3.50 }), 3.50);
    });

    test('should prefer v3 fixed_price over v2 rate', () => {
      assert.strictEqual(getPrice({ fixed_price: 5.00, rate: 3.50 }), 5.00);
    });

    test('should return undefined when neither field present', () => {
      assert.strictEqual(getPrice({ pricing_model: 'cpm' }), undefined);
    });
  });

  describe('getFloorPrice', () => {
    test('should return v3 floor_price', () => {
      assert.strictEqual(getFloorPrice({ floor_price: 1.00 }), 1.00);
    });

    test('should return v2 price_guidance.floor', () => {
      assert.strictEqual(getFloorPrice({ price_guidance: { floor: 0.50 } }), 0.50);
    });

    test('should prefer v3 floor_price over v2', () => {
      assert.strictEqual(getFloorPrice({ floor_price: 1.00, price_guidance: { floor: 0.50 } }), 1.00);
    });

    test('should return undefined when neither field present', () => {
      assert.strictEqual(getFloorPrice({ pricing_model: 'cpm' }), undefined);
    });
  });

  describe('adaptPricingOptionForV2', () => {
    test('should convert v3 fixed_price to v2 rate and is_fixed', () => {
      const v3Option = {
        pricing_option_id: 'cpm_fixed',
        pricing_model: 'cpm',
        currency: 'USD',
        fixed_price: 5.00,
      };

      const v2Option = adaptPricingOptionForV2(v3Option);

      assert.strictEqual(v2Option.rate, 5.00);
      assert.strictEqual(v2Option.is_fixed, true);
      assert.strictEqual(v2Option.fixed_price, undefined);
      assert.strictEqual(v2Option.pricing_option_id, 'cpm_fixed');
      assert.strictEqual(v2Option.currency, 'USD');
    });

    test('should convert v3 floor_price to v2 price_guidance.floor', () => {
      const v3Option = {
        pricing_option_id: 'cpm_auction',
        pricing_model: 'cpm',
        currency: 'USD',
        floor_price: 1.00,
        price_guidance: { p50: 2.50 },
      };

      const v2Option = adaptPricingOptionForV2(v3Option);

      assert.strictEqual(v2Option.is_fixed, false);
      assert.strictEqual(v2Option.price_guidance.floor, 1.00);
      assert.strictEqual(v2Option.price_guidance.p50, 2.50);
      assert.strictEqual(v2Option.floor_price, undefined);
    });

    test('should pass through v2 options unchanged', () => {
      const v2Option = {
        pricing_option_id: 'cpm_fixed',
        pricing_model: 'cpm',
        currency: 'USD',
        rate: 5.00,
        is_fixed: true,
      };

      const result = adaptPricingOptionForV2(v2Option);

      assert.strictEqual(result.rate, 5.00);
      assert.strictEqual(result.is_fixed, true);
    });

    test('should preserve additional fields', () => {
      const v3Option = {
        pricing_option_id: 'cpm_fixed',
        pricing_model: 'cpm',
        currency: 'USD',
        fixed_price: 5.00,
        min_spend_per_package: 1000,
        custom_field: 'value',
      };

      const v2Option = adaptPricingOptionForV2(v3Option);

      assert.strictEqual(v2Option.min_spend_per_package, 1000);
      assert.strictEqual(v2Option.custom_field, 'value');
    });
  });

  describe('normalizePricingOption', () => {
    test('should convert v2 rate and is_fixed to v3 fixed_price', () => {
      const v2Option = {
        pricing_option_id: 'cpm_fixed',
        pricing_model: 'cpm',
        currency: 'USD',
        rate: 5.00,
        is_fixed: true,
      };

      const v3Option = normalizePricingOption(v2Option);

      assert.strictEqual(v3Option.fixed_price, 5.00);
      assert.strictEqual(v3Option.rate, undefined);
      assert.strictEqual(v3Option.is_fixed, undefined);
    });

    test('should convert v2 price_guidance.floor to v3 floor_price', () => {
      const v2Option = {
        pricing_option_id: 'cpm_auction',
        pricing_model: 'cpm',
        currency: 'USD',
        is_fixed: false,
        price_guidance: {
          floor: 1.00,
          p25: 1.50,
          p50: 2.50,
          p75: 3.50,
        },
      };

      const v3Option = normalizePricingOption(v2Option);

      assert.strictEqual(v3Option.floor_price, 1.00);
      assert.strictEqual(v3Option.price_guidance.p25, 1.50);
      assert.strictEqual(v3Option.price_guidance.p50, 2.50);
      assert.strictEqual(v3Option.price_guidance.p75, 3.50);
      assert.strictEqual(v3Option.price_guidance.floor, undefined);
    });

    test('should pass through v3 options unchanged', () => {
      const v3Option = {
        pricing_option_id: 'cpm_fixed',
        pricing_model: 'cpm',
        currency: 'USD',
        fixed_price: 5.00,
      };

      const result = normalizePricingOption(v3Option);

      assert.strictEqual(result.fixed_price, 5.00);
    });

    test('should handle v2 rate without explicit is_fixed (implies fixed)', () => {
      const v2Option = {
        pricing_option_id: 'cpm_fixed',
        pricing_model: 'cpm',
        currency: 'USD',
        rate: 5.00,
      };

      const v3Option = normalizePricingOption(v2Option);

      assert.strictEqual(v3Option.fixed_price, 5.00);
    });

    test('should not convert rate if is_fixed is false', () => {
      const v2Option = {
        pricing_option_id: 'cpm_auction',
        pricing_model: 'cpm',
        currency: 'USD',
        rate: 5.00,
        is_fixed: false,
      };

      const v3Option = normalizePricingOption(v2Option);

      // rate should not become fixed_price when is_fixed is false
      assert.strictEqual(v3Option.fixed_price, undefined);
    });
  });

  describe('normalizeProductPricing', () => {
    test('should normalize pricing_options array', () => {
      const product = {
        id: 'product-1',
        name: 'Test Product',
        pricing_options: [
          {
            pricing_option_id: 'cpm_fixed',
            pricing_model: 'cpm',
            currency: 'USD',
            rate: 5.00,
            is_fixed: true,
          },
          {
            pricing_option_id: 'cpm_auction',
            pricing_model: 'cpm',
            currency: 'USD',
            is_fixed: false,
            price_guidance: { floor: 1.00 },
          },
        ],
      };

      const normalized = normalizeProductPricing(product);

      assert.strictEqual(normalized.pricing_options[0].fixed_price, 5.00);
      assert.strictEqual(normalized.pricing_options[1].floor_price, 1.00);
    });

    test('should pass through products without pricing_options', () => {
      const product = {
        id: 'product-1',
        name: 'Test Product',
      };

      const normalized = normalizeProductPricing(product);

      assert.deepStrictEqual(normalized, product);
    });

    test('should handle null/undefined products', () => {
      assert.strictEqual(normalizeProductPricing(null), null);
      assert.strictEqual(normalizeProductPricing(undefined), undefined);
    });
  });

  describe('normalizeGetProductsResponse', () => {
    test('should normalize all products in response', () => {
      const response = {
        products: [
          {
            id: 'product-1',
            pricing_options: [
              { pricing_option_id: 'opt1', rate: 5.00, is_fixed: true, pricing_model: 'cpm', currency: 'USD' },
            ],
          },
          {
            id: 'product-2',
            pricing_options: [
              { pricing_option_id: 'opt2', is_fixed: false, price_guidance: { floor: 1.00 }, pricing_model: 'cpm', currency: 'USD' },
            ],
          },
        ],
      };

      const normalized = normalizeGetProductsResponse(response);

      assert.strictEqual(normalized.products[0].pricing_options[0].fixed_price, 5.00);
      assert.strictEqual(normalized.products[1].pricing_options[0].floor_price, 1.00);
    });

    test('should pass through response without products array', () => {
      const response = { error: 'Not found' };

      const normalized = normalizeGetProductsResponse(response);

      assert.deepStrictEqual(normalized, response);
    });

    test('should preserve other response fields', () => {
      const response = {
        products: [
          { id: 'p1', pricing_options: [{ rate: 5.00, is_fixed: true, pricing_model: 'cpm', currency: 'USD', pricing_option_id: 'opt1' }] },
        ],
        total: 1,
        property_list_applied: true,
      };

      const normalized = normalizeGetProductsResponse(response);

      assert.strictEqual(normalized.total, 1);
      assert.strictEqual(normalized.property_list_applied, true);
    });
  });
});
