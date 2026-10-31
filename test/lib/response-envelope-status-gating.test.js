// adcp-client#3481: task-envelope fields are never stripped or filled in; the
// served release's published schema decides what a response must carry.
//
//   - A release that composes `core/protocol-envelope.json` into every task
//     response (3.3, and the 3.2.x backport) REQUIRES `status` on
//     `list_products` / `decline_proposals`, and every envelope field
//     validates.
//   - 3.2.x publishes those two arms without `status` (closed roots; the
//     decline success arm even says `not: required status`), so a conforming
//     3.2 response omits it and must keep validating.
//
// The 3.3 cases run against the pinned bundle once it composes the envelope.
// Until then, point `ADCP_COMPOSED_ENVELOPE_SCHEMA_ROOT` at an unpacked schema
// bundle built from adcontextprotocol/adcp#8547 (its `schemas/` directory) to
// run them against the composed contract.

const { describe, test } = require('node:test');
const assert = require('node:assert');
const { existsSync } = require('node:fs');

const { validateResponse } = require('../../dist/lib/validation/schema-validator.js');
const {
  acceptEnvelopeOnClosedResponseRootForVersion,
  responseSchemaComposesEnvelope,
  withExternalSchemaRoot,
} = require('../../dist/lib/validation/schema-loader.js');
const {
  omitsEnvelopeStatusForRelease,
  injectLegacyEnvelopeStatus,
} = require('../../dist/lib/utils/envelope-status-compat.js');
const { prepareResponseForSchemaValidation } = require('../../dist/lib/utils/response-schemas.js');
const { ADCP_VERSION } = require('../../dist/lib/version.js');

const CURRENT = ADCP_VERSION;
const LEGACY = '3.2.7';

const composedRoot = process.env.ADCP_COMPOSED_ENVELOPE_SCHEMA_ROOT;
const useComposedRoot = composedRoot !== undefined && existsSync(composedRoot);
const pinComposes = responseSchemaComposesEnvelope('list_products', CURRENT) === true;
const composedAvailable = useComposedRoot || pinComposes;
const skipComposed = composedAvailable
  ? false
  : 'the pinned bundle does not compose the protocol envelope yet; set ADCP_COMPOSED_ENVELOPE_SCHEMA_ROOT';

/** Run `fn` against the composed 3.3 contract: the pinned bundle, or the supplied root. */
function composed(fn) {
  return useComposedRoot ? withExternalSchemaRoot(CURRENT, composedRoot, fn) : fn();
}

const listProductsBody = { outcome: 'listed', products: [], feed_version: 'feed-v1', cache_scope: 'public' };
const declineBody = { results: [{ proposal_id: 'proposal-1', outcome: 'declined' }] };

function messages(result) {
  return result.issues.map(issue => `${issue.pointer} ${issue.keyword} ${issue.message}`).join('\n');
}

describe('a release that composes the envelope: status is required and preserved', { skip: skipComposed }, () => {
  for (const [tool, body] of [
    ['list_products', listProductsBody],
    ['decline_proposals', declineBody],
  ]) {
    test(`${tool} validates with status`, () => {
      composed(() => {
        const result = validateResponse(tool, { ...body, status: 'completed' }, CURRENT);
        assert.strictEqual(result.valid, true, messages(result));
      });
    });

    test(`${tool} without status is rejected, never filled in`, () => {
      composed(() => {
        const result = validateResponse(tool, body, CURRENT);
        assert.strictEqual(result.valid, false);
        assert.ok(
          result.issues.some(issue =>
            /status/.test(`${issue.pointer} ${issue.message} ${JSON.stringify(issue.params ?? {})}`)
          ),
          `expected a missing-status issue, got:\n${messages(result)}`
        );
      });
    });

    test(`${tool} accepts every envelope field alongside the body`, () => {
      composed(() => {
        const result = validateResponse(
          tool,
          {
            ...body,
            status: 'completed',
            // `task_id` is deliberately absent: the completed arm of
            // decline_proposals forbids it (it identifies an async submitted task).
            context_id: 'ctx-1',
            timestamp: '2026-11-03T12:00:00Z',
            replayed: false,
            // AdCP 3.3.0-beta.3 bounds a task-level message at 2000 characters (core/task-message.json).
            message: 'x'.repeat(2000),
            adcp_version: '3.3',
            context: { trace: 'abc' },
          },
          CURRENT
        );
        assert.strictEqual(result.valid, true, messages(result));
        const tooLong = validateResponse(tool, { ...body, status: 'completed', message: 'x'.repeat(2001) }, CURRENT);
        assert.strictEqual(tooLong.valid, false, 'a message longer than 2000 characters is refused');
      });
    });

    test(`${tool} is not status-free for that release`, () => {
      composed(() => {
        assert.strictEqual(omitsEnvelopeStatusForRelease(tool, CURRENT), false);
      });
    });
  }

  test('the Zod view for a 3.2 response is shown the status its schema implies, a composed release is not', () => {
    const viewed = prepareResponseForSchemaValidation('list_products', listProductsBody, LEGACY);
    // Only a Zod schema generated from a composing pin needs the completed status shown.
    assert.strictEqual(viewed.status, pinComposes ? 'completed' : undefined);
    assert.strictEqual(listProductsBody.status, undefined, 'the seller payload itself is untouched');
    composed(() => {
      assert.strictEqual(
        prepareResponseForSchemaValidation('list_products', listProductsBody, CURRENT).status,
        undefined
      );
    });
  });
});

