// `@adcp/sdk/version`: the AdCP protocol and library version constants and the
// version-resolution helpers, without loading the package root.
//
// Every name here is exported by `@adcp/sdk` under the same name, from the same
// source module. Add a name here only when the root exports it under the same
// name (`test/lib/runtime-subpaths.test.js` enforces this).

export {
  getAdcpVersion,
  getLibraryVersion,
  isCompatibleWith,
  getCompatibleVersions,
  parseAdcpMajorVersion,
  ADCP_VERSION,
  ADCP_MAJOR_VERSION,
  LIBRARY_VERSION,
  COMPATIBLE_ADCP_VERSIONS,
  VERSION_INFO,
} from '../version';
export type { AdcpVersion } from '../version';
export {
  listBundledAdcpVersions,
  resolveAdcpVersion,
  isAdcpVersionAtLeast,
  sellerAdvertises31,
  shouldOmit31Fields,
} from '../utils/adcp-version-config';
