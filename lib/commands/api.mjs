// uxc api <METHOD> <path> — a raw, SAFE passthrough to one of the target's API surfaces
// (BACKLOG-AGENTIC §27 item 3, #96).
//
// Agents fall back to hand-written `curl` with a copied token for every endpoint uxc has no command
// for. This replaces that curl with the target's own clients, so the long tail inherits what the
// verified commands already get:
//   - auth: the Core JWT (`token:` header) on core|gui|ai, the fast2 Bearer on f2 — never printed;
//   - pacing + 429 retry (FLOWERDOCS-LEARNINGS §42) and the request timeout (lib/http.mjs);
//   - the lock: GET/HEAD/OPTIONS and a POST to a FlowerDocs `/rest/<x>/search` are reads; every
//     other call is a WRITE — refused without --yes,
//     serialised on the target, and subject to the package's target pin exactly like push;
//   - the error knowledge base: a 4xx/5xx body carrying F00903, T00104… is explained.
//
// It is deliberately NOT a generated command surface: FlowerDocs mechanics (array bodies, id in
// path, cache clear, handler rotation) belong in verified adapters. `api` is for reading around and
// for one-off calls whose shape you already checked in the learnings.
import { readFileSync } from 'node:fs';
import { explainError } from '../explain.mjs';
import { collectRepeatedFlag } from '../util.mjs';
import { fail } from '../output.mjs';
import { isReadMethod, isReadCall, apiLockMode } from '../cli-meta.mjs';

export const SURFACES = ['core', 'gui', 'ai', 'f2'];
const METHOD_RE = /^[A-Za-z]+$/;

// the lock mode lives with the other audited modes (lib/cli-meta.mjs); re-exported for callers
export { isReadMethod, isReadCall, apiLockMode };

/**
 * Pick the surface and the path relative to its base.
 *   --surface wins; a leading prefix matching that surface ('/core', '/gui') is stripped.
 *   Otherwise from the path:
 *     full URL under one of the target's bases        -> that surface (longest base wins)
 *     …/gateway/uxopian-ai/…  or  /uxopian-ai/…       -> ai (rest after `uxopian-ai`)
 *     /core/…                                         -> core (prefix stripped)
 *     /gui/…                                          -> gui  (prefix stripped)
 *     /api/v1/…                                       -> ai   (the gateway's REST root)
 *     /api/…                                          -> f2   (the fast2 broker's REST root)
 *     anything else (/rest/…)                         -> core
 * -> { surface, path, inferred }
 */
export function resolveSurface(rawPath, { surface, target } = {}) {
  let p = String(rawPath ?? '');
  if (surface && !SURFACES.includes(surface)) {
    throw new Error(`unknown --surface "${surface}" — expected one of ${SURFACES.join('|')}`);
  }
  if (/^https?:\/\//i.test(p)) {
    const bases = [
      ['ai', target?.gateway], ['core', target?.core], ['gui', target?.gui], ['f2', target?.f2],
    ].filter(([, b]) => b).map(([s, b]) => [s, String(b).replace(/\/+$/, '')])
      .sort((a, b) => b[1].length - a[1].length);
    const hit = bases.find(([s, b]) => (!surface || s === surface) && (p === b || p.startsWith(`${b}/`) || p.startsWith(`${b}?`)));
    if (!hit) throw new Error(`${p} is not under any base of target "${target?.name ?? '?'}" — pass a path relative to a surface (see: uxc target ls)`);
    return { surface: hit[0], path: p.slice(hit[1].length) || '/', inferred: !surface };
  }
  if (!p.startsWith('/')) p = `/${p}`;
  const strip = (prefix) => (p === prefix ? '/' : p.startsWith(`${prefix}/`) || p.startsWith(`${prefix}?`) ? p.slice(prefix.length) : p);
  if (surface) {
    if (surface === 'core') return { surface, path: strip('/core'), inferred: false };
    if (surface === 'gui') return { surface, path: strip('/gui'), inferred: false };
    if (surface === 'ai') {
      const m = p.match(/\/uxopian-ai(\/.*)?$/);
      return { surface, path: m ? (m[1] || '/') : p, inferred: false };
    }
    return { surface, path: p, inferred: false };
  }
  const ai = p.match(/^(?:\/gui\/plugins\/[^/]+\/gateway)?\/uxopian-ai(\/.*)?$/);
  if (ai) return { surface: 'ai', path: ai[1] || '/', inferred: true };
  if (/^\/core(\/|\?|$)/.test(p)) return { surface: 'core', path: strip('/core'), inferred: true };
  if (/^\/gui(\/|\?|$)/.test(p)) return { surface: 'gui', path: strip('/gui'), inferred: true };
  if (/^\/api\/v1(\/|\?|$)/.test(p)) return { surface: 'ai', path: p, inferred: true };
  if (/^\/api(\/|\?|$)/.test(p)) return { surface: 'f2', path: p, inferred: true };
  return { surface: 'core', path: p, inferred: true };
}

