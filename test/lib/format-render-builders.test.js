const { test } = require('node:test');
const assert = require('node:assert');
const { displayRender, parameterizedRender, templateRender, FormatRender } = require('../../dist/lib/index.js');

test('displayRender injects role + dimensions only (no parameters_from_format_id)', () => {
  const render = displayRender({
    role: 'primary',
    dimensions: { width: 300, height: 250 },
  });
  assert.deepStrictEqual(render, {
    role: 'primary',
    dimensions: { width: 300, height: 250 },
  });
  assert.ok(!('parameters_from_format_id' in render));
});

test('parameterizedRender auto-injects parameters_from_format_id: true', () => {
  const render = parameterizedRender({ role: 'primary' });
  assert.deepStrictEqual(render, {
    role: 'primary',
    parameters_from_format_id: true,
  });
  assert.ok(!('dimensions' in render));
});

test('displayRender supports non-pixel units (e.g. DOOH physical dimensions)', () => {
  // Schema's `dimension-unit` enum: 'px' | 'dp' | 'inches' | 'cm' | 'mm' | 'pt'
  const render = displayRender({
    role: 'primary',
    dimensions: { width: 12, height: 8, unit: 'inches' },
  });
  assert.strictEqual(render.dimensions.unit, 'inches');
});

test('templateRender is an alias for parameterizedRender', () => {
  // Same function reference — matches creative-template specialism terminology
  // without paying a second-factory cost.
  assert.strictEqual(templateRender, parameterizedRender);
  assert.deepStrictEqual(templateRender({ role: 'primary' }), {
    role: 'primary',
    parameters_from_format_id: true,
  });
});

test('FormatRender namespace exposes all three builders', () => {
  // One-dot autocomplete for callers constructing renders[] by hand.
  assert.strictEqual(FormatRender.display, displayRender);
  assert.strictEqual(FormatRender.parameterized, parameterizedRender);
  assert.strictEqual(FormatRender.template, templateRender);
});

test('renders satisfy the Format.renders[] oneOf at the shape level', () => {
  // Smoke-test the invariant: a valid renders[] item has EXACTLY ONE of
  // (dimensions present) XOR (parameters_from_format_id: true). These
  // builders enforce that invariant by construction.
  const dRender = displayRender({ role: 'primary', dimensions: { width: 300, height: 250 } });
  assert.ok('dimensions' in dRender);
  assert.ok(!('parameters_from_format_id' in dRender));

  const pRender = parameterizedRender({ role: 'primary' });
  assert.ok(!('dimensions' in pRender));
  assert.strictEqual(pRender.parameters_from_format_id, true);
});
