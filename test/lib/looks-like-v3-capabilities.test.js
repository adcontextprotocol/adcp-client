// Unit tests for the v3-shape detection heuristic used by SingleAgentClient
// to decide whether a failed get_adcp_capabilities response is a v3 wire-shape
// bug (continue as v3) or genuinely v2 (fall back). See issue #1189.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { looksLikeV3Capabilities, parseCapabilitiesResponse } = require('../../dist/lib/utils/capabilities');

describe('looksLikeV3Capabilities', () => {
  describe('returns true for v3-shaped responses', () => {
    it('detects adcp envelope block', () => {
      assert.equal(looksLikeV3Capabilities({ adcp: { major_versions: [3] } }), true);
    });

    it('detects supported_protocols array', () => {
      assert.equal(looksLikeV3Capabilities({ supported_protocols: ['signals'] }), true);
    });

    it('detects empty supported_protocols array (still a v3 signal — the field exists)', () => {
      assert.equal(looksLikeV3Capabilities({ supported_protocols: [] }), true);
    });

    it('detects account block', () => {
      assert.equal(looksLikeV3Capabilities({ account: { require_operator_auth: true } }), true);
    });

    it('detects media_buy block', () => {
      assert.equal(looksLikeV3Capabilities({ media_buy: { features: {} } }), true);
    });

    it('detects signals block', () => {
      assert.equal(looksLikeV3Capabilities({ signals: { catalog_signals: true } }), true);
    });

    it('detects creative block', () => {
      assert.equal(looksLikeV3Capabilities({ creative: { supports_compliance: true } }), true);
    });

    it('detects brand block', () => {
      assert.equal(looksLikeV3Capabilities({ brand: { rights: true } }), true);
    });

    it('detects governance block', () => {
      assert.equal(looksLikeV3Capabilities({ governance: { spend_authority: true } }), true);
    });

    it('detects sponsored_intelligence block', () => {
      assert.equal(looksLikeV3Capabilities({ sponsored_intelligence: { offerings: [] } }), true);
    });

    it('detects compliance_testing block', () => {
      assert.equal(looksLikeV3Capabilities({ compliance_testing: { scenarios: [] } }), true);
    });

    it('detects partial response with v3-shape — the case matrix v2 surfaced', () => {
      // Failed-validation response from a v3 agent missing one required field.
      // Falling back to v2 here is what issue #1189 fixes.
      assert.equal(
        looksLikeV3Capabilities({
          adcp: { major_versions: [3] },
          supported_protocols: ['signals'],
          account: { require_operator_auth: true /* supported_billing missing */ },
        }),
        true
      );
    });
  });

  describe('returns false for non-v3-shaped or empty inputs', () => {
    it('rejects null', () => {
      assert.equal(looksLikeV3Capabilities(null), false);
    });

    it('rejects undefined', () => {
      assert.equal(looksLikeV3Capabilities(undefined), false);
    });

    it('rejects empty object', () => {
      assert.equal(looksLikeV3Capabilities({}), false);
    });

    it('rejects array', () => {
      assert.equal(looksLikeV3Capabilities([]), false);
    });

    it('rejects string', () => {
      assert.equal(looksLikeV3Capabilities('v3'), false);
    });

    it('rejects number', () => {
      assert.equal(looksLikeV3Capabilities(42), false);
    });

    it('rejects object with only unknown fields', () => {
      assert.equal(looksLikeV3Capabilities({ foo: 'bar', baz: 1 }), false);
    });

    it('rejects supported_protocols when not an array (malformed)', () => {
      assert.equal(looksLikeV3Capabilities({ supported_protocols: 'signals' }), false);
    });

    it('rejects v3 block when null (defensive)', () => {
      assert.equal(looksLikeV3Capabilities({ media_buy: null }), false);
    });

    it('rejects adcp when null (defensive)', () => {
      assert.equal(looksLikeV3Capabilities({ adcp: null }), false);
    });

    it('rejects adcp when array (typeof object would otherwise pass)', () => {
      assert.equal(looksLikeV3Capabilities({ adcp: [] }), false);
    });

    it('rejects v3 block when array (typeof object would otherwise pass)', () => {
      assert.equal(looksLikeV3Capabilities({ media_buy: [] }), false);
    });
  });

  describe('parser handoff — when heuristic returns true, downstream callers must see version: v3', () => {
    // Regression for the bug code-reviewer caught on PR #1201:
    // parseCapabilitiesResponse defaults majorVersions: [2] when response.adcp
    // is missing. SingleAgentClient.getCapabilities forces version: 'v3' after
    // parse when the heuristic confirmed v3-shape; this test pins the bug at
    // the parser layer so future contributors don't accidentally remove the
    // override and re-introduce v2 mis-classification.

    it('parser returns version: v2 when only supported_protocols is present (the bug)', () => {
      // This is the specific failure mode — the parser alone does NOT know
      // about the heuristic. Callers that rely on parser-only output for
      // version detection see v2, not v3. Documents the constraint that
      // motivated the override in SingleAgentClient.getCapabilities.
      const parsed = parseCapabilitiesResponse({ supported_protocols: ['signals'] });
      assert.equal(parsed.version, 'v2');
      assert.deepStrictEqual(parsed.majorVersions, [2]);
    });

    it('parser returns version: v3 when adcp.major_versions is explicit', () => {
      const parsed = parseCapabilitiesResponse({
        adcp: { major_versions: [3] },
        supported_protocols: ['signals'],
      });
      assert.equal(parsed.version, 'v3');
      assert.deepStrictEqual(parsed.majorVersions, [3]);
    });
  });
});