describe('the shim never fills in status', () => {
  test('injectLegacyEnvelopeStatus leaves the compact sync tools alone at every release', () => {
    for (const toolName of ['list_products', 'decline_proposals', 'list_collections', 'list_proposals']) {
      for (const adcpVersion of [undefined, CURRENT, LEGACY]) {
        const out = injectLegacyEnvelopeStatus({ ...listProductsBody }, { toolName, adcpVersion });
        assert.strictEqual(out.status, undefined, `${toolName} @ ${adcpVersion}`);
      }
    }
  });

  test('a 3.0 payload that declares itself 3.0 still gets the documented back-compat status', () => {
    const out = injectLegacyEnvelopeStatus({ adcp_version: '3.0', products: [] }, { toolName: 'get_products' });
    assert.strictEqual(out.status, 'completed');
  });
});

describe('3.2.x serves the published arms without status: they keep validating', () => {
  for (const [tool, body] of [
    ['list_products', listProductsBody],
    ['decline_proposals', declineBody],
  ]) {
    test(`${tool} validates without status`, () => {
      const result = validateResponse(tool, body, LEGACY);
      assert.strictEqual(result.valid, true, messages(result));
    });

    test(`${tool} is status-free for 3.2.x`, () => {
      for (const version of ['3.2', '3.2.1', '3.2.7']) {
        assert.strictEqual(omitsEnvelopeStatusForRelease(tool, version), true, version);
      }
    });
  }

  test('a closed 3.2 root accepts the envelope fields its release defines, but not body typos', () => {
    const ok = validateResponse(
      'list_products',
      // 3.2.7 pins `replayed: const true` locally on this arm; a local declaration is
      // validated as published, so use the value that release accepts.
      { ...listProductsBody, task_id: 'task-1', replayed: true, adcp_version: '3.2' },
      LEGACY
    );
    assert.strictEqual(ok.valid, true, messages(ok));

    const typo = validateResponse('list_products', { ...listProductsBody, produts_typo: [] }, LEGACY);
    assert.strictEqual(typo.valid, false, 'a body field the release does not define must still be rejected');
  });

  test('other tools and unknown releases keep status', () => {
    for (const tool of ['list_collections', 'list_proposals', 'get_products', 'check_governance']) {
      assert.strictEqual(omitsEnvelopeStatusForRelease(tool, LEGACY), false, tool);
    }
    assert.strictEqual(omitsEnvelopeStatusForRelease('list_products', undefined), false);
  });
});

describe('envelope handling in the schema loader', () => {
  test('a bundle that composes the envelope is validated exactly as published', () => {
    const composedSchema = {
      $id: 'urn:test:composed',
      allOf: [{ title: 'Protocol Envelope', properties: { status: { type: 'string' } } }],
      additionalProperties: false,
      properties: { body: { type: 'string' } },
    };
    assert.strictEqual(acceptEnvelopeOnClosedResponseRootForVersion(composedSchema, LEGACY), composedSchema);
  });

  test('a closed root that does not compose it gains only the release envelope fields', () => {
    const closed = {
      $id: 'urn:test:closed',
      type: 'object',
      additionalProperties: false,
      properties: { body: { type: 'string' }, task_id: { const: 'local' } },
    };
    const widened = acceptEnvelopeOnClosedResponseRootForVersion(closed, LEGACY);
    assert.notStrictEqual(widened, closed);
    assert.strictEqual(widened.additionalProperties, false, 'the root stays closed');
    assert.ok(widened.properties.status && widened.properties.replayed && widened.properties.adcp_version);
    assert.deepStrictEqual(widened.properties.task_id, { const: 'local' }, 'a local declaration is left as authored');
    assert.deepStrictEqual(
      closed.properties,
      { body: { type: 'string' }, task_id: { const: 'local' } },
      'input is not mutated'
    );
  });

  test('3.2.7 does not compose the envelope; unknown tools have no answer', () => {
    assert.strictEqual(responseSchemaComposesEnvelope('list_products', LEGACY), false);
    assert.strictEqual(responseSchemaComposesEnvelope('definitely_not_a_tool', LEGACY), undefined);
  });
});
