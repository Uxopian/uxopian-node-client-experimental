// The three API surfaces, JWT-authenticated, with the verified quirks baked in.
//  - Core REST  : JSON ARRAYS in/out; single-GETs return array-of-1 (use getOne); `token:` header.
//  - Gateway    : single JSON objects; same `token:` header (live-verified 2026-06-12).
//  - GUI caches : DELETE /gui/rest/caches with the `token:` header.
// Every call has a timeout. Token expires ~1h: transparently re-auth once on 401/expiry.
import { explainError } from './explain.mjs';

/** FlowerDocs "already exists" signals: T00108 (components/documents), F00903 (classes).
 *  Used to HEAL create->update races instead of failing or duplicating (LEARNINGS §25). */
/** FlowerDocs "does not exist" signals carried in 500 bodies (never a 404): F00206 (classes),
 *  F00012 (components/documents/virtualFolder), T00103 (tasks), T01002 (ACLs — "ACL cannot be
 *  got for [id]"). tryGet turns these into null so absent resources classify as CREATE. */
export const ABSENT_CODES = /F00206|F00012|T00103|T01002/;

export const isExistsError = (e) =>
  /T00108|F00903|already exist/i.test(`${e?.body?.code ?? ''} ${e?.message ?? ''}`);

export class HttpError extends Error {
  constructor(status, body, url, method) {
    const gist = typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body)?.slice(0, 300);
    super(`${method} ${url} -> ${status}${gist ? `: ${gist}` : ''}`);
    this.status = status;
    this.body = body;
    this.url = url;
    this.method = method;
    this.explanation = explainError(`${status} ${gist ?? ''}`);
  }
}

/**
 * A request that never became an HTTP response: DNS, TCP, TLS, or a socket closed mid-stream.
 *
 * `fetch` rejects these as a bare `TypeError: terminated`, with the real code buried in `.cause`.
 * That message used to reach the user verbatim — and on `uxc run` it printed exactly where the
 * model's answer goes, so it READ like an answer (#71). A transport failure must announce itself
 * as one, name the endpoint, and say what to look at next.
 */
/**
 * Dig the real errno out of a fetch rejection. undici gives you `TypeError: fetch failed` and hides
 * the useful part one or more levels down `.cause`; a dual-stack connect failure hides it further,
 * inside an AggregateError's `.errors`. Depth-first, first code wins.
 */
function errnoOf(e, depth = 0) {
  if (!e || depth > 5) return '';
  if (typeof e.code === 'string' && e.code) return e.code;
  const nested = errnoOf(e.cause, depth + 1);
  if (nested) return nested;
  for (const sub of e.errors ?? []) {
    const found = errnoOf(sub, depth + 1);
    if (found) return found;
  }
  return '';
}

/** Node/OpenSSL certificate failures. Most carry CERT/SSL/TLS in the code; UNABLE_TO_VERIFY_LEAF_SIGNATURE
 *  (an incomplete chain — the commonest corporate-proxy case) carries none of them (#76). */
const TLS_CODES = /CERT|SSL|TLS|SELF_SIGNED|DEPTH_ZERO|UNABLE_TO_(VERIFY|GET)_|LEAF_SIGNATURE/;

export class NetworkError extends Error {
  constructor(cause, url, method) {
    const code = errnoOf(cause);
    super(`transport failure: ${NetworkError.describe(code)} — ${method} ${url}${code ? ` (${code})` : ''}`);
    this.name = 'NetworkError';
    this.code = code;
    this.url = url;
    this.method = method;
    this.cause = cause;
    this.explanation = NetworkError.advise(code);
  }

