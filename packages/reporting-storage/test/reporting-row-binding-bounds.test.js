/**
 * `row_binding_id` and `credentialRef` follow AdCP's identifier bound, 1 to 255 characters of `A-Za-z0-9_.:-`
 * (adcp-client#3282), in the options a host passes, the provider client maps and the exported constants.
 */
const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const ledger = require('./helpers/ledger.js');
const { createS3ReportingRowObjectProviderV1 } = require('@adcp/reporting-storage/s3');

const provider = {
  name: 'stub',
  rangedReads: false,
  validateLocation() {},
  async probe() {},
  async putIfAbsent() {
    throw new Error('not used');
  },
  async get() {
    return null;
  },
  async delete() {
    return 'absent';
  },
};
const objectBinding = extra => ({ kind: 'object', provider: 'stub', location: {}, prefix: 'rows', ...extra });
const storage = bindings =>
  new ledger.ReportingRowStorageV1({ query: async () => ({ rows: [] }) }, { bindings, providers: { stub: provider } });
const id = length => 'b'.repeat(length);

describe('row binding identifier bounds', () => {
  test('the bound is the AdCP identifier bound, 255, exported for hosts', () => {
    assert.equal(ledger.REPORTING_ROW_BINDING_ID_MAX_LENGTH, 255);
    assert.equal(ledger.REPORTING_ROW_CREDENTIAL_REF_MAX_LENGTH, 255);
  });

  test('a binding ID of 1 to 255 characters of A-Za-z0-9_.:- is accepted', () => {
    for (const accepted of ['x', id(128), id(129), id(255), `A_b.c:d-${id(247)}`]) {
      assert.doesNotThrow(() => storage({ [accepted]: objectBinding() }), accepted.length);
    }
  });

  test('a longer, empty or ill-formed binding ID is refused, and the message names the bound', () => {
    for (const refused of [id(256), id(1000), '', 'has space', 'slash/id', 'é', `${id(10)}\n`]) {
      assert.throws(
        () => storage({ [refused]: objectBinding() }),
        error => error.code === 'INVALID_INPUT' && /1 to 255 characters of A-Za-z0-9_\.:-/.test(error.message),
        JSON.stringify(refused).slice(0, 20)
      );
    }
    // A very long ID is not echoed whole.
    assert.throws(
      () => storage({ [id(5000)]: objectBinding() }),
      error => error.message.length < 300
    );
  });

  test('a credentialRef follows the same bound', () => {
    for (const accepted of ['tenant-eu', id(128), id(129), id(255)]) {
      assert.doesNotThrow(() => storage({ objects: objectBinding({ credentialRef: accepted }) }));
    }
    for (const refused of [id(256), '', 'has space', 'a/b']) {
      assert.throws(
        () => storage({ objects: objectBinding({ credentialRef: refused }) }),
        error => error.code === 'INVALID_INPUT' && /invalid credentialRef: use 1 to 255 characters/.test(error.message)
      );
    }
  });

  test('a provider clients map accepts the same credential references a binding can name', () => {
    const client = { send() {} };
    assert.doesNotThrow(() => createS3ReportingRowObjectProviderV1({ client, clients: { [id(255)]: client } }));
    assert.throws(
      () => createS3ReportingRowObjectProviderV1({ client, clients: { [id(256)]: client } }),
      error => error.code === 'INVALID_INPUT'
    );
  });
});
