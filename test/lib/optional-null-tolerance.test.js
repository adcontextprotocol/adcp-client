// Tests for treatOptionalNullsAsAbsent: reading an explicit `null` as an
// omitted field wherever a generated Zod schema declares the field optional
// and non-nullable.
//
// The generated schemas keep `.optional()` so they mirror the TypeScript types
// exactly, which means they reject `null`. Agents that serialize from Pydantic,
// Jackson, or encoding/json emit `null` for fields they have nothing to report
// for, and Zod validates the whole payload before a caller reads any field — so
// a `null` on an optional scheduling hint discards the spend and impression
// figures reported alongside it.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');
const {
  treatOptionalNullsAsAbsent,
  GetMediaBuyDeliveryResponseSchema,
  AcquireRightsResponseSchema,
} = require('../../dist/lib/schemas/index.js');

function deliveryResponse(overrides = {}) {
  return {
    status: 'completed',
    reporting_period: { start: '2026-08-01T00:00:00Z', end: '2026-08-02T00:00:00Z' },
    media_buy_deliveries: [
      {
        media_buy_id: 'mb_1',
        status: 'active',
        totals: { impressions: 1000, spend: 500 },
        by_package: [{ package_id: 'pkg_1', impressions: 1000, spend: 500 }],
      },
    ],
    ...overrides,
  };
}

describe('treatOptionalNullsAsAbsent — what the schema says about a null', () => {
  test('drops null on an optional, non-nullable field', () => {
    const schema = z.object({ hint: z.string().optional() });

    const tolerated = treatOptionalNullsAsAbsent(schema, { hint: null });

    assert.deepEqual(tolerated, {});
    assert.equal('hint' in tolerated, false);
    assert.equal(schema.safeParse(tolerated).success, true);
  });

  test('keeps null on an explicitly nullable field', () => {
    const schema = z.object({ completion_rate: z.number().optional().nullable() });

    const tolerated = treatOptionalNullsAsAbsent(schema, { completion_rate: null });

    assert.deepEqual(tolerated, { completion_rate: null });
    assert.equal(schema.safeParse(tolerated).success, true);
  });

  test('keeps null on a required field so validation still fails', () => {
    const schema = z.object({ reporting_period: z.string() });

    const tolerated = treatOptionalNullsAsAbsent(schema, { reporting_period: null });

    assert.deepEqual(tolerated, { reporting_period: null });
    assert.equal(schema.safeParse(tolerated).success, false);
  });

  test('keeps null on a field the schema forbids outright', () => {
    // z.never().optional() means "must not be provided". Dropping the key would
    // turn a payload the schema rejects into one it accepts.
    const schema = z.object({ forbidden: z.never().optional() });

    const tolerated = treatOptionalNullsAsAbsent(schema, { forbidden: null });

    assert.deepEqual(tolerated, { forbidden: null });
    assert.equal(schema.safeParse(tolerated).success, false);
  });

  test('keeps null on an optional field whose type admits null', () => {
    const schema = z.object({ either: z.union([z.string(), z.null()]).optional() });

    const tolerated = treatOptionalNullsAsAbsent(schema, { either: null });

    assert.deepEqual(tolerated, { either: null });
  });

  test('passes through a key the schema does not declare', () => {
    const schema = z.looseObject({ declared: z.string().optional() });

    const tolerated = treatOptionalNullsAsAbsent(schema, { declared: null, undeclared: null });

    assert.deepEqual(tolerated, { undeclared: null });
  });

  test('leaves a union-typed field alone rather than guessing an arm', () => {
    const schema = z.object({
      arm: z.union([z.object({ a: z.string().optional() }), z.object({ b: z.number().optional() })]).optional(),
    });

    const tolerated = treatOptionalNullsAsAbsent(schema, { arm: { a: null } });

    assert.deepEqual(tolerated, { arm: { a: null } });
  });
});

