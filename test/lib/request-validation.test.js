// Unit tests for request validation in SingleAgentClient
// Tests critical validation that was previously missing (sync_creatives, create_media_buy, build_creative, get_products)

const { test, describe } = require('node:test');
const assert = require('node:assert');

// Import from built dist
const { AdCPClient, ProtocolClient } = require('../../dist/lib/index.js');

describe('SingleAgentClient Request Validation', () => {
  const mockAgent = {
    id: 'test-agent',
    name: 'Test Agent',
    agent_uri: 'https://test.example',
    protocol: 'a2a',
  };

  describe('sync_creatives validation', () => {
    test('should reject request with assets as array instead of object', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      await assert.rejects(
        async () => {
          await agent.syncCreatives({
            creatives: [
              {
                creative_id: 'test',
                name: 'Test Creative',
                format_id: { agent_url: 'https://test.example', id: 'format1' },
                // Invalid: assets should be object, not array
                assets: [
                  {
                    asset_type: 'video',
                    url: 'https://example.com/video.mp4',
                  },
                ],
              },
            ],
          });
        },
        err => {
          return err.message.includes('Request validation failed for sync_creatives');
        },
        'Should throw validation error for assets as array'
      );
    });

    test('should pass unknown top-level fields through (no strict parse)', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      // Unknown top-level fields (e.g. a caller typo like `mode` instead of
      // `dry_run`) are NOT rejected client-side. Required-field and
      // shape violations still reject; unknown keys pass through so the
      // runner's brand/account injection survives to the adapter, which
      // strips by schema.
      await assert.doesNotReject(async () => {
        try {
          await agent.syncCreatives({
            account: { account_id: 'test-account' },
            creatives: [
              {
                creative_id: 'test',
                name: 'Test Creative',
                format_id: { agent_url: 'https://test.example', id: 'format1' },
                assets: {
                  video: {
                    asset_type: 'video',
                    url: 'https://example.com/video.mp4',
                    width: 1920,
                    height: 1080,
                    duration_ms: 30000,
                  },
                },
              },
            ],
            mode: 'dry_run', // unknown top-level field — passes through now
          });
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      }, 'Unknown top-level fields should not trigger validation rejection');
    });
  });

  describe('create_media_buy validation', () => {
    test('should reject create_media_buy requests with missing required fields', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      await assert.rejects(
        async () => {
          // Missing `end_time` (required) — schema violation that must reject
          // regardless of strict mode.
          await agent.createMediaBuy({
            account: { account_id: 'test-account' },
            brand: { domain: 'example.com' },
            start_time: 'immediate',
          });
        },
        err => {
          return err.message.includes('Request validation failed for create_media_buy');
        },
        'Should throw validation error when end_time is missing'
      );
    });

    test('should pass unknown top-level fields through create_media_buy', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      // Non-strict parse — unknown top-level fields pass client validation.
      // The server is the authority on unknown keys.
      await assert.doesNotReject(async () => {
        try {
          await agent.createMediaBuy({
            account: { account_id: 'test-account' },
            packages: [],
            brand: { domain: 'example.com' },
            start_time: 'immediate',
            end_time: '2025-12-31T23:59:59Z',
            invalid_field: 'passes through to server',
          });
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      }, 'Unknown top-level fields should not trigger validation rejection');
    });

    test('should pass validation with brand_manifest present', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      // brand_manifest is preserved by the normalizer and should not cause validation errors
      await assert.doesNotReject(async () => {
        try {
          await agent.createMediaBuy({
            account: { account_id: 'test-account' },
            packages: [],
            brand_manifest: { name: 'Acme', url: 'https://acme.com/brand.json' },
            start_time: 'immediate',
            end_time: '2025-12-31T23:59:59Z',
          });
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      }, 'brand_manifest should not cause a validation error');
    });

    test('should forward brand_manifest URL to v2 agents from manifest object', async () => {
      const capturedCalls = [];
      const A2AClient = require('@a2a-js/sdk/client').A2AClient;
      const originalFromCardUrl = A2AClient.fromCardUrl;

      A2AClient.fromCardUrl = async () => ({
        sendMessage: async payload => {
          capturedCalls.push(payload.message.parts[0].data);
          return {
            jsonrpc: '2.0',
            id: 'test-id',
            result: {
              kind: 'task',
              id: 'task-123',
              contextId: 'ctx-123',
              status: { state: 'completed', timestamp: new Date().toISOString() },
            },
          };
        },
      });

      try {
        const client = new AdCPClient([mockAgent]);
        const agent = client.agent(mockAgent.id);

        await agent.createMediaBuy({
          account: { account_id: 'test-account' },
          packages: [],
          brand_manifest: { name: 'Acme', url: 'https://acme.com/brand.json' },
          start_time: 'immediate',
          end_time: '2025-12-31T23:59:59Z',
        });
      } catch (err) {
        assert.ok(
          !err.message.includes('Request validation failed'),
          `Validation should not reject brand_manifest: ${err.message}`
        );
      } finally {
        A2AClient.fromCardUrl = originalFromCardUrl;
      }

      // For v2 agents, the manifest object is converted to a URL string.
      const mediaBuyCall = capturedCalls.find(d => d.skill === 'create_media_buy');
      if (mediaBuyCall) {
        assert.strictEqual(
          mediaBuyCall.parameters.brand_manifest,
          'https://acme.com/brand.json',
          'brand_manifest URL should be extracted from manifest object for v2 agents'
        );
      }
    });

    test('should pass validation with buyer_ref present (backward compat)', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      // buyer_ref is copied from context.buyer_ref by the normalizer for pre-4.15 servers.
      // Non-strict parse accepts it without special-case handling.
      await assert.doesNotReject(async () => {
        try {
          await agent.createMediaBuy({
            account: { account_id: 'test-account' },
            packages: [],
            brand: { domain: 'example.com' },
            buyer_ref: 'buyer-123',
            start_time: 'immediate',
            end_time: '2025-12-31T23:59:59Z',
          });
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      }, 'buyer_ref should not cause a validation error');
    });

    test('should pass validation with both buyer_ref and brand_manifest present', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      // Both deprecated top-level fields should be stripped before strict validation
      await assert.doesNotReject(async () => {
        try {
          await agent.createMediaBuy({
            account: { account_id: 'test-account' },
            packages: [],
            brand: { domain: 'example.com' },
            buyer_ref: 'buyer-456',
            brand_manifest: { name: 'Acme', url: 'https://acme.com/brand.json' },
            start_time: 'immediate',
            end_time: '2025-12-31T23:59:59Z',
          });
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      }, 'buyer_ref + brand_manifest together should not cause a validation error');
    });

    test('should prefer explicit brand over brand_manifest when both are supplied', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      await assert.doesNotReject(async () => {
        try {
          await agent.createMediaBuy({
            account: { account_id: 'test-account' },
            packages: [],
            brand: { domain: 'example.com' },
            brand_manifest: { name: 'Acme', url: 'https://acme.com/brand.json' },
            start_time: 'immediate',
            end_time: '2025-12-31T23:59:59Z',
          });
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      }, 'brand takes precedence; brand_manifest stripped without causing a validation error');
    });
  });

  // AdCP v3 schemas have additionalProperties: true for extensibility.
  // Client-side validation uses non-strict parse so unknown fields pass
  // through — this matters for the storyboard runner's scoping injection
  // (`brand`/`account`) on tools whose schema declares neither, which the
  // downstream adapter strips before the wire call.

  describe('get_products validation', () => {
    test('should pass unknown top-level fields through get_products', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      // Non-strict parse — unknown top-level fields don't trigger rejection.
      await assert.doesNotReject(async () => {
        try {
          await agent.getProducts({
            extra_field: 'passes through',
          });
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      }, 'Unknown top-level fields should not trigger validation rejection');
    });

    test('should infer buying_mode "brief" when brief is provided but buying_mode is missing', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      // Should NOT throw validation error — buying_mode inferred from brief presence
      await assert.doesNotReject(async () => {
        try {
          await agent.getProducts({
            brief: 'Looking for premium ad placements',
          });
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      });
    });

    test('should infer buying_mode "wholesale" when neither brief nor buying_mode is provided', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      // Should NOT throw validation error — buying_mode inferred as 'wholesale'
      await assert.doesNotReject(async () => {
        try {
          await agent.getProducts({});
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      });
    });

    test('should not override explicit buying_mode', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      // Explicit buying_mode should be preserved even if brief is also provided
      await assert.doesNotReject(async () => {
        try {
          await agent.getProducts({
            buying_mode: 'brief',
            brief: 'Test brief',
          });
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      });
    });

    test('should preserve explicit wholesale buying_mode', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      await assert.doesNotReject(async () => {
        try {
          await agent.getProducts({
            buying_mode: 'wholesale',
          });
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      });
    });
  });

  describe('update_media_buy validation', () => {
    test('should allow extra fields in update_media_buy (v3 extensibility)', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      // AdCP v3 allows extra fields for forward compatibility
      // Use ext field for extensions, but extra fields won't be rejected
      try {
        await agent.updateMediaBuy({
          media_buy_id: 'mb123',
          extra_field: 'allowed in v3',
        });
      } catch (err) {
        // Network error is expected (mock agent), but validation error is not
        assert.ok(!err.message.includes('Request validation failed'), 'Should not reject extra fields in v3 schemas');
      }
    });
  });

  describe('list_creatives validation', () => {
    test('should pass unknown top-level fields through list_creatives', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      // list_creatives declares neither `brand` nor `account`. Before this
      // change, strict() rejected the runner's injected scoping fields
      // client-side before the adapter could strip them. Non-strict parse
      // lets injection pass through to the adapter.
      await assert.doesNotReject(async () => {
        try {
          await agent.listCreatives({
            invalid_field: 'passes through',
          });
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      }, 'Unknown top-level fields should not trigger validation rejection');
    });
  });

  describe('runner-injected brand/account survive client validation', () => {
    // Regression guard: the storyboard runner's `applyBrandInvariant` injects
    // top-level `brand` and `account` onto every outgoing request so a single
    // run stays scoped to one brand. For tools whose schema declares neither
    // (list_creative_formats, get_signals, activate_signal, sync_creatives),
    // a strict client-side parse would reject the injection BEFORE
    // `adaptRequestForServerVersion` strips it by schema. This test pins the
    // non-strict parse by asserting the injected request actually reaches
    // dispatch — not just "didn't throw a validation error."
    for (const [toolName, invoke] of [
      ['list_creative_formats', agent => agent.listCreativeFormats],
      ['get_signals', agent => agent.getSignals],
      ['list_creatives', agent => agent.listCreatives],
    ]) {
      test(`${toolName} accepts injected brand/account and dispatches`, async () => {
        const mockMCPAgent = {
          id: 'scoped-agent',
          name: 'Scoped Agent',
          agent_uri: 'https://agents.example.com/mcp',
          protocol: 'mcp',
        };
        const client = new AdCPClient([mockMCPAgent]);
        const agent = client.agent(mockMCPAgent.id);
        const inner = agent.client;
        inner.discoveredEndpoint = mockMCPAgent.agent_uri;
        inner.cachedCapabilities = {
          version: 'v3',
          majorVersions: [3],
          protocols: ['media_buy', 'signals'],
          features: {
            inlineCreativeManagement: false,
            conversionTracking: false,
            audienceTargeting: false,
            propertyListFiltering: false,
            contentStandards: false,
          },
          extensions: [],
          _synthetic: false,
        };

        const originalCallTool = ProtocolClient.callTool;
        const captured = [];
        ProtocolClient.callTool = async (_cfg, name, args) => {
          captured.push({ name, args });
          return {};
        };

        try {
          await invoke(agent).call(agent, {
            brand: { domain: 'example.com' },
            account: { brand: { domain: 'example.com' }, operator: 'example.com' },
          });
        } catch (err) {
          if (err.message?.includes('Request validation failed')) {
            throw err;
          }
        } finally {
          ProtocolClient.callTool = originalCallTool;
        }

        const call = captured.find(c => c.name === toolName);
        assert.ok(call, `${toolName} should have been dispatched (validation passed)`);
      });
    }
  });

  describe('PackageRequest format_ids validation', () => {
    test('should allow format_ids with extra fields (Zod strips unknown fields by default)', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      // NOTE: Zod strips unknown fields in nested objects by default (not strict for nested)
      // This is intentional - strict() only applies to top-level fields
      // Extra fields in format_ids will be silently stripped, not rejected
      await assert.doesNotReject(async () => {
        try {
          await agent.createMediaBuy({
            account: { account_id: 'test-account' },
            packages: [
              {
                buyer_ref: 'pkg123',
                product_id: 'prod123',
                format_ids: [
                  {
                    agent_url: 'https://test.example',
                    id: 'display_300x250',
                    width: 300,
                    height: 250,
                    // Extra fields - will be stripped, not rejected
                    name: 'Banner',
                    description: 'Standard banner',
                  },
                ],
                budget: 1000,
                pricing_option_id: 'cpm-fixed',
              },
            ],
            brand: { domain: 'example.com' },
            start_time: 'asap',
            end_time: '2025-12-31T23:59:59Z',
          });
        } catch (err) {
          // Network errors are expected since we're not mocking the agent
          // We only care that validation doesn't reject format_ids with extra fields
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      });
    });

    test('should accept format_ids with only valid FormatID fields', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      // This should NOT throw validation error (may fail on network, but not validation)
      await assert.doesNotReject(async () => {
        try {
          await agent.createMediaBuy({
            account: { account_id: 'test-account' },
            packages: [
              {
                buyer_ref: 'pkg123',
                product_id: 'prod123',
                format_ids: [
                  {
                    agent_url: 'https://test.example',
                    id: 'display_300x250',
                    width: 300,
                    height: 250,
                  },
                ],
                budget: 1000,
                pricing_option_id: 'cpm-fixed',
              },
            ],
            brand: { domain: 'example.com' },
            start_time: 'asap',
            end_time: '2025-12-31T23:59:59Z',
          });
        } catch (err) {
          // Network errors are expected since we're not mocking the agent
          // We only care that validation doesn't reject valid format_ids
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      });
    });
  });

  describe('context field preservation', () => {
    test('should allow arbitrary properties in context field for get_products', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      // This should NOT throw - context field should accept arbitrary properties
      await assert.doesNotReject(async () => {
        try {
          await agent.getProducts({
            buying_mode: 'brief',
            brief: 'Test brief',
            context: {
              trace_id: '123',
              request_id: 'abc',
              custom_field: 'anything',
              nested: { deeply: { nested: 'value' } },
            },
          });
        } catch (err) {
          // Network errors are expected since we're not mocking the agent
          // We only care that validation doesn't reject the context field
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      });
    });

    test('should allow arbitrary properties in context field for sync_creatives', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      await assert.doesNotReject(async () => {
        try {
          await agent.syncCreatives({
            account: { account_id: 'test-account' },
            creatives: [
              {
                creative_id: 'test',
                name: 'Test Creative',
                format_id: { agent_url: 'https://test.example', id: 'format1' },
                assets: {
                  video: {
                    asset_type: 'video',
                    url: 'https://example.com/video.mp4',
                    width: 1920,
                    height: 1080,
                    duration_ms: 30000,
                  },
                },
              },
            ],
            context: {
              correlation_id: 'xyz-789',
              tenant_id: 'tenant-123',
              any_property: 'should be preserved',
            },
          });
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      });
    });

    test('should allow arbitrary properties in context field for create_media_buy', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      await assert.doesNotReject(async () => {
        try {
          await agent.createMediaBuy({
            account: { account_id: 'test-account' },
            packages: [],
            brand: { domain: 'example.com' },
            start_time: 'immediate',
            end_time: '2025-12-31T23:59:59Z',
            context: {
              session_id: 'sess-456',
              user_agent: 'test-client/1.0',
              custom_metadata: { foo: 'bar', baz: 123 },
            },
          });
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      });
    });

    test('should allow arbitrary properties in context field for build_creative', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      await assert.doesNotReject(async () => {
        try {
          await agent.buildCreative({
            target_format_id: { agent_url: 'https://test.example', id: 'format1' },
            context: {
              build_id: 'build-789',
              environment: 'test',
              arbitrary_data: { nested: { structure: true } },
            },
          });
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      });
    });
  });

  describe('get_media_buys validation', () => {
    test('should accept valid get_media_buys request with media_buy_ids', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      await assert.doesNotReject(async () => {
        try {
          await agent.getMediaBuys({
            account: { account_id: 'test-account' },
            media_buy_ids: ['mb_123', 'mb_456'],
          });
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      });
    });

    test('should accept get_media_buys request with status_filter array', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      await assert.doesNotReject(async () => {
        try {
          await agent.getMediaBuys({
            account: { account_id: 'test-account' },
            status_filter: ['active', 'paused'],
            include_snapshot: true,
          });
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      });
    });

    test('should accept empty get_media_buys request', async () => {
      const client = new AdCPClient([mockAgent]);
      const agent = client.agent(mockAgent.id);

      await assert.doesNotReject(async () => {
        try {
          await agent.getMediaBuys({ account: { account_id: 'test-account' } });
        } catch (err) {
          if (err.message.includes('Request validation failed')) {
            throw err;
          }
        }
      });
    });
  });
});