/** Append k=v pairs to a path (keeps an existing query string). */
export function withQuery(path, pairs = []) {
  if (!pairs.length) return path;
  const qs = new URLSearchParams();
  for (const kv of pairs) {
    const eq = String(kv).indexOf('=');
    if (eq < 1) throw new Error(`bad --query "${kv}" — expected name=value`);
    qs.append(kv.slice(0, eq), kv.slice(eq + 1));
  }
  return `${path}${path.includes('?') ? '&' : '?'}${qs}`;
}

/** --header k=v (or "K: v") pairs -> an object. */
export function parseHeaders(pairs = []) {
  const out = {};
  for (const kv of pairs) {
    const m = String(kv).match(/^([^=:\s]+)\s*[=:]\s*(.*)$/);
    if (!m) throw new Error(`bad --header "${kv}" — expected name=value`);
    out[m[1]] = m[2];
  }
  return out;
}

// by NAME, substring, case-insensitive: X-Auth-Token, X-Api-Key, X-Session-Id, Client-Secret… (#103)
const SECRET_HEADER = /token|auth|key|secret|passw|cookie|session/i;

/** Copy of `headers` safe to print: credentials replaced by <redacted>. */
export function redactHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[k] = SECRET_HEADER.test(k) ? '<redacted>' : v;
  return out;
}

/** The response headers worth showing (never cookies or credentials). */
const SHOWN_RESPONSE_HEADERS = ['content-type', 'content-length', 'location', 'retry-after', 'etag', 'last-modified', 'x-request-id'];
export function responseHeaderSubset(headers) {
  const out = {};
  for (const h of SHOWN_RESPONSE_HEADERS) {
    const v = headers?.get ? headers.get(h) : headers?.[h];
    if (v != null) out[h] = v;
  }
  return out;
}

/**
 * The request body from --data '<json>' | --body <file> | --body - (stdin). JSON text is sent as-is
 * with Content-Type application/json; anything else is sent as text (set --header Content-Type).
 * -> { text, json:boolean } | null
 */
/**
 * stdin for `--body -`, without ever hanging while the write lock is held: a terminal is refused
 * outright, and an open pipe that sends NOTHING within `firstByteMs` is given up on (a harness can
 * leave stdin open). Once bytes flow, a slow producer is waited for to the end.
 */
