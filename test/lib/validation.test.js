// Unit tests for validation utilities
const { test, describe } = require('node:test');
const assert = require('node:assert');

// Import validation functions
const { validateAgentUrl, validateAdCPResponse, getExpectedSchema } = require('../../dist/lib/validation/index.js');

describe('validation utilities', () => {
  describe('validateAgentUrl', () => {
    test('should accept valid HTTPS URLs', () => {
      assert.doesNotThrow(() => {
        validateAgentUrl('https://agent.example.com/mcp/');
      });
    });

    test('should accept valid HTTP URLs', () => {
      assert.doesNotThrow(() => {
        validateAgentUrl('http://agent.example.com');
      });
    });

    test('should reject invalid protocols', () => {
      assert.throws(() => {
        validateAgentUrl('ftp://agent.example.com');
      }, /Protocol 'ftp:' not allowed \(only HTTP\/HTTPS\)/);
    });

    test('should reject excessively long URLs', () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(3000);
      assert.throws(() => {
        validateAgentUrl(longUrl);
      }, /Agent URL is too long \(max 2048 characters\)/);
    });

    test('should reject invalid URL format', () => {
      assert.throws(() => {
        validateAgentUrl('not-a-url');
      }, /Invalid agent URL/);
    });

    describe('private-network and metadata policy', () => {
      // Delegates to `classifyProbeUrl`, so agent URLs and discovery probes
      // share one policy. Deliberately NOT keyed on NODE_ENV — a staging image
      // running NODE_ENV=test must not get a looser SSRF posture than prod.
      // The `ADCP_ALLOW_INTERNAL_PROBES` opt-out is read once at module load,
      // so the widened branch isn't reachable from inside this process; the
      // default-deny behaviour below is what matters.

      // Loopback stays allowed: CLI dev loops, the mock server, and local
      // adapter tests all target it, and abusing it already requires on-host
      // access. This is the case that a blanket private-network refusal broke.
      const allowedLoopback = [
        ['loopback literal', 'http://127.0.0.1:3000/mcp'],
        ['non-.1 loopback literal', 'http://127.0.0.2:3000/mcp'],
        ['loopback name', 'http://localhost:8080/mcp'],
        ['bracketed IPv6 loopback', 'http://[::1]:3000/mcp'],
      ];

      for (const [label, url] of allowedLoopback) {
        test(`allows ${label}`, () => {
          assert.doesNotThrow(() => validateAgentUrl(url));
        });
      }

      const blockedPrivate = [
        ['RFC 1918 /8', 'https://10.1.2.3/mcp'],
        ['RFC 1918 /16', 'https://192.168.1.1/mcp'],
        ['RFC 1918 /12', 'https://172.16.0.1/mcp'],
        ['CGNAT', 'https://100.64.0.1/mcp'],
        ['IPv4-mapped IPv6 private', 'https://[::ffff:10.0.0.1]/mcp'],
      ];

      for (const [label, url] of blockedPrivate) {
        test(`refuses ${label} by default`, () => {
          assert.throws(() => validateAgentUrl(url), /not allowed/);
        });
      }

      // Refused even with the opt-out set — IMDS reach is never legitimate.
      test('refuses the cloud metadata address', () => {
        assert.throws(() => validateAgentUrl('https://169.254.169.254/latest/meta-data/'), /not allowed/);
      });

      test('refuses IPv4 link-local', () => {
        assert.throws(() => validateAgentUrl('https://169.254.1.1/mcp'), /not allowed/);
      });

      // The old hand-rolled prefix comparisons matched these as private.
      test('does not treat registered names sharing a private prefix as private', () => {
        assert.doesNotThrow(() => validateAgentUrl('https://10.example.com/mcp'));
        assert.doesNotThrow(() => validateAgentUrl('https://127.example.com/mcp'));
        assert.doesNotThrow(() => validateAgentUrl('https://192.168.example.com/mcp'));
      });

      test('public URLs are unaffected', () => {
        assert.doesNotThrow(() => validateAgentUrl('https://agent.example.com/mcp/'));
      });

      // The old gate did nothing at all unless NODE_ENV was exactly
      // 'production', so an unset or misspelled value disabled it entirely.
      test('enforces regardless of NODE_ENV', () => {
        const prior = process.env.NODE_ENV;
        try {
          for (const value of [undefined, 'production', 'test', 'development', 'staging']) {
            if (value === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = value;
            assert.throws(
              () => validateAgentUrl('https://169.254.169.254/latest/meta-data/'),
              /not allowed/,
              `metadata must be refused with NODE_ENV=${String(value)}`
            );
          }
        } finally {
          if (prior === undefined) delete process.env.NODE_ENV;
          else process.env.NODE_ENV = prior;
        }
      });
    });
  });

  describe('getExpectedSchema', () => {
    test('should return correct schema for get_products', () => {
      assert.strictEqual(getExpectedSchema('get_products'), 'products');
    });

    test('should return correct schema for list_creative_formats', () => {
      assert.strictEqual(getExpectedSchema('list_creative_formats'), 'formats');
    });

    test('should return correct schema for manage_creative_assets', () => {
      assert.strictEqual(getExpectedSchema('manage_creative_assets'), 'creative_management');
    });

    test('should return correct schema for sync_creatives', () => {
      assert.strictEqual(getExpectedSchema('sync_creatives'), 'sync_response');
    });

    test('should return correct schema for list_creatives', () => {
      assert.strictEqual(getExpectedSchema('list_creatives'), 'creative_list');
    });

    test('should return correct schema for add_creative_assets', () => {
      assert.strictEqual(getExpectedSchema('add_creative_assets'), 'creative_upload');
    });

    test('should return generic schema for unknown tools', () => {
      assert.strictEqual(getExpectedSchema('unknown_tool'), 'generic');
      assert.strictEqual(getExpectedSchema(''), 'generic');
    });
  });

  describe('validateAdCPResponse', () => {
    test('should reject null or undefined responses', () => {
      const result1 = validateAdCPResponse(null, 'products');
      assert.strictEqual(result1.valid, false);
      assert.ok(result1.errors.includes('Response is not a valid object'));

      const result2 = validateAdCPResponse(undefined, 'products');
      assert.strictEqual(result2.valid, false);
      assert.ok(result2.errors.includes('Response is not a valid object'));
    });

    test('should reject non-object responses', () => {
      const result1 = validateAdCPResponse('string', 'products');
      assert.strictEqual(result1.valid, false);
      assert.ok(result1.errors.includes('Response is not a valid object'));

      const result2 = validateAdCPResponse(123, 'products');
      assert.strictEqual(result2.valid, false);
      assert.ok(result2.errors.includes('Response is not a valid object'));
    });

    test('should validate products schema correctly', () => {
      // Valid products response
      const validResponse = {
        products: [
          {
            id: 'product-1',
            name: 'Test Product',
            pricing_model: 'cpm',
          },
        ],
      };

      const result = validateAdCPResponse(validResponse, 'products');
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    test('should reject invalid products schema', () => {
      // Missing products array
      const invalidResponse1 = {
        items: [],
      };

      const result1 = validateAdCPResponse(invalidResponse1, 'products');
      assert.strictEqual(result1.valid, false);
      assert.ok(result1.errors.includes('Missing or invalid products array'));

      // Products array with missing required fields
      const invalidResponse2 = {
        products: [
          {
            name: 'Test Product',
            // Missing id and pricing_model
          },
        ],
      };

      const result2 = validateAdCPResponse(invalidResponse2, 'products');
      assert.strictEqual(result2.valid, false);
      assert.ok(result2.errors.some(error => error.includes('Missing id field')));
      assert.ok(result2.errors.some(error => error.includes('Missing pricing_model field')));
    });

    test('should validate formats schema correctly', () => {
      // Valid formats response
      const validResponse1 = {
        formats: [
          {
            format_id: 'banner_300x250',
            name: 'Medium Rectangle',
          },
        ],
      };

      const result1 = validateAdCPResponse(validResponse1, 'formats');
      assert.strictEqual(result1.valid, true);

      // Alternative valid formats response
      const validResponse2 = {
        creative_formats: [
          {
            format_id: 'banner_728x90',
            name: 'Leaderboard',
          },
        ],
      };

      const result2 = validateAdCPResponse(validResponse2, 'formats');
      assert.strictEqual(result2.valid, true);
    });

    test('should reject invalid formats schema', () => {
      const invalidResponse = {
        other_data: [],
      };

      const result = validateAdCPResponse(invalidResponse, 'formats');
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.includes('Missing formats/creative_formats array'));
    });

    test('should accept generic schemas without specific validation', () => {
      const response = {
        any_field: 'any_value',
        numbers: [1, 2, 3],
      };

      const result = validateAdCPResponse(response, 'generic');
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    test('should handle unknown schemas gracefully', () => {
      const response = {
        data: 'some data',
      };

      const result = validateAdCPResponse(response, 'unknown_schema');
      assert.strictEqual(result.valid, true); // No specific validation for unknown schemas
      assert.strictEqual(result.errors.length, 0);
    });

    test('should validate empty products array as valid', () => {
      const response = {
        products: [],
      };

      const result = validateAdCPResponse(response, 'products');
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });
  });
});