  static describe(code) {
    if (/UND_ERR_SOCKET|ECONNRESET|EPIPE/.test(code)) return 'the server closed the connection';
    if (/ECONNREFUSED/.test(code)) return 'nothing is listening there';
    if (/ENOTFOUND|EAI_AGAIN/.test(code)) return 'the host could not be resolved';
    if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/.test(code)) return 'the connection timed out';
    if (TLS_CODES.test(code)) return 'the TLS certificate was rejected';
    return 'the request never completed';
  }

  static advise(code) {
    if (/UND_ERR_SOCKET|ECONNRESET|EPIPE/.test(code)) {
      return 'A socket closed mid-response is a SERVER-side crash, not a client bug: the JVM dropped '
        + 'the connection instead of answering. On a gateway prompt run the usual cause is a failing '
        + 'helper bean inside the prompt (FLOWERDOCS-LEARNINGS §29) — isolate it with a prompt that '
        + 'calls no bean at all. It is also what a malformed streamed body produces, e.g. an IMAGE '
        + 'content item without its `data:<mime>;base64,` prefix (UXOPIAN-AI-LEARNINGS §A19).';
    }
    if (/ECONNREFUSED/.test(code)) return 'Check the target URL and that the server is up: `uxc target ls`, then `uxc doctor --ready`.';
    if (/ENOTFOUND|EAI_AGAIN/.test(code)) return 'Check the hostname in the target (and your DNS/VPN): `uxc target ls`.';
    if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/.test(code)) return 'The host is unreachable — check the VPN, a firewall, or the port.';
    if (TLS_CODES.test(code)) {
      return 'Self-signed, expired, or incompletely chained certificate (UNABLE_TO_VERIFY_LEAF_SIGNATURE = the server '
        + 'does not send its intermediate CA). Trust the CA (NODE_EXTRA_CA_CERTS=<ca.pem>), or use an http target for a local instance.';
    }
    return null;
  }
}

/** A timeout is a real, expected outcome with its own handling (run.mjs stops the conversation) — it
 *  must keep its DOMException identity and NOT be re-dressed as a transport failure. */
const isTimeout = (e) => /TimeoutError|AbortError|aborted due to timeout/i.test(`${e?.name} ${e?.message}`);

const DEFAULT_TIMEOUT = 60_000;