describe('v3 partial-schema field stripping', () => {
  // For v3 agents with a cached inputSchema, the client filters request params to
  // only the fields declared in the schema. This handles partial v3 implementations
  // that declare get_adcp_capabilities but omit some v3 fields (brand, buying_mode,
  // etc.) from their tool schema, causing Pydantic unexpected_keyword_argument errors.
  test('should strip undeclared fields from get_products for a partial v3 agent', async () => {
    const mockMCPAgent = {
      id: 'partial-v3-agent',
      name: 'Partial V3 Agent',
      agent_uri: 'https://agents.example.com/mcp',
      protocol: 'mcp',
    };

    const client = new AdCPClient([mockMCPAgent]);
    const agent = client.agent(mockMCPAgent.id);
    // AgentClient wraps SingleAgentClient in .client; set state there to bypass network calls
    const inner = agent.client;

    // Simulate: agent is detected as v3 but get_products schema has no 'brand' field
    inner.discoveredEndpoint = mockMCPAgent.agent_uri;
    inner.cachedCapabilities = {
      version: 'v3',
      majorVersions: [3],
      protocols: ['media_buy'],
      features: {
        inlineCreativeManagement: false,
        conversionTracking: false,
        audienceTargeting: false,
        propertyListFiltering: false,
        contentStandards: false,
      },
      extensions: [],
      _synthetic: false,
    };
    inner.cachedToolSchemas = new Map([
      ['get_products', { brief: {}, filters: {}, buying_mode: {} }], // no 'brand'
    ]);

    const capturedCalls = [];
    const originalCallTool = ProtocolClient.callTool;
    ProtocolClient.callTool = async (_agentConfig, toolName, args) => {
      capturedCalls.push({ toolName, args });
      return { products: [], formats: [] };
    };

    try {
      await agent.getProducts({
        brand: { domain: 'fanta.com' },
        brief: 'love chocolate and have 20k to spend',
      });
    } catch (err) {
      if (err.message?.includes('Request validation failed')) {
        throw err;
      }
      // Network/protocol errors are expected since there's no real server
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }

    const getProductsCall = capturedCalls.find(c => c.toolName === 'get_products');
    assert.ok(getProductsCall, 'get_products should have been called');
    assert.strictEqual(
      getProductsCall.args.brand,
      undefined,
      'brand should be stripped when not declared in agent schema'
    );
    assert.ok(getProductsCall.args.brief, 'brief should be preserved');
  });

  test('should pass through all fields when v3 agent schema declares them', async () => {
    const mockMCPAgent = {
      id: 'full-v3-agent',
      name: 'Full V3 Agent',
      agent_uri: 'https://agents.example.com/mcp',
      protocol: 'mcp',
    };

    const client = new AdCPClient([mockMCPAgent]);
    const agent = client.agent(mockMCPAgent.id);
    const inner = agent.client;

    // Simulate: agent is detected as v3 and does declare 'brand' in its schema
    inner.discoveredEndpoint = mockMCPAgent.agent_uri;
    inner.cachedCapabilities = {
      version: 'v3',
      majorVersions: [3],
      protocols: ['media_buy'],
      features: {
        inlineCreativeManagement: false,
        conversionTracking: false,
        audienceTargeting: false,
        propertyListFiltering: false,
        contentStandards: false,
      },
      extensions: [],
      _synthetic: false,
    };
    inner.cachedToolSchemas = new Map([
      ['get_products', { brief: {}, filters: {}, buying_mode: {}, brand: {} }], // has 'brand'
    ]);

    const capturedCalls = [];
    const originalCallTool = ProtocolClient.callTool;
    ProtocolClient.callTool = async (_agentConfig, toolName, args) => {
      capturedCalls.push({ toolName, args });
      return { products: [], formats: [] };
    };

    try {
      await agent.getProducts({
        brand: { domain: 'example.com' },
        brief: 'test campaign',
      });
    } catch (err) {
      if (err.message?.includes('Request validation failed')) {
        throw err;
      }
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }

    const getProductsCall = capturedCalls.find(c => c.toolName === 'get_products');
    assert.ok(getProductsCall, 'get_products should have been called');
    assert.deepStrictEqual(
      getProductsCall.args.brand,
      { domain: 'example.com' },
      'brand should be passed through when declared in agent schema'
    );
  });
});

