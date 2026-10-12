const { test } = require('node:test');
const assert = require('node:assert/strict');

// AdCP 3.2.4 composes CompactTaskSubmitted from the shared version/protocol envelopes. The public
// validators stay ZodObjects (see postProcessCompactTaskSubmittedEnvelope) and must accept and reject
// exactly what the canonical `allOf` intersection does.
test('CompactTaskSubmitted validators stay ZodObjects equivalent to the canonical allOf intersection', async () => {
  const schemas = await import('../../dist/lib/types/schemas.generated.js');
  const { z } = await import('zod');
  const compact = schemas.CompactTaskSubmittedSchema;

  for (const schema of [
    compact,
    schemas.RequestProposalsAsyncSubmittedSchema,
    schemas.RefineProposalsAsyncSubmittedSchema,
  ]) {
    assert.equal(schema, compact, 'proposal submitted schemas alias the compact schema');
    for (const key of ['status', 'task_id', 'message', 'errors', 'context', 'ext', 'adcp_version', 'timestamp']) {
      assert.ok(schema.shape[key], `shape exposes ${key}`);
    }
    for (const helper of ['extend', 'pick', 'omit', 'partial']) assert.equal(typeof schema[helper], 'function', helper);
  }
  const extended = compact.extend({ tenant: z.string() });
  assert.equal(extended.safeParse({ status: 'submitted', task_id: 't1', tenant: 'a' }).success, true);
  assert.equal(extended.safeParse({ status: 'submitted', task_id: 't1' }).success, false);
  assert.equal(compact.pick({ task_id: true }).safeParse({ task_id: 't1' }).success, true);

  // Reference: the intersection the schema was before this projection, built from the same arms.
  const arms = compact.pick({ status: true, task_id: true, message: true, errors: true, context: true, ext: true });
  const reference = schemas.AdCPVersionEnvelopeSchema.merge(schemas.ProtocolEnvelopeSchema).and(arms.passthrough());

  const base = { status: 'submitted', task_id: 't1' };
  const variants = {
    status: ['submitted', 'working', 'completed', 'rejected', 'bogus', 1, null, undefined],
    task_id: [undefined, '', 'x', 1, null],
    message: [undefined, '', 'a'.repeat(2000), 'a'.repeat(2001), 1],
    errors: [undefined, [], [{ code: 'X', message: 'm' }], [{}], 'x'],
    context: [undefined, {}, { a: 1 }, 'x', null],
    ext: [undefined, {}, 'x'],
    adcp_version: [undefined, '3.2', 'x', 3],
    adcp_major_version: [undefined, 3, 0, 100, '3'],
    context_id: [undefined, 'c', 1],
    timestamp: [undefined, '2026-10-12T00:00:00Z', 'nope'],
    replayed: [undefined, true, 'yes'],
    adcp_error: [undefined, { code: 'X', message: 'm' }, 'x'],
    governance_context: [undefined, 'abc', '', 'a'.repeat(5000)],
    payload: [undefined, {}, 'x'],
    unknown_extra: [undefined, 1],
  };
  const outcome = result =>
    result.success
      ? { ok: true, data: result.data }
      : { ok: false, paths: [...new Set(result.error.issues.map(issue => issue.path.join('.')))].sort() };
  const inputs = [base, {}, 'x', null, []];
  for (const [key, values] of Object.entries(variants)) {
    for (const value of values) {
      const input = { ...base };
      if (value === undefined) delete input[key];
      else input[key] = value;
      inputs.push(input);
    }
  }
  for (const input of inputs) {
    assert.deepEqual(outcome(compact.safeParse(input)), outcome(reference.safeParse(input)), JSON.stringify(input));
  }
});
