#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import semver from 'semver';

const policy = new Map([
  [6, { node: '18.17.0', secure: '6.28.0' }],
  [7, { node: '20.18.1', secure: '7.29.0' }],
]);
const sdkNodeRange = '^20.19.0 || >=22.12.0';

export function checkRuntimeCompatibility(nodeRange, undiciRange) {
  if (typeof nodeRange !== 'string' || typeof undiciRange !== 'string') {
    throw new Error('package.json must declare both engines.node and dependencies.undici');
  }

  const nodeFloor = semver.minVersion(nodeRange);
  const undiciFloor = semver.minVersion(undiciRange);
  if (!nodeFloor || !undiciFloor) throw new Error('Unable to determine Node/Undici version floors');
  if (!semver.subset(nodeRange, sdkNodeRange)) {
    throw new Error(`Node range ${nodeRange} is not contained by the SDK runtime policy ${sdkNodeRange}`);
  }

  const selected = policy.get(undiciFloor.major);
  if (!selected) throw new Error(`Undici ${undiciFloor.major}.x has no reviewed runtime policy`);
  const reviewedRange = `>=${selected.secure} <${undiciFloor.major + 1}.0.0`;
  if (!semver.subset(undiciRange, reviewedRange)) {
    throw new Error(
      `Undici range ${undiciRange} is not contained by the reviewed ${undiciFloor.major}.x policy ${reviewedRange}`
    );
  }
  if (semver.lt(nodeFloor, selected.node)) {
    throw new Error(
      `engines.node floor ${nodeFloor.version} is incompatible with Undici ${undiciFloor.major}.x ` +
        `(requires Node >=${selected.node})`
    );
  }

  return (
    `Runtime policy OK: Node ${nodeRange}, Undici ${undiciRange} ` +
    `(floors ${nodeFloor.version} / ${undiciFloor.version})`
  );
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const root = path.resolve(path.dirname(scriptPath), '..');
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  console.log(checkRuntimeCompatibility(pkg.engines?.node, pkg.dependencies?.undici));
}
