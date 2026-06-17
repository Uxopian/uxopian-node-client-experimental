// Offline unit tests for the marketplace publisher: marketplace.json validation, slug derivation,
// the readable object catalog, and content-type guessing. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { openPackage } from '../lib/registry.mjs';
import {
  kebab, deriveSlug, scaffoldMarketplace, validateMarketplace, buildCatalog, objectLabel,
} from '../lib/catalog.mjs';
import { contentTypeFor } from '../lib/marketplace.mjs';
import { shaEq } from '../lib/util.mjs';

const dir = mkdtempSync(join(os.tmpdir(), 'uxc-mp-test-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

writeFileSync(join(dir, 'uxopian-project.json'), JSON.stringify({
  format: 'uxopian-package/1', name: 'Contract Management', code: 'ct', version: '1.0.0',
  description: 'Playbook-driven contract intelligence.', products: ['flowerdocs', 'uxopian-ai'],
}, null, 2) + '\n');
writeFileSync(join(dir, 'README.md'), '# Contract Management\n');

const w = (rel, obj) => {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, JSON.stringify(obj, null, 2) + '\n');
};
w('fd/tagclasses/CtType.json', { displayName: [{ value: 'Contract type', language: 'EN' }], type: 'CHOICELIST', values: ['NDA', 'CI'] });
w('fd/classes/CtContract.json', { name: 'CtContract', tagReferences: [{}, {}, {}] });
w('ai/prompts/ctSummary.json', { id: 'ctSummary', role: 'system', defaultLlmProvider: 'openai', defaultLlmModel: 'gpt-4o' });
w('fd/handlers/CtIngest_onCreate/meta.json', { action: 'CREATE', objectType: 'DOCUMENT', phase: 'AFTER', asynchronous: true });

const pkg = openPackage(dir);
pkg.addEntry({ kind: 'fd.tagclass', id: 'CtType', path: 'fd/tagclasses/CtType.json', policy: 'managed' });
pkg.addEntry({ kind: 'fd.documentclass', id: 'CtContract', path: 'fd/classes/CtContract.json', policy: 'managed' });
pkg.addEntry({ kind: 'ai.prompt', id: 'ctSummary', path: 'ai/prompts/ctSummary.json', policy: 'managed' });
pkg.addEntry({ kind: 'fd.handler', id: 'CtIngest_onCreate', path: 'fd/handlers/CtIngest_onCreate', policy: 'managed' });
pkg.addEntry({ kind: 'fd.tagclass', id: 'CtGone', path: 'fd/tagclasses/CtGone.json', policy: 'managed', retired: true });

test('kebab + deriveSlug', () => {
  assert.equal(kebab('Contract Management'), 'contract-management');
  assert.equal(kebab('Invoice_AP v2'), 'invoice-ap-v2');
  assert.equal(deriveSlug(pkg.manifest), 'contract-management');
});

test('scaffoldMarketplace: derives slug/summary/products, valid shape, README as a doc', () => {
  const mp = scaffoldMarketplace(pkg, { maintainer: { name: 'A', email: 'a@b.c' } });
  assert.equal(mp.slug, 'contract-management');
  assert.equal(mp.audience, 'generic');
  assert.ok(mp.summary.length > 0 && mp.summary.length <= 200);
  assert.deepEqual(mp.docs, ['README.md']);
  assert.ok('flowerdocs' in mp.compatibility && 'uxopianAi' in mp.compatibility);
});

test('buildCatalog: counts, total, retired excluded, titles + notes resolved from files', () => {
  const cat = buildCatalog(pkg);
  assert.equal(cat.total, 4); // CtGone is retired -> excluded
  assert.deepEqual(cat.counts, { 'fd.tagclass': 1, 'fd.documentclass': 1, 'ai.prompt': 1, 'fd.handler': 1 });

  const byId = Object.fromEntries(cat.objects.map((o) => [o.id, o]));
  assert.equal(byId.CtType.title, 'Contract type');          // EN displayName
  assert.match(byId.CtType.note, /CHOICELIST/);
  assert.match(byId.CtContract.note, /3 tag refs/);
  assert.match(byId.ctSummary.note, /system.*openai/);
  assert.match(byId.CtIngest_onCreate.note, /DOCUMENT.*AFTER.*async/);
});

test('objectLabel: falls back to id when the file is missing/unreadable', () => {
  const { title, note } = objectLabel(pkg, { kind: 'fd.tagclass', id: 'CtNope', path: 'fd/tagclasses/CtNope.json' });
  assert.equal(title, 'CtNope');
  assert.ok(note); // a kind label fallback
});

test('validateMarketplace: required fields, audience/account rule, asset existence', () => {
  // happy path
  const good = {
    slug: 'contract-management', summary: 'x', category: 'contract-intelligence', audience: 'generic',
    maintainer: { name: 'A', email: 'a@b.c' }, compatibility: { flowerdocs: ['5.6'], uxopianAi: ['1.10'] },
    docs: ['README.md'], screenshots: [],
  };
  const r1 = validateMarketplace(good, pkg);
  assert.deepEqual(r1.errors, []);
  assert.equal(r1.resolved.docs.length, 1);

  // missing required + bad slug + demo without account + missing asset
  const bad = {
    slug: 'Bad Slug', audience: 'customer-demo', account: null,
    maintainer: {}, screenshots: ['nope.png'],
  };
  const r2 = validateMarketplace(bad, pkg);
  const joined = r2.errors.join('\n');
  assert.match(joined, /slug .* kebab-case/);
  assert.match(joined, /"summary" is required/);
  assert.match(joined, /"category" is required/);
  assert.match(joined, /"account" is required when audience is "customer-demo"/);
  assert.match(joined, /maintainer\.name/);
  assert.match(joined, /screenshots file not found: nope\.png/);

  // unknown category + empty compatibility -> warnings, not errors
  const warnish = { ...good, category: 'made-up', compatibility: { flowerdocs: [], uxopianAi: [] } };
  const r3 = validateMarketplace(warnish, pkg);
  assert.deepEqual(r3.errors, []);
  assert.ok(r3.warnings.some((x) => /not in the seed vocabulary/.test(x)));
  assert.ok(r3.warnings.some((x) => /compatibility\.flowerdocs is empty/.test(x)));
});

test('shaEq: the import hash gate compares tolerantly, rejects empty/mismatch', () => {
  const h = 'sha256:abc123';
  assert.ok(shaEq(h, h));
  assert.ok(shaEq('sha256:ABC123', 'abc123'));     // case- and prefix-insensitive
  assert.ok(shaEq('abc123', 'sha256:abc123'));
  assert.ok(!shaEq(h, 'sha256:def456'));            // mismatch -> would ABORT the deploy
  assert.ok(!shaEq(null, null));                    // missing expected hash never "matches"
  assert.ok(!shaEq('', 'sha256:abc123'));
});

test('contentTypeFor: extension mapping', () => {
  assert.equal(contentTypeFor('a.png'), 'image/png');
  assert.equal(contentTypeFor('README.md'), 'text/markdown');
  assert.equal(contentTypeFor('ct-1.0.0.uxpkg'), 'application/zip');
  assert.equal(contentTypeFor('weird.bin'), 'application/octet-stream');
});
