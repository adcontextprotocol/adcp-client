#!/usr/bin/env tsx

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  adcp_version: string;
  engines?: { node?: string };
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};
const versionSource = readFileSync(path.join(root, 'src/lib/version.ts'), 'utf8');
const compatibleMatch = versionSource.match(/export const COMPATIBLE_ADCP_VERSIONS = \[([\s\S]*?)\] as const;/);
if (!compatibleMatch) throw new Error('Unable to read COMPATIBLE_ADCP_VERSIONS from src/lib/version.ts');
const compatibleVersions = [...compatibleMatch[1].matchAll(/'([^']+)'/g)].map(match => match[1]);

const integrity = `registry-derived after publication; run \`npm view ${pkg.name}@${pkg.version} dist.integrity\``;

const requiredPeers = Object.entries(pkg.peerDependencies ?? {})
  .map(
    ([name, range]) =>
      `| \`${name}\` | \`${range}\` | ${pkg.peerDependenciesMeta?.[name]?.optional === true ? 'Optional' : 'Required'} |`
  )
  .join('\n');
const document = `# SDK 14 release-bound upgrade worksheet

This page joins the release facts that adopters need before changing a production pin. It is generated from package and version metadata with \`npm run generate-release-worksheet\`; migration decisions remain documented in [Migrating from 13.x to the 14 prerelease](./migration-13-to-14.md).

## Release represented by this checkout

The changesets version lifecycle regenerates this section whenever the package
version changes. For an unpublished candidate, integrity is intentionally shown
as unavailable until the registry assigns it; use the exact registry command
below as the publication/deployment gate.

| Fact | Value |
| --- | --- |
| Exact npm package | \`${pkg.name}@${pkg.version}\` |
| npm integrity | ${integrity} |
| Node.js runtime | \`${pkg.engines?.node ?? 'not declared'}\` |
| Default AdCP wire release | \`${pkg.adcp_version}\` |
| Maintained wire releases | ${compatibleVersions.map(version => `\`${version}\``).join(', ')} |
| Canonical migration notes | [13.x → 14](./migration-13-to-14.md) |

Install exact production inputs rather than a moving prerelease range:

\`\`\`bash
npm install --save-exact '${pkg.name}@${pkg.version}'
npm view '${pkg.name}@${pkg.version}' dist.integrity
\`\`\`

### Required and optional peers

Install the peer packages used by your application at versions satisfying these release ranges. A2A and MCP calls continue to use their official protocol clients.

| Peer | Supported range | Installation |
| --- | --- | --- |
${requiredPeers}

## Historical worked example: rc.33/rc.35 → rc.36

This example is intentionally retained as the concrete migration that introduced
the rc.2 wire pin; it does not change when a later SDK candidate is released.

1. Change the exact SDK pin from \`14.0.0-rc.33\` or \`14.0.0-rc.35\` to \`14.0.0-rc.36\` and verify that historical release with \`npm view @adcp/sdk@14.0.0-rc.36 dist.integrity\`.
2. Upgrade communicating 3.2 peers together. rc.33 and rc.35 defaulted to AdCP \`3.2.0-rc.1\`; rc.36 defaults to \`3.2.0-rc.2\` and no longer advertises the superseded rc.1 pin as compatible.
3. Preserve an existing server's explicit \`defaultAdcpVersion\`. Raising the supported ceiling to rc.2 must not silently move unversioned callers off the release the application chose to serve by default.
4. Audit durable idempotency records containing malformed lone UTF-16 surrogates. rc.36 preserves distinct malformed payloads in request fingerprints, so a request that previously collided may now correctly return an idempotency conflict. Well-formed request fingerprints do not change.
5. Run mixed-version integration coverage for every release your deployment still advertises, then deploy all rc.2-speaking peers before sending rc.2-only payloads.

The complete behavioral inventory, including server-default separation and A2A 1.0 peer requirements, is in the [13.x → 14 migration guide](./migration-13-to-14.md).
`;

writeFileSync(path.join(root, 'docs/migration-14.x-rc-worksheet.md'), document);
console.log(`Wrote docs/migration-14.x-rc-worksheet.md for ${pkg.name}@${pkg.version}`);
