/** The exact protocol-method grammar in the AdCP 3.2 capability schema. */
export function isSigningProtocolMethod(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 256 &&
    value !== 'tools/call' &&
    !/[^A-Za-z0-9_/]/.test(value) &&
    /^(?:[a-z][A-Za-z0-9_]*(?:\/[A-Za-z][A-Za-z0-9_]*)+|[A-Z][A-Za-z0-9_]*)$/.test(value)
  );
}

/** Seller data must never turn exact membership into string substring matching. */
export function signingListIncludes(list: unknown, value: string): boolean {
  return Array.isArray(list) && list.some(item => typeof item === 'string' && item === value);
}

export function assertProtocolMethodOverrides(value: unknown): void {
  if (value !== undefined && (!Array.isArray(value) || !value.every(isSigningProtocolMethod))) {
    throw new TypeError(
      'always_sign_protocol_methods must be an array of exact slash-path or PascalCase JSON-RPC methods; tools/call and AdCP operation names are not allowed'
    );
  }
}

/** Internal functional-runner policy, retained by configuration snapshots. */
const UNSIGNED_CAPABILITY_BOOTSTRAP = Symbol.for('@adcp/sdk.unsignedCapabilityBootstrap');

export function withUnsignedCapabilityBootstrap<T extends object>(config: T): T {
  return { ...config, [UNSIGNED_CAPABILITY_BOOTSTRAP]: true };
}

export function hasUnsignedCapabilityBootstrap(config: object): boolean {
  return (config as { [UNSIGNED_CAPABILITY_BOOTSTRAP]?: boolean })[UNSIGNED_CAPABILITY_BOOTSTRAP] === true;
}

export function assertSigningPolicy(config: {
  always_sign?: unknown;
  sign_supported?: unknown;
  always_sign_protocol_methods?: unknown;
}): void {
  if (
    config.always_sign !== undefined &&
    (!Array.isArray(config.always_sign) || !config.always_sign.every(value => typeof value === 'string'))
  ) {
    throw new TypeError('always_sign must be an array of AdCP operation names');
  }
  if (config.sign_supported !== undefined && typeof config.sign_supported !== 'boolean') {
    throw new TypeError('sign_supported must be a boolean');
  }
  assertProtocolMethodOverrides(config.always_sign_protocol_methods);
}