describe('treatOptionalNullsAsAbsent — traversal', () => {
  test('recurses through nested objects', () => {
    const schema = z.object({
      outer: z.object({ inner: z.object({ hint: z.string().optional(), kept: z.number().optional().nullable() }) }),
    });

    const tolerated = treatOptionalNullsAsAbsent(schema, {
      outer: { inner: { hint: null, kept: null } },
    });

    assert.deepEqual(tolerated, { outer: { inner: { kept: null } } });
    assert.equal(schema.safeParse(tolerated).success, true);
  });

  test('recurses through array entries', () => {
    const schema = z.object({ rows: z.array(z.object({ hint: z.string().optional(), id: z.string() })) });

    const tolerated = treatOptionalNullsAsAbsent(schema, {
      rows: [
        { id: 'a', hint: null },
        { id: 'b', hint: 'kept' },
      ],
    });

    assert.deepEqual(tolerated, { rows: [{ id: 'a' }, { id: 'b', hint: 'kept' }] });
    assert.equal(schema.safeParse(tolerated).success, true);
  });

  test('resolves a merged shape against the merged field set', () => {
    // by_package entries are DeliveryMetricsSchema.merge(package fields): a
    // nullable field from the base and an optional field from the overlay have
    // to resolve differently within the same object.
    const base = z.object({ completion_rate: z.number().optional().nullable() });
    const schema = base.merge(z.object({ package_id: z.string(), rate: z.number().optional() }));

    const tolerated = treatOptionalNullsAsAbsent(schema, {
      package_id: 'pkg_1',
      completion_rate: null,
      rate: null,
    });

    assert.deepEqual(tolerated, { package_id: 'pkg_1', completion_rate: null });
    assert.equal(schema.safeParse(tolerated).success, true);
  });

  test('resolves an intersection against both of its sides', () => {
    // JSON Schema `allOf` lands as a Zod intersection: the object shape on one
    // side, conditional requirements on the other.
    const schema = z
      .object({ hint: z.string().optional(), id: z.string() })
      .and(z.looseObject({ note: z.string().optional() }));

    const tolerated = treatOptionalNullsAsAbsent(schema, { id: 'a', hint: null, note: null });

    assert.deepEqual(tolerated, { id: 'a' });
    assert.equal(schema.safeParse(tolerated).success, true);
  });

  test('keeps a null the sides of an intersection disagree about', () => {
    const schema = z
      .object({ rate: z.number().optional() })
      .and(z.looseObject({ rate: z.number().optional().nullable() }));

    const tolerated = treatOptionalNullsAsAbsent(schema, { rate: null });

    assert.deepEqual(tolerated, { rate: null });
  });

  test('drops a null on a defaulted field so the default applies', () => {
    const schema = z.object({ max_results: z.number().default(50) });

    const tolerated = treatOptionalNullsAsAbsent(schema, { max_results: null });

    assert.deepEqual(tolerated, {});
    assert.equal(schema.parse(tolerated).max_results, 50);
  });

  test('keeps a null on a field whose catch swallows it', () => {
    // `.catch()` accepts null and substitutes its fallback, so null is a value
    // the field holds — not an absence.
    const schema = z.object({ hint: z.string().catch('fallback') });

    const tolerated = treatOptionalNullsAsAbsent(schema, { hint: null });

    assert.deepEqual(tolerated, { hint: null });
    assert.equal(schema.parse(tolerated).hint, 'fallback');
  });

  test('keeps a null on an optional field narrowed back to required', () => {
    const schema = z.object({ hint: z.string().optional().nonoptional() });

    const tolerated = treatOptionalNullsAsAbsent(schema, { hint: null });

    assert.deepEqual(tolerated, { hint: null });
    assert.equal(schema.safeParse(tolerated).success, false);
  });

  test('reaches an object shape through prefault, default and readonly wrappers', () => {
    const inner = z.object({ hint: z.string().optional(), keep: z.number().optional().nullable() });
    const wrapped = {
      prefaulted: inner.prefault({}),
      defaulted: inner.default({}),
      frozen: inner.readonly(),
    };

    for (const [label, field] of Object.entries(wrapped)) {
      const schema = z.object({ [label]: field });

      const tolerated = treatOptionalNullsAsAbsent(schema, { [label]: { hint: null, keep: null } });

      assert.deepEqual(tolerated, { [label]: { keep: null } }, label);
    }
  });

  test('leaves nulls inside a record alone', () => {
    // A record names no per-key declaration to resolve a null against.
    const schema = z.object({ ext: z.record(z.string(), z.object({ hint: z.string().optional() })) });
    const payload = { ext: { vendor: { hint: null } } };

    assert.equal(treatOptionalNullsAsAbsent(schema, payload), payload);
  });

  test('does not mutate the input payload', () => {
    const schema = z.object({ rows: z.array(z.object({ hint: z.string().optional(), id: z.string() })) });
    const payload = { rows: [{ id: 'a', hint: null }] };

    treatOptionalNullsAsAbsent(schema, payload);

    assert.deepEqual(payload, { rows: [{ id: 'a', hint: null }] });
  });

  test('returns the original nodes when there is nothing to reinterpret', () => {
    const schema = z.object({ rows: z.array(z.object({ id: z.string() })) });
    const payload = { rows: [{ id: 'a' }] };

    assert.equal(treatOptionalNullsAsAbsent(schema, payload), payload);
  });
});

describe('treatOptionalNullsAsAbsent — get_media_buy_delivery', () => {
  test('a null next_expected_at no longer discards the reported figures', () => {
    const response = deliveryResponse({ next_expected_at: null });

    assert.equal(GetMediaBuyDeliveryResponseSchema.safeParse(response).success, false);

    const tolerated = treatOptionalNullsAsAbsent(GetMediaBuyDeliveryResponseSchema, response);
    const parsed = GetMediaBuyDeliveryResponseSchema.safeParse(tolerated);

    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
    assert.equal(parsed.data.media_buy_deliveries.length, 1);
    assert.equal(parsed.data.media_buy_deliveries[0].totals.spend, 500);
    assert.equal(parsed.data.media_buy_deliveries[0].totals.impressions, 1000);
    assert.equal(parsed.data.media_buy_deliveries[0].by_package[0].spend, 500);
    assert.equal('next_expected_at' in tolerated, false);
  });

  test('a null completion_rate inside by_package survives as a value', () => {
    const response = deliveryResponse();
    response.media_buy_deliveries[0].by_package[0].completion_rate = null;

    const tolerated = treatOptionalNullsAsAbsent(GetMediaBuyDeliveryResponseSchema, response);
    const parsed = GetMediaBuyDeliveryResponseSchema.safeParse(tolerated);

    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
    assert.equal(parsed.data.media_buy_deliveries[0].by_package[0].completion_rate, null);
  });

  test('a null reporting_period still fails validation', () => {
    const response = deliveryResponse({ reporting_period: null });

    const tolerated = treatOptionalNullsAsAbsent(GetMediaBuyDeliveryResponseSchema, response);

    assert.equal(tolerated.reporting_period, null);
    assert.equal(GetMediaBuyDeliveryResponseSchema.safeParse(tolerated).success, false);
  });

  test('reaches the fields of a generated schema rooted in an intersection', () => {
    // Response schemas projected from a JSON Schema `allOf` are intersections
    // at their root; the envelope fields sit on one side of it.
    assert.equal(AcquireRightsResponseSchema.def.type, 'intersection');

    const tolerated = treatOptionalNullsAsAbsent(AcquireRightsResponseSchema, {
      context_id: null,
      status: 'completed',
    });

    assert.deepEqual(tolerated, { status: 'completed' });
  });
});