// RATE LIMITS (2026-09-17). fd.demo went down under ~1000 requests/second and now limits each IP to
// 25 requests/second. Everything uxc does from one machine (push, pull, test books, scripts built on
// `connect`) shares that budget, so every request is (1) PACED per process — at most UXC_MAX_RPS per
// second, default 20, 0 disables (an empty or non-numeric value keeps the default) — and (2) RETRIED on
// HTTP 429, honouring Retry-After when the server sends one, otherwise backing off 0.5 s, 1 s, 2 s, 4 s.
// Several uxc processes at once can still exceed the limit together: the pacing keeps each one
// polite, the retry absorbs the overlap.
//
// WHICH 429s are replayed (#76). The ingress limiter refuses a request before any work is done, so
// replaying it is safe whatever the method. A 429 from BEHIND the ingress is not: the uxopian-ai
// gateway may pass an LLM provider's 429 up after a plan/agent run already called tools, and
// re-POSTing would run them again. Offline the two are indistinguishable (same status, maybe the same
// Retry-After), so the rule is by method and surface:
//   - GET/HEAD/OPTIONS, and a FlowerDocs `/rest/<category>/search` POST (a read): always replayed;
//   - POST/PUT/PATCH/DELETE: replayed only on the Core and GUI surfaces, whose 429 is the front
//     limiter (FLOWERDOCS-LEARNINGS §42) — never on the gateway or the fast2 broker, where the 429
//     comes back to the caller as an HttpError instead.
//
// TIMEOUT is per ATTEMPT, not per request: a request retried on 429 can take up to
// (1 + MAX_429_RETRIES) × timeout plus the backoff (5 × 60 s + up to 4 × 30 s with the default).
const DEFAULT_MAX_RPS = 20;
/** UXC_MAX_RPS -> requests/second. Unset, empty, negative or not a number -> the default; "0" disables. */
export function maxRpsFrom(raw) {
  if (raw == null || String(raw).trim() === '') return DEFAULT_MAX_RPS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_RPS;
}
const MAX_RPS = maxRpsFrom(process.env.UXC_MAX_RPS);
const MAX_429_RETRIES = 4;
let nextSlot = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pace() {
  if (!(MAX_RPS > 0)) return;
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + 1000 / MAX_RPS;
  if (at > now) await sleep(at - now);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SEARCH_PATH = /\/rest\/[^/]+\/search$/;
/** May a 429 on this request be replayed? See RATE LIMITS above. `replayWrites` = the surface's 429 is the front limiter. */
export function replayable429(method, url, replayWrites) {
  const m = String(method ?? 'GET').toUpperCase();
  if (SAFE_METHODS.has(m)) return true;
  if (m === 'POST' && SEARCH_PATH.test(new URL(url).pathname)) return true;
  return !!replayWrites;
}

/** How long to wait before retrying a 429: Retry-After (seconds or HTTP date) when present, capped at 30 s; otherwise exponential from 500 ms. */
export function retryDelayMs(retryAfter, attempt) {
  if (retryAfter != null && retryAfter !== '') {
    const secs = Number(retryAfter);
    const ms = Number.isNaN(secs) ? Date.parse(retryAfter) - Date.now() : secs * 1000;
    if (!Number.isNaN(ms)) return Math.min(30_000, Math.max(250, ms));
  }
  return Math.min(8_000, 500 * 2 ** attempt);
}

const MAX_REDIRECTS = 5;

/**
 * fetch with redirects followed by HAND, same origin only. undici's default `redirect: 'follow'`
 * strips Authorization/Cookie on a cross-origin hop but NOT our custom `token:` header, so a 302
 * from the target to another host delivered the Core JWT there (0.23.0 review). A cross-origin
 * Location is not followed: the caller gets the 3xx itself (and reports it as an HTTP error).
 * 303, and 301/302 on a POST, continue as a body-less GET, like a browser.
 */
async function fetchSameOrigin(url, init, timeout) {
  let current = url;
  let req = init;
  for (let hop = 0; ; hop++) {
    const res = await fetch(current, { ...req, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    const loc = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !loc || hop >= MAX_REDIRECTS) return res;
    const next = new URL(loc, current);
    if (next.origin !== new URL(current).origin) return res;
    await res.arrayBuffer().catch(() => undefined);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && req.method === 'POST')) {
      const { body: _dropped, ...rest } = req;
      const headers = { ...rest.headers };
      delete headers['Content-Type'];
      req = { ...rest, method: 'GET', headers };
    }
    current = next.href;
  }
}

async function rawRequest(url, { method = 'GET', headers = {}, body, timeout = DEFAULT_TIMEOUT, replayWrites = false } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined && body !== null) {
    if (body instanceof FormData) init.body = body;
    else if (typeof body === 'string' || body instanceof Uint8Array) init.body = body;
    else {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] ??= 'application/json';
    }
  }
  const t0 = Date.now();
  let res;
  for (let attempt = 0; ; attempt++) {
    await pace();
    try {
      res = await fetchSameOrigin(url, init, timeout);
    } catch (e) {
      if (isTimeout(e)) throw e;
      throw new NetworkError(e, url, method);
    }
    if (res.status !== 429 || attempt >= MAX_429_RETRIES || !replayable429(method, url, replayWrites)) break;
    await res.arrayBuffer().catch(() => undefined);
    await sleep(retryDelayMs(res.headers.get('retry-after'), attempt));
  }
  // the socket can also die while the BODY streams — undici rejects res.text(), not fetch()
  let text;
  try {
    text = await res.text();
  } catch (e) {
    if (isTimeout(e)) throw e;
    // an ERROR status already arrived: keep it (the caller raises an HttpError with the status and
    // the code), and say the body was lost — a NetworkError here hid the 5xx (#76)
    if (res.status >= 400) {
      const code = errnoOf(e);
      text = `(response body lost after HTTP ${res.status}: ${NetworkError.describe(code)}${code ? ` (${code})` : ''})`;
    } else throw new NetworkError(e, url, method);
  }
  // Opt-in request journal for load characterisation: UXC_HTTP_LOG=<file> appends one line per call.
  if (process.env.UXC_HTTP_LOG) {
    try {
      const { appendFileSync } = await import('node:fs');
      const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
      appendFileSync(process.env.UXC_HTTP_LOG, `${new Date().toISOString()}\t${method}\t${path}\t${res.status}\t${Date.now() - t0}\t${text.length}\n`);
    } catch { /* never fail a request because of the journal */ }
  }
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* non-JSON body */ }
  return { status: res.status, text, json, headers: res.headers };
}

