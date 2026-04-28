/**
 * CLI startup staleness check.
 *
 * Unpinned `npx @adcp/sdk` reuses whatever version is cached in
 * ~/.npm/_npx/ — users run months-old code without knowing. Doc pins
 * to `@latest` fix the copy-paste path; this catches every other way
 * stale code lands (global installs, locked package.json, corporate
 * forks, pnpm dlx cache).
 *
 * Runs once per 24h via a cache file. Fails silent on any network or
 * filesystem hiccup — a staleness warning must never break a CLI call.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const CONFIG_DIR = path.join(os.homedir(), '.adcp');
const CACHE_FILE = path.join(CONFIG_DIR, 'version-check.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 800;
const REGISTRY_URL = 'https://registry.npmjs.org/@adcp/sdk/latest';

function shouldSkipCheck() {
  if (process.env.ADCP_SKIP_VERSION_CHECK === '1') return true;
  if (process.env.CI === 'true' || process.env.CI === '1') return true;
  if (!process.stderr.isTTY) return true;
  if (process.argv.includes('--json')) return true;
  return false;
}

function readCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.latestVersion !== 'string') return null;
    if (typeof parsed?.checkedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(latestVersion) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ latestVersion, checkedAt: Date.now() }), 'utf8');
  } catch {
    /* fail silent */
  }
}

function fetchLatest() {
  return new Promise(resolve => {
    const req = https.get(REGISTRY_URL, { headers: { accept: 'application/json' }, timeout: FETCH_TIMEOUT_MS }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        // Abort runaway responses — the registry's `latest` entry is ~2KB.
        if (body.length > 64 * 1024) req.destroy();
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve(typeof parsed.version === 'string' ? parsed.version : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

// Semver ordering without a dep: compare numeric segments of the leading
// `x.y.z`. Pre-release suffixes are treated as equal to the base release,
// which is the right call for a staleness nudge — we don't want to tell a
// user on 5.13.0 that 5.14.0-next.3 is "newer" and they should upgrade.
function compareVersions(a, b) {
  const parse = v =>
    v
      .split('-')[0]
      .split('.')
      .map(n => parseInt(n, 10));
  const aa = parse(a);
  const bb = parse(b);
  for (let i = 0; i < 3; i++) {
    const x = aa[i] ?? 0;
    const y = bb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function printStaleWarning(current, latest) {
  process.stderr.write(
    `\n⚠️  Running @adcp/sdk ${current} — latest is ${latest}.\n` +
      `   Upgrade with \`npx @adcp/sdk@latest …\` (or clear \`~/.npm/_npx\` if you copy-pasted commands without the @latest pin).\n` +
      `   Silence this check with ADCP_SKIP_VERSION_CHECK=1.\n\n`
  );
}

/**
 * Schedule a staleness check. Returns immediately — the actual network
 * fetch (if needed) runs on `process.nextTick` so command dispatch is
 * never blocked. The warning, if any, prints to stderr before the
 * process exits naturally.
 */
function scheduleVersionCheck(currentVersion) {
  if (shouldSkipCheck()) return;

  const cache = readCache();
  const fresh = cache && Date.now() - cache.checkedAt < CACHE_TTL_MS;

  if (fresh) {
    if (compareVersions(currentVersion, cache.latestVersion) < 0) {
      printStaleWarning(currentVersion, cache.latestVersion);
    }
    return;
  }

  // Stale cache or no cache — fetch in the background. The command is
  // already running; we just want to catch the warning before exit if
  // we can, and otherwise refresh the cache for the next invocation.
  process.nextTick(async () => {
    const latest = await fetchLatest();
    if (!latest) return;
    writeCache(latest);
    if (compareVersions(currentVersion, latest) < 0) {
      printStaleWarning(currentVersion, latest);
    }
  });
}

module.exports = { scheduleVersionCheck };
