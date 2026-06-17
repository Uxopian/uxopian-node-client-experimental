// Pulse Addons Marketplace client — the publisher/browse HTTP surface (PULSE-MARKETPLACE-SPEC.md).
// Zero-dep: built-in fetch, bearer auth, timeouts. Mirrors the §6 (write) / §7 (read) contract.
//
// Pulse owns browse + download; Claude/uxc owns ALL create/update/version/lifecycle. This client
// is what `uxc mp …` codes against. The staged publish flow (create draft -> upload to signed
// URLs -> finalize) lives in lib/commands/mp-publish.mjs; this module is the thin transport.

const DEFAULT_TIMEOUT = 120_000;

const CONTENT_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', md: 'text/markdown', txt: 'text/plain', html: 'text/html', htm: 'text/html',
  pdf: 'application/pdf', json: 'application/json', uxpkg: 'application/zip', zip: 'application/zip',
};
/** Guess a Content-Type from a filename extension (for signed-URL uploads). */
export function contentTypeFor(filename) {
  const ext = String(filename).toLowerCase().split('.').pop();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

export class MarketplaceError extends Error {
  constructor(status, body, method, url) {
    const err = body && typeof body === 'object' ? body.error ?? body : null;
    const code = err?.code ?? `http_${status}`;
    const msg = err?.message ?? (typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body)?.slice(0, 300));
    super(`marketplace ${method} ${url} -> ${status} [${code}]${msg ? `: ${msg}` : ''}`);
    this.status = status;
    this.code = code;
    this.body = body;
    this.explanation = EXPLAIN[code] ?? null;
  }
}

const EXPLAIN = {
  unauthorized: 'API key missing/invalid/revoked — re-run `uxc mp login` with a current key.',
  forbidden: 'maintainer inactive or not allowed — ask a marketplace admin.',
  artifact_changed: 'this version already exists with DIFFERENT package content — bump `version` in uxopian-project.json. (Metadata-only fixes — compatibility, changelog, screenshots — re-publish the SAME version in place.)',
  version_exists: 'that version already exists. On the artifact-hash model a same-package re-publish edits in place; if the server still rejects, the package content changed — bump `version` in uxopian-project.json.',
  artifact_integrity: 'uploaded artifact failed the sha256/size check — re-run publish (the upload was incomplete or corrupted).',
  category_unknown: 'category not in the marketplace vocabulary — pick a known one (`uxc mp categories`) or ask an admin to add it.',
  validation_failed: 'the listing/version payload was rejected — fix the reported field(s) in marketplace.json.',
};

async function rawRequest(url, { method = 'GET', headers = {}, body, timeout = DEFAULT_TIMEOUT, redirect = 'follow' } = {}) {
  const init = { method, headers: { ...headers }, redirect, signal: AbortSignal.timeout(timeout) };
  if (body !== undefined && body !== null) {
    if (typeof body === 'string' || body instanceof Uint8Array || body instanceof ArrayBuffer) init.body = body;
    else { init.body = JSON.stringify(body); init.headers['content-type'] ??= 'application/json'; }
  }
  const res = await fetch(url, init);
  return res;
}

/**
 * Build a client bound to a resolved marketplace config. The live deployment is three edge
 * functions, each its own API root (routes append directly):
 *   url         -> marketplace-publish  (writes + whoami)
 *   browseUrl   -> marketplace-browse   (reads)
 *   downloadUrl -> marketplace-download (artifact 302)
 * browseUrl/downloadUrl fall back to url for single-root deployments.
 */
export function createMarketplaceClient({ url, browseUrl, downloadUrl, token } = {}) {
  const roots = {
    write: String(url || '').replace(/\/+$/, ''),
    read: String(browseUrl || url || '').replace(/\/+$/, ''),
    download: String(downloadUrl || url || '').replace(/\/+$/, ''),
  };
  const base = roots.write; // display
  const authHeaders = token ? { authorization: `Bearer ${token}` } : {};

  async function call(method, path, body, { raw = false, root = 'write' } = {}) {
    const full = path.startsWith('http') ? path : roots[root] + path;
    const res = await rawRequest(full, { method, headers: authHeaders, body });
    if (raw) return res;
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { /* non-JSON */ }
    if (res.status >= 400) throw new MarketplaceError(res.status, json ?? text, method, full);
    return json;
  }

  const qs = (params = {}) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v == null || v === '') continue;
      for (const one of Array.isArray(v) ? v : [v]) u.append(k, String(one));
    }
    const s = u.toString();
    return s ? `?${s}` : '';
  };
  const enc = encodeURIComponent;

  return {
    base, roots,

    // ---- marketplace-publish (writes + whoami) — methods verified live against the deployment ----
    whoami: () => call('GET', '/whoami'),
    upsertAddon: (slug, listing) => call('PUT', `/addons/${enc(slug)}`, listing),
    createVersion: (slug, version) => call('POST', `/addons/${enc(slug)}/versions`, version),
    finalizeVersion: (slug, version, body = {}) =>
      call('POST', `/addons/${enc(slug)}/versions/${enc(version)}/finalize`, body),
    setVersionStatus: (slug, version, body) =>
      call('POST', `/addons/${enc(slug)}/versions/${enc(version)}/status`, body),
    // archive isn't in the current deployment's route map; kept for forward-compat (404s today).
    archiveAddon: (slug) => call('DELETE', `/addons/${enc(slug)}`),

    // ---- marketplace-browse (reads) ----
    categories: () => call('GET', '/categories', undefined, { root: 'read' }),
    listAddons: (params = {}) => call('GET', `/addons${qs(params)}`, undefined, { root: 'read' }),
    getAddon: (slug) => call('GET', `/addons/${enc(slug)}`, undefined, { root: 'read' }),
    getVersion: (slug, version) => call('GET', `/addons/${enc(slug)}/versions/${enc(version)}`, undefined, { root: 'read' }),

    // ---- marketplace-download (artifact 302 -> signed Storage URL) ----
    async downloadArtifact(slug, version) {
      const path = `/addons/${enc(slug)}/versions/${enc(version)}/download`;
      const res = await call('GET', path, undefined, { raw: true, root: 'download' });
      if (res.status >= 400) {
        const text = await res.text();
        let json; try { json = JSON.parse(text); } catch { /* */ }
        throw new MarketplaceError(res.status, json ?? text, 'GET', roots.download + path);
      }
      return Buffer.from(await res.arrayBuffer());
    },

    /**
     * PUT/POST raw bytes to a signed upload URL returned by createVersion.
     * `upload` = { url, method, headers } from the server; bytes = Buffer/Uint8Array.
     */
    async uploadToSignedUrl(upload, bytes) {
      const res = await rawRequest(upload.url, {
        method: upload.method || 'PUT',
        headers: upload.headers || {},
        body: bytes,
      });
      if (res.status >= 400) {
        const text = await res.text().catch(() => '');
        throw new MarketplaceError(res.status, text || '(no body)', upload.method || 'PUT', upload.url);
      }
      return { status: res.status };
    },
  };
}
