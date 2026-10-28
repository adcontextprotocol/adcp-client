import { createWebBotAuthFetch, type WebBotSigningKey, type WebBotSigningOptions } from '../../signing/web-bot-auth';

/** Sign the public HTTPS target while the official transport delivers to loopback. */
export function createStoryboardWebBotAuthFetch(
  upstream: typeof fetch,
  key: WebBotSigningKey,
  options: WebBotSigningOptions & {
    /** Pin the destination origin for direct HTTPS delivery. */
    agentUrl?: string;
    target?: { publicUrl: string; loopbackUrl: string };
  }
): typeof fetch {
  const deliver: typeof fetch = async (input, init) => {
    const response = await upstream(input, { ...init, redirect: 'manual' });
    // Official transports can implement redirect following outside fetch.
    // Stop here so they cannot replay a signed body or request another signature.
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.has('location')) {
      await response.body?.cancel();
      throw new TypeError('Web Bot Auth storyboard requests do not follow HTTP redirects');
    }
    return response;
  };
  if (!options.target) {
    if (!options.agentUrl) throw new TypeError('Direct Web Bot Auth storyboard signing requires agentUrl');
    const agentUrl = new URL(options.agentUrl);
    if (agentUrl.protocol !== 'https:' || agentUrl.username || agentUrl.password || agentUrl.hash)
      throw new TypeError(
        'Direct Web Bot Auth storyboard signing requires an HTTPS agentUrl without credentials or fragments'
      );
    const signed = createWebBotAuthFetch(deliver, key, options);
    return (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      // The official transport may follow redirects outside its trusted fetch.
      // Refuse a redirected or metadata-derived origin before signing again.
      if (new URL(url).origin !== agentUrl.origin)
        return Promise.reject(new TypeError('Web Bot Auth storyboard refused a different agent origin'));
      return signed(input, init);
    };
  }
  const publicUrl = new URL(options.target.publicUrl);
  const localUrl = new URL(options.target.loopbackUrl);
  if (
    publicUrl.protocol !== 'https:' ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.hash ||
    publicUrl.search ||
    !['http:', 'https:'].includes(localUrl.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(localUrl.hostname) ||
    localUrl.username ||
    localUrl.password ||
    localUrl.hash ||
    localUrl.search
  )
    throw new TypeError(
      'Web Bot Auth test delivery requires a public HTTPS URL and a loopback URL without credentials, query or fragment'
    );
  const signed = createWebBotAuthFetch(
    async (input, init) => {
      const target = new URL(String(input));
      if (target.origin !== publicUrl.origin || target.pathname !== publicUrl.pathname)
        throw new TypeError('Web Bot Auth test delivery refused a different public endpoint');
      const destination = new URL(localUrl);
      destination.search = target.search;
      return deliver(destination.href, init);
    },
    key,
    options
  );
  return async (input, init) => {
    if (input instanceof Request) throw new TypeError('Web Bot Auth test delivery requires a URL and init');
    const source = new URL(String(input));
    if (source.origin !== localUrl.origin || source.pathname !== localUrl.pathname)
      throw new TypeError('Web Bot Auth test delivery refused a different loopback endpoint');
    const target = new URL(publicUrl);
    target.search = source.search;
    return signed(target.href, init);
  };
}
