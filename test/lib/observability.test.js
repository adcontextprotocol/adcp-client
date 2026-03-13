const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('Observability utilities', () => {
  describe('tracing exports', () => {
    it('exports all expected functions', async () => {
      const {
        getTracer,
        isTracingEnabled,
        injectTraceHeaders,
        withSpan,
        addSpanAttributes,
        recordSpanException,
      } = await import('../../dist/lib/index.js');

      assert.strictEqual(typeof getTracer, 'function');
      assert.strictEqual(typeof isTracingEnabled, 'function');
      assert.strictEqual(typeof injectTraceHeaders, 'function');
      assert.strictEqual(typeof withSpan, 'function');
      assert.strictEqual(typeof addSpanAttributes, 'function');
      assert.strictEqual(typeof recordSpanException, 'function');
    });

    it('isTracingEnabled returns boolean', async () => {
      const { isTracingEnabled } = await import('../../dist/lib/index.js');
      const result = isTracingEnabled();
      assert.strictEqual(typeof result, 'boolean');
    });

    it('getTracer returns tracer or null', async () => {
      const { getTracer } = await import('../../dist/lib/index.js');
      const tracer = getTracer();
      // Should be a tracer object (if OTel installed) or null
      assert.ok(tracer === null || typeof tracer === 'object');
    });

    it('injectTraceHeaders returns object', async () => {
      const { injectTraceHeaders } = await import('../../dist/lib/index.js');
      const headers = injectTraceHeaders();
      assert.strictEqual(typeof headers, 'object');
    });

    it('withSpan executes function and returns result', async () => {
      const { withSpan } = await import('../../dist/lib/index.js');
      const result = await withSpan('test.span', { attr: 'value' }, async () => {
        return 'test-result';
      });
      assert.strictEqual(result, 'test-result');
    });

    it('withSpan propagates errors', async () => {
      const { withSpan } = await import('../../dist/lib/index.js');
      await assert.rejects(
        async () => {
          await withSpan('test.error', {}, async () => {
            throw new Error('test error');
          });
        },
        { message: 'test error' }
      );
    });

    it('addSpanAttributes does not throw without active span', async () => {
      const { addSpanAttributes } = await import('../../dist/lib/index.js');
      // Should not throw even without an active span
      addSpanAttributes({ key: 'value' });
    });

    it('recordSpanException does not throw without active span', async () => {
      const { recordSpanException } = await import('../../dist/lib/index.js');
      // Should not throw even without an active span
      recordSpanException(new Error('test'));
    });
  });

  describe('tracing with OTel configured', () => {
    it('creates spans when tracer is available', async () => {
      const { trace, SpanStatusCode } = await import('@opentelemetry/api');
      const { withSpan, isTracingEnabled } = await import('../../dist/lib/index.js');

      // OTel should be available since it's in devDependencies
      assert.strictEqual(isTracingEnabled(), true);

      let spanCreated = false;
      const originalGetTracer = trace.getTracer;

      // Create a mock tracer to verify span creation
      const mockSpan = {
        setStatus: () => {},
        recordException: () => {},
        end: () => { spanCreated = true; },
      };

      const mockTracer = {
        startActiveSpan: (name, options, fn) => fn(mockSpan),
      };

      // Temporarily override
      trace.getTracer = () => mockTracer;

      try {
        const result = await withSpan('test.span', { foo: 'bar' }, async () => 42);
        assert.strictEqual(result, 42);
        assert.strictEqual(spanCreated, true);
      } finally {
        trace.getTracer = originalGetTracer;
      }
    });
  });
});
