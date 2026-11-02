// The server's HTML import map also catalogs immutable data/CSS/classic-script URLs.
// Only these exact same-origin content versions use the native HTTP cache; API/media/SW semantics stay separate.
const HASH = /^[a-f0-9]{64}$/;

/** Pure resolver, exposed for protocol/cache tests without a browser global. */
export function createRuntimeResolver(imports = {}, base = 'http://runtime.invalid/') {
  return (input) => {
    if (typeof input !== 'string') return input;
    try {
      const url = new URL(input, base);
      if (url.origin !== new URL(base).origin) return input;
      const mapped = imports[url.pathname];
      if (typeof mapped !== 'string') return input;
      const pinned = new URL(mapped, base);
      const hash = pinned.searchParams.get('rv');
      if (pinned.origin !== url.origin || pinned.pathname !== url.pathname || !HASH.test(hash)) return input;
      url.searchParams.set('rv', hash);
      return url.pathname + url.search + url.hash;
    } catch { return input; }
  };
}

let resolver;
export function runtimeURL(input) {
  if (!resolver) {
    let imports = {};
    try { imports = JSON.parse(globalThis.document?.querySelector('script[type="importmap"]')?.textContent || '{}').imports || {}; }
    catch { /* An ordinary fixture / older server continues with its original no-cache URLs. */ }
    resolver = createRuntimeResolver(imports, globalThis.document?.baseURI || globalThis.location?.href);
  }
  return resolver(input);
}

export function runtimeCacheMode(url) {
  try { return HASH.test(new URL(url, 'http://runtime.invalid/').searchParams.get('rv')) ? 'default' : 'no-cache'; }
  catch { return 'no-cache'; }
}
