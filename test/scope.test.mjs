// Offline unit tests for the SOAP layer + scope payload building/parsing. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope, parseFault, firstTag, allTags, scopeBlocks, xmlEsc } from '../lib/soap.mjs';
import { blankScopeXml, retargetScopeXml } from '../lib/scope.mjs';

test('buildEnvelope: soap 1.1 with flower-ns token/scope/request headers + body', () => {
  const env = buildEnvelope({ token: 'JWT', scope: 'Acme', request: 'r1', bodyXml: '<x/>' });
  assert.match(env, /<soap:Envelope xmlns:soap="http:\/\/schemas.xmlsoap.org\/soap\/envelope\/">/);
  assert.match(env, /<token xmlns="flower">JWT<\/token>/);
  assert.match(env, /<scope xmlns="flower">Acme<\/scope>/);
  assert.match(env, /<request xmlns="flower">r1<\/request>/);
  assert.match(env, /<soap:Body><x\/><\/soap:Body>/);
});

test('xmlEsc escapes the five entities', () => {
  assert.equal(xmlEsc(`a&b<c>d"e'f`), 'a&amp;b&lt;c&gt;d&quot;e&apos;f');
});

test('blankScopeXml: verified namespaces, id in common ns, ordered fields', () => {
  const xml = blankScopeXml('Acme', { description: 'Demo', admins: ['system', 'admin'], languages: ['EN'] });
  assert.match(xml, /<scope:Scope xmlns:scope="http:\/\/flower.com\/docs\/domain\/scope"/);
  assert.match(xml, /<common:id>Acme<\/common:id>/);
  assert.match(xml, /<scope:description>Demo<\/scope:description>/);
  assert.match(xml, /<scope:displayNames language="EN"><i18n:value>Acme<\/i18n:value>/);
  assert.match(xml, /<scope:languages>EN<\/scope:languages>/);
  assert.match(xml, /<common:ACL>acl-scope<\/common:ACL>/);
  assert.match(xml, /<scope:principals>system<\/scope:principals><scope:principals>admin<\/scope:principals>/);
  // id must come before description (sequence order matters for the server)
  assert.ok(xml.indexOf('<common:id>') < xml.indexOf('<scope:description>'));
});

test('retargetScopeXml: replaces only the first id, drops xml decl, errors if none', () => {
  const src = `<?xml version="1.0"?><Scope><id>IRIS</id><people><profiles><id>ADMIN</id></profiles></people></Scope>`;
  const out = retargetScopeXml(src, 'SwissLife');
  assert.ok(!/<\?xml/.test(out));
  assert.match(out, /<id>SwissLife<\/id>/);
  assert.match(out, /<id>ADMIN<\/id>/);          // the profile id is untouched (only the first id)
  assert.equal((out.match(/<id>SwissLife<\/id>/g) || []).length, 1);
  assert.throws(() => retargetScopeXml('<Scope></Scope>', 'X'), /could not find an <id>/);
});

const SAMPLE = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>
<getResponse xmlns="http://flower.com/docs/ws/api/scope" xmlns:common="http://flower.com/docs/domain/common" xmlns:scope="http://flower.com/docs/domain/scope">
<scope:Scope><common:id>IRIS</common:id><scope:description>Scope e-enveloppe</scope:description>
<scope:languages>EN</scope:languages><scope:languages>FR</scope:languages>
<scope:data><common:ACL>acl-scope</common:ACL></scope:data>
<scope:people><scope:profiles><common:id>ADMIN</common:id><scope:name>Administrator</scope:name>
<scope:principals>admin</scope:principals><scope:principals>system</scope:principals>
<scope:properties><common:name>search.template</common:name><common:value>x()</common:value></scope:properties>
</scope:profiles></scope:people></scope:Scope></getResponse></soap:Body></soap:Envelope>`;

test('response parsing: scopeBlocks + firstTag + allTags (prefix-agnostic)', () => {
  const blocks = scopeBlocks(SAMPLE);
  assert.equal(blocks.length, 1);
  assert.equal((firstTag(blocks[0], 'id') ?? '').trim(), 'IRIS');           // first id = the scope id
  assert.equal((firstTag(blocks[0], 'description') ?? '').trim(), 'Scope e-enveloppe');
  assert.deepEqual(allTags(blocks[0], 'languages').map((s) => s.trim()), ['EN', 'FR']);
  const profiles = allTags(blocks[0], 'profiles');
  assert.equal(profiles.length, 1);
  assert.deepEqual(allTags(profiles[0], 'principals').map((s) => s.trim()), ['admin', 'system']);
});

test('parseFault: extracts faultstring + FlowerDocs code', () => {
  const fault = `<soap:Fault><faultcode>soap:Server</faultcode><faultstring>F00123: scope already exists</faultstring></soap:Fault>`;
  const { faultstring, code } = parseFault(fault);
  assert.match(faultstring, /scope already exists/);
  assert.equal(code, 'F00123');
});
