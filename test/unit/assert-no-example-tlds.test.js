/**
 * Unit tests for `assertNoExampleTlds` — the fail-fast startup guard
 * that catches adopters who fork a `hello_*_adapter_*.ts` example and
 * ship without flipping the `KNOWN_PUBLISHERS = ['*.example', …]` seed
 * data outside of dev/test.
 *
 * The helper is wired into each worked example at module load. These
 * tests pin the behavior against the compiled `dist/` output so they
 * exercise what shipped to npm, not the TypeScript source.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const { assertNoExampleTlds } = require('../../dist/lib/server/assert-no-example-tlds');

// NODE_ENV save/restore — the helper reads `process.env.NODE_ENV` at call
// time, so we mutate the live env and restore the original value (which is
// almost always 'test' when running `node --test`).
let originalNodeEnv;

describe('assertNoExampleTlds', () => {
  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  describe('default allowlist behavior', () => {
    it('does not throw when NODE_ENV is "test"', () => {
      process.env.NODE_ENV = 'test';
      assert.doesNotThrow(() => assertNoExampleTlds({ KNOWN_PUBLISHERS: ['acmeoutdoor.example'] }));
    });

    it('does not throw when NODE_ENV is "development"', () => {
      process.env.NODE_ENV = 'development';
      assert.doesNotThrow(() => assertNoExampleTlds({ KNOWN_PUBLISHERS: ['acmeoutdoor.example'] }));
    });

    it('throws when NODE_ENV is "production"', () => {
      process.env.NODE_ENV = 'production';
      assert.throws(
        () => assertNoExampleTlds({ KNOWN_PUBLISHERS: ['acmeoutdoor.example'] }),
        /Adapter forked without flipping example constants/
      );
    });

    it('throws when NODE_ENV is unset (fails closed)', () => {
      delete process.env.NODE_ENV;
      assert.throws(
        () => assertNoExampleTlds({ KNOWN_PUBLISHERS: ['acmeoutdoor.example'] }),
        /Adapter forked without flipping example constants/
      );
    });

    it('throws when NODE_ENV is empty string', () => {
      process.env.NODE_ENV = '';
      assert.throws(
        () => assertNoExampleTlds({ KNOWN_PUBLISHERS: ['acmeoutdoor.example'] }),
        /Adapter forked without flipping example constants/
      );
    });

    it('throws when NODE_ENV is an unknown value like "staging"', () => {
      process.env.NODE_ENV = 'staging';
      assert.throws(
        () => assertNoExampleTlds({ KNOWN_PUBLISHERS: ['acmeoutdoor.example'] }),
        /Adapter forked without flipping example constants/
      );
    });
  });

  describe('detection rules', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('throws when a string value ends with .example', () => {
      assert.throws(
        () => assertNoExampleTlds({ UPSTREAM_HOST: 'api.acmeoutdoor.example' }),
        /UPSTREAM_HOST: api\.acmeoutdoor\.example/
      );
    });

    it('throws when an array contains a .example entry', () => {
      assert.throws(
        () =>
          assertNoExampleTlds({
            KNOWN_PUBLISHERS: ['real-publisher.com', 'acmeoutdoor.example'],
          }),
        /KNOWN_PUBLISHERS: acmeoutdoor\.example/
      );
    });

    it('is case-insensitive (.Example matches)', () => {
      assert.throws(
        () => assertNoExampleTlds({ HOST: 'foo.Example' }),
        /Adapter forked without flipping example constants/
      );
    });

    it('does not flag .example.com (real TLD)', () => {
      // `.example.com` is a real reserved second-level domain (RFC 2606)
      // that adopters legitimately use in demos. Only the `.example` TLD
      // is the smell we're guarding against.
      assert.doesNotThrow(() => assertNoExampleTlds({ PUBLIC_URL: 'https://my-agent.example.com' }));
    });

    it('does not flag substrings that contain "example" mid-string', () => {
      assert.doesNotThrow(() => assertNoExampleTlds({ NOTE: 'see example/path/foo' }));
    });

    it('passes through when no constants match', () => {
      assert.doesNotThrow(() =>
        assertNoExampleTlds({
          KNOWN_PUBLISHERS: ['acmeoutdoor.com', 'premium-sports.io'],
          UPSTREAM_HOST: 'api.acmeoutdoor.com',
          PORT: 3000,
          ENABLED: true,
        })
      );
    });

    it('ignores non-string, non-array values (numbers, booleans, objects)', () => {
      // Adopters may pass adjacent module constants without curating; the
      // helper should not throw on types it doesn't know how to scan.
      assert.doesNotThrow(() =>
        assertNoExampleTlds({
          PORT: 3000,
          ENABLED: true,
          CONFIG: { upstream: 'https://api.acmeoutdoor.example' }, // nested obj — ignored
          NULL_VALUE: null,
          UNDEF_VALUE: undefined,
        })
      );
    });

    it('reports multiple offenders in a single error', () => {
      try {
        assertNoExampleTlds({
          KNOWN_PUBLISHERS: ['acmeoutdoor.example', 'premium-sports.example'],
          UPSTREAM_HOST: 'api.acmeoutdoor.example',
        });
        assert.fail('expected throw');
      } catch (err) {
        assert.match(err.message, /KNOWN_PUBLISHERS: acmeoutdoor\.example/);
        assert.match(err.message, /KNOWN_PUBLISHERS: premium-sports\.example/);
        assert.match(err.message, /UPSTREAM_HOST: api\.acmeoutdoor\.example/);
      }
    });

    it('error message points at FORK CHECKLIST', () => {
      try {
        assertNoExampleTlds({ KNOWN_PUBLISHERS: ['acmeoutdoor.example'] });
        assert.fail('expected throw');
      } catch (err) {
        assert.match(err.message, /FORK CHECKLIST/);
        assert.match(err.message, /NODE_ENV=development or NODE_ENV=test/);
      }
    });
  });

  describe('custom allowIn allowlist', () => {
    it('allows callers to add their own environments', () => {
      process.env.NODE_ENV = 'staging';
      assert.doesNotThrow(() =>
        assertNoExampleTlds({ KNOWN_PUBLISHERS: ['acmeoutdoor.example'] }, { allowIn: ['staging'] })
      );
    });

    it('custom allowlist replaces the default (test no longer allowed)', () => {
      process.env.NODE_ENV = 'test';
      assert.throws(
        () => assertNoExampleTlds({ KNOWN_PUBLISHERS: ['acmeoutdoor.example'] }, { allowIn: ['staging'] }),
        /Adapter forked without flipping example constants/
      );
    });

    it('empty allowlist means assertion always runs', () => {
      process.env.NODE_ENV = 'development';
      assert.throws(
        () => assertNoExampleTlds({ KNOWN_PUBLISHERS: ['acmeoutdoor.example'] }, { allowIn: [] }),
        /Adapter forked without flipping example constants/
      );
    });
  });

  describe('exported from @adcp/sdk/server', () => {
    it('is re-exported from the server barrel', () => {
      const serverBarrel = require('../../dist/lib/server');
      assert.strictEqual(
        typeof serverBarrel.assertNoExampleTlds,
        'function',
        'assertNoExampleTlds must be re-exported from @adcp/sdk/server'
      );
    });
  });
});
