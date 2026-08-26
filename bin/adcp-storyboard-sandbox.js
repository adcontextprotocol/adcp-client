'use strict';

/**
 * Translate storyboard CLI routing flags into runner options.
 * Omitted flags intentionally preserve the historical undefined sandbox mode.
 */
function sandboxRunOptions(options = {}) {
  if (options.sandbox && options.noSandbox) {
    throw new Error('--sandbox and --no-sandbox are mutually exclusive');
  }
  if (options.sandbox) return { sandbox: true };
  if (options.noSandbox) return { sandbox: false, disable_sandbox: true };
  return {};
}

module.exports = { sandboxRunOptions };