/** Connect to a resolved target. Returns { core, gateway, gui, target }. */
export function createClients(target) {
  let token = null;
  let tokenAt = 0;
  const TOKEN_TTL = 50 * 60_000; // re-auth before the ~1h expiry

  async function auth() {
    const r = await rawRequest(`${target.core}/rest/authentication`, {
      method: 'POST', replayWrites: true, // the Core front limiter, and a login has no side effect
      body: { user: target.user, password: target.password, scope: target.scope },
    });
    if (r.status !== 200 || !r.json?.value) {
      throw new HttpError(r.status, r.text, `${target.core}/rest/authentication`, 'POST');
    }
    token = r.json.value;
    tokenAt = Date.now();
    return token;
  }

  async function authed(url, opts = {}) {
    if (!token || Date.now() - tokenAt > TOKEN_TTL) await auth();
    let r = await rawRequest(url, { ...opts, headers: { ...opts.headers, token } });
    if (r.status === 401) { // expired mid-run: one re-auth retry
      await auth();
      r = await rawRequest(url, { ...opts, headers: { ...opts.headers, token } });
    }
    return r;
  }

  /** `replayWrites`: this surface's 429 is the front limiter, so a refused write may be replayed (RATE LIMITS). */
  function surface(base, { arrays, replayWrites = false }) {
    const req = async (method, path, body, opts = {}) => {
      const r = await authed(base + path, { method, body, replayWrites, ...opts });
      if (r.status >= 400) throw new HttpError(r.status, r.json ?? r.text, base + path, method);
      return r;
    };
    const api = {
      base,
      req,
      get: async (path, opts) => (await req('GET', path, undefined, opts)).json,
      post: async (path, body, opts) => (await req('POST', path, body, opts)).json,
      put: async (path, body, opts) => (await req('PUT', path, body, opts)).json,
      del: async (path, body, opts) => (await req('DELETE', path, body, opts)).json,
      /** GET that may 404 -> null instead of throwing.
       *  FlowerDocs signals not-found as a 500, NOT a 404: class endpoints use F00206
       *  ("class do not exist"), component/document endpoints (documents, virtualFolder)
       *  use F00012 ("component does not exist"), and the ACL endpoint uses T01002
       *  ("ACL cannot be got for [id]"). All mean absent -> null (so a brand-new ACL
       *  classifies as create, not a hard error, on push/import). */
      tryGet: async (path, opts) => {
        const r = await authed(base + path, { method: 'GET', replayWrites, ...opts });
        if (r.status === 404) return null;
        if (r.status >= 400 && (ABSENT_CODES.test(r.json?.code ?? '') || ABSENT_CODES.test(r.text ?? ''))) return null;
        if (r.status >= 400) throw new HttpError(r.status, r.json ?? r.text, base + path, 'GET');
        return r.json;
      },
      raw: (method, path, body, opts) => authed(base + path, { method, body, replayWrites, ...opts }),
    };
    if (arrays) {
      /** Core single-GETs return an ARRAY of 1 — unwrap it. null on 404/empty. */
      api.getOne = async (path, opts) => {
        const j = await api.tryGet(path, opts);
        return Array.isArray(j) ? (j[0] ?? null) : j ?? null;
      };
    }
    return api;
  }

  // Core and GUI sit behind the ingress limiter (§42); the gateway may relay an LLM provider's 429
  // after tools already ran, so its writes are never replayed (#76)
  const core = surface(`${target.core}`, { arrays: true, replayWrites: true });
  const gateway = surface(`${target.gateway}`, { arrays: false, replayWrites: false });
  const gui = surface(`${target.gui}`, { arrays: false, replayWrites: true });
  const f2 = target.f2 ? f2Surface(target) : null;

  /** Upload to /core/rest/files/tmp. Fresh tmp per attempt (T00707: failed creates consume the ref). */
  core.uploadTmp = async (bytes, filename, mime = 'application/octet-stream') => {
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type: mime }), filename);
    const j = await core.post('/rest/files/tmp', fd);
    if (!j?.id) throw new Error(`tmp upload returned no id: ${JSON.stringify(j).slice(0, 200)}`);
    return j.id;
  };

  /**
   * Search endpoint per COMPONENT CATEGORY. FlowerDocs does not have one search: each category
   * has its own path, and querying the wrong one answers `found 0` rather than an error — which
   * is how `uxc search PoOrder` reported 0 on a scope holding 39 PoOrder VIRTUAL FOLDERS.
   * Verified live (fd.demo, scope default, 2026-09-10): all four take the SAME body shape and
   * answer the same {found, results:[{id, fields:[{name,value}]}]} envelope; criteria, paging
   * (start/max) and orderClauses behave identically on virtualFolder/search.
   */
  const SEARCH_PATHS = {
    documents: '/rest/documents/search',
    tasks: '/rest/tasks/search',
    virtualfolder: '/rest/virtualFolder/search', // capital F in the path, like every other VF endpoint
    virtual_folder: '/rest/virtualFolder/search',
    vfinstance: '/rest/virtualFolder/search',
    folder: '/rest/folders/search',
    folders: '/rest/folders/search',
  };
  core.SEARCH_PATHS = SEARCH_PATHS;

  /**
   * POST /core/rest/<category>/search with the verified shape.
   * where: { Tag: 'v' | ['a','b'] }  (multi-value EQUALS_TO = OR). classId may be string|string[].
   * Criteria ALWAYS carry type (null type -> 500 T00104). Returns { found, results:[{id, fields:{}}] }.
   */
  core.search = async ({ classId, where = {}, fields = ['name', 'classid'], max = 20, start = 0, order, category = 'documents' }) => {
    const criteria = [];
    if (classId) criteria.push({ name: 'classid', type: 'STRING', operator: 'EQUALS_TO', values: [classId].flat() });
    for (const [name, v] of Object.entries(where)) {
      criteria.push({ name, type: 'STRING', operator: 'EQUALS_TO', values: [v].flat().map(String) });
    }
    const body = {
      selectClause: { fields },
      filterClauses: criteria.length
        ? [{ '@class': 'com.flower.docs.domain.search.AndClause', criteria }]
        : [],
      max, start,
    };
    if (order) {
      const [name, dir] = order.split(':');
      // camelCase creationDate TIMESTAMP works; lowercase fails (learnings §15)
      body.orderClauses = [{ name, type: name === 'creationDate' ? 'TIMESTAMP' : 'STRING', ascending: dir !== 'desc' }];
    }
    const path = SEARCH_PATHS[String(category).toLowerCase()] ?? SEARCH_PATHS.documents;
    const j = await core.post(path, body);
    return {
      found: j?.found ?? 0,
      results: (j?.results ?? []).map((r) => ({
        id: r.id, // rows DO carry a top-level id (verified)
        fields: Object.fromEntries((r.fields ?? []).map((f) => [f.name, f.value])),
      })),
    };
  };

  /** Every hit of a search, paged (the server caps a page; `max` here is the TOTAL cap). */
  core.searchAll = async ({ max = 1000, pageSize = 200, ...rest }) => {
    const results = [];
    let found = 0;
    for (let start = 0; start < max;) {
      const page = await core.search({ ...rest, start, max: Math.min(pageSize, max - start) });
      found = page.found;
      results.push(...page.results);
      start += page.results.length;
      if (!page.results.length || start >= found) break;
    }
    return { found, results };
  };

  /** Read a document (unwrapped) or null. */
  core.getDoc = (id) => core.getOne(`/rest/documents/${encodeURIComponent(id)}`);

  /** Fetch a document file's content (Buffer). Uses the file-id path (the ?index=0 variant 405s). */
  core.getContent = async (docId, fileId) => {
    const doc = fileId ? null : await core.getDoc(docId);
    const fid = fileId ?? doc?.files?.[0]?.id;
    if (!fid) return null;
    const r = await authed(`${target.core}/rest/documents/${encodeURIComponent(docId)}/files/${encodeURIComponent(fid)}/content`, { method: 'GET' });
    if (r.status >= 400) throw new HttpError(r.status, r.text, 'content', 'GET');
    return Buffer.from(r.text, 'utf8');
  };

  /**
   * Upsert a document: exists-check FIRST (T00707), then create (POST array) or
   * GET-merge-POST /{id} update-in-place. `files` = [{bytes, filename, mime, name?}] uploaded fresh.
   */
  core.upsertDoc = async (doc, files = []) => {
    const existing = await core.getDoc(doc.id);
    const fileRefs = [];
    for (const f of files) {
      const tmp = await core.uploadTmp(f.bytes, f.filename, f.mime);
      fileRefs.push(f.name ? { id: tmp, name: f.name } : { id: tmp });
    }
    const updateInPlace = async (server) => {
      const merged = { ...server, ...doc, data: { ...server.data, ...doc.data } };
      if (fileRefs.length) merged.files = fileRefs;
      await core.post(`/rest/documents/${encodeURIComponent(doc.id)}`, [merged]);
      return { action: 'updated', id: doc.id };
    };
    if (existing) return updateInPlace(existing);
    const body = { ...doc };
    if (fileRefs.length) body.files = fileRefs;
    try {
      const created = await core.post('/rest/documents', [body]);
      return { action: 'created', id: created?.[0]?.id ?? doc.id };
    } catch (e) {
      // T00108: the doc appeared between the exists-check and the create (TOCTOU) — the server
      // refused the duplicate id (verified FD 2026). HEAL by updating in place, never duplicate.
      if (!isExistsError(e)) throw e;
      const server = await core.getDoc(doc.id);
      if (!server) throw e; // exists-error but unreadable: surface the original failure
      return updateInPlace(server);
    }
  };

  /** Clear GUI caches (IRIS-Script / IRIS-GUIConfiguration) and Core caches. */
  const cacheClear = async ({ coreToo = true } = {}) => {
    const out = {};
    const g = await gui.raw('DELETE', '/rest/caches');
    out.gui = g.status;
    if (coreToo) {
      const c = await core.raw('DELETE', '/rest/caches');
      out.core = c.status;
    }
    if (out.gui >= 400) throw new HttpError(out.gui, 'GUI cache clear failed — clear manually: Administration > caches, or check JWT-on-/gui verdict (uxc doctor)', `${target.gui}/rest/caches`, 'DELETE');
    return out;
  };

  return { core, gateway, gui, f2, cacheClear, auth, target };
}

