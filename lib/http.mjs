// The three API surfaces, JWT-authenticated, with the verified quirks baked in.
//  - Core REST  : JSON ARRAYS in/out; single-GETs return array-of-1 (use getOne); `token:` header.
//  - Gateway    : single JSON objects; same `token:` header (live-verified 2026-06-12).
//  - GUI caches : DELETE /gui/rest/caches with the `token:` header.
// Every call has a timeout. Token expires ~1h: transparently re-auth once on 401/expiry.
import { explainError } from './explain.mjs';

/** FlowerDocs "already exists" signals: T00108 (components/documents), F00903 (classes).
 *  Used to HEAL create->update races instead of failing or duplicating (LEARNINGS §25). */
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

const DEFAULT_TIMEOUT = 60_000;

async function rawRequest(url, { method = 'GET', headers = {}, body, timeout = DEFAULT_TIMEOUT } = {}) {
  const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(timeout) };
  if (body !== undefined && body !== null) {
    if (body instanceof FormData) init.body = body;
    else if (typeof body === 'string' || body instanceof Uint8Array) init.body = body;
    else {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] ??= 'application/json';
    }
  }
  const res = await fetch(url, init);
  const text = await res.text();
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
      method: 'POST',
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

  function surface(base, { arrays }) {
    const req = async (method, path, body, opts = {}) => {
      const r = await authed(base + path, { method, body, ...opts });
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
        const r = await authed(base + path, { method: 'GET', ...opts });
        if (r.status === 404) return null;
        const absentCode = /F00206|F00012|T00103|T01002/;
        if (r.status >= 400 && (absentCode.test(r.json?.code ?? '') || absentCode.test(r.text ?? ''))) return null;
        if (r.status >= 400) throw new HttpError(r.status, r.json ?? r.text, base + path, 'GET');
        return r.json;
      },
      raw: (method, path, body, opts) => authed(base + path, { method, body, ...opts }),
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

  const core = surface(`${target.core}`, { arrays: true });
  const gateway = surface(`${target.gateway}`, { arrays: false });
  const gui = surface(`${target.gui}`, { arrays: false });

  /** Upload to /core/rest/files/tmp. Fresh tmp per attempt (T00707: failed creates consume the ref). */
  core.uploadTmp = async (bytes, filename, mime = 'application/octet-stream') => {
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type: mime }), filename);
    const j = await core.post('/rest/files/tmp', fd);
    if (!j?.id) throw new Error(`tmp upload returned no id: ${JSON.stringify(j).slice(0, 200)}`);
    return j.id;
  };

  /**
   * POST /core/rest/documents/search with the verified shape.
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
    const path = category === 'tasks' ? '/rest/tasks/search' : '/rest/documents/search';
    const j = await core.post(path, body);
    return {
      found: j?.found ?? 0,
      results: (j?.results ?? []).map((r) => ({
        id: r.id, // rows DO carry a top-level id (verified)
        fields: Object.fromEntries((r.fields ?? []).map((f) => [f.name, f.value])),
      })),
    };
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

  return { core, gateway, gui, cacheClear, auth, target };
}
