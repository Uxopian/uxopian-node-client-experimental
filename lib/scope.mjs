// FlowerDocs scope lifecycle over the SOAP scope service (/core/services/scope).
// Verified live 2026-06-17 (see FD-SCOPE-SOAP.md). Reuses a uxc target's JWT as the SOAP <token>.
import { readFileSync } from 'node:fs';
import { soapPost, scopeBlocks, firstTag, allTags, xmlEsc } from './soap.mjs';

const SCOPE_WS_NS = 'http://flower.com/docs/ws/api/scope';
const DOMAIN_NS = 'http://flower.com/docs/domain/scope';
const COMMON_NS = 'http://flower.com/docs/domain/common';
const I18N_NS = 'http://flower.com/docs/domain/i18n';

/** Build the minimal Scope element the server accepts for a create (verified field set + order). */
export function blankScopeXml(id, { description, displayEn, displayFr, languages = ['EN', 'FR'], admins = ['system'], acl = 'acl-scope' } = {}) {
  const dn = [];
  if (displayEn || displayFr || true) {
    dn.push(`<scope:displayNames language="EN"><i18n:value>${xmlEsc(displayEn || id)}</i18n:value></scope:displayNames>`);
    dn.push(`<scope:displayNames language="FR"><i18n:value>${xmlEsc(displayFr || displayEn || id)}</i18n:value></scope:displayNames>`);
  }
  return `<scope:Scope xmlns:scope="${DOMAIN_NS}" xmlns:common="${COMMON_NS}" xmlns:i18n="${I18N_NS}">`
    + `<common:id>${xmlEsc(id)}</common:id>`
    + `<scope:description>${xmlEsc(description || id)}</scope:description>`
    + dn.join('')
    + languages.map((l) => `<scope:languages>${xmlEsc(l)}</scope:languages>`).join('')
    + `<scope:data><common:ACL>${xmlEsc(acl)}</common:ACL></scope:data>`
    + `<scope:people><scope:profiles>`
    + `<common:id>ADMIN</common:id><scope:name>Administrator</scope:name>`
    + admins.map((p) => `<scope:principals>${xmlEsc(p)}</scope:principals>`).join('')
    + `</scope:profiles></scope:people>`
    + `</scope:Scope>`;
}

/** Take an exported scope.xml (a <Scope> element) and re-target its scope id to `newId`.
 *  Replaces the FIRST id element's text (the scope identity). NOTE: gateway-URL re-targeting
 *  (/gui/plugins/<scope>/) is a clone concern handled separately — this only sets the id. */
export function retargetScopeXml(scopeXml, newId) {
  const body = scopeXml.replace(/^﻿?\s*<\?xml[^>]*\?>\s*/i, '');
  let replaced = false;
  const out = body.replace(/(<(\w+:)?id\b[^>]*>)([\s\S]*?)(<\/(\w+:)?id>)/i, (m, open, _p, _v, close) => {
    if (replaced) return m;
    replaced = true;
    return `${open}${xmlEsc(newId)}${close}`;
  });
  if (!replaced) throw new Error('could not find an <id> element to re-target in the scope.xml');
  return out;
}

/** Parse one <Scope> inner block into a compact summary. */
function summarizeScope(block) {
  const id = (firstTag(block, 'id') ?? '').trim();
  const description = (firstTag(block, 'description') ?? '').trim();
  const languages = allTags(block, 'languages').map((s) => s.trim());
  const profiles = allTags(block, 'profiles').map((p) => ({
    id: (firstTag(p, 'id') ?? '').trim(),
    principals: allTags(p, 'principals').map((s) => s.trim()),
    properties: allTags(p, 'properties').length,
  }));
  return { id, description, languages, profiles };
}

export function createScopeClient(clients, target) {
  const url = `${target.url}/core/services/scope`;
  let token;
  const getToken = async () => (token ??= await clients.auth());
  const reqId = () => `uxc-${process.pid}-${Date.now()}`;

  async function call(op, bodyXml, authScope) {
    return soapPost(url, { action: `scope/${op}`, token: await getToken(), scope: authScope, request: reqId(), bodyXml });
  }

  return {
    /** Read a scope by id. Returns a summary, or null if it doesn't exist (empty 200). */
    async get(id, { authScope } = {}) {
      const body = `<ns:getRequest xmlns:ns="${SCOPE_WS_NS}"><ns:id>${xmlEsc(id)}</ns:id></ns:getRequest>`;
      const xml = await call('get', body, authScope ?? id);
      const blocks = scopeBlocks(xml);
      return blocks.length ? summarizeScope(blocks[0]) : null;
    },

    /** Create a scope. Provide `scopeXml` (a <Scope> element, e.g. re-targeted export) or let it
     *  build a blank one from `opts`. Upserts server-side (create if absent, else update). */
    async create(id, { scopeXml, fromFile, authScope, ...opts } = {}) {
      let scopeEl = scopeXml;
      if (!scopeEl && fromFile) scopeEl = retargetScopeXml(readFileSync(fromFile, 'utf8'), id);
      if (!scopeEl) scopeEl = blankScopeXml(id, opts);
      const body = `<ns:createRequest xmlns:ns="${SCOPE_WS_NS}">${scopeEl}</ns:createRequest>`;
      const xml = await call('create', body, authScope ?? id);
      const blocks = scopeBlocks(xml);
      return blocks.length ? summarizeScope(blocks[0]) : { id };
    },

    /** Delete a scope by id (destructive). */
    async delete(id, { authScope } = {}) {
      const body = `<ns:deleteRequest xmlns:ns="${SCOPE_WS_NS}"><ns:id>${xmlEsc(id)}</ns:id></ns:deleteRequest>`;
      await call('delete', body, authScope ?? id);
      return { id, deleted: true };
    },
  };
}