export function readStdinGuarded({ stdin = process.stdin, firstByteMs = Number(process.env.UXC_STDIN_TIMEOUT_MS) || 10_000 } = {}) {
  if (stdin.isTTY) {
    return Promise.reject(new Error('--body - reads the body from stdin, but stdin is a terminal: pipe it in, or use --body <file> / --data'));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => {
      stdin.pause();
      reject(new Error(`--body -: nothing arrived on stdin within ${firstByteMs / 1000} s — pipe the body in, or use --body <file> / --data`));
    }, firstByteMs);
    stdin.on('data', (c) => { clearTimeout(timer); chunks.push(Buffer.from(c)); });
    stdin.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    stdin.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

export async function readRequestBody(flags, { readStdin = readStdinGuarded } = {}) {
  if (flags.data !== undefined && flags.body !== undefined) throw new Error('pass --data OR --body, not both');
  let text = null;
  if (flags.data !== undefined) {
    if (flags.data === true) throw new Error('--data needs a value: --data \'{"a":1}\'');
    text = String(flags.data);
  } else if (flags.body !== undefined) {
    if (flags.body === true || flags.body === '-') text = await readStdin();
    else text = readFileSync(String(flags.body), 'utf8');
  }
  if (text == null) return null;
  let json = false;
  try { JSON.parse(text); json = true; } catch { /* not JSON: sent as text */ }
  return { text, json };
}

const STATUS_TEXT = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found',
  304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 409: 'Conflict', 415: 'Unsupported Media Type', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

/** The explanation for an error response, from the code field first, then the whole body. */
export function explainResponse(status, json, text) {
  const code = json && typeof json === 'object' && !Array.isArray(json) ? json.code : null;
  return (code && explainError(String(code))) || explainError(`${status} ${text ?? ''}`);
}

const isJsonType = (ct) => /[/+]json\b/i.test(String(ct ?? ''));

export default {
  name: 'api',
  summary: 'raw call to a target surface with its auth, pacing, lock and explain (writes need --yes)',
  help: 'uxc api <METHOD> <path> [--surface core|gui|ai|f2] [--data \'<json>\' | --body <file|->] '
    + '[--query k=v]… [--header k=v]… [--raw] [--timeout <s>] [--verbose] [--yes] [--json]',
  async run(ctx) {
    const { args, flags } = ctx;
    const [methodArg, rawPath] = args;
    if (!methodArg || !rawPath || !METHOD_RE.test(methodArg)) fail(`usage: ${this.help}`);
    const method = methodArg.toUpperCase();
    const write = !isReadCall(method, rawPath);
    if (write && !flags.yes) {
      fail(`refused: ${method} is a write — uxc api sends it as-is, with none of the verified mechanics `
        + 'a command applies (array bodies, id in path, cache clear, handler rotation).\n'
        + '  Check the shape in the learnings, then re-run with --yes (it takes the target\'s write lock).');
    }

    let body;
    try { body = await readRequestBody(flags); } catch (e) { fail(e.message); }
    if (body && (method === 'GET' || method === 'HEAD')) fail(`${method} takes no body — drop --data/--body`);

    const { core, gui, gateway, f2, target } = ctx.connect();
    let route;
    try { route = resolveSurface(rawPath, { surface: typeof flags.surface === 'string' ? flags.surface : undefined, target }); } catch (e) { fail(e.message); }
    const client = { core, gui, ai: gateway, f2 }[route.surface];
    if (!client) fail(`target "${target.name}" has no ${route.surface} surface configured (uxc target add … --f2 <url>)`);

    let path;
    let headers;
    try {
      path = withQuery(route.path, collectRepeatedFlag('query'));
      headers = parseHeaders(collectRepeatedFlag('header'));
    } catch (e) { fail(e.message); }
    if (body?.json && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
    const timeout = flags.timeout ? Number(flags.timeout) * 1000 : undefined;
    const url = client.base + path;

    if (flags.verbose) {
      const authHeader = route.surface === 'f2' ? { Authorization: '<redacted>' } : { token: '<redacted>' };
      console.error(`> ${method} ${url}${route.inferred ? `  (surface ${route.surface}, inferred)` : ''}`);
      for (const [k, v] of Object.entries(redactHeaders({ ...headers, ...authHeader }))) console.error(`> ${k}: ${v}`);
    }

    const t0 = Date.now();
    const r = await client.raw(method, path, body?.text, { headers, ...(timeout ? { timeout } : {}) });
    const ms = Date.now() - t0;
    const ok = r.status < 400;
    console.error(`HTTP ${r.status}${STATUS_TEXT[r.status] ? ` ${STATUS_TEXT[r.status]}` : ''}  ${method} ${url}  (${ms} ms)`);

    const contentType = r.headers?.get?.('content-type') ?? '';
    const parsed = r.json !== undefined && (isJsonType(contentType) || !contentType) ? r.json : undefined;

    if (ctx.out.json) {
      ctx.out.result({
        status: r.status, surface: route.surface, method, path,
        headers: responseHeaderSubset(r.headers),
        body: parsed !== undefined ? parsed : (r.text || null),
        ...(ok ? {} : { explanation: explainResponse(r.status, r.json, r.text) }),
      });
    } else if (ok) {
      if (method !== 'HEAD' && r.text) {
        if (parsed !== undefined && !flags.raw) console.log(JSON.stringify(parsed, null, 2));
        else process.stdout.write(r.text.endsWith('\n') ? r.text : `${r.text}\n`);
      }
    } else {
      const excerpt = String(r.text ?? '').slice(0, 2000);
      if (excerpt) console.error(excerpt + (r.text.length > 2000 ? `\n(… ${r.text.length - 2000} more bytes: --json for the whole body)` : ''));
    }

    if (!ok) {
      const why = explainResponse(r.status, r.json, r.text);
      if (why) console.error(`  ↳ ${why}`);
      process.exitCode = 1;
    }
  },
};