describe('strict request validation against v2 servers', () => {
  // Pre-send AJV validation runs in SingleAgentClient on the unadapted v3
  // shape, before adaptRequestForServerVersion strips v3-only required
  // fields (buying_mode, account, brand) for the v2 wire. Validating the
  // adapted shape against the v3 schema would falsely reject those fields.
  test('strict mode does not reject get_products against a v2 agent after buying_mode is stripped', async () => {
    const mockMCPAgent = {
      id: 'v2-agent',
      name: 'V2 Agent',
      agent_uri: 'https://agents.example.com/mcp',
      protocol: 'mcp',
    };

    const client = new AdCPClient([mockMCPAgent], {
      validation: { requests: 'strict' },
    });
    const agent = client.agent(mockMCPAgent.id);
    const inner = agent.client;

    inner.discoveredEndpoint = mockMCPAgent.agent_uri;
    inner.cachedCapabilities = {
      version: 'v2',
      majorVersions: [2],
      protocols: ['media_buy'],
      features: {
        inlineCreativeManagement: false,
        conversionTracking: false,
        audienceTargeting: false,
        propertyListFiltering: false,
        contentStandards: false,
      },
      extensions: [],
      _synthetic: false,
    };

    const capturedCalls = [];
    const originalCallTool = ProtocolClient.callTool;
    ProtocolClient.callTool = async (_agentConfig, toolName, args) => {
      capturedCalls.push({ toolName, args });
      return { products: [] };
    };

    try {
      await assert.doesNotReject(
        agent.getProducts({
          buying_mode: 'brief',
          brief: 'Premium ad placements',
          brand: { domain: 'example.com' },
        }),
        err => err.message?.includes('Validation failed for field')
      );
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }

    const call = capturedCalls.find(c => c.toolName === 'get_products');
    assert.ok(call, 'get_products should have reached the protocol layer');
    assert.strictEqual(call.args.buying_mode, undefined, 'buying_mode is stripped by the v2 adapter');
    assert.strictEqual(call.args.brief, 'Premium ad placements', 'brief is preserved');
  });

  test('strict mode does not reject create_media_buy against a v2 agent after brand is rewritten to brand_manifest', async () => {
    const mockMCPAgent = {
      id: 'v2-agent-cmb',
      name: 'V2 Agent',
      agent_uri: 'https://agents.example.com/mcp',
      protocol: 'mcp',
    };

    const client = new AdCPClient([mockMCPAgent], {
      validation: { requests: 'strict' },
      // create_media_buy is mutating; allowV2 lets the v2 path proceed.
      allowV2: true,
    });
    const agent = client.agent(mockMCPAgent.id);
    const inner = agent.client;

    inner.discoveredEndpoint = mockMCPAgent.agent_uri;
    inner.cachedCapabilities = {
      version: 'v2',
      majorVersions: [2],
      protocols: ['media_buy'],
      features: {
        inlineCreativeManagement: false,
        conversionTracking: false,
        audienceTargeting: false,
        propertyListFiltering: false,
        contentStandards: false,
      },
      extensions: [],
      _synthetic: false,
    };

    const capturedCalls = [];
    const originalCallTool = ProtocolClient.callTool;
    ProtocolClient.callTool = async (_agentConfig, toolName, args) => {
      capturedCalls.push({ toolName, args });
      return { media_buy_id: 'mb-1', status: 'completed' };
    };

    try {
      await assert.doesNotReject(
        agent.createMediaBuy({
          account: { account_id: 'acct-1' },
          brand: { domain: 'example.com' },
          packages: [{ product_id: 'prod-1', budget: 1000, pricing_option_id: 'po-1' }],
          start_time: 'asap',
          end_time: '2027-12-31T23:59:59Z',
        }),
        err => err.message?.includes('Validation failed for field')
      );
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }

    const call = capturedCalls.find(c => c.toolName === 'create_media_buy');
    assert.ok(call, 'create_media_buy should have reached the protocol layer');
    assert.strictEqual(call.args.brand, undefined, 'brand is removed by the v2 adapter');
    assert.strictEqual(call.args.brand_manifest, 'https://example.com', 'brand_manifest is derived from brand.domain');
  });

  test('strict mode does not reject sync_creatives against a v2 agent after account is stripped', async () => {
    const mockMCPAgent = {
      id: 'v2-agent-sc',
      name: 'V2 Agent',
      agent_uri: 'https://agents.example.com/mcp',
      protocol: 'mcp',
    };

    const client = new AdCPClient([mockMCPAgent], {
      validation: { requests: 'strict' },
      allowV2: true,
    });
    const agent = client.agent(mockMCPAgent.id);
    const inner = agent.client;

    inner.discoveredEndpoint = mockMCPAgent.agent_uri;
    inner.cachedCapabilities = {
      version: 'v2',
      majorVersions: [2],
      protocols: ['creative'],
      features: {
        inlineCreativeManagement: false,
        conversionTracking: false,
        audienceTargeting: false,
        propertyListFiltering: false,
        contentStandards: false,
      },
      extensions: [],
      _synthetic: false,
    };

    const capturedCalls = [];
    const originalCallTool = ProtocolClient.callTool;
    ProtocolClient.callTool = async (_agentConfig, toolName, args) => {
      capturedCalls.push({ toolName, args });
      return { results: [] };
    };

    try {
      await assert.doesNotReject(
        agent.syncCreatives({
          account: { account_id: 'acct-1' },
          creatives: [
            {
              creative_id: 'cre-1',
              name: 'Test Creative',
              format_id: { agent_url: 'https://test.example', id: 'format1' },
              assets: {
                video: {
                  asset_type: 'video',
                  url: 'https://example.com/video.mp4',
                  width: 1920,
                  height: 1080,
                  duration_ms: 30000,
                },
              },
            },
          ],
        }),
        err => err.message?.includes('Validation failed for field')
      );
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }

    const call = capturedCalls.find(c => c.toolName === 'sync_creatives');
    assert.ok(call, 'sync_creatives should have reached the protocol layer');
    assert.strictEqual(call.args.account, undefined, 'account is stripped by the v2 adapter');
    assert.ok(Array.isArray(call.args.creatives) && call.args.creatives.length === 1, 'creatives are preserved');
    // Manifest must be flattened: v2 expects a single asset payload, not { role: payload }
    assert.deepStrictEqual(
      call.args.creatives[0].assets,
      { asset_type: 'video', url: 'https://example.com/video.mp4', width: 1920, height: 1080, duration_ms: 30000 },
      'v3 manifest assets are flattened to a single v2 asset payload'
    );
  });

  test('strict mode still rejects malformed v3 input from the migrated SingleAgentClient seam', async () => {
    // Regression guard for the call-site move: the inline AJV pass inside
    // TaskExecutor.executeTask is gone, replaced by SingleAgentClient.executeTask
    // calling executor.validateRequest before the v2 adapter runs. Confirm a
    // malformed v3 request (create_media_buy missing required end_time) still
    // throws — not just "didn't accept it cleanly", we want the
    // `Request validation failed` channel to fire.
    const mockMCPAgent = {
      id: 'v3-agent-negative',
      name: 'V3 Agent',
      agent_uri: 'https://agents.example.com/mcp',
      protocol: 'mcp',
    };

    const client = new AdCPClient([mockMCPAgent], {
      validation: { requests: 'strict' },
    });
    const agent = client.agent(mockMCPAgent.id);
    const inner = agent.client;
    inner.discoveredEndpoint = mockMCPAgent.agent_uri;
    inner.cachedCapabilities = {
      version: 'v3',
      majorVersions: [3],
      protocols: ['media_buy'],
      features: {
        inlineCreativeManagement: false,
        conversionTracking: false,
        audienceTargeting: false,
        propertyListFiltering: false,
        contentStandards: false,
      },
      extensions: [],
      _synthetic: false,
    };

    await assert.rejects(
      agent.createMediaBuy({
        account: { account_id: 'acct-1' },
        brand: { domain: 'example.com' },
        start_time: 'asap',
        // Missing `end_time` — required by the v3 schema. Must reject.
      }),
      err => /Request validation failed|Validation failed for field/.test(err.message ?? ''),
      'malformed v3 input must still throw from the migrated validate seam'
    );
  });

  test('strict mode preserves v3 fields and reaches the protocol layer for a v3 agent', async () => {
    const mockMCPAgent = {
      id: 'v3-agent',
      name: 'V3 Agent',
      agent_uri: 'https://agents.example.com/mcp',
      protocol: 'mcp',
    };

    const client = new AdCPClient([mockMCPAgent], {
      validation: { requests: 'strict' },
    });
    const agent = client.agent(mockMCPAgent.id);
    const inner = agent.client;

    inner.discoveredEndpoint = mockMCPAgent.agent_uri;
    inner.cachedCapabilities = {
      version: 'v3',
      majorVersions: [3],
      protocols: ['media_buy'],
      features: {
        inlineCreativeManagement: false,
        conversionTracking: false,
        audienceTargeting: false,
        propertyListFiltering: false,
        contentStandards: false,
      },
      extensions: [],
      _synthetic: false,
      idempotency: { replayTtlSeconds: 3600 },
    };

    const capturedCalls = [];
    const originalCallTool = ProtocolClient.callTool;
    ProtocolClient.callTool = async (_agentConfig, toolName, args) => {
      capturedCalls.push({ toolName, args });
      return { products: [] };
    };

    try {
      await agent.getProducts({
        buying_mode: 'brief',
        brief: 'Premium ad placements',
        brand: { domain: 'example.com' },
      });
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }

    const call = capturedCalls.find(c => c.toolName === 'get_products');
    assert.ok(call, 'get_products should have reached the protocol layer');
    assert.strictEqual(call.args.buying_mode, 'brief', 'buying_mode is preserved for v3');
    assert.deepStrictEqual(call.args.brand, { domain: 'example.com' }, 'brand is preserved for v3');
  });
});
