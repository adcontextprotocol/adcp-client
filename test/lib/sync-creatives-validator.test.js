const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  SyncCreativesItemSchema,
  SyncCreativesSuccessStrictSchema,
  SyncCreativesResponseStrictSchema,
} = require('../../dist/lib/validation/sync-creatives.js');

describe('SyncCreativesItemSchema', () => {
  const base = { creative_id: 'cr_1', action: 'created' };

  test('accepts minimal required shape', () => {
    const r = SyncCreativesItemSchema.safeParse(base);
    assert.equal(r.success, true, r.success ? '' : JSON.stringify(r.error.issues));
  });

  test('rejects missing creative_id', () => {
    const r = SyncCreativesItemSchema.safeParse({ action: 'created' });
    assert.equal(r.success, false);
  });

  test('rejects unknown action enum', () => {
    const r = SyncCreativesItemSchema.safeParse({ creative_id: 'cr_1', action: 'weird' });
    assert.equal(r.success, false);
  });

  test('forbids status when action=failed', () => {
    const r = SyncCreativesItemSchema.safeParse({ ...base, action: 'failed', status: 'approved' });
    assert.equal(r.success, false);
    assert.ok(r.error.issues.some(i => i.path.includes('status')));
  });

  test('forbids status when action=deleted', () => {
    const r = SyncCreativesItemSchema.safeParse({ ...base, action: 'deleted', status: 'archived' });
    assert.equal(r.success, false);
  });

  test('allows status on action=created', () => {
    const r = SyncCreativesItemSchema.safeParse({ ...base, status: 'approved' });
    assert.equal(r.success, true);
  });

  test('rejects javascript: preview_url', () => {
    const r = SyncCreativesItemSchema.safeParse({
      ...base,
      preview_url: 'javascript:alert(1)',
    });
    assert.equal(r.success, false);
  });

  test('accepts https preview_url', () => {
    const r = SyncCreativesItemSchema.safeParse({
      ...base,
      preview_url: 'https://example.com/preview',
    });
    assert.equal(r.success, true);
  });

  test('rejects malformed expires_at', () => {
    const r = SyncCreativesItemSchema.safeParse({ ...base, expires_at: 'not-a-date' });
    assert.equal(r.success, false);
  });

  test('accepts ISO-8601 expires_at', () => {
    const r = SyncCreativesItemSchema.safeParse({ ...base, expires_at: '2026-04-20T00:00:00Z' });
    assert.equal(r.success, true);
  });

  test('rejects assignment_errors key with disallowed characters', () => {
    const r = SyncCreativesItemSchema.safeParse({
      ...base,
      assignment_errors: { 'pkg/1': 'boom' },
    });
    assert.equal(r.success, false);
  });

  test('accepts valid assignment_errors keys', () => {
    const r = SyncCreativesItemSchema.safeParse({
      ...base,
      assignment_errors: { pkg_1: 'boom', 'pkg-2': 'oof' },
    });
    assert.equal(r.success, true);
  });

  test('passes through unknown top-level keys', () => {
    const r = SyncCreativesItemSchema.safeParse({ ...base, vendor_extension: { foo: 'bar' } });
    assert.equal(r.success, true);
  });
});

describe('SyncCreativesSuccessStrictSchema', () => {
  test('accepts success with empty creatives array', () => {
    const r = SyncCreativesSuccessStrictSchema.safeParse({ creatives: [] });
    assert.equal(r.success, true);
  });

  test('rejects when any per-item entry is invalid', () => {
    const r = SyncCreativesSuccessStrictSchema.safeParse({
      creatives: [{ creative_id: 'cr_1', action: 'failed', status: 'approved' }],
    });
    assert.equal(r.success, false);
  });
});

describe('SyncCreativesResponseStrictSchema', () => {
  test('accepts error branch', () => {
    const r = SyncCreativesResponseStrictSchema.safeParse({
      errors: [{ code: 'E1', message: 'boom' }],
    });
    assert.equal(r.success, true, r.success ? '' : JSON.stringify(r.error.issues));
  });

  test('accepts submitted branch', () => {
    const r = SyncCreativesResponseStrictSchema.safeParse({
      status: 'submitted',
      task_id: 'task_123',
    });
    assert.equal(r.success, true, r.success ? '' : JSON.stringify(r.error.issues));
  });
});
