const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Ajv = require('ajv');
const { evaluate } = require('../../dist/lib/conformance/oracle.js');
const { loadResponseSchema } = require('../../dist/lib/conformance/schemaLoader.js');

function findVersionEnvelope(node) {
  if (node.$id?.endsWith('/core/version-envelope.json')) return node;
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    for (const branch of node[keyword] ?? []) {
      const found = findVersionEnvelope(branch);
      if (found) return found;
    }
  }
}

for (const additionalProperties of [false, true]) {
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    test(`conformance validates canonical versions in ${additionalProperties ? 'open' : 'closed'} ${keyword} branches`, t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-conformance-composition-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const write = (name, schema) => {
        const file = path.join(root, 'bundled', name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(schema));
      };
      const envelope = findVersionEnvelope(loadResponseSchema('get_adcp_capabilities'));
      assert.ok(envelope, 'the packaged discovery schema contains the canonical version envelope');
      write('core/version-envelope.json', envelope);
      const closed = {
        type: 'object',
        additionalProperties,
        required: ['results'],
        properties: {
          // Existing narrower declarations must take precedence over the envelope.
          adcp_major_version: { const: 3 },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['proposal_id'],
              properties: { proposal_id: { type: 'string' } },
            },
          },
        },
      };
      write('media-buy/decline-proposals-response.json', { ...closed, [keyword]: [closed] });
      const schema = loadResponseSchema('decline_proposals', { schemaRoot: root });
      const validate = new Ajv({ strict: false }).compile(schema);
      const valid = { adcp_version: '3.2', adcp_major_version: 3, results: [{ proposal_id: 'proposal-1' }] };
      assert.equal(validate(valid), true, JSON.stringify(validate.errors));
      for (const invalid of [
        { ...valid, adcp_version: 'invalid' },
        { ...valid, adcp_version: '3.2.8' },
        { ...valid, adcp_version: 3.2 },
        { ...valid, adcp_major_version: '3' },
        { ...valid, adcp_major_version: 4 },
        { adcp_version: '3.2' },
        { ...valid, results: [{ proposal_id: 'proposal-1', adcp_version: '3.2' }] },
        { ...valid, results: [{}] },
      ]) {
        assert.equal(validate(invalid), false, JSON.stringify(invalid));
        assert.equal(
          evaluate({
            tool: 'decline_proposals',
            request: {},
            result: { success: true, status: 'completed', data: invalid },
            schemas: { schemaRoot: root },
          }).verdict,
          'invalid',
          JSON.stringify(invalid)
        );
      }
      assert.equal(validate({ ...valid, unexpected: true }), additionalProperties);
      assert.deepEqual(schema.required, ['results']);
      assert.equal(schema.additionalProperties, additionalProperties);
    });
  }
}
