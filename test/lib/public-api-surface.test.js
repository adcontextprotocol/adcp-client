/**
 * Public API Surface Tests
 *
 * These tests validate that:
 * 1. Only intended types/classes are exported from @adcp/client
 * 2. Internal types marked with @internal are not leaked
 * 3. Export count stays within acceptable bounds
 * 4. No numbered discriminated union types in public API
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const AdCPClient = require('../../dist/lib/index.js');

describe('Public API Surface', () => {
  describe('Export Validation', () => {
    it('should export expected main classes', () => {
      // Main client classes
      assert.ok(AdCPClient.AdCPClient, 'AdCPClient should be exported');
      assert.ok(AdCPClient.AsyncHandler, 'AsyncHandler should be exported');
      assert.ok(AdCPClient.TaskExecutor, 'TaskExecutor should be exported');

      // Error classes
      assert.ok(AdCPClient.ADCPError, 'ADCPError should be exported');
      assert.ok(AdCPClient.TaskTimeoutError, 'TaskTimeoutError should be exported');
      assert.ok(AdCPClient.ADCPValidationError, 'ADCPValidationError should be exported');
      assert.ok(AdCPClient.InputRequiredError, 'InputRequiredError should be exported');
      assert.ok(AdCPClient.AgentNotFoundError, 'AgentNotFoundError should be exported');
    });

    it('should export tool request/response type schemas', () => {
      // Media Buy Tool Schemas
      assert.ok(AdCPClient.GetProductsRequestSchema, 'GetProductsRequestSchema should be exported');
      assert.ok(AdCPClient.GetProductsResponseSchema, 'GetProductsResponseSchema should be exported');
      assert.ok(AdCPClient.CreateMediaBuyRequestSchema, 'CreateMediaBuyRequestSchema should be exported');
      assert.ok(AdCPClient.CreateMediaBuyResponseSchema, 'CreateMediaBuyResponseSchema should be exported');

      // Creative Tool Schemas
      assert.ok(AdCPClient.BuildCreativeRequestSchema, 'BuildCreativeRequestSchema should be exported');
      assert.ok(AdCPClient.BuildCreativeResponseSchema, 'BuildCreativeResponseSchema should be exported');

      // Signals Tool Schemas
      assert.ok(AdCPClient.GetSignalsRequestSchema, 'GetSignalsRequestSchema should be exported');
      assert.ok(AdCPClient.ActivateSignalRequestSchema, 'ActivateSignalRequestSchema should be exported');
    });

    it('should export core data model schemas', () => {
      assert.ok(AdCPClient.FormatIDSchema, 'FormatIDSchema should be exported');
      assert.ok(AdCPClient.ProductSchema, 'ProductSchema should be exported');
      assert.ok(AdCPClient.PackageRequestSchema, 'PackageRequestSchema should be exported');
      assert.ok(AdCPClient.CreativeAssetSchema, 'CreativeAssetSchema should be exported');
    });

    it('should NOT export internal schemas', () => {
      // These are internal implementation details that should not be exposed
      assert.strictEqual(AdCPClient.BrandManifestSchema, undefined, 'BrandManifestSchema should not be exported');
      assert.strictEqual(AdCPClient.ImageAssetSchema, undefined, 'ImageAssetSchema should not be exported');
      assert.strictEqual(AdCPClient.VideoAssetSchema, undefined, 'VideoAssetSchema should not be exported');
      assert.strictEqual(AdCPClient.VASTAssetSchema, undefined, 'VASTAssetSchema should not be exported');
      assert.strictEqual(AdCPClient.TargetingSchema, undefined, 'TargetingSchema should not be exported');
      assert.strictEqual(AdCPClient.GeographicTargetingSchema, undefined, 'GeographicTargetingSchema should not be exported');
    });

    it('should NOT export numbered discriminated union types', () => {
      // These indicate schema naming collisions that shouldn't be in public API
      assert.strictEqual(AdCPClient.BrandManifestReference1, undefined, 'BrandManifestReference1 should not be exported');
      assert.strictEqual(AdCPClient.CreativeStatus1, undefined, 'CreativeStatus1 should not be exported');
      assert.strictEqual(AdCPClient.UpdateMediaBuyRequest2, undefined, 'UpdateMediaBuyRequest2 should not be exported');
      assert.strictEqual(AdCPClient.PricingModel1, undefined, 'PricingModel1 should not be exported');
    });

    it('should NOT export internal server types', () => {
      // These are marked @internal and should not be in public API (though TypeScript allows them for internal use)
      // We're checking they don't leak into the actual exports
      const exportedKeys = Object.keys(AdCPClient);

      // Server-only request/response types
      assert.ok(!exportedKeys.includes('ManageCreativeAssetsRequest'), 'ManageCreativeAssetsRequest should not be in exports');
      assert.ok(!exportedKeys.includes('ManageCreativeAssetsResponse'), 'ManageCreativeAssetsResponse should not be in exports');

      // Note: TestResponse and AgentListResponse are exported for internal server use,
      // but they're marked @internal in JSDoc so IDEs can hide them
    });

    it('should keep total exports within acceptable bounds', () => {
      const exportedKeys = Object.keys(AdCPClient);
      const exportCount = exportedKeys.length;

      // Before cleanup: ~200+ exports
      // After cleanup: ~70-100 exports (allowing some buffer for growth)
      assert.ok(exportCount < 150, `Export count (${exportCount}) should be less than 150 to maintain clean API surface`);

      console.log(`\n📊 Current public API exports: ${exportCount}`);
      console.log(`✅ Export count is within acceptable bounds (< 150)`);
    });
  });

  describe('Schema Export Validation', () => {
    it('should only export main request/response schemas', () => {
      const exportedKeys = Object.keys(AdCPClient);

      // Count schemas (exports ending with 'Schema')
      const schemaExports = exportedKeys.filter(key => key.endsWith('Schema'));

      // Expected: 26 request/response schemas (13 tools × 2) + 4 core data model schemas = 30
      // Allow buffer up to 40 for any additions
      assert.ok(schemaExports.length <= 40,
        `Schema exports (${schemaExports.length}) should be ≤ 40. Found: ${schemaExports.join(', ')}`
      );

      console.log(`\n📋 Schema exports: ${schemaExports.length}`);
      console.log(`   Request/Response schemas: ~26 (13 tools × 2)`);
      console.log(`   Core data model schemas: 4`);
    });

    it('should export schemas that can validate correct data', () => {
      // Test FormatIDSchema works
      const validFormatID = {
        agent_url: 'https://formats.example.com',
        id: 'video_1920x1080_30s'
      };

      const result = AdCPClient.FormatIDSchema.safeParse(validFormatID);
      assert.ok(result.success, 'FormatIDSchema should validate correct FormatID structure');
    });

    it('should export schemas that reject invalid data', () => {
      const invalidFormatID = {
        // Missing required fields
        id: 'video_1920x1080_30s'
      };

      const result = AdCPClient.FormatIDSchema.safeParse(invalidFormatID);
      assert.ok(!result.success, 'FormatIDSchema should reject invalid FormatID structure');
    });
  });

  describe('Type Structure Validation', () => {
    it('should have AdCPClient with expected methods', () => {
      const client = new AdCPClient.AdCPClient([]);

      // Fluent API methods
      assert.strictEqual(typeof client.agent, 'function', 'agent() method should exist');
      assert.strictEqual(typeof client.agents, 'function', 'agents() method should exist');
      assert.strictEqual(typeof client.allAgents, 'function', 'allAgents() method should exist');

      // Agent management
      assert.strictEqual(typeof client.addAgent, 'function', 'addAgent() method should exist');
      assert.strictEqual(typeof client.getAgentConfigs, 'function', 'getAgentConfigs() method should exist');
    });

    it('should have AsyncHandler with expected configuration', () => {
      const handler = new AdCPClient.AsyncHandler({
        webhookBaseUrl: 'https://example.com/webhooks'
      });

      assert.ok(handler, 'AsyncHandler should be instantiable');
      assert.strictEqual(typeof handler.handleWebhook, 'function', 'handleWebhook() method should exist');
      // Note: getWebhookUrl is a private method, checking handleWebhook is sufficient
    });

    it('should have error classes with correct inheritance', () => {
      // ADCPError is abstract, test concrete subclasses
      assert.ok(AdCPClient.TaskTimeoutError, 'TaskTimeoutError should be exported');
      assert.ok(AdCPClient.AgentNotFoundError, 'AgentNotFoundError should be exported');

      const timeoutError = new AdCPClient.TaskTimeoutError('task-123', 5000);
      assert.ok(timeoutError instanceof Error, 'TaskTimeoutError should extend Error');
      assert.strictEqual(timeoutError.code, 'TASK_TIMEOUT', 'TaskTimeoutError should have code property');

      const agentError = new AdCPClient.AgentNotFoundError('agent-123', ['agent-1', 'agent-2']);
      assert.ok(agentError instanceof Error, 'AgentNotFoundError should extend Error');
      assert.strictEqual(agentError.code, 'AGENT_NOT_FOUND', 'AgentNotFoundError should have code property');
    });
  });

  describe('No Internal Type Leakage', () => {
    it('should not have exports with "Internal" in the name', () => {
      const exportedKeys = Object.keys(AdCPClient);
      const internalExports = exportedKeys.filter(key =>
        key.toLowerCase().includes('internal')
      );

      assert.strictEqual(internalExports.length, 0,
        `No exports should contain "Internal" in name. Found: ${internalExports.join(', ')}`
      );
    });

    it('should not have exports ending with numbers (discriminated unions)', () => {
      const exportedKeys = Object.keys(AdCPClient);

      // Check for exports ending with digit (e.g., Type1, Request2)
      const numberedExports = exportedKeys.filter(key => /\d$/.test(key));

      assert.strictEqual(numberedExports.length, 0,
        `No exports should end with numbers (indicates discriminated union collision). Found: ${numberedExports.join(', ')}`
      );
    });

    it('should not have duplicate type names', () => {
      const exportedKeys = Object.keys(AdCPClient);

      // Check if we have multiple variants of the same base name
      // e.g., CreativeAsset and CreativeAsset1
      const baseNames = new Map();

      exportedKeys.forEach(key => {
        const baseName = key.replace(/\d+$/, ''); // Remove trailing numbers
        if (!baseNames.has(baseName)) {
          baseNames.set(baseName, []);
        }
        baseNames.get(baseName).push(key);
      });

      const duplicates = Array.from(baseNames.entries())
        .filter(([_, variants]) => variants.length > 1);

      assert.strictEqual(duplicates.length, 0,
        `No duplicate base names should exist. Found: ${JSON.stringify(duplicates)}`
      );
    });
  });

  describe('Backward Compatibility', () => {
    it('should maintain legacy Agent class for backward compatibility', () => {
      assert.ok(AdCPClient.Agent, 'Agent class should be exported for backward compatibility');
      assert.ok(AdCPClient.AgentCollection, 'AgentCollection class should be exported for backward compatibility');
    });

    it('should export all 13 tool request/response type pairs', () => {
      const expectedTools = [
        'GetProducts',
        'ListCreativeFormats',
        'CreateMediaBuy',
        'UpdateMediaBuy',
        'SyncCreatives',
        'ListCreatives',
        'GetMediaBuyDelivery',
        'ListAuthorizedProperties',
        'ProvidePerformanceFeedback',
        'BuildCreative',
        'PreviewCreative',
        'GetSignals',
        'ActivateSignal'
      ];

      const exportedKeys = Object.keys(AdCPClient);

      expectedTools.forEach(tool => {
        const requestSchema = `${tool}RequestSchema`;
        const responseSchema = `${tool}ResponseSchema`;

        assert.ok(exportedKeys.includes(requestSchema),
          `${requestSchema} should be exported`
        );
        assert.ok(exportedKeys.includes(responseSchema),
          `${responseSchema} should be exported`
        );
      });
    });
  });

  describe('Export Categories', () => {
    it('should categorize all exports correctly', () => {
      const exportedKeys = Object.keys(AdCPClient);

      const categories = {
        schemas: new Set(),
        functions: new Set(),
        other: new Set()
      };

      // Categorize each export once
      exportedKeys.forEach(k => {
        const exported = AdCPClient[k];
        if (k.endsWith('Schema') && !k.startsWith('get')) {
          categories.schemas.add(k);
        } else if (typeof exported === 'function') {
          categories.functions.add(k);
        } else {
          categories.other.add(k);
        }
      });

      console.log('\n📦 Export Categories:');
      console.log(`   Schemas: ${categories.schemas.size}`);
      console.log(`   Classes/Functions: ${categories.functions.size}`);
      console.log(`   Other: ${categories.other.size}`);
      console.log(`   Total: ${exportedKeys.length}`);

      // Sanity check: categorization covers all exports
      const totalCategorized = categories.schemas.size +
                              categories.functions.size +
                              categories.other.size;

      assert.strictEqual(totalCategorized, exportedKeys.length,
        'All exports should be accounted for in categories'
      );
    });
  });
});

describe('Type Safety Validation (TypeScript)', () => {
  describe('Request/Response Types', () => {
    it('should have proper GetProducts types', () => {
      // This validates the types exist and are importable
      // TypeScript compilation will fail if types are wrong
      const request = {
        brand_manifest: 'https://example.com',
        brief: 'Test brief'
      };

      const validationResult = AdCPClient.GetProductsRequestSchema.safeParse(request);
      assert.ok(validationResult.success, 'GetProductsRequest should validate');
    });

    it('should have proper CreateMediaBuy types', () => {
      const request = {
        buyer_ref: 'test-campaign',
        brand_manifest: 'https://example.com',
        packages: [],
        start_time: 'asap',
        end_time: '2024-12-31T23:59:59Z'
      };

      const validationResult = AdCPClient.CreateMediaBuyRequestSchema.safeParse(request);
      assert.ok(validationResult.success, 'CreateMediaBuyRequest should validate');
    });
  });

  describe('Core Data Models', () => {
    it('should validate FormatID structure', () => {
      const formatId = {
        agent_url: 'https://formats.example.com',
        id: 'video_1920x1080_30s'
      };

      const result = AdCPClient.FormatIDSchema.safeParse(formatId);
      assert.ok(result.success, 'FormatID should validate correctly');

      if (result.success) {
        assert.strictEqual(result.data.agent_url, formatId.agent_url);
        assert.strictEqual(result.data.id, formatId.id);
      }
    });

    it('should have ProductSchema available for validation', () => {
      // Just verify the schema exists and can be called
      assert.ok(AdCPClient.ProductSchema, 'ProductSchema should be exported');
      assert.strictEqual(typeof AdCPClient.ProductSchema.safeParse, 'function',
        'ProductSchema should have safeParse method'
      );
    });
  });
});

describe('Clean API Experience', () => {
  it('should provide clean import experience', () => {
    // Simulating what users will see in their IDE
    const importedExports = Object.keys(AdCPClient);

    // Ensure no confusing numbered variants
    const confusingExports = importedExports.filter(key =>
      /\d$/.test(key) || // ends with number
      key.includes('Internal') || // contains "Internal"
      key.includes('_generated') // contains "_generated"
    );

    assert.strictEqual(confusingExports.length, 0,
      `Clean API should not have confusing exports. Found: ${confusingExports.join(', ')}`
    );
  });

  it('should have consistent naming conventions', () => {
    const exportedKeys = Object.keys(AdCPClient);

    // Request types should end with Request or RequestSchema
    const requestTypes = exportedKeys.filter(k =>
      k.includes('Request') && !k.includes('Input') && !k.includes('Required')
    );
    requestTypes.forEach(key => {
      assert.ok(
        key.endsWith('Request') || key.endsWith('RequestSchema'),
        `Request type ${key} should follow naming convention`
      );
    });

    // Response types should end with Response or ResponseSchema
    // Exclude utility classes like ResponseParser, ResponseValidator
    const responseTypes = exportedKeys.filter(k =>
      k.includes('Response') &&
      !k.includes('Parser') &&
      !k.includes('Handler') &&
      !k.includes('Validator')
    );
    responseTypes.forEach(key => {
      assert.ok(
        key.endsWith('Response') || key.endsWith('ResponseSchema'),
        `Response type ${key} should follow naming convention`
      );
    });
  });

  it('should have clear separation between types and schemas', () => {
    const exportedKeys = Object.keys(AdCPClient);

    // Every export ending with Schema should be a Zod schema
    // Exclude utility functions like getExpectedSchema
    const schemas = exportedKeys.filter(k =>
      k.endsWith('Schema') && !k.startsWith('get')
    );

    schemas.forEach(schema => {
      const schemaValue = AdCPClient[schema];

      // Schemas should be Zod objects with safeParse
      assert.ok(schemaValue && typeof schemaValue.safeParse === 'function',
        `${schema} should be a Zod schema with safeParse method`
      );
    });

    console.log(`\n✅ Clear naming: ${schemas.length} schemas properly suffixed with "Schema"`);
  });
});
