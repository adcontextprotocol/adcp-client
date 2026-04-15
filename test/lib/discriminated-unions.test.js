const { describe, test } = require('node:test');
const assert = require('node:assert');

// Import Zod schemas
const {
  PreviewCreativeRequestSchema,
  PreviewCreativeResponseSchema,
} = require('../../dist/lib/types/schemas.generated');

describe('Discriminated Union Validation', () => {
  describe('PreviewCreativeRequest - request_type discriminator', () => {
    test('should validate single request type', () => {
      const valid = {
        request_type: 'single',
        format_id: {
          agent_url: 'https://test.com',
          id: 'fmt-1',
        },
        creative_manifest: {
          format_id: {
            agent_url: 'https://test.com',
            id: 'fmt-1',
          },
          assets: {},
        },
      };

      const result = PreviewCreativeRequestSchema.safeParse(valid);
      assert.strictEqual(
        result.success,
        true,
        `Expected success but got errors: ${result.success ? 'success' : JSON.stringify(result.error.errors, null, 2)}`
      );

      // Verify discriminator value
      if (result.success) {
        assert.strictEqual(result.data.request_type, 'single');
      }
    });

    test('should validate batch request type', () => {
      const valid = {
        request_type: 'batch',
        requests: [
          {
            format_id: {
              agent_url: 'https://test.com',
              id: 'fmt-1',
            },
            creative_manifest: {
              format_id: {
                agent_url: 'https://test.com',
                id: 'fmt-1',
              },
              assets: {},
            },
          },
        ],
      };

      const result = PreviewCreativeRequestSchema.safeParse(valid);
      assert.strictEqual(
        result.success,
        true,
        `Expected success but got errors: ${result.success ? 'success' : JSON.stringify(result.error.errors, null, 2)}`
      );

      // Verify discriminator value
      if (result.success) {
        assert.strictEqual(result.data.request_type, 'batch');
      }
    });

    test('should reject missing request_type discriminator', () => {
      const invalid = {
        format_id: {
          agent_url: 'https://test.com',
          id: 'fmt-1',
        },
        creative_manifest: {
          format_id: {
            agent_url: 'https://test.com',
            id: 'fmt-1',
          },
          assets: {},
        },
      };

      const result = PreviewCreativeRequestSchema.safeParse(invalid);
      assert.strictEqual(result.success, false, 'Expected validation to fail for missing request_type');

      // Check error mentions discriminator
      if (!result.success) {
        const errorMessage = JSON.stringify(result.error.issues);
        assert.ok(
          errorMessage.includes('request_type') || errorMessage.includes('union'),
          'Error should mention request_type or union validation'
        );
      }
    });

    test('should reject invalid request_type value', () => {
      const invalid = {
        request_type: 'invalid_type',
        format_id: {
          agent_url: 'https://test.com',
          id: 'fmt-1',
        },
        creative_manifest: {
          format_id: {
            agent_url: 'https://test.com',
            id: 'fmt-1',
          },
          assets: {},
        },
      };

      const result = PreviewCreativeRequestSchema.safeParse(invalid);
      assert.strictEqual(result.success, false, 'Expected validation to fail for invalid request_type');
    });

    test('flat schema accepts single mode with creative_manifest', () => {
      // With the flat schema, mode-specific fields are optional at the schema level.
      // Conditional requirements (single needs creative_manifest, batch needs requests)
      // are enforced at the application level, not the schema level.
      const singleWithManifest = {
        request_type: 'single',
        creative_manifest: {
          format_id: { agent_url: 'https://test.com', id: 'fmt-1' },
          assets: {},
        },
      };
      const result = PreviewCreativeRequestSchema.safeParse(singleWithManifest);
      assert.strictEqual(result.success, true);
    });

    test('flat schema accepts batch mode with requests array', () => {
      const batchWithRequests = {
        request_type: 'batch',
        requests: [{
          creative_manifest: {
            format_id: { agent_url: 'https://test.com', id: 'fmt-1' },
            assets: {},
          },
        }],
      };
      const result = PreviewCreativeRequestSchema.safeParse(batchWithRequests);
      assert.strictEqual(result.success, true);
    });
  });

  describe('PreviewCreativeResponse - response_type discriminator', () => {
    test('should validate single response type', () => {
      const valid = {
        response_type: 'single',
        previews: [
          {
            preview_id: 'preview-1',
            renders: [
              {
                render_id: 'render-1',
                output_format: 'url',
                preview_url: 'https://preview.example.com/render-1.html',
                role: 'primary',
                dimensions: { width: 300, height: 250 },
              },
            ],
            input: {
              name: 'Default',
            },
          },
        ],
        expires_at: '2025-11-17T00:00:00Z',
      };

      const result = PreviewCreativeResponseSchema.safeParse(valid);
      assert.strictEqual(
        result.success,
        true,
        `Expected success but got errors: ${result.success ? 'success' : JSON.stringify(result.error.issues, null, 2)}`
      );

      // Verify discriminator value
      if (result.success) {
        assert.strictEqual(result.data.response_type, 'single');
      }
    });

    test('should validate batch response type', () => {
      const valid = {
        response_type: 'batch',
        results: [
          {
            success: true,
            response: {
              previews: [
                {
                  preview_id: 'preview-1',
                  renders: [
                    {
                      render_id: 'render-1',
                      output_format: 'url',
                      preview_url: 'https://preview.example.com/render-1.html',
                      role: 'primary',
                      dimensions: { width: 300, height: 250 },
                    },
                  ],
                  input: {
                    name: 'Default',
                  },
                },
              ],
              expires_at: '2025-11-17T00:00:00Z',
            },
          },
        ],
      };

      const result = PreviewCreativeResponseSchema.safeParse(valid);
      assert.strictEqual(
        result.success,
        true,
        `Expected success but got errors: ${result.success ? 'success' : JSON.stringify(result.error.issues, null, 2)}`
      );

      // Verify discriminator value
      if (result.success) {
        assert.strictEqual(result.data.response_type, 'batch');
      }
    });

    test('should reject missing response_type discriminator', () => {
      const invalid = {
        previews: [
          {
            preview_id: 'preview-1',
            renders: [
              {
                render_id: 'render-1',
                output_format: 'url',
                preview_url: 'https://preview.example.com/render-1.html',
                role: 'primary',
                dimensions: { width: 300, height: 250 },
              },
            ],
            input: {
              name: 'Default',
            },
          },
        ],
        expires_at: '2025-11-17T00:00:00Z',
      };

      const result = PreviewCreativeResponseSchema.safeParse(invalid);
      assert.strictEqual(result.success, false, 'Expected validation to fail for missing response_type');
    });

    test('should reject invalid response_type value', () => {
      const invalid = {
        response_type: 'invalid_type',
        previews: [
          {
            preview_id: 'preview-1',
            renders: [
              {
                render_id: 'render-1',
                output_format: 'url',
                preview_url: 'https://preview.example.com/render-1.html',
                role: 'primary',
                dimensions: { width: 300, height: 250 },
              },
            ],
            input: {
              name: 'Default',
            },
          },
        ],
        expires_at: '2025-11-17T00:00:00Z',
      };

      const result = PreviewCreativeResponseSchema.safeParse(invalid);
      assert.strictEqual(result.success, false, 'Expected validation to fail for invalid response_type');
    });
  });

  describe('Type narrowing behavior', () => {
    test('PreviewCreativeRequest discriminator enables type narrowing', () => {
      const singleRequest = {
        request_type: 'single',
        format_id: { agent_url: 'https://test.com', id: 'fmt-1' },
        creative_manifest: {
          format_id: { agent_url: 'https://test.com', id: 'fmt-1' },
          assets: {},
        },
      };

      const result = PreviewCreativeRequestSchema.safeParse(singleRequest);
      assert.strictEqual(result.success, true);

      // After validation, we can check the discriminator to know the type
      if (result.success) {
        assert.strictEqual(result.data.request_type, 'single');

        // TypeScript knows this is the 'single' branch
        if (result.data.request_type === 'single') {
          assert.ok('format_id' in result.data, 'Single request should have format_id field');
        }
      }
    });

    test('PreviewCreativeResponse discriminator enables type narrowing', () => {
      const batchResponse = {
        response_type: 'batch',
        results: [
          {
            success: true,
            response: {
              previews: [
                {
                  preview_id: 'preview-1',
                  renders: [
                    {
                      render_id: 'render-1',
                      output_format: 'url',
                      preview_url: 'https://preview.example.com/render-1.html',
                      role: 'primary',
                      dimensions: { width: 300, height: 250 },
                    },
                  ],
                  input: {
                    name: 'Default',
                  },
                },
              ],
              expires_at: '2025-11-17T00:00:00Z',
            },
          },
        ],
      };

      const result = PreviewCreativeResponseSchema.safeParse(batchResponse);
      assert.strictEqual(result.success, true);

      // After validation, we can check the discriminator to know the type
      if (result.success) {
        assert.strictEqual(result.data.response_type, 'batch');

        // TypeScript knows this is the 'batch' branch
        if (result.data.response_type === 'batch') {
          assert.ok('results' in result.data, 'Batch response should have results field');
          assert.ok(!('previews' in result.data), 'Batch response should not have previews field at top level');
        }
      }
    });
  });

  describe('Discriminated union benefits', () => {
    test('discriminators make invalid combinations impossible', () => {
      // Before discriminated unions, this would be ambiguous:
      // { format_id: ..., requests: [...] } - which is it?

      // With discriminated unions, you MUST specify the type:
      const ambiguous = {
        // Missing request_type - can't be parsed
        format_id: { agent_url: 'https://test.com', id: 'fmt-1' },
        requests: [
          {
            /* ... */
          },
        ],
      };

      const result = PreviewCreativeRequestSchema.safeParse(ambiguous);
      assert.strictEqual(result.success, false, 'Ambiguous data without discriminator should fail validation');
    });

    test('flat schema accepts any field combination with valid request_type', () => {
      // With the flat schema (adcp#2175), mode-specific fields are optional at
      // the schema level. Conditional requirements are application-level concerns.
      const singleWithoutManifest = {
        request_type: 'single',
        // No creative_manifest — schema allows it, application validates
      };

      const singleResult = PreviewCreativeRequestSchema.safeParse(singleWithoutManifest);
      assert.strictEqual(singleResult.success, true, 'Flat schema accepts single without creative_manifest');

      const batchWithoutRequests = {
        request_type: 'batch',
        // No requests array — schema allows it, application validates
      };

      const batchResult = PreviewCreativeRequestSchema.safeParse(batchWithoutRequests);
      assert.strictEqual(batchResult.success, true, 'Flat schema accepts batch without requests');
    });
  });
});