/**
 * The fast2 BROKER surface — an independent product with its own user store, its own token loop
 * and a different auth header (FAST2-LEARNINGS §F1-§F3):
 *   - `POST /api/auth/login {email,password}` -> {accessToken,…}, sent as `Authorization: Bearer`.
 *     The password goes PLAINTEXT; the RSA key at /api/auth/public-key is NOT required for login.
 *   - single JSON objects (no Core-style array wrapping); REST lives under `/api`.
 *   - LOCKOUT: 3 failed logins lock the account for 30s. So a failed login is NEVER retried, and
 *     token refresh is rate-limited — a retry storm would lock the operator out of the UI too.
 *   - missing/expired auth answers 403 with a GENERIC body (not 401), so 403 triggers exactly one
 *     re-auth, then gives up.
 */
export function f2Surface(target) {
  const base = String(target.f2).replace(/\/+$/, '');
  const TOKEN_TTL = 3.5 * 60 * 60_000; // access token lives 4h — refresh before that
  const LOGIN_COOLDOWN = 30_000;       // matches security.authentication.lock-time-duration
  let token = null;
  let tokenAt = 0;
  let lastLoginAt = 0;

  async function login() {
    if (!target.f2User || !target.f2Password) {
      throw new Error(
        `target "${target.name}" has a fast2 URL but no credentials (missing: ${[!target.f2User && 'f2User', !target.f2Password && 'f2Password'].filter(Boolean).join(', ')}) — ` +
        'uxc target add … --f2 http://host:1789 --f2-user <email> --f2-password <p> (env: UXC_F2_USER / UXC_F2_PASSWORD)',
      );
    }
    const since = Date.now() - lastLoginAt;
    if (lastLoginAt && since < LOGIN_COOLDOWN) {
      throw new Error(
        `refusing to re-authenticate to fast2 ${Math.ceil((LOGIN_COOLDOWN - since) / 1000)}s after the last attempt — ` +
        'fast2 locks an account after 3 failed logins (30s); a retry storm would lock you out of the UI too',
      );
    }
    lastLoginAt = Date.now();
    const r = await rawRequest(`${base}/api/auth/login`, {
      method: 'POST',
      body: { email: target.f2User, password: target.f2Password },
    });
    if (r.status !== 200 || !r.json?.accessToken) {
      const e = new HttpError(r.status, r.json ?? r.text, `${base}/api/auth/login`, 'POST');
      e.explanation = 'fast2 login failed — check --f2-user/--f2-password. After 3 failures the '
        + 'account locks for 30s (GET /api/auth/remaining-attempts?email=… introspects it).';
      throw e;
    }
    token = r.json.accessToken;
    tokenAt = Date.now();
    return token;
  }

  async function authed(url, opts = {}) {
    if (!token || Date.now() - tokenAt > TOKEN_TTL) await login();
    const hdr = () => ({ ...opts.headers, Authorization: `Bearer ${token}` });
    let r = await rawRequest(url, { ...opts, headers: hdr() });
    if (r.status === 401 || r.status === 403) { // expired mid-run: ONE re-auth retry, then give up
      await login();
      r = await rawRequest(url, { ...opts, headers: hdr() });
    }
    return r;
  }

  const req = async (method, path, body, opts = {}) => {
    const r = await authed(base + path, { method, body, ...opts });
    if (r.status >= 400) throw new HttpError(r.status, r.json ?? r.text, base + path, method);
    return r;
  };
  return {
    base,
    login,
    req,
    get: async (path, opts) => (await req('GET', path, undefined, opts)).json,
    post: async (path, body, opts) => (await req('POST', path, body, opts)).json,
    put: async (path, body, opts) => (await req('PUT', path, body, opts)).json,
    del: async (path, body, opts) => (await req('DELETE', path, body, opts)).json,
    /** GET that treats 404 as absent -> null (fast2 uses real 404s, unlike FD's 500+code). */
    tryGet: async (path, opts) => {
      const r = await authed(base + path, { method: 'GET', ...opts });
      if (r.status === 404) return null;
      if (r.status >= 400) throw new HttpError(r.status, r.json ?? r.text, base + path, 'GET');
      return r.json;
    },
    raw: (method, path, body, opts) => authed(base + path, { method, body, ...opts }),
    /** Text/binary GET (map .map.xml download returns application/octet-stream). */
    text: async (path, opts) => (await req('GET', path, undefined, opts)).text,
  };
}
