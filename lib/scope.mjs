// FlowerDocs scope lifecycle over Core REST (/core/rest/scope) — verified live 2026-06-18.
// Reuses uxc's existing `core` client (JWT auth, array bodies, array-of-1 GET unwrap), so there is
// no separate transport: scope is just another Core REST resource, like tagclass/documentclass.
//
//   get    : GET    /core/rest/scope/{id}        -> array-of-1 (core.getOne unwraps); null if absent
//   create : POST   /core/rest/scope     [obj]   -> 200  (new id; existing id -> 500 "must be unique")
//   update : POST   /core/rest/scope/{id} [obj]  -> 200  (id in path)
//   delete : DELETE /core/rest/scope/{id}        -> 200
import { readFileSync } from 'node:fs';

/** Build a minimal Scope object the server accepts for a create (verified field set). */
export function blankScope(id, { description, displayEn, displayFr, languages = ['EN', 'FR'], admins = ['system'], acl = 'acl-scope' } = {}) {
  return {
    id,
    description: description || id,
    displayNames: [
      { value: displayEn || id, language: 'EN' },
      { value: displayFr || displayEn || id, language: 'FR' },
    ],
    languages,
    data: { ACL: acl },
    people: { profiles: [{ id: 'ADMIN', name: 'Administrator', principals: admins }] },
  };
}

/** Re-target an existing scope object (e.g. from `uxc scope get <src> --json`) to a new id, for cloning. */
export function retargetScope(scopeObj, newId) {
  if (!scopeObj || typeof scopeObj !== 'object') throw new Error('retargetScope: expected a scope object (JSON)');
  return { ...scopeObj, id: newId };
}

/** Read a scope object from a JSON file (a `uxc scope get … --json` dump), or throw a clear error. */
export function readScopeFile(path) {
  let obj;
  try { obj = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { throw new Error(`--from: cannot read a JSON scope object from ${path}: ${e.message}`); }
  // accept either a bare scope object or a uxc `--json` result wrapper ({ exists, ...scope })
  if (obj && obj.exists !== undefined && obj.id === undefined && obj.people) return obj;
  return obj;
}

/** Scope client over the Core REST client (clients.core). */
export function createScopeClient(clients) {
  const core = clients.core;
  const path = (id) => `/rest/scope/${encodeURIComponent(id)}`;
  return {
    /** Full scope object, or null if it doesn't exist. */
    get: (id) => core.getOne(path(id)),
    /** Create a NEW scope (POST /rest/scope, array body). */
    async create(scopeObj) {
      const res = await core.post('/rest/scope', [scopeObj]);
      return Array.isArray(res) ? (res[0] ?? scopeObj) : (res ?? scopeObj);
    },
    /** Update an existing scope (POST /rest/scope/{id}, array body). */
    async update(scopeObj) {
      const res = await core.post(path(scopeObj.id), [scopeObj]);
      return Array.isArray(res) ? (res[0] ?? scopeObj) : (res ?? scopeObj);
    },
    /** Delete a scope by id. */
    async delete(id) {
      await core.del(path(id));
      return { id, deleted: true };
    },
  };
}
